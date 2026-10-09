#!/usr/bin/env node
// SteamedClaw MCP server — entry point.
//
// Two MCP transports over the same tool core:
//   default : streamable HTTP on HOST:PORT (127.0.0.1:8765) — one long-lived
//             process per agent; fits container fleets (Hermes) and any
//             runtime that connects to an MCP URL. Stateless per-POST
//             Server+Transport instances (the SDK's canonical pattern —
//             sharing one transport breaks after the first response stream).
//   --stdio : newline JSON-RPC over stdin/stdout — the runtime (e.g. Moltis)
//             spawns and owns the process; no port, no daemon to babysit.
//
// GET /health (HTTP mode) reports operator-facing status:
//   {ok, registered, claimed, activeMatch, wake:{...}, lastError}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config, VERSION, SERVER_NAME } from './src/config.mjs';
import { makeStateStore } from './src/state.mjs';
import { redactSecrets, log } from './src/http-client.mjs';
import { TOOL_DEFS, dispatchTool } from './src/tools.mjs';
import { makeWakeNotifier } from './src/wake.mjs';
import { hasEnrollmentWatch } from './src/enrollment-watch.mjs';

function buildMcpServer(ctx) {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const result = await dispatchTool(name, args, ctx);
    // Belt-and-braces: redact secret-shaped fields at the egress boundary too.
    return { content: [{ type: 'text', text: JSON.stringify(redactSecrets(result), null, 2) }] };
  });
  return server;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function healthPayload(ctx, notifier) {
  const creds = ctx.store.readCredentials();
  return {
    ok: true,
    version: VERSION,
    baseUrl: ctx.cfg.baseUrl,
    stateDir: ctx.cfg.stateDir,
    registered: Boolean(creds),
    agentName: creds?.name ?? null,
    claimed: Boolean(creds?.ownerSeen),
    activeMatch: ctx.store.readCurrentMatch()?.matchId ?? null,
    queued: ctx.store.readPendingQueue()?.gameId ?? null,
    tournamentRunContinues: Boolean(ctx.store.readTournamentRun()),
    tournamentAwaitingFirstGame: hasEnrollmentWatch(ctx),
    wake: notifier.status,
    lastError: ctx.health.lastError,
  };
}

export async function startHttpServer(ctx, notifier, { host, port }) {
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(healthPayload(ctx, notifier)));
        return;
      }
      const isMcp = req.url === '/mcp' || req.url?.startsWith('/mcp?');
      if (!isMcp) {
        res.writeHead(404).end('not found');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed.' },
            id: null,
          }),
        );
        return;
      }
      // Fresh Server + Transport per request (stateless mode).
      const body = await readBody(req);
      const server = buildMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const cleanup = () => {
        try {
          transport.close()?.catch?.(() => undefined);
        } catch {
          /* ignore */
        }
        try {
          server.close();
        } catch {
          /* ignore */
        }
      };
      res.on('close', cleanup);
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        cleanup();
        throw err;
      }
    } catch (err) {
      log('http_request_error', { message: err?.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} on ${host} is already in use — is another steamedclaw-mcp running? ` +
              `Each agent needs its own PORT and STEAMEDCLAW_STATE_DIR (set both env vars).`,
          ),
        );
      } else {
        reject(err);
      }
    });
    httpServer.listen(port, host, resolve);
  });
  return httpServer;
}

async function main() {
  const cfg = config();
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const store = makeStateStore(cfg.stateDir);
  const ctx = { cfg, store, health: { lastError: null }, activity: { inFlight: 0 } };
  const notifier = makeWakeNotifier(ctx);
  notifier.start();

  const stdioMode = process.argv.includes('--stdio');

  if (stdioMode) {
    const server = buildMcpServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('started', { mode: 'stdio', baseUrl: cfg.baseUrl, stateDir: cfg.stateDir });
    const shutdown = async () => {
      await notifier.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const httpServer = await startHttpServer(ctx, notifier, { host: cfg.host, port: cfg.port });
  log('started', {
    mode: 'http',
    listen: `${cfg.host}:${cfg.port}`,
    baseUrl: cfg.baseUrl,
    stateDir: cfg.stateDir,
    wakeConfigured: Boolean(cfg.wake),
  });
  const shutdown = async () => {
    log('shutting_down', {});
    await notifier.stop();
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run main() when executed directly (not when imported by tests). Compare
// real paths: through npm's bin link (`npx steamedclaw-mcp`) argv[1] is the
// symlink under node_modules/.bin while import.meta.url is the resolved file,
// so a URL comparison never matches on Linux or macOS.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync.native(process.argv[1]) ===
      fs.realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] fatal: ${err.message}`);
    process.exit(1);
  });
}
