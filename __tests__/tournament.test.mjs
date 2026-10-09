// Unattended tournament play: adoption of orchestrator-created matches,
// wait_for_turn spanning the series gap, queue_match recovery, hint hierarchy,
// and in-order delivery of an unseen finished game's envelope.
//
// Mock-server pattern mirrors tools.test.mjs. The structured signal is the
// server's `nextGameAssigned: true` — never text-sniffed.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { join } from 'node:path';

import { makeStateStore } from '../src/state.mjs';
import { dispatchTool, TOOL_DEFS } from '../src/tools.mjs';
import { makeWakeNotifier } from '../src/wake.mjs';

// --- mock game server -----------------------------------------------------------

let server;
let baseUrl;
/** route table: `${METHOD} ${pathname}` -> (req, res, url, body) */
let routes;

function respond(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(json));
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return respond(res, 404, { error: 'no_mock_route', key });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    await handler(req, res, url, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  routes = {};
});

function makeCtx() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scmcp-670-'));
  const store = makeStateStore(dir);
  store.writeCredentials({
    server: baseUrl,
    agentId: 'agent-1',
    apiKey: 'k_test_secret_9999',
    name: 'TestBot',
    registeredAt: new Date().toISOString(),
  });
  return {
    cfg: { baseUrl, stateDir: dir, wake: null },
    store,
    health: { lastError: null },
    activity: { inFlight: 0 },
  };
}

/** Matches-list row as the server's GET /api/agents/:id/matches returns it.
 *  createdAt derives from the id's numeric suffix (m-2 created after m-1) so
 *  candidate selection is exercised on real timestamps, not response order. */
function row(id, gameId, status, finishedAt = null) {
  const n = Number(/\d+$/.exec(id)?.[0] ?? 0);
  return {
    id,
    gameId,
    gameName: gameId,
    status,
    players: [],
    results: null,
    finishedAt,
    createdAt: new Date(Date.UTC(2026, 7, 20, 0, 0, n)).toISOString(),
  };
}

function matchesRoute(rows) {
  routes['GET /api/agents/agent-1/matches'] = (req, res) =>
    respond(res, 200, { agentId: 'agent-1', matches: rows, total: rows.length });
}

function stateRoute(matchId, st) {
  routes[`GET /api/matches/${matchId}/state`] = (req, res) => respond(res, 200, st);
}

const TOURNAMENT_GAME_OVER = {
  matchId: 'm-1',
  gameId: 'liars-dice',
  gameType: 'sequential',
  status: 'game_over',
  sequence: 9,
  view: {},
  results: [{ agentId: 'agent-1', outcome: 'win' }],
  rating: null,
  suggestions: null,
  newBadges: null,
  shareText: null,
  replayUrl: 'https://x/api/matches/m-1',
  replayMarkdownUrl: 'https://x/api/matches/m-1?format=md',
  messaging: {
    encouragement: 'Well played. Do not queue for a new match — your next game is assigned.',
  },
  nextGameAssigned: true,
};

function yourTurn(matchId, gameId = 'liars-dice') {
  return {
    matchId,
    gameId,
    gameType: 'sequential',
    status: 'your_turn',
    sequence: 1,
    view: { round: 1 },
    turnEndsAt: '2026-08-21T18:00:00.000Z',
  };
}

// --- tournament-run flag lifecycle -----------------------------------------

describe('tournament-run flag lifecycle', () => {
  test('game_over with nextGameAssigned=true records the run; without it, clears it', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'liars-dice', lastSequence: 8 });
    stateRoute('m-1', TOURNAMENT_GAME_OVER);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    const run = ctx.store.readTournamentRun();
    assert.ok(run, 'tournament run must be recorded');
    assert.equal(run.sinceMatchId, 'm-1');

    // A later game_over WITHOUT the signal (run over / normal match) clears it.
    ctx.store.writeCurrentMatch({ matchId: 'm-2', gameId: 'liars-dice', lastSequence: 3 });
    stateRoute('m-2', {
      ...TOURNAMENT_GAME_OVER,
      matchId: 'm-2',
      nextGameAssigned: undefined,
      messaging: { encouragement: 'gg' },
    });
    const out2 = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out2.status, 'game_over');
    assert.equal('nextGameAssigned' in out2, false);
    assert.equal(ctx.store.readTournamentRun(), null);
  });

  test('successful queue_match clears the run flag (agent explicitly chose matchmaking)', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    matchesRoute([row('m-1', 'liars-dice', 'completed', '2026-08-21T00:00:00Z')]);
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, { status: 'queued', position: 1 });
    const out = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(out.status, 'queued');
    assert.equal(ctx.store.readTournamentRun(), null);
  });
});

// --- adoption: get_turn ----------------------------------------------------

describe('get_turn adoption', () => {
  test('empty slot + assigned unfinished match → adopted and played (run continues)', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    matchesRoute([
      row('m-2', 'liars-dice', 'active'),
      row('m-1', 'liars-dice', 'completed', '2026-08-21T00:00:00Z'),
    ]);
    stateRoute('m-2', yourTurn('m-2'));
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(out.matchId, 'm-2');
    assert.equal(ctx.store.readCurrentMatch().matchId, 'm-2');
  });

  test('empty slot + assigned match, NO run flag → still adopted (round 1 / restart recovery)', async () => {
    const ctx = makeCtx();
    matchesRoute([row('m-9', 'liars-dice', 'waiting')]);
    stateRoute('m-9', yourTurn('m-9'));
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(out.matchId, 'm-9');
  });

  test('empty slot + no server match, no flag → no_active_match with the normal queue hint', async () => {
    const ctx = makeCtx();
    matchesRoute([row('m-0', 'nim', 'completed', '2026-08-01T00:00:00Z')]);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.error, 'no_active_match');
    assert.match(out.hint, /queue_match/);
  });

  test('empty slot + no server match, flag set → hint must NOT steer to queue_match', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    matchesRoute([row('m-1', 'liars-dice', 'completed', '2026-08-21T00:00:00Z')]);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.error, 'no_active_match');
    assert.doesNotMatch(out.hint, /Call queue_match to start/);
    assert.match(out.hint, /assigns your next game|tournament/i);
    assert.match(out.hint, /wait_for_turn/);
  });

  test('a tracked live match is never displaced — no discovery call happens', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-0', gameId: 'liars-dice' });
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'liars-dice', lastSequence: 2 });
    routes['GET /api/agents/agent-1/matches'] = () =>
      assert.fail('discovery must not run while a match is tracked');
    stateRoute('m-1', yourTurn('m-1'));
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.matchId, 'm-1');
  });
});

// --- adoption: queue_match (plugin C analog) --------------------------------

describe('queue_match recovery', () => {
  test('adopts a server-assigned match instead of queueing normal matchmaking', async () => {
    const ctx = makeCtx();
    matchesRoute([row('m-5', 'liars-dice', 'waiting')]);
    routes['POST /api/matchmaking/queue'] = () =>
      assert.fail('must not queue when the server already assigned a match');
    const out = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'matched');
    assert.equal(out.adopted, true);
    assert.equal(out.matchId, 'm-5');
    assert.equal(ctx.store.readCurrentMatch().matchId, 'm-5');
    assert.match(out.guidance, /wait_for_turn/);
  });

  test('no assigned match → queues normally (polarity)', async () => {
    const ctx = makeCtx();
    matchesRoute([]);
    routes['POST /api/matchmaking/queue'] = (req, res, url, body) => {
      assert.equal(body.gameId, 'nim');
      respond(res, 200, { status: 'queued', position: 2 });
    };
    const out = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(out.status, 'queued');
    assert.equal(ctx.store.readPendingQueue().gameId, 'nim');
  });

  test('occupied slot still refuses (single-match invariant unchanged)', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 2 });
    routes['GET /api/agents/agent-1/matches'] = () =>
      assert.fail('no discovery while a match is tracked');
    const out = await dispatchTool('queue_match', { gameId: 'chess' }, ctx);
    assert.equal(out.error, 'already_in_match');
  });
});

// --- wait_for_turn spans the series gap ------------------------------------

describe('wait_for_turn across the series gap', () => {
  test('game_over(run continues) → next call adopts the assigned game and returns your_turn', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'liars-dice', lastSequence: 8 });
    stateRoute('m-1', TOURNAMENT_GAME_OVER);
    const over = await dispatchTool('wait_for_turn', { timeoutMs: 5000 }, ctx);
    assert.equal(over.status, 'game_over');
    assert.equal(over.nextGameAssigned, true);

    matchesRoute([
      row('m-2', 'liars-dice', 'active'),
      row('m-1', 'liars-dice', 'completed', '2026-08-21T00:00:00Z'),
    ]);
    stateRoute('m-2', yourTurn('m-2'));
    const next = await dispatchTool('wait_for_turn', { timeoutMs: 8000 }, ctx);
    assert.equal(next.status, 'your_turn');
    assert.equal(next.matchId, 'm-2');
  });

  test('assignment arriving mid-wait is adopted inside ONE blocking call', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    // The gap loop re-verifies the run against m-1's terminal state.
    stateRoute('m-1', TOURNAMENT_GAME_OVER);
    let discoveries = 0;
    routes['GET /api/agents/agent-1/matches'] = (req, res) => {
      discoveries += 1;
      const rows =
        discoveries >= 2
          ? [row('m-2', 'liars-dice', 'active'), row('m-1', 'liars-dice', 'completed', 'x')]
          : [row('m-1', 'liars-dice', 'completed', 'x')];
      respond(res, 200, { agentId: 'agent-1', matches: rows, total: rows.length });
    };
    stateRoute('m-2', yourTurn('m-2'));
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 8000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(out.matchId, 'm-2');
    assert.ok(discoveries >= 2, 'discovery must poll across the gap');
  });

  test('timeout while the run continues → awaiting_next_game, no queue_match steer', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    matchesRoute([row('m-1', 'liars-dice', 'completed', 'x')]);
    stateRoute('m-1', TOURNAMENT_GAME_OVER); // re-verify: run still continues
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, ctx);
    assert.equal(out.ok, true);
    assert.equal(out.timedOut, true);
    assert.equal(out.status, 'awaiting_next_game');
    assert.doesNotMatch(out.hint ?? '', /queue_match/);
    assert.ok(ctx.store.readTournamentRun(), 're-verification must keep a live run');
  });

  test('a STALE run record is cleared by re-verification (server says the run is over)', async () => {
    const ctx = makeCtx();
    // Recorded 'continues' — e.g. a game_over built during a settle race, or a
    // run that ended with no further game-over for this agent.
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    matchesRoute([row('m-1', 'liars-dice', 'completed', 'x')]);
    stateRoute('m-1', {
      ...TOURNAMENT_GAME_OVER,
      nextGameAssigned: undefined, // fresh server computation: run over
      messaging: { encouragement: 'Champion! Queue any time.' },
    });
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 8000 }, ctx);
    // The wait must NOT hold for the whole budget on a dead run — it exits to
    // the normal no-run flow, and the record is gone.
    assert.equal(out.error, 'no_active_match');
    assert.equal(ctx.store.readTournamentRun(), null);
  });

  test('no flag, no pending, no server match → no_active_match after ONE discovery (normal polarity)', async () => {
    const ctx = makeCtx();
    let discoveries = 0;
    routes['GET /api/agents/agent-1/matches'] = (req, res) => {
      discoveries += 1;
      respond(res, 200, { agentId: 'agent-1', matches: [], total: 0 });
    };
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 5000 }, ctx);
    assert.equal(out.error, 'no_active_match');
    assert.equal(discoveries, 1);
  });
});

// --- in-order delivery of an unseen finished game (carryover analog) --------

describe('unseen finished game delivery (plugin-carryover analog)', () => {
  test('a game that ended with zero agent contact is adopted FIRST and its envelope delivered verbatim', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    ctx.store.updateCredentials({ lastCompletedMatch: { matchId: 'm-1', gameId: 'liars-dice' } });
    matchesRoute([
      row('m-3', 'liars-dice', 'waiting'),
      row('m-2', 'liars-dice', 'completed', '2026-08-21T01:00:00Z'),
      row('m-1', 'liars-dice', 'completed', '2026-08-21T00:00:00Z'),
    ]);
    const m2Over = {
      ...TOURNAMENT_GAME_OVER,
      matchId: 'm-2',
      results: [{ agentId: 'agent-1', outcome: 'loss', reason: 'forfeit' }],
      messaging: { encouragement: 'Game 2 was forfeited by absence.' },
      nextGameAssigned: true,
    };
    stateRoute('m-2', m2Over);
    stateRoute('m-3', yourTurn('m-3'));

    // First read delivers the MISSED game's terminal envelope, verbatim.
    const first = await dispatchTool('get_turn', {}, ctx);
    assert.equal(first.status, 'game_over');
    assert.equal(first.matchId, 'm-2');
    assert.deepEqual(first.results, m2Over.results);
    assert.deepEqual(first.messaging, m2Over.messaging);
    assert.equal(ctx.store.readTournamentRun().sinceMatchId, 'm-2');

    // Second read moves on to the live game — nothing skipped, order preserved.
    const second = await dispatchTool('get_turn', {}, ctx);
    assert.equal(second.status, 'your_turn');
    assert.equal(second.matchId, 'm-3');
  });

  test('a 404ing adopted match is skipped once, never re-adopted (no adopt/404 loop)', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    matchesRoute([row('m-2', 'liars-dice', 'active'), row('m-1', 'liars-dice', 'completed', 'x')]);
    let stateCalls = 0;
    routes['GET /api/matches/m-2/state'] = (req, res) => {
      stateCalls += 1;
      respond(res, 404, { error: 'match_not_found' });
    };
    const first = await dispatchTool('get_turn', {}, ctx);
    assert.equal(first.error, 'match_not_found');
    assert.doesNotMatch(first.hint, /Call queue_match/);
    const second = await dispatchTool('get_turn', {}, ctx);
    assert.equal(second.error, 'no_active_match');
    assert.equal(stateCalls, 1, 'the vanished match must not be re-adopted');
  });

  test('404 hint keeps the queue nudge when NO run continues (polarity)', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-gone', gameId: 'nim', lastSequence: 0 });
    routes['GET /api/matches/m-gone/state'] = (req, res) =>
      respond(res, 404, { error: 'match_not_found' });
    matchesRoute([]);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.error, 'match_not_found');
    assert.match(out.hint, /queue_match/);
  });
});

// --- refuter findings: pagination guard + adoption race -----------------------

describe('discovery safety guards (adversarial review)', () => {
  test('a page holding NO delivered-match anchor is never adopted from (pagination guard)', async () => {
    const ctx = makeCtx();
    // Run recorded against m-9, which is NOT in the page — an unsorted backend
    // with deep history serves its oldest rows first.
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-9', gameId: 'liars-dice' });
    ctx.store.updateCredentials({ lastCompletedMatch: { matchId: 'm-9', gameId: 'liars-dice' } });
    matchesRoute([
      row('m-2', 'nim', 'completed', '2026-07-01T00:00:00Z'),
      row('m-1', 'nim', 'completed', '2026-06-01T00:00:00Z'),
    ]);
    routes['GET /api/matches/m-1/state'] = () =>
      assert.fail('stale history must not be adopted or re-delivered');
    routes['GET /api/matches/m-2/state'] = () =>
      assert.fail('stale history must not be adopted or re-delivered');
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.error, 'no_active_match');
    // The live run record survives — an old normal match's envelope (no
    // nextGameAssigned) must never clear it.
    assert.equal(ctx.store.readTournamentRun().sinceMatchId, 'm-9');
    assert.equal(ctx.store.readCredentials().lastCompletedMatch.matchId, 'm-9');
  });

  test('a match formed from the queue DURING the discovery read is not clobbered', async () => {
    const ctx = makeCtx();
    ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
    routes['GET /api/agents/agent-1/matches'] = async (req, res) => {
      // Slow list read: a queue-matched writer lands while this is in flight.
      await new Promise((r) => setTimeout(r, 150));
      const rows = [row('m-2', 'liars-dice', 'active'), row('m-1', 'liars-dice', 'completed', 'x')];
      respond(res, 200, { agentId: 'agent-1', matches: rows, total: rows.length });
    };
    stateRoute('m-queue', { ...yourTurn('m-queue', 'nim'), matchId: 'm-queue' });
    routes['GET /api/matches/m-2/state'] = () =>
      assert.fail('adoption must yield to the queue-formed match');
    const pendingCall = dispatchTool('get_turn', {}, ctx);
    await new Promise((r) => setTimeout(r, 50));
    // A non-locked writer (wake notifier / queue watch) binds a fresh match.
    ctx.store.writeCurrentMatch({
      matchId: 'm-queue',
      gameId: 'nim',
      lastSequence: 0,
      lastStatus: 'matched',
    });
    const out = await pendingCall;
    assert.equal(out.matchId, 'm-queue');
    assert.equal(ctx.store.readCurrentMatch().matchId, 'm-queue');
  });
});

// --- unconsumed-turn fast path (found via the live tournament harness) ------------

describe('wait_for_turn unconsumed-turn fast path', () => {
  test('lastStatus your_turn → re-reads WITHOUT wait and returns the pending turn', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({
      matchId: 'm-1',
      gameId: 'liars-dice',
      lastSequence: 52,
      lastStatus: 'your_turn',
    });
    routes['GET /api/matches/m-1/state'] = (req, res, url) => {
      // A wait=true&afterSequence=52 park would hold server-side forever here —
      // the pending action is the agent's own (no future event is coming).
      assert.notEqual(url.searchParams.get('wait'), 'true', 'must not park on a pending turn');
      respond(res, 200, { ...yourTurn('m-1'), sequence: 52 });
    };
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 5000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(out.sequence, 52);
  });

  test('after the first-read resync, waiting states long-poll as before (polarity)', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({
      matchId: 'm-1',
      gameId: 'liars-dice',
      lastSequence: 3,
      lastStatus: 'waiting',
    });
    let calls = 0;
    routes['GET /api/matches/m-1/state'] = (req, res, url) => {
      calls += 1;
      if (calls === 1) {
        // First read of the call: ground-truth resync, no park.
        assert.notEqual(url.searchParams.get('wait'), 'true');
        return respond(res, 200, {
          matchId: 'm-1',
          gameId: 'liars-dice',
          gameType: 'sequential',
          status: 'waiting',
          sequence: 3,
          view: {},
        });
      }
      // Subsequent reads long-poll on the cursor.
      assert.equal(url.searchParams.get('wait'), 'true');
      assert.equal(url.searchParams.get('afterSequence'), '3');
      respond(res, 200, { ...yourTurn('m-1'), sequence: 4 });
    };
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 5000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(out.sequence, 4);
    assert.equal(calls, 2);
  });
});

// --- wake notifier discovers the next assigned game -------------------------

describe('wake notifier tournament discovery', () => {
  async function withWebhookReceiver(fn) {
    const received = [];
    const hook = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(202).end();
    });
    await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
    try {
      await fn(`http://127.0.0.1:${hook.address().port}/hook`, received);
    } finally {
      hook.close();
    }
  }

  function waitUntil(cond, ms = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (cond()) {
          clearInterval(t);
          resolve();
        } else if (Date.now() - start > ms) {
          clearInterval(t);
          reject(new Error('waitUntil timeout'));
        }
      }, 25);
    });
  }

  test('idle + run continues → discovers, adopts, and wakes match_found', async () => {
    await withWebhookReceiver(async (hookUrl, received) => {
      const ctx = makeCtx();
      ctx.cfg.wake = { url: hookUrl, authMode: 'bearer', secret: 's', headerName: 'Authorization' };
      ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
      matchesRoute([
        row('m-2', 'liars-dice', 'active'),
        row('m-1', 'liars-dice', 'completed', 'x'),
      ]);
      // Keep the adopted match 'waiting' so the notifier settles after the wake.
      stateRoute('m-2', {
        matchId: 'm-2',
        gameId: 'liars-dice',
        gameType: 'sequential',
        status: 'waiting',
        sequence: 0,
        view: {},
      });
      const notifier = makeWakeNotifier(ctx);
      notifier.start();
      try {
        await waitUntil(() => received.length >= 1);
      } finally {
        await notifier.stop();
      }
      const body = JSON.parse(received[0].body);
      assert.equal(body.event, 'match_found');
      assert.equal(body.matchId, 'm-2');
      assert.equal(ctx.store.readCurrentMatch().matchId, 'm-2');
    });
  });

  test('a 404ing adopted match is skip-recorded by the notifier, never re-adopted', async () => {
    await withWebhookReceiver(async (hookUrl, received) => {
      const ctx = makeCtx();
      ctx.cfg.wake = { url: hookUrl, authMode: 'bearer', secret: 's', headerName: 'Authorization' };
      ctx.store.writeTournamentRun({ sinceMatchId: 'm-1', gameId: 'liars-dice' });
      matchesRoute([
        row('m-2', 'liars-dice', 'active'),
        row('m-1', 'liars-dice', 'completed', 'x'),
      ]);
      stateRoute('m-1', TOURNAMENT_GAME_OVER); // run re-verification target
      let m2StateCalls = 0;
      routes['GET /api/matches/m-2/state'] = (req, res) => {
        m2StateCalls += 1;
        respond(res, 404, { error: 'match_not_found' });
      };
      const notifier = makeWakeNotifier(ctx);
      notifier.start();
      try {
        await waitUntil(
          () => (ctx.store.readTournamentRun()?.skippedMatchIds ?? []).includes('m-2'),
          5000,
        );
      } finally {
        await notifier.stop();
      }
      assert.equal(ctx.store.readCurrentMatch(), null);
      assert.equal(m2StateCalls, 1, 'the vanished match must not be re-adopted and re-polled');
      assert.ok(received.length >= 1, 'the adoption wake fired before the 404');
    });
  });

  test('idle WITHOUT the run flag → no discovery, no wake (normal idle unchanged)', async () => {
    await withWebhookReceiver(async (hookUrl, received) => {
      const ctx = makeCtx();
      ctx.cfg.wake = { url: hookUrl, authMode: 'bearer', secret: 's', headerName: 'Authorization' };
      routes['GET /api/agents/agent-1/matches'] = () =>
        assert.fail('no idle discovery without the tournament-run flag');
      const notifier = makeWakeNotifier(ctx);
      notifier.start();
      await new Promise((r) => setTimeout(r, 400));
      await notifier.stop();
      assert.equal(received.length, 0);
    });
  });
});

// --- tool descriptions stay honest ------------------------------------------

describe('tool description updates', () => {
  test('wait_for_turn documents the tournament-series span', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'wait_for_turn');
    assert.match(def.description, /tournament/i);
  });
});
