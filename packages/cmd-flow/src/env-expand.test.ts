import { describe, it, expect } from "vitest";
import { expandEnvVars, expandFlowEnv } from "./env-expand.js";

describe("expandEnvVars", () => {
  it("expands references to other vars and defaults", () => {
    const env = expandEnvVars(
      { PORT: "10020", URL: "http://x.localhost:${PORT}", MODE: "${MISSING:-dev}" },
      {},
    );
    expect(env.URL).toBe("http://x.localhost:10020");
    expect(env.MODE).toBe("dev");
  });

  it("leaves unresolved references without a default as-is", () => {
    expect(expandEnvVars({ A: "${NOPE}" }, {}).A).toBe("${NOPE}");
  });

  it("resolves a self-reference against the outer env (the shell wins over the flow default)", () => {
    const env = expandEnvVars({ SUBJECT: "${SUBJECT:-fallback}" }, { SUBJECT: "from shell" });
    expect(env.SUBJECT).toBe("from shell");
  });

  it("falls back to the default when the outer env does not set a self-referenced var", () => {
    expect(expandEnvVars({ SUBJECT: "${SUBJECT:-fallback}" }, {}).SUBJECT).toBe("fallback");
  });

  it("resolves a self-reference without default to empty when unset outside", () => {
    expect(expandEnvVars({ SUBJECT: "pre-${SUBJECT}" }, {}).SUBJECT).toBe("pre-");
  });

  it("lets other vars see the resolved self-referenced value", () => {
    const env = expandEnvVars(
      { SUBJECT: "${SUBJECT:-fallback}", PROMPT: "draw ${SUBJECT}" },
      { SUBJECT: "clouds" },
    );
    expect(env.PROMPT).toBe("draw clouds");
  });
});

describe("expandFlowEnv", () => {
  it("returns only the flow's keys, expanded against the outer env", () => {
    const env = expandFlowEnv(
      { ROOT: "${HOME_DIR}/repo", SUBJECT: "${SUBJECT:-x}" },
      { HOME_DIR: "/h", SUBJECT: "shell", UNRELATED: "1" },
    );
    expect(env).toEqual({ ROOT: "/h/repo", SUBJECT: "shell" });
  });
});
