<div align="center">
  <h1>@cyanheads/zenodo-mcp-server</h1>
  <p><b>Search and resolve Zenodo datasets, software, and publications by DOI; trace versions and funding, list files, and preview text files via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/zenodo-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/zenodo-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/zenodo-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/zenodo-mcp-server/releases/latest/download/zenodo-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=zenodo-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvemVub2RvLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22zenodo-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fzenodo-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Datasets, software releases, and publications from Zenodo, CERN's open research repository, over its public REST API. Search deposits with filters for funder, grant, community, license, and file type; resolve any Zenodo DOI, concept DOI, or URL to its record; walk a deposit's versions; and list, open, and preview its files, including members of `.zip` archives. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `zenodo_search_records` | Search deposits by keyword plus type, community, funder, grant, ORCID, file type, license, access, and date filters, with facet counts |
| `zenodo_get_record` | Resolve one deposit from a record id, DOI, concept DOI, or URL to its full metadata, first 25 files, and an optional citation |
| `zenodo_list_versions` | List every version of a deposit's version series, newest first |
| `zenodo_list_files` | Page a deposit's file manifest, or list the members of one of its `.zip` files |
| `zenodo_read_file` | Read a byte-capped text excerpt of one file or `.zip` member |
| `zenodo_lookup_vocabulary` | Resolve community, funder, grant, license, and resource-type names to the ids search filters take |

## Capability reference

### `zenodo_search_records` <sub>tool</sub>

- Keyword `query` (terms OR-ed unless joined with `AND`, quoted phrases, field syntax such as `metadata.title:"…"`) plus `resource_type`, `community`, `funder`, `award`, `creator_orcid`, `file_type`, `license`, `access_status`, and `published_from` / `published_to`
- Up to 25 hits per page; only the first 10,000 matches are reachable (`result_window_exceeded` past that); latest versions only unless `all_versions` is true
- `sort`: `bestmatch`, `newest`, `oldest`, `mostviewed`, `mostdownloaded`, `updated-desc`, `updated-asc` (default `bestmatch` with a query, `newest` without)
- Each hit carries record and concept ids and DOIs, type, version, creators, license ids, access, file totals, and unique views and downloads; `facets` count resource types, access statuses, file types, subjects, and years over the full match set
- A bare DOI or record URL as `query` fails as `query_is_identifier`; a `community` or `funder` Zenodo doesn't know fails as `unknown_community` / `unknown_funder`

---

### `zenodo_get_record` <sub>tool</sub>

- `id` takes a record id, a Zenodo DOI, a concept DOI or concept record id (resolves to the latest version), another DOI registered to a Zenodo record, or a zenodo.org / doi.org URL; `input_kind` and `resolved_from` report how it resolved
- Returns the description as plain text (up to 4,000 characters), creators and contributors with ORCIDs and ROR affiliations, rights, access and embargo, funding, related identifiers, communities, version position with `latest_recid`, usage counts, and the first 25 files
- `citation_style`: `bibtex`, `csl-json`, `apa`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `modern-language-association`, or `nature`
- A miss returns `found: false` with `miss_kind` (`not_found`, `deleted`, `restricted`, `not_on_zenodo`) and `guidance`; a deleted record adds its removal `tombstone`

---

### `zenodo_list_versions` <sub>tool</sub>

- Takes the same `id` forms as `zenodo_get_record`; a concept DOI and any version's DOI list the same series
- Newest first, up to 25 per page; reports `total_versions`, `latest_recid`, and the concept record id and DOI
- Each version carries its record id, DOI, version label, publication date, `index`, `is_latest`, file totals, and unique views and downloads
- Misses return `found: false` with the same `miss_kind`, `guidance`, and `tombstone` as `zenodo_get_record`

---

### `zenodo_list_files` <sub>tool</sub>

- Manifest entries carry key, size, MIME type, MD5, download URL, `previewable`, and `listable` (a `.zip`); up to 200 per page via `offset` / `limit`
- `archive_key` lists the members of one `.zip`; Zenodo lists at most 1,000 files and directories per archive, flagged by `upstream_truncated`
- `key_contains` filters keys or member paths case-insensitively before paging
- Restricted and embargoed files return the access status and embargo date with no entries; unknown and deleted records fail as `record_not_found` / `record_deleted`

---

### `zenodo_read_file` <sub>tool</sub>

- `key` from `zenodo_list_files`, plus `archive_member` to read inside a `.zip` without downloading it
- `max_bytes` 256–65,536 (default 16,384); continue a top-level file from `next_offset`; `.zip` members read from byte 0 only
- `status` is `text`, `not_text`, `restricted`, or `empty`; excerpts end on a line or character boundary
- Extensionless files typed `application/octet-stream` (LICENSE, Makefile) are returned only when their content is UTF-8 text
- Every result carries the deposit's `rights` and the `download_url`

---

### `zenodo_lookup_vocabulary` <sub>tool</sub>

- `vocabulary`: `communities`, `funders`, `awards`, `licenses`, or `resource_types`; `query` by name, acronym, or keyword, or omit it to browse
- Each entry's `filter_param` and `filter_value` name the `zenodo_search_records` filter and the id to pass it
- `funder` scopes awards to one funder, as a ROR id, ROR URL, or Crossref Funder DOI
- Up to 25 entries per page

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Zenodo-specific:

- Accepts a record id, Zenodo DOI, concept DOI, external DOI, or zenodo.org / doi.org URL in every tool that takes `id`; URLs are parsed locally and never fetched
- Search filters compose into Zenodo's query, so facet counts agree with `total`; community and funder values are checked before the search runs
- Separate request pacers for Zenodo's search and general rate-limit buckets, backed by its `X-RateLimit-*` headers, plus a process-local cache (records 5 min, searches 60 s, vocabularies 1 h)
- Byte-range file reads and `.zip` member reads, with binary detection before any text is returned

Agent-friendly output:

- Misses as data: `zenodo_get_record` and `zenodo_list_versions` return `found: false` with a typed `miss_kind`, next-step `guidance`, and a deleted record's tombstone
- Depositor-supplied text is labeled untrusted: descriptions render as quoted blocks, file content in a code fence, and HTML descriptions are converted to plain text
- Search responses echo the `effectiveQuery` sent to Zenodo and the `appliedSort`, and every paged tool reports totals with a next page or offset
- Fields Zenodo omits stay absent rather than defaulting to `0`, `''`, or `false`

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "zenodo-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/zenodo-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "zenodo-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/zenodo-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "zenodo-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/zenodo-mcp-server:latest"]
    }
  }
}
```

To raise the rate limit, add `"ZENODO_ACCESS_TOKEN": "your-token"` to `env` (or `-e ZENODO_ACCESS_TOKEN=…` for Docker). See [Configuration](#configuration).

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: a [Zenodo personal access token](https://zenodo.org/account/settings/applications/tokens/new/) for a higher rate limit.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/zenodo-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd zenodo-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optionally set ZENODO_ACCESS_TOKEN
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `ZENODO_ACCESS_TOKEN` | Zenodo personal access token, created with no scopes. Raises Zenodo's rate limit; tool behavior and page sizes are unchanged. | none |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Rate limits

Zenodo rate-limits anonymous clients per IP address: 60 requests per minute and 2,000 per hour overall, and 30 per minute on record search. The server paces its own requests below those limits: 25 searches per minute, and 55 other requests per minute and 1,900 per hour. Every caller of one server process shares that budget. When it runs out, tools fail with `rate_limited` and a `retryAfter` in seconds.

With `ZENODO_ACCESS_TOKEN` set, Zenodo allows 100 requests per minute and 5,000 per hour, and the server paces other requests at 90 per minute and 4,800 per hour. Search stays at 25 per minute.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t zenodo-mcp-server .
docker run --rm -p 3010:3010 zenodo-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/zenodo-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: server instructions, tool registration, service setup and teardown. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) plus shared render, schema, and record-miss helpers. |
| `src/services/zenodo` | Zenodo service: HTTP boundary and pacers, cache, identifier parsing, query building, normalization, text previews. |
| `tests/` | Unit, service, tool, and fuzz tests against recorded Zenodo fixtures. |
| `docs/design.md` | Tool surface design, verified upstream behavior, and decisions log. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging; Zenodo responses are cached process-wide in the service, not in `ctx.state`
- Register new tools in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
