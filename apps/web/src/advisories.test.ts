import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, PlainText } from './components.tsx';
import { confirmationState, describePendingTarget } from './views/Chat.tsx';
import { eventForm, eventPatch, overlapsDay } from './views/Calendar.tsx';
import { mergeEvents } from './views/JobDetail.tsx';
import type { CalendarEvent, JarvisEvent, Job } from './api.ts';

describe('web reviewer advisories', () => {
  it('requires a genuine Markdown table delimiter row', () => {
    const table = renderToStaticMarkup(Markdown({ children: 'Name | Value\n--- | ---\nA | B' }));
    expect(table).toContain('<table>');
    expect(table).toContain('<td>A</td>');

    const prose = renderToStaticMarkup(Markdown({ children: 'use grep | sort\n- first item' }));
    expect(prose).not.toContain('<table>');
    expect(prose).toContain('use grep | sort');
    expect(prose).toContain('<li>first item</li>');
  });

  it('renders a user message verbatim, escaped, with its line breaks kept', () => {
    // The transcript of the real request that prompted this work contained
    // literal-looking entities such as `&#x20;`. They are a copy/serialisation
    // artefact, not something Jarvis renders: a user message is escaped text,
    // so an entity the user typed is shown as the characters they typed.
    const typed = 'a & b <script>alert("x")</script> ok\n\nsecond &#x20; paragraph';
    const html = renderToStaticMarkup(PlainText({ children: typed }));

    expect(html).toContain('a &amp; b');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;x&quot;');
    // The entity survives as text rather than being decoded to a space.
    expect(html).toContain('&amp;#x20;');
    // And the blank line between paragraphs is still there, preserved by the
    // class `.plain-text` carries.
    expect(html).toContain('\n\nsecond');
    expect(html).toContain('class="plain-text"');
  });

  it('offers confirmation only for an authoritative pending execution', () => {
    expect(confirmationState('pending_approval')).toMatchObject({
      interactive: true,
      label: 'Review confirmation',
    });
    expect(confirmationState('succeeded')).toMatchObject({
      interactive: false,
      label: 'Completed',
    });
    expect(confirmationState('denied')).toMatchObject({ interactive: false, label: 'Denied' });
    expect(confirmationState('expired')).toMatchObject({ interactive: false, label: 'Expired' });
  });

  it('names the pending target instead of asking for a blind signature', () => {
    const execution = {
      id: 'tex_1',
      sessionId: 'ses_current',
      input: { id: 'ses_other' },
    } as unknown as Parameters<typeof describePendingTarget>[0];
    // The model chooses the target and it need not be anything this
    // conversation mentioned, so the recorded input is what the human reads.
    const lines = describePendingTarget(execution, [], new Map());
    expect(lines.join(' ')).toContain('ses_other');
    expect(lines.join(' ')).not.toContain('this one');
    expect(lines.some((line) => line.includes('"id":"ses_other"'))).toBe(true);

    const job = { id: 'job_1', goal: 'Fix the mobile nav' } as unknown as Job;
    expect(
      describePendingTarget(
        { id: 'tex_2', sessionId: null, input: { id: 'job_1' } } as unknown as Parameters<
          typeof describePendingTarget
        >[0],
        [],
        new Map([['job_1', job]]),
      ).join(' '),
    ).toContain('Fix the mobile nav');

    // Nothing to describe is said plainly rather than invented.
    expect(describePendingTarget(undefined, [], new Map())).toEqual([
      'the exact target described in the pending request',
    ]);
  });

  it('draws a one-day all-day event on exactly one cell in any timezone', () => {
    // Stored as midnight-UTC bounds with an exclusive end, as normaliseDraft writes it.
    const event = {
      allDay: true,
      startsAt: '2026-09-10T00:00:00.000Z',
      endsAt: '2026-09-11T00:00:00.000Z',
    } as CalendarEvent;
    const timed = {
      allDay: false,
      startsAt: '2026-09-10T08:00:00.000Z',
      endsAt: '2026-09-10T09:00:00.000Z',
    } as CalendarEvent;

    const zone = process.env.TZ;
    try {
      // East and west of UTC: an instant comparison lands on the wrong side in both.
      for (const tz of ['Europe/Paris', 'America/New_York', 'UTC']) {
        process.env.TZ = tz;
        const days = [9, 10, 11].map((date) => new Date(2026, 8, date));
        expect(days.filter((day) => overlapsDay(event, day)).map((day) => day.getDate())).toEqual([
          10,
        ]);
        // Timed events still use instant overlap, so they follow the local clock.
        expect(days.some((day) => overlapsDay(timed, day))).toBe(true);
      }
    } finally {
      process.env.TZ = zone;
    }
  });

  it('does not submit provider seconds as an edited series time', () => {
    const original = eventForm({
      id: 'evt_1',
      accountId: 'acc_1',
      remoteId: 'occurrence-2',
      source: 'Work',
      provider: 'google',
      recurring: true,
      seriesId: 'series-1',
      title: 'Standup',
      startsAt: '2026-09-11T09:00:30.500Z',
      endsAt: '2026-09-11T10:00:30.500Z',
      allDay: false,
      description: null,
      location: null,
      updatedAt: '2026-09-01T00:00:00.000Z',
      syncedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(eventPatch(original, { ...original, title: 'Renamed standup' })).toEqual({
      title: 'Renamed standup',
    });
  });

  it('unions overlapping event pages by id, oldest first', () => {
    const at = (...ids: number[]): JarvisEvent[] => ids.map((id) => ({ id, type: 't' }));

    // A shifted live tail overlaps what is already held; nothing is duplicated
    // and nothing already loaded is dropped.
    expect(mergeEvents(at(1, 2, 3), at(3, 4, 5)).map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    // A backfilled page arriving out of order is still placed by id.
    expect(mergeEvents(at(10, 11), at(4, 5)).map((e) => e.id)).toEqual([4, 5, 10, 11]);
    // Later pages win for the same id rather than being silently discarded.
    expect(mergeEvents(at(1), [{ id: 1, type: 'newer' }])).toEqual([{ id: 1, type: 'newer' }]);
  });
});
