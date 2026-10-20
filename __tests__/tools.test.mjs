// Tool surface tests against a scriptable mock game server, plus the
// wake notifier against a mock webhook receiver.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { createHmac } from 'node:crypto';
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

function makeCtx({ registered = true } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scmcp-tools-'));
  const store = makeStateStore(dir);
  if (registered) {
    store.writeCredentials({
      server: baseUrl,
      agentId: 'agent-1',
      apiKey: 'k_test_secret_9999',
      name: 'TestBot',
      registeredAt: new Date().toISOString(),
    });
  }
  return {
    cfg: { baseUrl, stateDir: dir, wake: null },
    store,
    health: { lastError: null },
    activity: { inFlight: 0 },
  };
}

const GAME_OVER_ENVELOPE = {
  matchId: 'm-1',
  gameId: 'tic-tac-toe',
  gameType: 'sequential',
  status: 'game_over',
  sequence: 9,
  view: { board: ['X'] },
  results: [
    { agentId: 'agent-1', outcome: 'win' },
    { agentId: 'agent-2', outcome: 'loss' },
  ],
  rating: { before: 1000, after: 1016, gameId: 'tic-tac-toe' },
  suggestions: ['nim', 'liars-dice'],
  newBadges: [{ id: 'first-win', name: 'First Win' }],
  shareText: 'TestBot won a nail-biter on SteamedClaw!',
  replayUrl: 'https://steamedclaw.com/api/matches/m-1',
  replayMarkdownUrl: 'https://steamedclaw.com/api/matches/m-1?format=md',
  matchUrl: 'https://steamedclaw.com/matches/m-1',
  messaging: { teaser: 'server teaser text', encouragement: 'server encouragement text' },
};

beforeEach(() => {
  routes = {};
});

// --- tool surface ----------------------------------------------------------

describe('tool defs', () => {
  test('gameplay and tournament tools, all with schemas', () => {
    assert.deepEqual(TOOL_DEFS.map((t) => t.name).sort(), [
      'enter_tournament',
      'get_my_tournament_schedule',
      'get_profile',
      'get_rules',
      'get_strategy',
      'get_tournament',
      'get_tournament_entry',
      'get_tournament_schedule',
      'get_tournament_standings',
      'get_tournament_terms',
      'get_turn',
      'leave_queue',
      'list_games',
      'list_tournaments',
      'queue_match',
      'record_reflection',
      'register_agent',
      'replay_match',
      'take_turn',
      'wait_for_event',
      'wait_for_turn',
    ]);
    for (const t of TOOL_DEFS) {
      assert.ok(t.description.length > 40, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });

  test('unknown tool name → unknown_tool', async () => {
    const ctx = makeCtx();
    assert.equal((await dispatchTool('nope', {}, ctx)).error, 'unknown_tool');
  });
});

describe('register_agent', () => {
  test('201 persists credentials + claim.md; result NEVER contains the apiKey', async () => {
    const ctx = makeCtx({ registered: false });
    routes['POST /api/agents'] = (req, res, url, body) =>
      respond(res, 201, {
        id: 'agent-9',
        name: body.name,
        model: body.model ?? null,
        apiKey: 'k_super_secret_12345',
        claim_url: `${baseUrl}/claim?agent=agent-9`,
        verification_code: 'lucky-crab-42',
      });
    const out = await dispatchTool('register_agent', { name: 'Fresh Bot' }, ctx);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'registered');
    assert.equal(out.agentId, 'agent-9');
    assert.match(out.claimUrl, /claim\?agent=agent-9/);
    assert.equal(out.verificationCode, 'lucky-crab-42');
    assert.doesNotMatch(JSON.stringify(out), /k_super_secret_12345/);
    const creds = ctx.store.readCredentials();
    assert.equal(creds.apiKey, 'k_super_secret_12345');
    assert.match(ctx.store.readClaimFile(), /lucky-crab-42/);
    assert.doesNotMatch(ctx.store.readClaimFile(), /k_super_secret_12345/);
  });

  test('idempotent when credentials exist — no second identity', async () => {
    const ctx = makeCtx();
    routes['POST /api/agents'] = () => assert.fail('must not hit the server');
    const out = await dispatchTool('register_agent', { name: 'Another Name' }, ctx);
    assert.equal(out.status, 'already_registered');
    assert.equal(out.agentId, 'agent-1');
  });

  test('409 → name_taken with hint; invalid name rejected locally', async () => {
    const ctx = makeCtx({ registered: false });
    routes['POST /api/agents'] = (req, res) => respond(res, 409, { error: 'name_taken' });
    assert.equal(
      (await dispatchTool('register_agent', { name: 'Taken' }, ctx)).error,
      'name_taken',
    );
    assert.equal((await dispatchTool('register_agent', { name: 'x' }, ctx)).error, 'invalid_name');
    assert.equal(
      (await dispatchTool('register_agent', { name: 'bad!chars<>' }, ctx)).error,
      'invalid_name',
    );
  });
});

describe('queue_match / leave_queue', () => {
  test('matched → current match written; queued → pending queue written', async () => {
    const ctx = makeCtx();
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, { status: 'matched', matchId: 'm-1', players: ['agent-1', 'agent-2'] });
    const out = await dispatchTool('queue_match', { gameId: 'tic-tac-toe' }, ctx);
    assert.equal(out.status, 'matched');
    assert.equal(ctx.store.readCurrentMatch().matchId, 'm-1');

    const ctx2 = makeCtx();
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, { status: 'queued', position: 1 });
    const out2 = await dispatchTool('queue_match', { gameId: 'nim', lane: 'fast' }, ctx2);
    assert.equal(out2.status, 'queued');
    assert.equal(ctx2.store.readPendingQueue().gameId, 'nim');
  });

  test('429 game_limit_reached surfaces the server message, claimUrl and real wait verbatim', async () => {
    const ctx = makeCtx();
    const serverMessage =
      'Game limit reached: unclaimed agents may play 10 games per rolling 24h. Have your operator claim your agent at https://steamedclaw.com/claim?agent=agent-1&code=v-1 to raise your limit to 50 games per 24h.';
    let calls = 0;
    routes['POST /api/matchmaking/queue'] = (req, res) => {
      calls += 1;
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3600' });
      res.end(
        JSON.stringify({
          error: 'game_limit_reached',
          message: serverMessage,
          limit: 10,
          windowHours: 24,
          retryAfterSeconds: 3600,
          claimUrl: 'https://steamedclaw.com/claim?agent=agent-1&code=v-1',
        }),
      );
    };
    const out = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'game_limit_reached');
    assert.equal(out.message, serverMessage); // server-authored, byte-identical
    assert.equal(out.claimUrl, 'https://steamedclaw.com/claim?agent=agent-1&code=v-1');
    assert.equal(out.retryAfterSeconds, 3600);
    assert.equal(out.limit, 10);
    assert.equal(out.windowHours, 24);
    // Not the generic rate-limit shape: no ~1s retry, no polling advice.
    assert.equal('retryAfterMs' in out, false);
    assert.doesNotMatch(out.hint, /wait_for_turn/);
    assert.match(out.hint, /retryAfterSeconds/);
    // The server message is written to the agent ("Have your operator claim
    // your agent…"), so the hint must not ask for it to be relayed verbatim.
    assert.doesNotMatch(out.hint, /VERBATIM/);
    assert.match(out.hint, /Tell your operator .*claimUrl/);
    // An hour-long wait is never retried client-side, and nothing was queued.
    assert.equal(calls, 1);
    assert.equal(ctx.store.readPendingQueue(), null);
  });

  test('429 game_limit_reached for a claimed agent carries no claimUrl', async () => {
    const ctx = makeCtx();
    const serverMessage =
      'Game limit reached: 50 games per rolling 24h. A slot opens when your oldest game leaves the window — see Retry-After.';
    routes['POST /api/matchmaking/queue'] = (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '900' });
      res.end(
        JSON.stringify({
          error: 'game_limit_reached',
          message: serverMessage,
          limit: 50,
          windowHours: 24,
          retryAfterSeconds: 900,
        }),
      );
    };
    const out = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(out.error, 'game_limit_reached');
    assert.equal(out.message, serverMessage);
    assert.equal(out.retryAfterSeconds, 900);
    assert.equal('claimUrl' in out, false);
    assert.doesNotMatch(out.hint, /claimUrl/);
  });

  test('429 game_limit_reached without retryAfterSeconds in the body falls back to Retry-After', async () => {
    const ctx = makeCtx();
    routes['POST /api/matchmaking/queue'] = (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1200' });
      res.end(JSON.stringify({ error: 'game_limit_reached', message: 'limit' }));
    };
    const out = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(out.error, 'game_limit_reached');
    assert.equal(out.retryAfterSeconds, 1200);
    assert.equal('limit' in out, false); // absent stays absent

    // With no wait anywhere, the hint never points at a missing field.
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 429, { error: 'game_limit_reached' });
    const bare = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(bare.error, 'game_limit_reached');
    assert.equal('retryAfterSeconds' in bare, false);
    assert.equal('message' in bare, false);
    assert.doesNotMatch(bare.hint, /retryAfterSeconds|VERBATIM/);
  });

  test('an ordinary 429 on queue_match keeps the rate_limited shape', async () => {
    const ctx = makeCtx();
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 429, { error: 'rate_limited', retryAfterMs: 1 });
    const out = await dispatchTool('queue_match', { gameId: 'nim' }, ctx);
    assert.equal(out.error, 'rate_limited');
    assert.equal(out.retryAfterMs, 1);
    assert.match(out.hint, /wait_for_turn/);
  });

  test('refuses a second simultaneous match', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 2 });
    const out = await dispatchTool('queue_match', { gameId: 'chess' }, ctx);
    assert.equal(out.error, 'already_in_match');
  });

  test('leave_queue issues server DELETE; already_matched surfaces the owed match', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'nim', lane: 'standard' });
    let sawMethod;
    routes['DELETE /api/matchmaking/queue'] = (req, res, url) => {
      sawMethod = req.method;
      assert.equal(url.searchParams.get('gameId'), 'nim');
      respond(res, 200, { status: 'left', removed: 1 });
    };
    const out = await dispatchTool('leave_queue', { gameId: 'nim' }, ctx);
    assert.equal(sawMethod, 'DELETE');
    assert.equal(out.status, 'left');
    assert.equal(ctx.store.readPendingQueue(), null);

    routes['DELETE /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, { status: 'already_matched', matchId: 'm-7' });
    ctx.store.writePendingQueue({ gameId: 'nim', lane: 'standard' });
    const out2 = await dispatchTool('leave_queue', { gameId: 'nim' }, ctx);
    assert.equal(out2.status, 'already_matched');
    assert.equal(ctx.store.readCurrentMatch().matchId, 'm-7');
  });
});

describe('get_turn state mapping', () => {
  test('your_turn carries view, sequence, turnEndsAt, deadline guidance', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 0 });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        matchId: 'm-1',
        gameId: 'tic-tac-toe',
        gameType: 'sequential',
        status: 'your_turn',
        sequence: 3,
        view: { board: [null] },
        turnEndsAt: '2026-07-03T18:00:00.000Z',
      });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(out.sequence, 3);
    assert.equal(out.turnEndsAt, '2026-07-03T18:00:00.000Z');
    assert.match(out.guidance, /BEFORE 2026-07-03T18:00:00/);
    assert.equal(ctx.store.readCurrentMatch().lastSequence, 3);
  });

  test('discussion surfaces bounded message tail + chat guidance', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'werewolf-7', lastSequence: 1 });
    const messages = Array.from({ length: 40 }, (_, i) => ({
      from: 'a',
      text: `msg-${i}`,
      timestamp: 't',
    }));
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        matchId: 'm-1',
        gameId: 'werewolf-7',
        gameType: 'simultaneous',
        status: 'discussion',
        sequence: 2,
        view: {},
        pollAfterMs: 2000,
        messages,
      });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'discussion');
    assert.equal(out.messages.length, 30); // bounded tail
    assert.equal(out.messages[29].text, 'msg-39');
    assert.match(out.guidance, /type:"message"/);
  });

  test('REGRESSION (HARD RULE): game_over forwards the FULL server envelope verbatim', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER_ENVELOPE);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    // Every server-authored field must ride through byte-identical.
    assert.deepEqual(out.results, GAME_OVER_ENVELOPE.results);
    assert.deepEqual(out.rating, GAME_OVER_ENVELOPE.rating);
    assert.deepEqual(out.suggestions, GAME_OVER_ENVELOPE.suggestions);
    assert.deepEqual(out.newBadges, GAME_OVER_ENVELOPE.newBadges);
    assert.equal(out.shareText, GAME_OVER_ENVELOPE.shareText);
    assert.equal(out.replayUrl, GAME_OVER_ENVELOPE.replayUrl);
    assert.equal(out.replayMarkdownUrl, GAME_OVER_ENVELOPE.replayMarkdownUrl);
    assert.equal(out.matchUrl, GAME_OVER_ENVELOPE.matchUrl); // portal page for the human
    assert.deepEqual(out.messaging, GAME_OVER_ENVELOPE.messaging); // ONE opaque object
    assert.match(out.guidance, /VERBATIM/);
    // Active slot cleared; last completed remembered for replay/reflection.
    assert.equal(ctx.store.readCurrentMatch(), null);
    assert.equal(ctx.store.readCredentials().lastCompletedMatch.matchId, 'm-1');
  });

  test('nextGameAssigned=true suppresses the queue_match nudge and defers to server messaging', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'liars-dice', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        ...GAME_OVER_ENVELOPE,
        suggestions: null, // the server suppresses these mid-run too
        messaging: {
          encouragement:
            'Do not queue for a new match — your next game is assigned to you automatically.',
        },
        nextGameAssigned: true,
      });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    // The signal is forwarded (machine-readable, like every server field).
    assert.equal(out.nextGameAssigned, true);
    // Hierarchy: client guidance must not contradict the server messaging —
    // the queue nudge is replaced with an explicit do-not-queue deferral.
    assert.doesNotMatch(out.guidance, /To play again, call the queue_match tool/);
    assert.match(out.guidance, /Do NOT call queue_match/);
    assert.match(out.guidance, /server messaging/);
  });

  test('without the signal the queue nudge is byte-identical (old servers / normal matches)', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER_ENVELOPE);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    assert.equal('nextGameAssigned' in out, false); // absent stays absent
    assert.match(
      out.guidance,
      /To play again, call the queue_match tool \(suggestions lists good next games\)\./,
    );
  });

  test('unclaimed-agent nudge appears on game_over when claim.md exists and no owner seen', async () => {
    const ctx = makeCtx();
    ctx.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'https://steamedclaw.com/claim?agent=agent-1',
      verificationCode: 'v-1',
    });
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER_ENVELOPE);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.match(out.guidance, /UNCLAIMED/);

    // And it disappears once the profile has shown an owner.
    const ctx2 = makeCtx();
    ctx2.store.updateCredentials({ ownerSeen: true });
    ctx2.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    const out2 = await dispatchTool('get_turn', {}, ctx2);
    assert.doesNotMatch(out2.guidance ?? '', /UNCLAIMED/);
  });

  test('game_over asks the server before nudging: a claimed agent that never called get_profile is not nagged', async () => {
    const ctx = makeCtx();
    ctx.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'https://steamedclaw.com/claim?agent=agent-1',
      verificationCode: 'v-1',
    });
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER_ENVELOPE);
    let meCalls = 0;
    routes['GET /api/agents/me'] = (req, res) => {
      meCalls += 1;
      // Claimed by an owner with no display name: no `owner` field.
      respond(res, 200, { id: 'agent-1', claim: { claimed: true, claimUrl: null } });
    };
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    assert.doesNotMatch(out.guidance, /UNCLAIMED/);
    assert.equal(ctx.store.readCredentials().ownerSeen, true);
    assert.equal(meCalls, 1);

    // Once claimed is known, later game-overs do not re-ask the server.
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    const again = await dispatchTool('get_turn', {}, ctx);
    assert.doesNotMatch(again.guidance, /UNCLAIMED/);
    assert.equal(meCalls, 1);
  });

  test('game_over nudge for a server-confirmed unclaimed agent carries the server claim link', async () => {
    const ctx = makeCtx();
    ctx.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'https://steamedclaw.com/claim?agent=agent-1&code=v-1',
      verificationCode: 'v-1',
    });
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER_ENVELOPE);
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, {
        id: 'agent-1',
        claim: { claimed: false, claimUrl: 'https://steamedclaw.com/claim?agent=agent-1&code=v-2' },
      });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.match(out.guidance, /UNCLAIMED/);
    assert.match(out.guidance, /claim\?agent=agent-1&code=v-2/);
    assert.equal(ctx.store.readCredentials().ownerSeen, undefined);
  });

  test('game_over claim read on an older server (no claim block) falls back to owner', async () => {
    const claimed = makeCtx();
    claimed.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'u',
      verificationCode: 'v',
    });
    claimed.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER_ENVELOPE);
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, { id: 'agent-1', owner: { displayName: 'Owner' } });
    const out = await dispatchTool('get_turn', {}, claimed);
    assert.doesNotMatch(out.guidance, /UNCLAIMED/);
    assert.equal(claimed.store.readCredentials().ownerSeen, true);

    const unclaimed = makeCtx();
    unclaimed.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'u',
      verificationCode: 'v',
    });
    unclaimed.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/agents/me'] = (req, res) => respond(res, 200, { id: 'agent-1' });
    const out2 = await dispatchTool('get_turn', {}, unclaimed);
    assert.match(out2.guidance, /UNCLAIMED/);
    assert.ok(out2.guidance.includes(unclaimed.store.claimPath));
  });

  test('a network failure on the game_over claim read keeps the claim.md nudge and still delivers', async () => {
    const ctx = makeCtx();
    ctx.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'u',
      verificationCode: 'v',
    });
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER_ENVELOPE);
    ctx.fetchImpl = (url, opts) =>
      new URL(url).pathname === '/api/agents/me'
        ? Promise.reject(new TypeError('fetch failed'))
        : fetch(url, opts);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    assert.match(out.guidance, /UNCLAIMED/);
    assert.ok(out.guidance.includes(ctx.store.claimPath));
    assert.equal(ctx.store.readCurrentMatch(), null);
  });

  test('404 clears the stale current match', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-gone', gameId: 'nim', lastSequence: 0 });
    routes['GET /api/matches/m-gone/state'] = (req, res) =>
      respond(res, 404, { error: 'match_not_found' });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.error, 'match_not_found');
    assert.equal(ctx.store.readCurrentMatch(), null);
  });

  test('401 is actionable in the result, not buried', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 0 });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 401, { error: 'unauthorized' });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.error, 'unauthorized');
    assert.match(out.hint, /credentials\.json|re-register/);
    assert.equal(ctx.health.lastError, 'unauthorized');
  });
});

describe('take_turn', () => {
  test('submits stored sequence; success → submitted with next-step guidance', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 3 });
    routes['POST /api/matches/m-1/action'] = (req, res, url, body) => {
      assert.equal(body.sequence, 3);
      assert.deepEqual(body.action, { type: 'move', position: 4 });
      respond(res, 200, {
        success: true,
        state: {
          matchId: 'm-1',
          gameId: 'tic-tac-toe',
          gameType: 'sequential',
          status: 'waiting',
          sequence: 4,
          view: {},
          pollAfterMs: 3000,
        },
      });
    };
    const out = await dispatchTool('take_turn', { action: { type: 'move', position: 4 } }, ctx);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'submitted');
    assert.equal(ctx.store.readCurrentMatch().lastSequence, 4);
  });

  test('{type:"message"} is turn-preserving → message_sent', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'werewolf-7', lastSequence: 2 });
    routes['POST /api/matches/m-1/action'] = (req, res, url, body) => {
      assert.equal(body.action.type, 'message');
      assert.equal(body.action.to, 'agent-3');
      respond(res, 200, {
        success: true,
        state: {
          matchId: 'm-1',
          gameId: 'werewolf-7',
          gameType: 'simultaneous',
          status: 'discussion',
          sequence: 2,
          view: {},
          messages: [{ from: 'agent-1', text: 'psst', timestamp: 't' }],
        },
      });
    };
    const out = await dispatchTool(
      'take_turn',
      { action: { type: 'message', text: 'psst', to: 'agent-3' } },
      ctx,
    );
    assert.equal(out.status, 'message_sent');
    assert.match(out.guidance, /did NOT consume your turn/);
  });

  test('action ending the game returns the full game_over envelope', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['POST /api/matches/m-1/action'] = (req, res) =>
      respond(res, 200, { success: true, state: GAME_OVER_ENVELOPE });
    const out = await dispatchTool('take_turn', { action: { type: 'move', position: 8 } }, ctx);
    assert.equal(out.status, 'game_over');
    assert.deepEqual(out.messaging, GAME_OVER_ENVELOPE.messaging);
    assert.equal(out.shareText, GAME_OVER_ENVELOPE.shareText);
    assert.equal(out.matchUrl, GAME_OVER_ENVELOPE.matchUrl);
  });

  test('409 stale_sequence updates the local cursor and hints a refresh', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 2 });
    routes['POST /api/matches/m-1/action'] = (req, res) =>
      respond(res, 409, { error: 'stale_sequence', currentSequence: 5 });
    const out = await dispatchTool('take_turn', { action: { type: 'take', count: 1 } }, ctx);
    assert.equal(out.error, 'stale_sequence');
    assert.equal(out.currentSequence, 5);
    assert.equal(ctx.store.readCurrentMatch().lastSequence, 5);
    assert.match(out.hint, /get_turn/);
  });

  test('{type:"resign"} rides the normal action path', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'chess', lastSequence: 12 });
    routes['POST /api/matches/m-1/action'] = (req, res, url, body) => {
      assert.deepEqual(body.action, { type: 'resign' });
      respond(res, 200, { success: true, state: { ...GAME_OVER_ENVELOPE, gameId: 'chess' } });
    };
    const out = await dispatchTool('take_turn', { action: { type: 'resign' } }, ctx);
    assert.equal(out.status, 'game_over');
    assert.deepEqual(out.messaging, GAME_OVER_ENVELOPE.messaging);
  });

  test('429 after client retries surfaces as an actionable rate_limited result', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 2 });
    routes['POST /api/matches/m-1/action'] = (req, res) =>
      respond(res, 429, { error: 'rate_limited', retryAfterMs: 1 });
    const out = await dispatchTool('take_turn', { action: { type: 'take', count: 1 } }, ctx);
    assert.equal(out.error, 'rate_limited');
    assert.ok(typeof out.retryAfterMs === 'number');
    assert.match(out.hint, /wait_for_turn/);
  });

  test('400 invalid_action carries details + rules hint; malformed args rejected locally', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 2 });
    routes['POST /api/matches/m-1/action'] = (req, res) =>
      respond(res, 400, { error: 'invalid_action', details: 'take count out of range' });
    const out = await dispatchTool('take_turn', { action: { type: 'take', count: 99 } }, ctx);
    assert.equal(out.error, 'invalid_action');
    assert.equal(out.details, 'take count out of range');
    assert.match(out.hint, /get_rules/);

    assert.equal(
      (await dispatchTool('take_turn', { action: 'move' }, ctx)).error,
      'invalid_argument',
    );
    assert.equal((await dispatchTool('take_turn', { action: [1] }, ctx)).error, 'invalid_argument');
    assert.equal((await dispatchTool('take_turn', {}, ctx)).error, 'invalid_argument');
  });
});

describe('wait_for_turn full chain', () => {
  test('queued → matched → your_turn in ONE call', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'nim', lane: 'standard' });
    let statusCalls = 0;
    routes['GET /api/matchmaking/status'] = (req, res) => {
      statusCalls += 1;
      if (statusCalls === 1) return respond(res, 200, { status: 'queued', position: 1 });
      respond(res, 200, { status: 'matched', matchId: 'm-2' });
    };
    routes['GET /api/matches/m-2/state'] = (req, res) => {
      // First read of the call is a no-wait ground-truth resync (wedge guard);
      // it may serve the turn directly.
      respond(res, 200, {
        matchId: 'm-2',
        gameId: 'nim',
        gameType: 'sequential',
        status: 'your_turn',
        sequence: 1,
        view: { piles: [3, 5, 7] },
        turnEndsAt: '2026-07-03T19:00:00.000Z',
      });
    };
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 15_000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(out.matchId, 'm-2');
    assert.ok(statusCalls >= 2);
    assert.equal(ctx.store.readPendingQueue(), null);
  });

  test('waiting → your_turn across long-poll cycles', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 1 });
    let calls = 0;
    routes['GET /api/matches/m-1/state'] = (req, res) => {
      calls += 1;
      if (calls === 1) {
        return respond(res, 200, {
          matchId: 'm-1',
          gameId: 'nim',
          gameType: 'sequential',
          status: 'waiting',
          sequence: 1,
          view: {},
          pollAfterMs: 3000,
        });
      }
      respond(res, 200, {
        matchId: 'm-1',
        gameId: 'nim',
        gameType: 'sequential',
        status: 'your_turn',
        sequence: 2,
        view: {},
      });
    };
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 15_000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.equal(calls, 2);
  });

  test('timeout returns a tiny actionable result', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 1 });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        matchId: 'm-1',
        gameId: 'nim',
        gameType: 'sequential',
        status: 'waiting',
        sequence: 1,
        view: {},
      });
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 1_000 }, ctx);
    assert.equal(out.timedOut, true);
    assert.equal(out.status, 'waiting');
    assert.ok(JSON.stringify(out).length < 500, 'timeout result must stay small');
  });

  test('nothing to wait for → no_active_match', async () => {
    const ctx = makeCtx();
    const out = await dispatchTool('wait_for_turn', {}, ctx);
    assert.equal(out.error, 'no_active_match');
  });
});

describe('wait_for_event', () => {
  test('returns when new table talk arrives', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({
      matchId: 'm-1',
      gameId: 'werewolf-7',
      lastSequence: 2,
      lastStatus: 'discussion',
      lastMessageCount: 1,
    });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        matchId: 'm-1',
        gameId: 'werewolf-7',
        gameType: 'simultaneous',
        status: 'discussion',
        sequence: 2,
        view: {},
        messages: [
          { from: 'a', text: 'first', timestamp: 't' },
          { from: 'b', text: 'second', timestamp: 't' },
        ],
      });
    const out = await dispatchTool('wait_for_event', { timeoutMs: 5000 }, ctx);
    assert.equal(out.status, 'discussion');
    assert.equal(out.messages.length, 2);
  });

  test('times out quietly when nothing changes', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({
      matchId: 'm-1',
      gameId: 'werewolf-7',
      lastSequence: 2,
      lastStatus: 'discussion',
      lastMessageCount: 2,
    });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        matchId: 'm-1',
        gameId: 'werewolf-7',
        gameType: 'simultaneous',
        status: 'discussion',
        sequence: 2,
        view: {},
        messages: [
          { from: 'a', text: 'first', timestamp: 't' },
          { from: 'b', text: 'second', timestamp: 't' },
        ],
      });
    const out = await dispatchTool('wait_for_event', { timeoutMs: 1200 }, ctx);
    assert.equal(out.status, 'no_new_events');
    assert.equal(out.timedOut, true);
  });
});

describe('get_profile', () => {
  test('unclaimed profile → claimStatus + claim guidance; claimed sets ownerSeen', async () => {
    const ctx = makeCtx();
    ctx.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'u',
      verificationCode: 'v',
    });
    const profile = {
      id: 'agent-1',
      name: 'TestBot',
      ratings: { nim: { gameId: 'nim', rating: 1050, gamesPlayed: 12, provisional: true } },
      reliability: { matchesCompleted: 12, tier: 'good' },
    };
    routes['GET /api/agents/me'] = (req, res) => respond(res, 200, profile);
    const out = await dispatchTool('get_profile', {}, ctx);
    assert.equal(out.claimStatus, 'unclaimed');
    assert.match(out.guidance, /claim/);
    assert.deepEqual(out.profile.ratings.nim, profile.ratings.nim);

    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, { ...profile, owner: { displayName: 'Owner' } });
    const out2 = await dispatchTool('get_profile', {}, ctx);
    assert.equal(out2.claimStatus, 'claimed');
    assert.equal(ctx.store.readCredentials().ownerSeen, true);
  });

  test('claim.claimed is the source of truth: claimed with no owner display name reads claimed', async () => {
    const ctx = makeCtx();
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, {
        id: 'agent-1',
        name: 'TestBot',
        ratings: {},
        reliability: {},
        claim: { claimed: true, claimUrl: null },
      });
    const out = await dispatchTool('get_profile', {}, ctx);
    assert.equal(out.claimStatus, 'claimed');
    assert.equal('guidance' in out, false);
    assert.equal(ctx.store.readCredentials().ownerSeen, true);
    assert.deepEqual(out.profile.claim, { claimed: true, claimUrl: null }); // forwarded verbatim
  });

  test('claim.claimed=false gives the server claim link in the guidance', async () => {
    const ctx = makeCtx();
    const claimUrl = 'https://steamedclaw.com/claim?agent=agent-1&code=v-1';
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, {
        id: 'agent-1',
        name: 'TestBot',
        ratings: {},
        reliability: {},
        claim: { claimed: false, claimUrl },
      });
    const out = await dispatchTool('get_profile', {}, ctx);
    assert.equal(out.claimStatus, 'unclaimed');
    assert.ok(out.guidance.includes(claimUrl));
    assert.equal(ctx.store.readCredentials().ownerSeen, undefined);
  });

  test('claim.claimed=false with no claim link keeps the claim.md guidance', async () => {
    const ctx = makeCtx();
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, { id: 'agent-1', claim: { claimed: false, claimUrl: null } });
    const out = await dispatchTool('get_profile', {}, ctx);
    assert.equal(out.claimStatus, 'unclaimed');
    assert.ok(out.guidance.includes(ctx.store.claimPath));
  });

  test('optional leaderboard fetch', async () => {
    const ctx = makeCtx();
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, { id: 'agent-1', name: 'TestBot', ratings: {}, reliability: {} });
    routes['GET /api/leaderboards/nim'] = (req, res) =>
      respond(res, 200, {
        gameId: 'nim',
        entries: [{ agentId: 'agent-1', rating: 1050 }],
        total: 1,
      });
    const out = await dispatchTool('get_profile', { leaderboardGameId: 'nim' }, ctx);
    assert.equal(out.leaderboard.total, 1);
  });

  test('badges ride along; badge-endpoint failure degrades to null', async () => {
    const ctx = makeCtx();
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, { id: 'agent-1', name: 'TestBot', ratings: {}, reliability: {} });
    routes['GET /api/agents/agent-1/badges'] = (req, res) =>
      respond(res, 200, {
        badges: [{ badgeId: 'first-win', name: 'First Win', rarity: 'common', earnedAt: 't' }],
      });
    const out = await dispatchTool('get_profile', {}, ctx);
    assert.equal(out.badges.length, 1);
    assert.equal(out.badges[0].badgeId, 'first-win');

    delete routes['GET /api/agents/agent-1/badges']; // 404 from the mock
    const out2 = await dispatchTool('get_profile', {}, ctx);
    assert.equal(out2.ok, true);
    assert.equal(out2.badges, null);
  });
});

describe('rules / strategy / games / replay / reflection', () => {
  test('get_rules returns {gameId, version, content}; strategy 404 → not_available', async () => {
    const ctx = makeCtx();
    routes['GET /api/games/nim/rules'] = (req, res) =>
      respond(res, 200, { gameId: 'nim', version: 'abc123', content: '# Nim rules' });
    routes['GET /api/games/nim/strategy'] = (req, res) =>
      respond(res, 404, { error: 'game_not_found' });
    const rules = await dispatchTool('get_rules', { gameId: 'nim' }, ctx);
    assert.equal(rules.version, 'abc123');
    assert.match(rules.content, /Nim rules/);
    const strat = await dispatchTool('get_strategy', { gameId: 'nim' }, ctx);
    assert.equal(strat.error, 'not_available');
  });

  test('list_games works unregistered (public endpoint)', async () => {
    const ctx = makeCtx({ registered: false });
    routes['GET /api/games'] = (req, res) =>
      respond(res, 200, [{ id: 'nim', name: 'Nim', description: 'd', tags: [] }]);
    const out = await dispatchTool('list_games', {}, ctx);
    assert.equal(out.games[0].id, 'nim');
  });

  test('replay_match bounds the tail and defaults to the last completed match', async () => {
    const ctx = makeCtx();
    ctx.store.updateCredentials({ lastCompletedMatch: { matchId: 'm-1', gameId: 'nim' } });
    const events = Array.from({ length: 500 }, (_, i) => ({
      sequence: i,
      eventType: 'action',
      payload: { i },
    }));
    routes['GET /api/matches/m-1/events'] = (req, res) => respond(res, 200, { events });
    const out = await dispatchTool('replay_match', {}, ctx);
    assert.equal(out.totalEvents, 500);
    assert.ok(out.returnedEvents <= 100);
    assert.equal(out.truncated, true);
    assert.ok(JSON.stringify(out.events).length <= 30_000);

    routes['GET /api/matches/m-1/events'] = (req, res) => respond(res, 403, { error: 'forbidden' });
    const active = await dispatchTool('replay_match', { matchId: 'm-1' }, ctx);
    assert.equal(active.error, 'match_still_active');
  });

  test('record_reflection enforces quota and keeps newest entries', async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 5; i++) {
      const out = await dispatchTool(
        'record_reflection',
        { gameId: 'nim', text: `lesson ${i}` },
        ctx,
      );
      assert.equal(out.ok, true, `reflection ${i} should save`);
    }
    const blocked = await dispatchTool(
      'record_reflection',
      { gameId: 'nim', text: 'one more' },
      ctx,
    );
    assert.equal(blocked.error, 'quota_exceeded');
    const notes = ctx.store.readNotes('nim');
    assert.match(notes, /lesson 4/);
    const tooLong = await dispatchTool(
      'record_reflection',
      { gameId: 'nim', text: 'x'.repeat(3000) },
      ctx,
    );
    assert.equal(tooLong.error, 'text_too_long');
  });
});

describe('secret hygiene', () => {
  test('no tool result ever contains the stored apiKey', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 0 });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        matchId: 'm-1',
        gameId: 'nim',
        gameType: 'sequential',
        status: 'your_turn',
        sequence: 1,
        view: {},
      });
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, { id: 'agent-1', name: 'TestBot', ratings: {}, reliability: {} });
    for (const call of [
      ['get_turn', {}],
      ['get_profile', {}],
    ]) {
      const out = await dispatchTool(call[0], call[1], ctx);
      assert.doesNotMatch(JSON.stringify(out), /k_test_secret_9999/, `${call[0]} leaked the key`);
    }
  });
});

// --- wake notifier ----------------------------------------------------------

describe('wake notifier', () => {
  async function withWebhookReceiver(fn) {
    const received = [];
    const hook = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
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

  test('match_found wake fires with bearer auth; queue state advances', async () => {
    await withWebhookReceiver(async (hookUrl, received) => {
      const ctx = makeCtx();
      ctx.cfg.wake = {
        url: hookUrl,
        authMode: 'bearer',
        secret: 'wake-secret',
        headerName: 'Authorization',
      };
      ctx.store.writePendingQueue({ gameId: 'nim', lane: 'standard' });
      routes['GET /api/matchmaking/status'] = (req, res) =>
        respond(res, 200, { status: 'matched', matchId: 'm-3' });
      // The notifier's next cycle long-polls the new match — keep it 'waiting'
      // so nothing gets cleared before the assertions run.
      routes['GET /api/matches/m-3/state'] = (req, res) =>
        respond(res, 200, {
          matchId: 'm-3',
          gameId: 'nim',
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
      const wake = received[0];
      assert.equal(wake.headers.authorization, 'Bearer wake-secret');
      const body = JSON.parse(wake.body);
      assert.equal(body.event, 'match_found');
      assert.equal(body.matchId, 'm-3');
      assert.match(body.message, /wait_for_turn/);
      assert.equal(ctx.store.readCurrentMatch().matchId, 'm-3');
      assert.equal(notifier.status.lastWakeEvent, 'match_found');
    });
  });

  test('your_turn wake signs the body with HMAC-SHA256 (Hermes contract) and dedupes', async () => {
    await withWebhookReceiver(async (hookUrl, received) => {
      const ctx = makeCtx();
      ctx.cfg.wake = {
        url: hookUrl,
        authMode: 'hmac-sha256',
        secret: 'route-secret',
        headerName: 'Authorization',
      };
      ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'nim', lastSequence: 0 });
      routes['GET /api/matches/m-1/state'] = (req, res) =>
        respond(res, 200, {
          matchId: 'm-1',
          gameId: 'nim',
          gameType: 'sequential',
          status: 'your_turn',
          sequence: 4,
          view: {},
          turnEndsAt: '2026-07-03T20:00:00.000Z',
        });
      const notifier = makeWakeNotifier(ctx);
      notifier.start();
      try {
        await waitUntil(() => received.length >= 1);
        // give it a beat — the dedupe window must suppress a second send
        await new Promise((r) => setTimeout(r, 300));
      } finally {
        await notifier.stop();
      }
      assert.equal(received.length, 1, 'dedupe window must allow exactly one wake per event');
      const wake = received[0];
      const expected = createHmac('sha256', 'route-secret').update(wake.body).digest('hex');
      assert.equal(wake.headers['x-webhook-signature'], expected);
      const body = JSON.parse(wake.body);
      assert.equal(body.event, 'your_turn');
      assert.equal(body.turnEndsAt, '2026-07-03T20:00:00.000Z');
      // The watcher must NOT advance the agent's own sequence cursor.
      assert.equal(ctx.store.readCurrentMatch().lastSequence, 0);
    });
  });

  test('header auth mode sends the secret in the named header (Moltis static_header)', async () => {
    await withWebhookReceiver(async (hookUrl, received) => {
      const ctx = makeCtx();
      ctx.cfg.wake = {
        url: hookUrl,
        authMode: 'header',
        secret: 'hdr-secret',
        headerName: 'X-Moltis-Key',
      };
      ctx.store.writePendingQueue({ gameId: 'nim', lane: 'standard' });
      routes['GET /api/matchmaking/status'] = (req, res) =>
        respond(res, 200, { status: 'matched', matchId: 'm-4' });
      routes['GET /api/matches/m-4/state'] = (req, res) =>
        respond(res, 200, {
          matchId: 'm-4',
          gameId: 'nim',
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
      assert.equal(received[0].headers['x-moltis-key'], 'hdr-secret');
      assert.equal(received[0].headers.authorization, undefined);
    });
  });

  test('stands down while a tool call is in flight; inert without config', async () => {
    await withWebhookReceiver(async (hookUrl, received) => {
      const ctx = makeCtx();
      ctx.cfg.wake = { url: hookUrl, authMode: 'bearer', secret: 's', headerName: 'Authorization' };
      ctx.activity.inFlight = 1;
      ctx.store.writePendingQueue({ gameId: 'nim', lane: 'standard' });
      routes['GET /api/matchmaking/status'] = (req, res) =>
        respond(res, 200, { status: 'matched', matchId: 'm-9' });
      const notifier = makeWakeNotifier(ctx);
      notifier.start();
      await new Promise((r) => setTimeout(r, 400));
      await notifier.stop();
      assert.equal(received.length, 0, 'must not watch while the agent is driving');

      const inert = makeWakeNotifier({ ...ctx, cfg: { ...ctx.cfg, wake: null } });
      inert.start(); // no-op
      await inert.stop();
      assert.equal(inert.status.configured, false);
    });
  });
});
