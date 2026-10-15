import { describe, expect, it } from "bun:test";
import { chooseRoute, routeForRequest } from "../src/route-policy.ts";

describe("chooseRoute", () => {
  it("uses the complete chain when Caveman and Headroom are ready", () => {
    expect(chooseRoute({ cavemanViaHeadroom: true, cavemanDirect: true, headroom: true, allowDirect: false }))
      .toBe("caveman-via-headroom");
  });

  it("keeps Caveman and bypasses unavailable Headroom", () => {
    expect(chooseRoute({ cavemanViaHeadroom: true, cavemanDirect: true, headroom: false, allowDirect: false }))
      .toBe("caveman-direct");
  });

  it("uses Headroom directly when Caveman is unavailable", () => {
    expect(chooseRoute({ cavemanViaHeadroom: false, cavemanDirect: false, headroom: true, allowDirect: false }))
      .toBe("headroom-direct");
  });

  it("fails closed when both proxies are unavailable by default", () => {
    expect(chooseRoute({ cavemanViaHeadroom: false, cavemanDirect: false, headroom: false, allowDirect: false }))
      .toBeUndefined();
  });

  it("uses direct upstream only when explicitly enabled", () => {
    expect(chooseRoute({ cavemanViaHeadroom: false, cavemanDirect: false, headroom: false, allowDirect: true }))
      .toBe("upstream-direct");
  });

  it("keeps a healthy previous route on retry rather than changing mid-turn", () => {
    expect(routeForRequest(
      { cavemanViaHeadroom: true, cavemanDirect: true, headroom: true, allowDirect: false },
      { reason: "retry", failedRoute: "headroom-direct" },
    )).toBe("headroom-direct");
  });

  it("moves off a failed dependency on retry", () => {
    expect(routeForRequest(
      { cavemanViaHeadroom: true, cavemanDirect: true, headroom: false, allowDirect: false },
      { reason: "retry", failedRoute: "caveman-via-headroom" },
    )).toBe("caveman-direct");
  });

  it("keeps the previous route for tool continuations", () => {
    expect(routeForRequest(
      { cavemanViaHeadroom: false, cavemanDirect: false, headroom: true, allowDirect: false },
      { reason: "continuation", previousRoute: "caveman-via-headroom" },
    )).toBe("caveman-via-headroom");
  });
});
