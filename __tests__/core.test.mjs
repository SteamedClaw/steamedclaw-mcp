// Core tests: config (base-URL allowlist), state store, http-client
// (429 retry posture + redaction). No network — mock servers on loopback.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { join } from 'node:path';

import { normalizeBaseUrl, config, VERSION, USER_AGENT } from '../src/config.mjs';
import { makeStateStore, writeJsonAtomic } from '../src/state.mjs';
import { apiRequest, redactSecrets, NetworkError } from '../src/http-client.mjs';

function tmpDir() {
  return fs.mkdtempSync(join(os.tmpdir(), 'scmcp-test-'));
}

describe('config', () => {
  test('version and UA derive from package.json', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
    assert.equal(USER_AGENT, `steamedclaw-mcp/${VERSION}`);
  });

  test('allowlist: prod and stage https pass', () => {
    assert.equal(normalizeBaseUrl('https://steamedclaw.com'), 'https://steamedclaw.com');
    assert.equal(
      normalizeBaseUrl('https://stage.steamedclaw.com/'),
      'https://stage.steamedclaw.com',
    );
  });

  test('allowlist: localhost and 127.0.0.1 http pass (dev)', () => {
    assert.equal(normalizeBaseUrl('http://localhost:3000'), 'http://localhost:3000');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    assert.equal(
      normalizeBaseUrl('http://host.docker.internal:3000'),
      'http://host.docker.internal:3000',
    );
  });

  test('allowlist: unknown host rejected with actionable message', () => {
    assert.throws(() => normalizeBaseUrl('https://evil.example.com'), /allowlist/);
    assert.throws(() => normalizeBaseUrl('http://steamedclaw.com'), /allowlist/); // http to prod host: not allowed
  });

  test('allowlist: unsafe override permits any http(s) host', () => {
    assert.equal(
      normalizeBaseUrl('https://evil.example.com', { allowUnsafe: true }),
      'https://evil.example.com',
    );
  });

  test('rejects embedded credentials, query, fragment, non-http', () => {
    assert.throws(() => normalizeBaseUrl('https://user:pw@steamedclaw.com'), /credentials/);
    assert.throws(() => normalizeBaseUrl('https://steamedclaw.com?x=1'), /query/);
    assert.throws(() => normalizeBaseUrl('ftp://steamedclaw.com', { allowUnsafe: true }), /http/);
  });

  test('config() reads env per call; invalid wake auth mode / missing secret throw', () => {
    const prev = { ...process.env };
    try {
      process.env.STEAMEDCLAW_BASE_URL = 'http://127.0.0.1:3999';
      process.env.STEAMEDCLAW_WAKE_WEBHOOK_URL = 'http://127.0.0.1:9999/hook';
      process.env.STEAMEDCLAW_WAKE_AUTH_MODE = 'bogus';
      process.env.STEAMEDCLAW_WAKE_SECRET = 's3cret';
      assert.throws(() => config(), /WAKE_AUTH_MODE/);
      process.env.STEAMEDCLAW_WAKE_AUTH_MODE = 'hmac-sha256';
      const c = config();
      assert.equal(c.wake.authMode, 'hmac-sha256');
      // Wake URL without a secret must fail fast, never send unsigned wakes.
      delete process.env.STEAMEDCLAW_WAKE_SECRET;
      assert.throws(() => config(), /WAKE_SECRET/);
      delete process.env.STEAMEDCLAW_WAKE_WEBHOOK_URL;
      assert.equal(config().wake, null);
    } finally {
      process.env = prev;
    }
  });

  test('default bind host is loopback', () => {
    const prev = { ...process.env };
    try {
      delete process.env.HOST;
      process.env.STEAMEDCLAW_BASE_URL = 'http://127.0.0.1:3999';
      assert.equal(config().host, '127.0.0.1');
    } finally {
      process.env = prev;
    }
  });
});

describe('state store', () => {
  test('credentials round-trip and merge', () => {
    const store = makeStateStore(tmpDir());
    assert.equal(store.readCredentials(), null);
    store.writeCredentials({
      server: 'http://127.0.0.1:3000',
      agentId: 'a-1',
      apiKey: 'steamedclaw_k_secret',
      name: 'TestAgent',
      registeredAt: '2026-07-03T00:00:00Z',
    });
    assert.equal(store.readCredentials().agentId, 'a-1');
    store.updateCredentials({ ownerSeen: true });
    assert.equal(store.readCredentials().ownerSeen, true);
    assert.equal(store.readCredentials().apiKey, 'steamedclaw_k_secret');
  });

  test('current match round-trip and clear', () => {
    const store = makeStateStore(tmpDir());
    assert.equal(store.readCurrentMatch(), null);
    store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 3 });
    assert.equal(store.readCurrentMatch().lastSequence, 3);
    assert.ok(store.readCurrentMatch().updatedAt);
    store.clearCurrentMatch();
    assert.equal(store.readCurrentMatch(), null);
  });

  test('pending queue round-trip and clear', () => {
    const store = makeStateStore(tmpDir());
    store.writePendingQueue({ gameId: 'nim', lane: 'standard' });
    assert.equal(store.readPendingQueue().gameId, 'nim');
    store.clearPendingQueue();
    assert.equal(store.readPendingQueue(), null);
  });

  test('claim file is write-once and never contains the apiKey', () => {
    const store = makeStateStore(tmpDir());
    const wrote = store.writeClaimFileOnce({
      agentId: 'a-1',
      name: 'TestAgent',
      claimUrl: 'https://steamedclaw.com/claim?agent=a-1',
      verificationCode: 'WORDS-CODE',
    });
    assert.equal(wrote, true);
    assert.equal(
      store.writeClaimFileOnce({ agentId: 'x', name: 'y', claimUrl: 'z', verificationCode: 'w' }),
      false,
    );
    const content = store.readClaimFile();
    assert.match(content, /WORDS-CODE/);
    assert.doesNotMatch(content, /apiKey|api_key|steamedclaw_k/i);
  });

  test('reflection quota counts a rolling 24h window', () => {
    const store = makeStateStore(tmpDir());
    const now = Date.now();
    store.recordReflectionTimestamp(now - 25 * 60 * 60 * 1000); // stale — pruned on next write
    store.recordReflectionTimestamp(now - 60_000);
    store.recordReflectionTimestamp(now);
    assert.equal(store.reflectionCount24h(now), 2);
  });

  test('notes filename sanitizes hostile gameIds', () => {
    const store = makeStateStore(tmpDir());
    const p = store.notesPathFor('../../etc/passwd');
    assert.doesNotMatch(p, /\.\./);
    store.writeNotes('../../etc/passwd', 'lesson');
    assert.equal(store.readNotes('../../etc/passwd'), 'lesson');
  });

  test('writeJsonAtomic leaves no tmp files behind', () => {
    const dir = tmpDir();
    const file = join(dir, 'x.json');
    writeJsonAtomic(file, { a: 1 });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).a, 1);
  });
});

describe('redaction', () => {
  test('redacts secret-shaped keys recursively and Bearer strings', () => {
    const out = redactSecrets({
      apiKey: 'steamedclaw_k_1234567890',
      nested: { Authorization: 'Bearer steamedclaw_k_1234567890', keep: 'visible' },
      arr: [{ token: 'abcdefghij' }], // 10 chars — short secrets redact fully
      note: 'sent Bearer steamedclaw_k_1234567890 upstream',
    });
    assert.match(out.apiKey, /^stea\.\.\./);
    assert.match(out.nested.Authorization, /^Bear\.\.\./); // key-based redaction wins
    assert.equal(out.nested.keep, 'visible');
    assert.equal(out.arr[0].token, '[redacted]'); // 4+4 preview would reveal it
    assert.equal(out.note, 'sent Bearer [redacted] upstream');
    assert.doesNotMatch(JSON.stringify(out), /steamedclaw_k_1234567890|abcdefghij/);
  });
});

describe('http-client 429 retry', () => {
  let server;
  let port;
  let hits;
  let behavior; // function(req, res, hitIndex)

  before(async () => {
    hits = 0;
    server = http.createServer((req, res) => {
      behavior(req, res, hits++);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => server.close());

  test('retries on 429 honoring body retryAfterMs, then succeeds', async () => {
    hits = 0;
    behavior = (req, res, i) => {
      if (i === 0) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate_limited', retryAfterMs: 5 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sawAuth: req.headers.authorization ?? null }));
      }
    };
    const { status, json } = await apiRequest({
      path: '/x',
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'k-secret-123',
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.sawAuth, 'Bearer k-secret-123');
    assert.equal(hits, 2);
  });

  test('falls back to Retry-After header seconds', async () => {
    hits = 0;
    behavior = (req, res, i) => {
      if (i === 0) {
        res.writeHead(429, { 'Retry-After': '0' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    };
    const { status } = await apiRequest({ path: '/x', baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(status, 200);
    assert.equal(hits, 2);
  });

  test('gives up after max retries and returns the 429', async () => {
    hits = 0;
    behavior = (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_limited', retryAfterMs: 1 }));
    };
    const { status, json } = await apiRequest({ path: '/x', baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(status, 429);
    assert.equal(json.error, 'rate_limited');
    assert.equal(hits, 5); // 1 initial + RATE_LIMIT_MAX_RETRIES
  });

  test('retryOn429=false returns immediately', async () => {
    hits = 0;
    behavior = (req, res) => {
      res.writeHead(429);
      res.end();
    };
    const { status } = await apiRequest({
      path: '/x',
      baseUrl: `http://127.0.0.1:${port}`,
      retryOn429: false,
    });
    assert.equal(status, 429);
    assert.equal(hits, 1);
  });

  test('sends versioned User-Agent and JSON body; parses response', async () => {
    hits = 0;
    behavior = async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ echo: body.name, ua: req.headers['user-agent'] }));
    };
    const { status, json } = await apiRequest({
      method: 'POST',
      path: '/agents',
      baseUrl: `http://127.0.0.1:${port}`,
      body: { name: 'Bot' },
    });
    assert.equal(status, 201);
    assert.equal(json.echo, 'Bot');
    assert.equal(json.ua, USER_AGENT);
  });

  test('query params serialize; undefined/null skipped', async () => {
    hits = 0;
    behavior = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    };
    const { json } = await apiRequest({
      path: '/state',
      baseUrl: `http://127.0.0.1:${port}`,
      query: { wait: 'true', afterSequence: 4, skip: undefined },
    });
    assert.equal(json.url, '/state?wait=true&afterSequence=4');
  });

  test('network failure throws NetworkError (unreachable port)', async () => {
    await assert.rejects(
      apiRequest({ path: '/x', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 }),
      NetworkError,
    );
  });
});
