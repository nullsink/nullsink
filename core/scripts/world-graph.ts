// Runtime-module graph extraction for the two service composition roots. This deliberately uses the
// TypeScript parser instead of source-text regexes: import syntax has several equivalent forms, and a
// privacy boundary must not depend on quote style or miss a re-export/dynamic import/require().
//
// Only literal local specifiers are followed. Package/builtin imports are outside this repository; opaque
// dynamic import/require expressions are recorded as policy failures because neither this graph nor a Bun
// metafile can prove their runtime target. Type-only imports/re-exports are excluded because TypeScript
// erases them and they contribute no runtime code to the attested binary.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const PARSED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const JS_TO_TS_EXTENSIONS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts", ".ts"],
  ".cjs": [".cts", ".ts"],
};

export type UnresolvedLocalImport = {
  importer: string;
  specifier: string;
};

export type OpaqueRuntimeImport = {
  importer: string;
  expression: string;
};

export type RuntimeModuleGraph = {
  modules: Set<string>;
  unresolved: UnresolvedLocalImport[];
  opaque: OpaqueRuntimeImport[];
};

function literalText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true; // side-effect import: import "./module"
  if (clause.isTypeOnly) return false;
  if (clause.name) return true; // default import
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  // Bun preserves `import {} from "./module"` as a side-effect import. An all-type
  // named import is different: Bun erases it completely.
  return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeValue(decl: ts.ExportDeclaration): boolean {
  if (decl.isTypeOnly) return false;
  if (!decl.exportClause) return true; // export * from "./module"
  if (ts.isNamespaceExport(decl.exportClause)) return true;
  // Like an empty import, Bun keeps `export {} from "./module"` as a runtime
  // dependency while erasing an export list made entirely of `type` specifiers.
  return decl.exportClause.elements.length === 0 || decl.exportClause.elements.some((element) => !element.isTypeOnly);
}

type RuntimeImportScan = { specifiers: string[]; opaque: string[] };

/** Return every runtime import in one TS/JS source file, separating literal targets from forbidden opaque ones. */
export function runtimeModuleSpecifiers(sourceText: string, fileName = "source.ts"): RuntimeImportScan {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const opaque: string[] = [];

  const add = (node: ts.Node | undefined): void => {
    const text = literalText(node);
    if (text != null) found.push(text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (importClauseHasRuntimeValue(node.importClause)) add(node.moduleSpecifier);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && exportDeclarationHasRuntimeValue(node)) add(node.moduleSpecifier);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "module" &&
          node.expression.name.text === "require");
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (literalText(argument) == null) opaque.push(argument?.getText(source) ?? "<missing>");
        else add(argument);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers: [...new Set(found)], opaque: [...new Set(opaque)] };
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Resolve the local specifiers Bun/TypeScript commonly accept, including directory indexes and .js→.ts. */
export function resolveLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return null;
  const base = isAbsolute(specifier) ? specifier : resolve(dirname(importer), specifier);
  const suffix = extname(base);
  const candidates: string[] = [];

  if (suffix) {
    for (const mapped of JS_TO_TS_EXTENSIONS[suffix] ?? []) {
      candidates.push(base.slice(0, -suffix.length) + mapped);
    }
    candidates.push(base);
  } else {
    candidates.push(base);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(base + extension);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(resolve(base, `index${extension}`));
  }

  return candidates.find(isFile) ?? null;
}

/** Walk all literal local runtime dependencies from one or more concrete entry files. */
export function runtimeModuleGraph(entries: string[]): RuntimeModuleGraph {
  const modules = new Set<string>();
  const unresolved: UnresolvedLocalImport[] = [];
  const opaque: OpaqueRuntimeImport[] = [];
  const stack = entries.map((entry) => resolve(entry));

  while (stack.length) {
    const file = stack.pop()!;
    if (modules.has(file)) continue;
    if (!isFile(file)) throw new Error(`world graph entry does not exist: ${file}`);
    modules.add(file);
    if (!PARSED_EXTENSIONS.has(extname(file))) continue;

    const scan = runtimeModuleSpecifiers(readFileSync(file, "utf8"), file);
    opaque.push(...scan.opaque.map((expression) => ({ importer: file, expression })));
    for (const specifier of scan.specifiers) {
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) continue;
      const target = resolveLocalModule(file, specifier);
      if (target) stack.push(target);
      else unresolved.push({ importer: file, specifier });
    }
  }

  return { modules, unresolved, opaque };
}
