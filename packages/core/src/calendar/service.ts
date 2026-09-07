import { transaction, likeTerm, type Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import type { JarvisConfig } from '../config.js';
import { newId, nowIso } from '../ids.js';
import { createLogger } from '../logger.js';
import { addCalendarDays, calendarDate } from './dates.js';
import { GoogleCalendarClient } from './google.js';
import { CalDavClient } from './caldav.js';
import {
  CalendarProviderError,
  type CalendarAccount,
  type CalendarClient,
  type CalendarCredentials,
  type CalendarEvent,
  type CalendarEventDraft,
  type CalendarProviderId,
  type GoogleCredentials,
  type IcloudCredentials,
  type RecurrenceScope,
  type RemoteCalendar,
} from './types.js';

const log = createLogger('calendar');

/** Hard ceiling on one provider round trip, so a hung server cannot stall sync. */
const REQUEST_TIMEOUT_MS = 30_000;

type Row = Record<string, unknown>;

export interface CalendarSyncReport {
  accountId: string;
  label: string;
  synced: number;
  removed: number;
  error: string | null;
}

export interface CalendarServiceDeps {
  db: Db;
  bus: EventBus;
  config: JarvisConfig;
  /** Seam for tests. Production always builds a real provider client. */
  createClient?: (
    account: Pick<CalendarAccount, 'provider' | 'calendarId'>,
    credentials: CalendarCredentials,
    signal: AbortSignal,
  ) => CalendarClient;
}

/**
 * Connected calendars, their mirrored events, and the loop that keeps the two
 * in step.
 *
 * Three rules shape everything here:
 *
 * 1. **The provider is the authority.** A write goes out first and the mirror
 *    is updated from what came back, so Jarvis can never show an event that
 *    Google or iCloud refused. There is nothing to merge and no conflict to
 *    resolve, which is why no conflict policy is configurable.
 * 2. **A read never touches the network.** "What do I have tomorrow?" is a
 *    local query against the mirror. Sync is what talks to a provider, on a
 *    timer, in the background.
 * 3. **Credentials leave this class only as an `Authorization` header.** They
 *    are read from the row inside a private method, never returned by a public
 *    one, never emitted on the bus and never written to a log.
 */
export class CalendarService {
  #timer: ReturnType<typeof setInterval> | null = null;
  #syncing = false;
  /** Serialises every sync, so a mandatory refresh can queue instead of drop. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CalendarServiceDeps) {}

  // ---------------------------------------------------------------- accounts --

  accounts(): CalendarAccount[] {
    return (
      this.deps.db.prepare('SELECT * FROM calendar_accounts ORDER BY created_at ASC').all() as Row[]
    ).map(rowToAccount);
  }

  account(id: string): CalendarAccount | null {
    const row = this.deps.db.prepare('SELECT * FROM calendar_accounts WHERE id = ?').get(id) as
      Row | undefined;
    return row ? rowToAccount(row) : null;
  }

  /** Calendars a credential can see, so the human can pick one before connecting. */
  async discover(input: {
    provider: CalendarProviderId;
    credentials: unknown;
  }): Promise<RemoteCalendar[]> {
    const credentials = parseCredentials(input.provider, input.credentials);
    return this.#withClient({ provider: input.provider, calendarId: '' }, credentials, (client) =>
      client.calendars(),
    );
  }

  /**
   * Connect a calendar and mirror it immediately.
   *
   * The credentials are proven against the provider BEFORE the row is written:
   * an account that cannot sync is worse than no account, because the failure
   * would only surface minutes later on a background timer.
   */
  async connect(input: {
    provider: CalendarProviderId;
    label?: string | null;
    credentials: unknown;
    calendarId?: string | null;
  }): Promise<CalendarAccount> {
    const credentials = parseCredentials(input.provider, input.credentials);
    const available = await this.#withClient(
      { provider: input.provider, calendarId: '' },
      credentials,
      (client) => client.calendars(),
    );
    const chosen = input.calendarId
      ? available.find((calendar) => calendar.id === input.calendarId)
      : available[0];
    if (!chosen) {
      throw new CalendarProviderError(
        input.calendarId
          ? 'that calendar is not available for these credentials'
          : 'no calendar was returned for these credentials',
      );
    }

    const now = nowIso();
    const account: CalendarAccount = {
      id: newId('cal'),
      provider: input.provider,
      label: (input.label?.trim() || chosen.name).slice(0, 80),
      calendarId: chosen.id,
      calendarName: chosen.name,
      status: 'active',
      // A shared or subscribed collection stays visible, but it is never
      // presented as editable -- see `#writable`.
      readOnly: chosen.writable === false,
      error: null,
      lastSyncAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db
      .prepare(
        `INSERT INTO calendar_accounts (id, provider, label, credentials, calendar_id, calendar_name,
           status, read_only, error, last_sync_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        account.id,
        account.provider,
        account.label,
        JSON.stringify(credentials),
        account.calendarId,
        account.calendarName,
        account.status,
        account.readOnly ? 1 : 0,
        null,
        null,
        now,
        now,
      );
    await this.sync(account.id);
    return this.account(account.id) ?? account;
  }

  /** Forget an account and its mirrored events. The remote calendar is untouched. */
  disconnect(id: string): boolean {
    const changes = this.deps.db
      .prepare('DELETE FROM calendar_accounts WHERE id = ?')
      .run(id).changes;
    if (!changes) return false;
    this.deps.bus.emit({ type: 'calendar.synced', payload: { accountId: id, disconnected: true } });
    return true;
  }

  // ------------------------------------------------------------------ reading --

  /**
   * The mirror. Local, bounded and free — this is what answers a question about
   * the week, in chat or in the UI.
   */
  events(
    query: {
      from?: string;
      to?: string;
      accountId?: string;
      search?: string;
      limit?: number;
    } = {},
  ): CalendarEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    // Overlap, not containment: a conference that started yesterday is still
    // what is happening today.
    //
    // Timed events overlap as INSTANTS; all-day events overlap as CALENDAR
    // DATES. Comparing an all-day event as an instant is what made the 10th
    // show up on the 9th for a caller in UTC-11 and on the 11th for one in
    // UTC+14. The bounds keep both readings because the caller's own lexical
    // date survives all the way here -- see `localIso`. The upper bound accepts
    // both an exclusive next-midnight and an inclusive same-day end -- see
    // `allDayUpperDate`.
    if (query.to) {
      where.push(
        `(CASE WHEN e.all_day = 1 THEN substr(e.starts_at, 1, 10) < ? ELSE e.starts_at < ? END)`,
      );
      params.push(allDayUpperDate(query.to), utcInstant(query.to));
    }
    if (query.from) {
      where.push(
        `(CASE WHEN e.all_day = 1 THEN substr(e.ends_at, 1, 10) > ? ELSE e.ends_at > ? END)`,
      );
      params.push(calendarDate(query.from), utcInstant(query.from));
    }
    if (query.accountId) {
      where.push('e.account_id = ?');
      params.push(query.accountId);
    }
    if (query.search?.trim()) {
      where.push(
        `(e.title LIKE ? ESCAPE '~' OR e.location LIKE ? ESCAPE '~' OR e.description LIKE ? ESCAPE '~')`,
      );
      const term = likeTerm(query.search.trim());
      params.push(term, term, term);
    }
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
    params.push(limit);
    const rows = this.deps.db
      .prepare(
        `SELECT e.*, a.provider AS provider, a.label AS source
           FROM calendar_events e JOIN calendar_accounts a ON a.id = e.account_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY e.starts_at ASC LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map(rowToEvent);
  }

  event(id: string): CalendarEvent | null {
    const row = this.deps.db
      .prepare(
        `SELECT e.*, a.provider AS provider, a.label AS source
           FROM calendar_events e JOIN calendar_accounts a ON a.id = e.account_id
          WHERE e.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  // ------------------------------------------------------------------ syncing --

  /** Start the background loop. Idempotent, and a no-op with no accounts. */
  start(): void {
    if (this.#timer) return;
    const interval = this.deps.config.calendar.syncIntervalMs;
    this.#timer = setInterval(() => {
      void this.sync().catch((error: unknown) => {
        log.warn('calendar sync failed', { error: String(error) });
      });
    }, interval);
    // Never hold the process open for a calendar refresh.
    this.#timer.unref?.();
    void this.sync().catch((error: unknown) => {
      log.warn('initial calendar sync failed', { error: String(error) });
    });
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Pull one account, or every account, into the mirror.
   *
   * A window replace rather than a delta: the provider is asked for everything
   * in the window and anything it did not return is removed. That is how an
   * event deleted or moved in Google or iCloud disappears here too, with no
   * sync-token bookkeeping to get wrong.
   *
   * Opportunistic: a timer tick that arrives while a sync is running simply
   * skips, because it has no reason to queue behind another timer. A refresh
   * that MUST happen goes through `#mustSync` instead.
   */
  async sync(accountId?: string): Promise<CalendarSyncReport[]> {
    if (this.#syncing) return [];
    return this.#mustSync(accountId);
  }

  /**
   * A sync that is not allowed to be dropped: it waits its turn.
   *
   * A post-write mirror repair is mandatory -- skipping it leaves sibling
   * occurrences of a shared CalDAV series holding an ETag the provider no
   * longer accepts, so the next write on any of them fails until a background
   * sync happens to run. Queued and coalesced on one chain, so it still never
   * overlaps another window replace.
   */
  #mustSync(accountId?: string): Promise<CalendarSyncReport[]> {
    const next = this.#queue.then(
      () => this.#syncNow(accountId),
      () => this.#syncNow(accountId),
    );
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #syncNow(accountId?: string): Promise<CalendarSyncReport[]> {
    const accounts = accountId
      ? [this.account(accountId)].filter((account): account is CalendarAccount => account !== null)
      : this.accounts();
    if (!accounts.length) return [];
    this.#syncing = true;
    try {
      const reports: CalendarSyncReport[] = [];
      for (const account of accounts) reports.push(await this.#syncOne(account));
      return reports;
    } finally {
      this.#syncing = false;
    }
  }

  async #syncOne(account: CalendarAccount): Promise<CalendarSyncReport> {
    const now = new Date();
    const from = new Date(
      now.getTime() - this.deps.config.calendar.windowPastDays * 86_400_000,
    ).toISOString();
    const to = new Date(
      now.getTime() + this.deps.config.calendar.windowFutureDays * 86_400_000,
    ).toISOString();
    const marker = nowIso();
    try {
      const remote = await this.#withClient(account, this.#credentials(account.id), (client) =>
        client.events({ from, to }),
      );
      const removed = transaction(this.deps.db, () => {
        const upsert = this.deps.db.prepare(
          `INSERT INTO calendar_events (id, account_id, remote_id, etag, title, description, location,
             starts_at, ends_at, all_day, recurring, series_id, raw, updated_at, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(account_id, remote_id) DO UPDATE SET
             etag=excluded.etag, title=excluded.title, description=excluded.description,
             location=excluded.location, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
             all_day=excluded.all_day, recurring=excluded.recurring, series_id=excluded.series_id,
             raw=excluded.raw, updated_at=excluded.updated_at, synced_at=excluded.synced_at`,
        );
        for (const event of remote) {
          upsert.run(
            newId('cev'),
            account.id,
            event.remoteId,
            event.etag,
            event.title.slice(0, 400),
            event.description?.slice(0, 4000) ?? null,
            event.location?.slice(0, 400) ?? null,
            event.startsAt,
            event.endsAt,
            event.allDay ? 1 : 0,
            event.recurring ? 1 : 0,
            event.seriesId,
            event.raw,
            marker,
            marker,
          );
        }
        // Gone from the provider inside the window, plus anything that has
        // fallen out of it entirely, so the mirror stays the size of the window.
        const stale = this.deps.db
          .prepare(
            `DELETE FROM calendar_events
              WHERE account_id = ? AND synced_at <> ? AND ends_at > ? AND starts_at < ?`,
          )
          .run(account.id, marker, from, to).changes;
        const expired = this.deps.db
          .prepare('DELETE FROM calendar_events WHERE account_id = ? AND ends_at <= ?')
          .run(account.id, from).changes;
        return Number(stale) + Number(expired);
      });

      this.#markSynced(account.id, null);
      this.deps.bus.emit({
        type: 'calendar.synced',
        payload: { accountId: account.id, events: remote.length, removed },
      });
      return {
        accountId: account.id,
        label: account.label,
        synced: remote.length,
        removed,
        error: null,
      };
    } catch (error) {
      const message = describeError(error);
      this.#markSynced(account.id, message);
      // The message is the provider's own status text, never a body or a
      // credential. See `davMessage` and `providerError`.
      log.warn('calendar account did not sync', { accountId: account.id, error: message });
      this.deps.bus.emit({
        type: 'calendar.sync.failed',
        payload: { accountId: account.id, error: message },
      });
      return { accountId: account.id, label: account.label, synced: 0, removed: 0, error: message };
    }
  }

  #markSynced(accountId: string, error: string | null): void {
    const now = nowIso();
    this.deps.db
      .prepare(
        `UPDATE calendar_accounts SET status = ?, error = ?, last_sync_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(error ? 'error' : 'active', error, now, now, accountId);
  }

  // ------------------------------------------------------------------ writing --

  async createEvent(input: {
    accountId: string;
    draft: CalendarEventDraft;
  }): Promise<CalendarEvent> {
    const account = this.#writable(input.accountId);
    const draft = normaliseDraft(input.draft);
    const created = await this.#withClient(account, this.#credentials(account.id), (client) =>
      client.create(draft),
    );
    const id = newId('cev');
    const now = nowIso();
    this.deps.db
      .prepare(
        `INSERT INTO calendar_events (id, account_id, remote_id, etag, title, description, location,
           starts_at, ends_at, all_day, recurring, series_id, raw, updated_at, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id, remote_id) DO UPDATE SET
           etag=excluded.etag, title=excluded.title, description=excluded.description,
           location=excluded.location, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
           all_day=excluded.all_day, series_id=excluded.series_id, raw=excluded.raw,
           updated_at=excluded.updated_at`,
      )
      .run(
        id,
        account.id,
        created.remoteId,
        created.etag,
        created.title,
        created.description,
        created.location,
        created.startsAt,
        created.endsAt,
        created.allDay ? 1 : 0,
        created.recurring ? 1 : 0,
        created.seriesId,
        created.raw,
        now,
        now,
      );
    const stored = this.#byRemote(account.id, created.remoteId);
    if (!stored) throw new Error('the event was created but could not be read back');
    this.deps.bus.emit({
      type: 'calendar.synced',
      payload: { accountId: account.id, changed: stored.id },
    });
    return stored;
  }

  /**
   * `scope` only matters when the event is recurring (see `RecurrenceScope`).
   * A `series` write changes the master's own properties, and only a resync
   * can correctly reflect that everywhere -- Jarvis does not evaluate RRULE
   * locally -- so this triggers one instead of guessing the touched row's new
   * fields. A Google `occurrence` write changes exactly the row that was asked
   * about, which is already known precisely: the draft that was sent.
   *
   * A CalDAV occurrence write is the exception -- see `mustRefresh`.
   */
  async updateEvent(
    id: string,
    patch: Partial<CalendarEventDraft>,
    scope: RecurrenceScope = 'occurrence',
  ): Promise<CalendarEvent> {
    const existing = this.event(id);
    if (!existing) throw new Error('event not found');
    const account = this.#writable(existing.accountId);
    const draft = normaliseDraft({
      title: patch.title ?? existing.title,
      startsAt: patch.startsAt ?? existing.startsAt,
      endsAt: patch.endsAt ?? existing.endsAt,
      allDay: patch.allDay ?? existing.allDay,
      description: patch.description === undefined ? existing.description : patch.description,
      location: patch.location === undefined ? existing.location : patch.location,
    });
    const changed = Object.fromEntries(
      (Object.keys(patch) as (keyof CalendarEventDraft)[])
        .filter((key) => draft[key] !== existing[key])
        .map((key) => [key, draft[key]]),
    ) as Partial<CalendarEventDraft>;
    const row = this.deps.db
      .prepare('SELECT etag, raw FROM calendar_events WHERE id = ?')
      .get(id) as Row | undefined;
    const effectiveScope: RecurrenceScope = existing.recurring ? scope : 'series';
    const updated = await this.#withClient(account, this.#credentials(account.id), (client) =>
      client.update(
        {
          remoteId: existing.remoteId,
          etag: (row?.etag as string | null) ?? null,
          raw: (row?.raw as string | null) ?? null,
          recurring: existing.recurring,
          seriesId: existing.seriesId,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          allDay: existing.allDay,
        },
        draft,
        effectiveScope,
        changed,
      ),
    );
    if (existing.recurring && mustRefresh(account.provider, effectiveScope)) {
      await this.#mustSync(account.id);
      const stored = this.event(id) ?? this.#byRemote(account.id, existing.remoteId);
      if (!stored)
        throw new Error('the series was updated but this occurrence could not be read back');
      return stored;
    }
    const now = nowIso();
    this.deps.db
      .prepare(
        `UPDATE calendar_events SET etag=?, title=?, description=?, location=?, starts_at=?,
           ends_at=?, all_day=?, series_id=?, raw=COALESCE(?, raw), updated_at=? WHERE id = ?`,
      )
      .run(
        updated.etag,
        updated.title,
        updated.description,
        updated.location,
        updated.startsAt,
        updated.endsAt,
        updated.allDay ? 1 : 0,
        updated.seriesId,
        updated.raw,
        now,
        id,
      );
    this.deps.bus.emit({
      type: 'calendar.synced',
      payload: { accountId: account.id, changed: id },
    });
    const stored = this.event(id);
    if (!stored) throw new Error('the event was updated but could not be read back');
    return stored;
  }

  /**
   * `scope` only matters when the event is recurring. A `series` delete
   * removes the whole recurring event, so a resync is what clears the other
   * occurrences' rows out of the local mirror -- they are not individually
   * deleted here, because Jarvis does not know which other rows belong to the
   * same series without asking the provider. An `occurrence` delete removes
   * exactly the row it was asked about and leaves the series in place.
   */
  async deleteEvent(
    id: string,
    scope: RecurrenceScope = 'occurrence',
  ): Promise<{ deleted: boolean; title: string }> {
    const existing = this.event(id);
    if (!existing) throw new Error('event not found');
    const account = this.#writable(existing.accountId);
    const row = this.deps.db
      .prepare('SELECT etag, raw FROM calendar_events WHERE id = ?')
      .get(id) as Row | undefined;
    const effectiveScope: RecurrenceScope = existing.recurring ? scope : 'series';
    await this.#withClient(account, this.#credentials(account.id), (client) =>
      client.remove(
        {
          remoteId: existing.remoteId,
          etag: (row?.etag as string | null) ?? null,
          raw: (row?.raw as string | null) ?? null,
          recurring: existing.recurring,
          seriesId: existing.seriesId,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          allDay: existing.allDay,
        },
        effectiveScope,
      ),
    );
    this.deps.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
    if (existing.recurring && mustRefresh(account.provider, effectiveScope)) {
      await this.#mustSync(account.id);
    }
    this.deps.bus.emit({
      type: 'calendar.synced',
      payload: { accountId: account.id, deleted: id },
    });
    return { deleted: true, title: existing.title };
  }

  // ------------------------------------------------------------------ private --

  #require(accountId: string): CalendarAccount {
    const account = this.account(accountId);
    if (!account) throw new Error('calendar account not found');
    return account;
  }

  /**
   * The account a mutation is allowed to touch.
   *
   * A read-only collection is refused HERE, before a provider is asked, so
   * Jarvis never claims a write it cannot make and never sends a doomed PUT.
   * Every calendar mutation -- UI, tool or chat -- routes through this.
   */
  #writable(accountId: string): CalendarAccount {
    const account = this.#require(accountId);
    if (account.readOnly) {
      throw new CalendarProviderError(
        `${account.label} is connected read-only; Jarvis cannot change events in it`,
      );
    }
    return account;
  }

  #byRemote(accountId: string, remoteId: string): CalendarEvent | null {
    const row = this.deps.db
      .prepare(
        `SELECT e.*, a.provider AS provider, a.label AS source
           FROM calendar_events e JOIN calendar_accounts a ON a.id = e.account_id
          WHERE e.account_id = ? AND e.remote_id = ?`,
      )
      .get(accountId, remoteId) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * The one place a stored credential is read.
   *
   * Nothing returns the value: it is handed straight to a client that turns it
   * into an `Authorization` header, and the client is discarded with the call.
   */
  #credentials(accountId: string): CalendarCredentials {
    const row = this.deps.db
      .prepare('SELECT provider, credentials FROM calendar_accounts WHERE id = ?')
      .get(accountId) as Row | undefined;
    if (!row) throw new Error('calendar account not found');
    return parseCredentials(
      row.provider as CalendarProviderId,
      JSON.parse(row.credentials as string),
    );
  }

  async #withClient<T>(
    account: Pick<CalendarAccount, 'provider' | 'calendarId'>,
    credentials: CalendarCredentials,
    run: (client: CalendarClient) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const client = this.deps.createClient
        ? this.deps.createClient(account, credentials, controller.signal)
        : account.provider === 'google'
          ? new GoogleCalendarClient(
              credentials as GoogleCredentials,
              account.calendarId,
              controller.signal,
            )
          : new CalDavClient(
              credentials as IcloudCredentials,
              account.calendarId,
              controller.signal,
            );
      return await run(client);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Provider-controlled text (a title, location, description or account label)
 * made safe to fold into a prompt.
 *
 * Title, location, description and the account label all come from Google or
 * iCloud, which means a shared calendar or an invitation the user never
 * authored can put arbitrary text in them, including newlines and fenced
 * delimiters crafted to look like a new prompt section or a closing fence.
 * Collapsing control characters to spaces and capping the length keeps that
 * text a single inert line of DATA no matter what it contains; nothing here
 * makes it any more trusted, only harder to use as a delimiter.
 */
export function sanitizeCalendarText(value: string, maxLen = 300): string {
  const controlChars = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]+`,
    'g',
  );
  const flat = value.replace(controlChars, ' ').replace(/```/g, "'''").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat;
}

/**
 * Render provider values as a JSON observation for a model prompt.
 *
 * This is intentionally not Markdown: values stay values in a fixed schema,
 * and escaping angle brackets makes it impossible for provider text to close
 * the surrounding untrusted-data marker. The resulting JSON is still legible
 * enough for Jarvis to answer schedule questions.
 */
export function renderCalendarObservation(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' ? sanitizeCalendarText(item, 500) : item,
  ).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A human-readable one-liner for an event, used in chat and in tool results. */
export function describeEvent(event: CalendarEvent): string {
  const when = event.allDay
    ? `${event.startsAt.slice(0, 10)} (all day)`
    : `${formatLocal(event.startsAt)}–${formatLocal(event.endsAt).slice(-5)}`;
  const location = event.location ? sanitizeCalendarText(event.location, 120) : '';
  return [
    when,
    sanitizeCalendarText(event.title, 200),
    location ? `@ ${location}` : '',
    `[${sanitizeCalendarText(event.source, 80)}]`,
    `id=${event.id}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** `YYYY-MM-DD HH:MM` in the machine's own timezone, which is the user's. */
function formatLocal(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function describeError(error: unknown): string {
  if (error instanceof CalendarProviderError) return error.message;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError'
      ? 'the calendar server did not answer in time'
      : error.message;
  }
  return String(error);
}

/**
 * Validate credentials at the boundary.
 *
 * The shapes are small and fixed, so this both narrows the type and refuses a
 * half-filled form before anything is stored or sent.
 */
export function parseCredentials(provider: CalendarProviderId, raw: unknown): CalendarCredentials {
  const value = (raw ?? {}) as Record<string, unknown>;
  const field = (key: string): string =>
    typeof value[key] === 'string' ? (value[key] as string).trim() : '';
  if (provider === 'google') {
    const credentials = {
      clientId: field('clientId'),
      clientSecret: field('clientSecret'),
      refreshToken: field('refreshToken'),
    };
    if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
      throw new CalendarProviderError(
        'Google needs an OAuth client id, client secret and refresh token',
      );
    }
    return credentials;
  }
  const credentials = { appleId: field('appleId'), appPassword: field('appPassword') };
  if (!credentials.appleId || !credentials.appPassword) {
    throw new CalendarProviderError('iCloud needs an Apple ID and an app-specific password');
  }
  return credentials;
}

/**
 * Must the whole account be refreshed before this write reports success?
 *
 * A `series` write changes the master's own properties, and Jarvis does not
 * evaluate RRULE locally, so only a resync can reflect it everywhere.
 *
 * A CalDAV `occurrence` write needs it just as much, for a different reason:
 * every occurrence of a CalDAV series lives in ONE shared resource, so writing
 * one instance changes the provider ETag for all of them and returns the whole
 * multi-VEVENT body rather than that occurrence's own. Without the refresh the
 * siblings keep a stale ETag -- and the edited row keeps an undifferentiated
 * series resource where occurrence-specific state belongs -- so the next write
 * on any of them fails `If-Match` until a background sync happens to run.
 * Google addresses each instance as its own resource with its own ETag, so it
 * needs nothing here.
 */
function mustRefresh(provider: CalendarProviderId, scope: RecurrenceScope): boolean {
  return scope === 'series' || provider === 'icloud';
}

/**
 * Bounds are compared as text against UTC columns, so an offset like `+02:00`
 * would sort wrong. Anything unparseable is left alone for SQLite to reject.
 */
/**
 * The EXCLUSIVE all-day date bound a `to` instant means.
 *
 * Both shapes a caller sends are honoured, because both are sensible and the
 * model picks either one. A next-midnight bound (`2026-09-11T00:00:00+02:00`)
 * is already exclusive and keeps its date. An inclusive same-day bound
 * (`2026-09-10T23:59:59+02:00`, or any other instant past midnight) means the
 * 10th is being asked about, so the exclusive date is the day after -- without
 * this, "what do I have on September 10?" returned the timed events and
 * silently dropped the all-day ones.
 *
 * Midnight is read LEXICALLY, from the offset the caller wrote: 00:00 at
 * UTC-11 and 00:00 at UTC+14 are both midnight, and neither is midnight once
 * converted to UTC. A bare `YYYY-MM-DD` has no clock at all, so it is midnight.
 */
const LOCAL_MIDNIGHT = /^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function allDayUpperDate(value: string): string {
  const date = calendarDate(value);
  return LOCAL_MIDNIGHT.test(value.trim()) ? date : addCalendarDays(date, 1);
}

function utcInstant(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Refuse a draft that could not be placed on a timeline. */
export function normaliseDraft(draft: CalendarEventDraft): CalendarEventDraft {
  const title = draft.title.trim();
  if (!title) throw new Error('an event needs a title');
  const start = new Date(draft.startsAt);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid start: ${draft.startsAt}`);
  const allDay = draft.allDay;
  const rawEnd = new Date(draft.endsAt);
  // A missing or backwards end is a common way for a natural-language request
  // to arrive; a default is friendlier than a refusal and can be corrected.
  const timedEndGiven = !Number.isNaN(rawEnd.getTime()) && rawEnd.getTime() > start.getTime();
  const startDate = allDay ? calendarDate(draft.startsAt) : null;
  // All-day endpoints are exclusive calendar dates. Comparing their instants
  // would make an offset change decide whether the same lexical day is valid.
  const allDayEndGiven =
    allDay && /^\d{4}-\d{2}-\d{2}/.test(draft.endsAt.trim())
      ? (calendarDate(draft.endsAt) as string) > (startDate as string)
      : false;
  const endGiven = allDay ? allDayEndGiven : timedEndGiven;
  const end = endGiven ? rawEnd : new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));

  // A real end keeps its own calendar date -- the provider's exclusive
  // end-date semantics -- a missing/backwards one defaults to the day after
  // start, which is what a one-day all-day event's exclusive end must be.
  const endDate = allDay
    ? endGiven
      ? calendarDate(draft.endsAt)
      : addCalendarDays(startDate as string, 1)
    : null;

  return {
    title: title.slice(0, 400),
    startsAt: allDay ? `${startDate}T00:00:00.000Z` : start.toISOString(),
    endsAt: allDay ? `${endDate}T00:00:00.000Z` : end.toISOString(),
    allDay,
    description: draft.description?.trim().slice(0, 4000) || null,
    location: draft.location?.trim().slice(0, 400) || null,
  };
}

function rowToAccount(row: Row): CalendarAccount {
  return {
    id: row.id as string,
    provider: row.provider as CalendarProviderId,
    label: row.label as string,
    calendarId: row.calendar_id as string,
    calendarName: (row.calendar_name as string | null) ?? null,
    status: (row.status as 'active' | 'error') ?? 'active',
    readOnly: Number(row.read_only ?? 0) === 1,
    error: (row.error as string | null) ?? null,
    lastSyncAt: (row.last_sync_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToEvent(row: Row): CalendarEvent {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    provider: row.provider as CalendarProviderId,
    source: row.source as string,
    remoteId: row.remote_id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    startsAt: row.starts_at as string,
    endsAt: row.ends_at as string,
    allDay: Number(row.all_day) === 1,
    recurring: Number(row.recurring) === 1,
    seriesId: (row.series_id as string | null) ?? null,
    updatedAt: row.updated_at as string,
    syncedAt: row.synced_at as string,
  };
}
