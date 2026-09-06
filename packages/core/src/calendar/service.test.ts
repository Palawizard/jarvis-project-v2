import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { CalDavClient } from './caldav.js';
import { GoogleCalendarClient } from './google.js';
import { buildIcs, parseVEvents, patchIcs } from './ical.js';
import { CalendarService, normaliseDraft } from './service.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import type {
  CalendarClient,
  CalendarEvent,
  CalendarEventDraft,
  RemoteEvent,
  RemoteEventRef,
} from './types.js';

/** A remote that accepts anything, for tests about what reaches it. */
function stubClient(): CalendarClient {
  return {
    async calendars() {
      return [{ id: 'primary', name: 'Personal' }];
    },
    async events() {
      return [];
    },
    async create(value) {
      return {
        ...value,
        remoteId: 'remote-1',
        etag: 'v1',
        raw: null,
        recurring: false,
        seriesId: null,
      };
    },
    async update(ref: RemoteEventRef, value: CalendarEventDraft) {
      return {
        ...value,
        remoteId: ref.remoteId,
        etag: 'v2',
        raw: null,
        recurring: false,
        seriesId: null,
      };
    },
    async remove() {},
  };
}

const draft: CalendarEventDraft = {
  title: 'Planning',
  startsAt: '2026-09-10T08:00:00.000Z',
  endsAt: '2026-09-10T09:00:00.000Z',
  allDay: false,
  description: null,
  location: 'Office',
};

describe('calendar mirror', () => {
  it('pulls provider changes and sends every local mutation back first', async () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const remote: RemoteEvent[] = [
      { ...draft, remoteId: 'remote-1', etag: 'v1', raw: null, recurring: false, seriesId: null },
    ];
    const client: CalendarClient = {
      async calendars() {
        return [{ id: 'primary', name: 'Personal' }];
      },
      async events() {
        return remote.map((event) => ({ ...event }));
      },
      async create(value) {
        const event = {
          ...value,
          remoteId: `remote-${remote.length + 1}`,
          etag: 'v1',
          raw: null,
          recurring: false,
          seriesId: null,
        };
        remote.push(event);
        return event;
      },
      async update(ref: RemoteEventRef, value: CalendarEventDraft) {
        const index = remote.findIndex((event) => event.remoteId === ref.remoteId);
        const event = {
          ...value,
          remoteId: ref.remoteId,
          etag: 'v2',
          raw: null,
          recurring: false,
          seriesId: null,
        };
        remote[index] = event;
        return event;
      },
      async remove(ref: RemoteEventRef) {
        remote.splice(
          remote.findIndex((event) => event.remoteId === ref.remoteId),
          1,
        );
      },
    };
    const service = new CalendarService({
      db,
      bus: new EventBus(db),
      config: loadConfig({ dbPath: ':memory:' }),
      createClient: () => client,
    });

    const account = await service.connect({
      provider: 'google',
      credentials: { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
    });
    expect(service.accounts()[0]).not.toHaveProperty('credentials');
    expect(service.events().map((event) => event.title)).toEqual(['Planning']);

    remote[0] = { ...(remote[0] as RemoteEvent), title: 'Planning changed elsewhere' };
    await service.sync();
    expect(service.events()[0]?.title).toBe('Planning changed elsewhere');

    const created = await service.createEvent({ accountId: account.id, draft });
    expect(remote).toHaveLength(2);
    const updated = await service.updateEvent(created.id, { title: 'Retrospective' });
    expect(updated.title).toBe('Retrospective');
    await service.deleteEvent(created.id);
    expect(remote).toHaveLength(1);

    remote.splice(0);
    await service.sync();
    expect(service.events()).toEqual([]);
    db.close();
  });

  it('accepts the offset timestamps chat asks the model for', async () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const service = new CalendarService({
      db,
      bus: new EventBus(db),
      config: loadConfig({ dbPath: ':memory:' }),
      createClient: () => stubClient(),
    });
    const tools = registerBuiltinTools({ calendar: service } as never, {
      db,
      bus: new EventBus(db),
      defaultTimeoutMs: 500,
    });
    const account = await service.connect({
      provider: 'google',
      credentials: { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
    });
    tools.grant({ toolName: 'calendar.create', actor: 'user' });

    // Exactly what dispatch hands the tool for "tomorrow at 9" in Paris.
    const created = await tools.execute(
      'calendar.create',
      {
        accountId: account.id,
        draft: {
          title: 'Planning',
          startsAt: '2026-09-10T09:00:00+02:00',
          endsAt: '2026-09-10T10:00:00+02:00',
        },
      },
      { actor: 'user' },
    );
    expect(created.status).toBe('succeeded');
    expect(service.events()[0]?.startsAt).toBe('2026-09-10T07:00:00.000Z');

    const listed = await tools.execute(
      'calendar.list',
      { from: '2026-09-10T00:00:00+02:00', to: '2026-09-11T00:00:00+02:00' },
      { actor: 'user' },
    );
    const found = listed.status === 'succeeded' ? (listed.result as CalendarEvent[]) : [];
    expect(found.map((event) => event.title)).toEqual(['Planning']);
    db.close();
  });

  it('changes only the fields a patch actually names', async () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const service = new CalendarService({
      db,
      bus: new EventBus(db),
      config: loadConfig({ dbPath: ':memory:' }),
      createClient: () => stubClient(),
    });
    const tools = registerBuiltinTools({ calendar: service } as never, {
      db,
      bus: new EventBus(db),
      defaultTimeoutMs: 500,
    });
    const account = await service.connect({
      provider: 'google',
      credentials: { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
    });
    tools.grant({ toolName: 'calendar.update', actor: 'user' });
    const event = await service.createEvent({
      accountId: account.id,
      draft: {
        title: 'Offsite',
        startsAt: '2026-09-10T00:00:00.000Z',
        endsAt: '2026-09-11T00:00:00.000Z',
        allDay: true,
        description: 'Bring the deck',
        location: 'Lyon',
      },
    });

    // A rename must not silently clear the description and location or turn an
    // all-day event into a timed one on the user's real calendar.
    const renamed = await tools.execute(
      'calendar.update',
      { id: event.id, patch: { title: 'Offsite (moved)' } },
      { actor: 'user' },
    );
    expect(renamed.status).toBe('succeeded');
    expect(service.event(event.id)).toMatchObject({
      title: 'Offsite (moved)',
      description: 'Bring the deck',
      location: 'Lyon',
      allDay: true,
      startsAt: '2026-09-10T00:00:00.000Z',
    });

    const empty = await tools.execute(
      'calendar.update',
      { id: event.id, patch: {} },
      { actor: 'user' },
    );
    expect(empty.status).toBe('failed');
    db.close();
  });

  it('keeps the iCloud partition host that discovery returned', async () => {
    const seen: string[] = [];
    const multistatus = (body: string) =>
      new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`, {
        status: 207,
        headers: { 'content-type': 'application/xml' },
      });
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      // iCloud answers the home-set with a partition host, then bare paths.
      if (seen.length === 1)
        return multistatus(
          '<d:response><d:current-user-principal><d:href>/123456/principal/</d:href>' +
            '</d:current-user-principal></d:response>',
        );
      if (seen.length === 2)
        return multistatus(
          '<d:response><c:calendar-home-set xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            '<d:href>https://p42-caldav.icloud.com/123456/calendars/</d:href>' +
            '</c:calendar-home-set></d:response>',
        );
      return multistatus(
        '<d:response><d:href>/123456/calendars/work/</d:href>' +
          '<d:resourcetype><d:collection/><c:calendar xmlns:c="urn:ietf:params:xml:ns:caldav"/>' +
          '</d:resourcetype><d:displayname>Work</d:displayname>' +
          '<c:supported-calendar-component-set xmlns:c="urn:ietf:params:xml:ns:caldav">' +
          '<c:comp name="VEVENT"/></c:supported-calendar-component-set></d:response>',
      );
    }) as typeof fetch;
    try {
      const client = new CalDavClient({ appleId: 'a@b.c', appPassword: 'pw' }, '');
      expect(await client.calendars()).toEqual([
        { id: 'https://p42-caldav.icloud.com/123456/calendars/work/', name: 'Work' },
      ]);
      expect(seen[2]).toBe('https://p42-caldav.icloud.com/123456/calendars/');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps unknown iCalendar properties when editing an event', () => {
    const original = buildIcs('event@example', draft).replace(
      'END:VEVENT',
      'ATTENDEE:mailto:friend@example.com\r\nEND:VEVENT',
    );
    const changed = patchIcs(original, { ...draft, title: 'Changed' });
    expect(changed).toContain('ATTENDEE:mailto:friend@example.com');
    expect(parseVEvents(changed)[0]).toMatchObject({ summary: 'Changed', location: 'Office' });

    const unicode = buildIcs('unicode@example', { ...draft, title: 'Équipe '.repeat(20) });
    expect(unicode.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(parseVEvents(unicode)[0]?.summary).toBe('Équipe '.repeat(20).trim());
  });

  it('keeps all-day bounds as lexical calendar dates across offsets and providers', async () => {
    const cases = [
      ['2026-09-10T00:00:00+14:00', '2026-09-11T00:00:00+14:00'],
      ['2026-09-10T00:00:00-11:00', '2026-09-12T00:00:00-11:00'],
      ['2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z'],
    ] as const;
    for (const [startsAt, endsAt] of cases) {
      expect(normaliseDraft({ ...draft, startsAt, endsAt, allDay: true })).toMatchObject({
        startsAt: '2026-09-10T00:00:00.000Z',
        endsAt: endsAt.startsWith('2026-09-12')
          ? '2026-09-12T00:00:00.000Z'
          : '2026-09-11T00:00:00.000Z',
      });
    }
    // Equal lexical dates are a one-day event, even if their offsets make the
    // end instant later than the start instant.
    expect(
      normaliseDraft({
        ...draft,
        startsAt: '2026-09-10T00:00:00+14:00',
        endsAt: '2026-09-10T00:00:00-11:00',
        allDay: true,
      }),
    ).toMatchObject({
      startsAt: '2026-09-10T00:00:00.000Z',
      endsAt: '2026-09-11T00:00:00.000Z',
    });

    const outbound = normaliseDraft({
      ...draft,
      startsAt: '2026-09-10T00:00:00+02:00',
      endsAt: '2026-09-12T00:00:00+02:00',
      allDay: true,
    });
    const calls: Array<{ url: string; body: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/token')) {
        return Response.json({ access_token: 'test-token', expires_in: 3600 });
      }
      calls.push({ url: target, body: String(init?.body ?? '') });
      if (target.includes('googleapis.com')) {
        return Response.json({
          id: 'google-event',
          start: { date: '2026-09-10' },
          end: { date: '2026-09-12' },
        });
      }
      return new Response('', { headers: { etag: 'caldav-v1' } });
    }) as typeof fetch;
    try {
      await new GoogleCalendarClient(
        { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
        'secondary',
      ).create(outbound);
      await new CalDavClient(
        { appleId: 'a@b.c', appPassword: 'pw' },
        'https://cal.example/work/',
      ).create(outbound);
      expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
        start: { date: '2026-09-10' },
        end: { date: '2026-09-12' },
      });
      expect(calls[1]?.body).toContain('DTSTART;VALUE=DATE:20260910');
      expect(calls[1]?.body).toContain('DTEND;VALUE=DATE:20260912');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('updates and deletes either a CalDAV occurrence or its whole series with ETags', async () => {
    const seriesUrl = 'https://cal.example/work/series.ics';
    const recurrenceId = '20260911T090000Z';
    const master = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:series@example',
      'DTSTART:20260910T090000Z',
      'DTEND:20260910T100000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Standup',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const occurrence = master.replace('RRULE:FREQ=DAILY;COUNT=3', `RECURRENCE-ID:${recurrenceId}`);
    const calls: Array<{ method: string; url: string; body: string; ifMatch: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url),
        body: String(init?.body ?? ''),
        ifMatch: headers.get('if-match'),
      });
      if (init?.method === 'GET') return new Response(master);
      return new Response(init?.method === 'DELETE' ? null : '', {
        status: init?.method === 'DELETE' ? 204 : 200,
        headers: { etag: 'v2' },
      });
    }) as typeof fetch;
    const ref: RemoteEventRef = {
      remoteId: `${seriesUrl}#${recurrenceId}`,
      seriesId: seriesUrl,
      etag: 'v1',
      raw: occurrence,
      recurring: true,
    };
    try {
      const client = new CalDavClient(
        { appleId: 'a@b.c', appPassword: 'pw' },
        'https://cal.example/work/',
      );
      await client.update(ref, { ...draft, title: 'Moved' }, 'occurrence');
      await client.update(ref, { ...draft, title: 'All moved' }, 'series');
      await client.remove(ref, 'occurrence');
      await client.remove(ref, 'series');

      const puts = calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(3);
      expect(puts.every((call) => call.url === seriesUrl && call.ifMatch === '"v1"')).toBe(true);
      expect(puts[0]?.body).toContain(`RECURRENCE-ID:${recurrenceId}`);
      expect(puts[0]?.body).toContain('SUMMARY:Moved');
      expect(puts[1]?.body).toContain('SUMMARY:All moved');
      expect(puts[2]?.body).toContain(`EXDATE:${recurrenceId}`);
      expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: seriesUrl, ifMatch: '"v1"' });
    } finally {
      globalThis.fetch = original;
    }
  });
});
