// Wake notifier — optional, inert unless STEAMEDCLAW_WAKE_WEBHOOK_URL is set.
//
// Watches the game server while the agent is asleep (no tool call in flight)
// and POSTs a small JSON notice to the runtime's inbound-webhook intake on
// match_found / your_turn / game_over, so an event-wakeable runtime (Moltis,
// Hermes) starts an agent run within seconds instead of waiting for its next
// heartbeat.
//
// Verified intake contracts (2026-07-03; Hermes re-verified 2026-07-14 @ 9de9c25f):
//   Hermes: POST :8644/webhooks/<route>; auth (mode "hmac-sha256") = V2 headers
//           X-Webhook-Signature-V2 (HMAC hex of "<unix-seconds>.<body>") +
//           X-Webhook-Timestamp, plus the legacy body-only X-Webhook-Signature
//           (V1) for backward-compatible receivers.
//   Moltis: POST /api/webhooks/ingest/<wh_id>; auth = bearer or static header
//           (modes "bearer" / "header").
//
// One wake per event key (matchId:event:sequence); re-notified only after
// WAKE_DEDUPE_WINDOW_MS as a nudge. Delivery failures are logged and surfaced
// on /health — never fatal.

import { createHmac } from 'node:crypto';
import {
  LONG_POLL_TIMEOUT_MS,
  QUEUE_POLL_INTERVAL_MS,
  WAKE_DEDUPE_WINDOW_MS,
  WAKE_ERROR_BACKOFF_MS,
  WAKE_IDLE_DISCOVERY_INTERVAL_MS,
  DISCOVERY_POLL_INTERVAL_MS,
} from './config.mjs';
import { apiRequest, NetworkError, log } from './http-client.mjs';
import { adoptAssignedMatch, refreshTournamentRun, recordSkippedMatch } from './tools.mjs';
import { refreshEnrollmentWatches, hasEnrollmentWatch } from './enrollment-watch.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeWakeNotifier(ctx) {
  const wake = ctx.cfg.wake;
  let running = false;
  let loopPromise = null;
  const notified = new Map(); // eventKey -> lastSentAt
  // Watch cursor for the long-poll hold, IN-MEMORY and separate from the
  // agent's own stored cursor (which must stay where the agent last read).
  // Without it, once the table sequence advances past the stored cursor
  // (any 3+ player game, any discussion phase), every wait=true request
  // returns immediately and the watcher becomes a tight request loop.
  let watch = { matchId: null, seq: 0 };
  const status = {
    configured: Boolean(wake),
    lastWakeAt: null,
    lastWakeEvent: null,
    lastError: null,
  };

  /** Interruptible sleep — returns early when the notifier is stopped. */
  async function pause(ms) {
    const deadline = Date.now() + ms;
    while (running && Date.now() < deadline) {
      await sleep(Math.min(250, deadline - Date.now()));
    }
  }

  async function sendWake(event, payload) {
    const key = `${payload.matchId ?? 'none'}:${event}:${payload.sequence ?? 0}`;
    const last = notified.get(key) ?? 0;
    if (Date.now() - last < WAKE_DEDUPE_WINDOW_MS) return false;
    // Bound the dedupe map: entries older than the window can never suppress
    // again, so prune them once the map grows past a handful of matches.
    if (notified.size > 50) {
      for (const [k, t] of notified) {
        if (Date.now() - t >= WAKE_DEDUPE_WINDOW_MS) notified.delete(k);
      }
    }

    const body = JSON.stringify({
      source: 'steamedclaw-mcp',
      event,
      ...payload,
      message: payload.message,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (wake.authMode === 'hmac-sha256') {
      if (wake.secret) {
        // Deprecated legacy V1: body-only HMAC. Sent alongside V2 so receivers
        // still on the old scheme keep working during migration.
        headers['X-Webhook-Signature'] = createHmac('sha256', wake.secret)
          .update(body)
          .digest('hex');
        // Current V2 (Hermes gateway/platforms/webhook.py @ 9de9c25f): HMAC of
        // "<unix-seconds>.<body>" with the timestamp echoed for replay defense.
        // A receiver that sees the V2 header commits to V2 (no V1 fallback).
        const timestamp = Math.floor(Date.now() / 1000).toString();
        headers['X-Webhook-Timestamp'] = timestamp;
        headers['X-Webhook-Signature-V2'] = createHmac('sha256', wake.secret)
          .update(`${timestamp}.${body}`)
          .digest('hex');
      }
    } else if (wake.authMode === 'bearer') {
      if (wake.secret) headers['Authorization'] = `Bearer ${wake.secret}`;
    } else if (wake.authMode === 'header') {
      if (wake.secret) headers[wake.headerName] = wake.secret;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await (ctx.fetchImpl ?? fetch)(wake.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 300) {
        notified.set(key, Date.now());
        status.lastWakeAt = new Date().toISOString();
        status.lastWakeEvent = event;
        status.lastError = null;
        log('wake_sent', { event, matchId: payload.matchId, status: res.status });
        return true;
      }
      status.lastError = `wake_http_${res.status}`;
      log('wake_failed', { event, status: res.status });
      return false;
    } catch (err) {
      status.lastError = `wake_error: ${err?.message}`;
      log('wake_failed', { event, reason: err?.message });
      return false;
    }
  }

  async function cycle() {
    // Stand down while the agent itself is driving (a tool call is in flight).
    if (ctx.activity.inFlight > 0) {
      await pause(1_000);
      return;
    }
    const creds = ctx.store.readCredentials();
    if (!creds) {
      await pause(5_000);
      return;
    }

    // A normal queue is independent of tournament assignment. Discover portal
    // enrollment even while queued, then let both watches make progress.
    if (!ctx.store.readCurrentMatch() && !ctx.store.readTournamentRun())
      await refreshEnrollmentWatches(ctx, creds);

    const pending = ctx.store.readPendingQueue();
    if (pending && !ctx.store.readCurrentMatch()) {
      const res = await apiRequest({
        path: '/api/matchmaking/status',
        baseUrl: creds.server,
        apiKey: creds.apiKey,
        query: { gameId: pending.gameId },
        fetchImpl: ctx.fetchImpl,
      });
      if (res.status === 200 && res.json?.status === 'matched') {
        ctx.store.clearPendingQueue();
        ctx.store.writeCurrentMatch({
          matchId: res.json.matchId,
          gameId: pending.gameId,
          lastSequence: 0,
          lastStatus: 'matched',
        });
        await sendWake('match_found', {
          matchId: res.json.matchId,
          gameId: pending.gameId,
          message:
            'SteamedClaw: a match was found and the game is starting. Call the wait_for_turn tool from the steamedclaw MCP server to play your turn.',
        });
        return;
      }
      if (res.status === 200 && res.json?.status === 'not_queued') {
        ctx.store.clearPendingQueue();
        return;
      }
      if (!hasEnrollmentWatch(ctx)) {
        await pause(QUEUE_POLL_INTERVAL_MS);
        return;
      }
      // Still queued: check the enrollment assignment too, retaining the queue.
    }

    const current = ctx.store.readCurrentMatch();
    if (!current) {
      // Tournament run: while a tournament run continues, the next game is created
      // server-side with no queue entry — discover and adopt it so a sleeping
      // agent still gets its wake. Enrollment discovery also covers the first
      // assignment; non-entrants never trigger assigned-match discovery here.
      if (ctx.store.readTournamentRun() || hasEnrollmentWatch(ctx)) {
        const r = await adoptAssignedMatch(ctx, creds); // NetworkError → cycle catch
        if (r.adopted) {
          if (!r.finished) {
            await sendWake('match_found', {
              matchId: r.matchId,
              gameId: r.gameId,
              message:
                'SteamedClaw: your next tournament game has been assigned and is starting. Call the wait_for_turn tool from the steamedclaw MCP server to play it.',
            });
          }
          // A finished (unseen) game just long-polls to game_over next cycle,
          // which sends the game_over wake — no separate event needed.
          return;
        }
        if (r.error) {
          await pause(WAKE_ERROR_BACKOFF_MS);
          return;
        }
        if (!r.alreadyTracked) {
          // Nothing assigned: re-verify the recorded run isn't stale (see
          // refreshTournamentRun) before idling on the discovery cadence.
          await refreshTournamentRun(ctx, creds);
          await pause(
            hasEnrollmentWatch(ctx) ? DISCOVERY_POLL_INTERVAL_MS : WAKE_IDLE_DISCOVERY_INTERVAL_MS,
          );
        }
        return;
      }
      await pause(5_000);
      return;
    }

    // Hold the server long-poll on the in-memory watch cursor (see above).
    // The agent's stored cursor is never advanced by the watcher.
    if (watch.matchId !== current.matchId) {
      watch = { matchId: current.matchId, seq: current.lastSequence ?? 0 };
    }
    const res = await apiRequest({
      path: `/api/matches/${encodeURIComponent(current.matchId)}/state`,
      baseUrl: creds.server,
      apiKey: creds.apiKey,
      query: { wait: 'true', afterSequence: watch.seq },
      timeoutMs: LONG_POLL_TIMEOUT_MS,
      fetchImpl: ctx.fetchImpl,
    });
    if (res.status === 404 || res.status === 403) {
      ctx.store.clearCurrentMatch();
      // Tournament run: without recording the skip, mid-run discovery would re-adopt the
      // vanished match next cycle (adopt→404→adopt, unpaced). Same guard the
      // tool path's handleStateHttpError applies.
      recordSkippedMatch(ctx, current.matchId);
      await pause(1_000);
      return;
    }
    if (res.status !== 200 || !res.json) {
      await pause(WAKE_ERROR_BACKOFF_MS);
      return;
    }
    const st = res.json;
    if (typeof st.sequence === 'number' && st.sequence > watch.seq) {
      watch.seq = st.sequence;
    }
    if (st.status === 'your_turn') {
      const sent = await sendWake('your_turn', {
        matchId: current.matchId,
        gameId: current.gameId,
        sequence: st.sequence,
        ...(st.turnEndsAt ? { turnEndsAt: st.turnEndsAt } : {}),
        message: `SteamedClaw: it is your turn in ${current.gameId}${st.turnEndsAt ? ` (act before ${st.turnEndsAt})` : ''}. Call the get_turn tool from the steamedclaw MCP server, then take_turn.`,
      });
      // Back off after notifying so we don't hammer the same pending turn;
      // the dedupe window turns later cycles into a gentle re-nudge.
      await pause(sent ? 30_000 : WAKE_ERROR_BACKOFF_MS);
      return;
    }
    if (st.status === 'game_over') {
      await sendWake('game_over', {
        matchId: current.matchId,
        gameId: current.gameId,
        message:
          'SteamedClaw: your match has ended. Call the get_turn tool from the steamedclaw MCP server for the result, rating change, and share text.',
      });
      // Leave current-match.json in place: the agent's own get_turn read
      // fetches the full terminal envelope and clears it.
      await pause(30_000);
      return;
    }
    // waiting / discussion — the long-poll itself was the delay; loop again.
  }

  return {
    status,
    start() {
      if (!wake || running) return;
      running = true;
      loopPromise = (async () => {
        log('wake_notifier_started', { url: wake.url, authMode: wake.authMode });
        while (running) {
          try {
            await cycle();
          } catch (err) {
            status.lastError =
              err instanceof NetworkError
                ? `network_error: ${err.message}`
                : `error: ${err?.message}`;
            log('wake_cycle_error', { reason: err?.message });
            await pause(WAKE_ERROR_BACKOFF_MS);
          }
        }
      })();
    },
    async stop() {
      running = false;
      await loopPromise?.catch(() => undefined);
    },
  };
}
