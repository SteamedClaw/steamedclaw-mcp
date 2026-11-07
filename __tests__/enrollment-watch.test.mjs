import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { makeStateStore } from '../src/state.mjs';
import { dispatchTool } from '../src/tools.mjs';
import { makeWakeNotifier } from '../src/wake.mjs';
import { refreshEnrollmentWatches, consumeEnrollmentAssignment } from '../src/enrollment-watch.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
// The entry record (route-schemas.ts tournamentEntryResponseSchema).
const ENTRY = {
  entryId: 'entry-1',
  tournamentId: ID,
  agentId: 'self',
  ownerId: 'owner-1',
  socialHandle: null,
  enteredAt: '2026-11-06T10:00:00.000Z',
  withdrawnAt: null,
  rulesVersionAccepted: 'v1',
  rulesContentHashAccepted: 'hash-1',
};
const WITH_ENTRY = new Set(['entered', 'withdrawn', 'forfeited', 'eliminated']);
/** One agent's standing (tournamentEntryStatusResponseSchema). */
function statusBody(status, { position = 2, waitlistLength = 3 } = {}) {
  const waiting = status === 'waitlisted';
  return {
    tournamentId: ID,
    agentId: 'self',
    status,
    position: waiting ? position : null,
    waitlistLength: waiting ? waitlistLength : null,
    entry: WITH_ENTRY.has(status)
      ? {
          ...ENTRY,
          withdrawnAt: ['withdrawn', 'forfeited'].includes(status)
            ? '2026-11-06T11:00:00.000Z'
            : null,
        }
      : null,
    eliminatedStage: status === 'eliminated' ? 'pool' : null,
    messaging: { toAgent: `Agent text for ${status}.`, forOperator: `Owner text for ${status}.` },
  };
}
const ARGS = {
  tournamentId: ID,
  single_entry_attestation: true,
  age_18_plus: true,
  rules_version_accepted: 'v1',
};

function fixture(t) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scmcp-enrollment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = {
    // /me status; the 201 of /enter answers enterStatus.
    me: 'entered',
    enterStatus: 'entered',
    // /my-schedule eliminated ({stage, at}) or null.
    eliminated: null,
    withdraw: { status: 204, json: null },
    status: 'registration',
    assigned: false,
    fail: false,
    format: 'pool-bracket',
    calls: [],
    wakes: [],
  };
  function restart() {
    const ctx = {
      cfg: {
        baseUrl: 'http://localhost:3210',
        stateDir: dir,
        wake: { url: 'http://localhost:3211/wake', authMode: 'bearer', secret: 'test' },
      },
      store: makeStateStore(dir),
      health: { lastError: null },
      activity: { inFlight: 0 },
      fetchImpl: async (input, options) => {
        const url = new URL(input);
        const path = url.pathname;
        state.calls.push(path);
        const res = (json, status = 200) =>
          new Response(status === 204 ? null : JSON.stringify(json), { status });
        if (path === '/wake') {
          state.wakes.push(JSON.parse(options.body));
          return res({}, 202);
        }
        if (path === '/api/tournaments') {
          if (state.fail) return res({ error: 'unavailable' }, 503);
          return res({
            tournaments: [{ id: ID, gameId: 'nim', format: state.format, status: state.status }],
          });
        }
        if (path === `/api/tournaments/${ID}/enter`) {
          state.me = state.enterStatus;
          return res(statusBody(state.enterStatus), 201);
        }
        if (path === `/api/tournaments/${ID}/withdraw`) {
          // Leaving the waitlist also reads withdrawn.
          if (state.withdraw.status === 204) state.me = 'withdrawn';
          return res(state.withdraw.json, state.withdraw.status);
        }
        if (path === `/api/tournaments/${ID}/me`) {
          if (state.meResponse) return res(state.meResponse.json, state.meResponse.status);
          return res(statusBody(state.me));
        }
        if (path === `/api/tournaments/${ID}/my-schedule`) {
          // tournamentMyScheduleRouteSchema; no series once out.
          const out = ['withdrawn', 'forfeited'].includes(state.me) || state.eliminated !== null;
          return res({
            tournamentId: ID,
            tournamentStatus: state.status,
            entered: WITH_ENTRY.has(state.me),
            withdrawn: ['withdrawn', 'forfeited'].includes(state.me),
            waitlisted: state.me === 'waitlisted',
            waitlistPosition: state.me === 'waitlisted' ? 2 : null,
            eliminated: state.eliminated,
            pool: null,
            current:
              state.assigned && !out
                ? {
                    stage: 'pool',
                    roundNumber: 1,
                    windowOpensAt: '2026-11-06T10:00:00.000Z',
                    windowClosesAt: '2026-11-06T12:00:00.000Z',
                    seriesId: 'series-1',
                    bye: false,
                    opponentAgentId: 'other',
                    opponentAgentName: 'Other',
                    bestOfN: 1,
                    myGameWins: 0,
                    opponentGameWins: 0,
                    outcome: null,
                    matchIds: ['first'],
                  }
                : null,
            next: null,
            nextPlanned: null,
            schedule: `/api/tournaments/${ID}/schedule`,
          });
        }
        if (path === '/api/agents/self/matches')
          return res({
            matches: state.assigned
              ? [
                  {
                    id: 'first',
                    gameId: 'nim',
                    status: state.over ? 'completed' : 'active',
                    finishedAt: state.over ? new Date().toISOString() : null,
                    createdAt: new Date().toISOString(),
                  },
                ]
              : [],
          });
        if (path === '/api/matches/first/state')
          return res({
            matchId: 'first',
            gameId: 'nim',
            sequence: 1,
            status: state.over ? 'game_over' : 'your_turn',
            ...(state.over ? { nextGameAssigned: false } : {}),
            view: {},
          });
        if (path === '/api/matches/normal/state')
          return res({
            matchId: 'normal',
            gameId: 'chess',
            sequence: 1,
            status: 'your_turn',
            view: {},
          });
        if (path === '/api/matchmaking/queue') return res({ status: 'queued' });
        if (path === '/api/matchmaking/status')
          return res(
            state.queueWaiting ? { status: 'queued' } : { status: 'matched', matchId: 'normal' },
          );
        return res({ error: 'not_found' }, 404);
      },
    };
    if (!ctx.store.readCredentials())
      ctx.store.writeCredentials({ server: ctx.cfg.baseUrl, agentId: 'self', apiKey: 'test-key' });
    return ctx;
  }
  return { state, restart, ctx: restart() };
}

async function until(fn, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('MCP enrollment persists a first-assignment watch and wait returns tournament guidance', async (t) => {
  const { ctx, restart } = fixture(t);
  const entered = await dispatchTool('enter_tournament', ARGS, ctx);
  assert.equal(entered.ok, true);
  assert.deepEqual(entered.entry, statusBody('entered'));
  assert.match(
    entered.hint,
    /^Entered: entry\.status is entered\. A persistent first-assignment watch is saved/,
  );
  assert.deepEqual(restart().store.readEnrollmentWatches(), [
    { tournamentId: ID, entryId: ENTRY.entryId, matchIds: [] },
  ]);
  assert.equal(ctx.store.readTournamentRun(), null);
  const result = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, ctx);
  assert.equal(result.status, 'awaiting_first_game');
  assert.equal(result.timedOut, true);
  assert.doesNotMatch(result.hint, /Call queue_match first/);
  assert.match(result.hint, /tournament/i);
  assert.match((await dispatchTool('get_turn', {}, ctx)).hint, /tournament/i);
});

test('portal enrollment is discovered and one wait call spans a delayed first assignment', async (t) => {
  const { ctx, state } = fixture(t);
  const waiting = dispatchTool('wait_for_turn', { timeoutMs: 8000 }, ctx);
  await until(() => state.calls.includes(`/api/tournaments/${ID}/my-schedule`));
  state.assigned = true;
  const result = await waiting;
  assert.equal(result.status, 'your_turn');
  assert.equal(result.matchId, 'first');
  assert.equal(ctx.store.readEnrollmentWatches()[0].assignedMatchId, 'first');
  assert.ok(!state.calls.includes('/api/matchmaking/queue'));
});

for (const saved of [false, true]) {
  test(`wake detects first assignment after restart (${saved ? 'persisted MCP watch' : 'portal entry with no watch'})`, async (t) => {
    const { ctx, state, restart } = fixture(t);
    if (saved) await dispatchTool('enter_tournament', ARGS, ctx);
    state.assigned = true;
    const recovered = restart();
    const notifier = makeWakeNotifier(recovered);
    notifier.start();
    try {
      await until(() => state.wakes.length > 0);
    } finally {
      await notifier.stop();
    }
    assert.equal(state.wakes[0].event, 'match_found');
    assert.equal(state.wakes[0].matchId, 'first');
    assert.equal(recovered.store.readCurrentMatch().matchId, 'first');
  });
}

// Each /me status that ends a run, a schedule elimination, and the
// tournament itself ending. closed_out is reached from the waitlist.
for (const ending of [
  'cancelled',
  'completed',
  'withdrawn',
  'forfeited',
  'eliminated',
  'closed_out',
  'not_entered',
  'schedule-eliminated',
]) {
  test(`${ending} stops first-assignment waiting`, async (t) => {
    const { ctx, state, restart } = fixture(t);
    if (ending === 'closed_out') state.enterStatus = 'waitlisted';
    await dispatchTool('enter_tournament', ARGS, ctx);
    assert.equal(ctx.store.readEnrollmentWatches().length, 1);
    if (['cancelled', 'completed'].includes(ending)) state.status = ending;
    else if (ending === 'schedule-eliminated')
      state.eliminated = { stage: 'pool', at: '2026-11-06T11:00:00.000Z' };
    else state.me = ending;
    const recovered = restart();
    const result = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, recovered);
    assert.equal(result.error, 'no_active_match');
    assert.deepEqual(recovered.store.readEnrollmentWatches(), []);
  });
}

test('a full field waitlists: the watch is saved unarmed, and a later entered read arms it', async (t) => {
  const { ctx, state, restart } = fixture(t);
  state.enterStatus = 'waitlisted';
  const entered = await dispatchTool('enter_tournament', ARGS, ctx);
  assert.equal(entered.ok, true);
  assert.equal(entered.entry.status, 'waitlisted');
  assert.deepEqual(entered.entry.messaging, statusBody('waitlisted').messaging);
  assert.match(entered.hint, /^Waitlisted: entry\.status is waitlisted at position 2 of 3\./);
  assert.match(entered.hint, /not an error/);
  assert.doesNotMatch(entered.hint, /Enrolled|Entered:/);
  assert.deepEqual(restart().store.readEnrollmentWatches(), [
    { tournamentId: ID, entryId: null, matchIds: [] },
  ]);
  // Unarmed: no first-assignment wait, normal idle.
  const idle = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, ctx);
  assert.equal(idle.error, 'no_active_match');
  assert.equal(ctx.store.readEnrollmentWatches()[0].entryId, null);
  assert.ok(!state.calls.includes(`/api/tournaments/${ID}/my-schedule`));

  state.me = 'entered';
  const waiting = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, ctx);
  assert.equal(waiting.status, 'awaiting_first_game');
  assert.equal(ctx.store.readEnrollmentWatches()[0].entryId, ENTRY.entryId);
  state.assigned = true;
  const turn = await dispatchTool('wait_for_turn', { timeoutMs: 8000 }, ctx);
  assert.equal(turn.status, 'your_turn');
  assert.equal(turn.matchId, 'first');
});

test('a portal waitlist place is discovered and the wake notifier sees the promotion after restart', async (t) => {
  const { ctx, state, restart } = fixture(t);
  state.me = 'waitlisted';
  await refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), { force: true });
  assert.deepEqual(ctx.store.readEnrollmentWatches(), [
    { tournamentId: ID, entryId: null, gameId: 'nim', matchIds: [] },
  ]);
  state.me = 'entered';
  state.assigned = true;
  // A waitlist place is scanned on the idle cadence; a restarted process
  // scans at once.
  const notifier = makeWakeNotifier(restart());
  notifier.start();
  try {
    await until(() => state.wakes.length > 0, 8000);
  } finally {
    await notifier.stop();
  }
  assert.equal(state.wakes[0].matchId, 'first');
});

test('/me answers that are not 200 are transient; entry_not_found is not looked for', async (t) => {
  const { ctx, state } = fixture(t);
  await dispatchTool('enter_tournament', ARGS, ctx);
  for (const meResponse of [
    { status: 404, json: { error: 'entry_not_found' } },
    { status: 404, json: { error: 'agent_not_found' } },
    { status: 503, json: { error: 'unavailable' } },
    // An unknown status is not evidence either.
    { status: 200, json: { ...statusBody('entered'), status: 'paused' } },
  ]) {
    state.meResponse = meResponse;
    await refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), { force: true });
    assert.equal(ctx.store.readEnrollmentWatches()[0]?.entryId, ENTRY.entryId);
  }
});

test('withdraw_tournament drops the watch and returns the standing read after the 204', async (t) => {
  for (const enterStatus of ['entered', 'waitlisted']) {
    const { ctx, state } = fixture(t);
    state.enterStatus = enterStatus;
    await dispatchTool('enter_tournament', ARGS, ctx);
    assert.equal(ctx.store.readEnrollmentWatches().length, 1);
    const result = await dispatchTool('withdraw_tournament', { tournamentId: ID }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.withdrawn, true);
    assert.deepEqual(result.entry, statusBody('withdrawn'));
    assert.deepEqual(ctx.store.readEnrollmentWatches(), []);
    const posts = state.calls.filter((path) => path.endsWith('/withdraw'));
    assert.deepEqual(posts, [`/api/tournaments/${ID}/withdraw`]);
    assert.equal(state.calls.at(-1), `/api/tournaments/${ID}/me`);
  }
});

test('withdraw_tournament mid-run re-verifies the run record, so hints stop saying it continues', async (t) => {
  const { ctx, state } = fixture(t);
  await dispatchTool('enter_tournament', ARGS, ctx);
  // The last game's game-over no longer reports nextGameAssigned.
  state.assigned = true;
  state.over = true;
  ctx.store.writeTournamentRun({ sinceMatchId: 'first', gameId: 'nim' });
  const result = await dispatchTool('withdraw_tournament', { tournamentId: ID }, ctx);
  assert.equal(result.ok, true);
  assert.equal(ctx.store.readTournamentRun(), null);
});

test('withdraw_tournament reports the withdrawal when the follow-up read fails', async (t) => {
  const { ctx, state } = fixture(t);
  await dispatchTool('enter_tournament', ARGS, ctx);
  state.meResponse = { status: 503, json: { error: 'unavailable' } };
  const result = await dispatchTool('withdraw_tournament', { tournamentId: ID }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.withdrawn, true);
  assert.equal(result.entry, undefined);
  assert.match(result.hint, /get_tournament_entry/);
  assert.deepEqual(ctx.store.readEnrollmentWatches(), []);
});

test('a refused withdrawal relays the code and message and keeps the watch', async (t) => {
  for (const [status, json] of [
    [403, { error: 'prize_withdraw_owner_only', message: 'Withdraw at /tournaments/12/enter' }],
    [403, { error: 'tournament_withdrawal_closed' }],
    [404, { error: 'entry_not_found' }],
  ]) {
    const { ctx, state } = fixture(t);
    await dispatchTool('enter_tournament', ARGS, ctx);
    state.withdraw = { status, json };
    const result = await dispatchTool('withdraw_tournament', { tournamentId: ID }, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.error, json.error);
    assert.deepEqual(result.details, json);
    assert.equal(ctx.store.readEnrollmentWatches().length, 1);
  }
});

test('temporary discovery failure keeps a saved watch through restart', async (t) => {
  const { ctx, state, restart } = fixture(t);
  await dispatchTool('enter_tournament', ARGS, ctx);
  state.fail = true;
  const recovered = restart();
  const result = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, recovered);
  assert.equal(result.status, 'awaiting_first_game');
  assert.equal(recovered.store.readEnrollmentWatches().length, 1);
});

test('normal matchmaking works and a normal match does not consume the tournament watch', async (t) => {
  const { ctx } = fixture(t);
  await dispatchTool('enter_tournament', ARGS, ctx);
  assert.equal((await dispatchTool('queue_match', { gameId: 'chess' }, ctx)).status, 'queued');
  const result = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, ctx);
  assert.equal(result.matchId, 'normal');
  assert.equal(ctx.store.readEnrollmentWatches()[0].assignedMatchId, undefined);
});

test('a pending normal queue does not hide portal enrollment or a delayed assignment from wait_for_turn', async (t) => {
  const { ctx, state } = fixture(t);
  state.queueWaiting = true;
  ctx.store.writePendingQueue({ gameId: 'chess' });
  const waiting = dispatchTool('wait_for_turn', { timeoutMs: 8000 }, ctx);
  // Let the initial recovery check finish before the assignment arrives.
  await until(() => state.calls.includes('/api/matchmaking/status'));
  state.assigned = true;
  const result = await waiting;
  assert.equal(result.matchId, 'first');
  assert.equal(result.status, 'your_turn');
  assert.equal(ctx.store.readPendingQueue().gameId, 'chess');
  assert.equal(ctx.store.readEnrollmentWatches()[0].assignedMatchId, 'first');
});

for (const saved of [false, true]) {
  test(`wake watches delayed tournament assignment alongside a pending queue (${saved ? 'MCP' : 'portal'})`, async (t) => {
    const { ctx, state, restart } = fixture(t);
    if (saved) await dispatchTool('enter_tournament', ARGS, ctx);
    state.queueWaiting = true;
    ctx.store.writePendingQueue({ gameId: 'chess' });
    const recovered = restart();
    const notifier = makeWakeNotifier(recovered);
    notifier.start();
    try {
      await until(() => state.calls.includes('/api/matchmaking/status'));
      state.assigned = true;
      await until(() => state.wakes.length > 0, 8000);
    } finally {
      await notifier.stop();
    }
    assert.equal(state.wakes[0].matchId, 'first');
    assert.equal(recovered.store.readPendingQueue().gameId, 'chess');
  });
}

test('non-entrants and shootout entries retain normal idle behavior', async (t) => {
  for (const format of ['pool-bracket', 'shootout']) {
    const { ctx, state } = fixture(t);
    state.format = format;
    state.me = format === 'shootout' ? 'entered' : 'not_entered';
    const result = await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, ctx);
    assert.equal(result.error, 'no_active_match');
    assert.deepEqual(ctx.store.readEnrollmentWatches(), []);
  }
});

test('a finished tournament game consumes the watch permanently, even while the entry remains live', async (t) => {
  const { ctx, state, restart } = fixture(t);
  state.assigned = true;
  assert.equal((await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, ctx)).matchId, 'first');
  state.over = true;
  assert.equal((await dispatchTool('get_turn', {}, ctx)).status, 'game_over');
  const recovered = restart();
  assert.equal(
    (await dispatchTool('wait_for_turn', { timeoutMs: 1000 }, recovered)).error,
    'no_active_match',
  );
  assert.equal(recovered.store.readEnrollmentWatches()[0].assignedMatchId, 'first');
  assert.equal(recovered.store.readTournamentRun(), null);
  // A later eliminated read drops the consumed marker too.
  state.me = 'eliminated';
  await refreshEnrollmentWatches(recovered, recovered.store.readCredentials(), { force: true });
  assert.deepEqual(recovered.store.readEnrollmentWatches(), []);
});

test('wake polls through a delayed first assignment without an agent tool call', async (t) => {
  const { ctx, state } = fixture(t);
  const notifier = makeWakeNotifier(ctx);
  notifier.start();
  try {
    await until(() => ctx.store.readEnrollmentWatches().length > 0);
    state.assigned = true;
    await until(() => state.wakes.length > 0, 8000);
  } finally {
    await notifier.stop();
  }
  assert.equal(state.wakes[0].matchId, 'first');
});

test('wake clears cancelled enrollment after restart and does not emit an assignment', async (t) => {
  const { ctx, state, restart } = fixture(t);
  await dispatchTool('enter_tournament', ARGS, ctx);
  state.status = 'cancelled';
  const recovered = restart();
  const notifier = makeWakeNotifier(recovered);
  notifier.start();
  try {
    await until(() => recovered.store.readEnrollmentWatches().length === 0);
  } finally {
    await notifier.stop();
  }
  assert.deepEqual(state.wakes, []);
});

test('a concurrent schedule refresh cannot undo a consumed assignment', async (t) => {
  const { ctx, state } = fixture(t);
  state.assigned = true;
  await refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), { force: true });
  const original = ctx.fetchImpl;
  let release;
  let reached = false;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  ctx.fetchImpl = async (url, options) => {
    if (new URL(url).pathname.endsWith('/my-schedule')) {
      reached = true;
      await barrier;
    }
    return original(url, options);
  };
  const refresh = refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), { force: true });
  await until(() => reached);
  consumeEnrollmentAssignment(ctx, 'first');
  release();
  await refresh;
  assert.equal(ctx.store.readEnrollmentWatches()[0].assignedMatchId, 'first');
});

test('successful enrollment racing an older absence read is not lost', async (t) => {
  const { ctx, state } = fixture(t);
  state.me = 'not_entered';
  const original = ctx.fetchImpl;
  let release;
  let reached = false;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  ctx.fetchImpl = async (url, options) => {
    const response = await original(url, options);
    if (new URL(url).pathname.endsWith('/me')) {
      reached = true;
      await barrier;
    }
    return response;
  };
  const refresh = refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), { force: true });
  await until(() => reached);
  const enrollment = dispatchTool('enter_tournament', ARGS, ctx);
  await until(() => state.calls.includes(`/api/tournaments/${ID}/enter`));
  release();
  await refresh;
  assert.equal((await enrollment).ok, true);
  assert.equal(ctx.store.readEnrollmentWatches()[0].entryId, ENTRY.entryId);
});

test('bounded scans resume so older portal entries and their schedules cannot starve', async (t) => {
  const { ctx, state } = fixture(t);
  state.assigned = true;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const original = ctx.fetchImpl;
  ctx.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/tournaments')
      return new Response(
        JSON.stringify({
          tournaments: ['new-1', 'new-2', ID].map((id) => ({
            id,
            gameId: 'nim',
            format: 'pool-bracket',
            status: 'qualifying',
          })),
        }),
      );
    // Deterministic latency budget: the first scan reaches the entry but runs
    // out before its schedule. Repeating the same prefix would never adopt it.
    if (path.endsWith('/me') || path.endsWith('/my-schedule')) now += 40;
    if (path.startsWith('/api/tournaments/new-'))
      return new Response(
        JSON.stringify({ ...statusBody('not_entered'), tournamentId: path.split('/')[3] }),
      );
    return original(url, options);
  };
  for (let scan = 0; scan < 3; scan++)
    await refreshEnrollmentWatches(ctx, ctx.store.readCredentials(), {
      force: true,
      timeoutMs: 100,
    });
  assert.deepEqual(ctx.store.readEnrollmentWatches()[0].matchIds, ['first']);
});
