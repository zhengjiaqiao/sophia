import assert from "node:assert/strict";
import test from "node:test";
import { dupGroupKey, dupGroupsOf, dupStripSentence, dupStripWanted } from "../src/dupNotice.ts";

const row = (domainKey: string, skill: string) => ({ domainKey, skill });

test("同名分组：同一个位置同名的两份及以上才算；不同位置同名不算；藏起来的行不算", () => {
  const rows = [
    row("project:/p/CardBox", "report-publish"),
    row("project:/p/CardBox", "report-publish"),
    row("global", "report-publish"),
    row("project:/p/CardBox", "pic-show"),
    row("global", "defuddle"),
    row("global", "defuddle"),
    row("global", "defuddle"),
  ];
  const groups = dupGroupsOf(rows);
  assert.deepEqual(
    [...groups],
    [
      ["project:/p/CardBox|report-publish", 2],
      ["global|defuddle", 3],
    ],
  );
  // 藏起来的（刚只留了一份、还没重扫）不算
  const hidden = dupGroupsOf(rows, (r) => r.skill === "defuddle");
  assert.deepEqual([...hidden.keys()], ["project:/p/CardBox|report-publish"]);
  assert.equal(dupGroupKey(rows[0]), "project:/p/CardBox|report-publish");
});

test("提示条：有没关掉过的同名才出；关掉的这一批不再出，之后新出现的同名再出", () => {
  const groups = new Map([
    ["project:/p/CardBox|report-publish", 2],
    ["global|defuddle", 2],
  ]);
  assert.equal(dupStripWanted(groups, new Set()), true);
  const dismissed = new Set(groups.keys());
  assert.equal(dupStripWanted(groups, dismissed), false);
  const later = new Map([...groups, ["global|pdf", 2]]);
  assert.equal(dupStripWanted(later, dismissed), true);
  assert.equal(dupStripWanted(new Map(), new Set()), false);
});

test("提示条的一句：几个 skill、两份还是几份", () => {
  assert.equal(
    dupStripSentence(
      new Map([
        ["a|x", 2],
        ["a|y", 2],
      ]),
    ),
    "2 个 skill 在同一个生效范围里有两份同名的，只能用上一份",
  );
  assert.equal(
    dupStripSentence(new Map([["a|x", 3]])),
    "1 个 skill 在同一个生效范围里有几份同名的，只能用上一份",
  );
});

test("推荐保留：一模一样留 .agents 里的；不一样留改得最近的；读数不齐或分不出不推荐", async () => {
  const { recommendKeep, inAgentsStore, copyReadout } = await import("../src/dupNotice.ts");
  const now = new Date(2026, 8, 30, 12);
  const info = (content: string | null, modified: number | null) => ({
    entries: 3,
    modified,
    content,
  });
  const sep28 = new Date(2026, 8, 28, 9).getTime();
  const sep20 = new Date(2026, 8, 20, 9).getTime();
  // 一模一样：留 .agents/skills 那份
  assert.deepEqual(
    recommendKeep(
      [
        { key: "weibo", agentsStore: false, info: info("abc", sep28) },
        { key: "store", agentsStore: true, info: info("abc", sep20) },
      ],
      now,
    ),
    { key: "store", reason: "两份一模一样，留 .agents 里的这份（多数 agent 直接读这里）" },
  );
  // 一模一样、都不在通用仓库（ego lite 两个版本各带一份）：留较新的
  assert.deepEqual(
    recommendKeep(
      [
        { key: "old", agentsStore: false, info: info("abc", sep20) },
        { key: "new", agentsStore: false, info: info("abc", sep28) },
      ],
      now,
    ),
    { key: "new", reason: "两份一模一样，这份较新（9月28日）" },
  );
  // 一模一样、一样新、都不在通用仓库：真的留哪份都一样，不推荐
  assert.equal(
    recommendKeep([
      { key: "a", agentsStore: false, info: info("abc", sep20) },
      { key: "b", agentsStore: false, info: info("abc", sep20) },
    ]),
    null,
  );
  // 不一样：留改得最近的（即使另一份在通用仓库）
  assert.deepEqual(
    recommendKeep(
      [
        { key: "weibo", agentsStore: false, info: info("new", sep28) },
        { key: "store", agentsStore: true, info: info("old", sep20) },
      ],
      now,
    ),
    { key: "weibo", reason: "两份内容不一样，这份改得最近（9月28日）" },
  );
  // 读数没齐、时间读不到、一样新：不推荐
  assert.equal(
    recommendKeep([
      { key: "a", agentsStore: true, info: undefined },
      { key: "b", agentsStore: false, info: info("x", sep20) },
    ]),
    null,
  );
  assert.equal(
    recommendKeep([
      { key: "a", agentsStore: true, info: info("x", null) },
      { key: "b", agentsStore: false, info: info("y", sep20) },
    ]),
    null,
  );
  assert.equal(
    recommendKeep([
      { key: "a", agentsStore: true, info: info("x", sep20) },
      { key: "b", agentsStore: false, info: info("y", sep20) },
    ]),
    null,
  );
  // 指纹读不出来时不说一模一样
  assert.equal(
    recommendKeep(
      [
        { key: "a", agentsStore: true, info: info(null, sep20) },
        { key: "b", agentsStore: false, info: info(null, sep28) },
      ],
      now,
    )?.key,
    "b",
  );
  assert.equal(inAgentsStore("/Users/me/Projects/CardBox/.agents/skills/report-publish"), true);
  assert.equal(inAgentsStore("/Users/me/.agents/skills/pdf"), true);
  assert.equal(inAgentsStore("/Users/me/Library/WeiboAP/skills/report-publish"), false);
  assert.equal(copyReadout(info("x", sep28), now), "改于 9月28日 · 3 个文件");
});

test("应用包里的原件：认得出应用；只留这份按不了、说原因；一组里每份都在应用包里时提示条不为它出", async () => {
  const { appBundleOf, keepBlockedReason, dupGroupsOf } = await import("../src/dupNotice.ts");
  const ego =
    "/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.5.1.11/Resources/ego-skills/ego-browser";
  assert.equal(appBundleOf(ego), "ego lite");
  assert.equal(appBundleOf("/Users/me/.agents/skills/pdf"), null);
  assert.equal(
    keepBlockedReason(ego),
    "另一份在 ego lite.app 里面，是应用自己带的，Sophia 不改别的应用",
  );
  assert.equal(keepBlockedReason("/Users/me/.agents/skills/pdf"), null);
  const rows = [
    { domainKey: "global", skill: "ego-browser", path: ego },
    { domainKey: "global", skill: "ego-browser", path: ego.replace("0.5.1.11", "0.5.1.13") },
    { domainKey: "global", skill: "pdf", path: "/a/pdf" },
    { domainKey: "global", skill: "pdf", path: ego.replace("ego-browser", "pdf") },
  ];
  const groups = dupGroupsOf(
    rows,
    () => false,
    (r) => appBundleOf(r.path) !== null,
  );
  assert.deepEqual([...groups.keys()], ["global|pdf"]);
});

test("只看这些开着、同名都只留了一份之后提示条那一句", async () => {
  const { dupsDone } = await import("../src/dupNotice.ts");
  assert.equal(dupsDone(), "同名的都只留了一份");
});
