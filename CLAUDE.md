# Developer Protocol

**Server:** zenodo-mcp-server
**Version:** 0.1.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.6`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

Six read-only tools over the Zenodo REST API (`https://zenodo.org/api`, InvenioRDM): `zenodo_search_records`, `zenodo_get_record`, `zenodo_list_versions`, `zenodo_list_files`, `zenodo_read_file`, `zenodo_lookup_vocabulary`. No resources, no prompts. No credentials are needed; the optional `ZENODO_ACCESS_TOKEN` raises the rate limit and changes nothing else. [`docs/design.md`](./docs/design.md) holds the per-tool contracts, the verified upstream behavior behind them, and the decisions log — read it before changing a tool.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — before adding a tool, extend `docs/design.md` with its contract
3. **Add tools** — scaffold new definitions using the `add-tool` skill, and register them in `src/mcp-server/tools/definitions/index.ts`
4. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
5. **Field-test definitions** — exercise the tools against live Zenodo using the `field-test` skill (pace searches: 25/min per process)
6. **Run `devcheck`** — lint, format, typecheck, and security audit
7. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
8. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
9. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Zenodo conventions

- **One fetch boundary.** Every upstream call goes through `ZenodoHttp` in `src/services/zenodo/http.ts`: per-call accept-lists (206, 301/302, 403, 404, 410, 416 are results, not errors), at most one retry, and no caller-controlled host — the service builds every path under `https://zenodo.org/api`. Tools call `getZenodoService()`, never `fetch`.
- **Two pacers, one budget per process.** `zenodo-search` (25/min) and `zenodo-general` (55/min and 1,900/hr anonymous; 90/min and 4,800/hr with a token), plus a header gate on `X-RateLimit-*`. A search takes a general start slot first. Every caller of the process shares the budget, so never add bulk or fan-out calls.
- **Process-local cache, not `ctx.state`.** Zenodo data is public, so `TtlLruCache` (`cache.ts`) is shared across tenants: records 5 min, searches 60 s, containers 10 min, vocabularies 1 h.
- **Identifiers parse locally.** `parseRecordRef()` (`identifiers.ts`) classifies every `id` form — record id, Zenodo DOI, concept DOI, external DOI, zenodo.org / doi.org URL. URLs are never fetched. All four `id`-taking tools share it.
- **Misses by tool role.** `zenodo_get_record` and `zenodo_list_versions` return `found: false` with `miss_kind`, `guidance`, and `tombstone` (shared in `record-miss.ts`); `zenodo_list_files` and `zenodo_read_file` throw `record_not_found` / `record_deleted`.
- **Untrusted text through the render helpers.** Every depositor-supplied string in `format()` goes through `inline()`, `quoteBlock()`, or `fence()` (`src/mcp-server/tools/render.ts`). HTML descriptions are converted by `htmlToText()` — the only transformation of upstream text.
- **Blank optional inputs read as unset.** Wrap optional strings and arrays with `blankToUndefined` / `toOptionalArray`, and enums with `enumPreprocess` (`schema-helpers.ts`). Never `.min(1)` on an optional field.
- **Enrichment defaults first.** A handler with required enrichment keys writes all of them on its first line, then overwrites where they change — a one-branch write fails the output parse on every other path.
- **Sparse fields stay absent.** An upstream field Zenodo omits is omitted from the output, never coerced to `0`, `''`, or `false`, and its `.describe()` says when it is absent.

---

## Patterns

### Tool

Abridged from `src/mcp-server/tools/definitions/list-versions.tool.ts`:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { parseRecordRef } from '@/services/zenodo/identifiers.js';
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
import { notOnZenodoMiss, recordMiss, TombstoneSchema } from '../record-miss.js';

export const listVersions = tool('zenodo_list_versions', {
  title: 'List Zenodo record versions',
  description: "List every version of a Zenodo deposit's version series, newest first, …",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    id: z.string().trim().min(1).max(500).describe('Any version or concept identifier of the deposit: …'),
    page: z.number().int().min(1).default(1).describe('Result page, starting at 1. page × size may not exceed 10,000.'),
    size: z.number().int().min(1).max(25).default(25).describe('Versions per page (1–25).'),
  }),
  output: z.object({ /* found, input_kind, miss_kind?, guidance?, tombstone?, total_versions?, versions[], … */ }),
  enrichment: {
    truncated: z.boolean().describe('True when more versions follow this page.'),
    shown: z.number().describe('Versions returned on this page.'),
    cap: z.number().describe('Page size applied.'),
    totalCount: z.number().describe('Number of versions in the series.'),
    notice: z.string().optional().describe('Guidance on paging or a page past the end.'),
  },
  errors: [
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'id matches no accepted form, or is a GitHub-badge latestdoi id or a non-zenodo.org host',
      recovery: 'Pass a Zenodo record id (22705923), a DOI (10.5281/zenodo.22705923), or a zenodo.org/records URL as id; …',
    },
    // result_window_exceeded, record_unavailable, upstream_timeout, rate_limited …
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.size, totalCount: 0 }); // required keys, first line

    const ref = parseRecordRef(input.id);
    if (ref.kind === 'invalid') {
      throw ctx.fail('invalid_identifier', ref.message, ctx.recoveryFor('invalid_identifier'));
    }
    const service = getZenodoService();
    // … resolve an external DOI; on a miss return { found: false, ...notOnZenodoMiss(doi), … }
    // … a record-GET miss returns { found: false, ...recordMiss(recid, lookup), … }

    const lookup = await service.listVersions(recid, input.page, input.size, ctx);
    const hasMore = input.page * input.size < lookup.total;
    ctx.enrich({ shown: lookup.hits.length });
    ctx.enrich.total(lookup.total);
    if (hasMore) {
      ctx.enrich.truncated({
        shown: lookup.hits.length,
        cap: input.size,
        guidance: `Showing ${lookup.hits.length} of ${lookup.total} versions; call again with page ${input.page + 1}.`,
      });
    }
    return { found: true, input_kind: ref.inputKind, total_versions: lookup.total, /* … */ versions: lookup.hits };
  },

  // format() renders every output field; depositor text goes through inline() / quoteBlock().
  format: (result) => [{ type: 'text', text: /* … */ '' }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  accessToken: z
    .string()
    .optional()
    .describe(
      'Zenodo personal access token (created with no scopes). Raises the global rate limit; tool behavior and page sizes are unchanged.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, { accessToken: 'ZENODO_ACCESS_TOKEN' });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`ZENODO_ACCESS_TOKEN`) not the path (`accessToken`). A blank value or an unsubstituted `${…}` placeholder reads as unset. A new env var also goes into `server.json`, `manifest.json`, both plugin manifests, and `.env.example` (see Bundling).

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment.

### Server identity and lifecycle

`src/index.ts`:

```ts
await createApp({
  name: 'zenodo-mcp-server',
  title: 'zenodo-mcp-server',
  instructions: "Zenodo is CERN's open research repository … metadata is CC0 and each file keeps its deposit's license.",
  tools: allToolDefinitions,
  setup(core) {
    initZenodoService(core.config);
  },
  teardown() {
    disposeZenodoService();
  },
});
```

The identity block is `name` + `title` only, both the bare hyphenated `zenodo-mcp-server` — never Title Case, never the npm scope, and never a duplicated `description` (it derives from `package.json`). `instructions` is session-level orientation sent on every `initialize`; keep it in step with the tool descriptions. `setup()` builds the service (pacers, cache, a User-Agent carrying the server version); `teardown()` disposes the pacers' timers.

No handler calls `ctx.requestInput`, so no `sessionMode` requirement is declared; the Dockerfile and `.env.example` run HTTP as `stateless`.

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Every tool declares an `enrichment` block; see *Enrichment defaults first*. |
| `ctx.fail` / `ctx.recoveryFor` | Throw a declared error-contract reason with its recovery hint: `throw ctx.fail('reason', message, ctx.recoveryFor('reason'))`. |
| `ctx.signal` | `AbortSignal` for cancellation — the service threads it into every upstream request and pacer wait. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

`ctx.state`, `ctx.requestInput` / `ctx.inputs`, and `ctx.content` are unused: responses are cached process-wide in the service, no tool asks for input mid-call, and every tool returns text.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Typed error contract.** Every tool declares `errors: [{ reason, code, when, recovery, retryable?, thrownBy? }]` inline and throws with `ctx.fail(reason, …, ctx.recoveryFor(reason))`. `when` is model-facing text (the framework advertises it), so write it for the calling model — no implementation terms like "record GET" or "pacer shed". `recovery` names the next tool call. Reasons the service throws (`rate_limited`, `record_unavailable`, `upstream_timeout`, `query_failed`, `archive_unavailable`) carry `thrownBy: 'service'`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'unknown_community', code: JsonRpcErrorCode.ValidationError,
    when: 'community resolves to no Zenodo community',
    recovery: 'Find the community’s slug with zenodo_lookup_vocabulary (vocabulary: communities), then pass it as community.' },
],
async handler(input, ctx) {
  const community = ref ? await service.getCommunity(ref, ctx) : undefined;
  if (!community) {
    throw ctx.fail('unknown_community', `No Zenodo community matches "${inline(input.community)}" …`, ctx.recoveryFor('unknown_community'));
  }
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp(): identity, instructions, tools, setup/teardown
  config/
    server-config.ts                    # ZENODO_ACCESS_TOKEN (Zod schema, lazy parse)
  services/zenodo/
    zenodo-service.ts                   # ZenodoService + init/get/dispose accessors
    http.ts                             # Fetch boundary: accept-lists, retries, pacers, header gate
    cache.ts                            # Process-local TTL LRU with a byte budget
    normalize.ts                        # Raw RDM JSON → domain types
    identifiers.ts                      # parseRecordRef, ROR / Funder DOI / ORCID / community parsing
    query-builder.ts                    # Composes the search q from filters
    html-to-text.ts                     # HTML description → plain text
    text-preview.ts                     # Preview mode, byte cut, binary detection
    resource-types.ts                   # Static 43-entry resource type table
    types.ts                            # Raw upstream and domain types
  mcp-server/tools/
    definitions/
      index.ts                          # allToolDefinitions barrel
      [tool-name].tool.ts               # The six tool definitions
    render.ts                           # inline / quoteBlock / fence for untrusted text
    schema-helpers.ts                   # blankToUndefined, toOptionalArray, enumPreprocess
    record-miss.ts                      # Shared found:false outcome + TombstoneSchema
tests/
  fixtures/zenodo/                      # Recorded Zenodo responses
  helpers/                              # Fixture loaders
  services/zenodo/                      # Service and pure-module tests
  mcp-server/tools/                     # Tool handler and helper tests
  fuzz/                                 # Adversarial-input fuzz tests
  smoke/                                # Definition smoke tests
docs/
  design.md                             # Tool contracts, verified API behavior, decisions log
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `list-versions.tool.ts` |
| Tool names | snake_case, `zenodo_` prefix | `zenodo_list_versions` |
| Directories | kebab-case | `src/services/zenodo/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Resolve names to the ids zenodo_search_records filters on, …'` |
| Input and output fields | snake_case | `concept_recid`, `latest_recid`, `next_offset` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity, plugin manifest identity, README version badge (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release from an annotated tag and attach the `.mcpb` bundle |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

**Tests never touch the network.** Service and tool tests run the real service against recorded responses in `tests/fixtures/zenodo/` through a fetch mock; a new upstream shape gets a trimmed fixture, not a live call.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected.

**Adding an env var touches every packaging surface:** `server.json` (registry discovery, `environmentVariables[]`), `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`), `.claude-plugin/plugin.json` (`userConfig` + `env`), and `.codex-plugin/mcp.json` (`env_vars`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

**Identity across publish surfaces.** The npm name `@cyanheads/zenodo-mcp-server` appears on install surfaces: the README `<h1>`, the npm and install badges, and every `bunx` / `npx -y` argument. `mcpName` and the `server.json` `name` are `io.github.cyanheads/zenodo-mcp-server`. Everywhere else — `createApp()`, `manifest.json` `name`, plugin names and server keys, the Docker image, the `.mcpb` file — it is the bare `zenodo-mcp-server`. `lint:packaging` enforces the split.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getZenodoService } from '@/services/zenodo/zenodo-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional inputs wrapped with `blankToUndefined` / `toOptionalArray` / `enumPreprocess`, never `.min(1)` on an optional field
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging; upstream data cached in the service, not `ctx.state`
- [ ] Handlers throw on failure via declared contract reasons (`ctx.fail` + `ctx.recoveryFor`), no try/catch
- [ ] Every upstream call goes through `getZenodoService()` — no direct `fetch`, no caller-supplied host
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Depositor-supplied text in `format()` passes through `inline()` / `quoteBlock()` / `fence()`
- [ ] Required enrichment keys written unconditionally on the handler's first line
- [ ] Sparse upstream fields optional in the output schema, left absent (never coerced), with `.describe()` saying when
- [ ] Tests include a sparse-payload case against a trimmed fixture; no live network in `bun run test`
- [ ] Registered in `allToolDefinitions` (`src/mcp-server/tools/definitions/index.ts`)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `docs/design.md` updated when a tool's contract changes
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this)
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; `ZENODO_ACCESS_TOKEN` listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env`
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords`; inline `mcpServers` entry keyed by the unscoped repo name, with `ZENODO_ACCESS_TOKEN` declared under `userConfig` and referenced from `env` as `"${user_config.zenodo_access_token}"`
- [ ] `bun run devcheck` passes with zero warnings, and `bun run test` passes
