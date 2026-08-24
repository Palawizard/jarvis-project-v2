import { describe, expect, it } from 'vitest';
import { isCandidateDevServerNoise, isCandidateStreamAbort } from './engine.js';

const ORIGIN = 'http://127.0.0.1:52395';

describe('candidate dev-server noise classification', () => {
  it('classifies the exact Vite HMR websocket failure on the candidate origin', () => {
    expect(
      isCandidateDevServerNoise(
        "WebSocket connection to 'ws://127.0.0.1:52395/?token=yhnxRALz5o0H' failed: " +
          'Error in connection establishment: net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS',
        ORIGIN,
      ),
    ).toBe(true);
    expect(
      isCandidateDevServerNoise(
        '[vite] failed to connect to websocket.\nyour current setup:',
        ORIGIN,
      ),
    ).toBe(true);
  });

  it('never hides a real application failure', () => {
    const real = [
      'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
      'GET http://127.0.0.1:52395/api/jobs 401 (Unauthorized)',
      'uncaught: TypeError: Cannot read properties of undefined',
      'Access to fetch at http://127.0.0.1:52395/api/health has been blocked by CORS policy',
      'Error: authentication failed',
    ];
    for (const text of real) expect(isCandidateDevServerNoise(text, ORIGIN)).toBe(false);
  });

  it('never hides a websocket failure to any other host or port', () => {
    const foreign = [
      "WebSocket connection to 'ws://evil.example.com/?token=abc' failed: refused",
      "WebSocket connection to 'ws://127.0.0.1:9999/?token=abc' failed: refused",
      "WebSocket connection to 'wss://127.0.0.1:52395/live' failed: refused",
    ];
    for (const text of foreign) expect(isCandidateDevServerNoise(text, ORIGIN)).toBe(false);
  });

  it('does not match a websocket message that merely mentions the candidate', () => {
    expect(
      isCandidateDevServerNoise(
        "the app logged: WebSocket connection to 'ws://127.0.0.1:52395/?token=x' failed",
        ORIGIN,
      ),
    ).toBe(false);
  });
});

describe('candidate stream-abort classification', () => {
  it('classifies the deliberate StrictMode SSE abort on the candidate origin', () => {
    expect(
      isCandidateStreamAbort(`${ORIGIN}/api/events?afterId=0`, 'net::ERR_ABORTED', ORIGIN),
    ).toBe(true);
  });

  it('never hides a different endpoint, origin, or error', () => {
    expect(isCandidateStreamAbort(`${ORIGIN}/api/jobs`, 'net::ERR_ABORTED', ORIGIN)).toBe(false);
    expect(
      isCandidateStreamAbort('http://evil.example.com/api/events', 'net::ERR_ABORTED', ORIGIN),
    ).toBe(false);
    expect(
      isCandidateStreamAbort(`${ORIGIN}/api/events`, 'net::ERR_CONNECTION_REFUSED', ORIGIN),
    ).toBe(false);
    expect(isCandidateStreamAbort(`${ORIGIN}/api/events`, 'failed', ORIGIN)).toBe(false);
  });
});
