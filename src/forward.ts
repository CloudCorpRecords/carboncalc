/**
 * carboncalc core: a forwarding client for the hosted
 * GreenCalculus MCP server.
 *
 * Nothing is computed locally. tools/list is answered
 * from the literal tool definitions below, taken verbatim
 * from a live capture of the upstream server (name,
 * description and inputSchema exactly as captured; the
 * capture carries no title key on any tool, so none is
 * reproduced). A tools/call is forwarded over a
 * streamable-HTTP JSON-RPC session: an initialize POST,
 * a notifications/initialized POST, then the tools/call
 * POST, honouring the Mcp-Session-Id response header
 * when the upstream issues one. The session is
 * established lazily on the first forwarded call and
 * reused for the lifetime of the client.
 *
 * The upstream endpoint is pinned to
 * https://mcp.greencalculus.com and can be overridden
 * with the GREENCALCULUS_MCP_URL environment variable
 * (that override is a labelled reconstruction). When
 * GREENCALCULUS_API_KEY is set in the environment, every
 * upstream request carries an
 * `Authorization: Bearer <key>` header (the Authorization
 * header name is pinned by the registry record; the
 * Bearer scheme and forwarding the key from this env
 * var are labelled reconstructions — the capture itself
 * was taken keyless). When the variable is unset, no
 * key header is sent.
 *
 * Upstream results pass through verbatim, including any
 * isError flag and any extra result fields. Failures — a
 * JSON-RPC error from the upstream, a non-2xx status, an
 * unparseable response, or a fetch that throws or times
 * out — surface as an isError result whose text starts
 * with `carboncalc error:` (that rendering is a labelled
 * reconstruction). Responses may be plain JSON or SSE
 * (data: lines); the JSON-RPC message with the matching
 * id wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://mcp.greencalculus.com";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/greencalculus-tools-original.json)      */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "lookup_factor",
    "description": "Look up a single greenhouse-gas emission factor by its canonical key. Returns the value plus an audit envelope: provenance (publisher, exact source reference, retrieval date, LICENCE and whether it may be redistributed, with the attribution the licence requires) and verification (whether the per-gas components sum to the headline, the GWP set, and the source note stating what the publisher did NOT provide). If the key does not exist you get candidate keys back rather than a dead end. Use search_factors first if you do not know the key.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Canonical factor key, e.g. \"grid.gbr.electricity.location_based\"."
        }
      },
      "required": [
        "key"
      ]
    }
  },
  {
    "name": "search_factors",
    "description": "Find emission factors by section, key prefix, or free text. Returns each match with its key, name, section, VALUE, unit and gas — enough to choose between them or read a few numbers without a second call. For one factor's full audit envelope (publisher, exact source reference, retrieval date, licence, verification) call lookup_factor; for several, call lookup_factors.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Free-text search over factor names/keys."
        },
        "section": {
          "type": "string",
          "description": "Restrict to a section, e.g. \"grid\", \"fuels\", \"freight\"."
        },
        "key_prefix": {
          "type": "string",
          "description": "Restrict to keys starting with this prefix."
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 20)."
        }
      }
    }
  },
  {
    "name": "lookup_factors",
    "description": "Look up SEVERAL emission factors by key in one call, each with the same audit envelope lookup_factor returns — provenance (publisher, exact source reference, retrieval date, licence, redistribution) and verification. Use this instead of calling lookup_factor in a loop: a portfolio or a multi-country comparison is one call, not one per factor. Keys that do not exist come back in `not_found` rather than failing the batch.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "keys": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Canonical factor keys, e.g. [\"grid.gbr.electricity.location_based\", \"grid.fra.electricity.location_based\"]. Maximum 25 per call."
        }
      },
      "required": [
        "keys"
      ]
    }
  },
  {
    "name": "calculate_activity",
    "description": "Turn activity data into greenhouse-gas emissions: emissions = activity × factor. Give an amount + unit and a factor key; the unit engine converts to the factor basis (MWh→kWh, tonne→kg, gallon→litre, mile→km) and returns the emissions with the working, the GHG Protocol scope, and the source. Use search_factors / lookup_factor to find the factor key.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "activity": {
          "type": "object",
          "description": "{ \"value\": <number>, \"unit\": \"<unit e.g. kWh, MWh, litres, tonne, km>\" }."
        },
        "factor_key": {
          "type": "string",
          "description": "Canonical emission-factor key."
        }
      },
      "required": [
        "activity",
        "factor_key"
      ]
    }
  },
  {
    "name": "calculate_embodied",
    "description": "Whole-life embodied carbon for materials, per EN 15978. Give a material key + quantity (+ optional boundary A1-A3 / A1-A4 / A1-A5 / A1-C); it assembles the declared lifecycle modules (A1-A3, B, C1-C4, D) into stages, totals the boundary, reports module D separately, and flags any missing stage as not-assessed (never zero). Find material keys via search_factors (section \"materials\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "materials": {
          "type": "array",
          "description": "Each: { material_key, quantity:{value,unit e.g. m3/kg/tonne/m2}, boundary? }.",
          "items": {
            "type": "object"
          }
        }
      },
      "required": [
        "materials"
      ]
    }
  },
  {
    "name": "calculate_pcaf",
    "description": "Compute PCAF Part A financed emissions for a portfolio. Returns each holding's attribution factor and financed emissions, the portfolio total, the outstanding-weighted data-quality score, and the audit trail (formula + PCAF source).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "asset_class": {
          "type": "string"
        },
        "holdings": {
          "type": "array",
          "description": "Each: { outstanding_amount, denominator:{type:\"evic\"|\"equity_plus_debt\", value}, company_emissions:{value,unit?} OR estimate_from_spend:{amount_usd, sector_key}, data_quality_score? }.",
          "items": {
            "type": "object"
          }
        }
      },
      "required": [
        "holdings"
      ]
    }
  },
  {
    "name": "calculate_electricity",
    "description": "GHG Protocol Scope 2 for purchased electricity, both methods. Always returns location-based (grid-average) emissions; also returns market-based when you supply a contractual supplier_factor (e.g. a green tariff / REC = 0) or a market_factor_key (residual mix). Find grid keys via search_factors (section \"grid\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "consumption": {
          "type": "object",
          "description": "{ \"value\": <number>, \"unit\": \"kWh|MWh|GWh\" }."
        },
        "location_factor_key": {
          "type": "string",
          "description": "Grid-average factor key, e.g. grid.gbr.electricity.location_based."
        },
        "market_factor_key": {
          "type": "string",
          "description": "Optional: residual-mix / supplier grid factor key."
        },
        "supplier_factor": {
          "type": "object",
          "description": "Optional contractual factor { value, unit } (wins over market_factor_key)."
        }
      },
      "required": [
        "consumption",
        "location_factor_key"
      ]
    }
  },
  {
    "name": "calculate_freight",
    "description": "Freight & logistics emissions (Scope 3 Cat 4 & 9), GLEC framework. THE FACTOR'S DENOMINATOR PICKS THE METHOD — check the factor's unit before choosing the input. Per tonne-km: emissions = tonnes × km × factor, send \"mass\". Per TEU-km (the sea-container family, e.g. freight_detailed.sea.container.trans_suez.dry): emissions = TEU × km × factor, send \"teu\" — a TEU is a twenty-foot container slot, not a mass, and a forty-foot box is 2 TEU. Sending mass against a per-TEU-km factor is refused (422), not converted. Find mode factors via search_factors (section \"freight\" or \"freight_detailed\"), e.g. freight.road_hgv.tonne_km.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "mass": {
          "type": "object",
          "description": "{ \"value\": <number>, \"unit\": \"tonne|kg|lb\" }. Required for a per-tonne-km factor; omit for a per-TEU-km one."
        },
        "teu": {
          "type": "object",
          "description": "{ \"value\": <number> } — container slots. Required for a per-TEU-km factor; omit for a per-tonne-km one."
        },
        "distance": {
          "type": "object",
          "description": "{ \"value\": <number>, \"unit\": \"km|mi|nmi\" }."
        },
        "factor_key": {
          "type": "string",
          "description": "Freight factor key. Its unit says whether to send mass (per tonne-km) or teu (per TEU-km)."
        }
      },
      "required": [
        "distance",
        "factor_key"
      ]
    }
  },
  {
    "name": "calculate_spend",
    "description": "Spend-based (EEIO) Scope 3 screening: emissions = spend × economic-intensity factor. Spend must be in the factor's own currency/year (no FX). Find sector factors via search_factors (section \"spend_based\"), e.g. spend_based.us.naics6.541511.custom_computer_programming_services.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "spend": {
          "type": "object",
          "description": "{ \"value\": <number>, \"currency\": \"USD|GBP|EUR|SGD\" }."
        },
        "factor_key": {
          "type": "string",
          "description": "Spend-based (EEIO) sector factor key."
        }
      },
      "required": [
        "spend",
        "factor_key"
      ]
    }
  },
  {
    "name": "calculate_business_travel",
    "description": "Business travel emissions (Scope 3 Cat 6), distance method: emissions = km × passengers × factor. Air factors come in with_rf / without_rf (radiative forcing) variants. Find factors via search_factors (section \"business_travel\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "distance": {
          "type": "object",
          "description": "{ \"value\": <number>, \"unit\": \"km|mi\" }."
        },
        "passengers": {
          "type": "number",
          "description": "Optional, defaults to 1."
        },
        "factor_key": {
          "type": "string",
          "description": "Per-passenger-km travel factor key."
        }
      },
      "required": [
        "distance",
        "factor_key"
      ]
    }
  },
  {
    "name": "resolve_factor",
    "description": "Find the best emission-factor key(s) for a plain-language description — the hardest step is picking the right key out of ~16,000. Returns ranked matches, each carrying the key, value, unit and a confidence score; feed the chosen key to a calculate_* tool or lookup_factor. Prefer this over guessing a key. PUT THE COUNTRY IN THE DESCRIPTION. Geography is read from the description text itself, not from a separate field — \"diesel per litre\" and \"diesel per litre France\" resolve differently, and omitting the country will quietly return a factor from somewhere else marked \"geo_match\":\"proxy\". ACT ON THE LABEL. Every candidate carries label: \"accept\" or \"review\", plus \"why\". \"accept\" means confidence >= 0.85 and no demotion applied — right about nine times in ten. \"review\" means the answer may be usable but something is off (low confidence, only one term matched, a proxy country, or a gate demoted it); confirm it before adopting the number rather than using it silently. Roughly half of CORRECT answers are also flagged \"review\" — that is the intended trade, so treat \"review\" as \"check this\", not \"discard this\". A MISS MAY EXPLAIN ITSELF. When nothing matches, or the only matches are from the wrong country, the response may carry an \"absence\" object saying WHY. classification \"structural\" means no publisher issues this anywhere — STOP, do not retry with reworded queries and do not substitute a different country without saying so. \"not_yet_sourced\" means a publisher exists and we have not ingested it (the publisher is named). \"refused\" means we found the data and declined it, with the reason. \"coupled\" means this reads empty only because a related family is empty. Use explain_absence to ask the same question directly.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "description": {
          "type": "string",
          "description": "What you need a factor for, INCLUDING the country if it matters, e.g. \"UK grid electricity\", \"diesel per litre France\", \"hotel stay Japan\". Geography is parsed from this string."
        },
        "section": {
          "type": "string",
          "description": "Optional section filter, e.g. \"fuels\", \"grid\", \"freight\"."
        },
        "limit": {
          "type": "number",
          "description": "Optional, default 5."
        }
      },
      "required": [
        "description"
      ]
    }
  },
  {
    "name": "explain_absence",
    "description": "Ask why a factor is NOT in the corpus. The reasoned counterpart to coverage: where a country reports zero rows for an inventory family, this says whether that is the world's limit or our backlog. Five classifications: \"structural\" (no publisher issues this anywhere — stop looking, and do not silently substitute another country), \"not_yet_sourced\" (a publisher exists and is named; it is our backlog), \"refused\" (we found it and declined — the reason is stated), \"held_not_counted\" (we DO hold it — see we_hold for the key), \"coupled\" (empty only because another family is empty). Each record names the publisher checked, the route tried, a confidence and a review date, and reports stale:true once past review. These are authored judgements about what the world publishes, not values derived from our data. Call this before concluding that a gap is permanent, and before telling a user to look elsewhere.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "country": {
          "type": "string",
          "description": "ISO-3166 alpha-3 code, e.g. \"can\"."
        },
        "family": {
          "type": "string",
          "description": "Inventory family, e.g. \"water\", \"wtt\", \"travel\", \"spend\", \"heat\"."
        },
        "classification": {
          "type": "string",
          "description": "Filter: structural | not_yet_sourced | refused | held_not_counted | coupled."
        }
      }
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` is one of the captured tools. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `carboncalc error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Parse a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * one is present, else the last parseable message, else
 * null when nothing parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON; ignore this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding one upstream session. The
 * session is established lazily on the first forwarded
 * call and reused for the lifetime of the client (the
 * process lifetime when the client is the MCP server's
 * or a one-shot client for the CLI).
 */
export class CarboncalcClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).GREENCALCULUS_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).GREENCALCULUS_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["Authorization"] = `Bearer ${key}`;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "carboncalc", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // The notification response body carries nothing we need.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Pass the upstream result through verbatim.
    return result;
  }
}

/** Create a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): CarboncalcClient {
  return new CarboncalcClient(deps);
}

/** One-shot helper: a fresh client per call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new CarboncalcClient(deps).callTool(name, args);
}
