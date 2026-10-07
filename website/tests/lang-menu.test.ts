/// 顶栏语言菜单的逻辑（spec R5、AC1 的菜单部分）：点击与悬停都能开，离开 0.2 秒收起，
/// 悬停打开后再点不收起，Esc 收起并把焦点还给键，触屏只认点击。假定时器，不起浏览器。
import assert from "node:assert/strict";
import test from "node:test";
import { LangMenu, LEAVE_DELAY_MS } from "../src/lib/langMenu.ts";
import { langCookie } from "../src/lib/langCookie.ts";
import { LANG_CODES, LANG_COOKIE } from "../src/lib/langs.ts";
import { SITE } from "../src/site.config.ts";
import { pickLang } from "../functions/_lib/lang.ts";

function setup() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const opens: boolean[] = [];
  let focused = 0;
  const menu = new LangMenu({
    timer: {
      set: (fn, ms) => {
        timers.set(nextId, { at: now + ms, fn });
        return nextId++;
      },
      clear: (id) => void timers.delete(id),
    },
    onChange: (o) => opens.push(o),
    focusButton: () => void focused++,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) (timers.delete(id), t.fn());
  };
  return { menu, advance, opens, focused: () => focused };
}

test("点击打开，再点收起", () => {
  const { menu } = setup();
  menu.click();
  assert.equal(menu.open, true);
  menu.click();
  assert.equal(menu.open, false);
});

test("鼠标移上去就打开；离开 0.2 秒后收起，没到点不收", () => {
  const { menu, advance } = setup();
  menu.pointerEnter("mouse");
  assert.equal(menu.open, true);
  menu.pointerLeave("mouse");
  advance(LEAVE_DELAY_MS - 1);
  assert.equal(menu.open, true);
  advance(1);
  assert.equal(menu.open, false);
  assert.equal(LEAVE_DELAY_MS, 200);
});

test("离开后又回来（从键挪到菜单）：取消收起", () => {
  const { menu, advance } = setup();
  menu.pointerEnter("mouse");
  menu.pointerLeave("mouse");
  advance(150);
  menu.pointerEnter("mouse");
  advance(500);
  assert.equal(menu.open, true);
});

test("悬停打开后再点：不收起（点只是确认）；之后再点才收起", () => {
  const { menu } = setup();
  menu.pointerEnter("mouse");
  menu.click();
  assert.equal(menu.open, true);
  menu.click();
  assert.equal(menu.open, false);
});

test("触屏只认点击：触摸的 pointerenter / pointerleave 不开不关", () => {
  const { menu, advance } = setup();
  menu.pointerEnter("touch");
  assert.equal(menu.open, false);
  menu.click();
  assert.equal(menu.open, true);
  menu.pointerLeave("touch");
  advance(1000);
  assert.equal(menu.open, true);
  menu.pointerEnter("pen");
  menu.pointerLeave("pen");
  advance(1000);
  assert.equal(menu.open, true);
});

test("Esc：收起并把焦点还给键；没开着时不抢焦点", () => {
  const { menu, focused } = setup();
  menu.escape();
  assert.equal(focused(), 0);
  menu.click();
  menu.escape();
  assert.equal(menu.open, false);
  assert.equal(focused(), 1);
});

test("点菜单外面收起；选了一种语言也收起", () => {
  const { menu } = setup();
  menu.click();
  menu.outsideClick();
  assert.equal(menu.open, false);
  menu.click();
  menu.select();
  assert.equal(menu.open, false);
});

test("开合只在真的变化时通知", () => {
  const { menu, opens } = setup();
  menu.outsideClick();
  menu.click();
  menu.pointerEnter("mouse");
  menu.escape();
  assert.deepEqual(opens, [true, false]);
});

test("lang cookie：名字 lang、值是页面语言码、站内通用、记一年", () => {
  assert.equal(langCookie("zh-Hans"), "lang=zh-Hans; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(langCookie("en"), "lang=en; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.throws(() => langCookie("fr"), /fr/);
});

test("cookie 认的语言码与站点语言表一致", () => {
  assert.deepEqual([...LANG_CODES].sort(), SITE.langs.map((l) => l.code).sort());
});

test("与 #184 的中间件对上：cookie 名一致，菜单写的每个语言码中间件都认（pickLang 读回同一个）", () => {
  assert.equal(LANG_COOKIE, "lang");
  for (const code of LANG_CODES) {
    const written = langCookie(code).split(";")[0]!;
    assert.equal(pickLang({ cookie: written, acceptLanguage: "de" }), code);
  }
});
