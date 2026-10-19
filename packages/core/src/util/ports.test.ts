import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { buildPortOverrides, parseDockerPortBindings, resolveAutoPorts, type PortEntry } from "./ports.js";

function entry(partial: Partial<PortEntry> & Pick<PortEntry, "service">): PortEntry {
  return {
    varName: null,
    defaultValue: null,
    swappable: false,
    hostExpr: "",
    target: "",
    ...partial,
  };
}

describe("parseDockerPortBindings", () => {
  it("parses ipv4 published ports", () => {
    expect(parseDockerPortBindings("0.0.0.0:10001->80/tcp")).toEqual([
      { host: 10001, target: 80 },
    ]);
  });

  it("dedupes ipv4/ipv6 duplicates of the same binding", () => {
    expect(
      parseDockerPortBindings("0.0.0.0:10001->80/tcp, [::]:10001->80/tcp"),
    ).toEqual([{ host: 10001, target: 80 }]);
  });

  it("parses multiple bindings and ignores exposed-only ports", () => {
    expect(
      parseDockerPortBindings("8080/tcp, 0.0.0.0:8090->8080/tcp, 0.0.0.0:8443->443/udp"),
    ).toEqual([
      { host: 8090, target: 8080 },
      { host: 8443, target: 443 },
    ]);
  });

  it("returns empty for no published ports", () => {
    expect(parseDockerPortBindings("")).toEqual([]);
    expect(parseDockerPortBindings("8080/tcp")).toEqual([]);
  });
});

describe("buildPortOverrides", () => {
  it("maps a reassigned auto-port var to the actual host port", () => {
    const entries = [
      entry({ service: "app-dev-proxy", varName: "APP_TOOLS_PORT", hostExpr: "${APP_TOOLS_PORT:-8091}", target: "80", swappable: true }),
      entry({ service: "app-mock", varName: "APP_SERVER_PORT", hostExpr: "${APP_SERVER_PORT:-8090}", target: "8080", swappable: true }),
    ];
    const published = new Map([
      ["app-dev-proxy", [{ host: 10001, target: 80 }]],
      ["app-mock", [{ host: 10002, target: 8080 }]],
    ]);
    expect(buildPortOverrides(entries, published)).toEqual({
      APP_TOOLS_PORT: "10001",
      APP_SERVER_PORT: "10002",
    });
  });

  it("matches the binding by target port when a service publishes several", () => {
    const entries = [
      entry({ service: "caddy", varName: "SCENARIO_PORT", hostExpr: "${SCENARIO_PORT:-8091}", target: "8091", swappable: true }),
    ];
    const published = new Map([
      ["caddy", [
        { host: 10000, target: 8091 },
        { host: 8443, target: 443 },
      ]],
    ]);
    expect(buildPortOverrides(entries, published)).toEqual({ SCENARIO_PORT: "10000" });
  });

  it("skips hardcoded ports and services that are not running", () => {
    const entries = [
      entry({ service: "db", hostExpr: "5432", target: "5432" }),
      entry({ service: "gone", varName: "GONE_PORT", hostExpr: "${GONE_PORT:-9000}", target: "9000", swappable: true }),
    ];
    const published = new Map([["web", [{ host: 8080, target: 80 }]]]);
    expect(buildPortOverrides(entries, published)).toEqual({});
  });
});

describe("resolveAutoPorts sticky env", () => {
  const RANGE = "31000-31050";

  function makeScenario(defaultPort: number): string {
    const dir = mkdtempSync(join(tmpdir(), "axn-ports-"));
    writeFileSync(
      join(dir, "compose.yaml"),
      `services:\n  web:\n    image: nginx\n    ports:\n      - "\${WEB_PORT:-${defaultPort}}:80"\n`,
    );
    return dir;
  }

  function occupy(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(port, () => resolve(s));
    });
  }

  async function freePort(): Promise<number> {
    const s = await occupy(0);
    const port = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(() => r(undefined)));
    return port;
  }

  it("reuses the sticky port instead of the declared default", async () => {
    const defaultPort = await freePort();
    const stickyPort = await freePort();
    const dir = makeScenario(defaultPort);
    const out = await resolveAutoPorts(dir, {}, true, RANGE, false, undefined, {
      WEB_PORT: String(stickyPort),
    });
    expect(out).toEqual({ WEB_PORT: String(stickyPort) });
  });

  it("picks a new free port when the sticky port is taken", async () => {
    const defaultPort = await freePort();
    const dir = makeScenario(defaultPort);
    const held = await occupy(31000);
    try {
      const out = await resolveAutoPorts(dir, {}, true, RANGE, false, undefined, {
        WEB_PORT: "31000",
      });
      const chosen = parseInt(out.WEB_PORT, 10);
      expect(chosen).toBeGreaterThanOrEqual(31000);
      expect(chosen).toBeLessThanOrEqual(31050);
      expect(chosen).not.toBe(31000);
    } finally {
      held.close();
    }
  });

  it("keeps an explicit env value even when a sticky port exists", async () => {
    const defaultPort = await freePort();
    const explicit = await freePort();
    const dir = makeScenario(defaultPort);
    const out = await resolveAutoPorts(dir, { WEB_PORT: String(explicit) }, true, RANGE, false, undefined, {
      WEB_PORT: "31000",
    });
    expect(out).toEqual({ WEB_PORT: String(explicit) });
  });

  it("keeps the declared default when there is no sticky value", async () => {
    const defaultPort = await freePort();
    const dir = makeScenario(defaultPort);
    const out = await resolveAutoPorts(dir, {}, true, RANGE, false);
    expect(out).toEqual({});
  });
});
