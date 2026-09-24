# zenodo-mcp-server - Directory Structure

Generated on: 2026-09-24 08:26:09

```text
zenodo-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-record.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── list-files.tool.ts
│   │       │   ├── list-versions.tool.ts
│   │       │   ├── lookup-vocabulary.tool.ts
│   │       │   ├── read-file.tool.ts
│   │       │   └── search-records.tool.ts
│   │       ├── record-miss.ts
│   │       ├── render.ts
│   │       └── schema-helpers.ts
│   ├── services/
│   │   └── zenodo/
│   │       ├── cache.ts
│   │       ├── html-to-text.ts
│   │       ├── http.ts
│   │       ├── identifiers.ts
│   │       ├── normalize.ts
│   │       ├── query-builder.ts
│   │       ├── resource-types.ts
│   │       ├── text-preview.ts
│   │       ├── types.ts
│   │       └── zenodo-service.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   └── zenodo/
│   │       ├── awards-q-symba.json
│   │       ├── citation-22705923-apa.txt
│   │       ├── citation-22705923.bib
│   │       ├── communities-q-astronomy.json
│   │       ├── community-symbaproject.json
│   │       ├── container-7614815-monthly_shapes_0_20.json
│   │       ├── content-22917909-altersgruppen-0-299.csv
│   │       ├── error-404-funder.json
│   │       ├── error-404-pid.json
│   │       ├── funder-01cwqze88.json
│   │       ├── funders-by-doi-10.13039-100000002.json
│   │       ├── funders-q-wellcome.json
│   │       ├── licenses-q-mit.json
│   │       ├── licenses-q-nomatch.json
│   │       ├── record-1241-no-doi.json
│   │       ├── record-22705923.json
│   │       ├── record-22837418-embargoed.json
│   │       ├── record-22917909-csv.json
│   │       ├── record-22931068-restricted.json
│   │       ├── record-7126368-metadata-only.json
│   │       ├── search-climate.json
│   │       ├── search-doi-10.3897-ap.e134190.json
│   │       ├── tombstone-22705918.json
│   │       ├── tombstone-22705920.json
│   │       ├── versions-22705923-p1s3.json
│   │       └── versions-22705923-p3s25-past-end.json
│   ├── fuzz/
│   │   └── tools.fuzz.test.ts
│   ├── helpers/
│   │   └── zenodo-fixtures.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-record.tool.test.ts
│   │       │   ├── list-files.tool.test.ts
│   │       │   ├── list-versions.tool.test.ts
│   │       │   ├── lookup-vocabulary.tool.test.ts
│   │       │   ├── read-file.tool.test.ts
│   │       │   └── search-records.tool.test.ts
│   │       ├── render.test.ts
│   │       └── schema-helpers.test.ts
│   ├── services/
│   │   └── zenodo/
│   │       ├── cache.test.ts
│   │       ├── html-to-text.test.ts
│   │       ├── http.test.ts
│   │       ├── identifiers.test.ts
│   │       ├── query-builder.test.ts
│   │       ├── resource-types.test.ts
│   │       ├── text-preview.test.ts
│   │       └── zenodo-service.test.ts
│   └── smoke/
│       └── definitions.smoke.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
