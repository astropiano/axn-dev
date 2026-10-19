import type { Chunk } from "../types.js";
import type { RawUnit } from "./types.js";

interface Pattern {
  kind: RawUnit["kind"];
  re: RegExp;
}

/**
 * Generic brace/semicolon scanner for block-style declarations.
 */
export function scanUnits(
  text: string,
  patterns: Pattern[],
  includeDocComments: boolean
): RawUnit[] {
  const units: RawUnit[] = [];
  const seen = new Set<number>();

  for (const { kind, re } of patterns) {
    for (const m of text.matchAll(re)) {
      const name = m[1] ?? "unnamed";
      const rawStart = m.index ?? 0;
      const leading = m[0].match(/^\s*/)?.[0].length ?? 0;
      const declStart = rawStart + leading;
      if (seen.has(declStart)) continue;
      seen.add(declStart);

      let blockStart = declStart;
      if (includeDocComments) {
        const preceding = text.slice(0, declStart);
        const blockDocMatch = preceding.match(/(\/\*\*(?:(?!\*\/)[\s\S])*?\*\/)\s*$/);
        if (blockDocMatch) {
          blockStart = declStart - blockDocMatch[0].length;
        } else {
          const lineDocMatch = preceding.match(/(\/{3}[^\n]*(?:\n\s*\/{3}[^\n]*)*\n\s*)$/);
          if (lineDocMatch) {
            blockStart = declStart - lineDocMatch[0].length;
          }
        }
      }

      let end = declStart;
      const afterDecl = text.slice(declStart);
      const bracePos = afterDecl.indexOf("{");
      const firstSemi = bracePos === -1 ? -1 : afterDecl.slice(0, bracePos).indexOf(";");
      const hasBody = bracePos !== -1 && firstSemi === -1;

      if (hasBody) {
        let depth = 0;
        for (let i = bracePos; i < afterDecl.length; i++) {
          if (afterDecl[i] === "{") depth++;
          else if (afterDecl[i] === "}") {
            depth--;
            if (depth === 0) {
              end = declStart + i + 1;
              break;
            }
          }
        }
      } else {
        const firstSemiGlobal = afterDecl.indexOf(";");
        end = firstSemiGlobal === -1 ? text.length : declStart + firstSemiGlobal + 1;
      }

      units.push({
        start: blockStart,
        end,
        name,
        text: text.slice(blockStart, end).trim(),
        kind,
      });
    }
  }

  return units.sort((a, b) => a.start - b.start);
}

function parentFor(units: RawUnit[], child: RawUnit): string | undefined {
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (u === child) continue;
    if (u.start <= child.start && u.end >= child.end) {
      if ((u.kind === "class" || u.kind === "section") && u.name) {
        return u.name;
      }
    }
  }
  return undefined;
}

export function buildChunks(units: RawUnit[]): Omit<Chunk, "offset">[] {
  const parents = new Map<RawUnit, string | undefined>();
  for (const u of units) {
    parents.set(u, parentFor(units, u));
  }

  return units.map((u) => {
    const parent = parents.get(u);
    const title = u.name;
    const titlePath = parent ? `${parent}.${u.name}` : u.name;
    return {
      title,
      titlePath,
      text: u.text,
    };
  });
}
