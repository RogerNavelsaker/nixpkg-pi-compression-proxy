# pi-compression-proxy

Client-side Pi extension and Nix launcher for an existing Headroom -> Caveman proxy chain. This package does not install or host either service.

## Install and run

Build and install from this checkout:

```sh
nix profile install .#default
```

The package expects an existing `pi` executable in `PATH`. Supply the actual upstream model ID, provider credential, and the model's context/output limits through the agent environment. Keep the API key in your environment's secret mechanism; it is not written to Pi configuration or the Nix store.

```sh
export PROXY_CHAIN_API_KEY
export PROXY_CHAIN_MODEL_ID=claude-sonnet-4-5-20250929
export PROXY_CHAIN_CONTEXT_WINDOW=200000
export PROXY_CHAIN_MAX_TOKENS=8192
pi-compression-proxy --model pi-compression-proxy/resilient
```

The launcher adds the extension only to that Pi process. It does not modify the user's Pi profile. The route appears as `pi-compression-proxy/resilient`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PROXY_CHAIN_API_KEY` | required | Credential sent by Pi to the selected proxy endpoint; direct upstream receives the same key if explicitly enabled |
| `PROXY_CHAIN_MODEL_ID` | required | Actual provider model ID dispatched through every route; synthetic route IDs are never sent upstream |
| `PROXY_CHAIN_CONTEXT_WINDOW` | required | Shared model context limit, positive integer |
| `PROXY_CHAIN_MAX_TOKENS` | required | Shared model output limit, positive integer |
| `PROXY_CHAIN_CAVEMAN_READY_URL` | `http://127.0.0.1:8789/health/ready` | Caveman readiness URL; path must end in `/health/ready` |
| `PROXY_CHAIN_HEADROOM_READY_URL` | `http://127.0.0.1:8787/readyz` | Headroom readiness URL; path must end in `/readyz` |
| `PROXY_CHAIN_UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Direct-upstream endpoint; used only when direct fallback is enabled |
| `PROXY_CHAIN_ALLOW_DIRECT` | unset | Set to exactly `1` to opt into direct upstream when both proxies are unavailable |

Readiness URL path prefixes are preserved when deriving the API base URLs. GET probes time out after 5.5 seconds and never follow redirects. Only HTTP 503, timeout, or identified connection-refused/reset/unreachable errors mark a hop unavailable; other response statuses and unclassified failures stop routing rather than trigger failover.

## URL safety

URLs must use HTTP or HTTPS and must not contain credentials, query strings, or fragments. HTTPS is required for public and unclassified hostnames. HTTP is accepted only for loopback, private/link-local/Tailnet IP addresses, and local DNS suffixes (`.local`, `.lan`, `.internal`, `.home.arpa`, and `.ts.net`). For other private DNS names, use HTTPS. The package does not resolve hostnames to infer network scope.

## Routing and credentials

The preferred route is Pi -> Caveman -> Headroom -> upstream. If a hop is unavailable, the router can choose a healthy route that skips that hop. It does not switch away from a healthy proxy because of an application, authentication, configuration, or policy error. Tool continuations keep the selected physical endpoint; retries keep it only while its readiness dependencies remain healthy. If no proxy route is ready, requests fail closed by default.

Direct upstream mode bypasses both proxies and sends the same API key to `PROXY_CHAIN_UPSTREAM_BASE_URL`; enable it only when that is intended. Costs are reported as zero by Pi because the proxy-side rate is not known here; use the proxy/provider's accounting for actual charges.

Caveman and Headroom retrieval/MCP integrations remain separate from this transport package. Configure them through their own Pi extensions/MCP setup if needed.

## Development

```sh
bun test
nix flake check --offline
nix build --offline .#default
```

Tests inject mock readiness responses and never contact real proxy or provider endpoints.
