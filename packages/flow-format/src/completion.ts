import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Complete the current word with flow XML files under flows/ or a given path. */
export function listFlowFiles(partial: string): string[] {
  try {
    const flowDir = "flows";
    const flowRoot = join(process.cwd(), flowDir);
    const lowerPartial = partial.toLowerCase();

    // Already typing a path inside the flows directory
    if (partial.includes("/")) {
      const dir = join(process.cwd(), partial.slice(0, partial.lastIndexOf("/") + 1));
      const base = partial.slice(partial.lastIndexOf("/") + 1).toLowerCase();
      if (!existsSync(dir)) return [];

      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".xml") && e.name.toLowerCase().startsWith(base))
        .map((e) => `${partial.slice(0, partial.lastIndexOf("/") + 1)}${e.name}`);
    }

    if (!existsSync(flowRoot) || !flowDir.toLowerCase().startsWith(lowerPartial)) {
      return [];
    }

    return readdirSync(flowRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".xml"))
      .map((e) => `${flowDir}/${e.name}`);
  } catch {
    return [];
  }
}
