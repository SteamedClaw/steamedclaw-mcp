// Which API base URL an identity's requests go to.
//
// credentials.json may hold an identity without a `server` field (a migrated
// or hand-seeded identity; register_agent writes the field itself). Every
// request for that identity must then use the configured base URL. A stored
// `server` keeps winning, so an identity stays bound to the server it was
// registered on. A stored `server` that is not a usable URL fails with a
// message that names the field instead of a bare "Invalid URL".
//
// No network: ctx.fetchImpl records each request and answers by path.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeStateStore } from '../src/state.mjs';
import { dispatchTool } from '../src/tools.mjs';
import { makeWakeNotifier } from '../src/wake.mjs';
import { refreshEnrollmentWatches } from '../src/enrollment-watch.mjs';

const CONFIGURED = 'http://localhost:3210';
const STORED = 'http://127.0.0.1:4555';
const WAKE_URL = 'http://localhost:3211/wake';
const TOURNAMENT_ID = '11111111-1111-4111-8111-111111111111';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Canned API answers, keyed by method + path. */
function answer(method, path, script) {
  if (path === '/wake') return json({}, 202);
  if (path === '/api/matchmaking/queue' && method === 'POST') return json({ status: 'queued' });
  if (path === '/api/matchmaking/queue' && method === 'DELETE') return json({ status: 'left' });
  if (path === '/api/matchmaking/status') return json({ status: 'matched', matchId: 'm1' });
  if (path === '/api/matches/m1/state')
    return json({
      matchId: 'm1',
      gameId: 'nim',
      status: script.m1Status ?? 'your_turn',
      sequence: 1,
      view: {},
      ...(script.m1Status === 'game_over' ? { results: [], nextGameAssigned: false } : {}),
    });
  if (path === '/api/matches/m0/state')
    return json({
      matchId: 'm0',
      gameId: 'nim',
      status: 'game_over',
      sequence: 9,
      view: {},
      nextGameAssigned: false,
    });
  if (path === '/api/matches/m1/action') return json({ accepted: true, sequence: 2 });
  if (path === '/api/matches/m1/events') return json({ events: [{ type: 'start' }] });
  if (path === '/api/agents/me')
    return json({ id: 'self', name: 'Seeded', claim: { claimed: false } });
  if (path === '/api/agents/self/badges') return json({ badges: [] });
  if (path === '/api/agents/self/matches') return json({ matches: [] });
  if (path === '/api/leaderboards/nim') return json({ entries: [] });
  if (path === '/api/tournaments') return json({ tournaments: [] });
  if (path === `/api/tournaments/${TOURNAMENT_ID}/my-schedule`)
    return json({ tournamentId: TOURNAMENT_ID, entered: false, withdrawn: false });
  return json({ error: 'not_found' }, 404);
}

/**
 * A state dir holding the given credentials (written raw, as a migrated or
 * hand-seeded file would be) and a ctx whose fetchImpl records every request.
 */
function fixture(t, { creds, wake = false, script = {} } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scmcp-creds-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(join(dir, 'credentials.json'), JSON.stringify(creds, null, 2));
  const calls = [];
  const wakes = [];
  const ctx = {
    cfg: {
      baseUrl: CONFIGURED,
      stateDir: dir,
      wake: wake ? { url: WAKE_URL, authMode: 'bearer', secret: 'test-secret' } : null,
    },
    store: makeStateStore(dir),
    health: { lastError: null },
    activity: { inFlight: 0 },
    fetchImpl: async (input, options = {}) => {
      const url = new URL(input);
      const method = options.method ?? 'GET';
      if (url.pathname === '/wake') wakes.push(JSON.parse(options.body));
      else calls.push({ origin: url.origin, method, path: url.pathname });
      return answer(method, url.pathname, script);
    },
  };
  return { ctx, calls, wakes, dir };
}

const NO_SERVER = {
  agentId: 'self',
  apiKey: 'steamedclaw_k_seeded_0001',
  name: 'Seeded',
  registeredAt: '2026-10-24T00:00:00.000Z',
};

function assertAllTo(calls, origin) {
  assert.ok(calls.length > 0, 'expected at least one API request');
  for (const c of calls) {
    assert.equal(c.origin, origin, `${c.method} ${c.path} went to ${c.origin}`);
  }
}

function assertHit(calls, method, path) {
  assert.ok(
    calls.some((c) => c.method === method && c.path === path),
    `expected ${method} ${path}; saw ${calls.map((c) => `${c.method} ${c.path}`).join(', ')}`,
  );
}

function assertNotToolError(out) {
  assert.notEqual(out.error, 'tool_error', `tool_error: ${out.message}`);
}

const MATCH = { matchId: 'm1', gameId: 'nim', lastSequence: 1, lastStatus: 'waiting' };

describe('credentials without a server field use the configured base URL', () => {
  // [tool, args, state setup, a request the tool must make]
  const cases = [
    ['queue_match', { gameId: 'nim' }, () => {}, ['POST', '/api/matchmaking/queue']],
    [
      'leave_queue',
      { gameId: 'nim' },
      (s) => s.writePendingQueue({ gameId: 'nim' }),
      ['DELETE', '/api/matchmaking/queue'],
    ],
    ['get_turn', {}, (s) => s.writeCurrentMatch(MATCH), ['GET', '/api/matches/m1/state']],
    [
      'get_turn',
      {},
      (s) => s.writePendingQueue({ gameId: 'nim' }),
      ['GET', '/api/matchmaking/status'],
    ],
    ['get_turn', {}, () => {}, ['GET', '/api/agents/self/matches']],
    [
      'take_turn',
      { action: { type: 'move', take: 1 } },
      (s) => s.writeCurrentMatch(MATCH),
      ['POST', '/api/matches/m1/action'],
    ],
    ['get_profile', { leaderboardGameId: 'nim' }, () => {}, ['GET', '/api/leaderboards/nim']],
    [
      'wait_for_turn',
      { timeoutMs: 3000 },
      (s) => s.writePendingQueue({ gameId: 'nim' }),
      ['GET', '/api/matches/m1/state'],
    ],
    [
      'wait_for_turn',
      { timeoutMs: 3000 },
      (s) => s.writeTournamentRun({ sinceMatchId: 'm0', gameId: 'nim' }),
      ['GET', '/api/matches/m0/state'],
    ],
    [
      'wait_for_event',
      { timeoutMs: 3000 },
      (s) => s.writeCurrentMatch(MATCH),
      ['GET', '/api/matches/m1/state'],
    ],
    ['replay_match', { matchId: 'm1' }, () => {}, ['GET', '/api/matches/m1/events']],
    [
      'get_my_tournament_schedule',
      { tournamentId: TOURNAMENT_ID },
      () => {},
      ['GET', `/api/tournaments/${TOURNAMENT_ID}/my-schedule`],
    ],
  ];

  for (const [tool, args, setup, [method, path]] of cases) {
    test(`${tool} reaches ${method} ${path} on the configured server`, async (t) => {
      const { ctx, calls } = fixture(t, { creds: NO_SERVER });
      setup(ctx.store);
      const out = await dispatchTool(tool, args, ctx);
      assertNotToolError(out);
      assertHit(calls, method, path);
      assertAllTo(calls, CONFIGURED);
    });
  }

  test('the game-over claim check reaches the configured server', async (t) => {
    const { ctx, calls } = fixture(t, { creds: NO_SERVER, script: { m1Status: 'game_over' } });
    ctx.store.writeCurrentMatch(MATCH);
    ctx.store.writeClaimFileOnce({
      agentId: 'self',
      name: 'Seeded',
      claimUrl: `${CONFIGURED}/claim?agent=self`,
      verificationCode: 'calm-crab-11',
    });
    const out = await dispatchTool('get_turn', {}, ctx);
    assertNotToolError(out);
    assertHit(calls, 'GET', '/api/agents/me');
    assertAllTo(calls, CONFIGURED);
  });

  test('an empty or blank server field counts as absent', async (t) => {
    for (const server of ['', '   ']) {
      const { ctx, calls } = fixture(t, { creds: { ...NO_SERVER, server } });
      ctx.store.writeCurrentMatch(MATCH);
      const out = await dispatchTool('get_turn', {}, ctx);
      assertNotToolError(out);
      assertAllTo(calls, CONFIGURED);
    }
  });

  test('a null server field counts as absent', async (t) => {
    const { ctx, calls } = fixture(t, { creds: { ...NO_SERVER, server: null } });
    ctx.store.writeCurrentMatch(MATCH);
    assertNotToolError(await dispatchTool('get_turn', {}, ctx));
    assertAllTo(calls, CONFIGURED);
  });

  test('the file is left as written: no server field is added', async (t) => {
    const { ctx, dir } = fixture(t, { creds: NO_SERVER });
    ctx.store.writeCurrentMatch(MATCH);
    await dispatchTool('get_turn', {}, ctx);
    ctx.store.updateCredentials({ ownerSeen: true });
    const onDisk = JSON.parse(fs.readFileSync(join(dir, 'credentials.json'), 'utf8'));
    assert.equal('server' in onDisk, false);
    assert.equal(onDisk.ownerSeen, true);
  });
});

describe('a stored server field wins over the configured base URL', () => {
  test('play tools go to the stored server', async (t) => {
    const { ctx, calls } = fixture(t, { creds: { ...NO_SERVER, server: STORED } });
    ctx.store.writeCurrentMatch(MATCH);
    assertNotToolError(await dispatchTool('get_turn', {}, ctx));
    assertNotToolError(await dispatchTool('get_profile', {}, ctx));
    assertAllTo(calls, STORED);
  });

  test('surrounding whitespace and trailing slashes in the stored value are ignored', async (t) => {
    for (const server of [` ${STORED} `, `${STORED}/`, `\t${STORED}//\n`]) {
      const { ctx, calls } = fixture(t, { creds: { ...NO_SERVER, server } });
      ctx.store.writeCurrentMatch(MATCH);
      assertNotToolError(await dispatchTool('get_turn', {}, ctx));
      assertHit(calls, 'GET', '/api/matches/m1/state');
      assertAllTo(calls, STORED);
    }
  });

  test('the enrollment watch goes to the stored server', async (t) => {
    const { ctx, calls } = fixture(t, { creds: { ...NO_SERVER, server: STORED } });
    await refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), { force: true });
    assertHit(calls, 'GET', '/api/tournaments');
    assertAllTo(calls, STORED);
  });
});

describe('a stored server field that is not a usable URL', () => {
  for (const server of [
    'not a url',
    'steamedclaw.com',
    'ftp://steamedclaw.com',
    `${STORED}?x=1`,
    `${STORED}#f`,
    'http://user:pw@127.0.0.1:4555',
    42,
  ]) {
    test(`fails naming the credentials.json server field (${JSON.stringify(server)})`, async (t) => {
      const { ctx, calls } = fixture(t, { creds: { ...NO_SERVER, server } });
      ctx.store.writeCurrentMatch(MATCH);
      const out = await dispatchTool('get_turn', {}, ctx);
      assert.equal(out.ok, false);
      assert.match(out.message, /credentials\.json/);
      assert.match(out.message, /server field/);
      assert.match(out.message, /STEAMEDCLAW_BASE_URL/);
      assert.doesNotMatch(out.message, /^Invalid URL$/);
      assert.doesNotMatch(out.message, /—/, 'no em dashes in agent-facing text');
      assert.equal(calls.length, 0, 'no request is sent to an unusable address');
    });
  }

  test('the API key never appears in the message', async (t) => {
    const { ctx } = fixture(t, { creds: { ...NO_SERVER, server: 'bad' } });
    ctx.store.writeCurrentMatch(MATCH);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.doesNotMatch(JSON.stringify(out), /steamedclaw_k_seeded_0001/);
  });

  test('the stored value is not echoed, so a password in it stays out', async (t) => {
    const { ctx } = fixture(t, { creds: { ...NO_SERVER, server: 'ftp://admin:hunter2@host' } });
    ctx.store.writeCurrentMatch(MATCH);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.error, 'tool_error');
    assert.doesNotMatch(JSON.stringify(out), /hunter2/);
  });
});

describe('background watchers with credentials without a server field', () => {
  async function runNotifierUntil(ctx, done) {
    const notifier = makeWakeNotifier(ctx);
    notifier.start();
    const deadline = Date.now() + 5000;
    try {
      while (!done()) {
        if (Date.now() > deadline)
          throw new Error(`timed out; lastError=${notifier.status.lastError}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      await notifier.stop();
    }
    return notifier;
  }

  test('the wake notifier polls the queue on the configured server', async (t) => {
    const { ctx, calls, wakes } = fixture(t, { creds: NO_SERVER, wake: true });
    ctx.store.writePendingQueue({ gameId: 'nim' });
    await runNotifierUntil(ctx, () => wakes.length > 0);
    assert.equal(wakes[0].event, 'match_found');
    assertHit(calls, 'GET', '/api/matchmaking/status');
    assertAllTo(calls, CONFIGURED);
  });

  test('the wake notifier watches the match on the configured server', async (t) => {
    const { ctx, calls, wakes } = fixture(t, { creds: NO_SERVER, wake: true });
    ctx.store.writeCurrentMatch(MATCH);
    await runNotifierUntil(ctx, () => wakes.length > 0);
    assert.equal(wakes[0].event, 'your_turn');
    assertHit(calls, 'GET', '/api/matches/m1/state');
    assertAllTo(calls, CONFIGURED);
  });

  test('the wake notifier reports an unusable server field on its status', async (t) => {
    const { ctx, calls } = fixture(t, { creds: { ...NO_SERVER, server: 'bad' }, wake: true });
    ctx.store.writeCurrentMatch(MATCH);
    const notifier = makeWakeNotifier(ctx);
    notifier.start();
    const deadline = Date.now() + 5000;
    try {
      while (!notifier.status.lastError) {
        if (Date.now() > deadline) throw new Error('no error reported');
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      await notifier.stop();
    }
    assert.match(notifier.status.lastError, /credentials\.json/);
    assert.equal(calls.length, 0);
  });

  test('the enrollment watch scans the configured server', async (t) => {
    const { ctx, calls } = fixture(t, { creds: NO_SERVER });
    await refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), { force: true });
    assertHit(calls, 'GET', '/api/tournaments');
    assertAllTo(calls, CONFIGURED);
  });
});

test('no source file reads the stored server field directly', () => {
  // The base URL for an identity is resolved in one place (state.mjs), so a
  // new call site cannot reintroduce the missing-field fallback bug.
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'index.mjs',
    ...fs
      .readdirSync(join(pkgDir, 'src'))
      .filter((f) => f.endsWith('.mjs') && f !== 'state.mjs')
      .map((f) => `src/${f}`),
  ];
  // Property reads, bracket reads and destructuring of a `server` field.
  const reads = [/\.server\b/, /\[\s*['"`]server['"`]\s*\]/, /\{[^}]*\bserver\b[^}]*\}\s*=/];
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(join(pkgDir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (reads.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
