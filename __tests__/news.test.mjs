// get_news (the news feed): GET /api/news, `since` passed through, the body
// forwarded whole with the lifecycle relay guidance. Fixtures follow
// route-schemas.ts newsItemSchema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { makeStateStore } from '../src/state.mjs';
import { dispatchTool, TOOL_DEFS } from '../src/tools.mjs';

const KEY = 'k_news_test_secret_value';
const ITEMS = [
  {
    id: '2026-11-05-outage',
    date: '2026-11-05',
    publishedAt: '2026-11-05T12:00:00.000Z',
    title: 'Outage tonight',
    toAgent: 'The API is down 14:00 to 15:00 UTC; queue after.',
    forOperator: 'SteamedClaw is down 14:00 to 15:00 UTC. https://steamedclaw.com/news',
    category: 'maintenance',
    eventStartsAt: '2026-11-05T14:00:00.000Z',
    eventEndsAt: '2026-11-05T15:00:00.000Z',
  },
  {
    id: '2026-11-01-chess',
    date: '2026-11-01',
    publishedAt: '2026-11-01T09:00:00.000Z',
    title: 'Chess analysis',
    toAgent: 'Chess games now have an analysis page.',
    forOperator: 'Your agent can read chess analysis now.',
    category: 'feature',
    actionUrl: '/api/games/chess/analyze',
  },
];

function context(t, { registered = false, status = 200, json = { items: ITEMS }, fail } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scmcp-news-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeStateStore(dir);
  if (registered)
    store.writeCredentials({ server: 'http://localhost:3210', agentId: 'self', apiKey: KEY });
  const calls = [];
  return {
    cfg: { baseUrl: 'http://localhost:3211', stateDir: dir },
    store,
    health: { lastError: null },
    activity: { inFlight: 0 },
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      if (fail) throw fail;
      return new Response(JSON.stringify(json), { status });
    },
  };
}

test('get_news reads the public feed and forwards every item unchanged with the relay guidance', async (t) => {
  for (const registered of [false, true]) {
    const ctx = context(t, { registered });
    const result = await dispatchTool('get_news', {}, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.news, { items: ITEMS });
    assert.equal(ctx.calls.length, 1);
    const call = ctx.calls[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.url.pathname, '/api/news');
    assert.deepEqual(Object.fromEntries(call.url.searchParams), {});
    // Public: no key, but the registered identity's saved server.
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.url.origin, registered ? 'http://localhost:3210' : ctx.cfg.baseUrl);
    assert.match(
      result.guidance,
      /news\.items\[\]\.toAgent is written for you: act on it, do not relay it\./,
    );
    assert.match(
      result.guidance,
      /Relay each news\.items\[\]\.forOperator to your operator as is: it is written for them/,
    );
    assert.match(result.guidance, /pass news\.items\[0\]\.publishedAt as since/);
  }
});

test('get_news passes since through as the query and keeps no local read state', async (t) => {
  for (const since of ['2026-11-01T09:00:00.000Z', '2026-11-01', '2026-11-01T09:00:00+02:00']) {
    const ctx = context(t, { json: { items: [ITEMS[0]] } });
    const result = await dispatchTool('get_news', { since }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.news.items, [ITEMS[0]]);
    assert.deepEqual(Object.fromEntries(ctx.calls[0].url.searchParams), { since });
    assert.deepEqual(fs.readdirSync(ctx.cfg.stateDir), []);
  }
});

test('an empty feed is a normal result with no relay guidance', async (t) => {
  const ctx = context(t, { json: { items: [] } });
  const result = await dispatchTool('get_news', { since: '2026-11-05T12:00:00.000Z' }, ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.news, { items: [] });
  assert.equal(result.guidance, undefined);
});

test('get_news refuses bad input before any HTTP call', async (t) => {
  for (const args of [
    { since: 'yesterday' },
    { since: '' },
    { since: 20261101 },
    { since: '2026-11-01T09:00:00' },
    { since: `2026-11-01T${'0'.repeat(40)}Z` },
    { limit: 5 },
  ]) {
    const ctx = context(t);
    assert.equal(
      (await dispatchTool('get_news', args, ctx)).error,
      'invalid_argument',
      JSON.stringify(args),
    );
    assert.equal(ctx.calls.length, 0);
  }
});

test('get_news relays server refusals and keeps the common error conventions', async (t) => {
  const refused = context(t, {
    status: 400,
    json: { error: 'invalid_input', message: 'since must be YYYY-MM-DD' },
  });
  const result = await dispatchTool('get_news', { since: '2026-13-45' }, refused);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_input');
  assert.equal(result.status, 400);
  assert.equal(result.details.message, 'since must be YYYY-MM-DD');
  const throttled = context(t, { status: 429, json: { retryAfterMs: 60000 } });
  assert.equal((await dispatchTool('get_news', {}, throttled)).error, 'rate_limited');
  const malformed = context(t, { json: { news: [] } });
  assert.equal((await dispatchTool('get_news', {}, malformed)).error, 'unexpected_status');
  const offline = context(t, { fail: new Error('offline') });
  assert.equal((await dispatchTool('get_news', {}, offline)).error, 'network_error');
  assert.equal(offline.activity.inFlight, 0);
});

test('get_news text: newsLatestAt as the signal, a literal example and a negative, no local state', () => {
  const def = TOOL_DEFS.find((tool) => tool.name === 'get_news');
  assert.ok(def);
  assert.match(def.description, /get_profile returns profile\.newsLatestAt/);
  assert.match(def.description, /toAgent/);
  assert.match(def.description, /forOperator, which you relay to your operator as is/);
  assert.match(def.description, /keeps no record of what you read/);
  assert.match(def.description, /Example: \{\} or \{"since":"2026-10-29T14:00:00Z"\}/);
  assert.match(def.description, /Not \{"since":"yesterday"\}/);
  assert.deepEqual(Object.keys(def.inputSchema.properties), ['since']);
  assert.equal(def.inputSchema.additionalProperties, false);
  assert.deepEqual(def.inputSchema.required, []);
});
