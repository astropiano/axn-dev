import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Language, Node, Parser } from "web-tree-sitter";
import type { Chunk, CodeFacts } from "../types.js";
import type { Extractor } from "./types.js";

const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

const METHOD_DECLARATIONS = new Set(["method_declaration", "constructor_declaration"]);

let parserPromise: Promise<Parser> | null = null;

/**
 * One parser for the process: loading the runtime and the grammar wasm costs
 * ~50-100ms, and extraction runs one file at a time, so sharing is safe.
 */
function javaParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    const { Parser: TsParser, Language: TsLanguage } = await import("web-tree-sitter");
    await TsParser.init();
    // Load from bytes: given a path string, web-tree-sitter tries fetch(), which Node can't use for files.
    const wasm = createRequire(import.meta.url).resolve("tree-sitter-wasms/out/tree-sitter-java.wasm");
    const language: Language = await TsLanguage.load(new Uint8Array(await readFile(wasm)));
    const parser = new TsParser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}

/**
 * Extract Java types (top-level and nested) and their methods/constructors,
 * parsed with tree-sitter. Each chunk carries the type's qualified name and
 * its 1-based line span, so a hit can be handed to a code navigator.
 */
export class JavaExtractor implements Extractor {
  async extract(text: string): Promise<Omit<Chunk, "offset">[]> {
    const parser = await javaParser();
    const tree = parser.parse(text);
    if (!tree) return [];
    try {
      const pkg = tree.rootNode.namedChildren.find((c) => c?.type === "package_declaration")?.namedChildren[0]?.text;
      const chunks: Omit<Chunk, "offset">[] = [];
      for (const child of tree.rootNode.namedChildren) {
        if (child && TYPE_DECLARATIONS.has(child.type)) collectType(child, text, pkg, chunks);
      }
      return chunks;
    } finally {
      // Trees live in wasm memory, outside the JS garbage collector.
      tree.delete();
    }
  }
}

/**
 * The package, imports and type uses of a Java file. A use is recorded once
 * per name and line, as written: a qualified use (`Outer.Inner`, `a.b.Foo`)
 * as one name, not as its parts.
 */
export async function extractJavaFacts(text: string): Promise<CodeFacts> {
  const parser = await javaParser();
  const tree = parser.parse(text);
  const facts: CodeFacts = { imports: [], types: {} };
  if (!tree) return facts;
  try {
    for (const child of tree.rootNode.namedChildren) {
      if (child?.type === "package_declaration") {
        facts.package = child.namedChildren[0]?.text;
      } else if (child?.type === "import_declaration" && !child.children.some((c) => c?.type === "static")) {
        const name = child.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier")?.text;
        if (name) facts.imports.push(child.children.some((c) => c?.type === "asterisk") ? `${name}.*` : name);
      }
    }
    const visit = (node: Node): void => {
      if (node.type === "type_identifier" || node.type === "scoped_type_identifier") {
        const lines = (facts.types[node.text] ??= []);
        const line = node.startPosition.row + 1;
        if (lines[lines.length - 1] !== line) lines.push(line);
        return;
      }
      for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(tree.rootNode);
    return facts;
  } finally {
    tree.delete();
  }
}

function collectType(node: Node, text: string, outer: string | undefined, out: Omit<Chunk, "offset">[]): void {
  const name = node.childForFieldName("name")?.text;
  if (!name) return;
  const qualified = outer ? `${outer}.${name}` : name;
  out.push(chunkFor(node, text, name, qualified));

  const body = node.childForFieldName("body");
  if (body) collectMembers(body, text, qualified, out);
}

/** Enums wrap their methods in `enum_body_declarations`; nested types recurse. */
function collectMembers(body: Node, text: string, qualified: string, out: Omit<Chunk, "offset">[]): void {
  for (const member of body.namedChildren) {
    if (!member) continue;
    if (METHOD_DECLARATIONS.has(member.type)) {
      const signature = methodSignature(member);
      if (signature) out.push(chunkFor(member, text, signature, `${qualified}.${signature}`));
    } else if (TYPE_DECLARATIONS.has(member.type)) {
      collectType(member, text, qualified, out);
    } else if (member.type === "enum_body_declarations") {
      collectMembers(member, text, qualified, out);
    }
  }
}

/** `name(Type, Type...)` — parameter types only, so overloads stay distinct. */
function methodSignature(node: Node): string | undefined {
  // Constructors carry their name as an `identifier` child, not a `name` field.
  const name = node.childForFieldName("name")?.text ?? node.namedChildren.find((c) => c?.type === "identifier")?.text;
  if (!name) return undefined;
  const params = node.childForFieldName("parameters")?.namedChildren ?? [];
  const types = params
    .filter((p) => p?.type === "formal_parameter" || p?.type === "spread_parameter")
    .map((p) => {
      const type = (p!.childForFieldName("type") ?? p!.namedChildren[0])?.text.replace(/\s+/g, " ") ?? "?";
      return p!.type === "spread_parameter" ? `${type}...` : type;
    });
  return `${name}(${types.join(", ")})`;
}

function chunkFor(node: Node, text: string, title: string, titlePath: string): Omit<Chunk, "offset"> {
  const doc = javadocBefore(node, text);
  return {
    title,
    titlePath,
    text: doc ? `${doc}\n${node.text}` : node.text,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

/**
 * The Javadoc immediately preceding a declaration. tree-sitter keeps comments
 * as siblings rather than attaching them, so look at the previous sibling.
 */
function javadocBefore(node: Node, text: string): string | undefined {
  const prev = node.previousSibling;
  if (prev?.type !== "block_comment" || !prev.text.startsWith("/**")) return undefined;
  // Only when nothing but whitespace separates the comment from the declaration.
  return /^\s*$/.test(text.slice(prev.endIndex, node.startIndex)) ? prev.text : undefined;
}
