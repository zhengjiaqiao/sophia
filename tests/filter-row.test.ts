import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const { FilterRow } = await import("../src/FilterRow.tsx");

const base = {
  location: "all" as const,
  onLocation: () => {},
  sort: "active" as const,
  onSort: () => {},
  listOpen: false,
  listFocus: 0,
  onListOpen: () => {},
  source: "来源：全部",
};

test("一个项目都没有：照画 全部 · 用户级（2026-09-30：不画太空），右端来源照留，没有 更多", () => {
  const html = render(FilterRow, { ...base, recent: [], sorted: [] });
  assert.match(html, /按生效范围筛选/);
  assert.match(html, />全部</);
  assert.match(html, />用户级</);
  assert.match(html, /来源：全部/);
  assert.doesNotMatch(html, /filter-row__more/);
});

test("有项目：照常画 全部 · 用户级 · 项目", () => {
  const p = { key: "project:/p/CardBox", label: "CardBox", path: "/p/CardBox" };
  const html = render(FilterRow, { ...base, recent: [p], sorted: [p] });
  assert.match(html, /按生效范围筛选/);
  assert.match(html, />全部</);
  assert.match(html, />用户级</);
});

test("安装页（没有 全部）没有项目时仍画 用户级", () => {
  const html = render(FilterRow, { ...base, recent: [], sorted: [], all: false, location: "user" });
  assert.match(html, />用户级</);
});
