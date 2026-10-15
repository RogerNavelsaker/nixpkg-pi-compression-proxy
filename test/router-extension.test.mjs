import { describe, expect, it } from "bun:test";
import {
  createProxyRouter,
  PROVIDER,
  registerProxyChain,
  ROUTE_MODEL_IDS,
} from "../src/router-extension.mjs";

const urls = {
  cavemanReadyUrl: "http://127.0.0.1:8789/health/ready",
  headroomReadyUrl: "http://127.0.0.1:8787/readyz",
};
const upstreamBaseUrl = "http://127.0.0.1:8790";
const upstreamModelId = "claude-test-model";
const modelIds = ROUTE_MODEL_IDS;

const baseUrls = {
  [modelIds["caveman-via-headroom"]]: "http://127.0.0.1:8789/anthropic",
  [modelIds["caveman-direct"]]: "http://127.0.0.1:8789/compat/direct-anthropic",
  [modelIds["headroom-direct"]]: "http://127.0.0.1:8787",
  [modelIds["upstream-direct"]]: upstreamBaseUrl,
};

function makeContext({ models = baseUrls, missingId, wrongBaseUrlId } = {}) {
  const entries = Object.values(modelIds)
    .filter((id) => id !== missingId)
    .map((id) => [
      id,
      {
        provider: PROVIDER,
        id,
        api: "anthropic-messages",
        baseUrl: id === wrongBaseUrlId ? "https://wrong.example" : models[id],
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: true,
      },
    ]);
  const byId = new Map(entries);
  return { modelRegistry: { find: (provider, id) => provider === PROVIDER ? byId.get(id) : undefined } };
}

function makeFetch(statusByUrl) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: statusByUrl.get(url) ?? 503 });
  };
  return { fetchImpl, calls };
}

function router(overrides = {}) {
  return createProxyRouter({
    ...urls,
    upstreamBaseUrl,
    upstreamModelId,
    ...overrides,
  });
}

describe("Pi compression proxy router", () => {
  it("selects the complete chain and dispatches the actual provider model ID", async () => {
    const { fetchImpl, calls } = makeFetch(new Map([[urls.cavemanReadyUrl, 200], [urls.headroomReadyUrl, 200]]));
    const selected = await router({ fetchImpl })(
      { reason: "user", thinkingLevel: "high", messages: [] },
      makeContext(),
    );
    expect(selected.model.id).toBe(upstreamModelId);
    expect(selected.model.provider).toBe(PROVIDER);
    expect(selected.model.baseUrl).toBe(baseUrls[modelIds["caveman-via-headroom"]]);
    expect(selected.thinkingLevel).toBe("high");
    expect(selected.state.route).toBe("caveman-via-headroom");
    expect(calls).toHaveLength(2);
    expect(calls.every(({ options }) => options.redirect === "manual")).toBe(true);
  });

  it("keeps Caveman but chooses its direct-upstream mount when Headroom is unavailable", async () => {
    const { fetchImpl } = makeFetch(new Map([[urls.cavemanReadyUrl, 200], [urls.headroomReadyUrl, 503]]));
    const selected = await router({ fetchImpl })(
      { reason: "user", thinkingLevel: "medium", messages: [] },
      makeContext(),
    );
    expect(selected.state.route).toBe("caveman-direct");
    expect(selected.model.baseUrl).toBe(baseUrls[modelIds["caveman-direct"]]);
  });

  it("uses Headroom directly when Caveman is unavailable", async () => {
    const { fetchImpl } = makeFetch(new Map([[urls.cavemanReadyUrl, 503], [urls.headroomReadyUrl, 200]]));
    const selected = await router({ fetchImpl })(
      { reason: "user", thinkingLevel: "low", messages: [] },
      makeContext(),
    );
    expect(selected.state.route).toBe("headroom-direct");
    expect(selected.model.baseUrl).toBe(baseUrls[modelIds["headroom-direct"]]);
  });

  it("fails closed when both proxies are unavailable by default", async () => {
    const { fetchImpl } = makeFetch(new Map());
    await expect(router({ fetchImpl })(
      { reason: "user", thinkingLevel: "off", messages: [] },
      makeContext(),
    )).rejects.toThrow("No proxy route is ready");
  });

  it("uses direct upstream only with explicit opt-in", async () => {
    const { fetchImpl } = makeFetch(new Map());
    const selected = await router({ fetchImpl, allowDirect: true })(
      { reason: "user", thinkingLevel: "off", messages: [] },
      makeContext(),
    );
    expect(selected.state.route).toBe("upstream-direct");
    expect(selected.model.id).toBe(upstreamModelId);
    expect(selected.model.baseUrl).toBe(upstreamBaseUrl);
  });

  it("keeps the exact selected model through continuations without probing", async () => {
    const firstFetch = makeFetch(new Map([[urls.cavemanReadyUrl, 200], [urls.headroomReadyUrl, 200]]));
    const route = router({ fetchImpl: firstFetch.fetchImpl });
    const context = makeContext();
    const first = await route(
      { reason: "user", thinkingLevel: "high", messages: [] },
      context,
    );
    const nextFetch = makeFetch(new Map());
    const continuation = await router({ fetchImpl: nextFetch.fetchImpl })(
      {
        reason: "continuation",
        previous: { model: first.model, thinkingLevel: "high" },
        thinkingLevel: "low",
        messages: [],
      },
      context,
    );
    expect(continuation.model).toBe(first.model);
    expect(continuation.thinkingLevel).toBe("high");
    expect(continuation.state.route).toBe("caveman-via-headroom");
    expect(nextFetch.calls).toHaveLength(0);
  });

  it("retains a failed route on retry while its readiness dependencies are healthy", async () => {
    const { fetchImpl } = makeFetch(new Map([[urls.cavemanReadyUrl, 200], [urls.headroomReadyUrl, 200]]));
    const context = makeContext();
    const failedModel = {
      ...context.modelRegistry.find(PROVIDER, modelIds["caveman-via-headroom"]),
      id: upstreamModelId,
    };
    const selected = await router({ fetchImpl })(
      {
        reason: "retry",
        failed: { model: failedModel, thinkingLevel: "high", message: { errorMessage: "HTTP 503" } },
        thinkingLevel: "low",
        messages: [],
      },
      context,
    );
    expect(selected.state.route).toBe("caveman-via-headroom");
    expect(selected.model.baseUrl).toBe(baseUrls[modelIds["caveman-via-headroom"]]);
  });

  it("moves off an unavailable failed dependency on retry", async () => {
    const { fetchImpl } = makeFetch(new Map([[urls.cavemanReadyUrl, 200], [urls.headroomReadyUrl, 503]]));
    const context = makeContext();
    const failedModel = {
      ...context.modelRegistry.find(PROVIDER, modelIds["caveman-via-headroom"]),
      id: upstreamModelId,
    };
    const selected = await router({ fetchImpl })(
      {
        reason: "retry",
        failed: { model: failedModel, thinkingLevel: "high", message: { errorMessage: "HTTP 503" } },
        thinkingLevel: "low",
        messages: [],
      },
      context,
    );
    expect(selected.state.route).toBe("caveman-direct");
  });

  it("rejects a missing or mismatched route model instead of dispatching it", async () => {
    const { fetchImpl } = makeFetch(new Map([[urls.cavemanReadyUrl, 200], [urls.headroomReadyUrl, 200]]));
    await expect(router({ fetchImpl })(
      { reason: "user", thinkingLevel: "off", messages: [] },
      makeContext({ missingId: modelIds["caveman-via-headroom"] }),
    )).rejects.toThrow("Physical model for route");
    await expect(router({ fetchImpl })(
      { reason: "user", thinkingLevel: "off", messages: [] },
      makeContext({ wrongBaseUrlId: modelIds["caveman-via-headroom"] }),
    )).rejects.toThrow("Physical model for route");
  });
});

describe("proxy endpoint validation", () => {
  it("accepts public HTTPS endpoints and preserves readiness path prefixes", async () => {
    const remoteUrls = {
      cavemanReadyUrl: "https://caveman.example.net/prefix/health/ready",
      headroomReadyUrl: "https://headroom.example.net/edge/readyz",
    };
    const expected = {
      [modelIds["caveman-via-headroom"]]: "https://caveman.example.net/prefix/anthropic",
      [modelIds["caveman-direct"]]: "https://caveman.example.net/prefix/compat/direct-anthropic",
      [modelIds["headroom-direct"]]: "https://headroom.example.net/edge",
      [modelIds["upstream-direct"]]: upstreamBaseUrl,
    };
    const { fetchImpl } = makeFetch(new Map([[remoteUrls.cavemanReadyUrl, 200], [remoteUrls.headroomReadyUrl, 200]]));
    const selected = await router({ ...remoteUrls, fetchImpl })(
      { reason: "user", thinkingLevel: "medium", messages: [] },
      makeContext({ models: expected }),
    );
    expect(selected.model.baseUrl).toBe(expected[modelIds["caveman-via-headroom"]]);
  });

  it("allows HTTP to private and Tailnet addresses", () => {
    expect(() => router({
      cavemanReadyUrl: "http://10.4.0.2:8789/health/ready",
      headroomReadyUrl: "http://100.64.0.3:8787/readyz",
    })).not.toThrow();
    expect(() => router({
      cavemanReadyUrl: "http://[fd00::5]:8789/health/ready",
      headroomReadyUrl: "http://headroom.tailnet.ts.net:8787/readyz",
    })).not.toThrow();
  });

  it("requires HTTPS for public and unclassified HTTP endpoints", () => {
    expect(() => router({ cavemanReadyUrl: "http://proxy.example.net/health/ready" }))
      .toThrow("must use HTTPS");
    expect(() => router({ headroomReadyUrl: "http://172.32.1.1:8787/readyz" }))
      .toThrow("must use HTTPS");
    expect(() => router({ upstreamBaseUrl: "http://api.example.net" }))
      .toThrow("must use HTTPS");
  });

  it("rejects unsupported schemes, credentials, query strings, and fragments", () => {
    expect(() => router({ cavemanReadyUrl: "ftp://127.0.0.1/health/ready" })).toThrow("HTTP(S)");
    expect(() => router({ cavemanReadyUrl: "https://user:pass@proxy.example/health/ready" }))
      .toThrow("without credentials");
    expect(() => router({ cavemanReadyUrl: "https://proxy.example/health/ready?token=x" }))
      .toThrow("without credentials");
    expect(() => router({ headroomReadyUrl: "https://proxy.example/readyz#status" }))
      .toThrow("without credentials");
  });

  it("requires expected readiness paths so API endpoints can be derived safely", () => {
    expect(() => router({ cavemanReadyUrl: "https://proxy.example/ready" }))
      .toThrow("must end with /health/ready");
    expect(() => router({ headroomReadyUrl: "https://proxy.example/health/ready" }))
      .toThrow("must end with /readyz");
  });

  it("fails closed on authentication and configuration responses from readiness probes", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const { fetchImpl } = makeFetch(new Map([[urls.cavemanReadyUrl, status], [urls.headroomReadyUrl, 200]]));
      await expect(router({ fetchImpl })(
        { reason: "user", thinkingLevel: "off", messages: [] },
        makeContext(),
      )).rejects.toThrow("HTTP " + status);
    }
  });

  it("does not follow readiness redirects or fail over on them", async () => {
    const { fetchImpl, calls } = makeFetch(new Map([[urls.cavemanReadyUrl, 302], [urls.headroomReadyUrl, 200]]));
    await expect(router({ fetchImpl })(
      { reason: "user", thinkingLevel: "off", messages: [] },
      makeContext(),
    )).rejects.toThrow("redirect");
    expect(calls.find(({ url }) => url === urls.cavemanReadyUrl).options.redirect).toBe("manual");
  });

  it("fails over on a positively identified connection refusal", async () => {
    const fetchImpl = async (url) => {
      if (url === urls.cavemanReadyUrl) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
        });
      }
      return new Response(null, { status: 200 });
    };
    const selected = await router({ fetchImpl })(
      { reason: "user", thinkingLevel: "off", messages: [] },
      makeContext(),
    );
    expect(selected.state.route).toBe("headroom-direct");
  });

  it("fails closed on unclassified probe errors rather than assuming unavailability", async () => {
    const fetchImpl = async (url) => {
      if (url === urls.cavemanReadyUrl) throw new TypeError("fetch failed");
      return new Response(null, { status: 200 });
    };
    await expect(router({ fetchImpl })(
      { reason: "user", thinkingLevel: "off", messages: [] },
      makeContext(),
    )).rejects.toThrow("refusing failover");
  });

});

describe("Pi extension registration", () => {
  const env = {
    PROXY_CHAIN_API_KEY: "test-only-key",
    PROXY_CHAIN_MODEL_ID: "claude-test-model",
    PROXY_CHAIN_CONTEXT_WINDOW: "200000",
    PROXY_CHAIN_MAX_TOKENS: "8192",
    PROXY_CHAIN_CAVEMAN_READY_URL: "https://caveman.example/prefix/health/ready",
    PROXY_CHAIN_HEADROOM_READY_URL: "http://100.64.0.3:8787/readyz",
  };

  it("registers the dedicated provider and resilient virtual model without replacing Anthropic", () => {
    const calls = [];
    const pi = {
      registerProvider: (...args) => calls.push(["provider", ...args]),
      registerVirtualModel: (model) => calls.push(["virtual", model]),
    };
    registerProxyChain(pi, env);

    const providerCall = calls.find(([kind]) => kind === "provider");
    const virtualCall = calls.find(([kind]) => kind === "virtual");
    expect(providerCall[1]).toBe(PROVIDER);
    expect(providerCall[2].apiKey).toBe("$PROXY_CHAIN_API_KEY");
    expect(providerCall[2].models).toHaveLength(4);
    expect(providerCall[2].models[0].baseUrl).toBe("https://caveman.example/prefix/anthropic");
    expect(virtualCall[1].provider).toBe(PROVIDER);
    expect(virtualCall[1].id).toBe("resilient");
  });

  it("requires runtime credentials, model identity, and limits", () => {
    const pi = { registerProvider() {}, registerVirtualModel() {} };
    expect(() => registerProxyChain(pi, { ...env, PROXY_CHAIN_API_KEY: "" }))
      .toThrow("PROXY_CHAIN_API_KEY");
    expect(() => registerProxyChain(pi, { ...env, PROXY_CHAIN_MODEL_ID: "" }))
      .toThrow("PROXY_CHAIN_MODEL_ID");
    expect(() => registerProxyChain(pi, { ...env, PROXY_CHAIN_CONTEXT_WINDOW: "12x" }))
      .toThrow("positive integer");
    expect(() => registerProxyChain(pi, { ...env, PROXY_CHAIN_MAX_TOKENS: "0" }))
      .toThrow("positive integer");
  });
});
