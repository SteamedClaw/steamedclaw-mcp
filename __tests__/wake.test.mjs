// Wake notifier signature-header tests.
//
// Drives makeWakeNotifier through one real cycle by injecting ctx.fetchImpl
// and a fake store: a pending queue that the matchmaking-status poll reports as
// "matched" makes the notifier emit a match_found wake POST, whose outbound
// headers we capture and assert on. No network — fetchImpl routes by URL.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { makeWakeNotifier } from '../src/wake.mjs';

const SERVER = 'http://127.0.0.1:3999';
const WAKE_URL = 'http://127.0.0.1:9998/webhooks/steamedclaw';
const SECRET = 'wake-secret-abc123';

/** Minimal in-memory store honoring the reads/writes cycle() performs. */
function makeFakeStore({ pending = null, current = null } = {}) {
  let pendingQueue = pending;
  let currentMatch = current;
  return {
    readCredentials: () => ({ server: SERVER, apiKey: 'steamedclaw_k_test' }),
    readTournamentRun: () => null,
    readEnrollmentWatches: () => [],
    readPendingQueue: () => pendingQueue,
    clearPendingQueue: () => {
      pendingQueue = null;
    },
    readCurrentMatch: () => currentMatch,
    writeCurrentMatch: (m) => {
      currentMatch = m;
    },
    clearCurrentMatch: () => {
      currentMatch = null;
    },
  };
}

/**
 * Run the notifier until it POSTs one wake, and resolve with that request's
 * captured { url, options }. fetchImpl answers the matchmaking-status poll with
 * "matched" and captures the subsequent wake POST.
 */
async function captureWake(cfg) {
  const store = makeFakeStore({ pending: { gameId: 'tic-tac-toe' } });
  let resolveCapture;
  const captured = new Promise((r) => {
    resolveCapture = r;
  });

  const fetchImpl = async (url, options) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href.startsWith(WAKE_URL)) {
      resolveCapture({ url: href, options });
      return new Response('', { status: 200 });
    }
    // Matchmaking status poll → report a match so match_found fires.
    if (href.includes('/api/matchmaking/status')) {
      return new Response(JSON.stringify({ status: 'matched', matchId: 'm-test-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const ctx = { cfg, store, activity: { inFlight: 0 }, fetchImpl };
  const notifier = makeWakeNotifier(ctx);
  notifier.start();
  let timer;
  try {
    return await Promise.race([
      captured,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('wake capture timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await notifier.stop();
  }
}

describe('wake notifier signature headers', () => {
  test('hmac-sha256 mode sends V1 + both V2 headers; V2 signs "<ts>.<body>"', async () => {
    const cfg = {
      wake: { url: WAKE_URL, authMode: 'hmac-sha256', secret: SECRET, headerName: 'Authorization' },
    };
    const { options } = await captureWake(cfg);
    const headers = options.headers;
    const body = options.body;

    // All three signature headers present.
    assert.ok(headers['X-Webhook-Signature'], 'legacy V1 header present');
    assert.ok(headers['X-Webhook-Signature-V2'], 'V2 signature header present');
    assert.ok(headers['X-Webhook-Timestamp'], 'V2 timestamp header present');

    // Timestamp is unix SECONDS (10 digits, and close to now-in-seconds).
    const ts = headers['X-Webhook-Timestamp'];
    assert.match(ts, /^\d+$/);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(nowSec - Number(ts)) < 60, `timestamp ${ts} is unix seconds near now`);

    // V1 digest = HMAC(secret, body).
    const expectedV1 = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(headers['X-Webhook-Signature'], expectedV1);

    // V2 digest = HMAC(secret, "<timestamp>.<body>").
    const expectedV2 = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    assert.equal(headers['X-Webhook-Signature-V2'], expectedV2);

    // The two digests differ (they sign different strings).
    assert.notEqual(headers['X-Webhook-Signature'], headers['X-Webhook-Signature-V2']);
  });

  test('bearer mode sends no signature headers, only Authorization', async () => {
    const cfg = {
      wake: { url: WAKE_URL, authMode: 'bearer', secret: SECRET, headerName: 'Authorization' },
    };
    const { options } = await captureWake(cfg);
    const headers = options.headers;

    assert.equal(headers['Authorization'], `Bearer ${SECRET}`);
    assert.equal(headers['X-Webhook-Signature'], undefined);
    assert.equal(headers['X-Webhook-Signature-V2'], undefined);
    assert.equal(headers['X-Webhook-Timestamp'], undefined);
  });

  test('header mode sends the configured static header, no signatures', async () => {
    const cfg = {
      wake: { url: WAKE_URL, authMode: 'header', secret: SECRET, headerName: 'X-Wake-Token' },
    };
    const { options } = await captureWake(cfg);
    const headers = options.headers;

    assert.equal(headers['X-Wake-Token'], SECRET);
    assert.equal(headers['X-Webhook-Signature'], undefined);
    assert.equal(headers['X-Webhook-Signature-V2'], undefined);
  });
});
