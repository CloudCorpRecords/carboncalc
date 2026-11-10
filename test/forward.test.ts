import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  CarboncalcClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream
 * implementing the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, no live call — the real GreenCalculus
 * endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/greencalculus-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"factors\":[],\"count\":0}" }],
  structuredContent: { count: 0 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "greencalculus", version: "1.0.4" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new CarboncalcClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 12 tools, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 12);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 12 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "lookup_factor",
      "search_factors",
      "lookup_factors",
      "calculate_activity",
      "calculate_embodied",
      "calculate_pcaf",
      "calculate_electricity",
      "calculate_freight",
      "calculate_spend",
      "calculate_business_travel",
      "resolve_factor",
      "explain_absence",
    ]);
  });

  it("carries no title key on any tool, as captured", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal("title" in tool, false);
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
    }
  });

  it("carries exactly the fixture's required fields per tool", () => {
    const required = new Map(
      TOOL_DEFS.map((t) => [
        t.name,
        (t.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    assert.deepEqual(required.get("lookup_factor"), ["key"]);
    assert.deepEqual(required.get("search_factors"), []);
    assert.deepEqual(required.get("lookup_factors"), ["keys"]);
    assert.deepEqual(required.get("calculate_activity"), ["activity", "factor_key"]);
    assert.deepEqual(required.get("calculate_embodied"), ["materials"]);
    assert.deepEqual(required.get("calculate_pcaf"), ["holdings"]);
    assert.deepEqual(required.get("calculate_electricity"), ["consumption", "location_factor_key"]);
    assert.deepEqual(required.get("calculate_freight"), ["distance", "factor_key"]);
    assert.deepEqual(required.get("calculate_spend"), ["spend", "factor_key"]);
    assert.deepEqual(required.get("calculate_business_travel"), ["distance", "factor_key"]);
    assert.deepEqual(required.get("resolve_factor"), ["description"]);
    assert.deepEqual(required.get("explain_absence"), []);
  });

  it("carries every fixture property, in order, per tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < fixture.tools.length; i++) {
      const served = Object.keys(
        (TOOL_DEFS[i].inputSchema as { properties: object }).properties,
      );
      const expected = Object.keys(
        (fixture.tools[i].inputSchema as { properties: object }).properties,
      );
      assert.deepEqual(served, expected);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool("lookup_factor", {
      key: "grid.gbr.electricity.location_based",
    });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://mcp.greencalculus.com");

    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, {
      name: "carboncalc",
      version: VERSION,
    });
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(
        call.headers["Accept"],
        "application/json, text/event-stream",
      );
    }
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("search_factors", {});
    await c.callTool("lookup_factor", { key: "grid.gbr.electricity.location_based" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool("search_factors", {});
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the GREENCALCULUS_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new CarboncalcClient({
      fetchFn: upstream.fetchFn,
      env: { GREENCALCULUS_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool("search_factors", {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool("search_factors", {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends Authorization: Bearer <key> on every request when GREENCALCULUS_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new CarboncalcClient({
      fetchFn: upstream.fetchFn,
      env: { GREENCALCULUS_API_KEY: "gc-key-42" },
    });
    await c.callTool("search_factors", {});
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer gc-key-42",
      ),
    );
  });

  it("sends no Authorization header when GREENCALCULUS_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("search_factors", {});
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards lookup_factor arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { key: "grid.gbr.electricity.location_based" };
    await c.callTool("lookup_factor", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "lookup_factor");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards search_factors arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { query: "diesel", section: "fuels", key_prefix: "fuels.", limit: 5 };
    await c.callTool("search_factors", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "search_factors");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards search_factors with no arguments", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("search_factors", {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "search_factors");
    assert.deepEqual(params.arguments, {});
  });

  it("forwards lookup_factors arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { keys: ["grid.gbr.electricity.location_based", "grid.fra.electricity.location_based"] };
    await c.callTool("lookup_factors", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "lookup_factors");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards calculate_activity arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { activity: { value: 100, unit: "kWh" }, factor_key: "grid.gbr.electricity.location_based" };
    await c.callTool("calculate_activity", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "calculate_activity");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards calculate_embodied arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { materials: [{ material_key: "materials.concrete", quantity: { value: 2, unit: "m3" } }] };
    await c.callTool("calculate_embodied", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "calculate_embodied");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards calculate_pcaf arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { holdings: [{ outstanding_amount: 1000, denominator: { type: "evic", value: 5000 } }] };
    await c.callTool("calculate_pcaf", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "calculate_pcaf");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards calculate_electricity arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { consumption: { value: 1000, unit: "kWh" }, location_factor_key: "grid.gbr.electricity.location_based" };
    await c.callTool("calculate_electricity", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "calculate_electricity");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards calculate_freight arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { distance: { value: 500, unit: "km" }, factor_key: "freight.road_hgv.tonne_km", mass: { value: 10, unit: "tonne" } };
    await c.callTool("calculate_freight", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "calculate_freight");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards calculate_spend arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { spend: { value: 1000, currency: "USD" }, factor_key: "spend_based.us.naics6.541511.custom_computer_programming_services" };
    await c.callTool("calculate_spend", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "calculate_spend");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards calculate_business_travel arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { distance: { value: 1000, unit: "km" }, factor_key: "business_travel.air", passengers: 2 };
    await c.callTool("calculate_business_travel", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "calculate_business_travel");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards resolve_factor arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { description: "diesel per litre France" };
    await c.callTool("resolve_factor", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "resolve_factor");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards explain_absence arguments verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { country: "can", family: "water" };
    await c.callTool("explain_absence", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "explain_absence");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards explain_absence with no arguments", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("explain_absence", {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "explain_absence");
    assert.deepEqual(params.arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool("search_factors", {});
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "factor not found" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("lookup_factor", { key: "nope" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool("lookup_factor", { key: "grid.gbr.electricity.location_based" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "lookup_factor",
      { key: "grid.gbr.electricity.location_based" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "lookup_factor");
    assert.deepEqual(params.arguments, { key: "grid.gbr.electricity.location_based" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as carboncalc error text", () => {
  it("maps a JSON-RPC error to `carboncalc error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "factor not found" },
    });
    const out = await c.callTool("lookup_factor", { key: "nope" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "carboncalc error: factor not found");
  });

  it("maps an initialize JSON-RPC error to carboncalc error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool("search_factors", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "carboncalc error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool("search_factors", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "carboncalc error: malformed response");
  });

  it("maps a non-2xx upstream status to carboncalc error text", async () => {
    const { client: c } = stubClient({
      callBodyText: "internal error",
      callStatus: 500,
    });
    const out = await c.callTool("search_factors", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "carboncalc error: HTTP 500");
  });

  it("maps a throwing fetch to carboncalc error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool("search_factors", {});
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^carboncalc error: /);
  });

  it("maps a throwing initialize fetch to carboncalc error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool("search_factors", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "carboncalc error: socket hang up");
  });

  it("maps a timed-out call to carboncalc error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool("search_factors", {});
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^carboncalc error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects non-object arguments before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "lookup_factor", ["nope"]),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "lookup_factor", {
      key: "grid.gbr.electricity.location_based",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { key: "grid.gbr.electricity.location_based" });
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli(["lookup_factor", "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli(["lookup_factor", "[]"]);
    assert.equal(res.status, 2);
  });
});
