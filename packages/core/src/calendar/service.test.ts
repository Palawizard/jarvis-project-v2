import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { CalDavClient } from './caldav.js';
import { GoogleCalendarClient } from './google.js';
import { addCalendarDays, isCalendarDate } from './dates.js';
import { buildIcs, parseIcsDate, parseVEvents, patchIcs } from './ical.js';
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
      return [{ id: 'primary', name: 'Personal', writable: true }];
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
        return [{ id: 'primary', name: 'Personal', writable: true }];
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
    const client = stubClient();
    const update = client.update.bind(client);
    let sentPatch: Partial<CalendarEventDraft> | undefined;
    client.update = async (ref, value, scope, patch) => {
      sentPatch = patch;
      return update(ref, value, scope, patch);
    };
    const service = new CalendarService({
      db,
      bus: new EventBus(db),
      config: loadConfig({ dbPath: ':memory:' }),
      createClient: () => client,
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

    // The web form sends a materialised draft. The provider still receives
    // only the value that changed, so a series update cannot copy an
    // occurrence's dates onto its master.
    const current = service.event(event.id) as CalendarEvent;
    await service.updateEvent(event.id, {
      title: 'Offsite (final)',
      startsAt: current.startsAt,
      endsAt: current.endsAt,
      allDay: current.allDay,
      description: current.description,
      location: current.location,
    });
    expect(sentPatch).toEqual({ title: 'Offsite (final)' });

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
        {
          id: 'https://p42-caldav.icloud.com/123456/calendars/work/',
          name: 'Work',
          writable: true,
        },
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
    // Europe/Paris changes from UTC+2 to UTC+1 between the master and this occurrence.
    const recurrenceId = '20261026T090000';
    const master = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:series@example',
      'DTSTART;TZID=Europe/Paris:20261024T090000',
      'DTEND;TZID=Europe/Paris:20261024T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Standup',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const occurrence = master.replace(
      'RRULE:FREQ=DAILY;COUNT=3',
      `RECURRENCE-ID;TZID=Europe/Paris:${recurrenceId}`,
    );
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
      startsAt: '2026-10-26T08:00:00.000Z',
      endsAt: '2026-10-26T09:00:00.000Z',
      allDay: false,
    };
    const occurrenceDraft = {
      ...draft,
      startsAt: ref.startsAt,
      endsAt: ref.endsAt,
    };
    try {
      const client = new CalDavClient(
        { appleId: 'a@b.c', appPassword: 'pw' },
        'https://cal.example/work/',
      );
      await client.update(ref, { ...occurrenceDraft, title: 'Moved' }, 'occurrence');
      await client.update(ref, { ...occurrenceDraft, title: 'All moved' }, 'series', {
        title: 'All moved',
      });
      await client.update(
        ref,
        {
          ...occurrenceDraft,
          startsAt: '2026-10-26T09:00:00.000Z',
          endsAt: '2026-10-26T10:00:00.000Z',
        },
        'series',
        {
          startsAt: '2026-10-26T09:00:00.000Z',
          endsAt: '2026-10-26T10:00:00.000Z',
        },
      );
      await client.remove(ref, 'occurrence');
      await client.remove(ref, 'series');

      const puts = calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(4);
      expect(puts.every((call) => call.url === seriesUrl && call.ifMatch === '"v1"')).toBe(true);
      expect(puts[0]?.body).toContain(`RECURRENCE-ID;TZID=Europe/Paris:${recurrenceId}`);
      expect(puts[0]?.body).toContain('SUMMARY:Moved');
      expect(puts[1]?.body).toContain('SUMMARY:All moved');
      expect(puts[1]?.body).toContain('DTSTART;TZID=Europe/Paris:20261024T090000');
      expect(puts[1]?.body).not.toContain('DTSTART;TZID=Europe/Paris:20261026T090000');
      // The +1 hour occurrence edit is applied to the master's wall clock,
      // while its TZID stays attached so future RRULE instances survive DST.
      expect(puts[2]?.body).toContain('DTSTART;TZID=Europe/Paris:20261024T100000');
      expect(puts[2]?.body).toContain('DTEND;TZID=Europe/Paris:20261024T110000');
      expect(puts[2]?.body).not.toContain('DTSTART:20261024T080000Z');
      expect(puts[3]?.body).toContain(`EXDATE;TZID=Europe/Paris:${recurrenceId}`);
      expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: seriesUrl, ifMatch: '"v1"' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('PATCHes a Google series title without moving its master to the selected occurrence', async () => {
    const calls: Array<{ method: string; body: unknown; ifMatch: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/token')) {
        return Response.json({ access_token: 'test-token', expires_in: 3600 });
      }
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        ifMatch: new Headers(init?.headers).get('if-match'),
      });
      if (method === 'GET') {
        return Response.json({
          id: 'series-1',
          etag: 'master-v2',
          summary: 'Standup',
          start: { dateTime: '2026-09-10T09:00:00.000Z' },
          end: { dateTime: '2026-09-10T10:00:00.000Z' },
        });
      }
      return Response.json({
        id: 'series-1',
        etag: 'master-v3',
        summary: 'Renamed standup',
        start: { dateTime: '2026-09-10T09:00:00.000Z' },
        end: { dateTime: '2026-09-10T10:00:00.000Z' },
      });
    }) as typeof fetch;
    try {
      const client = new GoogleCalendarClient(
        { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
        'primary',
      );
      const ref: RemoteEventRef = {
        remoteId: 'occurrence-2',
        seriesId: 'series-1',
        etag: 'occurrence-v1',
        raw: null,
        recurring: true,
        startsAt: '2026-09-11T09:00:00.000Z',
        endsAt: '2026-09-11T10:00:00.000Z',
        allDay: false,
      };
      await client.update(
        ref,
        { ...draft, title: 'Renamed standup', startsAt: ref.startsAt, endsAt: ref.endsAt },
        'series',
        { title: 'Renamed standup' },
      );

      expect(calls).toEqual([
        { method: 'GET', body: null, ifMatch: null },
        { method: 'PATCH', body: { summary: 'Renamed standup' }, ifMatch: 'master-v2' },
      ]);

      await client.update(
        ref,
        {
          ...draft,
          startsAt: '2026-09-11T10:00:00.000Z',
          endsAt: '2026-09-11T11:00:00.000Z',
        },
        'series',
        {
          startsAt: '2026-09-11T10:00:00.000Z',
          endsAt: '2026-09-11T11:00:00.000Z',
        },
      );
      expect(calls[3]).toMatchObject({
        method: 'PATCH',
        body: {
          start: { dateTime: '2026-09-10T10:00:00.000Z' },
          end: { dateTime: '2026-09-10T11:00:00.000Z' },
        },
        ifMatch: 'master-v2',
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('identifies a CalDAV series from its stored RRULE, not from the expansion', async () => {
    const seriesUrl = 'https://cal.example/work/series.ics';
    const stored = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:series@example',
      'DTSTART;TZID=Europe/Paris:20260910T090000',
      'DTEND;TZID=Europe/Paris:20260910T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Standup',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    // RFC 4791 §9.6.5: expansion drops RRULE, and the first instance carries no
    // RECURRENCE-ID of its own. 09:00 in Paris is 07:00Z in September.
    const instance = (day: string, labelled = true) =>
      [
        'BEGIN:VEVENT',
        'UID:series@example',
        ...(labelled ? [`RECURRENCE-ID;TZID=Europe/Paris:${day}T090000`] : []),
        `DTSTART:${day}T070000Z`,
        `DTEND:${day}T080000Z`,
        'SUMMARY:Standup',
        'END:VEVENT',
      ].join('\r\n');
    const expansion = (...events: string[]) =>
      ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n');

    const events = async (expanded: string) => {
      const original = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const text = String(init?.body ?? '').includes('expand') ? expanded : stored;
        return new Response(
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>' +
            `<d:href>${seriesUrl}</d:href><d:getetag>"v1"</d:getetag>` +
            `<c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav"><![CDATA[${text}]]>` +
            '</c:calendar-data></d:response></d:multistatus>',
          { status: 207, headers: { 'content-type': 'application/xml' } },
        );
      }) as typeof fetch;
      try {
        return await new CalDavClient(
          { appleId: 'a@b.c', appPassword: 'pw' },
          'https://cal.example/work/',
        ).events({ from: draft.startsAt, to: draft.endsAt });
      } finally {
        globalThis.fetch = original;
      }
    };

    // A window holding only the first instance still reads as a series, and its
    // occurrence id is the master's own DTSTART, in the master's own zone.
    const alone = await events(expansion(instance('20260910', false)));
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatchObject({
      remoteId: `${seriesUrl}#20260910T090000`,
      seriesId: seriesUrl,
      recurring: true,
    });
    expect(alone[0]?.raw).toContain('RECURRENCE-ID;TZID=Europe/Paris:20260910T090000');

    // The whole expanded window: the unlabelled first instance is addressable
    // alongside the ones the server did label.
    const many = await events(
      expansion(instance('20260910', false), instance('20260911'), instance('20260912')),
    );
    expect(many.map((event) => event.remoteId)).toEqual([
      `${seriesUrl}#20260910T090000`,
      `${seriesUrl}#20260911T090000`,
      `${seriesUrl}#20260912T090000`,
    ]);

    const first = many[0] as RemoteEvent;
    const ref: RemoteEventRef = {
      remoteId: first.remoteId,
      etag: first.etag,
      raw: first.raw,
      recurring: first.recurring,
      seriesId: first.seriesId,
      startsAt: first.startsAt,
      endsAt: first.endsAt,
      allDay: first.allDay,
    };

    // Editing and deleting that first occurrence must reach the provider and
    // leave the recurrence rule standing.
    const puts: Array<{ body: string; ifMatch: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') return new Response(stored, { headers: { etag: '"v1"' } });
      puts.push({
        body: String(init?.body ?? ''),
        ifMatch: new Headers(init?.headers).get('if-match'),
      });
      return new Response('', { headers: { etag: '"v2"' } });
    }) as typeof fetch;
    try {
      const dav = new CalDavClient(
        { appleId: 'a@b.c', appPassword: 'pw' },
        'https://cal.example/work/',
      );
      const edited = { ...draft, title: 'Just today', startsAt: ref.startsAt };
      await dav.update(ref, edited, 'occurrence');
      await dav.remove(ref, 'occurrence');
    } finally {
      globalThis.fetch = original;
    }
    expect(puts).toHaveLength(2);
    expect(puts.every((put) => put.ifMatch === '"v1"')).toBe(true);
    // The override names the first instance; the series keeps its rule.
    expect(puts[0]?.body).toContain('RECURRENCE-ID;TZID=Europe/Paris:20260910T090000');
    expect(puts[0]?.body).toContain('SUMMARY:Just today');
    expect(puts[0]?.body).toContain('RRULE:FREQ=DAILY;COUNT=3');
    expect(puts[0]?.body).toContain('DTSTART;TZID=Europe/Paris:20260910T090000');
    // Deleting it excludes the instance and, again, keeps the rule.
    expect(puts[1]?.body).toContain('EXDATE;TZID=Europe/Paris:20260910T090000');
    expect(puts[1]?.body).toContain('RRULE:FREQ=DAILY;COUNT=3');
  });

  it('returns an all-day event on exactly its calendar date, in every offset', async () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const allDay = (remoteId: string, from: string, to: string, title: string): RemoteEvent => ({
      title,
      startsAt: `${from}T00:00:00.000Z`,
      endsAt: `${to}T00:00:00.000Z`,
      allDay: true,
      description: null,
      location: null,
      remoteId,
      etag: 'v1',
      raw: null,
      recurring: false,
      seriesId: null,
    });
    const remote: RemoteEvent[] = [
      allDay('one', '2026-09-10', '2026-09-11', 'One day'),
      // Exclusive end: the 14th, 15th and 16th, and nothing on the 17th.
      allDay('many', '2026-09-14', '2026-09-17', 'Three days'),
      { ...draft, remoteId: 'timed', etag: 'v1', raw: null, recurring: false, seriesId: null },
    ];
    const service = new CalendarService({
      db,
      bus: new EventBus(db),
      config: loadConfig({ dbPath: ':memory:' }),
      createClient: () => ({
        ...stubClient(),
        async events() {
          return remote.map((event) => ({ ...event }));
        },
      }),
    });
    await service.connect({
      provider: 'google',
      credentials: { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
    });

    // The caller's own calendar day, as the browser, a tool and chat all send
    // it: a local wall clock carrying its offset.
    const onDay = (date: string, offset: string) =>
      service
        .events({
          from: `${date}T00:00:00.000${offset}`,
          to: `${addCalendarDays(date, 1)}T00:00:00.000${offset}`,
        })
        .filter((event) => event.allDay)
        .map((event) => event.title);

    for (const offset of ['Z', '+02:00', '-05:00', '+14:00', '-11:00']) {
      expect([offset, onDay('2026-09-09', offset)]).toEqual([offset, []]);
      expect([offset, onDay('2026-09-10', offset)]).toEqual([offset, ['One day']]);
      expect([offset, onDay('2026-09-11', offset)]).toEqual([offset, []]);

      expect([offset, onDay('2026-09-13', offset)]).toEqual([offset, []]);
      for (const date of ['2026-09-14', '2026-09-15', '2026-09-16']) {
        expect([offset, date, onDay(date, offset)]).toEqual([offset, date, ['Three days']]);
      }
      expect([offset, onDay('2026-09-17', offset)]).toEqual([offset, []]);
    }

    // Timed events keep instant semantics: 08:00Z is the 10th in UTC and still
    // the 9th for a caller at UTC-11.
    const timed = (date: string, offset: string) =>
      service
        .events({
          from: `${date}T00:00:00.000${offset}`,
          to: `${addCalendarDays(date, 1)}T00:00:00.000${offset}`,
        })
        .filter((event) => !event.allDay)
        .map((event) => event.title);
    expect(timed('2026-09-10', 'Z')).toEqual(['Planning']);
    expect(timed('2026-09-10', '-11:00')).toEqual([]);
    expect(timed('2026-09-09', '-11:00')).toEqual(['Planning']);
    db.close();
  });

  it('rebases a series across an all-day conversion by calendar date, not elapsed millis', async () => {
    // Europe/Paris leaves CEST on 2026-10-25: the master runs at UTC+2 and the
    // selected occurrence at UTC+1.
    const timedOccurrence = {
      startsAt: '2026-10-26T08:00:00.000Z',
      endsAt: '2026-10-26T09:00:00.000Z',
      allDay: false,
    };
    const asAllDay = {
      ...draft,
      startsAt: '2026-10-26T00:00:00.000Z',
      endsAt: '2026-10-27T00:00:00.000Z',
      allDay: true,
    };
    const allDayOccurrence = {
      startsAt: '2026-10-26T00:00:00.000Z',
      endsAt: '2026-10-27T00:00:00.000Z',
      allDay: true,
    };
    const asTimed = {
      ...draft,
      startsAt: '2026-10-26T09:00:00.000Z',
      endsAt: '2026-10-26T10:00:00.000Z',
      allDay: false,
    };
    // Exactly the keys a "move this occurrence" edit names.
    const patchOf = (value: { startsAt: string; endsAt: string; allDay: boolean }) => ({
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      allDay: value.allDay,
    });

    // ---------------------------------------------------------------- Google --
    const googlePatch = async (
      master: Record<string, unknown>,
      occurrence: { startsAt: string; endsAt: string; allDay: boolean },
      updated: CalendarEventDraft,
    ) => {
      let sent: Record<string, unknown> = {};
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('/token')) {
          return Response.json({ access_token: 'test-token', expires_in: 3600 });
        }
        if ((init?.method ?? 'GET') === 'GET') return Response.json(master);
        sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Response.json({ id: 'series', ...master });
      }) as typeof fetch;
      try {
        await new GoogleCalendarClient(
          { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
          'primary',
        ).update(
          {
            remoteId: 'series_20261026',
            etag: 'occ',
            raw: null,
            recurring: true,
            seriesId: 'series',
            ...occurrence,
          },
          updated,
          'series',
          patchOf(updated),
        );
      } finally {
        globalThis.fetch = original;
      }
      return sent;
    };

    // TIMED -> ALL-DAY. Elapsed-instant arithmetic would move the 09:00 (UTC+2)
    // master back to 23:00 on 2026-10-23; the calendar date it is on is the 24th.
    expect(
      await googlePatch(
        {
          id: 'series',
          etag: 'master',
          start: { dateTime: '2026-10-24T09:00:00+02:00' },
          end: { dateTime: '2026-10-24T10:00:00+02:00' },
        },
        timedOccurrence,
        asAllDay,
      ),
    ).toMatchObject({ start: { date: '2026-10-24' }, end: { date: '2026-10-25' } });

    // ALL-DAY -> TIMED: the master keeps its own date and takes the chosen clock.
    expect(
      await googlePatch(
        {
          id: 'series',
          etag: 'master',
          start: { date: '2026-10-24' },
          end: { date: '2026-10-25' },
        },
        allDayOccurrence,
        asTimed,
      ),
    ).toMatchObject({
      start: { dateTime: '2026-10-24T09:00:00.000Z' },
      end: { dateTime: '2026-10-24T10:00:00.000Z' },
    });

    // ---------------------------------------------------------------- CalDAV --
    const davPut = async (
      master: string[],
      occurrence: { startsAt: string; endsAt: string; allDay: boolean },
      updated: CalendarEventDraft,
    ) => {
      const stored = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        ...master,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      let body = '';
      const original = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') return new Response(stored);
        body = String(init?.body ?? '');
        return new Response('', { headers: { etag: '"v2"' } });
      }) as typeof fetch;
      try {
        await new CalDavClient(
          { appleId: 'a@b.c', appPassword: 'pw' },
          'https://cal.example/work/',
        ).update(
          {
            remoteId: 'https://cal.example/work/series.ics#20261026T090000',
            etag: 'v1',
            raw: null,
            recurring: true,
            seriesId: 'https://cal.example/work/series.ics',
            ...occurrence,
          },
          updated,
          'series',
          patchOf(updated),
        );
      } finally {
        globalThis.fetch = original;
      }
      return body;
    };

    const timedToAllDay = await davPut(
      [
        'UID:series@example',
        'DTSTART;TZID=Europe/Paris:20261024T090000',
        'DTEND;TZID=Europe/Paris:20261024T100000',
        'RRULE:FREQ=DAILY;COUNT=5',
        'SUMMARY:Standup',
      ],
      timedOccurrence,
      asAllDay,
    );
    expect(timedToAllDay).toContain('DTSTART;VALUE=DATE:20261024');
    expect(timedToAllDay).toContain('DTEND;VALUE=DATE:20261025');
    expect(timedToAllDay).not.toContain('20261023');
    expect(timedToAllDay).toContain('RRULE:FREQ=DAILY;COUNT=5');

    const allDayToTimed = await davPut(
      [
        'UID:series@example',
        'DTSTART;VALUE=DATE:20261024',
        'DTEND;VALUE=DATE:20261025',
        'RRULE:FREQ=DAILY;COUNT=5',
        'SUMMARY:Standup',
      ],
      allDayOccurrence,
      asTimed,
    );
    expect(allDayToTimed).toContain('DTSTART:20261024T090000');
    expect(allDayToTimed).toContain('DTEND:20261024T100000');
    expect(allDayToTimed).toContain('RRULE:FREQ=DAILY;COUNT=5');
  });

  it('refreshes every CalDAV sibling occurrence onto the new ETag before reporting success', async () => {
    const calendarUrl = 'https://cal.example/work/';
    const seriesUrl = `${calendarUrl}series.ics`;
    const occurrence = (day: string, summary: string) => [
      'BEGIN:VEVENT',
      'UID:series@example',
      `RECURRENCE-ID;TZID=Europe/Paris:2026${day}T090000`,
      `DTSTART;TZID=Europe/Paris:2026${day}T090000`,
      `DTEND;TZID=Europe/Paris:2026${day}T100000`,
      `SUMMARY:${summary}`,
      'END:VEVENT',
    ];
    const server = {
      text: [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:series@example',
        'DTSTART;TZID=Europe/Paris:20261019T090000',
        'DTEND;TZID=Europe/Paris:20261019T100000',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:Standup',
        'END:VEVENT',
        ...occurrence('1020', 'Standup B'),
        ...occurrence('1021', 'Standup C'),
        'END:VCALENDAR',
      ].join('\r\n'),
      etag: 'e1',
      version: 1,
    };
    // Every If-Match a write actually sent, and every one the server refused.
    const ifMatch: string[] = [];
    const refused: string[] = [];
    const multistatus = (body: string) =>
      new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`, {
        status: 207,
        headers: { 'content-type': 'application/xml' },
      });
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = String(init?.body ?? '');
      if (method === 'PROPFIND' && body.includes('current-user-principal')) {
        return multistatus(
          '<d:response><d:current-user-principal><d:href>/p/</d:href>' +
            '</d:current-user-principal></d:response>',
        );
      }
      if (method === 'PROPFIND' && body.includes('calendar-home-set')) {
        return multistatus(
          '<d:response><c:calendar-home-set xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            '<d:href>https://cal.example/home/</d:href></c:calendar-home-set></d:response>',
        );
      }
      if (method === 'PROPFIND') {
        return multistatus(
          `<d:response><d:href>${calendarUrl}</d:href><d:resourcetype><d:collection/>` +
            '<c:calendar xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:resourcetype>' +
            '<d:displayname>Work</d:displayname>' +
            '<c:supported-calendar-component-set xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            '<c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
            '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>' +
            '<d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:response>',
        );
      }
      if (method === 'REPORT') {
        return multistatus(
          `<d:response><d:href>${seriesUrl}</d:href><d:getetag>"${server.etag}"</d:getetag>` +
            '<c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            `<![CDATA[${server.text}]]></c:calendar-data></d:response>`,
        );
      }
      if (method === 'GET') {
        return new Response(server.text, { headers: { etag: `"${server.etag}"` } });
      }
      if (method === 'PUT') {
        const sent = new Headers(init?.headers).get('if-match');
        ifMatch.push(sent ?? 'none');
        // A real server refuses a stale If-Match, which is exactly what the
        // sibling occurrences used to send until a background sync ran.
        if (sent !== `"${server.etag}"`) {
          refused.push(sent ?? 'none');
          return new Response('', { status: 412 });
        }
        server.text = body;
        server.etag = `e${++server.version}`;
        return new Response('', { headers: { etag: `"${server.etag}"` } });
      }
      throw new Error(`unexpected ${method}`);
    }) as typeof fetch;

    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    try {
      const service = new CalendarService({
        db,
        bus: new EventBus(db),
        config: loadConfig({ dbPath: ':memory:' }),
      });
      await service.connect({
        provider: 'icloud',
        credentials: { appleId: 'a@b.c', appPassword: 'pw' },
        calendarId: calendarUrl,
      });
      const etags = () =>
        (
          db.prepare('SELECT remote_id, etag FROM calendar_events ORDER BY starts_at').all() as {
            remote_id: string;
            etag: string;
          }[]
        ).map((row) => row.etag);
      const byRecurrenceId = (day: string) =>
        service.events().find((event) => event.remoteId === `${seriesUrl}#2026${day}T090000`);

      expect(service.events()).toHaveLength(3);
      expect(etags()).toEqual(['e1', 'e1', 'e1']);

      // Edit occurrence B while a background sync is already running: the
      // mandatory post-write refresh must QUEUE, never be dropped by the
      // "already syncing" guard.
      const inFlight = service.sync();
      const b = byRecurrenceId('1020') as CalendarEvent;
      await service.updateEvent(b.id, { title: 'B moved' }, 'occurrence');
      await inFlight;
      expect(etags()).toEqual(['e2', 'e2', 'e2']);
      // Each row still holds its OWN occurrence, not the whole series resource.
      const bRaw = db.prepare('SELECT raw FROM calendar_events WHERE id = ?').get(b.id) as {
        raw: string;
      };
      expect(bRaw.raw).toContain('RECURRENCE-ID;TZID=Europe/Paris:20261020T090000');
      expect(bRaw.raw).not.toContain('RRULE');
      expect(bRaw.raw).not.toContain('Standup C');

      // Immediately delete a sibling: it must already carry the new ETag.
      const c = byRecurrenceId('1021') as CalendarEvent;
      await service.deleteEvent(c.id, 'occurrence');
      expect(service.events()).toHaveLength(2);
      expect(etags()).toEqual(['e3', 'e3']);

      // ...and editing after that delete works the same way round.
      const again = byRecurrenceId('1020') as CalendarEvent;
      await service.updateEvent(again.id, { title: 'B moved again' }, 'occurrence');
      expect(etags()).toEqual(['e4', 'e4']);
      expect(server.text).toContain('SUMMARY:B moved again');

      expect(ifMatch).toEqual(['"e1"', '"e2"', '"e3"']);
      expect(refused).toEqual([]);
    } finally {
      globalThis.fetch = original;
      db.close();
    }
  });

  it('reports CalDAV writability and refuses to mutate a read-only calendar', async () => {
    const privileges = (writable: boolean) =>
      '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>' +
      (writable ? '<d:privilege><d:write/></d:privilege>' : '') +
      '</d:current-user-privilege-set>';
    const collection = (href: string, name: string, writable: boolean) =>
      `<d:response><d:href>${href}</d:href><d:resourcetype><d:collection/>` +
      '<c:calendar xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:resourcetype>' +
      `<d:displayname>${name}</d:displayname>` +
      '<c:supported-calendar-component-set xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      `<c:comp name="VEVENT"/></c:supported-calendar-component-set>${privileges(writable)}` +
      '</d:response>';
    const multistatus = (body: string) =>
      new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`, {
        status: 207,
        headers: { 'content-type': 'application/xml' },
      });
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return multistatus(
          '<d:response><d:current-user-principal><d:href>/p/</d:href>' +
            '</d:current-user-principal></d:response>',
        );
      }
      if (calls === 2) {
        return multistatus(
          '<d:response><c:calendar-home-set xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            '<d:href>https://cal.example/home/</d:href></c:calendar-home-set></d:response>',
        );
      }
      return multistatus(
        collection('https://cal.example/home/work/', 'Work', true) +
          collection('https://cal.example/home/shared/', 'Team (shared)', false),
      );
    }) as typeof fetch;
    try {
      expect(
        await new CalDavClient({ appleId: 'a@b.c', appPassword: 'pw' }, '').calendars(),
      ).toEqual([
        { id: 'https://cal.example/home/work/', name: 'Work', writable: true },
        { id: 'https://cal.example/home/shared/', name: 'Team (shared)', writable: false },
      ]);
    } finally {
      globalThis.fetch = original;
    }

    // Connected read-only, every mutation is refused HERE -- the provider is
    // never asked, and no tool can claim otherwise.
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    let reached = 0;
    const service = new CalendarService({
      db,
      bus: new EventBus(db),
      config: loadConfig({ dbPath: ':memory:' }),
      createClient: () => ({
        ...stubClient(),
        async calendars() {
          return [{ id: 'shared', name: 'Team (shared)', writable: false }];
        },
        async create(value) {
          reached += 1;
          return {
            ...value,
            remoteId: 'remote-1',
            etag: 'v1',
            raw: null,
            recurring: false,
            seriesId: null,
          };
        },
      }),
    });
    const tools = registerBuiltinTools({ calendar: service } as never, {
      db,
      bus: new EventBus(db),
      defaultTimeoutMs: 500,
    });
    const account = await service.connect({
      provider: 'icloud',
      credentials: { appleId: 'a@b.c', appPassword: 'pw' },
    });
    expect(account.readOnly).toBe(true);
    expect(service.accounts()[0]?.readOnly).toBe(true);

    tools.grant({ toolName: 'calendar.create', actor: 'user' });
    const created = await tools.execute(
      'calendar.create',
      { accountId: account.id, draft: { ...draft } },
      { actor: 'user' },
    );
    expect(created.status).toBe('failed');
    expect(reached).toBe(0);
    await expect(service.createEvent({ accountId: account.id, draft })).rejects.toThrow(
      /read-only/,
    );
    db.close();
  });

  it('refuses impossible calendar dates instead of letting Date normalise them', () => {
    for (const valid of ['2024-02-29', '2026-01-31', '2026-04-30', '2026-12-31', '2000-02-29']) {
      expect([valid, isCalendarDate(valid)]).toEqual([valid, true]);
    }
    for (const invalid of [
      '2025-02-29',
      '2026-02-30',
      '2026-00-10',
      '2026-13-01',
      '2026-01-00',
      '2026-04-31',
      '1900-02-29',
      '2026-1-01',
      '20260101',
      '2026-01-01T00:00:00Z',
    ]) {
      expect([invalid, isCalendarDate(invalid)]).toEqual([invalid, false]);
    }

    // Provider input goes through the same gate: an impossible date is refused,
    // never silently mirrored onto the day `Date` would have normalised it to.
    expect(parseIcsDate('20260230')).toBeNull();
    expect(parseIcsDate('20261301')).toBeNull();
    expect(parseIcsDate('20260229')).toBeNull();
    expect(parseIcsDate('20240229')).toBe('2024-02-29T00:00:00.000Z');
    expect(parseIcsDate('20260230T090000Z')).toBeNull();
    expect(
      parseVEvents(['BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260230', 'END:VEVENT'].join('\r\n')),
    ).toEqual([]);

    // A user draft is refused the same way.
    expect(() =>
      normaliseDraft({ ...draft, startsAt: '2026-02-30', endsAt: '2026-03-01', allDay: true }),
    ).toThrow();
    expect(
      normaliseDraft({ ...draft, startsAt: '2024-02-29', endsAt: '2024-03-01', allDay: true }),
    ).toMatchObject({ startsAt: '2024-02-29T00:00:00.000Z', endsAt: '2024-03-01T00:00:00.000Z' });
  });
});
