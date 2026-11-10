# BUILD REPORT — carboncalc

Rebuild of `com.greencalculus/api` v1.0.4 (remote-only, keyless capture)
as `@reneturcios/carboncalc` 0.1.0 / `io.github.CloudCorpRecords/carboncalc`.

## Fixture conflicts

**None.** The brief, the spec prose, and the fixture agree on all 12 tool
names and every required field. Required fields as served, taken from
the fixture (`harness/fixtures/greencalculus-tools-original.json`):

- `lookup_factor` — required: `key`
- `search_factors` — required: (absent)
- `lookup_factors` — required: `keys`
- `calculate_activity` — required: `activity`, `factor_key`
- `calculate_embodied` — required: `materials`
- `calculate_pcaf` — required: `holdings`
- `calculate_electricity` — required: `consumption`, `location_factor_key`
- `calculate_freight` — required: `distance`, `factor_key`
- `calculate_spend` — required: `spend`, `factor_key`
- `calculate_business_travel` — required: `distance`, `factor_key`
- `resolve_factor` — required: `description`
- `explain_absence` — required: (absent)

The fixture's tool literals (name, description, inputSchema — including
every property description) are served verbatim from
`src/forward.ts`; this was verified by the registration-integrity test
(served tools/list deep-equals the fixture's 12 tool objects, in order)
and again by the parity harness. The capture carries **no `title` key**
on any tool — none was invented; a test asserts each served tool
carries exactly the keys `name`, `description`, `inputSchema`.

## What was built

All 19 factory files under `builds/carboncalc/`:

- `package.json` (`@reneturcios/carboncalc` 0.1.0, bin
  `carboncalc` → `dist/cli.js`, deps exactly `@modelcontextprotocol/sdk ^1`
  + `zod ^3`; devDeps `@types/node ^20`, `tsx ^4`, `typescript ^5`)
- `server.json` (description exactly the prescribed 89-char string
  "Sourced emission factors and carbon calculations: activity, freight, spend, travel, PCAF.";
  npm entry carries `"version": "0.1.0"`; OCI entry
  `ghcr.io/cloudcorprecords/carboncalc:0.1.0` carries **no** version field)
- `Dockerfile` (node:20-alpine both stages; server-name label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/carboncalc"`
  matches `server.json`)
- `tsconfig.json` (fleet-identical, 318 bytes), `.gitignore`,
  `package-lock.json`, `README.md` (fresh prose), `LICENSE` (MIT,
  Copyright (c) 2026 Rene Turcios), `CHANGELOG.md` (single 0.1.0 entry,
  2026-10-28)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/forward.ts` (core; exports `VERSION = "0.1.0"`)
- `test/forward.test.ts`
- `.github/workflows/{ci.yml, publish.yml, publish-container.yml,
  registry-publish.yml}` (container workflow: IMAGE
  `ghcr.io/cloudcorprecords/carboncalc`, smoke assertion on server name
  `carboncalc`)

Plus `BUILD-REPORT.md` (this file) and the `parity-out/` harness output.

## Design

- Forwarding client to `https://mcp.greencalculus.com` (pinned),
  overridable via `GREENCALCULUS_MCP_URL` (labelled reconstruction).
  tools/call is forwarded as a streamable-HTTP JSON-RPC client:
  initialize (protocolVersion `2025-03-26`, clientInfo `carboncalc`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; session established lazily and reused per client.
  Plain-JSON and SSE replies both parsed; the matching-id message
  wins; upstream results pass through verbatim (including `isError`
  and extra fields such as `structuredContent`).
- When `GREENCALCULUS_API_KEY` is set, an `Authorization: Bearer <value>`
  header is sent on every upstream request (header name pinned by the
  registry record; the Bearer scheme and forwarding it from this env
  var are labelled reconstructions — the capture was keyless). When
  unset, no key header is sent. Both branches are covered by tests.
- Upstream failures (JSON-RPC error, non-2xx status, malformed body,
  throwing/timing-out fetch) surface as `carboncalc error:` text
  results (labelled reconstruction).
- Registration via the MCP SDK **low-level** `Server` API
  (`ListToolsRequestSchema` / `CallToolRequestSchema` handlers) serving
  the fixture literals exactly; no `McpServer` + zod registration.
  `src/mcp.ts` also exports `createServer` / `startMcpServer` /
  `handleCallTool` so the MCP layer is testable without a transport;
  the CLI's `mcp` subcommand starts it over stdio.
- Core takes an injectable fetch (`ForwardDeps.fetchFn`), so all tests
  run against a stubbed JSON-RPC upstream. No live network calls in
  tests; no live call claimed anywhere. The captured surface is a
  sourced factor corpus plus calculators over caller-supplied inputs;
  the PCAF tool computes over holdings data the caller supplies, and
  no sending or payment tool exists in the surface — none was added.

## Lockfile (Route 3, clean from birth)

Generated in a temp dir (`/tmp/carboncalc-lock`) containing only the
new `package.json`: `npm install --package-lock-only --ignore-scripts
--offline`. Verified: parses, `name == @reneturcios/carboncalc`,
**128 package entries**; placed into the build dir with matching
sha256 (`0a5e8733…e5ba6` on both sides: full value
`0a5e8733193d7112c5932672588ac2b90d45484d88407b67f5ca3f170a3e5ba6`).
Then `npm install --offline --ignore-scripts` in the build dir for
`node_modules`. No write-guard failure occurred; `dist/` was built
in-tree normally, so no /tmp dist staging was needed.

## Verification (all in the build dir unless noted)

- `npx tsc --noEmit` → exit 0
- `npm run build` → real `dist/` (cli.js 2345 B approx, forward.js 24 KB,
  mcp.js 2670 B approx, all non-empty, with `.d.ts` + source maps)
- `node dist/cli.js --version` → `0.1.0`; unknown subcommand → usage on
  stderr, exit 2
- `npm test` → **47 tests, 47 pass, 0 fail** (8 suites: registration
  integrity — served tools deep-equal the fixture's full 12 tool
  objects, names in order, no title key on any tool, required fields
  and every property key in order per tool; session
  establishment/reuse/session-id handling; env URL override;
  Authorization Bearer header present on every request when the key
  is set / absent when unset; verbatim argument forwarding for all 12
  tools, including no-argument `search_factors` and `explain_absence`;
  verbatim result pass-through incl. upstream isError and SSE;
  JSON-RPC/init/malformed/HTTP/throw/timeout failures →
  `carboncalc error:`; parseRpcBody; MCP-layer validation;
  CLI --version / unknown exit 2 / bad-JSON exit 2)
- Parity: `python3 harness/parity.py --original
  harness/fixtures/greencalculus-tools-original.json --rebuild
  "stdio:node builds/carboncalc/dist/cli.js mcp" --out
  builds/carboncalc/parity-out` (run from `~/workspace/mcp-rebuild-100`)
  → **PASS, parity 100.0, 12/12 identical, no missing/extra/schema
  diffs** (see `parity-out/parity.json`)
- Consistency sweep: package.json version = server.json top-level =
  npm-entry version = OCI tag = core `VERSION` = CHANGELOG heading
  (0.1.0); package.json `mcpName` = server.json `name` = Dockerfile
  label; server.json description measured at 89 chars; OCI entry
  confirmed to have no `version` field.

Clean-room: all prose and code written fresh for carboncalc; only the
mechanics were patterned on the sibling surveyloop build, and only the
fixture's tool literals are served verbatim.
