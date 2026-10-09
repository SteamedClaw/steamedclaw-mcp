import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { makeStateStore } from '../src/state.mjs';
import { dispatchTool, TOOL_DEFS } from '../src/tools.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'k_tournament_test_secret';
const ENTRY = {
  tournamentId: ID,
  single_entry_attestation: true,
  age_18_plus: true,
  rules_version_accepted: 'v1',
};

function context(t, { registered = true, status = 200, json = {}, fail } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'scmcp-tournament-tools-'));
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

const READS = [
  ['list_tournaments', {}, '/api/tournaments', {}, false, 'tournaments'],
  [
    'list_tournaments',
    { status: 'live' },
    '/api/tournaments',
    { status: 'live' },
    false,
    'tournaments',
  ],
  ['get_tournament', {}, '/api/tournaments/active', {}, false, 'tournament'],
  ['get_tournament', { tournamentId: ID }, `/api/tournaments/${ID}`, {}, false, 'tournament'],
  ['get_tournament', { number: 12 }, '/api/tournaments/by-number/12', {}, false, 'tournament'],
  [
    'get_tournament',
    { slug: 'test-cup' },
    '/api/tournaments/by-slug/test-cup',
    {},
    false,
    'tournament',
  ],
  [
    'get_tournament_terms',
    { number: 12 },
    '/api/tournaments/by-number/12/terms',
    {},
    false,
    'terms',
  ],
  [
    'get_tournament_terms',
    { number: 12, version: 'v1.2' },
    '/api/tournaments/by-number/12/terms',
    { version: 'v1.2' },
    false,
    'terms',
  ],
  ['get_tournament_entry', { tournamentId: ID }, `/api/tournaments/${ID}/me`, {}, true, 'entry'],
  [
    'get_tournament_schedule',
    { tournamentId: ID },
    `/api/tournaments/${ID}/schedule`,
    {},
    false,
    'schedule',
  ],
  [
    'get_my_tournament_schedule',
    { tournamentId: ID },
    `/api/tournaments/${ID}/my-schedule`,
    {},
    true,
    'schedule',
  ],
  [
    'get_tournament_standings',
    { tournamentId: ID },
    `/api/tournaments/${ID}/standings`,
    {},
    false,
    'standings',
  ],
];

for (const [name, args, path, query, auth, field] of READS) {
  test(`${name} ${JSON.stringify(args)} maps the read API and preserves its payload`, async (t) => {
    const payload = {
      tournamentId: ID,
      entered: false,
      nextPlanned: null,
      text: 'Full terms',
      standings: [],
      tournaments: [],
    };
    const ctx = context(t, { json: payload });
    const result = await dispatchTool(name, args, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result[field], payload);
    assert.equal(ctx.calls.length, 1);
    const call = ctx.calls[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.url.pathname, path);
    assert.deepEqual(Object.fromEntries(call.url.searchParams), query);
    assert.equal(call.url.origin, 'http://localhost:3210');
    assert.equal(call.headers.Authorization, auth ? `Bearer ${KEY}` : undefined);
    assert.equal(call.body, undefined);
    assert.equal(ctx.activity.inFlight, 0);
  });
}

test('public reads work before registration; account reads and entry require local credentials', async (t) => {
  for (const [name, args, , , auth] of READS) {
    const ctx = context(t, { registered: false });
    const result = await dispatchTool(name, args, ctx);
    assert.equal(result.ok, !auth);
    assert.equal(ctx.calls.length, auth ? 0 : 1);
    if (auth) assert.equal(result.error, 'not_registered');
    else assert.equal(ctx.calls[0].url.origin, ctx.cfg.baseUrl);
  }
  const ctx = context(t, { registered: false });
  assert.equal((await dispatchTool('enter_tournament', ENTRY, ctx)).error, 'not_registered');
  assert.equal(ctx.calls.length, 0);
});

test('entry sends only explicit attestations and accepted version, preserves gameplay state', async (t) => {
  const entry = {
    tournamentId: ID,
    entryId: 'entry-test',
    agentId: 'self',
    rulesVersionAccepted: 'v1',
  };
  const ctx = context(t, { status: 201, json: entry });
  ctx.store.writeCurrentMatch({ matchId: 'playing', gameId: 'nim' });
  ctx.store.writePendingQueue({ gameId: 'chess' });
  ctx.store.writeTournamentRun({ sinceMatchId: 'previous' });
  const before = fs
    .readdirSync(ctx.cfg.stateDir)
    .map((name) => [name, fs.readFileSync(join(ctx.cfg.stateDir, name), 'utf8')]);
  const result = await dispatchTool('enter_tournament', ENTRY, ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entry, entry);
  assert.match(result.hint, /wait_for_turn/);
  assert.match(result.hint, /do NOT call queue_match/);
  const call = ctx.calls[0];
  assert.equal(ctx.calls.length, 1);
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, `/api/tournaments/${ID}/enter`);
  assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
  const { tournamentId, ...body } = ENTRY;
  assert.deepEqual(JSON.parse(call.body), body);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
  assert.deepEqual(
    fs
      .readdirSync(ctx.cfg.stateDir)
      .filter((name) => name !== 'tournament-enrollments.json')
      .map((name) => [name, fs.readFileSync(join(ctx.cfg.stateDir, name), 'utf8')]),
    before,
  );
  assert.equal(ctx.store.readEnrollmentWatches()[0].entryId, 'entry-test');
});

test('invalid inputs and implicit acceptance never issue HTTP requests', async (t) => {
  const invalid = [
    ['list_tournaments', { status: 'registration_open' }],
    ['get_tournament', { tournamentId: ID, number: 1 }],
    ['get_tournament', { slug: '../admin' }],
    ['get_tournament', { tournamentId: '../admin' }],
    ['get_tournament', { number: '1' }],
    ['get_tournament_terms', {}],
    ['get_tournament_terms', { number: 0 }],
    ['get_tournament_terms', { number: 1.5 }],
    ['get_tournament_terms', { number: Infinity }],
    ['get_tournament_terms', { number: 2147483648 }],
    ['get_tournament_terms', { number: 1, version: 'x'.repeat(17) }],
    ['get_tournament_terms', { number: 1, version: '../' }],
    ['get_tournament_entry', { tournamentId: ID, agentId: 'other' }],
    ['get_my_tournament_schedule', {}],
    ['get_tournament_schedule', []],
    ['get_tournament_standings', 'oops'],
    ...['single_entry_attestation', 'age_18_plus', 'rules_version_accepted'].flatMap((key) => {
      const missing = { ...ENTRY };
      delete missing[key];
      return [
        ['enter_tournament', missing],
        ['enter_tournament', { ...ENTRY, [key]: false }],
      ];
    }),
    ['enter_tournament', { ...ENTRY, single_entry_attestation: 'true' }],
    // Entry asks for no country; the field is not in the schema.
    ['enter_tournament', { ...ENTRY, jurisdiction: 'US' }],
    ['enter_tournament', { ...ENTRY, rules_version_accepted: '' }],
    ['enter_tournament', { ...ENTRY, agentId: 'other' }],
    ['enter_tournament', { ...ENTRY, ownerId: 'owner' }],
  ];
  for (const [name, args] of invalid) {
    const ctx = context(t);
    assert.equal(
      (await dispatchTool(name, args, ctx)).error,
      'invalid_argument',
      `${name}: ${JSON.stringify(args)}`,
    );
    assert.equal(ctx.calls.length, 0);
  }
});

test('server refusals retain status, code and owner guidance without retrying acceptance', async (t) => {
  for (const [status, error] of [
    [400, 'attestation_required'],
    [403, 'prize_entry_owner_only'],
    [403, 'phone_verification_required'],
    [404, 'entry_not_found'],
    [409, 'rules_version_mismatch'],
    [409, 'tournament_field_full'],
    [410, 'registration_closed'],
    [503, 'unavailable'],
  ]) {
    const json = { error, message: 'Owner must enter at /tournaments/12/enter', apiKey: KEY };
    const ctx = context(t, { status, json });
    const result = await dispatchTool('enter_tournament', ENTRY, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.error, error);
    assert.equal(result.details.message, json.message);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
    assert.equal(ctx.calls.length, 1);
  }
});

test('common auth, throttling, malformed response and network errors use existing conventions', async (t) => {
  const unauthorized = context(t, { status: 401, json: { error: 'bad_key' } });
  assert.equal(
    (await dispatchTool('get_tournament_entry', { tournamentId: ID }, unauthorized)).error,
    'unauthorized',
  );
  assert.equal(unauthorized.health.lastError, 'unauthorized');
  const throttled = context(t, { status: 429, json: { retryAfterMs: 60000 } });
  assert.equal((await dispatchTool('list_tournaments', {}, throttled)).error, 'rate_limited');
  for (const json of [null, [], 'not json object']) {
    const ctx = context(t, { json });
    assert.equal((await dispatchTool('get_tournament', {}, ctx)).error, 'unexpected_status');
  }
  const offline = context(t, { fail: new Error('offline') });
  assert.equal((await dispatchTool('list_tournaments', {}, offline)).error, 'network_error');
  assert.equal(offline.activity.inFlight, 0);
});

test('schemas advertise mandatory explicit acceptance and no owner/admin authority', () => {
  const def = TOOL_DEFS.find((tool) => tool.name === 'enter_tournament');
  assert.ok(def);
  assert.deepEqual(new Set(def.inputSchema.required), new Set(Object.keys(ENTRY)));
  assert.deepEqual(def.inputSchema.properties.age_18_plus.enum, [true]);
  // No country, and the age attestation states the free-tournament age.
  assert.equal(def.inputSchema.properties.jurisdiction, undefined);
  assert.doesNotMatch(JSON.stringify(def), /jurisdiction|country code/i);
  assert.match(def.inputSchema.properties.age_18_plus.description, /13 or older/);
  assert.doesNotMatch(def.inputSchema.properties.age_18_plus.description, /at least 18/);
  assert.deepEqual(def.inputSchema.properties.single_entry_attestation.enum, [true]);
  assert.equal(def.inputSchema.additionalProperties, false);
  assert.match(def.description, /prize/i);
  assert.match(def.description, /owner/i);
});
