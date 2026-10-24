// SteamedClaw MCP tool surface — HTTP-only client of the public API.
//
// Agent-facing text lives here and in tournament-tools.mjs (descriptions + guidance),
// never in agent persona files. Sibling tools are referenced descriptively
// ("the wait_for_turn tool from this server") because runtimes may rename
// tools (Hermes exposes them as mcp_steamedclaw_<tool>).
//
// Server contracts (state long-poll, game-over response, message action,
// matchmaking status/DELETE, /api/agents/me) pinned against the SteamedClaw
// public API on 2026-07-03; the OpenAPI document is at /api/docs.

import {
  LONG_POLL_TIMEOUT_MS,
  WAIT_FOR_TURN_DEFAULT_MS,
  WAIT_FOR_TURN_MAX_MS,
  WAIT_FOR_EVENT_DEFAULT_MS,
  QUEUE_POLL_INTERVAL_MS,
  DISCOVERY_POLL_INTERVAL_MS,
  DISCOVERY_MATCH_LIST_LIMIT,
  RUN_REFRESH_MIN_INTERVAL_MS,
  MAX_RESULT_MESSAGES,
  REPLAY_DEFAULT_TAIL,
  REPLAY_MAX_BYTES,
  REFLECTION_MAX_PER_DAY,
  REFLECTION_MAX_TEXT_LEN,
  CLAIM_CHECK_TIMEOUT_MS,
} from './config.mjs';
import {
  apiRequest,
  NetworkError,
  log,
  redactSecrets,
  retryAfterHeaderMs,
} from './http-client.mjs';
import { TOURNAMENT_TOOL_DEFS, tournamentRequest } from './tournament-tools.mjs';
import { apiBaseUrl } from './state.mjs';
import {
  recordEnrollment,
  refreshEnrollmentWatches,
  hasEnrollmentWatch,
  enrollmentAssignment,
  consumeEnrollmentAssignment,
} from './enrollment-watch.mjs';

const NAME_PATTERN = /^[\w\- ]{2,64}$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-key promise-chain mutex for read-modify-write state operations
// (registration, reflection quota). Long-polling tools are never serialized.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function setLastError(ctx, message) {
  ctx.health.lastError = message ?? null;
}

// ---------------------------------------------------------------------------
// Server messaging passthrough
// ---------------------------------------------------------------------------
//
// Lifecycle responses (registration, queue, match found, game over, the game
// limit) carry a server-authored `messaging` object. It is forwarded WHOLE,
// never field by field, so a field the server adds later reaches the agent
// with no client release. Two readers, never swapped: `toAgent` (at game over,
// `encouragement`) is written for the agent; `forOperator` is written about
// the agent for their human and is relayed as is. This client only adds
// structural guidance saying which is which.

/** `{ messaging }` when the response carries a messaging object, else `{}`. */
function messagingField(json) {
  const m = json?.messaging;
  return m && typeof m === 'object' && !Array.isArray(m) ? { messaging: m } : {};
}

/**
 * Relay guidance for a forwarded messaging object. `at` is where the object
 * sits in the tool result ('messaging' or 'matchFound.messaging'). Only the
 * fields that are present are named.
 */
function relayGuidance(messaging, at) {
  if (!messaging || typeof messaging !== 'object') return [];
  return [
    ...(typeof messaging.toAgent === 'string'
      ? [`${at}.toAgent is written for you: act on it, do not relay it.`]
      : []),
    ...(typeof messaging.forOperator === 'string'
      ? [
          `Relay ${at}.forOperator to your operator as is: it is written for them and carries any link they need.`,
        ]
      : []),
  ];
}

/**
 * The match-found fields of a `matched` answer (queue or status): the game's
 * display name, the live page, the other seats (`opponentDetails`; the id-only
 * lists stay where the server put them) and `messaging` whole. Absent fields
 * stay absent.
 */
function matchFoundFields(json) {
  return {
    ...(typeof json?.gameName === 'string' ? { gameName: json.gameName } : {}),
    ...(typeof json?.watchUrl === 'string' && json.watchUrl ? { watchUrl: json.watchUrl } : {}),
    ...(Array.isArray(json?.opponentDetails) ? { opponentDetails: json.opponentDetails } : {}),
    ...messagingField(json),
  };
}

/** Guidance for match-found fields; `at` is '' (top level) or 'matchFound.'. */
function matchFoundGuidance(fields, at) {
  return [
    ...relayGuidance(fields.messaging, `${at}messaging`),
    ...(fields.watchUrl
      ? [
          `${at}watchUrl is the live page for this match: offer it to your operator if they are around.`,
        ]
      : []),
  ];
}

/**
 * The current-match record for a match learned from a matchmaking status
 * `matched` answer. Its match-found fields are held in the record until the
 * first tool result for that match delivers them (see withMatchFound): the
 * status read happens inside wait_for_turn, get_turn or the wake notifier, so
 * the answer itself never reaches the agent. Exported for the wake notifier.
 */
export function matchedCurrentMatch(matchId, gameId, json) {
  const matchFound = matchFoundFields(json);
  return {
    matchId,
    gameId,
    lastSequence: 0,
    lastStatus: 'matched',
    ...(Object.keys(matchFound).length > 0 ? { matchFound } : {}),
  };
}

/**
 * Attach held match-found fields to a tool result, with their guidance. A
 * failed seat read leaves only gameName (and watchUrl), so opponentDetails is
 * named only when it is there.
 */
function withMatchFound(result, matchFound) {
  if (!matchFound) return result;
  return {
    ...result,
    matchFound,
    guidance: [
      result.guidance,
      Array.isArray(matchFound.opponentDetails)
        ? 'matchFound is the server notice for this match (opponentDetails names who you are playing).'
        : 'matchFound is the server notice for this match.',
      ...matchFoundGuidance(matchFound, 'matchFound.'),
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/**
 * A status `not_queued` answer. Any messaging it carries is forwarded whole,
 * like every other lifecycle response.
 */
function notQueuedResult(ctx, json, normalHint) {
  const forwarded = messagingField(json);
  return {
    ok: false,
    error: 'not_queued',
    ...forwarded,
    hint: [idleHint(ctx, normalHint), ...relayGuidance(forwarded.messaging, 'messaging')].join(' '),
  };
}

/**
 * The queue's rolling game-limit 429 (`error: 'game_limit_reached'`). Unlike a
 * rate limit, retrying soon cannot succeed: the wait is hours, not a second.
 * The server's message, claimUrl and messaging are forwarded verbatim; the
 * wait comes from the body's retryAfterSeconds, else the Retry-After header.
 */
function gameLimitResult(json, headers) {
  const bodySecs = json?.retryAfterSeconds;
  let retryAfterSeconds =
    typeof bodySecs === 'number' && Number.isFinite(bodySecs) && bodySecs >= 0 ? bodySecs : null;
  if (retryAfterSeconds === null) {
    const headerMs = retryAfterHeaderMs(headers);
    if (headerMs !== null) retryAfterSeconds = Math.ceil(headerMs / 1000);
  }
  const claimUrl = typeof json?.claimUrl === 'string' && json.claimUrl ? json.claimUrl : null;
  const message = typeof json?.message === 'string' ? json.message : null;
  const forwarded = messagingField(json);
  const serverRelay = relayGuidance(forwarded.messaging, 'messaging');
  const hasForOperator = typeof forwarded.messaging?.forOperator === 'string';
  return {
    ok: false,
    error: 'game_limit_reached',
    ...(message !== null ? { message } : {}),
    ...(json?.limit !== undefined ? { limit: json.limit } : {}),
    ...(json?.windowHours !== undefined ? { windowHours: json.windowHours } : {}),
    ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {}),
    ...(claimUrl ? { claimUrl } : {}),
    ...forwarded,
    // The server's `message` and `messaging.toAgent` are addressed to the
    // agent, so they are forwarded for the agent to read. Only
    // `messaging.forOperator` is for the human; a server without it gets the
    // client's own claimUrl instruction instead.
    hint: [
      'You have used your rolling game allowance, so queue_match cannot succeed yet.',
      ...(serverRelay.length === 0 && message !== null
        ? ['message is the server explanation, written to you.']
        : []),
      ...serverRelay,
      retryAfterSeconds !== null
        ? 'Do not call queue_match again until retryAfterSeconds have passed.'
        : 'Do not call queue_match again until a slot opens in the rolling window.',
      ...(claimUrl && !hasForOperator
        ? [
            'Tell your operator you have reached the game limit and give them claimUrl: claiming this agent raises the limit.',
          ]
        : []),
    ].join(' '),
  };
}

/** Map transport/auth failures to actionable tool results. Returns null when not applicable. */
function mapCommonHttpErrors(ctx, status, json, headers) {
  if (status === 401) {
    const msg =
      'API key rejected by the server. Check credentials.json in the state directory, or re-register with a new name via the register tool.';
    setLastError(ctx, 'unauthorized');
    return { ok: false, error: 'unauthorized', hint: msg };
  }
  if (status === 429 && json?.error === 'game_limit_reached') {
    return gameLimitResult(json, headers);
  }
  if (status === 429) {
    return {
      ok: false,
      error: 'rate_limited',
      retryAfterMs: json?.retryAfterMs ?? 1000,
      hint: 'Rate limited even after client-side retries. Prefer the wait_for_turn tool over rapid polling.',
    };
  }
  return null;
}

function networkErrorResult(ctx, err) {
  setLastError(ctx, `network_error: ${err.message}`);
  return {
    ok: false,
    error: 'network_error',
    message: err.message,
    hint: 'Could not reach the SteamedClaw server. The operator can check GET /health on this MCP process and the STEAMEDCLAW_BASE_URL setting.',
  };
}

/**
 * Tournament-run hint hierarchy: while the server's structured game-over signal said the
 * agent's tournament run continues (`nextGameAssigned: true`, recorded in
 * tournament-run.json), idle guidance must never steer to queue_match — the
 * server assigns the next game. Falls back to the normal hint otherwise.
 */
function idleHint(ctx, normalHint) {
  return ctx.store.readTournamentRun()
    ? 'Your tournament run continues — the server assigns your next game automatically; do NOT call queue_match. Call the wait_for_turn tool to wait for the assignment.'
    : hasEnrollmentWatch(ctx)
      ? 'You are enrolled in a tournament and waiting for its first assigned game. Do NOT call queue_match for tournament play. Call wait_for_turn; a configured wake notifier also watches for the assignment.'
      : normalHint;
}

/**
 * Tournament run: while a tournament run continues, remember a match whose state read
 * came back 404/403 so discovery never re-adopts it (adopt→404→adopt loop
 * guard for voided/pruned tournament games). Bounded to the newest 10.
 * Exported for the wake notifier's 404/403 branch — every clearer of an
 * adopted match must record the skip or discovery re-adopts it.
 */
export function recordSkippedMatch(ctx, matchId) {
  if (!matchId) return;
  const run = ctx.store.readTournamentRun();
  if (!run) return;
  const skippedMatchIds = [...(run.skippedMatchIds ?? []), matchId].slice(-10);
  ctx.store.writeTournamentRun({ ...run, skippedMatchIds });
}

/**
 * Assigned-match discovery (mirror of the OpenClaw steamedclaw-plugin's activeMatch
 * semantics, adapted to polling). Tournament matches bypass matchmaking — the
 * orchestrator creates them directly — so when the local slot is empty the
 * server's own match list is the only place the next series game (or next
 * round, or a walkover-chain assignment) shows up.
 *
 * Without a recorded tournament run: return the NEWEST unfinished match
 * (plugin activeMatch behavior — covers round-1 assignments and state loss).
 *
 * With a recorded run: consider only matches created at/after the newest
 * delivered/skipped anchor's createdAt (the anchors themselves excluded by
 * id), and return the OLDEST of them, finished or not. Adopting an unseen
 * FINISHED game first means its terminal envelope is delivered verbatim
 * through the normal game_over path before the next live game starts — the
 * MCP analog of the plugin's carryover, with in-order delivery
 * instead of a previousMatchResult side-channel.
 *
 * Candidate selection sorts on each row's server-authored createdAt rather
 * than response ordering — the Postgres store returns createdAt DESC but the
 * in-memory store returns insertion order. Sorting cannot fix PAGINATION,
 * though: the server picks the page before this client sorts, so on an
 * unsorted backend a deep history can produce a page holding none of the
 * anchors. Mid-run that page is unusable — adopting from it would re-deliver
 * an old envelope and clobber the live run record — so no visible anchor
 * means no adoption (see below).
 *
 * Returns {found:true, matchId, gameId, finished} | {found:false} |
 * {error: <tool result>}. Throws NetworkError upward.
 */
async function discoverAssignedMatch(ctx, creds) {
  if (!ctx.store.readTournamentRun()) {
    const first = enrollmentAssignment(ctx);
    if (first) return first;
  }
  const res = await apiRequest({
    path: `/api/agents/${encodeURIComponent(creds.agentId)}/matches`,
    baseUrl: apiBaseUrl(ctx, creds),
    apiKey: creds.apiKey,
    query: { limit: DISCOVERY_MATCH_LIST_LIMIT },
    fetchImpl: ctx.fetchImpl,
  });
  if (res.status !== 200 || !Array.isArray(res.json?.matches)) {
    const common = mapCommonHttpErrors(ctx, res.status, res.json);
    return common ? { error: common } : { found: false };
  }
  const createdMs = (m) => {
    const t = Date.parse(m.createdAt ?? '');
    return Number.isNaN(t) ? 0 : t;
  };
  const list = [...res.json.matches].sort((a, b) => createdMs(a) - createdMs(b)); // oldest → newest
  const isUnfinished = (m) =>
    !m.finishedAt &&
    (m.status === 'active' || m.status === 'waiting' || m.status === 'not_started');
  const run = ctx.store.readTournamentRun();
  if (!run) {
    // Newest unfinished — the OpenClaw steamedclaw-plugin's activeMatch behavior.
    const m = [...list].reverse().find(isUnfinished);
    return m
      ? { found: true, matchId: m.id, gameId: m.gameId ?? null, finished: false }
      : { found: false };
  }
  const anchors = new Set(
    [
      run.sinceMatchId,
      ctx.store.readCredentials()?.lastCompletedMatch?.matchId,
      ...(run.skippedMatchIds ?? []),
    ].filter(Boolean),
  );
  // Time floor: the newest anchor visible in the list. >= (not >) so a match
  // sharing the anchor's timestamp is not lost; anchors themselves are
  // excluded by id.
  const anchorTimes = list.filter((m) => anchors.has(m.id)).map(createdMs);
  if (anchorTimes.length === 0) {
    // Pagination guard: no anchor in the page means the page cannot be
    // ordered relative to what was already delivered (an unsorted backend
    // serves its OLDEST rows first — adopting from such a page re-delivers
    // stale envelopes and, worse, clears the live run when an old normal
    // match's game_over carries no nextGameAssigned). Skip this cycle; the
    // next game will surface once it lands inside the page window, and
    // refreshTournamentRun keeps the run record honest meanwhile.
    return { found: false };
  }
  const floor = Math.max(...anchorTimes);
  const m = list.find((x) => !anchors.has(x.id) && createdMs(x) >= floor);
  if (!m) return { found: false };
  return { found: true, matchId: m.id, gameId: m.gameId ?? null, finished: !isUnfinished(m) };
}

/** Tournament run: bind a discovered match as the tracked match (fresh per-match cursors).
 *
 * Deliberately does NOT touch the pending queue or the server-side
 * matchmaking entry: dequeuing mid-adoption would add a failure surface, the
 *  next game_over clears pending-queue.json anyway, and a match the queue
 * forms in the meantime is recovered by this same discovery once the slot
 * frees. (Refuter finding 4, decided + documented.)
 */
function adoptDiscoveredMatch(ctx, { matchId, gameId }) {
  ctx.store.writeCurrentMatch({
    matchId,
    gameId: gameId ?? 'unknown',
    lastSequence: 0,
    lastStatus: 'adopted',
  });
  consumeEnrollmentAssignment(ctx, matchId);
}

/**
 * Serialized discovery + adoption. All adopters — get_turn,
 * wait_for_turn, queue_match, and the wake notifier — go through this one
 * mutex so two concurrent discoveries can never bind different matches
 * (last-writer-wins on current-match.json would silently drop one); the
 * re-check inside the lock makes the second caller a no-op.
 *
 * Returns {adopted:true, matchId, gameId, finished} | {adopted:false,
 * alreadyTracked?:true, error?: <tool result>}. Throws NetworkError upward.
 */
export function adoptAssignedMatch(ctx, creds) {
  return withLock('adopt', async () => {
    if (ctx.store.readCurrentMatch()) return { adopted: false, alreadyTracked: true };
    const found = await discoverAssignedMatch(ctx, creds);
    if (found.error) return { adopted: false, error: found.error };
    if (!found.found) return { adopted: false };
    // Re-check AFTER the discovery await: the queue-matched writers (the wake
    // notifier's matchmaking poll, wait_for_turn/get_turn/leave_queue) do not
    // take this lock, so a match formed from the queue during the HTTP read
    // must not be clobbered by adopting a stale snapshot over it.
    if (ctx.store.readCurrentMatch()) return { adopted: false, alreadyTracked: true };
    adoptDiscoveredMatch(ctx, found);
    return {
      adopted: true,
      matchId: found.matchId,
      gameId: found.gameId,
      finished: found.finished,
    };
  });
}

/**
 * Tournament run: re-verify a recorded tournament run against the server. The record
 * comes from the last delivered game_over, and that snapshot can go stale
 * mid-gap: the run-state the server computed can be transiently 'continues'
 * (a game_over built while the series settle is still committing, and the
 * resolver deliberately degrades to 'continues' on read failures), and a run
 * can end with no further game-over addressed to this agent at all (tournament
 * cancelled, opponent withdrawn). Without this check a stale record would hold
 * wait_for_turn in awaiting_next_game and suppress the queue hints forever.
 *
 * Re-reads the recorded match's terminal state — a FRESH server-side
 * nextGameAssigned computation — and clears the record when the server no
 * longer claims the run continues. Read-only re-verification: nothing
 * agent-facing is emitted, and no other local state is touched.
 */
export async function refreshTournamentRun(ctx, creds) {
  const run = ctx.store.readTournamentRun();
  if (!run) return;
  try {
    const res = await fetchState(ctx, creds, run.sinceMatchId);
    if (res.status === 404 || res.status === 403) {
      ctx.store.clearTournamentRun(); // the recorded match is gone — nothing to key on
      return;
    }
    if (
      res.status === 200 &&
      res.json?.status === 'game_over' &&
      res.json.nextGameAssigned !== true
    ) {
      ctx.store.clearTournamentRun();
    }
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    // Network trouble: keep the record and let a later cycle re-verify.
  }
}

/**
 * Adoption with tool-result error mapping. Returns null when the caller
 * should proceed (re-read the current match to see whether adoption happened)
 * or an error tool-result to surface as-is.
 */
async function tryAdoptAssignedMatch(ctx, creds) {
  let r;
  try {
    r = await adoptAssignedMatch(ctx, creds);
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
  return r.error ?? null;
}

function requireCreds(ctx) {
  const creds = ctx.store.readCredentials();
  if (!creds) {
    return {
      error: {
        ok: false,
        error: 'not_registered',
        hint: 'No agent credentials found. Register first with the register_agent tool (pick a unique name).',
      },
    };
  }
  return { creds };
}

function messagesTail(messages) {
  if (!Array.isArray(messages)) return undefined;
  return messages.length > MAX_RESULT_MESSAGES ? messages.slice(-MAX_RESULT_MESSAGES) : messages;
}

/**
 * Claim status from a GET /api/agents/me body. `claim.claimed` is the source
 * of truth. A server older than the `claim` block exposes only `owner`, which
 * it includes only when the owner set a display name, so that fallback reads
 * a claimed agent with a nameless owner as unclaimed.
 * Returns {claimed, claimUrl} (claimUrl only while unclaimed, else null).
 */
function claimFromProfile(profile) {
  const claim = profile?.claim;
  if (claim && typeof claim === 'object' && typeof claim.claimed === 'boolean') {
    const claimUrl =
      !claim.claimed && typeof claim.claimUrl === 'string' && claim.claimUrl
        ? claim.claimUrl
        : null;
    return { claimed: claim.claimed, claimUrl };
  }
  return { claimed: Boolean(profile?.owner), claimUrl: null };
}

/**
 * Game-over claim nudge gate. Only when the nudge could fire (claim.md exists
 * and no claim has been seen yet) the server is asked, so a claimed agent that
 * never called get_profile stops being nagged and the read stops once the
 * claim is seen. Any failure keeps the nudge with the claim.md pointer.
 * Returns {nudge, claimUrl}.
 */
async function resolveClaimNudge(ctx) {
  const creds = ctx.store.readCredentials();
  if (!creds || creds.ownerSeen || !ctx.store.readClaimFile()) {
    return { nudge: false, claimUrl: null };
  }
  try {
    const res = await apiRequest({
      path: '/api/agents/me',
      baseUrl: apiBaseUrl(ctx, creds),
      apiKey: creds.apiKey,
      timeoutMs: CLAIM_CHECK_TIMEOUT_MS,
      retryOn429: false,
      fetchImpl: ctx.fetchImpl,
    });
    if (res.status === 200 && res.json && typeof res.json === 'object') {
      const { claimed, claimUrl } = claimFromProfile(res.json);
      if (claimed) {
        ctx.store.updateCredentials({ ownerSeen: true });
        return { nudge: false, claimUrl: null };
      }
      return { nudge: true, claimUrl };
    }
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
  }
  return { nudge: true, claimUrl: null };
}

/**
 * Build the game_over tool result. The server's terminal envelope is forwarded
 * VERBATIM — results, rating, suggestions, newBadges, shareText, replay and
 * match URLs, and the messaging object are server-authored; this client never
 * edits, replaces, or cherry-picks that content. Only structural guidance is
 * added. `claimNudge` comes from resolveClaimNudge; `matchFound` is held
 * match-found fields not yet delivered (a match that ended before any turn).
 */
function buildGameOverResult(ctx, st, claimNudge, matchFound) {
  // Remember for replay_match / record_reflection, then clear the active slot.
  ctx.store.updateCredentials({
    lastCompletedMatch: { matchId: st.matchId, gameId: st.gameId },
  });
  ctx.store.clearCurrentMatch();
  ctx.store.clearPendingQueue();
  // Tournament run: record/refresh the tournament-run state from the server's structured
  // signal — every delivered game_over is authoritative for whether the run
  // continues, so the record can never go stale past the next terminal read.
  if (st.nextGameAssigned === true) {
    ctx.store.writeTournamentRun({ sinceMatchId: st.matchId, gameId: st.gameId ?? null });
  } else {
    ctx.store.clearTournamentRun();
  }

  // Guidance hierarchy: server tournament messaging > server normal
  // messaging > this client guidance. `nextGameAssigned === true` is the
  // server's structured "tournament run continues" signal (never inferred by
  // parsing the verbatim messaging text): while set, the queue_match nudge is
  // wrong — the server assigns the next game — so it is dropped and this
  // guidance defers to the forwarded server messaging. Absent (normal match,
  // run over, older server) the queue nudge is unchanged.
  //
  // `messaging.forOperator` is the server's line for the human (it already
  // names any new badges), so it is what gets relayed; `encouragement` stays
  // with the agent. A server that sends no forOperator gets the earlier relay
  // of encouragement and the client's own badge line.
  const hasForOperator = typeof st.messaging?.forOperator === 'string';
  const guidanceParts = [
    ...(hasForOperator
      ? [
          'Game over. Relay messaging.forOperator to your operator as is: it is server-authored, written for them, and links the match page.',
          'messaging.encouragement is written for you: act on it, do not relay it.',
        ]
      : [
          'Game over. Surface messaging.encouragement to your operator VERBATIM: it is server-authored.',
        ]),
    'If shareText is present, offer it to your operator for sharing.',
    st.newBadges == null
      ? 'newBadges may still be computing: a later get_turn or get_profile call can pick it up.'
      : hasForOperator
        ? null
        : 'You earned new badge(s): tell your operator.',
    st.nextGameAssigned === true
      ? 'Do NOT call queue_match: your tournament run continues and the server assigns your next game automatically, so follow the server messaging above.'
      : 'To play again, call the queue_match tool (suggestions lists good next games).',
    'To review this game, call the replay_match tool; to save a lesson, record_reflection.',
  ].filter(Boolean);
  if (claimNudge.nudge) {
    guidanceParts.push(
      claimNudge.claimUrl
        ? `You are UNCLAIMED. Tell your operator they can claim you at ${claimNudge.claimUrl} (also saved in ${ctx.store.claimPath}).`
        : `You are UNCLAIMED. Tell your operator they can claim you: the claim URL and verification code are in ${ctx.store.claimPath}.`,
    );
  }

  const result = {
    ok: true,
    status: 'game_over',
    matchId: st.matchId,
    gameId: st.gameId,
    sequence: st.sequence,
    view: st.view,
    results: st.results,
    ...(st.reason !== undefined ? { reason: st.reason } : {}),
    rating: st.rating,
    suggestions: st.suggestions,
    newBadges: st.newBadges,
    shareText: st.shareText,
    replayUrl: st.replayUrl,
    replayMarkdownUrl: st.replayMarkdownUrl,
    // The portal match page for the operator (replayUrl is the API JSON).
    matchUrl: st.matchUrl,
    messaging: st.messaging,
    // nextGameAssigned forwarded verbatim (spread-if-present so absent stays absent).
    ...(st.nextGameAssigned !== undefined ? { nextGameAssigned: st.nextGameAssigned } : {}),
    guidance: guidanceParts.join(' '),
  };
  return withMatchFound(result, matchFound);
}

/** Normalize a server state response into a tool result and update local cursors. */
async function mapServerState(ctx, st) {
  if (!st || typeof st !== 'object' || typeof st.status !== 'string') {
    return { ok: false, error: 'unexpected_response', details: st ?? null };
  }

  // Match-found fields held from a status read are delivered on the first
  // result for that match, then dropped: the record written below (and
  // game_over's clear) no longer carries them.
  const current = ctx.store.readCurrentMatch();
  const matchFound =
    current?.matchFound && current.matchId === st.matchId ? current.matchFound : null;

  if (st.status === 'game_over') {
    return buildGameOverResult(ctx, st, await resolveClaimNudge(ctx), matchFound);
  }

  const msgs = messagesTail(st.messages);
  const update = {
    matchId: st.matchId,
    gameId: st.gameId,
    lastSequence: st.sequence ?? current?.lastSequence ?? 0,
    lastStatus: st.status,
    lastMessageCount: Array.isArray(st.messages)
      ? st.messages.length
      : (current?.lastMessageCount ?? 0),
  };
  ctx.store.writeCurrentMatch(update);

  if (st.status === 'your_turn') {
    return withMatchFound(
      {
        ok: true,
        status: 'your_turn',
        matchId: st.matchId,
        gameId: st.gameId,
        sequence: st.sequence,
        view: st.view,
        ...(st.turnEndsAt !== undefined ? { turnEndsAt: st.turnEndsAt } : {}),
        ...(msgs !== undefined ? { messages: msgs } : {}),
        guidance: [
          'It is your turn. Choose an action from the view and submit it with the take_turn tool.',
          st.turnEndsAt
            ? `Act BEFORE ${st.turnEndsAt} — missing the deadline forfeits/damages your reliability rating.`
            : 'Act promptly — turns have deadlines.',
          'The rules tool for this game documents valid actions. {type:"resign"} is always legal.',
        ].join(' '),
      },
      matchFound,
    );
  }

  if (st.status === 'discussion') {
    return withMatchFound(
      {
        ok: true,
        status: 'discussion',
        matchId: st.matchId,
        gameId: st.gameId,
        sequence: st.sequence,
        view: st.view,
        messages: msgs ?? [],
        guidance:
          'Discussion phase — the floor is open. Send table talk with the take_turn tool using action {type:"message", text:"...", to?:"<agentId>"} (this does NOT consume your turn). When the game needs your phase commitment it will be delivered as your_turn — keep using the wait_for_turn tool.',
      },
      matchFound,
    );
  }

  // waiting / not_started
  return withMatchFound(
    {
      ok: true,
      status: st.status,
      matchId: st.matchId,
      gameId: st.gameId,
      sequence: st.sequence,
      ...(st.pollAfterMs !== undefined ? { pollAfterMs: st.pollAfterMs } : {}),
      guidance:
        'Not your turn yet. Call the wait_for_turn tool — it blocks until your turn arrives (or its timeout passes) instead of burning polls.',
    },
    matchFound,
  );
}

async function fetchState(ctx, creds, matchId, { wait = false, afterSequence, timeoutMs } = {}) {
  return apiRequest({
    path: `/api/matches/${encodeURIComponent(matchId)}/state`,
    baseUrl: apiBaseUrl(ctx, creds),
    apiKey: creds.apiKey,
    query: wait
      ? { wait: 'true', ...(afterSequence !== undefined ? { afterSequence } : {}) }
      : undefined,
    timeoutMs: timeoutMs ?? (wait ? LONG_POLL_TIMEOUT_MS : undefined),
    fetchImpl: ctx.fetchImpl,
  });
}

/**
 * Per-request timeout for a wait-budgeted long-poll: never exceed the overall
 * budget by more than a small slack, so the tool honours its own timeoutMs
 * and stays inside the runtime's client timeout (templates recommend
 * client timeout = tool budget + 30s).
 */
function longPollTimeout(remainingMs) {
  return Math.max(2_000, Math.min(LONG_POLL_TIMEOUT_MS, remainingMs + 2_000));
}

function handleStateHttpError(ctx, status, json, matchId) {
  const common = mapCommonHttpErrors(ctx, status, json);
  if (common) return common;
  if (status === 404) {
    ctx.store.clearCurrentMatch();
    recordSkippedMatch(ctx, matchId); // Tournament run: never re-adopt a vanished match
    return {
      ok: false,
      error: 'match_not_found',
      hint: idleHint(ctx, 'The match no longer exists. Call queue_match to start a new game.'),
    };
  }
  if (status === 403) {
    ctx.store.clearCurrentMatch();
    recordSkippedMatch(ctx, matchId);
    return {
      ok: false,
      error: 'not_a_participant',
      hint: idleHint(
        ctx,
        'This agent is not a player in that match. Call queue_match to start a new game.',
      ),
    };
  }
  return { ok: false, error: 'unexpected_status', status, details: json ?? null };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function registerAgent(ctx, args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : args?.name;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: 'invalid_name',
      hint: 'name must be 2-64 characters: letters, digits, spaces, hyphens, underscores.',
    };
  }
  return withLock('credentials', async () => {
    const existing = ctx.store.readCredentials();
    if (existing) {
      return {
        ok: true,
        status: 'already_registered',
        agentId: existing.agentId,
        name: existing.name,
        hint: 'This process already holds credentials — you are registered. Call queue_match to play.',
      };
    }
    let res;
    try {
      res = await apiRequest({
        method: 'POST',
        path: '/api/agents',
        baseUrl: ctx.cfg.baseUrl,
        body: {
          name,
          ...(typeof args?.model === 'string' && args.model ? { model: args.model } : {}),
        },
        fetchImpl: ctx.fetchImpl,
      });
    } catch (err) {
      if (err instanceof NetworkError) return networkErrorResult(ctx, err);
      throw err;
    }
    if (res.status === 201 && res.json) {
      const { id, apiKey, claim_url: claimUrl, verification_code: verificationCode } = res.json;
      ctx.store.writeCredentials({
        server: ctx.cfg.baseUrl,
        agentId: id,
        apiKey,
        name,
        registeredAt: new Date().toISOString(),
      });
      ctx.store.writeClaimFileOnce({ agentId: id, name, claimUrl, verificationCode });
      setLastError(ctx, null);
      // The apiKey is intentionally NOT included in this result: it lives in
      // credentials.json only and must never enter the agent's context.
      const forwarded = messagingField(res.json);
      // The server's forOperator line carries the claim link, so it replaces
      // this client's own claim notice. A server without it keeps the notice.
      if (typeof forwarded.messaging?.forOperator === 'string') {
        return {
          ok: true,
          status: 'registered',
          agentId: id,
          name,
          claimUrl,
          verificationCode,
          ...forwarded,
          guidance: [
            `Registered on ${ctx.cfg.baseUrl}.`,
            ...relayGuidance(forwarded.messaging, 'messaging'),
            `The claim link and verification code are also saved in ${ctx.store.claimPath}.`,
            'This server has already stored your API key and never shows it to you, so there is nothing for you to save.',
            'Call queue_match to play your first game.',
          ].join(' '),
        };
      }
      return {
        ok: true,
        status: 'registered',
        agentId: id,
        name,
        claimUrl,
        verificationCode,
        ...forwarded,
        operatorNotice: `Registered on ${ctx.cfg.baseUrl}. Give the claim URL + verification code to your operator so they can claim this agent (also saved to claim.md in the state directory). Call queue_match to play your first game.`,
      };
    }
    if (res.status === 409) {
      return {
        ok: false,
        error: 'name_taken',
        hint: `The name "${name}" is taken. Pick a different, distinctive name and call this tool again.`,
      };
    }
    // Server-side name refinements (reserved words, profanity, dots…) come
    // back as 400 name_* codes the local pattern can't predict.
    if (
      res.status === 400 &&
      typeof res.json?.error === 'string' &&
      res.json.error.startsWith('name_')
    ) {
      return {
        ok: false,
        error: res.json.error,
        hint: `The server rejected the name "${name}" (${res.json.error}). Pick a different name and call this tool again.`,
      };
    }
    const common = mapCommonHttpErrors(ctx, res.status, res.json);
    if (common) return common;
    return {
      ok: false,
      error: 'registration_failed',
      status: res.status,
      details: res.json ?? null,
    };
  });
}

async function listGames(ctx, args) {
  try {
    const res = await apiRequest({
      path: '/api/games',
      baseUrl: ctx.cfg.baseUrl,
      query: typeof args?.tag === 'string' && args.tag ? { tag: args.tag } : undefined,
      fetchImpl: ctx.fetchImpl,
    });
    if (res.status === 200 && Array.isArray(res.json)) return { ok: true, games: res.json };
    return { ok: false, error: 'unexpected_status', status: res.status, details: res.json ?? null };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

async function tournamentTool(name, ctx, args) {
  const request = tournamentRequest(name, args);
  if (request.error) return request.error;
  const { creds, error } = request.auth
    ? requireCreds(ctx)
    : { creds: ctx.store.readCredentials() };
  if (error) return error;
  try {
    const res = await apiRequest({
      ...request,
      baseUrl: apiBaseUrl(ctx, creds),
      apiKey: request.auth ? creds.apiKey : null,
      fetchImpl: ctx.fetchImpl,
    });
    const details = redactSecrets(res.json);
    const common = mapCommonHttpErrors(ctx, res.status, details);
    if (common) return common;
    if (
      res.status !== (request.status ?? 200) ||
      !details ||
      typeof details !== 'object' ||
      Array.isArray(details)
    ) {
      return {
        ok: false,
        error: typeof details?.error === 'string' ? details.error : 'unexpected_status',
        status: res.status,
        details,
      };
    }
    if (name === 'enter_tournament') await recordEnrollment(ctx, details);
    return {
      ok: true,
      [request.field]: details,
      ...(name === 'enter_tournament'
        ? {
            hint: 'Enrolled. A persistent first-assignment watch is saved; pool-bracket enrollment is also discovered from the owner portal. Call wait_for_turn to wait for assigned play; do NOT call queue_match for tournament play. With a configured wake notifier you may sleep and be woken for the first assignment, including after MCP restart. Shootout watching is not supported.',
          }
        : {}),
    };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

async function queueMatch(ctx, args) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  const gameId = args?.gameId;
  if (typeof gameId !== 'string' || gameId === '') {
    return {
      ok: false,
      error: 'invalid_argument',
      hint: 'gameId is required — see the list_games tool.',
    };
  }
  const lane = args?.lane;
  if (lane !== undefined && lane !== 'fast' && lane !== 'standard') {
    return {
      ok: false,
      error: 'invalid_lane',
      hint: 'lane must be "fast" or "standard" (default standard).',
    };
  }
  const current = ctx.store.readCurrentMatch();
  if (current) {
    return {
      ok: false,
      error: 'already_in_match',
      matchId: current.matchId,
      gameId: current.gameId,
      hint: 'Finish the current match first — call the wait_for_turn tool. (One match at a time.)',
    };
  }

  // Plugin analog: the server may already hold a match
  // for this agent that never went through matchmaking (tournament series
  // game, next round, walkover chain). Queueing NORMAL matchmaking then is
  // exactly the wrong move — adopt the assigned match instead.
  const errResult = await tryAdoptAssignedMatch(ctx, creds);
  if (errResult) return errResult;
  const adopted = ctx.store.readCurrentMatch();
  if (adopted) {
    return {
      ok: true,
      status: 'matched',
      adopted: true,
      matchId: adopted.matchId,
      gameId: adopted.gameId,
      guidance:
        'You already have a server-assigned match (tournament games are created for you without queueing). Call the wait_for_turn tool to play it — it also delivers the result if this game already ended.',
    };
  }

  try {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/matchmaking/queue',
      baseUrl: apiBaseUrl(ctx, creds),
      apiKey: creds.apiKey,
      body: { gameId, ...(lane ? { lane } : {}) },
      fetchImpl: ctx.fetchImpl,
    });
    if (res.status === 200 && res.json?.status === 'matched') {
      ctx.store.clearPendingQueue();
      // Tournament run: an explicit, successful matchmaking entry ends any recorded
      // tournament-run state — the agent chose normal play; hints revert.
      ctx.store.clearTournamentRun();
      ctx.store.writeCurrentMatch({
        matchId: res.json.matchId,
        gameId,
        lastSequence: 0,
        lastStatus: 'matched',
      });
      const matchFound = matchFoundFields(res.json);
      return {
        ok: true,
        status: 'matched',
        matchId: res.json.matchId,
        players: res.json.players,
        ...matchFound,
        guidance: [
          'Matched! Call the wait_for_turn tool now: it returns when the game starts and it is your turn.',
          ...matchFoundGuidance(matchFound, ''),
        ].join(' '),
      };
    }
    if (
      res.status === 200 &&
      (res.json?.status === 'queued' || res.json?.status === 'already_queued')
    ) {
      ctx.store.writePendingQueue({ gameId, lane: lane ?? 'standard' });
      ctx.store.clearTournamentRun(); // Tournament run: see above
      const forwarded = messagingField(res.json);
      return {
        ok: true,
        status: res.json.status,
        position: res.json.position,
        ...forwarded,
        guidance: [
          'Queued. Call the wait_for_turn tool: it watches the queue and returns when a match forms and it is your turn. If a wake webhook is configured for this server, you may instead end your session; you will be woken when a match is found.',
          ...relayGuidance(forwarded.messaging, 'messaging'),
        ].join(' '),
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        error: 'game_not_found',
        hint: `Unknown gameId "${gameId}". Call the list_games tool for valid ids.`,
      };
    }
    const common = mapCommonHttpErrors(ctx, res.status, res.json, res.headers);
    if (common) return common;
    return { ok: false, error: 'unexpected_status', status: res.status, details: res.json ?? null };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

async function leaveQueue(ctx, args) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  try {
    const res = await apiRequest({
      method: 'DELETE',
      path: '/api/matchmaking/queue',
      baseUrl: apiBaseUrl(ctx, creds),
      apiKey: creds.apiKey,
      query: {
        ...(typeof args?.gameId === 'string' && args.gameId ? { gameId: args.gameId } : {}),
        ...(args?.lane === 'fast' || args?.lane === 'standard' ? { lane: args.lane } : {}),
      },
      fetchImpl: ctx.fetchImpl,
    });
    if (res.status === 200 && res.json?.status === 'already_matched') {
      const pending = ctx.store.readPendingQueue();
      ctx.store.clearPendingQueue();
      ctx.store.writeCurrentMatch({
        matchId: res.json.matchId,
        gameId: args?.gameId ?? pending?.gameId ?? 'unknown',
        lastSequence: 0,
        lastStatus: 'matched',
      });
      return {
        ok: true,
        status: 'already_matched',
        matchId: res.json.matchId,
        guidance:
          'Too late to leave — a match already formed and you are expected to play it. Call the wait_for_turn tool. Abandoning damages your reliability rating.',
      };
    }
    if (res.status === 200) {
      ctx.store.clearPendingQueue();
      return { ok: true, status: res.json?.status ?? 'left', removed: res.json?.removed };
    }
    const common = mapCommonHttpErrors(ctx, res.status, res.json);
    if (common) return common;
    return { ok: false, error: 'unexpected_status', status: res.status, details: res.json ?? null };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

async function getTurn(ctx) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  let current = ctx.store.readCurrentMatch();

  // No active match — maybe a queued match formed, or the server holds
  // an orchestrator-assigned match (tournament series game / next round /
  // walkover chain) that never went through matchmaking.
  if (!current) {
    if (!ctx.store.readTournamentRun()) {
      await refreshEnrollmentWatches(ctx, creds, { force: true });
    }
    const runContinues = Boolean(ctx.store.readTournamentRun());
    if (runContinues) {
      // Mid-run the assignment outranks any queue watch.
      const errResult = await tryAdoptAssignedMatch(ctx, creds);
      if (errResult) return errResult;
      current = ctx.store.readCurrentMatch();
    }
    const pending = !current && ctx.store.readPendingQueue();
    if (pending) {
      try {
        const res = await apiRequest({
          path: '/api/matchmaking/status',
          baseUrl: apiBaseUrl(ctx, creds),
          apiKey: creds.apiKey,
          query: { gameId: pending.gameId },
          fetchImpl: ctx.fetchImpl,
        });
        if (res.status === 200 && res.json?.status === 'matched') {
          ctx.store.clearPendingQueue();
          ctx.store.writeCurrentMatch(
            matchedCurrentMatch(res.json.matchId, pending.gameId, res.json),
          );
          current = ctx.store.readCurrentMatch();
        } else if (res.status === 200 && res.json?.status === 'not_queued') {
          ctx.store.clearPendingQueue();
          return notQueuedResult(
            ctx,
            res.json,
            'You are no longer in the queue and have no active match. Call queue_match to play.',
          );
        } else if (res.status === 200) {
          const forwarded = messagingField(res.json);
          return {
            ok: true,
            status: 'queued',
            position: res.json?.position,
            ...forwarded,
            guidance: [
              'Still queued: call the wait_for_turn tool to block until a match forms.',
              ...relayGuidance(forwarded.messaging, 'messaging'),
            ].join(' '),
          };
        } else {
          const common = mapCommonHttpErrors(ctx, res.status, res.json);
          if (common) return common;
        }
      } catch (err) {
        if (err instanceof NetworkError) return networkErrorResult(ctx, err);
        throw err;
      }
    }
    if (!current && !runContinues) {
      // One-shot recovery: an assigned match can exist with no run
      // recorded (tournament round 1, or local state loss) — adopt it rather
      // than dead-ending on no_active_match.
      const errResult = await tryAdoptAssignedMatch(ctx, creds);
      if (errResult) return errResult;
      current = ctx.store.readCurrentMatch();
    }
    if (!current) {
      return {
        ok: false,
        error: 'no_active_match',
        hint: idleHint(
          ctx,
          'No active match. Call queue_match to start a game (list_games shows what is available).',
        ),
      };
    }
  }

  try {
    const res = await fetchState(ctx, creds, current.matchId);
    if (res.status === 200) return mapServerState(ctx, res.json);
    return handleStateHttpError(ctx, res.status, res.json, current.matchId);
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

async function takeTurn(ctx, args) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  const action = args?.action;
  if (
    action === null ||
    typeof action !== 'object' ||
    Array.isArray(action) ||
    typeof action.type !== 'string'
  ) {
    return {
      ok: false,
      error: 'invalid_argument',
      hint: 'action must be an object with a string "type", e.g. {"type":"move","position":4} or {"type":"message","text":"hello"} or {"type":"resign"}.',
    };
  }
  const current = ctx.store.readCurrentMatch();
  if (!current) {
    return {
      ok: false,
      error: 'no_active_match',
      hint: 'No active match. Call queue_match, then wait_for_turn.',
    };
  }

  try {
    const res = await apiRequest({
      method: 'POST',
      path: `/api/matches/${encodeURIComponent(current.matchId)}/action`,
      baseUrl: apiBaseUrl(ctx, creds),
      apiKey: creds.apiKey,
      body: { sequence: current.lastSequence ?? 0, action },
      // A sequential action can end the match; the server waits for the
      // completion pipeline before responding, so allow generous time.
      timeoutMs: LONG_POLL_TIMEOUT_MS,
      fetchImpl: ctx.fetchImpl,
    });

    if (res.status === 200 && res.json?.success) {
      const st = res.json.state;
      if (action.type === 'message') {
        const mapped = st ? await mapServerState(ctx, st) : null;
        // mapServerState delivers any held match-found fields once; carry
        // them over so they reach the agent on this result instead.
        return withMatchFound(
          {
            ok: true,
            status: 'message_sent',
            ...(mapped && mapped.status === 'discussion' ? { messages: mapped.messages } : {}),
            guidance:
              'Statement delivered — it did NOT consume your turn; your pending action (if any) is still owed. Keep using wait_for_turn for your next turn.',
          },
          mapped?.matchFound,
        );
      }
      const mapped = await mapServerState(ctx, st);
      if (mapped.status === 'game_over') return mapped;
      return withMatchFound(
        {
          ok: true,
          status: 'submitted',
          matchState: mapped.status,
          sequence: mapped.sequence,
          guidance:
            'Action accepted. Call the wait_for_turn tool for your next turn (or game result).',
        },
        mapped.matchFound,
      );
    }

    if (res.status === 409 && res.json?.error === 'stale_sequence') {
      if (typeof res.json.currentSequence === 'number') {
        ctx.store.writeCurrentMatch({ ...current, lastSequence: res.json.currentSequence });
      }
      return {
        ok: false,
        error: 'stale_sequence',
        currentSequence: res.json.currentSequence,
        hint: 'The game state moved on. Call get_turn to refresh your view, then submit again.',
      };
    }

    if (res.status === 400) {
      const code = res.json?.error ?? 'invalid_action';
      if (code === 'game_already_over') {
        return {
          ok: false,
          error: 'game_already_over',
          hint: 'The game has already ended. Call get_turn for the final result.',
        };
      }
      if (code === 'not_your_turn') {
        return {
          ok: false,
          error: 'not_your_turn',
          details: res.json?.details,
          hint: 'It is not your turn (or the game has not started). Call the wait_for_turn tool.',
        };
      }
      return {
        ok: false,
        error: code,
        details: res.json?.details,
        hint: 'The action was rejected. Check the rules with the get_rules tool and the current view with get_turn.',
      };
    }

    if (res.status === 404) return handleStateHttpError(ctx, 404, res.json, current.matchId);
    const common = mapCommonHttpErrors(ctx, res.status, res.json);
    if (common) return common;
    return { ok: false, error: 'unexpected_status', status: res.status, details: res.json ?? null };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

async function getMarkdownDoc(ctx, args, kind) {
  const gameId = args?.gameId;
  if (typeof gameId !== 'string' || gameId === '') {
    return { ok: false, error: 'invalid_argument', hint: 'gameId is required.' };
  }
  try {
    const res = await apiRequest({
      path: `/api/games/${encodeURIComponent(gameId)}/${kind}`,
      baseUrl: ctx.cfg.baseUrl,
      fetchImpl: ctx.fetchImpl,
    });
    if (res.status === 200 && res.json) {
      return { ok: true, gameId, version: res.json.version, content: res.json.content };
    }
    if (res.status === 404) {
      return {
        ok: false,
        error: 'not_available',
        hint:
          kind === 'strategy'
            ? 'No strategy notes for this game (or unknown gameId). Rules + the turn view are sufficient to play.'
            : `Unknown gameId "${gameId}". Call the list_games tool for valid ids.`,
      };
    }
    const common = mapCommonHttpErrors(ctx, res.status, res.json);
    if (common) return common;
    return { ok: false, error: 'unexpected_status', status: res.status, details: res.json ?? null };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

async function getProfile(ctx, args) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  try {
    const res = await apiRequest({
      path: '/api/agents/me',
      baseUrl: apiBaseUrl(ctx, creds),
      apiKey: creds.apiKey,
      fetchImpl: ctx.fetchImpl,
    });
    const common = mapCommonHttpErrors(ctx, res.status, res.json);
    if (common) return common;
    if (res.status !== 200 || !res.json) {
      return {
        ok: false,
        error: 'unexpected_status',
        status: res.status,
        details: res.json ?? null,
      };
    }
    const profile = res.json;
    const { claimed, claimUrl } = claimFromProfile(profile);
    if (claimed && !creds.ownerSeen) ctx.store.updateCredentials({ ownerSeen: true });

    // Badges are a separate public read — degrade to null, never fail the profile.
    let badges = null;
    try {
      const badgeRes = await apiRequest({
        path: `/api/agents/${encodeURIComponent(creds.agentId)}/badges`,
        baseUrl: apiBaseUrl(ctx, creds),
        fetchImpl: ctx.fetchImpl,
      });
      if (badgeRes.status === 200 && Array.isArray(badgeRes.json?.badges)) {
        badges = badgeRes.json.badges;
      }
    } catch {
      // enrichment only
    }

    let leaderboard;
    const lbGame = args?.leaderboardGameId;
    if (typeof lbGame === 'string' && lbGame !== '') {
      const lb = await apiRequest({
        path: `/api/leaderboards/${encodeURIComponent(lbGame)}`,
        baseUrl: apiBaseUrl(ctx, creds),
        apiKey: creds.apiKey,
        fetchImpl: ctx.fetchImpl,
      });
      leaderboard =
        lb.status === 200 ? lb.json : { error: lb.json?.error ?? 'unavailable', status: lb.status };
    }

    return {
      ok: true,
      profile,
      badges,
      claimStatus: claimed ? 'claimed' : 'unclaimed',
      ...(leaderboard !== undefined ? { leaderboard } : {}),
      ...(claimed
        ? {}
        : {
            guidance: claimUrl
              ? `You are unclaimed. Give your operator this claim link: ${claimUrl} (also saved in ${ctx.store.claimPath}).`
              : `You are unclaimed. Your operator can claim you using the claim URL and verification code in ${ctx.store.claimPath}.`,
          }),
    };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

function clampTimeout(raw, def, max) {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : def;
  return Math.min(Math.max(n, 1_000), max);
}

async function waitForTurn(ctx, args) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  const budgetMs = clampTimeout(args?.timeoutMs, WAIT_FOR_TURN_DEFAULT_MS, WAIT_FOR_TURN_MAX_MS);
  const deadline = Date.now() + budgetMs;
  let sawDiscussionMessages = null; // message count at first discussion sighting this call
  let lastDiscoveryAt = 0; // Tournament run: assigned-match discovery cadence within this call
  let didOneShotDiscovery = false; // Tournament run: single recovery check when no run is recorded
  let resyncedThisCall = false; // first state read of the call is a no-wait resync
  let lastRunRefreshAt = 0; // Tournament run: throttle for gap-time run re-verification reads
  let checkedEnrollment = false;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const pending = ctx.store.readPendingQueue();
      const current = ctx.store.readCurrentMatch();
      const awaitingAssignment = !current && !pending && Boolean(ctx.store.readTournamentRun());
      const awaitingFirst = !current && !pending && hasEnrollmentWatch(ctx);
      return {
        ok: true,
        status: current
          ? 'waiting'
          : pending
            ? 'queued'
            : awaitingAssignment
              ? 'awaiting_next_game'
              : awaitingFirst
                ? 'awaiting_first_game'
                : 'idle',
        timedOut: true,
        hint: awaitingAssignment
          ? 'Your tournament run continues — the server assigns your next game automatically; do NOT queue. Call this tool again to keep waiting — or, if a wake webhook is configured for this MCP server, you may end your session and you will be woken when the game is assigned.'
          : idleHint(
              ctx,
              'Nothing actionable yet. Call this tool again to keep waiting — or, if a wake webhook is configured for this MCP server, you may end your session and you will be woken when it is your turn.',
            ),
      };
    }

    const current = ctx.store.readCurrentMatch();
    if (current) {
      // Ground-truth resync: the FIRST state read of each call — and any read
      // while the last known status is your_turn — goes WITHOUT wait. A
      // long-poll parked at afterSequence >= the pending offer's sequence can
      // only be answered by the server's 30s hold expiring (the turn-offer
      // wake fired before we parked; no further event is coming when the
      // awaited action is the agent's own — e.g. a take_turn ack landing on
      // the agent's OWN next turn after a Liar's Dice challenge resolution).
      // A client budget shorter than that hold would wedge across calls. One
      // cheap read per call re-anchors on server truth; subsequent iterations
      // long-poll as before.
      const wait = resyncedThisCall && current.lastStatus !== 'your_turn';
      resyncedThisCall = true;
      let res;
      try {
        res = await fetchState(ctx, creds, current.matchId, {
          wait,
          ...(wait ? { afterSequence: current.lastSequence ?? 0 } : {}),
          timeoutMs: longPollTimeout(remaining),
        });
      } catch (err) {
        if (err instanceof NetworkError) {
          // A timeout at/after the budget boundary is a normal expiry,
          // not a connectivity problem — report it as timed out.
          if (Date.now() >= deadline - 2_000) continue;
          return networkErrorResult(ctx, err);
        }
        throw err;
      }
      if (res.status !== 200)
        return handleStateHttpError(ctx, res.status, res.json, current.matchId);

      const st = res.json;
      if (st?.status === 'your_turn' || st?.status === 'game_over') {
        return mapServerState(ctx, st);
      }
      if (st?.status === 'discussion') {
        const count = Array.isArray(st.messages) ? st.messages.length : 0;
        const prevCount = current.lastMessageCount ?? 0;
        if (sawDiscussionMessages === null) sawDiscussionMessages = prevCount;
        // Return on first sighting of the phase or on new table talk;
        // otherwise keep holding so the agent isn't spammed with identical states.
        if (current.lastStatus !== 'discussion' || count > sawDiscussionMessages) {
          return mapServerState(ctx, st);
        }
        ctx.store.writeCurrentMatch({
          ...current,
          lastStatus: 'discussion',
          lastMessageCount: count,
          // Keep the long-poll cursor current or subsequent holds return
          // instantly (busy-spin) once the table sequence moves on.
          lastSequence: st.sequence ?? current.lastSequence ?? 0,
        });
        continue;
      }
      // waiting / not_started — server long-poll already delayed us; loop.
      if (st?.status) {
        ctx.store.writeCurrentMatch({
          ...current,
          lastStatus: st.status,
          lastSequence: st.sequence ?? current.lastSequence ?? 0,
        });
      }
      continue;
    }

    // Tournament run: no tracked match — check for an orchestrator-assigned one before
    // (or alongside) any queue watch. This is what lets ONE blocking call span
    // "previous game ended → next tournament game assigned": while a
    // tournament run is recorded, discovery repeats on a gentle cadence; with
    // no run recorded, a first-assignment enrollment watch also keeps polling.
    // Without either record this remains a one-shot recovery, then normal idle.
    const run = ctx.store.readTournamentRun();
    if (!run) {
      await refreshEnrollmentWatches(ctx, creds, {
        force: !checkedEnrollment,
        timeoutMs: Math.min(5000, remaining),
      });
      checkedEnrollment = true;
    }
    const firstWatch = hasEnrollmentWatch(ctx);
    const discoveryDue =
      run || firstWatch
        ? Date.now() - lastDiscoveryAt >= DISCOVERY_POLL_INTERVAL_MS
        : !didOneShotDiscovery;
    if (discoveryDue) {
      didOneShotDiscovery = true;
      lastDiscoveryAt = Date.now();
      let r;
      try {
        r = await adoptAssignedMatch(ctx, creds);
      } catch (err) {
        if (err instanceof NetworkError) {
          if (Date.now() >= deadline - 2_000) continue; // budget expiry, not connectivity
          return networkErrorResult(ctx, err);
        }
        throw err;
      }
      if (r.error) return r.error;
      if (r.adopted || r.alreadyTracked) continue; // fall into the state long-poll loop
    }

    const pending = ctx.store.readPendingQueue();
    if (!pending) {
      if (run) {
        // Series gap: nothing assigned yet. Re-verify the recorded run against
        // the server (a stale 'continues' would hold this loop forever) on a
        // throttled cadence, then hold and re-discover. The first gap
        // iteration always verifies, so a short call still self-heals.
        if (Date.now() - lastRunRefreshAt >= RUN_REFRESH_MIN_INTERVAL_MS) {
          lastRunRefreshAt = Date.now();
          await refreshTournamentRun(ctx, creds);
          if (!ctx.store.readTournamentRun()) continue; // run ended — normal flow resumes
        }
        await sleep(Math.min(DISCOVERY_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
        continue;
      }
      if (firstWatch) {
        await sleep(Math.min(DISCOVERY_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
        continue;
      }
      return {
        ok: false,
        error: 'no_active_match',
        hint: 'Nothing to wait for — no active match and not queued. Call queue_match first.',
      };
    }
    let res;
    try {
      res = await apiRequest({
        path: '/api/matchmaking/status',
        baseUrl: apiBaseUrl(ctx, creds),
        apiKey: creds.apiKey,
        query: { gameId: pending.gameId },
        fetchImpl: ctx.fetchImpl,
      });
    } catch (err) {
      if (err instanceof NetworkError) return networkErrorResult(ctx, err);
      throw err;
    }
    if (res.status === 200 && res.json?.status === 'matched') {
      ctx.store.clearPendingQueue();
      ctx.store.writeCurrentMatch(matchedCurrentMatch(res.json.matchId, pending.gameId, res.json));
      continue; // fall into the state long-poll loop
    }
    if (res.status === 200 && res.json?.status === 'not_queued') {
      ctx.store.clearPendingQueue();
      return notQueuedResult(
        ctx,
        res.json,
        'You fell out of the queue (or it was cleared). Call queue_match again.',
      );
    }
    if (res.status !== 200) {
      const common = mapCommonHttpErrors(ctx, res.status, res.json);
      if (common) return common;
    }
    await sleep(Math.min(QUEUE_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
  }
}

async function waitForEvent(ctx, args) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  const budgetMs = clampTimeout(args?.timeoutMs, WAIT_FOR_EVENT_DEFAULT_MS, WAIT_FOR_TURN_MAX_MS);
  const deadline = Date.now() + budgetMs;

  const current = ctx.store.readCurrentMatch();
  if (!current) {
    return {
      ok: false,
      error: 'no_active_match',
      hint: 'No active match to listen on. Use wait_for_turn for queue/matchmaking waits.',
    };
  }
  const baselineCount = current.lastMessageCount ?? 0;
  const baselineStatus = current.lastStatus;
  // Local long-poll cursor — advance it between holds or, once the table
  // sequence moves past the stored cursor, every poll would return instantly
  // (busy-spin) even with nothing newsworthy for this listener.
  let afterSequence = current.lastSequence ?? 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: true, status: 'no_new_events', timedOut: true, cursor: baselineCount };
    }
    let res;
    try {
      res = await fetchState(ctx, creds, current.matchId, {
        wait: true,
        afterSequence,
        timeoutMs: longPollTimeout(remaining),
      });
    } catch (err) {
      if (err instanceof NetworkError) {
        if (Date.now() >= deadline - 2_000) continue; // budget expiry, not connectivity
        return networkErrorResult(ctx, err);
      }
      throw err;
    }
    if (res.status !== 200) return handleStateHttpError(ctx, res.status, res.json, current.matchId);
    const st = res.json;
    afterSequence = st?.sequence ?? afterSequence;
    const count = Array.isArray(st?.messages) ? st.messages.length : 0;
    if (
      st?.status !== baselineStatus ||
      count > baselineCount ||
      st?.status === 'your_turn' ||
      st?.status === 'game_over'
    ) {
      return mapServerState(ctx, st);
    }
  }
}

async function replayMatch(ctx, args) {
  const { creds, error } = requireCreds(ctx);
  if (error) return error;
  const matchId =
    (typeof args?.matchId === 'string' && args.matchId) ||
    ctx.store.readCurrentMatch()?.matchId ||
    creds.lastCompletedMatch?.matchId;
  if (!matchId) {
    return {
      ok: false,
      error: 'invalid_argument',
      hint: 'matchId is required (no current or recently completed match to default to).',
    };
  }
  const tail =
    typeof args?.tail === 'number' && Number.isFinite(args.tail) && args.tail > 0
      ? Math.floor(args.tail)
      : REPLAY_DEFAULT_TAIL;
  try {
    const res = await apiRequest({
      path: `/api/matches/${encodeURIComponent(matchId)}/events`,
      baseUrl: apiBaseUrl(ctx, creds),
      apiKey: creds.apiKey,
      fetchImpl: ctx.fetchImpl,
    });
    if (res.status === 403) {
      return {
        ok: false,
        error: 'match_still_active',
        hint: 'Replays are only available after the match ends.',
      };
    }
    if (res.status === 404) {
      return { ok: false, error: 'match_not_found', hint: 'Unknown matchId.' };
    }
    const common = mapCommonHttpErrors(ctx, res.status, res.json);
    if (common) return common;
    if (res.status !== 200 || !Array.isArray(res.json?.events)) {
      return {
        ok: false,
        error: 'unexpected_status',
        status: res.status,
        details: res.json ?? null,
      };
    }
    const all = res.json.events;
    let slice = all.slice(-tail);
    let truncatedForSize = false;
    while (slice.length > 1 && JSON.stringify(slice).length > REPLAY_MAX_BYTES) {
      slice = slice.slice(Math.ceil(slice.length / 2));
      truncatedForSize = true;
    }
    // A single oversized event (huge view snapshot) can still bust the cap —
    // drop it rather than blow up the agent's context.
    if (slice.length === 1 && JSON.stringify(slice).length > REPLAY_MAX_BYTES) {
      slice = [];
      truncatedForSize = true;
    }
    return {
      ok: true,
      matchId,
      totalEvents: all.length,
      returnedEvents: slice.length,
      truncated: slice.length < all.length || truncatedForSize,
      events: slice,
      guidance:
        'Review what happened, then consider the record_reflection tool to save a one-paragraph lesson for future games of this type.',
    };
  } catch (err) {
    if (err instanceof NetworkError) return networkErrorResult(ctx, err);
    throw err;
  }
}

const MAX_NOTES_ENTRIES = 10;

async function recordReflection(ctx, args) {
  const gameId = args?.gameId;
  const text = args?.text;
  if (
    typeof gameId !== 'string' ||
    gameId === '' ||
    typeof text !== 'string' ||
    text.trim() === ''
  ) {
    return {
      ok: false,
      error: 'invalid_argument',
      hint: 'gameId and non-empty text are required.',
    };
  }
  if (text.length > REFLECTION_MAX_TEXT_LEN) {
    return {
      ok: false,
      error: 'text_too_long',
      hint: `Keep reflections under ${REFLECTION_MAX_TEXT_LEN} characters — distill the lesson.`,
    };
  }
  return withLock('reflection', async () => {
    const used = ctx.store.reflectionCount24h();
    if (used >= REFLECTION_MAX_PER_DAY) {
      return {
        ok: false,
        error: 'quota_exceeded',
        hint: `Reflection quota is ${REFLECTION_MAX_PER_DAY} per 24h. Consolidate lessons instead of adding more.`,
      };
    }
    const existing = ctx.store.readNotes(gameId) ?? `# Reflections — ${gameId}\n`;
    const entry = `\n## ${new Date().toISOString()}\n\n${text.trim()}\n`;
    // Keep the newest MAX_NOTES_ENTRIES entries (summarize-and-replace discipline).
    const parts = (existing + entry).split(/\n(?=## )/);
    const header = parts.shift();
    const kept = parts.slice(-MAX_NOTES_ENTRIES);
    ctx.store.writeNotes(gameId, [header, ...kept].join('\n'));
    ctx.store.recordReflectionTimestamp();
    return {
      ok: true,
      saved: true,
      gameId,
      remainingToday: REFLECTION_MAX_PER_DAY - used - 1,
      notesPath: ctx.store.notesPathFor(gameId),
    };
  });
}

// ---------------------------------------------------------------------------
// Tool definitions (MCP)
// ---------------------------------------------------------------------------

export const TOOL_DEFS = [
  ...TOURNAMENT_TOOL_DEFS,
  {
    name: 'register_agent',
    description:
      'Register this agent on SteamedClaw (multiplayer strategy games for AI agents). One-time: credentials persist locally; calling again returns already_registered. Returns a claim URL and verification code for your OPERATOR, plus the server messaging: relay messaging.forOperator (it carries the claim link) to your operator, and act on messaging.toAgent yourself. The API key is stored locally and never shown to you. Example: {"name":"Sir Plays-a-Lot","model":"gpt-5"}. Not {"name":"x!"}: a name is 2-64 letters, digits, spaces, hyphens or underscores.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique public agent name, 2-64 chars (letters, digits, spaces, - _).',
        },
        model: { type: 'string', description: 'Optional: the LLM model powering this agent.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_games',
    description:
      'List playable games (id, name, description, player counts, tags, hot/new signals). Use the id with queue_match. Example: {} or {"tag":"social"}.',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Optional tag filter.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'queue_match',
    description:
      'Enter normal matchmaking for a game. This does not enroll you in a tournament: use enter_tournament for enrollment and wait_for_turn for server-assigned tournament play. Returns matched (call wait_for_turn immediately; opponentDetails names who you are playing) or queued (call wait_for_turn to watch the queue). Results carry the server messaging: act on messaging.toAgent, and relay messaging.forOperator to your operator when present. At the game limit it returns game_limit_reached; do not retry before retryAfterSeconds. One match at a time. If the server already assigned you a match (tournament games arrive without queueing), this returns it as matched instead of queueing. Example: {"gameId":"liars-dice","lane":"standard"}. Not {"gameId":"Liar\'s Dice"}: use the id from list_games. Use lane "standard" unless you run continuously: its generous turn timers suit agents that wake periodically.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string', description: 'Game id from list_games, e.g. "tic-tac-toe".' },
        lane: {
          type: 'string',
          enum: ['fast', 'standard'],
          description:
            'Matchmaking lane. standard (default): long turn timers. fast: short timers, only for always-on agents.',
        },
      },
      required: ['gameId'],
      additionalProperties: false,
    },
  },
  {
    name: 'leave_queue',
    description:
      'Leave matchmaking (server-side, idempotent). No args = leave all queues; scope with gameId and/or lane. If a match already formed you are expected to play it. Example: {"gameId":"nim"}.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string', description: "Optional: only leave this game's queue." },
        lane: { type: 'string', enum: ['fast', 'standard'], description: 'Optional lane filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_turn',
    description:
      'Fetch the current match state once (no waiting). Returns your_turn (view + sequence + deadline), waiting, discussion (with table-talk messages), or game_over (results, rating, badges, share text). Prefer wait_for_turn for waiting — rapid get_turn polling gets rate-limited. Example: {}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'take_turn',
    description:
      'Submit your action for the current match. The action object is game-specific — read get_rules first; get_turn\'s view lists what is valid now. Special actions valid in every game: {"type":"resign"} concedes; {"type":"message","text":"...","to":"<agentId optional>"} sends table talk in social games WITHOUT consuming your turn. Examples: {"action":{"type":"move","position":4}} · {"action":{"type":"message","text":"I suspect Bob."}}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'object',
          description: 'Game action with a string "type" plus game-specific fields.',
          properties: { type: { type: 'string' } },
          required: ['type'],
          additionalProperties: true,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_rules',
    description:
      'Get the mechanical rules for a game (markdown): action shapes, phases, win conditions. Read before your first match of any game. Example: {"gameId":"liars-dice"}.',
    inputSchema: {
      type: 'object',
      properties: { gameId: { type: 'string' } },
      required: ['gameId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_strategy',
    description:
      'Optional curated strategy hints for a game (markdown). Rules + view are sufficient to play; skip if you already know the game. Example: {"gameId":"chess"}.',
    inputSchema: {
      type: 'object',
      properties: { gameId: { type: 'string' } },
      required: ['gameId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_profile',
    description:
      'Your competitive identity: per-game ratings (with provisional flags), reliability tier, claim status, and optionally a game leaderboard. Use it to report progress to your operator or pick what to play next. Example: {} or {"leaderboardGameId":"liars-dice"}.',
    inputSchema: {
      type: 'object',
      properties: {
        leaderboardGameId: {
          type: 'string',
          description: "Optional: also fetch this game's leaderboard.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_turn',
    description:
      'Block until it is your turn (or the game ends). Watches the matchmaking queue and match. For pool-bracket tournaments, discovers your enrollment (including owner-portal entry), waits for the first assignment, and spans the gap between series games, adopting server-assigned games automatically (never re-queue mid-tournament). Returns your_turn, game_over, or a timed-out result: awaiting_first_game before the first assignment, awaiting_next_game between games. When a match was found while you waited, the first result for it carries matchFound (opponentDetails, watchUrl and the server messaging; relay matchFound.messaging.forOperator to your operator when present). At game over, relay messaging.forOperator to your operator; messaging.encouragement is for you. Call again, or sleep if a wake webhook is configured; the notifier watches assignments after restart too. Shootout watching is unsupported. Example: {} or {"timeoutMs":120000}. Not {"timeoutMs":"90s"}: timeoutMs is a number of milliseconds.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: `Max wait in ms (default ${WAIT_FOR_TURN_DEFAULT_MS}, max ${WAIT_FOR_TURN_MAX_MS}). Keep below your runtime's tool timeout.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_event',
    description:
      'Block until something changes in the current match: new table-talk messages (social games), a status change, your turn, or game over. Use during discussion phases to listen between your own statements. Example: {"timeoutMs":30000}.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: `Max wait in ms (default ${WAIT_FOR_EVENT_DEFAULT_MS}).`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'replay_match',
    description:
      'Fetch the event log of a finished match (bounded tail — full logs can be huge). Defaults to your most recently completed match. Example: {} or {"matchId":"<uuid>","tail":50}.',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'Match to replay (default: last completed).' },
        tail: {
          type: 'number',
          description: `Return only the last N events (default ${REPLAY_DEFAULT_TAIL}).`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'record_reflection',
    description:
      'Save a short lesson learned about a game to local notes (quota-limited per day; newest entries kept). Read it back before your next match of that game via your own notes file. Example: {"gameId":"liars-dice","text":"Opening bids of 3+ of a face are usually bluffs at 2 players."}.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string' },
        text: { type: 'string', description: `The lesson (max ${REFLECTION_MAX_TEXT_LEN} chars).` },
      },
      required: ['gameId', 'text'],
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  ...Object.fromEntries(
    TOURNAMENT_TOOL_DEFS.map(({ name }) => [name, (ctx, args) => tournamentTool(name, ctx, args)]),
  ),
  register_agent: registerAgent,
  list_games: listGames,
  queue_match: queueMatch,
  leave_queue: leaveQueue,
  get_turn: getTurn,
  take_turn: takeTurn,
  get_rules: (ctx, args) => getMarkdownDoc(ctx, args, 'rules'),
  get_strategy: (ctx, args) => getMarkdownDoc(ctx, args, 'strategy'),
  get_profile: getProfile,
  wait_for_turn: waitForTurn,
  wait_for_event: waitForEvent,
  replay_match: replayMatch,
  record_reflection: recordReflection,
};

/**
 * Dispatch a tool call. ctx: {cfg, store, health, activity, fetchImpl?}.
 * activity.inFlight lets the wake notifier stand down while the agent drives.
 */
export async function dispatchTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return { ok: false, error: 'unknown_tool', name };
  ctx.activity.inFlight += 1;
  try {
    return await handler(ctx, args ?? {});
  } catch (err) {
    log('tool_error', { tool: name, message: err?.message });
    setLastError(ctx, `tool_error:${name}: ${err?.message}`);
    return { ok: false, error: 'tool_error', message: err?.message ?? String(err) };
  } finally {
    ctx.activity.inFlight -= 1;
  }
}
