/// 文案在用的时候才取（spec 2026-09-30-language-and-theme，第三批要不重启就换语言）：
/// 模块顶层不调 t / tn / tRich。`const PICK_HINT = t("…")` 在模块加载时就定成了简体，换语言也不变，
/// 所以常量写成函数或键表。这里按 TypeScript 语法树找：调用不在任何函数体里就算违规
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/// 一个文件里在模块加载时就会执行的取文案调用：`行号: 调用`
function loadTimeCalls(src: string, path = "x.tsx"): string[] {
  const file = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
  // 从 i18n 模块导入的 t / tn / tRich（含改名）
  const names = new Set<string>();
  for (const st of file.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!/(^|\/)i18n(\.ts)?$/.test(st.moduleSpecifier.text)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (["t", "tn", "tRich"].includes(imported)) names.add(el.name.text);
    }
  }
  const out: string[] = [];
  const deferred = (node: ts.Node): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) return true;
      // 实例字段的初值在 new 的时候才算
      if (
        ts.isPropertyDeclaration(p) &&
        !p.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
      )
        return true;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text) &&
      !deferred(node)
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      out.push(`${line + 1}: ${node.getText().slice(0, 60)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

test("检测器：顶层常量、顶层对象里的调用算；函数体、箭头函数、方法、实例字段里的不算；不是从 i18n 导入的 t 不算", () => {
  const src = [
    'import { t, tn as count } from "./i18n.ts";',
    'const A = t("skills.a");',
    'const TABLE = { add: t("toast.add") };',
    'const B = count("usage.m", 3);',
    'export function f() { return t("skills.b"); }',
    'const g = () => t("skills.c");',
    'const KEYS = { add: "toast.verb.add" } as const;',
    'class C { label = t("skills.d"); static S = t("skills.e"); get x() { return t("skills.f"); } }',
  ].join("\n");
  assert.deepEqual(loadTimeCalls(src), [
    '2: t("skills.a")',
    '3: t("toast.add")',
    '4: count("usage.m", 3)',
    '8: t("skills.e")',
  ]);
  assert.deepEqual(loadTimeCalls('const t = (x: string) => x;\nconst A = t("x");'), []);
});

test("src 里没有在模块加载时就取文案的地方", () => {
  const root = new URL("../src/", import.meta.url);
  const walk = (dir: URL): URL[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(new URL(`${e.name}/`, dir))
        : /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")
          ? [new URL(e.name, dir)]
          : [],
    );
  const bad = walk(root).flatMap((u) => {
    const rel = u.pathname.slice(root.pathname.length);
    return loadTimeCalls(readFileSync(u, "utf8"), rel).map((v) => `src/${rel}:${v}`);
  });
  assert.deepEqual(bad, []);
});
