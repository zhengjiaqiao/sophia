/// 位置页 `管理来源`（裁决 15）：来源片那一行末尾的开关式默认键（紧凑），展开「全部来源」列表
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { render } from "./ui-render.ts";

const { manageSourcesLabel, sourceSlot, MANAGE_SOURCES, ALL_SOURCES } =
  await import("../src/pages/sourcesView.ts");
const { ManageSourcesKey, SourceListView } = await import("../src/SourceRow.tsx");
const { default: Matrix } = await import("../src/Matrix.tsx");

test("片下那一块：没订阅来源什么都不出；展开着出全部来源（选中一片时它那一行并进列表）；否则恰好选中一个订阅的来源出它这一行", () => {
  assert.equal(sourceSlot(true, [], []), null);
  assert.equal(sourceSlot(false, [], ["a"]), null);
  assert.deepEqual(sourceSlot(true, ["a", "b"], []), { kind: "list" });
  assert.deepEqual(sourceSlot(true, ["a", "b"], ["a"]), { kind: "list" });
  assert.deepEqual(sourceSlot(false, ["a", "b"], ["a"]), { kind: "row", id: "a" });
  // `全部`、系统一次选中几片、选中的片不是订阅来的（没有来源行）：都不出
  assert.equal(sourceSlot(false, ["a", "b"], []), null);
  assert.equal(sourceSlot(false, ["a", "b"], ["a", "b"]), null);
  assert.equal(sourceSlot(false, ["a", "b"], ["x"]), null);
});

test("键上的字：收着 `管理来源`，展开着 `收起`", () => {
  assert.equal(MANAGE_SOURCES, "管理来源");
  assert.equal(manageSourcesLabel(false), "管理来源");
  assert.equal(manageSourcesLabel(true), "收起");
});

const row = (id: string, name: string, own = false) => ({
  id,
  name,
  sub: { where: "", count: "" },
  path: `/Users/me/${id}/skills`,
  own,
  items: [],
  targets: [],
  switchTitle: "只管以后新出现的，现有的不变",
  ruleRef: id,
  crossDomain: false,
});

const stubState = (rows: ReturnType<typeof row>[], listOpen: boolean) => ({
  data: { rows, subtitle: "" },
  targetsOf: (r: { targets: string[] }) => r.targets,
  ruleOn: () => false,
  rowOf: (id: string) => rows.find((r) => r.id === id),
  setRule: () => undefined,
  askRemove: async () => undefined,
  removeBusy: null,
  host: null,
  say: () => undefined,
  listOpen,
  setListOpen: () => undefined,
  keyRef: { current: null },
  listRef: { current: null },
  listId: "srclist-1",
});

const model = {
  ruleOn: "自动加到",
  targetsTitle: "自动加到哪些 agent",
  targetUnit: "个 agent",
  noTargetsReason: "这里还没有 agent 的 skill 目录",
  targetsLabel: "自动加到",
  ownRemoveReason: "它的原件就在 CardBox 里，删掉原件才会消失",
  memoryKey: (id: string) => `test:${id}`,
  targetsFor: () => [],
  pickable: () => [],
};
const domain = { key: "project:/Users/me/code/CardBox", label: "CardBox" };

test("管理来源：默认键（紧凑，单独出现的动作不用安静键）、开关式（aria-expanded / aria-controls）；一个来源都没订阅时不出", () => {
  const rows = [row("u", "通用仓库"), row("w", "WeiboAP")];
  const closed = render(ManageSourcesKey, { state: stubState(rows, false) as never });
  assert.match(closed, /class="srcmanage"/);
  assert.match(closed, /class="ss-btn ss-btn--compact"/);
  assert.doesNotMatch(closed, /ss-btn--quiet/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /aria-controls/);
  assert.match(closed, />管理来源<\/button>/);
  const open = render(ManageSourcesKey, { state: stubState(rows, true) as never });
  assert.match(open, /aria-expanded="true" aria-controls="srclist-1"/);
  assert.match(open, />收起<\/button>/);
  assert.equal(render(ManageSourcesKey, { state: stubState([], false) as never }), "");
});

test("全部来源：订阅的每个来源一行＝来源名 + 来源行（短路径、打开 ↗、规则、×）；自己的来源 × 禁用并带原因", () => {
  const rows = [row("own", "CardBox · 通用仓库", true), row("w", "WeiboAP")];
  const html = render(SourceListView, {
    state: stubState(rows, true) as never,
    model: model as never,
    domain,
    onReveal: () => undefined,
  });
  assert.match(
    html,
    new RegExp(`class="srclist" id="srclist-1" role="group" aria-label="${ALL_SOURCES}"`),
  );
  assert.equal(html.match(/class="srclist__name"/g)?.length, 2);
  assert.equal(html.match(/class="srcrow"/g)?.length, 2);
  // 名字在各自的来源行前面
  assert.match(
    html,
    /srclist__label">CardBox · 通用仓库<\/span>[\s\S]*?class="srcrow"[\s\S]*?srclist__label">WeiboAP</,
  );
  assert.equal(html.match(/srcrow__label[^"]*">以后新出现的自动加到</g)?.length, 2);
  // 自己的来源：× 禁用、原因就是单行时的那一句
  assert.match(html, /它的原件就在 CardBox 里，删掉原件才会消失/);
  assert.match(html, /从 CardBox 移除 WeiboAP（不动原件）/);
});

test("Matrix：`管理来源` 与片同一行，排在最后一片后面（跟着片折行）", () => {
  const html = render(Matrix, {
    columns: [],
    rows: [],
    nameLabel: "名称",
    originLabel: "来源",
    filterText: "",
    onFilterText: () => undefined,
    selected: new Set<string>(),
    onSelectionChange: () => undefined,
    onCell: () => undefined,
    sources: {
      selected: [],
      onSelect: () => undefined,
      items: [
        { id: "u", label: "通用仓库", count: 1 },
        { id: "w", label: "WeiboAP", count: 1 },
      ],
      tail: createElement(ManageSourcesKey, {
        state: stubState([row("u", "通用仓库")], false) as never,
      }),
    },
  });
  // 尾巴在最后一片之后、仍在同一个折行容器（.mx-sources）里
  assert.match(
    html,
    /class="mx-sources"[^>]*>(?:(?!<\/div>)[\s\S])*data-origin="w"[\s\S]*?class="srcmanage"[\s\S]*?>管理来源<\/button><\/span><\/span><\/div>/,
  );
  const css = readFileSync(new URL("../src/SourceRow.css", import.meta.url), "utf8");
  // 字离最后一片 8：片间距 6 + 2
  assert.match(css, /\.srcmanage \{[^}]*margin-left: 2px;/);
  // 名字列：字至多 160（176 含右留 16），行间一条 row-line
  assert.match(css, /grid-template-columns: fit-content\(176px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.srclist__name \{[^}]*border-bottom: var\(--border-row\);/);
});
