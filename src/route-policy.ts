export type RouteTarget = "caveman-via-headroom" | "caveman-direct" | "headroom-direct" | "upstream-direct";

export interface RouteAvailability {
  cavemanViaHeadroom: boolean;
  cavemanDirect: boolean;
  headroom: boolean;
  allowDirect: boolean;
}

export interface RequestRouteState {
  reason: "user" | "continuation" | "retry" | "direct";
  previousRoute?: RouteTarget;
  failedRoute?: RouteTarget;
}

function isReady(route: RouteTarget, available: RouteAvailability): boolean {
  switch (route) {
    case "caveman-via-headroom":
      return available.cavemanViaHeadroom && available.headroom;
    case "caveman-direct":
      return available.cavemanDirect;
    case "headroom-direct":
      return available.headroom;
    case "upstream-direct":
      return available.allowDirect;
  }
}

export function chooseRoute(available: RouteAvailability): RouteTarget | undefined {
  if (available.cavemanViaHeadroom && available.headroom) return "caveman-via-headroom";
  if (available.cavemanDirect) return "caveman-direct";
  if (available.headroom) return "headroom-direct";
  if (available.allowDirect) return "upstream-direct";
  return undefined;
}

export function routeForRequest(
  available: RouteAvailability,
  request: RequestRouteState,
): RouteTarget | undefined {
  if (request.reason === "continuation" && request.previousRoute) return request.previousRoute;
  if (request.reason === "retry" && request.failedRoute && isReady(request.failedRoute, available)) {
    return request.failedRoute;
  }
  return chooseRoute(available);
}
