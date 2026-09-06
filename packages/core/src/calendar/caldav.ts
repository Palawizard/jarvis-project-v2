import { randomUUID } from 'node:crypto';
import {
  buildIcs,
  excludeIcsOccurrence,
  patchIcs,
  patchIcsEvent,
  parseVEvents,
  recurrenceIdLine,
} from './ical.js';
import {
  CalendarProviderError,
  rebaseSeriesPatch,
  type CalendarClient,
  type CalendarEventDraft,
  type IcloudCredentials,
  type RecurrenceScope,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventRef,
} from './types.js';

/** iCloud's CalDAV entry point. Discovery walks from here to the calendars. */
export const ICLOUD_CALDAV_ROOT = 'https://caldav.icloud.com';

/**
 * Match an XML element by local name, whatever namespace prefix the server used.
 *
 * Servers disagree about prefixes (`d:`, `D:`, none) and about which namespace
 * is the default, so prefix-insensitive matching is the only thing that works
 * across them. This is a fixed set of well-known element names, not a general
 * XML parser: nothing here interprets structure it was not asked for.
 */
function elements(xml: string, tag: string): string[] {
  const pattern = new RegExp(
    `<(?:[A-Za-z0-9._-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${tag}>`,
    'gi',
  );
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? '');
}

function firstElement(xml: string, tag: string): string | null {
  return elements(xml, tag)[0] ?? null;
}

function hasElement(xml: string, tag: string): boolean {
  const selfClosing = new RegExp(`<(?:[A-Za-z0-9._-]+:)?${tag}(?:\\s[^>]*)?/>`, 'i');
  return selfClosing.test(xml) || elements(xml, tag).length > 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Resolve a multistatus href against the URL that returned it.
 *
 * iCloud answers `calendar-home-set` with a per-account partition host
 * (`https://pNN-caldav.icloud.com/...`) and then bare paths underneath it.
 * Rebasing those onto the discovery root sends every later request to the wrong
 * host, where the redirect drops the Authorization header and the account looks
 * like it was rejected.
 */
function resolve(href: string, base: string): string {
  return new URL(decodeXml(href.trim()), base).toString();
}

function icsStamp(iso: string): string {
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** The resource URL a recurring occurrence's `resource#recurrenceId` id names. */
function seriesUrlOf(remoteId: string): string {
  const hash = remoteId.indexOf('#');
  return hash < 0 ? remoteId : remoteId.slice(0, hash);
}

/** The RECURRENCE-ID an occurrence id names, or null for a non-fragment id. */
function recurrenceIdOf(remoteId: string): string | null {
  const hash = remoteId.indexOf('#');
  return hash < 0 ? null : remoteId.slice(hash + 1);
}

/** An EXDATE line with the same params and value as a RECURRENCE-ID line. */
function toExdateLine(line: string): string {
  return line.replace(/^RECURRENCE-ID/i, 'EXDATE');
}

/**
 * iCloud (and any other CalDAV server) over plain HTTP verbs.
 *
 * There is no CalDAV client dependency here because the protocol surface Jarvis
 * uses is four requests: find the calendar, read a time range, PUT an object,
 * DELETE an object. Everything else — scheduling, free/busy, sharing — is out
 * of scope, and a library would bring all of it.
 *
 * Authentication is an Apple ID plus an app-specific password. Apple does not
 * offer OAuth for CalDAV, so this is the only mechanism that exists.
 */
export class CalDavClient implements CalendarClient {
  readonly #auth: string;

  constructor(
    credentials: IcloudCredentials,
    private readonly calendarUrl: string,
    private readonly signal?: AbortSignal | undefined,
    private readonly root: string = ICLOUD_CALDAV_ROOT,
  ) {
    this.#auth = `Basic ${Buffer.from(`${credentials.appleId}:${credentials.appPassword}`).toString('base64')}`;
  }

  async calendars(): Promise<RemoteCalendar[]> {
    const principal = await this.#href(
      this.root,
      '<d:prop><d:current-user-principal/></d:prop>',
      'current-user-principal',
    );
    const home = await this.#href(
      principal,
      '<d:prop><c:calendar-home-set/></d:prop>',
      'calendar-home-set',
    );
    const response = await this.#dav('PROPFIND', home, {
      depth: '1',
      body:
        '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
        '<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop>' +
        '</d:propfind>',
    });
    const calendars: RemoteCalendar[] = [];
    for (const block of elements(response.text, 'response')) {
      const href = firstElement(block, 'href');
      if (!href || !hasElement(block, 'calendar')) continue;
      // Contacts and reminders live in the same home and answer PROPFIND too.
      if (!/name="VEVENT"/i.test(block)) continue;
      calendars.push({
        id: resolve(href, response.url),
        name: decodeXml(firstElement(block, 'displayname')?.trim() ?? '').trim() || 'Calendar',
      });
    }
    if (!calendars.length) {
      throw new CalendarProviderError('no writable iCloud calendar was found for this Apple ID');
    }
    return calendars;
  }

  async events(range: { from: string; to: string }): Promise<RemoteEvent[]> {
    const response = await this.#dav('REPORT', this.calendarUrl, {
      depth: '1',
      body:
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
        '<d:prop><d:getetag/><c:calendar-data>' +
        // Ask the server to expand recurrence: an occurrence Jarvis can show is
        // worth more than a master rule it would have to evaluate itself.
        `<c:expand start="${icsStamp(range.from)}" end="${icsStamp(range.to)}"/>` +
        '</c:calendar-data></d:prop>' +
        '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
        `<c:time-range start="${icsStamp(range.from)}" end="${icsStamp(range.to)}"/>` +
        '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>',
    });

    const events: RemoteEvent[] = [];
    for (const block of elements(response.text, 'response')) {
      const href = firstElement(block, 'href');
      const data = firstElement(block, 'calendar-data');
      if (!href || !data) continue;
      const resource = resolve(href, response.url);
      const etag = firstElement(block, 'getetag')?.trim().replace(/^"|"$/g, '') ?? null;
      const parsed = parseVEvents(decodeXml(data));
      // One resource holding several VEVENTs is an expanded series: each
      // occurrence gets a distinct id so the mirror can show them all. The
      // resource itself -- without the recurrence-id fragment -- is the
      // series id: what a `series`-scoped update or delete addresses.
      const expanded = parsed.length > 1;
      for (const event of parsed) {
        const recurring = expanded || event.recurring;
        events.push({
          remoteId:
            recurring && event.recurrenceId ? `${resource}#${event.recurrenceId}` : resource,
          etag,
          raw: event.raw,
          title: event.summary,
          description: event.description,
          location: event.location,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          allDay: event.allDay,
          recurring,
          seriesId: recurring ? resource : null,
        });
      }
    }
    return events;
  }

  async create(draft: CalendarEventDraft): Promise<RemoteEvent> {
    const uid = `${randomUUID()}@jarvis.local`;
    const url = `${this.calendarUrl.replace(/\/$/, '')}/${uid}.ics`;
    const body = buildIcs(uid, draft);
    const response = await this.#dav('PUT', url, {
      body,
      contentType: 'text/calendar; charset=utf-8',
      // Refuse to overwrite: a UUID collision must fail loudly, not silently
      // replace somebody's meeting.
      headers: { 'if-none-match': '*' },
    });
    return {
      ...draft,
      remoteId: url,
      etag: response.etag,
      raw: body,
      recurring: false,
      seriesId: null,
    };
  }

  /**
   * `scope: 'series'` (the default) rewrites the master's own properties in
   * place, leaving any existing occurrence overrides untouched -- exactly
   * RFC 5545's model, where an override that changed only its own fields
   * keeps them regardless of what the master says. `scope: 'occurrence'`
   * rewrites (or creates) the one override for this instance and leaves the
   * master and every other occurrence alone.
   *
   * Either way the write targets the actual resource -- fetched fresh here,
   * because the per-occurrence `ref.raw` from an expanded `REPORT` is a
   * synthetic single-VEVENT object, not the real multi-VEVENT resource a
   * server will accept a PUT against. Concurrency still checks against
   * `ref.etag`, the etag from Jarvis's last sync, exactly as a non-recurring
   * update does: the fresh GET only supplies the text to patch.
   */
  async update(
    ref: RemoteEventRef,
    draft: CalendarEventDraft,
    scope: RecurrenceScope = 'series',
    patch: Partial<CalendarEventDraft> = draft,
  ): Promise<RemoteEvent> {
    if (!ref.recurring) {
      const body = ref.raw
        ? patchIcs(ref.raw, draft)
        : buildIcs(`${randomUUID()}@jarvis.local`, draft);
      const response = await this.#dav('PUT', ref.remoteId, {
        body,
        contentType: 'text/calendar; charset=utf-8',
        // Optimistic concurrency: if the calendar moved on since the last
        // sync, the server rejects the write instead of overwriting the
        // newer version.
        ...(ref.etag ? { headers: { 'if-match': `"${ref.etag}"` } } : {}),
      });
      return {
        ...draft,
        remoteId: ref.remoteId,
        etag: response.etag,
        raw: body,
        recurring: false,
        seriesId: null,
      };
    }

    const seriesUrl = ref.seriesId ?? seriesUrlOf(ref.remoteId);
    const recurrenceId = recurrenceIdOf(ref.remoteId);
    if (scope === 'occurrence' && !recurrenceId) {
      throw new CalendarProviderError('this occurrence has no recurrence marker to target');
    }
    const current = await this.#dav('GET', seriesUrl);
    const master = parseVEvents(current.text).find((event) => event.recurrenceId === null);
    if (!master) throw new CalendarProviderError('the series has no master event to edit');
    const seriesPatch =
      scope === 'series' ? rebaseSeriesPatch(master, ref, draft, patch) : undefined;
    const body = patchIcsEvent(
      current.text,
      draft,
      scope === 'occurrence' ? recurrenceId : null,
      scope === 'occurrence' && ref.raw ? recurrenceIdLine(ref.raw) : null,
      seriesPatch,
    );
    const response = await this.#dav('PUT', seriesUrl, {
      body,
      contentType: 'text/calendar; charset=utf-8',
      ...(ref.etag ? { headers: { 'if-match': `"${ref.etag}"` } } : {}),
    });
    return {
      ...draft,
      remoteId: scope === 'occurrence' ? ref.remoteId : seriesUrl,
      etag: response.etag,
      raw: body,
      recurring: true,
      seriesId: seriesUrl,
    };
  }

  /**
   * `scope: 'series'` (the default) deletes the whole resource, exactly as a
   * non-recurring delete already did. `scope: 'occurrence'` instead adds an
   * EXDATE for this instance to the master and drops any override already
   * written for it, which excludes the occurrence while leaving the series
   * -- and every other occurrence -- in place.
   */
  async remove(ref: RemoteEventRef, scope: RecurrenceScope = 'series'): Promise<void> {
    const seriesUrl = ref.seriesId ?? seriesUrlOf(ref.remoteId);
    if (!ref.recurring || scope === 'series') {
      await this.#dav('DELETE', seriesUrl, {
        ...(ref.etag ? { headers: { 'if-match': `"${ref.etag}"` } } : {}),
        allow: [404, 410],
      });
      return;
    }
    const recurrenceId = recurrenceIdOf(ref.remoteId);
    if (!recurrenceId) {
      throw new CalendarProviderError('this occurrence has no recurrence marker to target');
    }
    if (!ref.raw) {
      throw new CalendarProviderError('this occurrence has no recurrence data to exclude it with');
    }
    const line = recurrenceIdLine(ref.raw);
    if (!line) throw new CalendarProviderError('this occurrence has no RECURRENCE-ID to exclude');
    const current = await this.#dav('GET', seriesUrl);
    const body = excludeIcsOccurrence(current.text, recurrenceId, toExdateLine(line));
    await this.#dav('PUT', seriesUrl, {
      body,
      contentType: 'text/calendar; charset=utf-8',
      ...(ref.etag ? { headers: { 'if-match': `"${ref.etag}"` } } : {}),
    });
  }

  async #href(url: string, prop: string, tag: string): Promise<string> {
    const response = await this.#dav('PROPFIND', url, {
      depth: '0',
      body: `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${prop}</d:propfind>`,
    });
    const block = firstElement(response.text, tag);
    const href = block ? firstElement(block, 'href') : null;
    if (!href) throw new CalendarProviderError(`iCloud did not return a ${tag}`);
    return resolve(href, response.url);
  }

  async #dav(
    method: string,
    url: string,
    options: {
      depth?: string;
      body?: string;
      contentType?: string;
      headers?: Record<string, string>;
      allow?: number[];
    } = {},
  ): Promise<{ text: string; etag: string | null; status: number; url: string }> {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: this.#auth,
        ...(options.depth ? { depth: options.depth } : {}),
        ...(options.body
          ? { 'content-type': options.contentType ?? 'application/xml; charset=utf-8' }
          : {}),
        ...options.headers,
      },
      ...(options.body ? { body: options.body } : {}),
      ...(this.signal ? { signal: this.signal } : {}),
    });
    if (!response.ok && !(options.allow ?? []).includes(response.status)) {
      throw new CalendarProviderError(davMessage(method, response.status), response.status);
    }
    return {
      status: response.status,
      // Hrefs in a multistatus are relative to the request URI (RFC 4918), and
      // after a redirect that is where the server actually answered.
      url: response.url || url,
      etag: response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null,
      // Bodies are XML from the user's own calendar server. Never logged, and
      // never surfaced in an error, so no event content leaks into an audit row.
      text: response.status === 204 ? '' : await response.text(),
    };
  }
}

function davMessage(method: string, status: number): string {
  if (status === 401 || status === 403) {
    return 'iCloud rejected the Apple ID or app-specific password. Reconnect the account.';
  }
  if (status === 412) {
    return 'the event changed in iCloud since Jarvis last synced; sync and try again';
  }
  if (status === 507) return 'the iCloud calendar is out of space';
  return `iCloud refused the ${method} request (HTTP ${status})`;
}
