/// 待处理页的数据层：把散在几十行格子里的异常状况收成一张去重后的列表。
/// 纯逻辑，不碰 api、不产 JSX——页面只负责把它摆出来。
///
/// 数据来源是 `viewOf` 的 `issue` 字段（组件规范 §8）：四种异常态画出来都是空心，
/// 但点击行为与要拿的主意完全不同，所以先判状态、再决定这一条给什么动作。
import { viewOf } from "../cellState.ts";
import type {
  CellRef,
  DomainPage,
  IssueKind,
  Overview,
  PlannedAction,
  Source,
  Target,
} from "../types.ts";

/// key 里的分隔符，与 `store.rs` 的 `KEY_SEP` 是同一个 Unit Separator：路径里不会出现它
const KEY_SEP = "\u001f";

/// 类别 + 全部位置排序后拼接，与 `IgnoredIssue::key_for` 同规则。
///
/// 两边必须同源：这既是本页的去重依据（同一条状况会被多个格命中），
/// 也是「这条是不是已经忽略过」的判断依据。路径任一变化 → key 变化 → 自然重新提示。
export function issueKey(kind: IssueKind, paths: string[]): string {
  return [kind, ...[...paths].sort()].join(KEY_SEP);
}

/// 从 key 里取回涉及的位置。core 的 key 不取摘要、直接留可读的路径串，
/// 所以已忽略的那条即使在磁盘上已经不存在了，也还能把位置摆出来
export function pathsOfKey(key: string): string[] {
  return key.split(KEY_SEP).slice(1);
}

/// 类别名：待处理页左列记号的提示框与读屏名（DESIGN「视觉优先」：类别名进 title，
/// 记号与格内异常同形）。只是展示，改它不影响 key
export const KIND_LABEL: Record<IssueKind, string> = {
  duplicateSource: "同名：有两份",
  brokenLink: "链接失效",
  wholeLinkedTarget: "整个文件夹是链接",
  readOnlyTarget: "写不进",
  differentCopies: "两份不一样",
  invalidLocation: "位置无效",
};

/// 句子的一段：`subject` 的是对象名（墨色），其余是连接词（灰）——
/// 待处理页一眼扫对象，不逐字读句子
export interface SentencePart {
  text: string;
  subject?: boolean;
}

/// 列表里的先后：同名本体最需要拿主意，排最前；目录不可写多半是一过性的，排最后
const KIND_RANK: Record<IssueKind, number> = {
  duplicateSource: 0,
  brokenLink: 1,
  wholeLinkedTarget: 2,
  readOnlyTarget: 3,
  differentCopies: 4,
  invalidLocation: 5,
};

/// 同名两份里的一份：待处理页给「只留 X 的」，删的是另一份
export interface DeleteChoice {
  /// 按钮上的位置名，如「通用仓库」
  label: string;
  sourceId: string;
  skill: string;
  /// 原件目录
  path: string;
}

/// 列表里的一条状况。四类问题共用这一个形状，动作按 `kind` 取用
export interface PendingIssue {
  kind: IssueKind;
  /// 见 `issueKey`
  key: string;
  /// 涉及的全部位置，原样传给 `ignore_issue`
  paths: string[];
  /// 主行开头的等宽名字（skill 名）；这一条说的是目录而不是某个 skill 时为 null
  subject: string | null;
  /// 主行正文，接在 subject 后面
  text: string;
  /// 整句拆段（对象墨色、连接词灰），待处理页照它渲染；读屏读 `subject + text`
  parts: SentencePart[];
  /// 副行：涉及的位置
  detail: string;
  /// 相关的 agent 名，用来写提示条；与 skill 无关的那两类才有
  agent: string | null;
  /// 相关 agent 的 id（决定图标），提示条里画图标用
  agentId: string | null;
  /// 同名：两份原件各一个选项（「只留 X 的」删另一份）
  deletes: DeleteChoice[];
  /// 链接失效：`清除` 要执行的动作
  clear: PlannedAction | null;
  /// 整目录链接：`拆开` 的目标 id
  splitTargetId: string | null;
  /// 目录不可写：`再试一次` 要重建的那些格
  retry: CellRef[];
}

/// 后端路径是「目录 + 分隔符 + 条目名」，两种分隔符都认
/// （不用模板串：串里的反斜杠会让 lint-ui 取文案时引号配错对）
const join = (dir: string, name: string) => dir + (dir.includes("\\") ? "\\" : "/") + name;

/// 一条空壳，四类问题各自往上填
const blank = (kind: IssueKind, paths: string[]): PendingIssue => ({
  kind,
  key: issueKey(kind, paths),
  paths,
  subject: null,
  text: "",
  parts: [],
  detail: paths.join(" · "),
  agent: null,
  agentId: null,
  deletes: [],
  clear: null,
  splitTargetId: null,
  retry: [],
});

/// 目录写不进去这一条。**扫描永远不产出 `readOnly`**（判定它要实际试写一次），
/// 所以它不在 `collectIssues` 的产出里，由真的写失败的那一方构造——
/// 文案与动作仍走这一份，主视图的待处理栏与待处理页说的是同一句话
export function readOnlyIssue(target: Target, retry: CellRef[]): PendingIssue {
  const issue = blank("readOnlyTarget", [target.path]);
  issue.text = " 的 skills 目录写不进去，开不了 skill";
  issue.parts = [{ text: target.label, subject: true }, { text: issue.text }];
  issue.agent = target.label;
  issue.agentId = target.scope.harnessId;
  issue.retry.push(...retry);
  return issue;
}

/// 遍历当前 overview 的所有格，收出需要用户拿主意的事。
///
/// **去重按 key 做**（类别 + 位置排序后拼接），和后端的忽略判断对得上：同名本体会在
/// 每个 agent 下各命中一次，目录写不进去会在每个 skill 上各命中一次，摆给用户看只该有一条。
///
/// `domains` 用来只看其中几个域：主视图的待处理栏只说侧栏当前选中那个位置的事，
/// 待处理页不传，看全部。
export function collectIssues(overview: Overview | null, domains?: DomainPage[]): PendingIssue[] {
  if (overview === null) return [];

  // 本体真实路径 → 它属于哪个本体位置。用来认出「另一处同名本体」在哪，好给出第二个删除选项
  const ownerOf = new Map<string, { source: Source; skill: string }>();
  for (const source of overview.sources) {
    for (const skill of source.skills) ownerOf.set(skill.path, { source, skill: skill.name });
  }

  const out = new Map<string, PendingIssue>();
  const add = (issue: PendingIssue) => {
    const prev = out.get(issue.key);
    // 先到的那条留着（它带着 skill 名与 agent 名），后来的只把要重试的格并进去
    if (prev === undefined) out.set(issue.key, issue);
    else prev.retry.push(...issue.retry);
  };

  for (const page of domains ?? overview.domains) {
    collectPage(page, overview, ownerOf, add);
  }

  return [...out.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

function collectPage(
  page: DomainPage,
  overview: Overview,
  ownerOf: Map<string, { source: Source; skill: string }>,
  add: (issue: PendingIssue) => void,
) {
  const brokenAt = new Map(page.broken.map((a) => [a.targetPath, a]));

  for (const row of page.rows) {
    const source = overview.sources.find((s) => s.id === row.sourceId) ?? null;
    const ownPath =
      source?.skills.find((s) => s.name === row.skill)?.path ??
      join(source?.path ?? row.sourceId, row.skill);

    for (const cell of row.cells) {
      const target = page.targets.find((t) => t.id === cell.targetId);
      if (target === undefined) continue;
      const kind = viewOf(cell, target, target.label, row.skill).issue;
      if (kind === undefined) continue;

      switch (kind) {
        case "duplicateSource": {
          // pointsTo 为空是防御分支：判 foreign 的那一刻 core 手里正好是 real_path 的结果。
          // 真为空就只拿这一处的本体位置入 key，至少这一条不会和别的状况撞上
          const other = cell.pointsTo;
          const issue = blank(kind, other === null ? [ownPath] : [ownPath, other]);
          issue.subject = row.skill;
          issue.deletes.push({
            label: source?.label ?? row.sourceId,
            sourceId: row.sourceId,
            skill: row.skill,
            path: ownPath,
          });
          const owner = other === null ? undefined : ownerOf.get(other);
          if (owner !== undefined && owner.source.id !== row.sourceId) {
            issue.deletes.push({
              label: owner.source.label,
              sourceId: owner.source.id,
              skill: owner.skill,
              path:
                owner.source.skills.find((s) => s.name === owner.skill)?.path ?? (other as string),
            });
          }
          issue.text =
            issue.deletes.length > 1
              ? ` · ${issue.deletes.map((d) => d.label).join("、")} 各一份`
              : " 在别处还有一份同名的，那一处不在已知的来源里，只能删这一份";
          issue.parts = [{ text: row.skill, subject: true }, { text: issue.text }];
          add(issue);
          break;
        }
        case "brokenLink": {
          const issue = blank(kind, [cell.path]);
          issue.subject = row.skill;
          // 主语是 skill，但待处理栏一次只显示一条，不点名 agent 就不知道是哪一列的
          issue.text = ` 在 ${target.label} 下的链接指向的位置没了`;
          issue.parts = [{ text: row.skill, subject: true }, { text: issue.text }];
          issue.agent = target.label;
          issue.agentId = target.scope.harnessId;
          // 扫描已经把这个目录里解析不到的链接都算成动作了；万一对不上就现搭一条，
          // 执行前后端还会重校验它仍是一条链接
          issue.clear = brokenAt.get(cell.path) ?? {
            kind: "brokenLink",
            itemName: row.skill,
            sourcePath: cell.pointsTo ?? cell.path,
            targetPath: cell.path,
            target: target.path,
          };
          add(issue);
          break;
        }
        case "wholeLinkedTarget": {
          const whole = target.linkedWholeTo;
          const issue = blank(kind, whole === null ? [target.path] : [target.path, whole]);
          const where = whole === null ? "别处" : placeName(whole, overview);
          issue.text = ` 的 skills 文件夹整个链接到了 ${where}，拆开后才能逐个开关`;
          issue.parts = [{ text: target.label, subject: true }, { text: issue.text }];
          issue.detail = whole === null ? target.path : `${target.path} → ${whole}`;
          issue.agent = target.label;
          issue.agentId = target.scope.harnessId;
          issue.splitTargetId = target.id;
          add(issue);
          break;
        }
        case "readOnlyTarget": {
          add(
            readOnlyIssue(target, [
              { sourceId: row.sourceId, skill: row.skill, targetId: target.id },
            ]),
          );
          break;
        }
      }
    }
  }

  // 目录里那些没有对应行的失效链接：本体早就不在了，矩阵里不成行，只能从这里清。
  // 与上面按格收到的那些 key 相同，会被去重合成一条
  for (const action of page.broken) {
    const issue = blank("brokenLink", [action.targetPath]);
    issue.subject = action.itemName;
    const target = page.targets.find((t) => t.path === action.target);
    issue.agent = target?.label ?? null;
    issue.agentId = target?.scope.harnessId ?? null;
    issue.text = ` 在 ${issue.agent ?? "这个 agent"} 下的链接指向的位置没了`;
    issue.parts = [{ text: action.itemName, subject: true }, { text: issue.text }];
    issue.clear = action;
    add(issue);
  }
}

/// 整个文件夹链去的那个地方叫什么：是已知来源就用来源名（`WeiboAP`），
/// 否则取路径末尾那一级。绝对路径不进可见文案（DESIGN「来源的名字」）
function placeName(path: string, overview: Overview): string {
  const trim = (p: string) => p.replace(/[/\\]+$/, "");
  const known = overview.sources.find(
    (s) => trim(s.path) === trim(path) || trim(s.id) === trim(path),
  );
  if (known !== undefined) return known.label;
  const parts = trim(path).split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/// 按钮里的专名不靠空格断词（DESIGN「按钮」）：汉字之间不加空格，中西文之间一个空格。
/// `只留通用仓库的`、`只留 WeiboAP 的`
export function joinWords(...words: string[]): string {
  const latin = /[A-Za-z0-9]/;
  return words.reduce((acc, word) => {
    if (acc === "" || word === "") return acc + word;
    const gap = latin.test(acc[acc.length - 1]) !== latin.test(word[0]) ? " " : "";
    return acc + gap + word;
  }, "");
}

/// 目录大小：给人读的一位小数。确认弹窗靠它判断「这一处是不是那个该留下的」
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
