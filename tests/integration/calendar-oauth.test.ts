import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Jarvis, loadConfig } from '../../packages/core/src/index.js';
import { createRoutes } from '../../apps/orchestrator/src/routes.js';

const homes: string[] = [];
const open: Jarvis[] = [];

afterEach(() => {
  for (const jarvis of open.splice(0)) jarvis.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('Google calendar OAuth selection', () => {
  it('persists an explicitly selected writable secondary calendar', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-calendar-oauth-'));
    homes.push(home);
    const origin = 'http://127.0.0.1:5199';
    const jarvis = new Jarvis(loadConfig({ home, controlOrigins: [origin] }));
    open.push(jarvis);
    const control = jarvis.control.pair(jarvis.control.createBootstrap());
    if (!control) throw new Error('control fixture did not pair');
    const app = createRoutes(jarvis);
    const request = (route: string, init?: RequestInit) =>
      app.request(
        new Request(`${origin}${route}`, {
          ...init,
          headers: { 'x-jarvis-control': control, ...(init?.headers ?? {}) },
        }),
      );
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/token')) {
        return Response.json({ refresh_token: 'refresh-token', access_token: 'access-token' });
      }
      if (target.includes('/calendarList')) {
        return Response.json({
          items: [
            { id: 'primary', summary: 'Primary', primary: true },
            { id: 'team', summary: 'Team calendar' },
          ],
        });
      }
      if (target.includes('/events')) return Response.json({ items: [] });
      throw new Error(`unexpected Google request: ${target}`);
    }) as typeof fetch;
    try {
      const authorize = await request('/api/calendar/google/authorize', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: `${origin}/api/calendar/google/callback`,
          returnTo: `${origin}/calendar`,
        }),
      });
      const authUrl = new URL(((await authorize.json()) as { url: string }).url);
      const callback = await request(
        `/api/calendar/google/callback?state=${encodeURIComponent(authUrl.searchParams.get('state') ?? '')}&code=code`,
      );
      expect(callback.status).toBe(302);
      const location = new URL(callback.headers.get('location') ?? '', origin);
      expect(location.searchParams.get('google')).toBe('choose');
      expect(location.searchParams.has('connection')).toBe(false);
      const cookie = callback.headers.get('set-cookie');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).not.toContain('refresh-token');

      const choices = await request('/api/calendar/google/connection', {
        headers: { cookie: cookie ?? '' },
      });
      expect((await choices.json()) as unknown).toEqual({
        calendars: [
          { id: 'primary', name: 'Primary', writable: true },
          { id: 'team', name: 'Team calendar', writable: true },
        ],
      });
      const connected = await request('/api/calendar/google/connection', {
        method: 'POST',
        headers: { origin, cookie: cookie ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({ calendarId: 'team' }),
      });
      expect(connected.status).toBe(201);
      expect((await connected.json()) as { calendarId: string }).toMatchObject({
        calendarId: 'team',
      });
      expect(jarvis.calendar.accounts()[0]).toMatchObject({ calendarId: 'team' });

      // Consumed: replaying the same cookie cannot connect a second calendar,
      // and the CSRF state behind it cannot be replayed either.
      const replayed = await request('/api/calendar/google/connection', {
        method: 'POST',
        headers: { origin, cookie: cookie ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({ calendarId: 'primary' }),
      });
      expect(replayed.status).toBe(400);
      expect(jarvis.calendar.accounts()).toHaveLength(1);
      const replayedCallback = await request(
        `/api/calendar/google/callback?state=${encodeURIComponent(authUrl.searchParams.get('state') ?? '')}&code=code`,
      );
      expect(replayedCallback.status).toBe(400);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('drops pending OAuth secrets on cancellation, on expiry, and on their own timer', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-calendar-oauth-'));
    homes.push(home);
    const origin = 'http://127.0.0.1:5198';
    const jarvis = new Jarvis(loadConfig({ home, controlOrigins: [origin] }));
    open.push(jarvis);
    const control = jarvis.control.pair(jarvis.control.createBootstrap());
    if (!control) throw new Error('control fixture did not pair');
    const app = createRoutes(jarvis);
    const request = (route: string, init?: RequestInit) =>
      app.request(
        new Request(`${origin}${route}`, {
          ...init,
          headers: { 'x-jarvis-control': control, ...(init?.headers ?? {}) },
        }),
      );
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/token')) {
        return Response.json({ refresh_token: 'refresh-token', access_token: 'access-token' });
      }
      if (target.includes('/calendarList')) {
        return Response.json({ items: [{ id: 'primary', summary: 'Primary', primary: true }] });
      }
      if (target.includes('/events')) return Response.json({ items: [] });
      throw new Error(`unexpected Google request: ${target}`);
    }) as typeof fetch;

    /** Run the browser round trip and return the connection cookie it set. */
    const connect = async (): Promise<string> => {
      const authorize = await request('/api/calendar/google/authorize', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: `${origin}/api/calendar/google/callback`,
          returnTo: `${origin}/calendar`,
        }),
      });
      const authUrl = new URL(((await authorize.json()) as { url: string }).url);
      const callback = await request(
        `/api/calendar/google/callback?state=${encodeURIComponent(authUrl.searchParams.get('state') ?? '')}&code=code`,
      );
      return callback.headers.get('set-cookie') ?? '';
    };

    try {
      // 1. Cancellation consumes the pending state immediately and clears the cookie.
      const cancelled = await connect();
      const cancel = await request('/api/calendar/google/connection', {
        method: 'DELETE',
        headers: { origin, cookie: cancelled },
      });
      expect(cancel.status).toBe(200);
      expect((await cancel.json()) as { cancelled: boolean }).toEqual({ cancelled: true });
      expect(cancel.headers.get('set-cookie')).toContain('Max-Age=0');
      expect(
        (await request('/api/calendar/google/connection', { headers: { cookie: cancelled } }))
          .status,
      ).toBe(400);

      // 2. An entry the declared expiry has passed is rejected and removed when
      //    a connection endpoint reaches it, whatever the timer did.
      const stale = await connect();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
      expect(
        (await request('/api/calendar/google/connection', { headers: { cookie: stale } })).status,
      ).toBe(400);
      expect(
        (
          await request('/api/calendar/google/connection', {
            method: 'POST',
            headers: { origin, cookie: stale, 'content-type': 'application/json' },
            body: JSON.stringify({ calendarId: 'primary' }),
          })
        ).status,
      ).toBe(400);
      vi.useRealTimers();

      // 3. The declared lifetime is enforced in real time: with the clock left
      //    alone, firing the scheduled timer alone is enough to drop the entry,
      //    so an abandoned flow does not hold its secrets until process exit.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const abandoned = await connect();
      expect(
        (await request('/api/calendar/google/connection', { headers: { cookie: abandoned } }))
          .status,
      ).toBe(200);
      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(
        (await request('/api/calendar/google/connection', { headers: { cookie: abandoned } }))
          .status,
      ).toBe(400);
      expect(jarvis.calendar.accounts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = original;
    }
  });
});
