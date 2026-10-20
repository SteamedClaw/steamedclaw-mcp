// HTTP client for the SteamedClaw public API.
//
// - Bearer auth + versioned User-Agent
// - 429 retry: body retryAfterMs → Retry-After header → capped exponential
//   fallback + jitter; double-bounded by attempt count AND cumulative delay
//   budget (posture ported from an earlier prototype, live-validated there)
// - Secret redaction on every log line and on error details

import {
  USER_AGENT,
  HTTP_TIMEOUT_MS,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_TOTAL_DELAY_MS,
  RATE_LIMIT_FALLBACK_INITIAL_MS,
  RATE_LIMIT_FALLBACK_MAX_MS,
  RATE_LIMIT_JITTER_MAX_MS,
} from './config.mjs';

const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'bearer',
  'access_token',
  'refresh_token',
  'token',
  'password',
  'secret',
]);

function redactString(s) {
  // Below 12 chars the 4+4 preview would reveal most or all of the secret.
  if (typeof s !== 'string' || s.length < 12) return '[redacted]';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

/** Recursively redact secret-shaped keys and inline Bearer tokens. */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const norm = k.replace(/-/g, '_').toLowerCase();
      if (SENSITIVE_KEYS.has(norm) && typeof v === 'string') {
        out[k] = redactString(v);
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  if (typeof value === 'string' && /Bearer\s+\S+/.test(value)) {
    return value.replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
  }
  return value;
}

/** Structured single-line stderr log, always redacted. */
export function log(event, fields = {}) {
  try {
    // Spread fields first so the log's own event label always wins over a
    // same-named payload field (e.g. wake payloads carry an `event` too).
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), ...redactSecrets(fields), event }) + '\n',
    );
  } catch {
    // logging must never throw
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterBodyMs(json) {
  const v = json && typeof json === 'object' ? json.retryAfterMs : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Retry-After header (delta-seconds or HTTP-date) in ms, or null when absent/unparseable. */
export function retryAfterHeaderMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function rateLimitDelayMs(json, headers, retryIndex) {
  let requested = retryAfterBodyMs(json);
  if (requested === null) requested = retryAfterHeaderMs(headers);
  if (requested === null) {
    requested = Math.min(
      RATE_LIMIT_FALLBACK_MAX_MS,
      RATE_LIMIT_FALLBACK_INITIAL_MS * 2 ** retryIndex,
    );
  }
  const jitter = Math.floor(Math.random() * (RATE_LIMIT_JITTER_MAX_MS + 1));
  return Math.max(0, Math.floor(requested) + jitter);
}

/** Error thrown on network-level failure (never for HTTP status codes). */
export class NetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Perform an API request. Returns {status, json, headers}; never throws on
 * HTTP error statuses (callers map them), throws NetworkError on transport
 * failure and timeout.
 *
 * options: {method, path, baseUrl, apiKey?, body?, query?, timeoutMs?, retryOn429?}
 */
export async function apiRequest({
  method = 'GET',
  path,
  baseUrl,
  apiKey = null,
  body = undefined,
  query = undefined,
  timeoutMs = HTTP_TIMEOUT_MS,
  retryOn429 = true,
  fetchImpl = fetch,
}) {
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let retryIndex = 0;
  let totalDelayMs = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message;
      log('api_network_error', { method, path, reason });
      throw new NetworkError(`${method} ${path} failed: ${reason}`, err);
    }
    clearTimeout(timer);

    let json = null;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (res.status === 429 && retryOn429 && retryIndex < RATE_LIMIT_MAX_RETRIES) {
      const delayMs = rateLimitDelayMs(json, res.headers, retryIndex);
      if (totalDelayMs + delayMs <= RATE_LIMIT_TOTAL_DELAY_MS) {
        log('api_rate_limited_retry', { method, path, retryIndex, delayMs });
        await sleep(delayMs);
        totalDelayMs += delayMs;
        retryIndex += 1;
        continue;
      }
    }

    return { status: res.status, json, headers: res.headers };
  }
}
