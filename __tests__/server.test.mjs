// Integration tests: the real server process over both MCP transports
// (streamable HTTP + stdio) against a mock game server, plus /health and the
// loud port-conflict error.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'index.mjs');

// --- mock game server -------------------------------------------------------------

let botoff;
let botoffUrl;
before(async () => {
  botoff = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (req.method === 'POST' && url.pathname === '/api/agents') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'agent-int',
          name: body.name,
          model: null,
          apiKey: 'k_integration_secret',
          claim_url: 'https://steamedclaw.com/claim?agent=agent-int',
          verification_code: 'code-77',
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/games') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 'nim', name: 'Nim', description: 'd', tags: [] }]));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tournaments') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          filter: 'all',
          tournaments: [{ number: 12 }],
          apiKey: 'must_not_escape_transport',
        }),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => botoff.listen(0, '127.0.0.1', resolve));
  botoffUrl = `http://127.0.0.1:${botoff.address().port}`;
});
after(() => botoff.close());

function freshEnv(extra = {}) {
  return {
    ...process.env,
    STEAMEDCLAW_BASE_URL: botoffUrl,
    STEAMEDCLAW_STATE_DIR: fs.mkdtempSync(join(os.tmpdir(), 'scmcp-int-')),
    ...extra,
  };
}

function waitFor(cond, ms = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(async () => {
      try {
        if (await cond()) {
          clearInterval(t);
          resolve();
        } else if (Date.now() - start > ms) {
          clearInterval(t);
          reject(new Error('waitFor timeout'));
        }
      } catch {
        if (Date.now() - start > ms) {
          clearInterval(t);
          reject(new Error('waitFor timeout'));
        }
      }
    }, 100);
  });
}

/** Parse an MCP streamable-HTTP response (SSE or plain JSON) into JSON-RPC messages. */
async function mcpPost(port, message) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
  }
  return text ? [JSON.parse(text)] : [];
}

const INIT_MSG = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '0.0.0' },
  },
};

describe('HTTP transport (streamable)', () => {
  let proc;
  let port;

  before(async () => {
    port = 18000 + Math.floor(Math.random() * 2000);
    proc = spawn(process.execPath, [INDEX], {
      env: freshEnv({ PORT: String(port), HOST: '127.0.0.1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', () => {});
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      return r?.ok;
    });
  });

  after(() => proc.kill());

  test('/health reports operator-facing status', async () => {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.registered, false);
    assert.equal(health.baseUrl, botoffUrl);
    assert.equal(health.wake.configured, false);
    assert.equal(health.lastError, null);
    assert.equal(health.tournamentAwaitingFirstGame, false);
  });

  test('initialize → tools/list exposes gameplay and tournament tools', async () => {
    const initMsgs = await mcpPost(port, INIT_MSG);
    const initResult = initMsgs.find((m) => m.id === 0);
    assert.equal(initResult.result.serverInfo.name, 'steamedclaw-mcp');

    const listMsgs = await mcpPost(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const list = listMsgs.find((m) => m.id === 1);
    assert.equal(list.result.tools.length, 21);
    assert.ok(list.result.tools.some((t) => t.name === 'wait_for_turn'));
    assert.ok(list.result.tools.some((t) => t.name === 'enter_tournament'));
  });

  test('tournament discovery over HTTP uses the shared dispatch and redaction boundary', async () => {
    const messages = await mcpPost(port, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'list_tournaments', arguments: {} },
    });
    const result = messages.find((message) => message.id === 30).result;
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.tournaments.tournaments[0].number, 12);
    assert.doesNotMatch(result.content[0].text, /must_not_escape_transport/);
  });

  test('tools/call register_agent end-to-end: registers, persists, never leaks the key', async () => {
    const msgs = await mcpPost(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'register_agent', arguments: { name: 'Integration Bot' } },
    });
    const reply = msgs.find((m) => m.id === 2);
    const payload = JSON.parse(reply.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, 'registered');
    assert.equal(payload.verificationCode, 'code-77');
    assert.doesNotMatch(reply.result.content[0].text, /k_integration_secret/);

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.registered, true);
    assert.equal(health.agentName, 'Integration Bot');
  });

  test('non-MCP paths 404; GET /mcp 405', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`)).status, 405);
  });
});

describe('stdio transport', () => {
  test('initialize + tools/list + tools/call over stdio', async () => {
    const proc = spawn(process.execPath, [INDEX, '--stdio'], {
      env: freshEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const received = [];
    let buffer = '';
    proc.stdout.on('data', (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) received.push(JSON.parse(line));
      }
    });
    proc.stderr.on('data', () => {});

    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
    try {
      send(INIT_MSG);
      await waitFor(() => received.some((m) => m.id === 0));
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await waitFor(() => received.some((m) => m.id === 1));
      const list = received.find((m) => m.id === 1);
      assert.equal(list.result.tools.length, 21);
      assert.ok(list.result.tools.some((t) => t.name === 'enter_tournament'));

      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_games', arguments: {} },
      });
      await waitFor(() => received.some((m) => m.id === 2));
      const call = received.find((m) => m.id === 2);
      const payload = JSON.parse(call.result.content[0].text);
      assert.equal(payload.ok, true);
      assert.equal(payload.games[0].id, 'nim');
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_tournaments', arguments: {} },
      });
      await waitFor(() => received.some((m) => m.id === 3));
      const tournamentText = received.find((m) => m.id === 3).result.content[0].text;
      assert.equal(JSON.parse(tournamentText).tournaments.tournaments[0].number, 12);
      assert.doesNotMatch(tournamentText, /must_not_escape_transport/);
    } finally {
      proc.kill();
    }
  });
});

describe('port conflict', () => {
  test('EADDRINUSE exits loudly, naming the env vars', async () => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    const env = freshEnv({ PORT: String(port), HOST: '127.0.0.1' });
    const first = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        return r?.ok;
      });
      const second = spawn(process.execPath, [INDEX], {
        env: freshEnv({ PORT: String(port), HOST: '127.0.0.1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      second.stderr.on('data', (d) => (stderr += d.toString()));
      const code = await new Promise((resolve) => second.on('exit', resolve));
      assert.notEqual(code, 0);
      assert.match(stderr, /already in use/);
      assert.match(stderr, /PORT/);
      assert.match(stderr, /STEAMEDCLAW_STATE_DIR/);
    } finally {
      first.kill();
    }
  });
});
