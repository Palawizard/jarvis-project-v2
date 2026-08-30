import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './components.tsx';
import { confirmationState, describePendingTarget } from './views/Chat.tsx';
import type { Job } from './api.ts';

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
});
