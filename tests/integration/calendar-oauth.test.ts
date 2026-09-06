import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
          { id: 'primary', name: 'Primary' },
          { id: 'team', name: 'Team calendar' },
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
    } finally {
      globalThis.fetch = original;
    }
  });
});
