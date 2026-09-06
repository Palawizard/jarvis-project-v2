/**
 * Calendar domain types.
 *
 * The local `calendar_events` table is a MIRROR, never the authority: the
 * connected provider owns the data. Reads are served from the mirror so a
 * question about the week costs no network call; writes go to the provider
 * first and only then update the mirror. That is what makes "conflict
 * resolution" a non-problem here — there is never a local edit waiting to be
 * reconciled, because a local edit that the provider refused never happened.
 */

export type CalendarProviderId = 'google' | 'icloud';

/**
 * Which part of a repeating event a write targets.
 *
 * `series` is the default: it is what every non-recurring write already meant,
 * so a caller that never heard of recurrence keeps behaving exactly as before.
 * `occurrence` targets one instance and must leave the rest of the series
 * alone -- the distinction the review found missing for CalDAV.
 */
export type RecurrenceScope = 'occurrence' | 'series';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface IcloudCredentials {
  appleId: string;
  appPassword: string;
}

export type CalendarCredentials = GoogleCredentials | IcloudCredentials;

/**
 * A connected calendar, as everything outside the service may see it.
 *
 * There is deliberately no `credentials` field: the row has one, and it is
 * read only inside `CalendarService`, so an account cannot be serialised into
 * an HTTP response, an event payload, a log line or a prompt with the secret
 * still attached.
 */
export interface CalendarAccount {
  id: string;
  provider: CalendarProviderId;
  label: string;
  /** Google calendar id, or the absolute CalDAV collection URL. */
  calendarId: string;
  calendarName: string | null;
  status: 'active' | 'error';
  error: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  accountId: string;
  provider: CalendarProviderId;
  /** The account label, so the UI and Jarvis can always name the source. */
  source: string;
  remoteId: string;
  title: string;
  description: string | null;
  location: string | null;
  /** ISO-8601 UTC. All-day events are stored at midnight UTC of their date. */
  startsAt: string;
  /** ISO-8601 UTC, exclusive — as both Google and RFC 5545 define it. */
  endsAt: string;
  allDay: boolean;
  /**
   * An occurrence of a repeating series. Both providers address instances
   * individually, so an occurrence stays editable without touching the rest
   * of the series -- see `RecurrenceScope`.
   */
  recurring: boolean;
  /**
   * The series' own id: Google's `recurringEventId`, or the iCloud/CalDAV
   * resource URL shared by every occurrence. Null for a non-recurring event.
   * This is what a `series`-scoped update or delete addresses instead of the
   * one occurrence's own id.
   */
  seriesId: string | null;
  updatedAt: string;
  syncedAt: string;
}

/** The mutable half of an event: what a human or Jarvis can actually set. */
export interface CalendarEventDraft {
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  description: string | null;
  location: string | null;
}

/** One event exactly as the provider holds it. */
export interface RemoteEvent extends CalendarEventDraft {
  remoteId: string;
  etag: string | null;
  /**
   * The provider's own representation (the iCalendar object for CalDAV).
   * Kept so an update can patch the properties Jarvis understands and leave
   * every property it does not — attendees, alarms, recurrence — untouched.
   */
  raw: string | null;
  recurring: boolean;
  /** See `CalendarEvent.seriesId`. */
  seriesId: string | null;
}

/** What an update or delete needs in order to address the remote resource. */
export interface RemoteEventRef {
  remoteId: string;
  etag: string | null;
  raw: string | null;
  recurring: boolean;
  seriesId: string | null;
}

export interface RemoteCalendar {
  id: string;
  name: string;
}

/**
 * The provider-facing contract. Two implementations, no abstraction beyond
 * what both genuinely need.
 */
export interface CalendarClient {
  /** Calendars this credential can see, used to resolve the one to sync. */
  calendars(): Promise<RemoteCalendar[]>;
  events(range: { from: string; to: string }): Promise<RemoteEvent[]>;
  create(draft: CalendarEventDraft): Promise<RemoteEvent>;
  /** `scope` only matters when `ref.recurring`; defaults to the whole series. */
  update(
    ref: RemoteEventRef,
    draft: CalendarEventDraft,
    scope?: RecurrenceScope,
  ): Promise<RemoteEvent>;
  remove(ref: RemoteEventRef, scope?: RecurrenceScope): Promise<void>;
}

/** A failure that came from the provider, safe to show a human. */
export class CalendarProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CalendarProviderError';
  }
}
