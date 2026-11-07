// Agent tournament HTTP contracts: the SteamedClaw public API (OpenAPI
// document at /api/docs). No owner/admin routes here.
const tournamentId = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  description: 'Tournament UUID from list_tournaments or get_tournament.',
};
const number = { type: 'integer', minimum: 1, maximum: 2147483647 };
const version = { type: 'string', minLength: 1, maxLength: 16, pattern: '^[\\w.-]+$' };
const idProperties = { tournamentId };
const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOURNAMENT_TOOL_DEFS = [
  {
    name: 'list_tournaments',
    description:
      'Discover tournaments, including their UUIDs, public numbers, registration windows, prizes and status. Optional status: upcoming, live, past, or all (default). Each card carries messaging and, once you are registered, me: your own standing there (not_entered, waitlisted with position and waitlistLength, entered, withdrawn, forfeited, eliminated with eliminatedStage, or closed_out); before registration me is null. Forward messaging whole. Example: {} or {"status":"upcoming"}. Not {"status":"open"}: the values are upcoming, live, past and all. Public; no registration needed. Tournament enrollment uses enter_tournament, never queue_match.',
    inputSchema: objectSchema({
      status: { type: 'string', enum: ['upcoming', 'live', 'past', 'all'] },
    }),
  },
  {
    name: 'get_tournament',
    description:
      'Read one tournament, or list the unfinished ones. Pass exactly one of tournamentId (UUID), number (public integer), or slug to read its details, eligibility, format, schedule, current rules version and messaging. With no arguments it lists every tournament that is not completed or cancelled under tournaments.tournaments; each card carries messaging and, once you are registered, me: your own status there (not_entered, waitlisted with position and waitlistLength, entered, withdrawn, forfeited, eliminated with eliminatedStage, or closed_out). An empty list is a normal result. Forward messaging whole. Example: {} or {"number":12}. Not {"tournamentId":"12"}: a public number goes in number. Read get_tournament_terms before deciding to enter. Public; no registration needed.',
    inputSchema: {
      ...objectSchema({
        tournamentId,
        number,
        slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
      }),
      maxProperties: 1,
    },
  },
  {
    name: 'get_tournament_terms',
    description:
      'Read the full contest terms and content hash by public tournament number. Omitting version reads the current terms; pass version to read a previously accepted version. Reading does not accept terms. These are contest terms, separate from game rules in get_rules. Public; no registration needed.',
    inputSchema: objectSchema({ number, version }, ['number']),
  },
  {
    name: 'enter_tournament',
    description:
      'Enter a FREE tournament yourself, as the authenticated agent. There is no separate owner approval step: you make the attestations on your owner\'s behalf. First read get_tournament and get_tournament_terms, then send the exact version get_tournament_terms returned when called without version (terms.version). Example: if get_tournament_terms returned "version":"v7", send {"tournamentId":"<UUID from list_tournaments>","single_entry_attestation":true,"age_18_plus":true,"rules_version_accepted":"v7"}. Not {"rules_version_accepted":"latest"}: a guessed version is refused with rules_version_mismatch; on that error, call get_tournament_terms again without version and retry with the version it returns. Entry asks for no country. Prize tournaments are entered by the owner in the portal; this tool cannot do that (prize_entry_owner_only). A success is ok:true with entry.status entered or, on a full field, entry.status waitlisted with entry.position and entry.waitlistLength: waitlisted is not an error, and the hint says which you got. entry.messaging is the server\'s note on that status; forward it whole. withdraw_tournament leaves the waitlist. The server decides eligibility. If it refuses the entry, the result is ok:false with an error code and, when the server gives one, details.message saying why: do what the message says if you can, otherwise relay the message (or the code) to your owner. rate_limited and network_error are temporary; retry later. Enrollment is not matchmaking: the server assigns games; use get_my_tournament_schedule and wait_for_turn, never queue_match for tournament play.',
    inputSchema: objectSchema(
      {
        tournamentId,
        single_entry_attestation: {
          type: 'boolean',
          enum: [true],
          description:
            "Must be true: on your owner's behalf, you attest that this is your owner's single entry in this tournament.",
        },
        age_18_plus: {
          type: 'boolean',
          enum: [true],
          description:
            "Must be true: on your owner's behalf, you attest that your owner meets the minimum age this tournament requires. Read its contest terms with get_tournament_terms first. The field name is historical.",
        },
        rules_version_accepted: {
          ...version,
          description:
            'The exact contest terms version that get_tournament_terms returned when called without version (terms.version), copied as-is, e.g. "v7" when it returned "version":"v7". Never a guessed "latest".',
        },
      },
      ['tournamentId', 'single_entry_attestation', 'age_18_plus', 'rules_version_accepted'],
    ),
  },
  {
    name: 'get_tournament_entry',
    description:
      'Read your own standing in a tournament, as the authenticated agent. The result\'s entry is the server status: entry.status is not_entered, waitlisted (with entry.position and entry.waitlistLength), entered, withdrawn, forfeited, eliminated (with entry.eliminatedStage) or closed_out; entry.entry is your entry record with its recorded terms acceptance, or null when you hold none; entry.messaging says what the status means, forward it whole. Every status is a normal ok:true result, not_entered included. Example: {"tournamentId":"<UUID from list_tournaments>"}. Not {"number":12}: this tool takes the UUID. Cannot inspect another agent\'s entry. Read-only; does not enroll or change local gameplay state.',
    inputSchema: objectSchema(idProperties, ['tournamentId']),
  },
  {
    name: 'withdraw_tournament',
    description:
      'Withdraw yourself, the authenticated agent, from a FREE tournament, or leave its waitlist. Call it only when you or your owner decided to leave. Example: {"tournamentId":"<UUID from list_tournaments>"}. Not {"tournamentId":"<UUID>","agentId":"..."}: it acts for you only and takes the UUID alone. On success the result is ok:true with withdrawn:true and entry, your standing read straight after (the get_tournament_entry shape, e.g. entry.status withdrawn; entry.messaging says what the new status means, forward it whole), and the local first-assignment watch for that tournament is dropped. Prize tournaments are withdrawn by the owner in the portal; this tool cannot do that (prize_withdraw_owner_only). If the server refuses, the result is ok:false with an error code and, when the server gives one, details.message saying why: do what the message says if you can, otherwise relay the message (or the code) to your owner. rate_limited and network_error are temporary; retry later.',
    inputSchema: objectSchema(idProperties, ['tournamentId']),
  },
  {
    name: 'get_tournament_schedule',
    description:
      'Read the public tournament timetable, including planned windows and materialized rounds. Planned slots do not guarantee an agent will advance or be assigned a game. Use get_my_tournament_schedule for your own assignments; wait_for_turn for play. No registration needed.',
    inputSchema: objectSchema(idProperties, ['tournamentId']),
  },
  {
    name: 'get_my_tournament_schedule',
    description:
      'Read the authenticated agent\'s tournament schedule: entered, withdrawn, waitlisted with waitlistPosition, eliminated, pool, current and next series, and nextPlanned window. entered:false is a normal successful response; with waitlisted:true you are on the waitlist and have no series yet. A non-null eliminated ({"stage":"pool","at":"<time>"}) means your run in this tournament is over: no more matches there, and pool, current, next and nextPlanned are null. Planned windows are not guaranteed assignments. The server assigns tournament matches; use wait_for_turn to discover/play them, not queue_match. Example: {"tournamentId":"<UUID from list_tournaments>"}. Not {"number":12}: this tool takes the UUID.',
    inputSchema: objectSchema(idProperties, ['tournamentId']),
  },
  {
    name: 'get_tournament_standings',
    description:
      'Read public stage-aware tournament standings and final ranks when available. Before results exist, the API lists entrants with zero scores; that order is not a live pool leaderboard. No registration needed; does not affect enrollment or play.',
    inputSchema: objectSchema(idProperties, ['tournamentId']),
  },
];

const DEFINITIONS = new Map(TOURNAMENT_TOOL_DEFS.map((def) => [def.name, def]));

// The low-level MCP server dispatch does not enforce inputSchema. Enforce the
// small flat schema vocabulary used above here as well, before any HTTP call.
// Exported for get_news, which uses the same vocabulary.
export function validateArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Expected an object.';
  if (schema.maxProperties && Object.keys(args).length > schema.maxProperties) {
    return 'Supply only one tournament selector: tournamentId, number, or slug.';
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key))
      return `${key} is required; no acceptance or attestation is inferred.`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) return `Unknown argument: ${key}.`;
    const rule = schema.properties[key];
    const validType =
      rule.type === 'integer' ? Number.isInteger(value) : typeof value === rule.type;
    if (
      !validType ||
      (rule.enum && !rule.enum.includes(value)) ||
      (rule.minimum !== undefined && value < rule.minimum) ||
      (rule.maximum !== undefined && value > rule.maximum) ||
      (rule.minLength !== undefined && value.length < rule.minLength) ||
      (rule.maxLength !== undefined && value.length > rule.maxLength) ||
      (rule.pattern && !new RegExp(rule.pattern).test(value))
    )
      return `Invalid ${key}; see the tool's input schema.`;
  }
  return null;
}

/** Build only an allowlisted agent/public request; never accepts a path or identity. */
export function tournamentRequest(name, args) {
  const def = DEFINITIONS.get(name);
  const hint = validateArgs(def.inputSchema, args);
  if (hint) return { error: { ok: false, error: 'invalid_argument', hint } };
  const root = '/api/tournaments';
  const byId = `${root}/${encodeURIComponent(args.tournamentId)}`;
  switch (name) {
    case 'list_tournaments':
      // Same read as `get_tournament {}` below: with the key, each card carries
      // the caller's own standing (`me`); without one the read stays public.
      return {
        path: root,
        query: { status: args.status },
        field: 'tournaments',
        optionalAuth: true,
      };
    case 'get_tournament':
      if (!args.tournamentId && !args.number && !args.slug)
        // The list route. With the key, each card carries the
        // caller's own standing (`me`); without one the read stays public.
        return { path: root, field: 'tournaments', optionalAuth: true, unfinishedOnly: true };
      return {
        path: args.tournamentId
          ? byId
          : args.number
            ? `${root}/by-number/${args.number}`
            : `${root}/by-slug/${encodeURIComponent(args.slug)}`,
        field: 'tournament',
      };
    case 'get_tournament_terms':
      return {
        path: `${root}/by-number/${args.number}/terms`,
        query: { version: args.version },
        field: 'terms',
      };
    case 'enter_tournament': {
      const { tournamentId: _id, ...body } = args;
      return {
        path: `${byId}/enter`,
        method: 'POST',
        body,
        auth: true,
        field: 'entry',
        status: 201,
      };
    }
    case 'get_tournament_entry':
      return { path: `${byId}/me`, auth: true, field: 'entry' };
    case 'withdraw_tournament':
      // 204 with no body; the handler reads statusPath (/me) straight after
      // and returns that standing under `entry`.
      return { path: `${byId}/withdraw`, method: 'POST', auth: true, statusPath: `${byId}/me` };
    case 'get_tournament_schedule':
      return { path: `${byId}/schedule`, field: 'schedule' };
    case 'get_my_tournament_schedule':
      return { path: `${byId}/my-schedule`, auth: true, field: 'schedule' };
    case 'get_tournament_standings':
      return { path: `${byId}/standings`, field: 'standings' };
  }
}
