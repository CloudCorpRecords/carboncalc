# carboncalc

carboncalc is a small local bridge to the hosted
GreenCalculus MCP server, a sourced corpus of
greenhouse-gas emission factors plus deterministic
calculators built on top of it. You can look a factor
up by its canonical key and get back not just the
value but an audit envelope — who published it, the
exact source reference, when it was retrieved, what
licence covers it and whether the per-gas components
add up — or search and resolve factors from a
plain-language description when you do not yet know
the key.

On top of that corpus sit the calculators: activity
data into emissions, whole-life embodied carbon for
materials, PCAF financed emissions for a portfolio
you supply, Scope 2 electricity under both methods,
freight under the GLEC framework, spend-based EEIO
screening, and business travel by distance. A
companion tool explains why a factor is absent from
the corpus — whether no publisher issues it anywhere,
it has not been sourced yet, it was declined, or the
gap is coupled to another empty family.

The bridge keeps no factor data of its own. It serves
the upstream server's tool list locally, exactly as
captured from the live endpoint, and forwards each
tool call upstream, returning the result untouched.
Calculations run over inputs the caller supplies;
there is no sending or payment tool in the surface.

## Tools

- `lookup_factor` — look up one emission factor by
  canonical key, with its full audit envelope.
  Required: `key`.
- `search_factors` — find factors by free text,
  section, or key prefix. Optional: `query`,
  `section`, `key_prefix`, `limit`.
- `lookup_factors` — look up several factors by key
  in one call, each with its audit envelope.
  Required: `keys`.
- `calculate_activity` — emissions = activity ×
  factor, with unit conversion to the factor basis.
  Required: `activity`, `factor_key`.
- `calculate_embodied` — whole-life embodied carbon
  for materials per EN 15978. Required: `materials`.
- `calculate_pcaf` — PCAF Part A financed emissions
  for a portfolio. Required: `holdings`. Optional:
  `asset_class`.
- `calculate_electricity` — GHG Protocol Scope 2 for
  purchased electricity, location-based and (when a
  market factor or supplier factor is given)
  market-based. Required: `consumption`,
  `location_factor_key`.
- `calculate_freight` — freight and logistics
  emissions (GLEC); the factor's denominator decides
  whether to send `mass` or `teu`. Required:
  `distance`, `factor_key`.
- `calculate_spend` — spend-based (EEIO) Scope 3
  screening: emissions = spend × intensity factor.
  Required: `spend`, `factor_key`.
- `calculate_business_travel` — business travel
  emissions by the distance method. Required:
  `distance`, `factor_key`. Optional: `passengers`.
- `resolve_factor` — find the best factor key(s) for
  a plain-language description, country included in
  the text. Required: `description`.
- `explain_absence` — ask why a factor is not in the
  corpus. Optional: `country`, `family`,
  `classification`.

## Configuration

- `GREENCALCULUS_MCP_URL` (optional) — override the
  upstream endpoint. Defaults to
  `https://mcp.greencalculus.com`. (The override hook
  is this rebuild's own labelled reconstruction.)
- `GREENCALCULUS_API_KEY` (optional) — when set,
  every upstream request carries an
  `Authorization: Bearer <key>` header, for the
  caller's own GreenCalculus key. When it is not set,
  no key header is sent. (The header name is pinned
  by the original's registry record; the Bearer scheme
  and this env forwarding are labelled
  reconstructions — the original surface was captured
  keyless.)

### Forwarding mechanics

On the first tool call the client opens a streamable
HTTP session with the upstream: a JSON-RPC
`initialize` request (protocolVersion `2025-03-26`,
clientInfo name `carboncalc`), then a
`notifications/initialized` notification, then the
`tools/call` request carrying the caller's arguments
unchanged. When the upstream answers `initialize`
with an `Mcp-Session-Id` header, that value rides on
every later request of the session, which is reused
for the life of the process. Replies may arrive as
plain JSON or as server-sent events; both are read.

Successful upstream results pass through verbatim,
including any `isError` flag the upstream sets.
Failures — a JSON-RPC error, a non-2xx status, an
unreadable response, or a request that cannot be
completed — come back as an `isError` result whose
text starts with `carboncalc error:` (this rendering
is this rebuild's own labelled reconstruction).

## CLI

Each tool is also a subcommand taking one JSON
argument string:

```bash
npx @reneturcios/carboncalc lookup_factor '{"key":"grid.gbr.electricity.location_based"}'
npx @reneturcios/carboncalc calculate_freight '{"distance":{"value":500,"unit":"km"},"factor_key":"freight.road_hgv.tonne_km","mass":{"value":10,"unit":"tonne"}}'
npx @reneturcios/carboncalc --version
```

Exit codes: `0` on success, `1` on an `isError`
result, `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/carboncalc mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "carboncalc": {
      "command": "npx",
      "args": ["-y", "@reneturcios/carboncalc", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/carboncalc
docker run --rm ghcr.io/cloudcorprecords/carboncalc --version
```

The container's default command is `mcp`, so the first
form is a stdio MCP server; any other arguments reach
the CLI normally.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs entirely against a stubbed
JSON-RPC upstream — no live network calls.

## License

MIT — see `LICENSE`.
