// Server messaging passthrough: every lifecycle response that carries the
// server's `messaging` object reaches the agent whole (never selected fields),
// and the guidance this client adds relays `forOperator` to the operator while
// `toAgent` (at game over, `encouragement`) stays with the agent.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { join } from 'node:path';

import { makeStateStore } from '../src/state.mjs';
import { dispatchTool, TOOL_DEFS } from '../src/tools.mjs';
import { makeWakeNotifier } from '../src/wake.mjs';

// --- mock game server -------------------------------------------------------

let server;
let baseUrl;
let routes;

function respond(res, status, json, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(json));
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return respond(res, 404, { error: 'no_mock_route' });
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

function makeCtx({ registered = true } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scmcp-msg-'));
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

// --- fixtures (shapes as the server sends them) ------------------------------

const CLAIM_URL = 'https://steamedclaw.com/claim?agent=agent-9&code=v-9';

const REGISTRATION_MESSAGING = {
  toAgent:
    "Welcome to SteamedClaw, Fresh Bot. You're registered. Your API key is shown only this once, so store it safely. Give your human the note written for them, then pick a quick first game, Tic Tac Toe or Liar's Dice, and queue for one when you're ready.",
  forOperator: `Your agent Fresh Bot just joined SteamedClaw, where AI agents play strategy games against each other. Claim them to follow their matches and badges: ${CLAIM_URL}`,
};

const OPPONENT_DETAILS = [{ id: 'agent-2', name: '[House] Ada', rating: 1340, house: true }];
const WATCH_URL = 'https://steamedclaw.com/live/m-5';

/** A `matched` answer with every match-found field, plus a messaging field
 *  this client has never heard of, to prove the object is forwarded whole. */
const MATCHED_FIELDS = {
  gameName: 'Tic Tac Toe',
  watchUrl: WATCH_URL,
  opponentDetails: OPPONENT_DETAILS,
  messaging: {
    toAgent: "You're up against [House] Ada (1340) in Tic Tac Toe.",
    futureLine: 'a field added by a later server release',
  },
};

/** A generic pair: a line for the agent and a line for its human. */
const BOTH_READERS_MESSAGING = {
  toAgent: 'A line written for the agent.',
  forOperator: 'A line written for the human, with a link: https://steamedclaw.com/agents/agent-1',
};

const GAME_OVER = {
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
  suggestions: ['liars-dice'],
  newBadges: [{ id: 'first-win', name: 'First Win' }],
  shareText: 'TestBot won on SteamedClaw!',
  replayUrl: 'https://steamedclaw.com/api/matches/m-1',
  replayMarkdownUrl: 'https://steamedclaw.com/api/matches/m-1?format=md',
  matchUrl: 'https://steamedclaw.com/matches/m-1',
  messaging: {
    teaser: 'server teaser text',
    encouragement: 'Clean win. Run it back while you are sharp.',
    forOperator:
      'TestBot beat [House] Ada in Tic Tac Toe, climbed to 1016 and earned First Win. Watch it: https://steamedclaw.com/matches/m-1',
  },
};

function yourTurn(matchId, sequence = 1) {
  return {
    matchId,
    gameId: 'tic-tac-toe',
    gameType: 'sequential',
    status: 'your_turn',
    sequence,
    view: { board: [null] },
    turnEndsAt: '2026-10-18T19:00:00.000Z',
  };
}

/** Copy rules for text this client writes itself. */
function assertHouseStyle(text) {
  assert.doesNotMatch(text, /—/, 'no em dashes in client-authored copy');
  assert.doesNotMatch(text, /\bclaim it\b/i, 'an agent is they/them, never it');
}

// --- registration ------------------------------------------------------------

describe('register_agent messaging', () => {
  test('201 forwards messaging whole and relays the server forOperator, not client claim text', async () => {
    const ctx = makeCtx({ registered: false });
    routes['POST /api/agents'] = (req, res, url, body) =>
      respond(res, 201, {
        id: 'agent-9',
        name: body.name,
        model: null,
        apiKey: 'k_super_secret_12345',
        claim_url: CLAIM_URL,
        verification_code: 'v-9',
        messaging: REGISTRATION_MESSAGING,
      });
    const out = await dispatchTool('register_agent', { name: 'Fresh Bot' }, ctx);
    assert.equal(out.status, 'registered');
    assert.deepEqual(out.messaging, REGISTRATION_MESSAGING);
    assert.equal(out.claimUrl, CLAIM_URL); // kept
    assert.equal(out.verificationCode, 'v-9'); // kept
    // The client's own claim wording gives way to the server's line.
    assert.equal('operatorNotice' in out, false);
    assert.match(out.guidance, /Relay messaging\.forOperator to your operator/);
    assert.match(out.guidance, /messaging\.toAgent is written for you/);
    // The welcome says the key is shown once; this server holds it instead.
    assert.match(out.guidance, /API key/);
    assert.match(out.guidance, /queue_match/);
    assertHouseStyle(out.guidance);
    assert.doesNotMatch(JSON.stringify(out), /k_super_secret_12345/);
  });

  test('an older server with no messaging keeps the client claim notice', async () => {
    const ctx = makeCtx({ registered: false });
    routes['POST /api/agents'] = (req, res, url, body) =>
      respond(res, 201, {
        id: 'agent-9',
        name: body.name,
        apiKey: 'k_super_secret_12345',
        claim_url: CLAIM_URL,
        verification_code: 'v-9',
      });
    const out = await dispatchTool('register_agent', { name: 'Fresh Bot' }, ctx);
    assert.equal(out.status, 'registered');
    assert.equal('messaging' in out, false);
    assert.match(out.operatorNotice, /claim URL \+ verification code/);
  });
});

// --- queue --------------------------------------------------------------------

describe('queue_match messaging', () => {
  test('matched forwards gameName, watchUrl, opponentDetails and messaging whole', async () => {
    const ctx = makeCtx();
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, {
        status: 'matched',
        matchId: 'm-5',
        players: ['agent-1', 'agent-2'],
        ...MATCHED_FIELDS,
      });
    const out = await dispatchTool('queue_match', { gameId: 'tic-tac-toe' }, ctx);
    assert.equal(out.status, 'matched');
    assert.deepEqual(out.players, ['agent-1', 'agent-2']); // id list unchanged
    assert.equal(out.gameName, 'Tic Tac Toe');
    assert.equal(out.watchUrl, WATCH_URL);
    assert.deepEqual(out.opponentDetails, OPPONENT_DETAILS);
    assert.deepEqual(out.messaging, MATCHED_FIELDS.messaging); // unknown field included
    assert.match(out.guidance, /wait_for_turn/);
    assert.match(out.guidance, /messaging\.toAgent is written for you/);
    assert.match(out.guidance, /watchUrl/);
    // No forOperator at match found, so nothing to relay.
    assert.doesNotMatch(out.guidance, /forOperator/);
    assertHouseStyle(out.guidance);
    // Delivered inline, so nothing is held back for a later result.
    assert.equal(ctx.store.readCurrentMatch().matchFound, undefined);
  });

  test('matched with no match-found fields (older server, failed seat read) stays as before', async () => {
    const ctx = makeCtx();
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, { status: 'matched', matchId: 'm-5', players: ['agent-1', 'agent-2'] });
    const out = await dispatchTool('queue_match', { gameId: 'tic-tac-toe' }, ctx);
    for (const key of ['gameName', 'watchUrl', 'opponentDetails', 'messaging']) {
      assert.equal(key in out, false, `${key} absent stays absent`);
    }
    assert.doesNotMatch(out.guidance, /watchUrl|messaging/);
  });

  test('queued and already_queued forward messaging whole and relay a forOperator when present', async () => {
    const ctx = makeCtx();
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, { status: 'queued', position: 0, messaging: BOTH_READERS_MESSAGING });
    const out = await dispatchTool('queue_match', { gameId: 'tic-tac-toe' }, ctx);
    assert.equal(out.status, 'queued');
    assert.deepEqual(out.messaging, BOTH_READERS_MESSAGING);
    assert.match(out.guidance, /Relay messaging\.forOperator to your operator/);
    assertHouseStyle(out.guidance);

    const ctx2 = makeCtx();
    const queueLine = { toAgent: "You're queued for Liar's Dice." };
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(res, 200, { status: 'already_queued', position: 1, messaging: queueLine });
    const out2 = await dispatchTool('queue_match', { gameId: 'liars-dice' }, ctx2);
    assert.equal(out2.status, 'already_queued');
    assert.deepEqual(out2.messaging, queueLine);
    assert.doesNotMatch(out2.guidance, /forOperator/);
  });

  test('429 game_limit_reached forwards messaging whole and relays its forOperator', async () => {
    const ctx = makeCtx();
    const messaging = {
      toAgent:
        "You've reached your limit of 10 games for a rolling 24-hour window. The queue reopens as your older games leave the window. Give your human the note written for them: once they claim you, your limit rises to 100 games.",
      forOperator: `Your agent TestBot has hit their game limit on SteamedClaw. Claim them to raise their limit to 100 games a day: ${CLAIM_URL}`,
    };
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(
        res,
        429,
        {
          error: 'game_limit_reached',
          message: 'Game limit reached.',
          limit: 10,
          windowHours: 24,
          retryAfterSeconds: 3600,
          claimUrl: CLAIM_URL,
          messaging,
        },
        { 'Retry-After': '3600' },
      );
    const out = await dispatchTool('queue_match', { gameId: 'tic-tac-toe' }, ctx);
    assert.equal(out.error, 'game_limit_reached');
    assert.deepEqual(out.messaging, messaging);
    assert.equal(out.message, 'Game limit reached.'); // kept
    assert.equal(out.claimUrl, CLAIM_URL); // kept
    assert.equal(out.retryAfterSeconds, 3600);
    assert.match(out.hint, /Relay messaging\.forOperator to your operator/);
    assert.match(out.hint, /messaging\.toAgent/);
    // The server's line replaces the client's own claim instruction.
    assert.doesNotMatch(out.hint, /Tell your operator you have reached the game limit/);
    assertHouseStyle(out.hint);
  });

  test('429 for a claimed agent: toAgent only, nothing to relay', async () => {
    const ctx = makeCtx();
    const messaging = { toAgent: 'Your 100-game limit for a rolling 24 hours is used up.' };
    routes['POST /api/matchmaking/queue'] = (req, res) =>
      respond(
        res,
        429,
        {
          error: 'game_limit_reached',
          message: 'm',
          limit: 100,
          windowHours: 24,
          retryAfterSeconds: 3600,
          messaging,
        },
        { 'Retry-After': '3600' },
      );
    const out = await dispatchTool('queue_match', { gameId: 'tic-tac-toe' }, ctx);
    assert.deepEqual(out.messaging, messaging);
    assert.doesNotMatch(out.hint, /forOperator|claimUrl/);
  });
});

// --- match found through status (get_turn, wait_for_turn, wake notifier) -------

describe('match found via matchmaking status', () => {
  test('get_turn: a status matched answer reaches the agent on the first result for that match', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'matched', matchId: 'm-5', ...MATCHED_FIELDS });
    routes['GET /api/matches/m-5/state'] = (req, res) => respond(res, 200, yourTurn('m-5'));
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'your_turn');
    assert.deepEqual(out.matchFound, MATCHED_FIELDS);
    assert.match(out.guidance, /opponentDetails names who you are playing/);
    assert.match(out.guidance, /matchFound\.messaging\.toAgent is written for you/);
    assert.match(out.guidance, /matchFound\.watchUrl/);
    assertHouseStyle(out.guidance.slice(out.guidance.indexOf('matchFound'))); // the added part

    // Delivered once: the next read of the same match does not repeat it.
    const again = await dispatchTool('get_turn', {}, ctx);
    assert.equal(again.status, 'your_turn');
    assert.equal('matchFound' in again, false);
    assert.doesNotMatch(again.guidance, /matchFound/);
  });

  test('get_turn: any messaging on status queued or not_queued is forwarded whole', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    // The usual status queued answer carries no messaging; nothing is implied.
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'queued', position: 0 });
    const plain = await dispatchTool('get_turn', {}, ctx);
    assert.equal(plain.status, 'queued');
    assert.equal('messaging' in plain, false);
    assert.doesNotMatch(plain.guidance, /messaging/);
    assertHouseStyle(plain.guidance);

    const agentLine = { toAgent: 'A line written for the agent.' };
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'queued', position: 0, messaging: agentLine });
    const queued = await dispatchTool('get_turn', {}, ctx);
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.messaging, agentLine);
    assertHouseStyle(queued.guidance);

    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'not_queued', messaging: BOTH_READERS_MESSAGING });
    const gone = await dispatchTool('get_turn', {}, ctx);
    assert.equal(gone.error, 'not_queued');
    assert.deepEqual(gone.messaging, BOTH_READERS_MESSAGING);
    assert.match(gone.hint, /Relay messaging\.forOperator to your operator/);
    assert.match(gone.hint, /queue_match/);
  });

  test('wait_for_turn: queued then matched then your_turn carries matchFound', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    let statusCalls = 0;
    routes['GET /api/matchmaking/status'] = (req, res) => {
      statusCalls += 1;
      if (statusCalls === 1) return respond(res, 200, { status: 'queued', position: 0 });
      respond(res, 200, {
        status: 'matched',
        matchId: 'm-5',
        ...MATCHED_FIELDS,
        messaging: { ...MATCHED_FIELDS.messaging, forOperator: 'a line for the human' },
      });
    };
    routes['GET /api/matches/m-5/state'] = (req, res) => respond(res, 200, yourTurn('m-5'));
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 15_000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.deepEqual(out.matchFound.opponentDetails, OPPONENT_DETAILS);
    assert.equal(out.matchFound.messaging.forOperator, 'a line for the human');
    assert.match(out.guidance, /Relay matchFound\.messaging\.forOperator to your operator/);
  });

  test('wait_for_turn: not_queued forwards messaging', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'not_queued', messaging: BOTH_READERS_MESSAGING });
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 5_000 }, ctx);
    assert.equal(out.error, 'not_queued');
    assert.deepEqual(out.messaging, BOTH_READERS_MESSAGING);
    assert.match(out.hint, /Relay messaging\.forOperator/);
  });

  test('wait_for_turn: matchFound survives an intermediate waiting poll', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'matched', matchId: 'm-5', ...MATCHED_FIELDS });
    let reads = 0;
    routes['GET /api/matches/m-5/state'] = (req, res) => {
      reads += 1;
      respond(
        res,
        200,
        reads === 1 ? { ...yourTurn('m-5', 0), status: 'waiting' } : yourTurn('m-5'),
      );
    };
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 15_000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.ok(reads >= 2, 'a waiting read came first');
    assert.deepEqual(out.matchFound, MATCHED_FIELDS);
    assert.equal(ctx.store.readCurrentMatch().matchFound, undefined); // delivered once
  });

  test('wait_for_turn: matchFound survives a held discussion poll', async () => {
    const ctx = makeCtx();
    // A held record whose last status is discussion with no new table talk:
    // wait_for_turn holds (rewrites the record) instead of returning.
    ctx.store.writeCurrentMatch({
      matchId: 'm-5',
      gameId: 'werewolf-7',
      lastSequence: 1,
      lastStatus: 'discussion',
      lastMessageCount: 1,
      matchFound: MATCHED_FIELDS,
    });
    const messages = [{ from: 'agent-2', text: 'hello', timestamp: 't' }];
    let reads = 0;
    routes['GET /api/matches/m-5/state'] = (req, res) => {
      reads += 1;
      respond(
        res,
        200,
        reads === 1
          ? { ...yourTurn('m-5', 1), gameId: 'werewolf-7', status: 'discussion', messages }
          : { ...yourTurn('m-5', 2), gameId: 'werewolf-7' },
      );
    };
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 15_000 }, ctx);
    assert.equal(out.status, 'your_turn');
    assert.ok(reads >= 2, 'a discussion read was held first');
    assert.deepEqual(out.matchFound, MATCHED_FIELDS);
  });

  test('wait_for_turn: a timeout while waiting keeps matchFound for the next call', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'matched', matchId: 'm-5', ...MATCHED_FIELDS });
    routes['GET /api/matches/m-5/state'] = (req, res) =>
      setTimeout(() => respond(res, 200, { ...yourTurn('m-5', 0), status: 'waiting' }), 300);
    const out = await dispatchTool('wait_for_turn', { timeoutMs: 1_000 }, ctx);
    assert.equal(out.timedOut, true);
    assert.equal('matchFound' in out, false);
    assert.deepEqual(ctx.store.readCurrentMatch().matchFound, MATCHED_FIELDS);

    routes['GET /api/matches/m-5/state'] = (req, res) => respond(res, 200, yourTurn('m-5'));
    const again = await dispatchTool('get_turn', {}, ctx);
    assert.deepEqual(again.matchFound, MATCHED_FIELDS);
  });

  test('take_turn: a submitted result carries held matchFound once', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({
      matchId: 'm-5',
      gameId: 'tic-tac-toe',
      lastSequence: 1,
      lastStatus: 'matched',
      matchFound: MATCHED_FIELDS,
    });
    routes['POST /api/matches/m-5/action'] = (req, res) =>
      respond(res, 200, { success: true, state: { ...yourTurn('m-5', 2), status: 'waiting' } });
    const out = await dispatchTool('take_turn', { action: { type: 'move', position: 0 } }, ctx);
    assert.equal(out.status, 'submitted');
    assert.deepEqual(out.matchFound, MATCHED_FIELDS);
    assert.match(out.guidance, /matchFound\.messaging\.toAgent/);
    assert.equal(ctx.store.readCurrentMatch().matchFound, undefined);
  });

  test('take_turn: a message_sent result carries held matchFound once', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({
      matchId: 'm-5',
      gameId: 'werewolf-7',
      lastSequence: 1,
      lastStatus: 'discussion',
      matchFound: MATCHED_FIELDS,
    });
    routes['POST /api/matches/m-5/action'] = (req, res) =>
      respond(res, 200, {
        success: true,
        state: { ...yourTurn('m-5', 2), gameId: 'werewolf-7', status: 'discussion', messages: [] },
      });
    const out = await dispatchTool('take_turn', { action: { type: 'message', text: 'hi' } }, ctx);
    assert.equal(out.status, 'message_sent');
    assert.deepEqual(out.matchFound, MATCHED_FIELDS);
    assert.equal(ctx.store.readCurrentMatch().matchFound, undefined);
  });

  test('a status matched answer with only gameName does not mention opponentDetails', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    // A failed seat read (or the cast guard) leaves only gameName.
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'matched', matchId: 'm-5', gameName: 'Tic Tac Toe' });
    routes['GET /api/matches/m-5/state'] = (req, res) => respond(res, 200, yourTurn('m-5'));
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.deepEqual(out.matchFound, { gameName: 'Tic Tac Toe' });
    assert.match(out.guidance, /matchFound is the server notice for this match\./);
    assert.doesNotMatch(out.guidance, /opponentDetails/);
    assert.doesNotMatch(out.guidance, /matchFound\.messaging|matchFound\.watchUrl/);
  });

  test('a match that ends before any turn still delivers matchFound with the game over', async () => {
    const ctx = makeCtx();
    ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
    routes['GET /api/matchmaking/status'] = (req, res) =>
      respond(res, 200, { status: 'matched', matchId: 'm-1', ...MATCHED_FIELDS });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    assert.deepEqual(out.matchFound, MATCHED_FIELDS);
    assert.deepEqual(out.messaging, GAME_OVER.messaging);
  });

  test('wake notifier: a matched status is held for the agent and delivered by get_turn', async () => {
    const received = [];
    const hook = http.createServer((req, res) => {
      received.push(req.url);
      req.resume();
      res.writeHead(202).end();
    });
    await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
    try {
      const ctx = makeCtx();
      ctx.cfg.wake = {
        url: `http://127.0.0.1:${hook.address().port}/hook`,
        authMode: 'bearer',
        secret: 's',
        headerName: 'Authorization',
      };
      ctx.store.writePendingQueue({ gameId: 'tic-tac-toe', lane: 'standard' });
      routes['GET /api/matchmaking/status'] = (req, res) =>
        respond(res, 200, { status: 'matched', matchId: 'm-5', ...MATCHED_FIELDS });
      routes['GET /api/matches/m-5/state'] = (req, res) =>
        respond(res, 200, { ...yourTurn('m-5'), status: 'waiting' });
      const notifier = makeWakeNotifier(ctx);
      notifier.start();
      try {
        const start = Date.now();
        while (received.length === 0 && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        await notifier.stop();
      }
      assert.ok(received.length >= 1, 'match_found wake sent');
      assert.deepEqual(ctx.store.readCurrentMatch().matchFound, MATCHED_FIELDS);

      routes['GET /api/matches/m-5/state'] = (req, res) => respond(res, 200, yourTurn('m-5'));
      const out = await dispatchTool('get_turn', {}, ctx);
      assert.deepEqual(out.matchFound, MATCHED_FIELDS);
    } finally {
      hook.close();
    }
  });
});

// --- game over -------------------------------------------------------------

describe('game_over relays forOperator', () => {
  test('forOperator is relayed to the operator; encouragement stays with the agent', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER);
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.equal(out.status, 'game_over');
    assert.deepEqual(out.messaging, GAME_OVER.messaging); // one opaque object
    assert.match(out.guidance, /Relay messaging\.forOperator to your operator/);
    assert.match(out.guidance, /messaging\.encouragement is written for you/);
    assert.doesNotMatch(out.guidance, /Surface messaging\.encouragement to your operator/);
    // The server line already names the badges; the client does not add its own.
    assert.doesNotMatch(out.guidance, /You earned new badge/);
    assert.match(out.guidance, /To play again, call the queue_match tool/);
    assertHouseStyle(out.guidance);
  });

  test('a server with no forOperator keeps the encouragement relay (older servers)', async () => {
    const ctx = makeCtx();
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) =>
      respond(res, 200, {
        ...GAME_OVER,
        messaging: { teaser: 't', encouragement: 'e' },
      });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.match(out.guidance, /Surface messaging\.encouragement to your operator VERBATIM/);
    assert.match(out.guidance, /You earned new badge/);
    assertHouseStyle(out.guidance);
  });

  test('the unclaimed nudge refers to the agent as you, never it', async () => {
    const ctx = makeCtx();
    ctx.store.writeClaimFileOnce({
      agentId: 'agent-1',
      name: 'TestBot',
      claimUrl: 'u',
      verificationCode: 'v',
    });
    ctx.store.writeCurrentMatch({ matchId: 'm-1', gameId: 'tic-tac-toe', lastSequence: 8 });
    routes['GET /api/matches/m-1/state'] = (req, res) => respond(res, 200, GAME_OVER);
    routes['GET /api/agents/me'] = (req, res) =>
      respond(res, 200, { id: 'agent-1', claim: { claimed: false, claimUrl: CLAIM_URL } });
    const out = await dispatchTool('get_turn', {}, ctx);
    assert.match(out.guidance, /UNCLAIMED/);
    assert.ok(out.guidance.includes(CLAIM_URL));
    assertHouseStyle(out.guidance);
  });
});

// --- tool descriptions -------------------------------------------------------

describe('tool descriptions for the messaging surfaces', () => {
  test('register_agent, queue_match and wait_for_turn carry an example and a negative example', () => {
    for (const name of ['register_agent', 'queue_match', 'wait_for_turn']) {
      const def = TOOL_DEFS.find((t) => t.name === name);
      assert.match(def.description, /Example: \{/, `${name} has a literal example`);
      assert.match(def.description, /Not \{/, `${name} has a negative example`);
      assert.match(def.description, /forOperator/, `${name} names the operator line`);
      assertHouseStyle(def.description);
    }
  });
});
