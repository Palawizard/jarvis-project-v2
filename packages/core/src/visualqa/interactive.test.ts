import { describe, expect, it } from 'vitest';
import {
  BROWSER_ACTION,
  BROWSER_ACTION_BATCH,
  VISUAL_ACTION_SCHEMA_VERSION,
  VISUAL_QA_BUDGET,
  describeLocator,
} from './interactive.js';

const ok = (value: unknown) => BROWSER_ACTION.safeParse(value).success;

describe('browser action schema', () => {
  it('is versioned', () => {
    expect(VISUAL_ACTION_SCHEMA_VERSION).toBe(1);
  });

  it('accepts every declared action in its documented form', () => {
    const actions = [
      { action: 'goto', route: '/chat/session_x' },
      { action: 'click', locator: { testId: 'chat-view' } },
      { action: 'hover', locator: { role: 'button', name: 'Edit' } },
      { action: 'fill', locator: { testId: 'composer' }, value: 'hello' },
      { action: 'press', key: 'Enter' },
      { action: 'press', key: 'Escape', locator: { text: 'Cancel' } },
      { action: 'scroll', direction: 'down', amount: 400 },
      { action: 'wait', locator: { testId: 'chat-view' }, timeoutMs: 5_000 },
      { action: 'inspect' },
      { action: 'set_viewport', viewport: 'mobile' },
      { action: 'checkpoint', name: 'edit mode reached', note: 'textarea visible' },
      { action: 'finish' },
    ];
    for (const action of actions) expect(ok(action), JSON.stringify(action)).toBe(true);
  });

  it('has no action that executes JavaScript, a shell, or host code', () => {
    for (const action of [
      { action: 'evaluate', script: 'window.__x = 1' },
      { action: 'eval', expression: 'fetch("http://evil.test")' },
      { action: 'exec', command: 'rm -rf /' },
      { action: 'read_file', path: 'C:/Users/super/.jarvis/jarvis.db' },
      { action: 'request', url: 'http://127.0.0.1:9999/api/jobs' },
      { action: 'click', locator: { testId: 'x' }, script: 'alert(1)' },
      { action: 'goto', route: '/', headers: { 'x-jarvis-control': 'stolen' } },
    ]) {
      expect(ok(action), JSON.stringify(action)).toBe(false);
    }
  });

  it('refuses any route that is not a same-origin absolute path', () => {
    for (const route of [
      'http://evil.example/',
      'https://127.0.0.1:5199/',
      '//evil.example/path',
      'file:///C:/Users/super/.ssh/id_rsa',
      'data:text/html,<script>1</script>',
      'javascript:alert(1)',
      'chat',
      '\\\\server\\share',
      '/chat\\..\\..\\etc',
    ]) {
      expect(ok({ action: 'goto', route }), route).toBe(false);
    }
    expect(ok({ action: 'goto', route: '/chat/x?edit=1' })).toBe(true);
  });

  it('allows only the declared keyboard keys, never a host chord', () => {
    expect(ok({ action: 'press', key: 'Enter' })).toBe(true);
    for (const key of ['Control+C', 'Meta+Q', 'Alt+F4', 'F12', 'a'])
      expect(ok({ action: 'press', key }), key).toBe(false);
  });

  it('bounds locator forms and rejects unknown or mixed shapes', () => {
    expect(ok({ action: 'click', locator: { css: '.chat .message button' } })).toBe(true);
    for (const locator of [
      { xpath: '//button' },
      { css: 'a'.repeat(241) },
      { css: 'button >> nth=0 >> internal:control=enter-frame' },
      { css: 'xpath=//button' },
      { css: 'text=Delete everything' },
      { role: 'BUTTON', name: 'Edit' },
      { role: 'button' },
      { text: '' },
      {},
    ]) {
      expect(ok({ action: 'click', locator }), JSON.stringify(locator)).toBe(false);
    }
  });

  it('bounds every numeric and string field', () => {
    expect(ok({ action: 'wait', timeoutMs: 60_000 })).toBe(false);
    expect(ok({ action: 'wait', timeoutMs: 0 })).toBe(false);
    expect(ok({ action: 'scroll', direction: 'down', amount: 100_000 })).toBe(false);
    expect(ok({ action: 'fill', locator: { testId: 'x' }, value: 'x'.repeat(401) })).toBe(false);
    expect(ok({ action: 'checkpoint', name: '' })).toBe(false);
    expect(ok({ action: 'checkpoint', name: 'x'.repeat(81) })).toBe(false);
    expect(ok({ action: 'set_viewport', viewport: 'tablet' })).toBe(false);
  });

  it('caps one model decision at the per-turn action budget', () => {
    const batch = (n: number) => Array.from({ length: n }, () => ({ action: 'finish' as const }));
    expect(BROWSER_ACTION_BATCH.safeParse(batch(VISUAL_QA_BUDGET.actionsPerTurn)).success).toBe(
      true,
    );
    expect(BROWSER_ACTION_BATCH.safeParse(batch(VISUAL_QA_BUDGET.actionsPerTurn + 1)).success).toBe(
      false,
    );
  });

  it('describes locators without leaking anything but the locator itself', () => {
    expect(describeLocator({ testId: 'chat-view' })).toBe('testId=chat-view');
    expect(describeLocator({ role: 'button', name: 'Edit' })).toBe('role=button name=Edit');
    expect(describeLocator(undefined)).toBe('');
  });
});

describe('visual QA budget', () => {
  it('is finite everywhere, so no path can loop', () => {
    for (const [key, value] of Object.entries(VISUAL_QA_BUDGET)) {
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it('holds the agreed ceilings', () => {
    expect(VISUAL_QA_BUDGET.modelTurns).toBeLessThanOrEqual(5);
    expect(VISUAL_QA_BUDGET.actions).toBeLessThanOrEqual(20);
    expect(VISUAL_QA_BUDGET.evidence).toBeLessThanOrEqual(6);
    expect(VISUAL_QA_BUDGET.viewports).toBeLessThanOrEqual(2);
    expect(VISUAL_QA_BUDGET.attempts).toBe(2);
    expect(VISUAL_QA_BUDGET.visualFixCycles).toBe(1);
  });
});
