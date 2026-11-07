// First-assignment watching is separate from the game-over-driven run record.
// The server remains authoritative for enrollment, format and lifecycle. Only
// pool-bracket is supported; no owner credentials or owner endpoints are used.
import { apiRequest, NetworkError, log } from './http-client.mjs';
import { apiBaseUrl } from './state.mjs';
import { DISCOVERY_POLL_INTERVAL_MS, WAKE_IDLE_DISCOVERY_INTERVAL_MS } from './config.mjs';

const LIVE_STATUSES = new Set(['announced', 'registration', 'qualifying', 'seeding', 'bracket']);
// The entry statuses (GET /api/tournaments/:id/me) that end any watch.
// entered arms one; waitlisted keeps one with no entry id; any other value is
// not evidence of anything.
const FINAL_ENTRY_STATUSES = new Set([
  'not_entered',
  'withdrawn',
  'forfeited',
  'eliminated',
  'closed_out',
]);
const states = new WeakMap();
function stateFor(ctx) {
  if (!states.has(ctx))
    states.set(ctx, { tail: Promise.resolve(), lastScan: null, resumeTournamentId: null });
  return states.get(ctx);
}
function serialized(ctx, fn) {
  const state = stateFor(ctx);
  const next = state.tail.then(fn, fn);
  state.tail = next.catch(() => undefined);
  return next;
}

// Read-modify-write at commit time: adoption may consume an entry during an
// in-flight scan. Never restore that stale scan's unconsumed snapshot.
function update(ctx, tournamentId, fn) {
  const entries = ctx.store.readEnrollmentWatches();
  const old = entries.find((entry) => entry.tournamentId === tournamentId);
  const next = fn(old);
  const rest = entries.filter((entry) => entry.tournamentId !== tournamentId);
  if (next) rest.push(next);
  if (JSON.stringify(entries) !== JSON.stringify(rest)) ctx.store.writeEnrollmentWatches(rest);
}

/** An armed first-assignment watch: an entry with no assigned game yet. A
 * waitlist place (entryId null) is kept and scanned, but is not armed. */
export function hasEnrollmentWatch(ctx) {
  return ctx.store
    .readEnrollmentWatches()
    .some((entry) => typeof entry.entryId === 'string' && !entry.assignedMatchId);
}

export function enrollmentAssignment(ctx) {
  const entry = ctx.store
    .readEnrollmentWatches()
    .find((entry) => !entry.assignedMatchId && entry.matchIds?.length && entry.gameId);
  return entry
    ? { found: true, matchId: entry.matchIds[0], gameId: entry.gameId, finished: false }
    : null;
}

// Called AFTER current-match.json is written. A restart can recover the slot
// even if it interrupts before this second atomic write.
export function consumeEnrollmentAssignment(ctx, matchId) {
  for (const entry of ctx.store.readEnrollmentWatches()) {
    if (!entry.assignedMatchId && entry.matchIds?.includes(matchId)) {
      update(ctx, entry.tournamentId, (latest) => ({ ...latest, assignedMatchId: matchId }));
    }
  }
}

/** The watch entry id an entry status body supports: a string for entered,
 * null for waitlisted, undefined when the body supports no watch. */
function watchEntryId(status) {
  if (status?.status === 'entered')
    return typeof status.entry?.entryId === 'string' && status.entry.withdrawnAt == null
      ? status.entry.entryId
      : undefined;
  return status?.status === 'waitlisted' ? null : undefined;
}

/** Save the watch an enter_tournament 201 (the entry status) supports. */
export function recordEnrollment(ctx, status) {
  const entryId = watchEntryId(status);
  if (typeof status?.tournamentId !== 'string' || entryId === undefined) return;
  return serialized(ctx, () => {
    update(ctx, status.tournamentId, (old) =>
      old?.entryId === entryId
        ? old
        : {
            tournamentId: status.tournamentId,
            entryId,
            matchIds: [],
          },
    );
    stateFor(ctx).lastScan = null;
  });
}

/** Drop the watch for one tournament (the agent withdrew or left its waitlist). */
export function dropEnrollmentWatch(ctx, tournamentId) {
  return serialized(ctx, () => {
    update(ctx, tournamentId, () => null);
    stateFor(ctx).lastScan = null;
  });
}

/** Discover owner-portal entries too, including after a process restart.
 * Transient failures retain known watches; only authoritative absence or a
 * terminal state clears them. The in-memory throttle deliberately resets on
 * restart, while both pending and consumed enrollment records survive.
 */
export function refreshEnrollmentWatches(ctx, creds, { force = false, timeoutMs = 5000 } = {}) {
  return serialized(ctx, async () => {
    const state = stateFor(ctx);
    const interval = hasEnrollmentWatch(ctx)
      ? DISCOVERY_POLL_INTERVAL_MS
      : WAKE_IDLE_DISCOVERY_INTERVAL_MS;
    if (!force && state.lastScan !== null && Date.now() - state.lastScan < interval) return;
    state.lastScan = Date.now();
    const deadline = Date.now() + timeoutMs;
    const read = (path, auth = false) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NetworkError('Enrollment scan budget expired');
      return apiRequest({
        path,
        baseUrl: apiBaseUrl(ctx, creds),
        apiKey: auth ? creds.apiKey : null,
        fetchImpl: ctx.fetchImpl,
        timeoutMs: remaining,
        retryOn429: false,
      });
    };
    try {
      const catalog = await read('/api/tournaments');
      if (catalog.status !== 200 || !Array.isArray(catalog.json?.tournaments)) return;
      let cards = [...catalog.json.tournaments];
      const missing = new Set();
      // Keep missing cards until a direct read proves absence. A catalog read
      // may race successful entry or be served from an incomplete snapshot.
      for (const known of ctx.store.readEnrollmentWatches()) {
        if (!cards.some((card) => card?.id === known.tournamentId)) {
          missing.add(known.tournamentId);
          cards.push({ id: known.tournamentId });
        }
      }
      // Resume the interrupted card, including its schedule read, rather than
      // repeatedly spending the whole budget on the same catalog prefix.
      const resumeAt = cards.findIndex((card) => card?.id === state.resumeTournamentId);
      if (resumeAt > 0) cards = [...cards.slice(resumeAt), ...cards.slice(0, resumeAt)];
      for (let card of cards) {
        if (typeof card?.id !== 'string') continue;
        state.resumeTournamentId = card.id;
        if (missing.has(card.id)) {
          const detail = await read(`/api/tournaments/${encodeURIComponent(card.id)}`);
          if (detail.status === 404) {
            update(ctx, card.id, () => null);
            continue;
          }
          if (detail.status !== 200 || detail.json?.id !== card.id) continue;
          card = detail.json;
        }
        if (card.format !== 'pool-bracket' || !LIVE_STATUSES.has(card.status)) {
          // Unknown/malformed responses aren't evidence of termination.
          if (card.format === 'shootout' || ['completed', 'cancelled'].includes(card.status))
            update(ctx, card.id, () => null);
          continue;
        }
        const root = `/api/tournaments/${encodeURIComponent(card.id)}`;
        // /me answers 200 for every status, so only its status ends
        // a watch; any other answer is transient.
        const mine = await read(`${root}/me`, true);
        if (
          mine.status !== 200 ||
          mine.json?.tournamentId !== card.id ||
          mine.json?.agentId !== creds.agentId
        )
          continue;
        if (FINAL_ENTRY_STATUSES.has(mine.json.status)) {
          update(ctx, card.id, () => null);
          continue;
        }
        const entryId = watchEntryId(mine.json);
        if (entryId === undefined) continue;
        update(ctx, card.id, (old) =>
          old?.entryId === entryId
            ? old
            : { tournamentId: card.id, entryId, gameId: card.gameId, matchIds: [] },
        );
        // A waitlist place has no series to read until the server makes it
        // an entry; a later scan arms the watch when /me reads entered.
        if (entryId === null) continue;
        if (
          ctx.store.readEnrollmentWatches().find((entry) => entry.tournamentId === card.id)
            ?.assignedMatchId
        )
          continue;
        const schedule = await read(`${root}/my-schedule`, true);
        const view = schedule.json;
        if (schedule.status === 404 && view?.error === 'tournament_not_found') {
          update(ctx, card.id, () => null);
          continue;
        }
        if (schedule.status !== 200 || view?.tournamentId !== card.id) continue;
        // A non-null eliminated means no more matches here.
        if (
          view.entered === false ||
          view.withdrawn === true ||
          view.eliminated != null ||
          ['completed', 'cancelled'].includes(view.tournamentStatus)
        ) {
          update(ctx, card.id, () => null);
          continue;
        }
        if (view.entered !== true || view.withdrawn !== false) continue;
        const matchIds = Array.isArray(view.current?.matchIds)
          ? view.current.matchIds.filter((id) => typeof id === 'string' && id.length > 0)
          : [];
        update(ctx, card.id, (old) => ({ ...old, gameId: card.gameId, matchIds }));
        const current = ctx.store.readCurrentMatch();
        const last = ctx.store.readCredentials()?.lastCompletedMatch;
        // Recover a crash between slot adoption and consuming the watch, or
        // first discovery after an assigned game was played via normal tools.
        if (current && matchIds.includes(current.matchId))
          consumeEnrollmentAssignment(ctx, current.matchId);
        else if (last && matchIds.includes(last.matchId))
          consumeEnrollmentAssignment(ctx, last.matchId);
      }
      state.resumeTournamentId = null;
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
      log('enrollment_watch_unavailable', { message: err.message });
    }
  });
}
