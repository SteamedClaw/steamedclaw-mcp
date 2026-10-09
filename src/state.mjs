// On-disk state for the SteamedClaw MCP server.
//
// The game server is the source of truth for everything gameplay; local state
// only persists credentials and seeds the next read. All JSON writes are
// atomic (tmp + rename) with best-effort 0600 permissions (near-no-op on
// NTFS — documented in the README).
//
// Files under the state dir:
//   credentials.json   {server, agentId, apiKey, name, registeredAt, ownerSeen?}
//   current-match.json {matchId, gameId, lastSequence, lastStatus, updatedAt}
//   pending-queue.json {gameId, lane, queuedAt}
//   tournament-run.json {sinceMatchId, gameId, setAt, skippedMatchIds?}
//                      present while the server's game-over said the agent's
//                      tournament run continues (nextGameAssigned: true)
//   tournament-enrollments.json [{tournamentId, entryId, gameId?, matchIds?, assignedMatchId?}]
//                      first-assignment watches plus consumed-entry markers
//   claim.md           write-once, human-readable; NEVER contains the apiKey
//   notes/<gameId>.md  record_reflection output
//   reflection-log.json rolling 24h quota timestamps

import fs from 'node:fs';
import { join } from 'node:path';

/** Atomic JSON write: tmp file in the same dir, then rename; chmod 0600 best-effort. */
export function writeJsonAtomic(filePath, value) {
  const dir = join(filePath, '..');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort (no-op on some filesystems)
  }
  fs.renameSync(tmp, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function makeStateStore(stateDir) {
  const credsPath = join(stateDir, 'credentials.json');
  const matchPath = join(stateDir, 'current-match.json');
  const queuePath = join(stateDir, 'pending-queue.json');
  const claimPath = join(stateDir, 'claim.md');
  const tournamentRunPath = join(stateDir, 'tournament-run.json');
  const enrollmentsPath = join(stateDir, 'tournament-enrollments.json');
  const reflectionLogPath = join(stateDir, 'reflection-log.json');
  const notesDir = join(stateDir, 'notes');

  return {
    stateDir,

    // --- credentials ---
    readCredentials() {
      const c = readJson(credsPath);
      if (!c || typeof c.apiKey !== 'string' || typeof c.agentId !== 'string') return null;
      return c;
    },
    writeCredentials(creds) {
      writeJsonAtomic(credsPath, creds);
    },
    /** Merge fields (e.g. ownerSeen) into existing credentials. */
    updateCredentials(fields) {
      const existing = this.readCredentials();
      if (!existing) return null;
      const merged = { ...existing, ...fields };
      writeJsonAtomic(credsPath, merged);
      return merged;
    },

    // --- current match ---
    readCurrentMatch() {
      const m = readJson(matchPath);
      if (!m || typeof m.matchId !== 'string' || typeof m.gameId !== 'string') return null;
      return m;
    },
    writeCurrentMatch(match) {
      writeJsonAtomic(matchPath, { ...match, updatedAt: new Date().toISOString() });
    },
    clearCurrentMatch() {
      try {
        fs.rmSync(matchPath, { force: true });
      } catch {
        // ignore
      }
    },

    // --- pending queue ---
    readPendingQueue() {
      const q = readJson(queuePath);
      if (!q || typeof q.gameId !== 'string') return null;
      return q;
    },
    writePendingQueue(queue) {
      writeJsonAtomic(queuePath, {
        ...queue,
        queuedAt: queue.queuedAt ?? new Date().toISOString(),
      });
    },
    clearPendingQueue() {
      try {
        fs.rmSync(queuePath, { force: true });
      } catch {
        // ignore
      }
    },

    // --- tournament run ---
    // Present while the server's structured game-over signal said the agent's
    // tournament run continues (`nextGameAssigned: true`). Drives assigned-match
    // discovery cadence and keeps idle hints from steering to queue_match.
    readTournamentRun() {
      const r = readJson(tournamentRunPath);
      if (!r || typeof r.sinceMatchId !== 'string') return null;
      return r;
    },
    writeTournamentRun(run) {
      writeJsonAtomic(tournamentRunPath, { setAt: new Date().toISOString(), ...run });
    },
    clearTournamentRun() {
      try {
        fs.rmSync(tournamentRunPath, { force: true });
      } catch {
        // ignore
      }
    },

    // Consumed markers prevent a still-enrolled, eliminated agent being re-armed.
    readEnrollmentWatches() {
      const entries = readJson(enrollmentsPath);
      return Array.isArray(entries)
        ? entries.filter(
            (entry) =>
              typeof entry?.tournamentId === 'string' && typeof entry?.entryId === 'string',
          )
        : [];
    },
    writeEnrollmentWatches(entries) {
      writeJsonAtomic(enrollmentsPath, entries);
    },

    // --- claim file (write-once; never contains the apiKey) ---
    writeClaimFileOnce({ agentId, name, claimUrl, verificationCode }) {
      if (fs.existsSync(claimPath)) return false;
      fs.mkdirSync(stateDir, { recursive: true });
      const body = [
        `# SteamedClaw agent claim`,
        ``,
        `- Agent: ${name} (${agentId})`,
        `- Claim URL: ${claimUrl}`,
        `- Verification code: ${verificationCode}`,
        `- Registered: ${new Date().toISOString()}`,
        ``,
        `Give the claim URL and verification code to the agent's owner.`,
        `The API key is intentionally not written to this file.`,
        ``,
      ].join('\n');
      fs.writeFileSync(claimPath, body, { mode: 0o600 });
      return true;
    },
    readClaimFile() {
      try {
        return fs.readFileSync(claimPath, 'utf8');
      } catch {
        return null;
      }
    },
    get claimPath() {
      return claimPath;
    },

    // --- reflections ---
    /** Returns the number of reflections recorded in the trailing 24h. */
    reflectionCount24h(now = Date.now()) {
      const log = readJson(reflectionLogPath);
      if (!Array.isArray(log)) return 0;
      return log.filter((t) => typeof t === 'number' && now - t < 24 * 60 * 60 * 1000).length;
    },
    recordReflectionTimestamp(now = Date.now()) {
      const log = readJson(reflectionLogPath);
      const kept = (Array.isArray(log) ? log : []).filter(
        (t) => typeof t === 'number' && now - t < 24 * 60 * 60 * 1000,
      );
      kept.push(now);
      writeJsonAtomic(reflectionLogPath, kept);
    },
    /** Sanitize a gameId into a safe notes filename stem. */
    notesPathFor(gameId) {
      const safe = String(gameId)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 80);
      return join(notesDir, `${safe}.md`);
    },
    readNotes(gameId) {
      try {
        return fs.readFileSync(this.notesPathFor(gameId), 'utf8');
      } catch {
        return null;
      }
    },
    writeNotes(gameId, content) {
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(this.notesPathFor(gameId), content, { mode: 0o600 });
    },
  };
}
