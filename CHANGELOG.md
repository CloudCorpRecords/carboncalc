# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted GreenCalculus MCP server, serving all 12 captured tools locally for tools/list and forwarding every tools/call upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when issued).
- Tools: `lookup_factor`, `search_factors`, `lookup_factors`, `calculate_activity`, `calculate_embodied`, `calculate_pcaf`, `calculate_electricity`, `calculate_freight`, `calculate_spend`, `calculate_business_travel`, `resolve_factor`, `explain_absence`.
- Upstream results pass through verbatim; upstream failures surface as `carboncalc error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). Upstream endpoint overridable via `GREENCALCULUS_MCP_URL`; when `GREENCALCULUS_API_KEY` is set it is sent as an `Authorization: Bearer <value>` header on every upstream request.
