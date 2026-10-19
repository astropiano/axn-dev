import { resolveInfraRoot } from "./infra.js";

/** Shared completer for `backup dotenv` / `restore dotenv`. */
export function dotenvCompleter(flags: string[]) {
  return (words: string[]): string[] => {
    const prev = words[words.length - 2] ?? "";
    const cur = words[words.length - 1] ?? "";
    if (words.length === 3) {
      return ["dotenv"].filter((s) => s.startsWith(cur) && s !== cur);
    }
    if (words[2] === "dotenv") {
      if (["--infra", "--scenario", "-s", "--from", "-f"].includes(prev)) return [];
      if (["--base", "--to"].includes(prev)) {
        try {
          return [resolveInfraRoot()].filter((p) => p.startsWith(cur));
        } catch {
          return [];
        }
      }
    }
    return flags.filter((f) => f.startsWith(cur) && f !== cur);
  };
}
