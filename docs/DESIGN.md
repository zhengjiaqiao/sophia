---
version: 1
name: Sophia
description: 一个管理多 AI 编码工具 skill / MCP / 模型配置的桌面工具。零色彩、零阴影、零渐变；强调只有三档——次要文字、加粗、反色。界面回答两个问题：这东西在这个 agent 下现在能不能用；点了没成的话，是什么挡住了。

colors:
  canvas: "#ffffff"
  surface: "#f0f0fa"
  hairline: "#e0e0e8"
  ink: "#000000"
  ink-mute: "#5a5a5f"
  ink-faint: "#9a9aa2"
  disabled: "#c8c8d0"
  ink-faint-inverse: "#6a6a72"

typography:
  display:
    fontFamily: "Barlow Condensed, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: 1.4px
    textTransform: uppercase
  wordmark:
    fontFamily: "Barlow Condensed, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: 1.9px
    textTransform: uppercase
  body:
    fontFamily: "Barlow, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  nav-cap:
    fontFamily: "Barlow Condensed, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: 1.17px
    textTransform: uppercase
  button-cap:
    fontFamily: "Barlow Condensed, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: 1.17px
    textTransform: uppercase
  caption:
    fontFamily: "Barlow, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  micro-cap:
    fontFamily: "Barlow Condensed, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 2.0
    letterSpacing: 0.96px
    textTransform: uppercase
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, PingFang SC, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6

borders:
  hairline: "1px solid {colors.hairline}"
  strong: "1px solid {colors.ink}"
  disabled: "1px solid {colors.disabled}"

rounded:
  none: 0
  input: 4px
  pill: 32px
  dot: 50%

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 18px
  xl: 24px
  xxl: 32px
  huge: 48px

components:
  button-ghost:
    backgroundColor: "transparent"
    borderColor: "{colors.ink}"
    textColor: "{colors.ink}"
    typography: "{typography.button-cap}"
    rounded: "{rounded.pill}"
    height: 34px
    padding: 0 24px
  button-ghost-compact:
    backgroundColor: "transparent"
    borderColor: "{colors.ink}"
    textColor: "{colors.ink}"
    typography: "{typography.button-cap}"
    rounded: "{rounded.pill}"
    height: 26px
    padding: 0 16px
  button-inverse:
    backgroundColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.button-cap}"
    rounded: "{rounded.pill}"
    height: 34px
    padding: 0 24px
  button-disabled:
    backgroundColor: "transparent"
    borderColor: "{colors.disabled}"
    textColor: "{colors.ink-faint}"
    typography: "{typography.button-cap}"
    rounded: "{rounded.pill}"
    height: 34px
    padding: 0 24px
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.ink-mute}"
    typography: "{typography.caption}"
    textDecoration: underline
  chip:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    height: 34px
    padding: 0 16px
  chip-selected:
    backgroundColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    height: 34px
    padding: 0 16px
  chip-disabled:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    textColor: "{colors.ink-faint}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    height: 34px
    padding: 0 16px
  chip-compact:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 2px 6px 2px 10px
    removeMark: 9px {colors.ink-mute}, hover {colors.ink}, gap 5px
  tag-square:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.ink}"
    textColor: "{colors.ink}"
    typography: "{typography.micro-cap}"
    rounded: "{rounded.none}"
    padding: 1px 6px
  tag-square-weak:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    textColor: "{colors.ink-faint}"
    typography: "{typography.micro-cap}"
    rounded: "{rounded.none}"
    padding: 1px 6px
  text-input:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.input}"
    padding: 10px 14px
  toast:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.ink}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 16px 20px
    maxWidth: 480px
  banner-error:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 12px 16px
  confirm:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.ink}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 24px 28px
    width: 460px
  pending-bar:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.ink}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 9px 32px
  row-notice:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.none}"
    padding: 8px 12px
---

# Sophia 设计系统

**本文件是实现的唯一依据。** 画布「SymSync 界面重构」（改名前的画布，名字未改）是视觉参照，两者不一致时以本文件为准；改组件先改这里，再改代码，再同步画布。`scripts/lint-ui.mjs` 把本文件的硬性约束变成了可执行断言，接在 `make lint` 里。

历史裁决与每条规则背后的推理在 `docs/specs/2026-09-21-ui-decisions-log.md`，本文件只写结论。

## Overview

视觉源自 `docs/DESIGN-spacex.md` 的 shop 面（`canvas-light` 那一组）。marketing 面那套（纯黑、全幅照片、80px 大写标题）对工具界面不成立，不采用。

界面回答两个问题：**这东西在这个 agent 下现在能不能用**；**点了没成的话，是什么挡住了**。第二个问题必须给出用户能据此行动的话，不是错误码。

## Colors

**整个界面零色彩。** 八个灰阶，没有任何有彩色的值。规范规定色彩全部来自照片，工具里没有照片，所以一个色都不用。

强调只有三种手段，按强度递增：**次要文字（`ink-mute`）→ 加粗 → 反色（`ink` 底 `canvas` 字）**。红色不是其中之一。

**破坏性操作靠信息和文案承担分量，不靠颜色。** 删除弹窗给出完整路径、目录大小、受影响的链接数、git 状态；按钮写「删到废纸篓」而不是「确定」——用户读完就知道会发生什么，再涂红就是吓唬人。

| Token | 用途 |
|---|---|
| `canvas` | 画布 |
| `surface` | 次级面：侧栏选中、悬停 |
| `hairline` | 分隔线、选择片描边、无格态短横 |
| `ink` | 主文字、实心圆点、按钮描边 |
| `ink-mute` | 次要文字、文字链 |
| `ink-faint` | 弱文字、空心圆点描边、hover 前的排序箭头 |
| `disabled` | 禁用描边 |
| `ink-faint-inverse` | 反色面（选中行、错误横幅）里的空心描边 |

## Typography

### 三个字族都没有中文字形

界面绝大部分文字是中文，会落到系统 CJK 字体（macOS 苹方）。所以字族选择**只对西文生效**——skill 名、路径、数字、agent 名。三条推论：

1. `text-transform: uppercase` 对中文**完全无效**。「自动同步」不会有任何变化，它只在 `SKILL` `CLAUDE CODE` 这类西文标签上起作用。
2. `letter-spacing` 对中文有效，但那是字间距不是字母间距。区域标签的 0.96px 用在中文上读起来是「疏排」，这是想要的效果。
3. 中西文混排一行里，`font-weight: 600` 取的是苹方的中黑，与 Barlow Condensed 的 600 不是同一个视觉重量，略有差异是可接受的代价，**不要为此改成 700**。

字体文件打进应用，只引 latin 子集的 Barlow 400、Barlow Condensed 600/700、IBM Plex Mono 400。不走 CDN，不整包引入。

### 层级：五档，相邻至少差一倍的视觉重量

| Token | 字号 / 行高 | 用在哪 |
|---|---|---|
| `display` | 28 / 1.1 | 二级页面名、区域大标题 |
| `wordmark` | 20 / 1.0 | 顶栏 wordmark |
| `body` | 15 / 1.6 | 表格、说明、条目名、选择片文字 |
| `button-cap` / `caption` | 13 | 按钮；副行、文字链、提示条副行 |
| `micro-cap` / `mono` | 12 / **2.0** | 区域标签、列头、方标签；路径与计数 |

**五档之外有两个 `body` 档的变体，它们不是第六档**——字号行高与 `body` 完全一致，变的是字族、字重、字距与大小写：

| 变体 | 写法 | 用在哪 |
|---|---|---|
| `nav-cap` | Condensed 15 / 700 / +1.17 / 大写 | 顶栏页签（一级导航），可点高度 36 |
| `head-cap` | Condensed 15 / 600 / +1.1（`--track-head`） | 区域小标题、弹窗标题 |

**第一版的错**：20 / 15 / 14 / 13 / 12 五档挤在 8px 里，14 与 15、13 与 12 眼睛分不出来，整页读起来像一张密排的表。参照 `DESIGN-spacex.md`：display 到 body 是三倍以上的跳跃，小字靠**行高 2.0** 撑出呼吸感而不是靠字号。所以：页面名拉到 28；砍掉 14 这一档；12px 的标签行高 2.0（占 24px 高，与 SpaceX 的 `micro-cap` 一致）。

### 大写是结构的语言，不大写是内容的语言

**实现上这意味着：`display` / `nav-cap` / `button-cap` / `micro-cap` 四档 token 自带 `text-transform: uppercase`，专名嵌进去必须逐个用 `<Plain>` 开洞**——`重启 Codex` 不包就渲染成 `重启 CODEX`。这条踩过两次，第二次是渲染成图才看出来。

大写只给**我们自己写的结构词**：区域标签、列头、按钮。被谈论的对象一律不大写——agent 名出现在选择片、行标题、句子里时都写 `Claude Code`。唯一例外是矩阵列头，那里 agent 名承担列标签的职能。

**文件系统来的名字一律原样，不做大小写转换。** `defuddle` 转成 `DEFUDDLE` 后跟表格里的名字对不上。

**skill 名用 `body`，不用 `mono`。** 等宽的理由是路径要对齐、要分得清 `l` 与 `1`；skill 名在列表里是当词读的，等宽反而更难读，还会和同行标签的字号打架。目录名出现在路径里时随路径走等宽。

## Layout

基准 8px，子单位 4 / 12 / 16 / 18 / 24 / 32 / **48**。

### 壳

**顶栏的 wordmark 用 `assets/logo/wordmark.svg`，不用纯文本。** 字标的首字母带和图标同样的重影——那是这个标志的识别点，写成 `<h1>Sophia</h1>` 就丢了。高度 20px（`wordmark` 档），`currentColor` 取色。

**窗口标题栏不显示产品名**（macOS：`titleBarStyle: Overlay` + `hiddenTitle`）。顶栏自己已经有 wordmark，系统标题栏再写一遍 "Sophia" 是重复。

红绿灯浮在窗口左上角那 28px 里——**那一排留空**，只当拖动区；字标与页签在它下面的 56px 里。第一版把字标和红绿灯挤在同一排，用户反馈"太靠上"。顶栏总高 84 = 28 空 + 56 内容，整条可拖动窗口。**二级页面的头同一条规矩**（它是 `position: fixed` 盖满整窗的）。

**侧栏底部的「添加项目」是文字链**（`button-link`），不是 pill、不带省略号。它是侧栏里的次级动作，样式与侧栏项同一档；第一版是一个孤立的按钮，"和其他的格格不入"。

### 留白：往大了给

| 尺度 | 值 | 用在哪 |
|---|---|---|
| 区域之间 | `huge` 48 | 页面里的大区块（模型页的「agent 行区」与「限制说明」之间） |
| 组之间 | `xl` 24 | 筛选行与表格、表格与待处理栏、表单字段之间 |
| 行内 | `sm` 12 | 同一行里元素之间 |
| 页边 | `xxl` 32 | 内容区左右内边距（SpaceX 的 grid gutter） |

**矩阵行高 40px**，不是 30。密排的表格是"文字很密集"这个观感的主要来源——skill 名、位置名、圆点之间要有空气。

**壳**：顶栏 56px + hairline；侧栏与内容区之间 hairline；侧栏项高 36px。**二级页面**占满整窗、不渲染侧栏，顶栏换成 `←` + 页面名（`display` 28px）。

**待处理栏贴底**：`position: sticky; bottom: 0`，与内容区底边之间**没有缝隙**，上边一条 `ink` 描边，左右负边距铺满内容区、内边距与页边对齐。

## Elevation & Depth

零阴影、零渐变、零 `rgba()`。层级只靠描边与反色表达。

确认弹窗的背景罩是**白罩 `opacity: .72`**——零色彩系统里没有半透明黑。

## Shapes

**圆角只有四个值，且形状承担语义**（`none` 是其中之一，也是绝大多数元素的取值）：

| 值 | 给谁 | 语义 |
|---|---|---|
| `pill` 32px | 按钮、选择片 | **可点** |
| `input` 4px | 输入框 | |
| `dot` 50% | 状态点 | |
| `none` 0 | 其余一切 | |

**pill 是「可点」的记号。** 不可点的标识——状态徽标、分组标记——一律零圆角方标签（`tag-square`）。界面里唯一的圆角就是"这里可以按"，所以圆角不能出现在按不动的东西上。

## Components

### 按钮

只有一种形：ghost pill。四个变体：默认、禁用（**必须同时给 `title` 说明原因**，类型上强制）、反色（表示"现在开着"的开关态）、文字链（次级动作）。两档尺寸按所在容器的高度选，不按重要性选。

### 状态与动效

| 项 | 取值 |
|---|---|
| 可点元素高度 | `--control-h: 34px` / `--control-h-compact: 26px`，**一律偶数**——奇数高会让 pill 端帽只有 75% 覆盖，同一圈描边一半实一半虚，读起来就是「锯齿」 |
| 命中区下限 | `--hit-min: 24px` |
| 焦点 | 只认 `:focus-visible`：1px `ink` 外框、偏移 2px；反色面上转 `canvas`。**不要系统默认的蓝色焦点环**——那是零色彩界面里唯一闯进来的彩色 |
| 过渡 | 只有一档 `--motion-fast: 120ms`，且 `prefers-reduced-motion` 下全部关掉 |
| 数字 | `font-variant-numeric: tabular-nums`，计数跳动时不抖 |
| 字形渲染 | `-webkit-font-smoothing: antialiased`，关掉 macOS 次像素渲染的彩边（零色彩系统里它是真能看出来的） |

### 选择片 `Chip`

多选 / 单选的紧凑控件。未选中 hairline 描边，选中**反色**，不可选灰描边灰字。文字用 `body`（不大写，内容是专名）。图标 16px 在左，间距 8px。

### 状态点 `StateDot`

格回答两件事：**填充＝这个 agent 能不能用它，外环＝它在这儿是本体还是一条软链。**

| 状态 | 形 |
|---|---|
| `linked` 已开启 · 软链 | 9px 实心 |
| `missing` 未开启 | 9px 空心 `ink-faint` |
| `own` 已开启 · 本体 | 13px 外环 + 6px 内实心 |
| 无格 | 8px `hairline` 短横，不可点 |

**前三行是状态，第四行不是**：「无格」说的是这儿根本没有这一格，不是某种状态。常驻的状态只有那三种。异常态（链接失效、指向别处、同名被占、整目录链走、写不进去）**画成空心**，但点击行为与文案分叉——由提示条说原因，需要拿主意的进待处理栏。

选中行反色时：实心与外环转 `canvas`，空心描边转 `ink-faint-inverse`。

### 矩阵列头

**16px 图标在上、名字 `micro-cap` 在下，堆叠。** 列宽约 84px。

**列头没有灯。** 曾经在图标右上角放一盏 6px 的灯表示目录状态，用户看不懂。目录不存在这件事在点击那一刻由提示条说（「已经建出来」），写不进去的进待处理栏——列头不需要再说一遍。

### 图标

所有图标同一套画法：16px 画布、`currentColor`、1.4 描边。**设置的入口必须是有齿圈的齿轮**——第一版画成圆心加八根放射线，那是太阳，用户看成了「切换日间模式」。看不懂的图标比没有图标更糟，这条和列头灯是同一课。

### agent 图标 `AgentMark`

单色 inline SVG，`currentColor` 取色。**不用品牌色。** 实现时用各项目官方 SVG 转单色路径，不手画。取不到的用**首字母方块**（14px `tag-square-weak` + 一个大写字母）——它是图标缺席时的占位，**永远和名字一起出现**：已安装的 9 个里首字母就撞了 3 个 C、2 个 G。

### 选择操作条

勾选一个以上 skill 后，表格上方出现一条：`已选 N 个 skill` + `取消选择` + **一排 agent 片**（每个在本域的 agent 一片，外加「全部」）。

每片是一个开关，语义是**已选的 skill × 这个 agent**：

| 片的状态 | 含义 | 点一下 |
|---|---|---|
| 反色 | 已选的 skill 在这个 agent 下**全部**开着 | 全部关掉 |
| hairline + `开启 N` | 有 N 个还没开 | 把没开的开了 |
| 灰描边不可选 | 已选的都是本体、或这个 agent 整目录链走 | — |

「全部」片对所有 agent 做同一件事。**不要**把它退化成只有「开启（N）」「关掉（M）」两个按钮——那丢掉了"针对某个 agent"这一维。

### 空态与忙碌态

四种空态（扫描中、这个域没有目录、筛选无结果、一个都没有）各自说明现状与下一步；两个动作时**只有一个是 pill**，另一个降文字链。busy 期间受影响控件 `opacity: .45`，**五个豁免**：设置、筛选输入框、取消选择、提示条关闭、表头排序——保持 `opacity: 1`，不加聚焦态，对比本身就说明它还能用。

### 表头排序

默认无箭头（`visibility: hidden` 占位，hover 时行不跳）、hover 出 `ink-faint` 箭头、激活转 `ink`。busy 期间不禁用。

## Patterns

**这一节只放与产品无关的组织法**——换一个产品、换一批对象，这些规则照样成立。
凡是「本产品叫什么、算什么、显示几个」的裁决，一律去 `## 产品裁决`。

### 说结果，不说机制

软链是我们的实现手段，不是用户的目的。**只在用户需要据此判断时才提软链**——删本体的弹窗要说「2 条链接会因此失效」，因为那正是他要权衡的；其余时候说他能看见的结果。

| 别写 | 写 |
|---|---|
| 导入＝在选中的 agent 下建软链接 | 让这些 skill 出现在「全局」的列表里 |
| 没有需要建立的链接 | `<agent>` 下已经有同名的 `<skill>`，没有覆盖它 |
| 操作失败，请重试 | `<agent>` 的 skills 目录写不进去 |

### 命中区与视觉尺寸是两回事

**视觉可以小，命中区不能小于 24×24。** 12px 的方形复选框、片上 9px 的 `×`、6px 的圆点——它们的**视觉**尺寸由层级决定，但点击目标要用透明外圈撑到 24px 以上；列表行里的选择记号更进一步：**整行可点**，记号只是告诉你点了会发生什么。

**撑命中区不能改变视觉尺寸。** 用 `padding` 撑的话 `border` 会画在 padding 盒外沿，12px 的框就成了 24px——模型选择器里的复选框就是这么变大的，和 skill 列表里的一比就露馅。正确做法：视觉元素保持自身尺寸，命中区用伪元素或透明 `outline`/负外边距的包裹层撑，不动 border。**同一个记号在全应用里只能有一个尺寸。**

### 可点的面：hover 怎么表示

零色彩系统里能用的只有描边和反色，按面的形态分两种：

| 面 | 静息 | hover |
|---|---|---|
| 有 `hairline` 描边的块（区块、输入框、未选中的片） | `hairline` 描边 | 描边转 `ink`，**底色不变**——换底色会把里面 canvas 底的片糊掉 |
| 无描边的列表行（侧栏项、表格行） | 无描边 | 底色转 `surface` |
| **静息就已经是 `ink` 描边的面**（按钮、选中的片） | `ink` 描边或反色 | 描边已经到顶，**改底**：ghost pill 铺 `surface`、按下转 `hairline`；反色面退到 `ink-mute` |

第三行是前两条规则的盲区：描边只有 hairline → ink 一档可升，升满了就没有下一档，所以只能改底。

### 什么时候才有按钮

**界面里的改动默认当场生效。** 勾选、开关、改名、删片、筛选——点了就是结果，不需要第二步去确认它。这条原则曾散在四处注释里（「返回即保存」「改一个生效一个」「切换开关即保存」「不给拉取模型单独按钮」），从没被正面写出来，于是新写的浮层又长出一对「保存 / 关闭」。

只有三种情况配得上一个按钮：

1. **要离开当前语境去做一件外部的事**：`配置`、`启用` / `撤下`、`重启 Codex`、`导入 skill`
2. **多个输入必须一次提交、中途状态没有意义**：网关地址 + 密钥 → `保存`（且保存即拉取）
3. **真会丢东西、需要确认一道**：删本体、开启自动同步 / 自动导入、MCP 的批量或跨域写入、重启 Codex——与「页面还是弹层」那四处确认同源

**「关闭」「取消」「确定」不是动作。** 浮层点外面或 Esc 关；二级页面 `←` 或 Esc 回；离开即提交。唯一例外是确认弹窗里的 `取消`——那是在回答一个问题，不是在关一个面。

一句判据：**操作本身已经说明了结果，就不要再放一个按钮教用户怎么完成它。**

### 反馈：四个地方会说话，一件事只在一个地方说

| 说什么 | 在哪 | 形 |
|---|---|---|
| 刚做完了什么（会消失） | 提示条 `toast` | 右下浮层，一次操作汇总成一句，不排队。6 秒（做不成 8 秒）。可逆的给 `撤销` |
| 应用级故障（不会消失） | 错误横幅 `banner-error` | 顶栏之下通栏反色 |
| 要你拿主意，散在几十行里 | 待处理栏 `pending-bar` / 待处理页 | 主视图底部贴底一条，一次一条；完整列表在二级页面 |
| 要你拿主意，就挂在这一行上 | 行内待办条 `row-notice` | 一句话 + 紧凑 pill + `稍后` |

**二级页面自己渲染提示条**（待处理页已经这么做）。壳上的提示条只服务主视图。二级页面里上游服务够不着这类失败（网关拉不到模型列表）走错误横幅——它不是某次点击的结果，是那条链路此刻不通，用户得读完再走。

**提示条的四种形态**：成功（一句 + 等宽统计副行 + 撤销）、成功多项（汇总一句）、做不成（说原因）、部分失败（`开启了 2 个，1 个没成——<原因>` + `查看`）。

**待处理栏里每一类都带自己的动作**：

| 类 | 一句话 | 动作 |
|---|---|---|
| 同名本体 | `<skill> 有两个本体，删掉哪个？` | `删 <位置A> 的` / `删 <位置B> 的` / `忽略` |
| 链接失效 | `<agent> 下 <skill> 的链接指向的位置没了` | `清除` / `忽略` |
| 整目录链走 | `<agent> 的 skills 目录整个链到了别的本体，要逐条开关得先拆开` | `拆开` / `忽略` |
| 写不进去 | `<agent> 的 skills 目录写不进去` | `再试一次` / `忽略` |

同名本体那条：**两个本体各自仍在列表里成行**，待处理栏只负责问删哪个。不要用"指向别处、没有覆盖"这种格视角的话——那是点格时提示条说的，待处理栏说的是行视角的事。

**「忽略」记的是这一条具体状况**，不是记这个 skill：涉及的位置发生变化后重新提示。key 由前端与 core 按同一公式算（`tests/issue-key-contract.test.ts` 与 `store.rs` 两边钉死）。

### 页面还是弹层

**弹层只有一种用途：确认一个决定。** 设置、导入、待处理、网关配置全是二级页面。弹层把用户困在一个小框里，挤出来的信息密度低。

**确认只给这四件事，且只确认一道**：删本体（真会丢内容）、开启自动同步 / 自动导入（一次批量建几十条，规模用户看不见）、MCP 的**批量或跨域**写入（跨域会把请求头和令牌一并复制过去）、**重启 Codex**（会结束正在运行的进程）。开关链接、清除失效链接、**MCP 同域的单格写入**都不确认。

## 产品裁决

下面几节是 Sophia 自己的决定，**不是设计系统的一部分**。做别的产品时照搬这里的结论没有意义，
该照搬的是上面的 Foundations / Components / Patterns。

### 术语

**Skill 和 MCP 都叫「导入」。** MCP 页曾用「引入」区别于 skill 的「导入」，用户反馈应该统一——同一个动作两个词，换个 tab 就要重新学。

界面文案里**不出现「harness」**，一律 agent。代码标识符不动（`disabled_harnesses` 是已落盘的键）。

### 来源的名字

来源的标签是**用户认得的名字**，不是路径：

| 来源 | 标签 |
|---|---|
| 通用仓库 | `通用仓库` |
| agent 的全局目录 | agent 名 |
| 项目 | 项目目录名 |
| 应用包内的目录（`/Applications/ego lite.app/…/ego-skills`） | **应用名** `ego lite`——从 `.app` 那一级取，去掉后缀 |
| 应用数据目录（`~/Library/Application Support/WeiboAP/…`） | **应用名** `WeiboAP`——`Application Support` 下一级 |
| 其余外部目录 | 从末尾往上找**第一个不是泛称的分量**：`~/.local/share/ego/skills` 叫 `ego` 不叫 `skills`。末尾一级几乎总是 `skills` 这类泛称，光取它三个来源会撞成一个名字 |

路径放 `title`。绝对路径**不出现在任何可见文案里**，除非用户正要据此做判断（删本体的确认弹窗）。

**矩阵「本体位置」列不给外部来源挂「外部」标签。** 用户要知道的是它叫什么、在哪，`ego lite` 这个名字已经说完了；「外部」是我们的分类词，对用户没有信息量。导入页的来源栏保留分类，那里是在挑来源、分类有用。

### 计数口径

一页上出现的数字口径必须一致。侧栏域名右侧＝该域有格可点的 skill 行数；列头 agent 名下＝该 agent 下能用的格数；导入页来源栏「未导入」列＝未导入数，列表头 `· N 个本体`＝本体总数，**两个数不共用位置**；自动同步行＝下一轮会新建的条数，**带单位写成 `N 条待建`**，裸的 `+N` 会被读成「还有 N 个 agent」。

### 列的存废

看「用户还有没有别的入口」，不看「文件存不存在」。Skill：目录不存在的 agent 照样成列（藏了用户就没别的地方能把目录建出来）。MCP：Claude Code 在一个项目里的第二个空位置藏起来（它仍是「导入」的显式目标，入口没丢）。

### 模型页

**一个 agent 一张卡，卡片按列表排；页面上没有解释段落。** 参照 cc-switch 的 provider 列表：一眼看到的是"有哪些、各自什么状态"，不是一篇说明。第一版是"区域标题 + 一句介绍 + 名字 + 两行说明 + 分隔线 + 限制说明段"的文档式排版，用户反馈"很乱"。

卡片（hairline 描边、零圆角、内边距 16 24）：

| 行 | 内容 |
|---|---|
| 第一行 | 左：24px 图标 + 名字（`display` 档，不大写）。右：三个动作——开关（ghost pill 两态，反色＝已启用）、`重启 <agent>`、`配置网关` |
| 第二行 | **生效的模型**：紧凑片（`chip-compact`），每片带 `×`；整行可点打开选择器；空时写 `还没选模型 · 点这里挑`。片区自然换行 |
| 第三行 | **一句** `caption`：状态 + 版本 + 路由，合成一句，版本与端口那几段走 `mono`。`还没启用 · Codex 0.155 · 路由未安装`。不是两行——「一句人话副行 + 一行等宽事实」那个旧说法作废。**不写"选好的 N 个模型点「启用」就会进…"这种教操作的话**——按钮就在那儿 |

卡片**满宽**，里面的每一行也满宽——生效的模型那一块不设 `max-width`，否则卡片右边空一大片。卡片之间 16。卡片上方**没有**「第三方模型」区域标题和那句介绍；卡片下方**没有**「用第三方模型要知道的」段落——限制说明搬到网关配置页底部，配置第三方模型的地方才是读它限制的地方。

**选择器**：搜索框 + 列表，已选置顶，已选标记用 **12px 方形复选框**——圆＝状态（只读事实），方＝选择（我选的）。整行可点，勾选当场写盘，没有保存/关闭按钮。

**网关配置页**：二级页面，同一页两个视图——列表（一家一行）与表单（地址 + 密钥 + `保存`即拉取 + 只读端口协议）。底部一段 `caption`：用第三方模型的限制。

**`重启 <agent>`**：结束它的常驻进程，下次启动带新配置。会中断进行中的对话，**确认一道**。**没有禁用态**——一个进程都没找到不算失败。

## Do's and Don'ts

### Do

- 一次操作只汇总成一句提示条
- 禁用的按钮同时给 `title` 说原因
- 需要用户拿主意的事进待处理栏，各带自己的动作
- 数字带单位
- 用反色表示"现在开着"

### Don't

- 不涂红。破坏性靠信息承担分量
- 不用滑动开关（iOS 语言，必带圆角）
- 不在列头放灯。看不懂的记号比没有记号更糟
- 不把选择操作条退化成两个总按钮，「针对某个 agent」这一维不能丢
- 不显示绝对路径，除非用户正要据此做判断
- 不写「操作失败」「请重试」「没有需要建立的链接」
- 不给「拉取模型」「改选模型」单独的按钮——保存即拉取，整块区域可点
- 不给浮层配「保存」「关闭」——点了就生效，点外面就关
- 不让命中区跟着视觉尺寸缩——12px 的记号，24px 的目标
- 不说「同步」（MCP 页）——它只新增、从不覆盖也不删除

## Decisions

- **2026-09-21 · 规范自检**：新画布「Sophia 设计系统」按组件重排时，逐条核出这份规范自己的毛病，一次改掉——① 数字对不上四处：「五档」下面列六行（`nav-cap` 与 `body` 同字号同行高，它是 body 的变体不是第六档，另立一小表，同时补上一直在用却从未写进规范的 `head-cap` 与 `--track-head: 1.1px`）、「圆角三个值」实为四个、StateDot「三种常驻」表里四行（第四行「无格」不是状态）、「五种空态」实为四种；② 「可点的面」原来只有两行，漏掉**静息就已经是 ink 描边的面**——描边升满了没有下一档，只能改底，PR #19 实现时只好自己发明，现在补成规范；③ 新增「状态与动效」一节，把 PR #19 落地但规范里查不到的一整组写回来（定高 34/26 且一律偶数、命中区 24、`:focus-visible` 的 1px ink 焦点环、120ms 单档过渡与 `prefers-reduced-motion`、`tabular-nums`、关次像素渲染）；④ front-matter 的 `button-ghost.padding: 9px 24px` 已与实现不符，改成 `height + padding`；⑤ 新增 `borders` 一组——零阴影零渐变，层级几乎全靠描边承担，它却从来没被 token 化。
- **2026-09-21 · 分层**：`## Patterns` 原来五节没有一条是可复用的模式（术语、来源的名字、计数口径、列的存废、模型页全是 Sophia 的裁决），而真正跨产品的规则反倒躺在 `## Components` 里。现在：跨产品的五节（命中区、可点的面、什么时候才有按钮、四个地方会说话、页面还是弹层）移进 `Patterns`，产品裁决另起 `## 产品裁决`。**这份规范要拿去做别的设计，分层不清就等于过拟合。**

日期为准，后者覆盖前者。完整推理见 `docs/specs/2026-09-21-ui-decisions-log.md`。

- **2026-09-21 · 反打补丁**：一天十几条反馈逐条改代码、画布一次没更新，结果彼此不统一。改法：先把整套画布按当前决定重画（`.superpowers/design/BRIEF-v2.md`），看图，再实施。顺带三条：侧栏「添加项目」改文字链去省略号；卡片内容满宽；命中区不能用 padding 撑（border 会跟着大）。
- **2026-09-21 · 模型页改卡片列表**：一个 agent 一张 hairline 卡，三行——身份与动作 / 生效的模型 / 一句状态；页面没有解释段落，限制说明搬去网关配置页。参照 cc-switch 的 provider 列表；第一版文档式排版被反馈"很乱"。
- **2026-09-21 · 首页五条**：wordmark 用带重影的字标资产不用纯文本；系统标题栏不显示产品名；模型页一行一个 agent、生效的模型并进行里（多 agent 时不能一个占两段）；设置图标从「太阳」改成真齿轮；矩阵里去掉「外部」标签。
- **2026-09-21 · 顶栏页签有自己的档**：`nav-cap` 15/700。留白那轮把全局字号拉开时，顶栏页签漏改、还留在 12px 的标签档——挨着 20px 的 wordmark 显得极小，中文的「模型」又吃不到大写和字距。一级导航值得比普通按钮高半档。
- **2026-09-21 · 什么时候才有按钮**：改动默认当场生效；按钮只给「离开语境做外部的事」「多输入一次提交」「要确认的破坏性操作」三种。起因是真机反馈「过度设计」——模型选择浮层长出了「保存 / 关闭」，而点外面本来就关、勾选本来就该当场生效。
- **2026-09-21 · 侧栏没有「全部」**：默认落在「全局」。多域并排时同名 agent 出现多列、选择操作条的片重复；跨域批量的事走待处理页。（早在裁决日志里定了，这次才实现。）
- **2026-09-21 · 留白与层级**：字号从 20/15/14/13/12 改成 28/20/15/13/12，砍掉 14；12px 标签行高 2.0；按钮内边距 7/20 → 9/24；矩阵行高 30 → 40；间距加 `huge` 48；页边 32。原因：整页读起来像密排的表，SpaceX 的层级靠三倍跳跃和行高撑开，不靠字号密集分档。
- **2026-09-21 · 真机反馈七条**：列头灯移除；选择操作条改为按 agent 的片；外部来源标签取应用名；待处理栏贴底、同名本体用行视角文案并给「删 X 的」；「重启路由」改为「重启 Codex」（它是常驻进程，可以结束）并确认一道；「拉取模型」并进「保存」；「改选模型」链接去掉、整块区域可点、已选模型改紧凑片。
- **2026-09-21 · 排版**：skill 名用 `body` 不用 `mono`；`mono` 只给路径与计数。
- **2026-09-21 · 反馈归属**：四处会说话，一件事只在一处说；行内待办条是第四处，边界是"处理它的动作就在那一行上"。
- **2026-09-21 · 零色彩**：删掉红与琥珀两个 token；错误横幅用反色；破坏性按钮不涂红。
- **2026-09-21 · 删本体**：不给撤销（后端没有恢复命令），提示条说「已移到废纸篓，可以在访达里恢复」。
- **2026-09-21 · 自动同步行**：不展开，只读一行 + `关掉`。建规则在导入页那个勾，排除 / 恢复在矩阵点圆点。
- **2026-09-21 · 设置**：二级页面；agent 选择片网格；不展示路径；默认只列已安装的（本机 9 / 41）。
- **2026-09-21 · 确认**：删本体、开启自动同步 / 自动导入、MCP 的批量或跨域写入、重启 Codex，四件事各一道。原先写的是「两处」却列了三条，还写着「写入 MCP 配置都不确认」——与 `docs/specs/2026-09-21-ui-rebuild-mcp.md`「同域单格不确认、批量与跨域确认」的裁决相抵；实现按 MCP 那份做的，这里按实现校正。
