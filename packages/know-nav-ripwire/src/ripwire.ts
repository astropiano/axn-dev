import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { CodeLocation, NavigationHit, NavigationQuery, NavigationResult } from "@axn-dev/core";

export interface RipwireOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs `ripwire <root> <args>`; injectable so tests need no binary. */
export type RipwireRunner = (root: string, args: string[]) => Promise<RipwireOutput>;

/** What ripwire says about the reliability of a result. */
interface Gauges {
  defs?: number;
  countsFloor?: boolean;
  unresolved?: number;
  ambiguous?: number;
}

/**
 * The ripwire selector for a location. A member is qualified by its file, as
 * ripwire disambiguates `File.java:name`. A type stays unqualified: with a file
 * qualifier `--uses` narrows to uses inside that file, and loses every subclass.
 */
export function selectorFor(location: CodeLocation): string {
  return location.memberName ? `${basename(location.path)}:${location.memberName}` : location.typeName;
}

export function argsFor(query: NavigationQuery, location: CodeLocation, target?: CodeLocation): string[] {
  const sel = selectorFor(location);
  switch (query) {
    case "impact":
      return [`--impact=${sel}`, "--json"];
    case "path":
      if (!target) throw new Error("A path needs a second symbol to lead to.");
      return [`--path=${sel},${selectorFor(target)}`];
    case "callers":
      return [`--callers=${sel}`, "--json"];
    case "callees":
      return [`--callees=${sel}`, "--json"];
    // ripwire's --lego reports no implementors on Java; --uses tags both
    // `extends` and `implements` as role "extends".
    case "implementations":
      return [`--uses=${location.typeName}`];
    case "references":
      return [`--uses=${sel}`];
  }
}

/** Split ripwire's `relative/path:line` into an absolute path and a line. */
function hitLocation(p: string, root: string): Pick<NavigationHit, "path" | "line"> {
  const m = /^(.*):(\d+)$/.exec(p);
  return m ? { path: resolve(root, m[1]), line: Number(m[2]) } : { path: resolve(root, p) };
}

/** `--callers`/`--callees`/`--impact` with `--json`: `{ <key>: [{ t, n, p }], defs, counts_floor, … }`. */
export function parseJsonList(stdout: string, key: "callers" | "callees" | "impact", root: string): { hits: NavigationHit[]; gauges: Gauges } {
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  const rows = (doc[key] as { t?: string; n?: string; p: string }[] | undefined) ?? [];
  return {
    hits: rows.map((r) => ({ ...hitLocation(r.p, root), symbol: r.n, kind: r.t })),
    gauges: {
      defs: doc.defs as number | undefined,
      countsFloor: doc.counts_floor === true,
      unresolved: doc.graph_unresolved as number | undefined,
      ambiguous: doc.graph_ambiguous as number | undefined,
    },
  };
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** `--uses` has no JSON form: `<uses defs=… counts_floor=…>` then `<u role=… p=… in_id=…/>` rows. */
export function parseUses(stdout: string, root: string, roles?: string[]): { hits: NavigationHit[]; gauges: Gauges } {
  const header = /<uses [^>]*>/.exec(stdout)?.[0] ?? "";
  const hits: NavigationHit[] = [];
  for (const [row] of stdout.matchAll(/<u role="[^"]*"[^>]*>/g)) {
    const role = attr(row, "role")!;
    if (roles && !roles.includes(role)) continue;
    const p = attr(row, "p");
    if (!p) continue;
    hits.push({ ...hitLocation(p, root), symbol: attr(row, "in_id"), kind: role });
  }
  const num = (n: string) => (attr(header, n) === undefined ? undefined : Number(attr(header, n)));
  return {
    hits,
    gauges: { defs: num("defs"), countsFloor: attr(header, "counts_floor") === "1", unresolved: num("graph_unresolved"), ambiguous: num("graph_ambiguous") },
  };
}

function caveats(query: NavigationQuery, location: CodeLocation, sel: string, gauges: Gauges): string[] {
  const out: string[] = [];
  if (!location.memberName && (query === "callers" || query === "callees")) {
    out.push(`'${sel}' is a type, and ripwire reports ${query} of methods; try references or implementations.`);
  }
  if (gauges.defs !== undefined && gauges.defs > 1) {
    out.push(`'${sel}' matches ${gauges.defs} definitions; the hits may mix them.`);
  }
  if (gauges.countsFloor) {
    const unresolved = `ripwire left ${gauges.unresolved ?? "some"} references unresolved and ${gauges.ambiguous ?? "some"} ambiguous in this repo`;
    out.push(query === "path"
      ? `Not final: ${unresolved}, so a shorter path, or one reported missing, may exist.`
      : `A lower bound: ${unresolved}, so some ${query} may be missing.`);
  }
  return out;
}

/**
 * `--path` has no JSON form: `<path reachable=… hops=… hint=…>` then one
 * `<s t= n= p=/>` per hop, both ends included. With no directed path, the
 * hint says what to try instead; it becomes a caveat.
 */
export function parsePath(stdout: string, root: string): { hits: NavigationHit[]; gauges: Gauges; noPathHint?: string } {
  const header = /<path [^>]*>/.exec(stdout)?.[0] ?? "";
  const hits: NavigationHit[] = [];
  for (const [row] of stdout.matchAll(/<s t="[^"]*"[^>]*>/g)) {
    const p = attr(row, "p");
    if (p) hits.push({ ...hitLocation(p, root), symbol: attr(row, "n"), kind: attr(row, "t") });
  }
  const num = (n: string) => (attr(header, n) === undefined ? undefined : Number(attr(header, n)));
  return {
    hits,
    gauges: { countsFloor: attr(header, "counts_floor") === "1", unresolved: num("graph_unresolved"), ambiguous: num("graph_ambiguous") },
    noPathHint: attr(header, "reachable") === "0" ? attr(header, "hint") ?? "" : undefined,
  };
}

/** ripwire exits 1 with one of these when the selector names nothing it indexed. */
const NOT_FOUND = /symbol not found|matched no indexed definition/;

export async function navigate(
  query: NavigationQuery,
  location: CodeLocation,
  root: string,
  run: RipwireRunner,
  target?: CodeLocation,
): Promise<NavigationResult> {
  const sel = query === "implementations" ? location.typeName : selectorFor(location);
  const out = await run(root, argsFor(query, location, target));

  if (out.exitCode !== 0) {
    if (NOT_FOUND.test(out.stderr)) {
      return { navigator: "ripwire", hits: [], caveats: [`ripwire found no definition of '${sel}' under ${root}.`] };
    }
    throw new Error(`ripwire failed (exit ${out.exitCode}): ${out.stderr.trim().split("\n")[0]}`);
  }

  if (query === "path") {
    const { hits, gauges, noPathHint } = parsePath(out.stdout, root);
    const found = noPathHint === undefined
      ? []
      : [`No directed call path from '${sel}' to '${selectorFor(target!)}'.${noPathHint ? ` ripwire: ${noPathHint}` : ""}`];
    return { navigator: "ripwire", hits, caveats: [...found, ...caveats(query, location, sel, gauges)] };
  }
  const { hits, gauges } =
    query === "callers" || query === "callees" || query === "impact"
      ? parseJsonList(out.stdout, query, root)
      : parseUses(out.stdout, root, query === "implementations" ? ["extends"] : undefined);
  return { navigator: "ripwire", hits, caveats: caveats(query, location, sel, gauges) };
}

/** The repository root containing `path`, or its directory outside git. */
export function repoRootOf(path: string): Promise<string> {
  return new Promise((done) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(path) }, (err, stdout) =>
      done(err ? dirname(path) : stdout.trim()),
    );
  });
}

/** Runs the `ripwire` binary from PATH. */
export const runRipwire: RipwireRunner = (root, args) =>
  new Promise((done, fail) => {
    execFile("ripwire", [root, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        fail(new Error("ripwire is not installed or not on PATH; the ripwire code navigator needs it."));
        return;
      }
      done({ stdout, stderr, exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0 });
    });
  });
