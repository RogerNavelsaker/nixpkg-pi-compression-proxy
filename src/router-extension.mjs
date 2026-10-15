import { isIP } from "node:net";
import { routeForRequest } from "./route-policy.ts";

export const PROVIDER = "pi-compression-proxy";
export const ROUTE_MODEL_IDS = Object.freeze({
  "caveman-via-headroom": "chain-caveman-full",
  "caveman-direct": "chain-caveman-direct",
  "headroom-direct": "chain-headroom-direct",
  "upstream-direct": "chain-upstream-direct",
});

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LOCAL_SUFFIXES = ["local", "lan", "internal", "home.arpa", "ts.net"];

function isPrivateOrLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const family = isIP(host);

  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127
    );
  }

  if (family === 6) {
    return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith("." + suffix))
  );
}

function parseEndpoint(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(name + " must be a valid HTTP(S) URL");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(name + " must be a valid HTTP(S) URL");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(name + " must be an HTTP(S) URL without credentials, query, or fragment");
  }
  if (url.protocol === "http:" && !isPrivateOrLocalHost(url.hostname)) {
    throw new Error(name + " must use HTTPS for public or unclassified hosts");
  }
  return url;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = parseEndpoint(value, "Model base URL");
  } catch {
    return undefined;
  }
  return url.href.replace(/\/+$/, "");
}

function baseFromReadinessUrl(url, suffix, name) {
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(suffix)) {
    throw new Error(name + " must end with " + suffix);
  }
  const prefix = path.slice(0, -suffix.length).replace(/\/+$/, "");
  url.pathname = path;
  return { readyUrl: url.href, baseUrl: url.origin + prefix };
}

export function resolveProxyEndpoints({
  cavemanReadyUrl = "http://127.0.0.1:8789/health/ready",
  headroomReadyUrl = "http://127.0.0.1:8787/readyz",
  upstreamBaseUrl = "https://api.anthropic.com",
} = {}) {
  const caveman = parseEndpoint(cavemanReadyUrl, "Caveman readiness URL");
  const headroom = parseEndpoint(headroomReadyUrl, "Headroom readiness URL");
  const upstream = parseEndpoint(upstreamBaseUrl, "Upstream base URL");
  const cavemanEndpoint = baseFromReadinessUrl(caveman, "/health/ready", "Caveman readiness URL");
  const headroomEndpoint = baseFromReadinessUrl(headroom, "/readyz", "Headroom readiness URL");
  const normalizedUpstream = upstream.href.replace(/\/+$/, "");

  return {
    cavemanReadyUrl: cavemanEndpoint.readyUrl,
    headroomReadyUrl: headroomEndpoint.readyUrl,
    upstreamBaseUrl: normalizedUpstream,
    expectedBaseUrls: {
      "caveman-via-headroom": cavemanEndpoint.baseUrl + "/anthropic",
      "caveman-direct": cavemanEndpoint.baseUrl + "/compat/direct-anthropic",
      "headroom-direct": headroomEndpoint.baseUrl,
      "upstream-direct": normalizedUpstream,
    },
  };
}

function requirePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(name + " must be a positive integer");
  }
  return parsed;
}

function requireModelId(value) {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Set PROXY_CHAIN_MODEL_ID to the actual provider model identifier");
  }
  return value;
}

export function createProviderConfig(expectedBaseUrls, contextWindow, maxTokens) {
  const models = Object.entries(ROUTE_MODEL_IDS).map(([route, id]) => ({
    id,
    name: "Pi Compression Proxy (" + route + ")",
    api: "anthropic-messages",
    baseUrl: expectedBaseUrls[route],
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow,
    maxTokens,
  }));

  return {
    name: "Pi Compression Proxy",
    baseUrl: expectedBaseUrls["upstream-direct"],
    api: "anthropic-messages",
    apiKey: "$PROXY_CHAIN_API_KEY",
    models,
  };
}

const UNAVAILABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function isConfirmedUnavailable(error) {
  return (
    error?.name === "AbortError" ||
    UNAVAILABLE_NETWORK_CODES.has(error?.cause?.code ?? error?.code)
  );
}

async function ready(url, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "manual", signal });
    await response.body?.cancel();
  } catch (error) {
    if (signal.aborted || isConfirmedUnavailable(error)) return false;
    throw new Error("Readiness probe failed; refusing failover: " + (error?.message ?? String(error)), { cause: error });
  }

  if (response.status >= 200 && response.status < 300) return true;
  if (response.status === 503) return false;
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Readiness probe returned redirect HTTP " + response.status + "; refusing failover");
  }
  throw new Error("Readiness probe returned HTTP " + response.status + "; refusing failover");
}

export function createProxyRouter({
  cavemanReadyUrl,
  headroomReadyUrl,
  allowDirect = false,
  timeoutMs = 5500,
  fetchImpl = fetch,
  provider = PROVIDER,
  upstreamBaseUrl = "https://api.anthropic.com",
  upstreamModelId,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Readiness timeout must be a positive integer");
  }
  const endpoints = resolveProxyEndpoints({ cavemanReadyUrl, headroomReadyUrl, upstreamBaseUrl });
  const actualModelId = requireModelId(upstreamModelId);
  const expectedBaseUrls = endpoints.expectedBaseUrls;

  function routeForModel(model) {
    if (!model || model.provider !== provider) return undefined;
    return Object.entries(expectedBaseUrls).find(([, baseUrl]) =>
      normalizeBaseUrl(model.baseUrl) === normalizeBaseUrl(baseUrl)
    )?.[0];
  }

  async function availability(signal) {
    const [caveman, headroom] = await Promise.all([
      ready(endpoints.cavemanReadyUrl, fetchImpl, signal),
      ready(endpoints.headroomReadyUrl, fetchImpl, signal),
    ]);
    return {
      cavemanViaHeadroom: caveman && headroom,
      cavemanDirect: caveman,
      headroom,
      allowDirect,
    };
  }

  return async (request, ctx) => {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const previousRoute = routeForModel(request.previous?.model);
    if (request.reason === "continuation" && previousRoute) {
      return {
        model: request.previous.model,
        thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
        state: { route: previousRoute },
      };
    }
    const failedRoute = request.reason === "retry" ? routeForModel(request.failed?.model) : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    let selected;
    try {
      const available = await availability(signal);
      if (request.signal?.aborted) {
        throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      selected = routeForRequest(available, {
        reason: request.reason,
        previousRoute,
        failedRoute,
      });
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!selected) {
      throw new Error("No proxy route is ready; direct upstream fallback is disabled");
    }
    const model = ctx.modelRegistry.find(provider, ROUTE_MODEL_IDS[selected]);
    if (
      !model ||
      model.provider !== provider ||
      model.api !== "anthropic-messages" ||
      normalizeBaseUrl(model.baseUrl) !== normalizeBaseUrl(expectedBaseUrls[selected])
    ) {
      throw new Error("Physical model for route " + selected + " is missing or its endpoint does not match");
    }

    const thinkingLevel =
      request.reason === "retry" && request.failed?.thinkingLevel
        ? request.failed.thinkingLevel
        : request.thinkingLevel;
    return {
      model: { ...model, id: actualModelId, name: actualModelId },
      thinkingLevel,
      state: { route: selected },
    };
  };
}

export function registerProxyChain(pi, env = process.env) {
  if (typeof env.PROXY_CHAIN_API_KEY !== "string" || !env.PROXY_CHAIN_API_KEY.trim()) {
    throw new Error("Set PROXY_CHAIN_API_KEY in the runtime environment");
  }
  const contextWindow = requirePositiveInteger(env.PROXY_CHAIN_CONTEXT_WINDOW, "PROXY_CHAIN_CONTEXT_WINDOW");
  const maxTokens = requirePositiveInteger(env.PROXY_CHAIN_MAX_TOKENS, "PROXY_CHAIN_MAX_TOKENS");
  const upstreamModelId = requireModelId(env.PROXY_CHAIN_MODEL_ID);
  const endpointConfig = {
    cavemanReadyUrl: env.PROXY_CHAIN_CAVEMAN_READY_URL,
    headroomReadyUrl: env.PROXY_CHAIN_HEADROOM_READY_URL,
    upstreamBaseUrl: env.PROXY_CHAIN_UPSTREAM_BASE_URL ?? "https://api.anthropic.com",
  };
  const endpoints = resolveProxyEndpoints(endpointConfig);

  pi.registerProvider(PROVIDER, createProviderConfig(endpoints.expectedBaseUrls, contextWindow, maxTokens));
  pi.registerVirtualModel({
    provider: PROVIDER,
    id: "resilient",
    name: "Caveman -> Headroom resilient route",
    thinkingLevels: THINKING_LEVELS,
    contextWindow,
    maxTokens,
    route: createProxyRouter({
      ...endpointConfig,
      allowDirect: env.PROXY_CHAIN_ALLOW_DIRECT === "1",
      upstreamModelId,
    }),
  });
}

export default function registerProxyChainExtension(pi) {
  registerProxyChain(pi);
}
