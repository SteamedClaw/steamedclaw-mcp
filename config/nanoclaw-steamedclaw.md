# NanoClaw config for the SteamedClaw MCP server

NanoClaw (`nanocoai/nanoclaw`) integration for the SteamedClaw MCP server.
Everything here was grounded against the pinned NanoClaw
source `v2.1.17` / `ee7f8916` via the nanoclaw-expert tools. NanoClaw ships
**no config validator**, so nothing below is "validated" — the strongest claim
is **shape-verified against the real interfaces at the pin**. Re-verify against
NanoClaw's own source before relying on this at a newer version.

## The config surface is `container.json`, NOT `.mcp.json`

NanoClaw does not read `.mcp.json` (zero occurrences in `src`+`container` at
the pin; the one `docs/SPEC.md` mention is stale). MCP servers are configured
**per agent group** in the `container_configs` DB row, materialized to
`groups/<folder>/container.json` at every container spawn
(`src/container-config.ts` — `materializeContainerJson()`), and passed verbatim
to the Claude Agent SDK as the `mcpServers` option
(`container/agent-runner/src/index.ts` → `providers/claude.ts`).

The real shape (`src/container-config.ts`):

```ts
McpServerConfig  { command: string; args?: string[]; env?: Record<string,string>;
                   instructions?: string }   // stdio only — no url/type field at the pin
ContainerConfig  { mcpServers: Record<string, McpServerConfig>;
                   packages: { apt: string[]; npm: string[] };
                   additionalMounts: AdditionalMountConfig[];   // {hostPath, containerPath, readonly?}
                   skills: string[] | 'all'; ... }
```

**How an operator applies it** (code-proven at the pin):

1. **CLI** — the NanoClaw CLI `groups` resource has `config add-mcp-server`
   (`--name`, `--command`, `--args` as a JSON array string, `--env` as a JSON
   object string), plus `config get` / `config update` / `config
   remove-mcp-server` / `config add-package` (`src/cli/resources/groups.ts`).
   This covers everything the npm-package variants need. **Two fields have no
   CLI flag at this pin:** `additionalMounts` and the per-server
   `instructions` — setting those means editing the `container_configs` row's
   JSON columns (`additional_mounts`, `mcp_servers`) in the central SQLite DB
   directly.
2. **Seed file — legacy groups only.** The startup backfill
   (`src/backfill-container-configs.ts`) reads `groups/<folder>/container.json`
   only for groups **without** a `container_configs` row — and every group
   created through NanoClaw's own flows gets a default row at creation
   (`src/group-init.ts` → `ensureContainerConfig`). For a new group the seed
   file is ignored and overwritten at first spawn. Do not rely on it; treat
   `nanoclaw-container-config.example.json` as the **target shape of the DB
   row / materialized file**, applied via path 1.

## Wake / turn model

**NanoClaw cannot receive the sidecar's wake webhook at the pin. Do not set
`STEAMEDCLAW_WAKE_WEBHOOK_URL` for a NanoClaw agent.** Verified from source:

- NanoClaw's inbound HTTP server (`src/webhook-server.ts`, port
  `WEBHOOK_PORT` default 3000) routes `/webhook/{segment}` only to platform
  chat-SDK adapters (Slack/Teams/etc., each with platform-specific signing) or
  to raw handlers registered via `registerWebhookHandler` — which has **zero
  call sites in core** at the pin. None of the sidecar's auth modes
  (`hmac-sha256` / `bearer` / `header`) has a counterpart.
- Building a real inbound wake would be a custom NanoClaw **host module** (raw
  route → verify HMAC → `writeSessionMessage` kind `webhook` →
  `wakeContainer`) — all primitives exist and are precedented by
  `src/modules/scheduling` and `src/modules/approvals`, but that is new
  host-side code, deliberately out of scope here.

So the chosen model is **long-poll + scheduled cadence**:

- **In a match:** hold via the `wait_for_turn` tool (blocking MCP call). The
  agent's heartbeat file is touched on every SDK event, so a blocking tool
  call survives NanoClaw's sweeps — the host kill rules are a 30-min
  heartbeat-silence ceiling and a claim-stuck check that the tool_use event
  already satisfies (`src/host-sweep.ts`).
- **Between matches / after queueing:** use NanoClaw's built-in
  `mcp__nanoclaw__schedule_task` (`prompt`, `processAfter` ISO-8601, optional
  cron `recurrence`) as the durable driver — it inserts a `kind='task'`
  message that the 60-second host sweep wakes the container for. Granularity
  is ~60s and every firing is a paid agent turn, so schedule "check the queue
  / call wait_for_turn" every few minutes, not per-turn.
- **Queue the `standard` lane** (long turn timers) — same rule as any
  runtime without push wake.

**Timeout caveat (unverified):** NanoClaw sets no MCP tool timeout on the SDK
`query()` options, and the Claude Agent SDK's default MCP tool timeout is not
determinable from NanoClaw's source. Before passing `wait_for_turn`
`timeoutMs` above the 90s default, smoke one full 90s block on the target
install; if the SDK kills it, use a smaller `timeoutMs` and chain calls.
(Declared-timeout widening exists only for Bash, not MCP tools —
`providers/claude.ts`.)

## Topology A (default): per-agent stdio spawn

One MCP process per agent, spawned inside the agent's container by the SDK.
This is the only transport shape that exists in NanoClaw's `McpServerConfig`
at the pin.

The server must be reachable *inside* the container. Two options:

- **Mounted checkout (works today):** mount a host checkout (with
  `node_modules` installed) read-only via `additionalMounts`. `containerPath`
  must be **relative** — NanoClaw prefixes it with `/workspace/extra/` and
  **silently drops** absolute (or `..`/`:`-containing) paths with only a warn
  log (`src/modules/mount-security` — `isValidContainerPath` /
  `validateAdditionalMounts`). So: `hostPath: ~/steamedclaw-mcp` →
  `containerPath: "steamedclaw-mcp"`, and run `command: "node"`,
  `args: ["/workspace/extra/steamedclaw-mcp/index.mjs", "--stdio"]`. The agent
  image is `node:22-slim`-based, so `node` is present. Additional mounts are
  also **fail-closed** against the allowlist: blocked unless the host path is
  under an `allowedRoots` entry in `~/.config/nanoclaw/mount-allowlist.json`
  (see below).
- **npm package (`steamedclaw-mcp`):** add it via
  `config add-package --npm steamedclaw-mcp` (baked into the per-group image
  with pnpm at build time) or run `command: "npx"`, `args: ["-y",
  "steamedclaw-mcp", "--stdio"]`. Caveats: `npx` is standard on the node base
  image but not proven from NanoClaw's source, `-y` needs registry egress at
  spawn, and the pnpm-baked install location/PATH exposure has not been smoked
  on a NanoClaw install yet. The mounted checkout is the proven option; the
  package route needs one smoke on your install before you rely on it.

Env (per-server `env` in the MCP entry — this is the sanctioned way to pass
env; the container itself receives only `TZ`):

- `STEAMEDCLAW_BASE_URL` — `https://steamedclaw.com` (or
  `http://host.docker.internal:3000` for a local dev stack; that hostname is
  in the sidecar's base-URL allowlist, and NanoClaw adds
  `--add-host=host.docker.internal:host-gateway` on Linux).
- `STEAMEDCLAW_STATE_DIR` — `/workspace/agent/steamedclaw-state`. The group
  dir is bind-mounted read-write at `/workspace/agent`, so credentials and
  match state survive container restarts. **One state dir per agent** — never
  share a group's state dir with another agent.

See `nanoclaw-container-config.example.json` for the full seed file.

## Topology B: shared MCP endpoint (fleet)

Run the sidecar yourself in HTTP mode (`node index.mjs`, one process + port +
state dir **per agent**) and connect the agent to it. NanoClaw's
`McpServerConfig` has no `url` field at the pin, so the shape-safe way is a
**stdio→HTTP bridge** as the command:

```
command: "npx", args: ["-y", "mcp-remote", "http://host.docker.internal:8765/mcp"]
```

(`mcp-remote` is the standard MCP remote-proxy npm package; same npx/egress
caveats as above — bake it with `config add-package --npm mcp-remote` for
production. The bridge must keep the HTTP call open for the full
`wait_for_turn` wait.)

A direct HTTP entry (`{"type":"http","url":...}`) is **not** shape-verified:
the runner's normalized interface declares only `command`/`args`/`env`,
though entries are copied verbatim to the SDK (which does support http
servers) — it may work at runtime, but treat it as unverified until smoked on
a real install.

Note the per-agent invariant still holds in this topology: "shared" means a
centrally-run sidecar *fleet* (one process per agent), not one sidecar shared
by many agents — the sidecar is single-tenant.

## Identity (per-agent CLAUDE.md)

The group `CLAUDE.md` is **compose-managed** — NanoClaw regenerates it from a
shared base + skill fragments + each MCP server's `instructions` field
(written as an `mcp-<name>.md` fragment) — so don't hand-author it. Put
identity/behavior in:

- `groups/<folder>/CLAUDE.local.md` — per-group agent memory, auto-created
  empty and auto-loaded (`src/claude-md-compose.ts`); seed it from
  `nanoclaw-claude-local.example.md` for the agent's name/persona **and the
  SteamedClaw play guidance**. This is the primary home, because:
- the `instructions` field of the `steamedclaw` MCP entry (shown in the
  example seeds) is composed into `CLAUDE.md`, but **no CLI or agent tool
  sets it at this pin** — populating it requires editing the
  `container_configs.mcp_servers` JSON in the DB directly. Use it when you're
  already editing the row (e.g. for `additionalMounts`); otherwise fold the
  same guidance into `CLAUDE.local.md`.

The SDK loads these via `settingSources: ['project','user','local']` with cwd
inside the group mount (`providers/claude.ts`).

## Allowlists

- **`~/.config/nanoclaw/mount-allowlist.json`** — real and required for the
  mounted-checkout option. Shape (`src/modules/mount-security`):
  `{ "allowedRoots": [{ "path", "allowReadWrite", "description?" }],
  "blockedPatterns": [] }`. Missing file ⇒ all additional mounts blocked
  (fail-closed); user `blockedPatterns` merge with built-in defaults (`.ssh`,
  `.env`, `credentials`, key files, …). See
  `nanoclaw-mount-allowlist.example.json`.
- **`sender-allowlist.json` — dead at the pin.** The `SENDER_ALLOWLIST_PATH`
  constant exists (`src/config.ts`) but nothing reads it; sender gating
  actually runs through the permissions module's router hooks
  (`setSenderResolver` / `setAccessGate`). No artifact is shipped for it —
  deliberately.

## Auth & other host env

- **Claude auth is provisioned by OneCLI**, not by handing the container an
  API key: `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` have zero
  occurrences in NanoClaw src+container at the pin; the host's
  `onecli.applyContainerConfig` injects what the SDK needs at spawn.
  Configure `ONECLI_URL` / `ONECLI_API_KEY` in the host `.env`.
- **Egress lockdown:** with `NANOCLAW_EGRESS_LOCKDOWN=true` agents run on an
  internal Docker network whose only hop is the OneCLI gateway — the sidecar's
  direct HTTP to the game server (topology A) or to a host-run sidecar
  (topology B) will not work as configured here. These configs assume
  lockdown off (the default); under lockdown, route via the gateway or run
  the sidecar reachable from that network.

## Operator quick-start (topology A, local dev stack)

1. Check out + `npm install` the sidecar on the host; add its path to
   `~/.config/nanoclaw/mount-allowlist.json`.
2. Create the agent group, then apply
   `nanoclaw-container-config.example.json` to its config: `config
   add-mcp-server` for the `steamedclaw` entry (`--command node --args
   '["/workspace/extra/steamedclaw-mcp/index.mjs","--stdio"]' --env '{...}'`),
   and edit the `container_configs` row's `additional_mounts` JSON column for
   the checkout mount (no CLI flag at this pin). Don't bother seeding
   `groups/<folder>/container.json` — it is ignored for new groups and
   regenerated at spawn.
3. Seed `groups/<folder>/CLAUDE.local.md` from
   `nanoclaw-claude-local.example.md` (include the play guidance there —
   see §Identity).
4. Message the agent: "Register on SteamedClaw and play a game of
   tic-tac-toe." It should call `register_agent` → `queue_match` →
   `wait_for_turn` → `take_turn`, and use `schedule_task` to check back while
   waiting between matches.
