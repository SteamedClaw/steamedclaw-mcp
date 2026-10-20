// Configuration for the SteamedClaw MCP server.
//
// All values are read from the environment at call time (not import time) so
// tests can set env per-case. The one import-time constant is the package
// version, which is the single source for the MCP server identity and the
// HTTP User-Agent.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

/** Package version — single source for server identity + User-Agent. */
export const VERSION = PKG.version;
export const USER_AGENT = `steamedclaw-mcp/${VERSION}`;
export const SERVER_NAME = 'steamedclaw-mcp';

// --- Tunables (constants; override points can be added when a real need appears) ---

/** 429 retry: max retry attempts per request. */
export const RATE_LIMIT_MAX_RETRIES = 4;
/** 429 retry: cumulative delay budget per request (ms). */
export const RATE_LIMIT_TOTAL_DELAY_MS = 10_000;
/** 429 retry: exponential fallback initial/max (ms) when no server hint. */
export const RATE_LIMIT_FALLBACK_INITIAL_MS = 250;
export const RATE_LIMIT_FALLBACK_MAX_MS = 2_000;
/** 429 retry: jitter upper bound (ms). */
export const RATE_LIMIT_JITTER_MAX_MS = 100;

/** Default per-request HTTP timeout (ms); long-polls get the server hold + slack. */
export const HTTP_TIMEOUT_MS = 20_000;
/** Game-over claim-status read: short, so a slow server barely delays the result (ms). */
export const CLAIM_CHECK_TIMEOUT_MS = 5_000;
/** Server holds ?wait=true long-polls up to 30s; allow that plus slack. */
export const LONG_POLL_TIMEOUT_MS = 40_000;

/** wait_for_turn: default and max overall wait budget (ms). */
export const WAIT_FOR_TURN_DEFAULT_MS = 90_000;
export const WAIT_FOR_TURN_MAX_MS = 600_000;
/** wait_for_event: default overall wait budget (ms). */
export const WAIT_FOR_EVENT_DEFAULT_MS = 60_000;
/** Matchmaking status poll cadence while queued (ms). */
export const QUEUE_POLL_INTERVAL_MS = 2_500;
/** Tournament run: assigned-match discovery cadence inside wait_for_turn while a tournament run continues (ms). */
export const DISCOVERY_POLL_INTERVAL_MS = 5_000;
/** Tournament run: wake-notifier idle discovery cadence while a tournament run continues (ms). */
export const WAKE_IDLE_DISCOVERY_INTERVAL_MS = 15_000;
/** Tournament run: how many recent matches an assigned-match discovery read pages over.
 *  Route max is 100; a wide page keeps the delivered-match anchors visible on
 *  backends that page in insertion order (the anchor-invisible pagination
 *  guard refuses adoption otherwise). */
export const DISCOVERY_MATCH_LIST_LIMIT = 50;
/** Tournament run: minimum interval between tournament-run re-verification reads (ms). */
export const RUN_REFRESH_MIN_INTERVAL_MS = 15_000;

/** Bounded tail of buffered chat messages returned on turn results. */
export const MAX_RESULT_MESSAGES = 30;
/** replay_match: default/max event tail and response size cap. */
export const REPLAY_DEFAULT_TAIL = 100;
export const REPLAY_MAX_BYTES = 30_000;

/** record_reflection: rolling 24h quota and text cap. */
export const REFLECTION_MAX_PER_DAY = 5;
export const REFLECTION_MAX_TEXT_LEN = 2_048;

/** Wake notifier: minimum interval between webhook POSTs for the same event key (ms). */
export const WAKE_DEDUPE_WINDOW_MS = 60_000;
/** Wake notifier: idle pause between watch cycles after an error (ms). */
export const WAKE_ERROR_BACKOFF_MS = 15_000;

// --- Base URL allowlist ---
//
// Credential-exfil guard: the Bearer key is sent to STEAMEDCLAW_BASE_URL, so
// only known SteamedClaw hosts (and local dev) are allowed unless explicitly
// overridden. Ported from an earlier prototype's posture.

const ALLOWED_HTTPS_HOSTS = new Set(['steamedclaw.com', 'stage.steamedclaw.com']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

/**
 * Validate and normalize a base URL. Returns the normalized URL string
 * (no trailing slash) or throws with an actionable message.
 */
export function normalizeBaseUrl(raw, { allowUnsafe = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('STEAMEDCLAW_BASE_URL must be a non-empty URL');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`STEAMEDCLAW_BASE_URL is not a valid absolute URL: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error('STEAMEDCLAW_BASE_URL must not embed credentials');
  }
  if (url.search || url.hash) {
    throw new Error('STEAMEDCLAW_BASE_URL must not include a query or fragment');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`STEAMEDCLAW_BASE_URL must be http(s), got ${url.protocol}`);
  }
  if (!allowUnsafe) {
    const host = url.hostname;
    const allowed =
      (url.protocol === 'https:' && ALLOWED_HTTPS_HOSTS.has(host)) || LOCAL_HOSTS.has(host);
    if (!allowed) {
      throw new Error(
        `STEAMEDCLAW_BASE_URL host "${host}" is not on the allowlist ` +
          `(steamedclaw.com, stage.steamedclaw.com, localhost). ` +
          `Set STEAMEDCLAW_ALLOW_UNSAFE_BASE_URL=1 to override — your API key will be sent there.`,
      );
    }
  }
  return url.toString().replace(/\/+$/, '');
}

function envFlag(name) {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/**
 * Resolve the full runtime configuration from the environment.
 * Called per use — never cached — so tests can vary env between cases.
 */
export function config() {
  const baseUrl = normalizeBaseUrl(process.env.STEAMEDCLAW_BASE_URL || 'https://steamedclaw.com', {
    allowUnsafe: envFlag('STEAMEDCLAW_ALLOW_UNSAFE_BASE_URL'),
  });
  const stateDir = process.env.STEAMEDCLAW_STATE_DIR || join(homedir(), '.steamedclaw-mcp');

  const portRaw = parseInt(process.env.PORT || '8765', 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 8765;
  const host = process.env.HOST || '127.0.0.1';

  // Wake notifier — inert unless the URL is set.
  const wakeUrl = process.env.STEAMEDCLAW_WAKE_WEBHOOK_URL || null;
  const wakeAuthMode = process.env.STEAMEDCLAW_WAKE_AUTH_MODE || 'bearer';
  const wakeSecret = process.env.STEAMEDCLAW_WAKE_SECRET || null;
  const wakeHeaderName = process.env.STEAMEDCLAW_WAKE_HEADER_NAME || 'Authorization';
  if (wakeUrl && !['hmac-sha256', 'bearer', 'header'].includes(wakeAuthMode)) {
    throw new Error(
      `STEAMEDCLAW_WAKE_AUTH_MODE must be one of hmac-sha256|bearer|header, got "${wakeAuthMode}"`,
    );
  }
  // Fail fast rather than silently POST unauthenticated/unsigned wakes.
  if (wakeUrl && !wakeSecret) {
    throw new Error(
      'STEAMEDCLAW_WAKE_WEBHOOK_URL is set but STEAMEDCLAW_WAKE_SECRET is not — every wake auth mode needs the secret.',
    );
  }

  return {
    baseUrl,
    stateDir,
    host,
    port,
    wake: wakeUrl
      ? { url: wakeUrl, authMode: wakeAuthMode, secret: wakeSecret, headerName: wakeHeaderName }
      : null,
  };
}
