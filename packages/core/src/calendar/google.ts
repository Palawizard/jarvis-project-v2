import { assertCalendarDate, isCalendarDate, zonedWallClock } from './dates.js';
import {
  CalendarProviderError,
  rebaseSeriesPatch,
  type CalendarClient,
  type CalendarEventDraft,
  type GoogleCredentials,
  type RecurrenceScope,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventRef,
} from './types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CALENDAR_SCOPE =
  'https://www.googleapis.com/auth/calendar.events ' +
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
/** Refresh a little early: a token that expires mid-request is a failed sync. */
const TOKEN_SKEW_MS = 60_000;
/** Bounded paging. A sync window this deep is a misconfiguration, not a calendar. */
const MAX_PAGES = 10;

interface GoogleTime {
  date?: string;
  dateTime?: string;
  /** The zone a recurring master's wall clock (and its RRULE) is anchored to. */
  timeZone?: string;
}

interface GoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  recurringEventId?: string;
}

/** Exchange the one-time browser code for the durable offline credential. */
export async function exchangeGoogleCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GoogleCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) {
    throw new CalendarProviderError(
      `Google refused the authorization code (HTTP ${response.status}). Try connecting again.`,
      response.status,
    );
  }
  const body = (await response.json()) as { refresh_token?: string };
  if (!body.refresh_token) {
    throw new CalendarProviderError(
      'Google returned no refresh token. Reconnect and grant offline access again.',
    );
  }
  return {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: body.refresh_token,
  };
}

/**
 * Google Calendar over the REST API, with no SDK.
 *
 * The official client library exists to do OAuth, paging and retries; this
 * needs one grant type, one resource and one page loop, so `fetch` is smaller
 * than the dependency would be.
 *
 * `singleEvents=true` asks Google to expand recurrence into real instances.
 * Each instance is separately addressable, so an occurrence stays editable.
 */
export class GoogleCalendarClient implements CalendarClient {
  #token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly calendarId: string,
    private readonly signal?: AbortSignal | undefined,
  ) {}

  async calendars(): Promise<RemoteCalendar[]> {
    const body = await this.#json<{
      items?: { id?: string; summary?: string; primary?: boolean }[];
    }>('GET', `${API}/users/me/calendarList?maxResults=100&minAccessRole=writer`);
    const items = body.items ?? [];
    // Primary first: it is what "my calendar" means to the person connecting.
    return (
      items
        .filter((item): item is { id: string; summary?: string; primary?: boolean } =>
          Boolean(item.id),
        )
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
        // `minAccessRole=writer` already excluded everything this credential
        // cannot edit, so anything listed here is writable by construction.
        .map((item) => ({ id: item.id, name: item.summary ?? item.id, writable: true }))
    );
  }

  async events(range: { from: string; to: string }): Promise<RemoteEvent[]> {
    const events: RemoteEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        timeMin: range.from,
        timeMax: range.to,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        ...(pageToken ? { pageToken } : {}),
      });
      const body = await this.#json<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        'GET',
        `${this.#eventsUrl()}?${query}`,
      );
      for (const item of body.items ?? []) {
        const event = toRemoteEvent(item);
        if (event) events.push(event);
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) {
      throw new CalendarProviderError(
        `Google returned more than ${MAX_PAGES * 250} events in the sync window; shorten the calendar window`,
      );
    }
    return events;
  }

  async create(draft: CalendarEventDraft): Promise<RemoteEvent> {
    const created = await this.#json<GoogleEvent>('POST', this.#eventsUrl(), toGoogleEvent(draft));
    return (
      toRemoteEvent(created) ?? {
        ...draft,
        remoteId: created.id ?? '',
        etag: null,
        raw: null,
        recurring: false,
        seriesId: null,
      }
    );
  }

  /**
   * `scope: 'series'` targets `ref.seriesId` (the master event Google calls
   * `recurringEventId`) instead of the one instance's own id -- Google already
   * addresses a single instance correctly via its own id, which is why
   * `occurrence` (the default) is unchanged from before recurrence scoping
   * existed.
   */
  async update(
    ref: RemoteEventRef,
    draft: CalendarEventDraft,
    scope: RecurrenceScope = 'occurrence',
    patch: Partial<CalendarEventDraft> = draft,
  ): Promise<RemoteEvent> {
    const targetId = scope === 'series' && ref.seriesId ? ref.seriesId : ref.remoteId;
    let body = toGoogleEvent(draft);
    let etag = ref.etag;
    if (scope === 'series' && ref.seriesId) {
      const raw = await this.#json<GoogleEvent>(
        'GET',
        `${this.#eventsUrl()}/${encodeURIComponent(targetId)}`,
      );
      const master = toRemoteEvent(raw);
      if (!master) throw new CalendarProviderError('Google returned an invalid series master');
      // The master's own zone, which its RRULE expands against. Absent only
      // when the event really is UTC or floating.
      const timeZone = raw.start?.timeZone ?? null;
      body = toGooglePatch(rebaseSeriesPatch(master, ref, draft, patch, timeZone), timeZone);
      etag = master.etag;
    }
    const updated = await this.#json<GoogleEvent>(
      'PATCH',
      `${this.#eventsUrl()}/${encodeURIComponent(targetId)}`,
      body,
      etag ? { 'if-match': etag } : undefined,
    );
    return (
      toRemoteEvent(updated) ?? {
        ...draft,
        remoteId: targetId,
        etag: null,
        raw: null,
        recurring: ref.recurring,
        seriesId: ref.seriesId,
      }
    );
  }

  async remove(ref: RemoteEventRef, scope: RecurrenceScope = 'occurrence'): Promise<void> {
    const targetId = scope === 'series' && ref.seriesId ? ref.seriesId : ref.remoteId;
    const response = await this.#fetch(
      'DELETE',
      `${this.#eventsUrl()}/${encodeURIComponent(targetId)}`,
    );
    // Already gone is the state the caller asked for.
    if (response.ok || response.status === 404 || response.status === 410) return;
    throw await providerError(response, 'delete the event');
  }

  #eventsUrl(): string {
    return `${API}/calendars/${encodeURIComponent(this.calendarId)}/events`;
  }

  /**
   * A valid access token, minted from the refresh token.
   *
   * Cached in memory only, and never written anywhere: the refresh token in the
   * database is the only durable credential.
   */
  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt - TOKEN_SKEW_MS > Date.now()) return this.#token.value;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
      ...(this.signal ? { signal: this.signal } : {}),
    });
    if (!response.ok) {
      // The body of a token failure can echo the client secret back; only the
      // status and Google's short error code are safe to surface.
      const detail = await response
        .json()
        .then((body: unknown) =>
          body &&
          typeof body === 'object' &&
          typeof (body as { error?: unknown }).error === 'string'
            ? ` (${(body as { error: string }).error})`
            : '',
        )
        .catch(() => '');
      throw new CalendarProviderError(
        `Google refused the stored credentials${detail}. Reconnect the account.`,
        response.status,
      );
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new CalendarProviderError('Google returned no access token', response.status);
    }
    this.#token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.#token.value;
  }

  async #fetch(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const token = await this.#accessToken();
    return fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.signal ? { signal: this.signal } : {}),
    });
  }

  async #json<T>(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const response = await this.#fetch(method, url, body, headers);
    if (!response.ok) throw await providerError(response, `${method} ${new URL(url).pathname}`);
    return (await response.json()) as T;
  }
}

async function providerError(response: Response, what: string): Promise<CalendarProviderError> {
  if (response.status === 412) {
    return new CalendarProviderError(
      'the event changed in Google Calendar since Jarvis last synced; sync and try again',
      response.status,
    );
  }
  const text = await response.text().catch(() => '');
  let detail = '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    detail = parsed.error?.message ?? '';
  } catch {
    detail = text.slice(0, 200);
  }
  return new CalendarProviderError(
    `Google Calendar could not ${what}: ${response.status}${detail ? ` ${detail}` : ''}`,
    response.status,
  );
}

function toGoogleEvent(draft: CalendarEventDraft): Record<string, unknown> {
  return {
    summary: draft.title,
    description: draft.description,
    location: draft.location,
    start: toGoogleTime(draft.startsAt, draft.allDay),
    end: toGoogleTime(draft.endsAt, draft.allDay),
  };
}

function toGooglePatch(
  patch: Partial<CalendarEventDraft>,
  timeZone: string | null = null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) body.summary = patch.title;
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
    body.description = patch.description;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'location')) body.location = patch.location;
  if (patch.startsAt && patch.endsAt && patch.allDay !== undefined) {
    body.start = toGoogleTime(patch.startsAt, patch.allDay, timeZone);
    body.end = toGoogleTime(patch.endsAt, patch.allDay, timeZone);
  }
  return body;
}

function toGoogleTime(iso: string, allDay: boolean, timeZone: string | null = null): GoogleTime {
  if (allDay) return { date: assertCalendarDate(iso.slice(0, 10), 'all-day date') };
  // With the series' zone known, send the wall clock AND the zone: an instant
  // alone would re-anchor a TZID-bound series to UTC, and RFC 3339 lets the
  // offset be omitted exactly when `timeZone` supplies it.
  return timeZone
    ? { dateTime: zonedWallClock(iso, timeZone), timeZone }
    : { dateTime: new Date(iso).toISOString() };
}

/** Null for anything Jarvis cannot place on a timeline, including cancellations. */
function toRemoteEvent(event: GoogleEvent): RemoteEvent | null {
  if (!event.id || event.status === 'cancelled') return null;
  const allDay = Boolean(event.start?.date);
  const startsAt = fromGoogleTime(event.start);
  const endsAt = fromGoogleTime(event.end) ?? startsAt;
  if (!startsAt || !endsAt) return null;
  return {
    remoteId: event.id,
    etag: event.etag ?? null,
    raw: null,
    title: event.summary?.trim() || '(untitled)',
    description: event.description ?? null,
    location: event.location ?? null,
    startsAt,
    endsAt,
    allDay,
    recurring: Boolean(event.recurringEventId),
    seriesId: event.recurringEventId ?? null,
  };
}

function fromGoogleTime(time: GoogleTime | undefined): string | null {
  // An all-day `date` is a calendar date, and an impossible one must be
  // refused rather than normalised onto a day the event was never on.
  if (time?.date !== undefined && !isCalendarDate(time.date)) return null;
  const raw = time?.dateTime ?? (time?.date ? `${time.date}T00:00:00.000Z` : null);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
