import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import type { ScenarioInfo } from "./repo.js";
import type { AxnDevConfig } from "./config.js";
import {
  devServerEnvPrefix,
  devServerUrlEnv,
  startDevServers,
  stopDevServers,
} from "./dev-servers.js";

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function scenario(devServers: ScenarioInfo["devServers"], worktreePath?: string): ScenarioInfo {
  return {
    name: "sim",
    path: mkdtempSync(join(tmpdir(), "devsrv-scenario-")),
    type: "shell",
    repoName: "my-hardware",
    devServers,
    worktree: worktreePath ? { path: worktreePath } : undefined,
  } as unknown as ScenarioInfo;
}

function config(): AxnDevConfig {
  return { repos: {} } as unknown as AxnDevConfig;
}

describe("devServerUrlEnv", () => {
  it("exposes <LABEL>_URL and <LABEL>_PORT per declared server", () => {
    const env = devServerUrlEnv([
      { label: "dashboard", command: "x", port: 5190 },
      { label: "mobile-app", command: "y", port: 5173 },
      { label: "noport", command: "z" },
    ]);
    expect(env.DASHBOARD_URL).toBe("http://localhost:5190");
    expect(env.DASHBOARD_PORT).toBe("5190");
    expect(env.MOBILE_APP_URL).toBe("http://localhost:5173");
    expect(env.NOPORT_URL).toBeUndefined();
  });

  it("matches the URL scheme to the probe; 'none' exposes only the port", () => {
    const env = devServerUrlEnv([
      { label: "socket", command: "x", port: 4321, probe: "tcp" },
      { label: "opaque", command: "y", port: 9999, probe: "none" },
    ]);
    expect(env.SOCKET_URL).toBe("tcp://localhost:4321");
    expect(env.SOCKET_PORT).toBe("4321");
    expect(env.OPAQUE_URL).toBeUndefined();
    expect(env.OPAQUE_PORT).toBe("9999");
  });

  it("derives the env prefix from the label", () => {
    expect(devServerEnvPrefix("sim-dashboard")).toBe("SIM_DASHBOARD");
  });
});

describe("dev-server lifecycle", () => {
  it("spawns the command, writes pid+env, stops the process group", async () => {
    const port = await freePort();
    const cwd = mkdtempSync(join(tmpdir(), "devsrv-cwd-"));
    const s = scenario([
      {
        label: "fake",
        command: `python3 -m http.server ${port} --bind 127.0.0.1`,
        port,
        env: ["MARKER=hello-${CONTROL_PORT}"],
      },
    ], cwd);

    await startDevServers(s, { CONTROL_PORT: "4242" }, config());
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.ok).toBe(true);

    stopDevServers(s);
    await new Promise((r) => setTimeout(r, 300));
    await expect(
      fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) }),
    ).rejects.toThrow();
  }, 30000);

  it("reuses a server already answering on the port and does not kill it", async () => {
    const port = await freePort();
    const server = createHttpServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const s = scenario([
        { label: "reused", command: "false", port },
      ]);
      await startDevServers(s, {}, config());
      expect((await fetch(`http://localhost:${port}/`)).ok).toBe(true);
      stopDevServers(s);
      // Untouched — we never spawned it.
      expect((await fetch(`http://localhost:${port}/`)).ok).toBe(true);
    } finally {
      server.close();
    }
  }, 15000);

  it("fails when a non-HTTP process owns the port", async () => {
    const port = await freePort();
    const server = createTcpServer((sock) => sock.end());
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const s = scenario([{ label: "busy", command: "false", port }]);
      await expect(startDevServers(s, {}, config())).rejects.toThrow(
        /dev-server busy:.*foreign process/,
      );
    } finally {
      server.close();
    }
  }, 15000);

  it("fails when the spawned command exits before answering", async () => {
    const port = await freePort();
    const cwd = mkdtempSync(join(tmpdir(), "devsrv-cwd-"));
    const s = scenario([{ label: "doomed", command: "false", port }], cwd);
    await expect(startDevServers(s, {}, config())).rejects.toThrow(
      /dev-server doomed: exited early/,
    );
  }, 15000);

  it("fails when the declared repo is not configured", async () => {
    const s = scenario([{ label: "missing", command: "sleep 60" }]);
    await expect(startDevServers(s, {}, config())).rejects.toThrow(
      /dev-server missing: repo 'my-hardware' not found/,
    );
  });

  it("reuses a bare TCP listener when probe is 'tcp'", async () => {
    const port = await freePort();
    const server = createTcpServer((sock) => sock.end());
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const s = scenario([{ label: "tsock", command: "false", port, probe: "tcp" }]);
      await startDevServers(s, {}, config());
      // Reused — no pidfile was written, so stop() must not touch it.
      stopDevServers(s);
      const sock = await new Promise<boolean>((resolve) => {
        const c = createTcpServer();
        c.on("error", () => resolve(true)); // still bound → reused, alive
        c.listen(port, "127.0.0.1", () => c.close(() => resolve(false)));
      });
      expect(sock).toBe(true);
    } finally {
      server.close();
    }
  }, 15000);

  it("does not double-spawn a portless server while its pid lives", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "devsrv-cwd-"));
    const s = scenario([{ label: "daemon", command: "sleep 60" }], cwd);
    const sleeps = () =>
      spawnSync("pgrep", ["-f", "^sleep 60$"]).stdout.toString().trim()
        .split("\n").filter(Boolean).length;
    const baseline = sleeps();

    await startDevServers(s, {}, config());
    expect(sleeps()).toBe(baseline + 1);
    await startDevServers(s, {}, config()); // live pidfile → reused
    expect(sleeps()).toBe(baseline + 1);

    stopDevServers(s);
    await new Promise((r) => setTimeout(r, 300));
    expect(sleeps()).toBe(baseline);
  }, 15000);
});
