import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarEventDraft,
  type CalendarProvider,
  type JarvisEvent,
  type RecurrenceScope,
  type RemoteCalendar,
} from '../api.ts';
import { Badge, Card, Empty, useModalDialog } from '../components.tsx';
import { useAsync } from '../hooks.ts';
import { approvePending } from './Chat.tsx';

type EventForm = CalendarEventDraft & { id?: string; accountId: string; recurring?: boolean };

export function CalendarView({ lastEvent }: { lastEvent: JarvisEvent | null }) {
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const range = useMemo(() => monthGrid(month), [month]);
  const accounts = useAsync<CalendarAccount[]>(() => api.calendarAccounts(), []);
  // Local wall-clock bounds, not `toISOString()`: the server filters all-day
  // events by the CALENDAR DATE asked about, and a UTC conversion would have
  // already rolled that date to its neighbour outside UTC.
  const events = useAsync<CalendarEvent[]>(
    () => api.calendarEvents({ from: localBound(range.start), to: localBound(range.end) }),
    [localBound(range.start), localBound(range.end)],
  );
  const [editing, setEditing] = useState<EventForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleChoice, setGoogleChoice] = useState<RemoteCalendar[] | null>(null);
  // A read-only calendar is visible but never editable: every control that
  // would mutate it is disabled here, before any tool or provider is reached.
  const writable = (accounts.data ?? []).filter((account) => !account.readOnly);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('google') === 'error') {
      setError(params.get('message') ?? 'Google connection failed');
    } else if (params.get('google') === 'choose') {
      // OAuth credentials and the bounded connection selector remain
      // server-side (the latter in an HttpOnly cookie), never in this URL or
      // React state. The UI receives only writable calendar names and ids.
      void api
        .googleConnectionCalendars()
        .then(({ calendars }) => setGoogleChoice(calendars))
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }
    if (params.has('google')) history.replaceState({}, '', '/calendar');
  }, []);

  useEffect(() => {
    if (!lastEvent?.type.startsWith('calendar.')) return;
    accounts.reload();
    events.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  const reload = () => {
    accounts.reload();
    events.reload();
  };
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page wide calendar-page" data-testid="calendar-view">
      <div className="page-title">
        <div>
          <h1>Calendar</h1>
          <p>Google Calendar and iCloud, kept in sync automatically.</p>
        </div>
        <div className="row wrap">
          <button
            className="btn"
            disabled={busy}
            onClick={() => void act(() => api.syncCalendars())}
          >
            Sync now
          </button>
          <button
            className="btn primary"
            disabled={!writable.length}
            onClick={() => setEditing(newEvent(writable[0]?.id ?? ''))}
          >
            ＋ Event
          </button>
        </div>
      </div>

      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}

      <div className="calendar-layout">
        <aside className="calendar-sources">
          <Card title="Calendars">
            {(accounts.data ?? []).map((account) => (
              <div className="calendar-account" key={account.id}>
                <div className="spread">
                  <strong>{account.label}</strong>
                  <Badge tone={account.status === 'active' ? 'ok' : 'err'}>
                    {account.provider}
                  </Badge>
                </div>
                {account.readOnly && (
                  <div className="tiny faint" data-testid={`calendar-read-only-${account.id}`}>
                    Read-only — Jarvis can show this calendar but not change it.
                  </div>
                )}
                <div className="tiny faint">
                  {account.lastSyncAt
                    ? `Synced ${new Date(account.lastSyncAt).toLocaleString()}`
                    : 'Waiting for first sync'}
                </div>
                {account.error && <div className="tiny err-text">{account.error}</div>}
                <button
                  className="btn sm danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !confirm(
                        `Disconnect ${account.label}? Its remote events will not be deleted.`,
                      )
                    )
                      return;
                    void act(() => api.disconnectCalendar(account.id));
                  }}
                >
                  Disconnect
                </button>
              </div>
            ))}
            {!accounts.loading && !accounts.data?.length && (
              <Empty>No calendar connected yet.</Empty>
            )}
          </Card>
          <ConnectCalendar busy={busy} onBusy={setBusy} onError={setError} onConnected={reload} />
        </aside>

        <section className="calendar-main" aria-label="Month calendar">
          <div className="calendar-toolbar">
            <div className="row">
              <button
                className="btn sm"
                aria-label="Previous month"
                onClick={() => setMonth(addMonths(month, -1))}
              >
                ←
              </button>
              <button className="btn sm" onClick={() => setMonth(monthStart(new Date()))}>
                Today
              </button>
              <button
                className="btn sm"
                aria-label="Next month"
                onClick={() => setMonth(addMonths(month, 1))}
              >
                →
              </button>
            </div>
            <h2>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
          </div>

          <div className="calendar-weekdays" aria-hidden="true">
            {weekdays().map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {range.days.map((day) => {
              const dayEvents = (events.data ?? []).filter((event) => overlapsDay(event, day));
              return (
                <div
                  className={`calendar-day ${day.getMonth() === month.getMonth() ? '' : 'outside'} ${sameDay(day, new Date()) ? 'today' : ''}`}
                  key={day.toISOString()}
                >
                  <button
                    className="calendar-day-number"
                    disabled={!writable.length}
                    onClick={() => setEditing(newEvent(writable[0]?.id ?? '', day))}
                    aria-label={`Create event on ${day.toLocaleDateString()}`}
                  >
                    <span className="calendar-mobile-date">
                      {day.toLocaleDateString(undefined, { weekday: 'short', month: 'short' })}{' '}
                    </span>
                    {day.getDate()}
                  </button>
                  <div className="calendar-day-events">
                    {dayEvents.slice(0, 4).map((event) => (
                      <button
                        className={`calendar-event ${event.provider}`}
                        key={event.id}
                        data-testid={`calendar-event-${event.id}`}
                        onClick={() => setEditing(eventForm(event))}
                        title={`${event.title} — ${event.source}`}
                      >
                        {!event.allDay && <time>{time(event.startsAt)}</time>}
                        <span>{event.title}</span>
                      </button>
                    ))}
                    {dayEvents.length > 4 && (
                      <span className="tiny faint">+{dayEvents.length - 4} more</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {!events.loading && !(events.data ?? []).length && (
            <div className="calendar-empty">No events this month.</div>
          )}
        </section>
      </div>

      {editing && (
        <EventDialog
          value={editing}
          accounts={accounts.data ?? []}
          readOnly={Boolean(
            (accounts.data ?? []).find((account) => account.id === editing.accountId)?.readOnly,
          )}
          busy={busy}
          error={error}
          onCancel={() => {
            setEditing(null);
            setError(null);
          }}
          onSave={(value, scope) =>
            void act(async () => {
              const draft = toDraft(value);
              const patch = value.id ? eventPatch(editing, value) : null;
              if (patch && !Object.keys(patch).length) {
                setEditing(null);
                return;
              }
              const outcome = value.id
                ? await api.updateCalendarEvent(
                    value.id,
                    patch ?? {},
                    value.recurring ? scope : undefined,
                  )
                : await api.createCalendarEvent(value.accountId, draft);
              await approvePending(outcome);
              setEditing(null);
            })
          }
          onDelete={
            editing.id
              ? (scope) =>
                  void act(async () => {
                    if (
                      !confirm(
                        `Delete “${editing.title}” from ${sourceName(editing, accounts.data ?? [])}?`,
                      )
                    )
                      return;
                    await approvePending(
                      await api.deleteCalendarEvent(
                        editing.id as string,
                        editing.recurring ? scope : undefined,
                      ),
                    );
                    setEditing(null);
                  })
              : undefined
          }
        />
      )}

      {googleChoice && (
        <GoogleCalendarChooser
          calendars={googleChoice}
          busy={busy}
          error={error}
          onCancel={() => {
            setGoogleChoice(null);
            setError(null);
            // Drop the exchanged credential server-side now rather than
            // leaving it to expire.
            void api.cancelGoogleConnection().catch(() => undefined);
          }}
          onConnect={(calendarId, label) =>
            void act(async () => {
              await api.connectGoogleConnection(calendarId, label);
              setGoogleChoice(null);
            })
          }
        />
      )}
    </div>
  );
}

function GoogleCalendarChooser({
  calendars,
  busy,
  error,
  onCancel,
  onConnect,
}: {
  calendars: RemoteCalendar[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConnect: (calendarId: string, label?: string) => void;
}) {
  const ref = useModalDialog(true);
  const [calendarId, setCalendarId] = useState(calendars[0]?.id ?? '');
  const [label, setLabel] = useState('');
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      data-testid="google-calendar-chooser"
      onCancel={onCancel}
    >
      <h2>Choose a Google calendar</h2>
      {calendars.length === 0 ? (
        <Empty>No writable Google calendar was found for this account.</Empty>
      ) : (
        <div className="settings-form">
          <label>
            Calendar
            <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
              {calendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Display name (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
        </div>
      )}
      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}
      <div className="spread dialog-actions">
        <div />
        <div className="row">
          <button className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {calendars.length > 0 && (
            <button
              className="btn primary"
              disabled={busy || !calendarId}
              onClick={() => onConnect(calendarId, label || undefined)}
            >
              {busy ? 'Connecting…' : 'Connect calendar'}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function ConnectCalendar({
  busy,
  onBusy,
  onError,
  onConnected,
}: {
  busy: boolean;
  onBusy: (value: boolean) => void;
  onError: (value: string | null) => void;
  onConnected: () => void;
}) {
  const [provider, setProvider] = useState<CalendarProvider>('google');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [found, setFound] = useState<RemoteCalendar[]>([]);
  const [calendarId, setCalendarId] = useState('');
  const [label, setLabel] = useState('');

  const run = async (work: () => Promise<void>) => {
    onBusy(true);
    onError(null);
    try {
      await work();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      onBusy(false);
    }
  };
  const field = (name: string, value: string) =>
    setCredentials((old) => ({ ...old, [name]: value }));

  return (
    <Card title="Connect">
      <div className="settings-form">
        <label>
          Provider
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as CalendarProvider);
              setCredentials({});
              setFound([]);
            }}
          >
            <option value="google">Google Calendar</option>
            <option value="icloud">iCloud</option>
          </select>
        </label>
        {provider === 'google' ? (
          <>
            <p className="tiny faint">
              Create a Web OAuth client with Calendar API access and register this redirect URI:
              <br />
              <code>{location.origin}/api/calendar/google/callback</code>
            </p>
            <SecretField
              label="OAuth client ID"
              value={credentials.clientId ?? ''}
              onChange={(v) => field('clientId', v)}
            />
            <SecretField
              label="OAuth client secret"
              value={credentials.clientSecret ?? ''}
              onChange={(v) => field('clientSecret', v)}
            />
            <button
              className="btn primary"
              disabled={busy || !credentials.clientId || !credentials.clientSecret}
              onClick={() =>
                void run(async () => {
                  const authorization = await api.authorizeGoogleCalendar(
                    credentials.clientId ?? '',
                    credentials.clientSecret ?? '',
                  );
                  location.assign(authorization.url);
                })
              }
            >
              Continue with Google
            </button>
          </>
        ) : (
          <>
            <p className="tiny faint">
              Use your Apple ID and an app-specific password, not your Apple password.
            </p>
            <label>
              Apple ID
              <input
                value={credentials.appleId ?? ''}
                autoComplete="username"
                onChange={(e) => field('appleId', e.target.value)}
              />
            </label>
            <SecretField
              label="App-specific password"
              value={credentials.appPassword ?? ''}
              onChange={(v) => field('appPassword', v)}
            />
          </>
        )}
        {provider === 'icloud' && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const calendars = await api.discoverCalendars(provider, credentials);
                setFound(calendars);
                setCalendarId(calendars[0]?.id ?? '');
              })
            }
          >
            Find calendars
          </button>
        )}
        {found.length > 0 && (
          <>
            <label>
              Calendar
              <select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>
                {found.map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name}
                    {calendar.writable ? '' : ' (read-only)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Display name (optional)
              <input value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <button
              className="btn primary"
              disabled={busy || !calendarId}
              onClick={() =>
                void run(async () => {
                  await api.connectCalendar(provider, credentials, calendarId, label || undefined);
                  setCredentials({});
                  setFound([]);
                  setLabel('');
                  onConnected();
                })
              }
            >
              Connect calendar
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function EventDialog({
  value,
  accounts,
  readOnly,
  busy,
  error,
  onCancel,
  onSave,
  onDelete,
}: {
  value: EventForm;
  accounts: CalendarAccount[];
  readOnly: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (value: EventForm, scope: RecurrenceScope) => void;
  onDelete?: (scope: RecurrenceScope) => void;
}) {
  const ref = useModalDialog(true);
  const [form, setForm] = useState(value);
  const [scope, setScope] = useState<RecurrenceScope>('occurrence');
  const patch = (change: Partial<EventForm>) => setForm((old) => ({ ...old, ...change }));
  const valid = Boolean(form.title.trim() && form.startsAt && form.endsAt && form.accountId);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog event-dialog"
      data-testid="event-dialog"
      onCancel={onCancel}
    >
      <h2>{form.id ? 'Edit event' : 'New event'}</h2>
      <div className="settings-form">
        <label>
          Calendar
          <select
            disabled={Boolean(form.id)}
            value={form.accountId}
            onChange={(e) => patch({ accountId: e.target.value })}
          >
            {accounts
              .filter((account) => !account.readOnly || account.id === form.accountId)
              .map((account) => (
                <option value={account.id} key={account.id}>
                  {account.label}
                  {account.readOnly ? ' (read-only)' : ''}
                </option>
              ))}
          </select>
        </label>
        <label>
          Title
          <input autoFocus value={form.title} onChange={(e) => patch({ title: e.target.value })} />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.allDay}
            onChange={(e) =>
              patch(
                e.target.checked
                  ? {
                      allDay: true,
                      startsAt: form.startsAt.slice(0, 10),
                      endsAt: form.endsAt.slice(0, 10),
                    }
                  : {
                      allDay: false,
                      startsAt: `${form.startsAt.slice(0, 10)}T09:00`,
                      endsAt: `${form.endsAt.slice(0, 10)}T10:00`,
                    },
              )
            }
          />
          All day
        </label>
        <div className="grid cols-2">
          <label>
            Starts
            <input
              type={form.allDay ? 'date' : 'datetime-local'}
              value={form.startsAt}
              onChange={(e) => patch({ startsAt: e.target.value })}
            />
          </label>
          <label>
            Ends
            <input
              type={form.allDay ? 'date' : 'datetime-local'}
              value={form.endsAt}
              onChange={(e) => patch({ endsAt: e.target.value })}
            />
          </label>
        </div>
        <label>
          Location
          <input
            value={form.location ?? ''}
            onChange={(e) => patch({ location: e.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            value={form.description ?? ''}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>
        {form.id && value.recurring && (
          <div role="radiogroup" aria-label="Apply to">
            <label className="check">
              <input
                type="radio"
                name="recurrence-scope"
                checked={scope === 'occurrence'}
                onChange={() => setScope('occurrence')}
              />
              This event
            </label>
            <label className="check">
              <input
                type="radio"
                name="recurrence-scope"
                checked={scope === 'series'}
                onChange={() => setScope('series')}
              />
              All events in the series
            </label>
          </div>
        )}
      </div>
      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}
      {readOnly && (
        <div className="api-error" role="status" data-testid="event-read-only">
          This calendar is connected read-only. Jarvis cannot change its events.
        </div>
      )}
      <div className="spread dialog-actions">
        <div>
          {onDelete && (
            <button
              className="btn danger"
              disabled={busy || readOnly}
              onClick={() => onDelete(scope)}
            >
              Delete
            </button>
          )}
        </div>
        <div className="row">
          <button className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !valid || readOnly}
            onClick={() => onSave(form, scope)}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function newEvent(accountId: string, day = new Date()): EventForm {
  const start = new Date(day);
  start.setHours(day.getHours() === 0 ? 9 : day.getHours() + 1, 0, 0, 0);
  const end = new Date(start.getTime() + 3_600_000);
  return {
    accountId,
    title: '',
    startsAt: localInput(start),
    endsAt: localInput(end),
    allDay: false,
    description: null,
    location: null,
  };
}

export function eventForm(event: CalendarEvent): EventForm {
  return {
    ...event,
    startsAt: event.allDay ? event.startsAt.slice(0, 10) : localInput(new Date(event.startsAt)),
    endsAt: event.allDay ? event.endsAt.slice(0, 10) : localInput(new Date(event.endsAt)),
  };
}

function toDraft(form: CalendarEventDraft): CalendarEventDraft {
  const iso = (value: string) =>
    form.allDay ? `${value.slice(0, 10)}T00:00:00.000Z` : new Date(value).toISOString();
  return {
    title: form.title,
    startsAt: iso(form.startsAt),
    endsAt: iso(form.endsAt),
    allDay: form.allDay,
    description: form.description?.trim() || null,
    location: form.location?.trim() || null,
  };
}

export function eventPatch(
  before: CalendarEventDraft,
  after: CalendarEventDraft,
): Partial<CalendarEventDraft> {
  const old = toDraft(before);
  const next = toDraft(after);
  return Object.fromEntries(
    (Object.keys(next) as (keyof CalendarEventDraft)[])
      .filter((key) => next[key] !== old[key])
      .map((key) => [key, next[key]]),
  ) as Partial<CalendarEventDraft>;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function addMonths(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}
function monthGrid(month: Date) {
  const start = new Date(month);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + 42);
  const days: Date[] = [];
  for (const day = new Date(start); day < end; day.setDate(day.getDate() + 1))
    days.push(new Date(day));
  return { start, end, days };
}
function weekdays(): string[] {
  const monday = new Date(2024, 0, 1);
  return Array.from({ length: 7 }, (_, index) =>
    new Date(monday.getTime() + index * 86_400_000).toLocaleDateString(undefined, {
      weekday: 'short',
    }),
  );
}
export function overlapsDay(event: CalendarEvent, day: Date): boolean {
  if (event.allDay) {
    // An all-day event is stored as midnight-UTC bounds with an exclusive end,
    // so it is a range of calendar dates, not an interval of instants. Compared
    // as instants it bleeds into the neighbouring cell for anyone outside UTC.
    const key = dayKey(day);
    return event.startsAt.slice(0, 10) <= key && key < event.endsAt.slice(0, 10);
  }
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return new Date(event.startsAt).getTime() < end && new Date(event.endsAt).getTime() > start;
}
function dayKey(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}
function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/** A local wall-clock bound whose lexical `YYYY-MM-DD` is the day the human sees. */
function localBound(date: Date): string {
  return `${localInput(date)}:00`;
}
function localInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function sourceName(event: EventForm, accounts: CalendarAccount[]): string {
  return accounts.find((account) => account.id === event.accountId)?.label ?? 'its calendar';
}
