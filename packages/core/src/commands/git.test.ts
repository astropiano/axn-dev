import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describeRepos } from "./git.js";

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A repo with one commit, an origin URL and one linked worktree. */
function repoWithWorktree(): { main: string; wt: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axn-git-repos-")));
  const main = join(base, "app");
  const wt = join(base, "app-feat");
  spawnSync("git", ["init", "-q", "-b", "main", main]);
  sh(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  sh(main, "remote", "add", "origin", "git@example.com:group/sub/app.git");
  sh(main, "worktree", "add", "-q", "-b", "feat/x", wt);
  return { main, wt };
}

describe("describeRepos", () => {
  it("reports remote and every worktree, main first", () => {
    const { main, wt } = repoWithWorktree();
    const [r] = describeRepos([{ name: "app", path: main }]);
    expect(r).toEqual({
      name: "app",
      path: main,
      remote: "git@example.com:group/sub/app.git",
      worktrees: [
        { path: main, branch: "main", isMain: true },
        { path: wt, branch: "feat/x", isMain: false },
      ],
    });
  });

  it("resolves the remote when the configured path is a linked worktree", () => {
    const { main, wt } = repoWithWorktree();
    const [r] = describeRepos([{ name: "app", path: wt }]);
    expect(r.remote).toBe("git@example.com:group/sub/app.git");
    expect(r.worktrees[0]).toEqual({ path: main, branch: "main", isMain: true });
  });

  it("keeps a repo without origin, with a null remote", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "axn-git-repos-")));
    spawnSync("git", ["init", "-q", "-b", "main", base]);
    const [r] = describeRepos([{ name: "bare", path: base }]);
    expect(r.remote).toBeNull();
  });
});
