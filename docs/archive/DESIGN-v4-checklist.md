# V4 落地清单（归档）

> **归档**（2026-09-25）：这份清单是 V4 视觉与 D1–D24 布局的实施验收标准，已全部落地，原在 `docs/DESIGN.md` 末尾。条目里的「本文件」「见「某节」」指当时的 `DESIGN.md`；现行规范以 `docs/DESIGN.md`、`docs/DESIGN-components.md` 为准，演变见 `docs/DESIGN-decisions.md`。归档前按后来的决定改掉了会误导验收的几条（深色失败提示、外链的手形光标与下划线、删来源管理页、勾选框 16），改动处标「归档前改」；其余条目按当时原样保留，与现行规范不一致时以现行规范为准。

实施的验收标准。每条一行：做什么 → 怎么验。视觉改动按 CLAUDE.md 跑 `make build-web && cargo check --workspace` 与 `make test`，并在 `make dev` 里 1x 与 2x 各截一次图对照本文件。

## 一、视觉语言（现在就能落地）

**tokens.css + 字体**
- 色 token 换成 front-matter 的 14 个（`--shell` … `--accent`；`--ink-edge` 随 2026-09-24 物性删除）→ `tests/ui.test.ts` 的 token 表断言逐值通过。
- 删 `--canvas` `--disabled` → `grep -rn "var(--canvas)\|var(--disabled)" src` 为空。字族 token 回到 `--font-ui`（Barlow）/ `--font-cond`（Barlow Condensed）/ `--font-mono`；正字距 token 只留三个：`--track-nav: 1.17px` `--track-label: 0.96px` `--track-head: 1.1px`（2026-09-24 字体回到原设计），`--track-display` `--track-title` 不恢复（页面名字距 0）→ `grep -rn -- "--track-" src` 只出现这三个名字，且只在 `Cap` 的样式里被引用。
- 圆角 token：`--radius-scribe 2 / mark 4 / knob 4 / track 5 / control 7 / tab-track 10 / face 12 / float 12 / pill 999px / dot 50%`，删 `--radius-layer` `--radius-dialog` → `grep -rn -- "--radius-\(layer\|dialog\)" src` 为空。
- 层次 token 换成四档（2026-09-24 物性）：凹 `--recess-input` `--recess-tabs` `--recess-track`，抬起 `--raise` `--raise-hover` `--raise-pressed` `--raise-ink` `--raise-ink-pressed`，浮 `--elev-float`，值照 front-matter `elevation`；删 `--key-edge` `--key-edge-ink` `--recess-pressed` `--elev-layer` `--elev-tip`，`--veil-opacity: 0.16` → `grep -rn "key-edge\|recess-pressed\|elev-layer\|elev-tip" src` 为空，`rgba(` 只出现在这些定义行。
- 动效 token（2026-09-24 物性）：`--motion-fast: 120ms`、`--ease-mech`、`--dur-press: 70ms`、`--dur-release: 180ms`、`--dur-slide-tab: 260ms`、`--dur-slide-knob: 200ms`、`--spring-slide`（front-matter `motion.spring-slide` 的 `linear()` 原样）、`--press-transform: translateY(0.5px) scale(.985)` → 页签滑块与开关滑块的 `transition` 引用 `--spring-slide`，颜色 / 底色 / 透明度的 `transition` 引用 `--ease-mech`；`grep -rn "cubic-bezier\|linear(" src` 只出现在 tokens.css 的定义行；reduced-motion 块把这些时长全置 0。
- 字号 token：28 / 20 / 16 / 15 / 13 / 12，行高按「层级」表，删 `--size-wordmark` 与 `--leading-micro: 2` → tokens.css 里没有 14px、没有 2.0 行高。
- 字体用 `@fontsource/barlow` latin 400/500/600 + `@fontsource/barlow-condensed` latin 600/700 + `@fontsource/ibm-plex-mono` latin 400/500；`--font-ui: Barlow, "PingFang SC", "Microsoft YaHei", sans-serif`，`--font-cond: "Barlow Condensed", "PingFang SC", "Microsoft YaHei", sans-serif`（2026-09-24 字体回到原设计）→ `package.json` 里没有 `@fontsource/inter`，构建产物里没有 Inter 字体文件；各档字族按「Typography › 层级」表。
- `:root` 底色 `--shell`、字色 `--ink`、全局 `tabular-nums` → dev 窗口里机壳取色 = #F4F4F2。

**scripts/lint-ui.mjs 的 token 集**
- `TOKENS` 换成 V4 的 14 个值（2026-09-24 物性删 `#000000`）→ 在 tokens.css 之外写任何字面色值、或在 tokens.css 里写旧值 `#222222` `#f2f2f2` `#c8c8c8` 时 lint 报错。
- `FONTS` = `Barlow` `Barlow Condensed` `IBM Plex Mono` → 写 `Inter` 报错。
- `RADII` 换成 `0 / 4px / 7px / 12px / 999px / 50%`（2026-09-24 物性删 2 / 5 / 10）→ 写 2px、3px、5px、6px、8px、10px、32px 报错。
- `ELEVATIONS` 与 `ELEV_DEF` 换成四档九个层次 token（`--recess-input/-tabs/-track`、`--raise` `--raise-hover` `--raise-pressed` `--raise-ink` `--raise-ink-pressed`、`--elev-float`）→ 直接写 `box-shadow: 0 2px 4px …` 报错，引用 `var(--raise)` / `var(--elev-float)` 通过，引用 `var(--key-edge)` 报错。
- `FADE_STOPS` 换成 `var(--face)` / `transparent` → 从 `--canvas` 渐隐报错。
- 新增 `accent-scope`：`var(--accent)` 只许出现在开关组件与指示点（侧栏 agent 名后）的选择器里 → 在按钮、文字、焦点环上用它报错。
- 删 `no-uppercase`，恢复原 `cjk-tracking`：`text-transform: uppercase` 与非 0 `letter-spacing` 只许出现在 `Cap` 的样式里（只作用于拉丁 run）→ 在别的选择器里写大写或正字距报错，`Cap` 里通过。
- `size-14` 保留，说明改为「28 / 20 / 16 / 15 / 13 / 12」→ 写 14px 仍报错。

**ui 组件（src/ui/*）**
- `Button`：默认键 `paper` + `--raise`（无 `ctl-border` 描边），悬停 `--raise-hover`，按下 `surface` 面 + `--raise-pressed` + `--press-transform`（70ms 按下、180ms 弹簧松开）；主动作墨键 + `--raise-ink` + `face` 字，按下 `--raise-ink-pressed`；禁用平贴（实线 `hairline`、无投影、按下不动，D20）；文字链拆成浅键与外链（见「二 · 通用组件」）→ 1x 截图里默认键四周有一圈淡环、下沿有柔和的影、看得出离开机面；悬停影子略重、键不动；按住时影子收紧、键略缩；禁用键与它并排时平贴无影。
- ~~`Button` 的 `is-on-dark` 变体改为墨面上的浅描边键~~ （归档前改，2026-09-25）：提示条一律是纸窗（2026-09-25「黑条提示全部改纸窗」），`Button` / `IconButton` 没有深色底上的变体 → `grep -rn "is-on-dark\|onDark" src` 为空；提示条里的 `撤销` `查看` 是默认键紧凑。
- `IconButton`（在 `Button.tsx` / `icons.tsx`）：图形 `ink-mute`，悬停 `surface` 底、图形 `ink`，不抬起、按下不动 → 图标键悬停只变底、没有投影、按下不缩。
- `Switch`：圆角矩形槽（`track` 5）+ 抬起的滑块（`knob` 4，面上无纹）+ 刻条（`scribe` 2） + 指示点，含紧凑版与不可用态，尺寸与位置照「开关」→ 开＝滑块在右 + 左侧橙刻条 + 橙点，关＝滑块在左 + 右侧灰刻条 + 灰点；滑块 `--raise`、悬停 `--raise-hover`、按住 `--raise-pressed`；点击滑块 200ms `--spring-slide` 停靠；按住横移 > 3px 进入拖动、滑块跟手，松手速度 ≥ 0.3px/ms 按方向落、否则过半落对侧、否则回原位（单元测试覆盖这三支与 3px 门槛）；不可用平贴无投影、拖不动；reduced-motion 下无位移动画、拖动仍跟手。
- `Chip`（来源筛选项）：行首 `来源` 标签 + 第一颗 `全部`（不带数）+ 每项一颗胶囊、来源名 + 计数（12 tabular，没选 `ink-faint`、选中 `ctl-border`），没选的 `recess` 底 + `ink-mute`，选中的 `ink` 底 + `face` 字（`pill`、高 26、无边无投影）；单选，点 `全部` 回到全部 → 截图里来源这一排没有抬起的键、没有槽、没有勾选框；每项有胶囊边界；选中前后各项不跳位。
- 勾选框（`Switch.tsx` 里的 `Checkbox`、`.ss-checkbox`，`src/pages/CheckMark.tsx` 共用）：~~16 方、`surface` 浅面~~ **14 方**、4 圆角、`paper` 白面 + 1px `ink-faint` 内环，勾上是墨底白勾 → 全应用勾选框量出来都是 14×14，勾上的是墨底白勾。（归档前改，2026-09-25）：2026-09-25 真机走查定 16 → 14、未勾改白面。
- `StateDot`：四种都 10px（无格 8×1.5），未加上是 1.3px `ink-mute` 环，无凹坑 → 与画板 V4 列的格子 2x 截图逐像素对齐（±1px）。
- `Tooltip`：墨底、`face` 字、`control` 7、`--elev-float` → 提示框上没有 `--elev-tip` 残留。
- `Toast` / `FloatingToast`：成功＝纸窗（`paper` + `hairline` 边 + 12 + `--elev-float`），失败＝同一种纸窗 + 左侧记号栏（⊘ / !）；读数改 12 tabular 不用 mono → 同时出一条成功与一条失败时两条都是浅色，只靠句首记号与否定动词分开；深色浮窗只有提示框（归档前改，2026-09-25）。
- `ErrorBanner`（灰面板）：`surface`、12 圆角、无边无投影、默认键紧凑 24 → 截图里灰面板与悬停行能靠圆角和内缩分开。
- `Confirm`：`paper` + `hairline` 边 + 12 + `--elev-float`，宽 384，标题 16/600、正文 15 `ink-mute`、键高 32，遮罩 `ink` 16% → 确认框正文不是 14px。
- `Spinner`：刻度扫过——14 宽 5 根 / 24 宽 7 根竖刻线，`ctl-border` 底、`ink` 亮格 + `ink-mute` 余晖，`steps` 一趟 0.8s；不含 `--accent`，不再有辐条、太阳 / 地球 / 轨道。
- `Cap`：恢复（2026-09-24 字体回到原设计）——按脚本切 run，只给拉丁 run 套 Condensed + 大写 + 字距，汉字 run 原样、字距 0；档位 `nav`（15 / 700 / 1.17px）、`label`（12 / 600 / 0.96px）、`head`（16 / 600 / 1.1px）→ 用在且只用在：页签 `SKILLS` `MCP`、侧栏区块小标 `AGENT`、MCP 列头第二行 `LOCAL` `PROJECT`、表格列头里的 agent 名、`AgentMark` 首字母；`grep -rn "uppercase" src` 只命中 `Cap` 的样式；`text-transform: lowercase` 在 src 里为空。
- `Tag`：弱标识改 `ink-mute` 400 → `ink-faint` 不再用于非计数的文字。
- `AgentMark`：首字母方块 14px、4 圆角、`ctl-border` 边、Condensed 大写字母（经 `Cap`）→ 与列头图标同高同中线。
- `SubPage`：整窗二级页随 D1 删除（设置、添加来源都只替换机面）→ 见「二 · 应用壳与侧栏」，这里不单独做。
- `Empty`：图不带框直接落在机面上 → 见「空态插图」一组的验收。

**应用壳（App.tsx / App.css）**
- 窗体底色 `shell`，删侧栏右线、侧栏底线（顶栏随 D1 整条删除）→ 截图里壳上没有任何 1px 线。
- 内容区包成一块机面（`face` + 1px `hairline` + 12 圆角 + 无投影），现值内缩 4 / 16 / 16 / 4 → 机面四角圆、四边有线、没有投影。
- 页签改为滑槽组件，`SKILLS` `MCP`（经 `Cap`，Condensed 15 / 700 / 1.17px，选中同重；D1 起在位置页页面头）：`surface` 槽（`tab-track` 10）+ `--recess-tabs`，选中滑块 `paper`（`control` 7）+ `--raise`（2026-09-24 物性）→ 选中滑块四周淡环、下沿柔影、没有描边与底边；按下即切，滑块 260ms `--spring-slide` 滑过去、停稳时无肉眼可见的回弹；切换前后页签字宽不变；拖不动。
- 侧栏项：15 `ink-mute`，选中 `face` 底 + `hairline` 环 + `ink` 600，悬停 `surface` → 选中项读作一小块机面。
- 侧栏字标用原资产 `assets/logo/wordmark.svg`（大写 `SOPHIA`、首字母左下重影），框高 26 → 在侧栏字标带（高 44）里垂直居中（窗口 y 37–63），主体 `S` 左沿 x 20、重影左沿 x 15（见「壳 › 字标在侧栏顶」）。
- 吸顶行与滚动渐隐的底色改 `face` → 滚动时吸顶行下面不露出别的颜色。

**矩阵 / DomainView / Skills / MCP（只动视觉，不动布局）**
- 列头：图标 / 名字 Condensed 12 / 600 `ink`、经 `Cap` 大写 + 0.96px（`CLAUDE CODE`）/ 计数 12 tabular `ink-faint`；表头底 1px `hairline`，删 2px 墨线 → `Matrix.css` 与 `McpTab.css` 里没有 `2px solid var(--ink)`。
- 行线 `row-line`、行带 `surface`（无列带，D23）、悬停光晕 22px `hairline` → 光晕在行带上仍看得见。
- 刚点亮反色：`ink` 底、点转 `face` → `tests/flash-keyframes.test.ts` 改断言 `--face` 后通过。
- `×2` 与各处计数改 12 tabular（不用 mono）→ 列头计数与 `×2` 字族都是 Barlow。
- MCP 列头第二行 `LOCAL` / `PROJECT`（经 `Cap`）；`传输` 列内容原样（`stdio` `HTTP`）→ 截图里大写单词只出现在页签、区块小标与列头。
- `McpDiffPanel`：展开区边界 1px `hairline`，值 mono 12，加粗标差异 → 没有墨色边线。

**模型 / 网关 / 托盘（只动视觉，不动布局）**
- Codex 页页面名 `title` Condensed 20 / 700、原样 `Codex`、字距 0，侧栏区块小标 `AGENT`（经 `Cap`）→ 截图里页面名不是大写、区块小标是大写。
- 模型片是白胶囊（`paper` + `hairline` 环、`ink` 字、无投影）+ ×，与来源筛选的灰胶囊不同样 → 并排截图里两者只差 ×。
- 网关行里的模型勾选列表：`paper` 面 + `hairline` 边 + 12 圆角（行内、不投影），组头 `ink-mute`，id 仍 mono `ink-faint` → 列表框没有投影。（汇总模型下拉随 D5 删除，行尾网关短名的断言随之删，见「二 · Codex 页」。）
- 启用开关换新 `Switch`（Codex 页与托盘）→ Codex 页开着时机面里只有这一处有橙（侧栏 `Codex` 后的指示点是另一处）。
- 网关区块（D5 起在 Codex 页里）：小标下 `hairline`、行线 `row-line`、表单输入框凹面 → 没有 `line` 之外的旧 token。
- 托盘面板：`paper` 底、1px `hairline`、12 圆角、无投影；菜单项悬停 `surface`、`control` 7 → `TrayPanel.css` 只引用 V4 token。

**来源 / 添加来源 / 设置（只动视觉，不动布局）**
- 来源管理页的来源行：底 1px `row-line`，紧凑开关，目标小框 `ctl-border` 边 → 没有 2px 墨线。
- 添加来源页：勾选框 14、`选择文件夹…` 默认键 32、`添加 N 个来源` 墨键 32、加不进来走带记号栏的纸窗（归档前改，2026-09-25） → 底部墨键抬起（`--raise-ink`）。
- 设置页：勾选框 14，未安装的名字 `ink-mute`，版本号 mono `ink-faint`，`检查更新` 默认键紧凑 → 未安装一节不用 `ink-faint` 写名字。

**空态插图（src/assets/empty-*.png）**
- 三张图按 V4 用色重出：猫身 #1C1C1A、须子与鼻头 #4E4E4A、眼白 #FFFFFF、文件夹描边 #1C1C1A 填 #FFFFFF、虚线文件夹 #4E4E4A、地线 #D4D4CF → 取样猫身、须子、地线像素值与 token 一致。
- 底透明（或恰为 #FCFCFB），不留白边 → 四角像素 alpha = 0 或 = #FCFCFB；放在机面上 1x、2x 截图看不出方框。
- 尺寸与 2x 规格不变（472×150、250×110）→ `Empty` 里图原样显示、不缩放。

**标志：字标、应用图标、托盘图标、字标动效**（2026-09-24 回到原设计：标志资产是品牌，不随 V4 token 换色）
- **保持原资产**：`assets/logo/*`（`wordmark.svg` `wordmark-inverse.svg` `mark.svg` `mark-inverse.svg` `app-icon.svg` `tray.svg` `README.md`）不改 → `git diff <V4 前的提交> -- assets/logo` 为空（大写 `S` / `SOPHIA`、Barlow Condensed 700 轮廓、重影在左下、错位字高的 (0.25, 0.093)、重合处浅一档；应用图标 824 圆角黑底板）。
- `src-tauri/icons/` 的应用图标与 `public/icon.svg` 由原 `app-icon.svg` 生成，托盘 `src-tauri/icons/tray.png` 由原 `tray.svg` 生成、**44×44**，命令照 `assets/logo/README.md` → 若 V4 期间已被重新生成，恢复成原资产生成的版本；`tray.png` 量出来 44×44、只有黑色 + alpha，`tray.rs` 仍是 `icon_as_template(true)`。
- 侧栏字标用 `assets/logo/wordmark.svg`（不用纯文本、不取 `currentColor`、不换色），高 26 → 截图里侧栏顶是大写 `SOPHIA`、首字母左下有灰影，主体 `S` 左沿 x 20。
- `src/brand/glassMark.ts` / `AnimatedWordmark.tsx`：前后遮挡回到 `S P I` 在猫后、`O H A` 在猫前；猫与裂纹取色读 `--ink` `--paper` `--ink-mute` `--ctl-border` `--ctl-edge`；字标高 26、碎片落在字标带下沿（窗口 y 72），命中区＝字标框含左下重影（见「壳 › 字标在侧栏顶」）→ `tests/glass-mark.test.ts` 按大写字母与左下重影改断言后通过，reduced-motion 下猫不出现。

**设计画板（.superpowers/design/*.dc.html + lint-artboards.mjs）**
- `lint-artboards.mjs` 的 `TOKENS` `FONTS` `RADII` `ELEV` 与 `lint-ui.mjs` 同步（最好抽成共享模块）→ 两处集合比较无差异（2026-09-24 物性后：`TOKENS` 14 个、`RADII` 六个、层次九个）。
- 在用画板＝`canvas.json` 里 `page-tone` 页上的画板（2026-09-24 起只有 `V4Layouts.dc.html`，它覆盖全部 15 屏）：V4 token、Barlow / Barlow Condensed、结构词 Condensed 大写 + 字距（只给拉丁 `span`）→ `node .superpowers/design/lint-artboards.mjs` 零报错。V4 之前的各屏画板移到 `page-archive`「V4 之前（历史，不再维护）」，不再逐张改——它们画的是被 D1–D14 取代的布局，改色改字也不会让它们变成现行规范（①）。
- `RamsDirections*.dc.html` 保留为探索板，移到 `page-2`「方向探索（已定）」；lint 只查 `page-tone`，不需要豁免名单 → `canvas.json` 里 `page-tone` 只剩 `V4Layouts.dc.html`。
- 画板里的字标与图标（`V4Layouts` 的侧栏字标、托盘图标，`Marks.dc.html`）一律是 `assets/logo/` 原资产的 SVG 内容 → 画板与 `assets/logo/` 同一份轮廓、同一组颜色。

**断言旧视觉的测试**
- `tests/ui.test.ts`：token 表（`#222222` 等）、Button「2px 描边」（按钮字 Barlow 13 / 600 仍对，保留）、主动作 hover 的 `--canvas` 描边、`is-on-dark`、`--radius-layer` / `--elev-tip` 的提示框与提示条、灰面板圆角 → 改成 V4 断言后通过。
- `tests/flash-keyframes.test.ts`：`--canvas` → `--face` → 通过。
- `tests/models-view.test.ts`：网关短名 `--ink-faint` → `--ink-mute` → 通过。
- `tests/glass-mark.test.ts`：字母回到大写 `S P I` / `O H A`、重影在左下，取色读 V4 token → 通过。
- 收口 → `grep -rn "#222222\|--canvas\|radius-layer\|elev-tip\|lowercase" tests src scripts` 与 `grep -rnw "Inter" tests src scripts` 都为空，`uppercase` 只命中 `Cap` 的样式，`make test` 全绿。

## 二、页面布局（2026-09-24 按 D1–D14 推导完成）

每条：做什么 → 怎么验。截图一律在 1100 × 720 默认窗口、1x 与 2x 各一次；「4 个长名 agent」指 `GitHub Copilot` `Kimi Code CLI` `Command Code` `Mistral Vibe`。

**应用壳与侧栏（`App.tsx` / `App.css`、`sidebarProjects.ts`、`src-tauri`）**
- 删顶栏（字标 + 页签 + 齿轮那一条 84 高）；侧栏 208 宽、全高，红绿灯行 28 留空 → 截图里没有横贯窗口的一条头；侧栏右沿 x 208，机面左沿紧贴它。
- 机面外距上 / 右 / 下 10、左 0，内边距 16 24 0 → 1100 宽时机面宽 882；四角 12 圆角、1px `hairline`、无投影。
- 侧栏三段：`AGENT`（区块小标，经 `Cap` 大写）、`项目`（带 `最近活跃 ▾`）、贴底 `设置` → 三段的项同高 34、同一种选中；全侧栏任何时候只有一项是选中态。
- `agent` 段只列有能力节的 agent → 今天只有 `Codex` 一项；没有灰着的 agent 项。
- 扩展点一：一张 agent 注册表（id、名字、图标、指示点条件、能力节列表）生成侧栏 `agent` 段、agent 页的节与托盘的块 → 往表里加一个只有一节的假 agent（测试里），三处同时出现，不改别的代码。
- 扩展点二：一张 domain 列表（今天 `skills` `mcp`）生成位置页页签、⌘1…⌘n 与应用菜单「显示」的项；落点记忆存 domain id → 测试里往列表加第三项，页签、快捷键、菜单项同时出现。
- `Codex` 后的 6px 橙点：第三方模型开着才画，关着不画 → 拨开关写成后，点与开关同为「配置里开着」；关着时侧栏没有任何灰点。
- `+ 项目` 是项目列表的最后一行（侧栏行的长相，不是键）→ 只有 `全局` 时它紧跟在 `全局` 下面、上面没有线；项目多到侧栏中段滚动时，它停在可见区底边、`设置` 上方，上沿出 1px `row-line`，滚到哪都看得见。
- 移除手动项目：悬停出 `×`，点了不确认，`×` 下浮起 `✓ 已移除 X · 撤销`（6 秒）→ `撤销` 后项目回到原来的排位；移除当前选中的项目后选中落到 `全局`；自动发现的项目悬停没有 `×`。
- 默认落点：首次启动 `全局 · skills`；之后记住侧栏选中项与 `skills ｜ mcp` → 清空本机记录后启动落在全局 skills；停在 Codex 页退出、再开仍在 Codex 页；记着的项目被移除后落 `全局`。
- `⌘,` 打开设置（应用菜单项 + 快捷键）→ 在任何页按 `⌘,` 机面换成设置、侧栏 `设置` 选中、侧栏仍在。
- 所有页面只替换机面：设置、添加来源不再盖满整窗 → 这两页里侧栏可见且可点；`SubPage` 整窗模式删除。
- 窗口最小 1100 × 560 不变 → `tauri.conf.json` 的 `minWidth` / `minHeight` 仍是这两个数。

**字标彩蛋（`src/brand/AnimatedWordmark.tsx` / `glassMark.ts`）**
- 字标（原资产 `wordmark.svg`）搬进侧栏字标带（高 44，框高 26、窗口 y 37–63，主体 `S` 左沿 x 20、重影左沿 x 15），黑猫与玻璃的全部行为保留 → 悬停 0.4 秒猫走进来；敲 2～4 下碎开，移开后碎片弹回、字标愈合；`tests/glass-mark.test.ts` 通过。
- 平时静止：不自动播放、不循环、首次启动不演示 → 启动后不碰字标 10 秒，性能面板里字标画布没有帧；reduced-motion 下悬停猫不出现、敲击不碎。
- 命中区＝字标框（含左下重影，窗口 x 15–109、y 37–63：重影左沿到 `A` 右沿 + 4）→ 在字标右侧 10px 处、红绿灯行里悬停 1 秒猫都不出现；红绿灯行仍能拖窗。
- 碎片地面＝字标带下沿（窗口 y 72），画布只盖 208 × 44（y 28–72）→ 碎开时碎片停在 `AGENT` 小标上方，没有一块越过 x 208 进机面、没有一块落到导航项上；碎开期间红绿灯照常可点。

**通用组件（`src/ui/*`）**
- 新增浅键 `button-quiet`，~~无底无边、静止态与纯文字无异；`text-decoration: underline` 只剩外链组件~~ （归档前改，2026-09-25）：外链并入浅键——静止是平贴的 `surface` 键面、`ink-mute` 13、高 24，末尾一律 10px `↗`，手靠近抬起 → 1x 截图里浅键静止是一小块浅灰键面；`grep -rn "text-decoration: underline" src` 为空。
- 离开 Sophia 的动作是浅键，末尾必带 10px `↗`（`打开 ↗` `在访达中显示 ↗` `去发布页 ↗` `打开目录 ↗` `在访达中显示备份 ↗`）→ `grep -rn "underline\|cursor: pointer" src` 为空。
- 应用内原文字链全部换掉：~~换成浅键~~ `取消`（选择行、网关表单）、提示条里的 `撤销` `查看`、`稍后`、`只留这份`、`恢复`、`清除筛选` 都是默认键（2026-09-25 起浅键只给离开 Sophia 的动作），`编辑` 是图标键（铅笔）→ 逐个在截图里确认没有下划线。（归档前改，2026-09-25）
- `Confirm` 的 `取消` 改默认键（`paper` + `--raise`），主动作墨键在右 → 确认框里两颗键都抬起，主次靠墨与纸分开。
- 页签滑槽只剩 `skills` `mcp` 两项，用在位置页页面头 → `grep -rn "模型" src/App.tsx` 里没有页签项。
- 选择行组件取代 `选择操作条`（见下「位置页」）→ `Matrix.tsx` 里不再有顶替工具行的选择条分支。

**位置页（`DomainView.tsx`、`Matrix.tsx` / `Matrix.css`、`SkillsTab.tsx`、`McpTab.tsx` / `McpTab.css`、`originFilter.ts`）**
- 页面头：左 `skills ｜ mcp` 滑槽，右定宽 200 筛选框（框内 `⌘F`）+ `+ 来源`；页面头右端 `管理来源` + `+ 来源` 并排（间距 8）→ 页面头高 34，右端两件的右沿 = 表格右沿；切 skills / mcp 时这两件的 x 坐标逐像素不变。
- 面板宽 776（34 + 246 + 120 + 4 × 88 + 24），Skills 与 MCP 相同 → 两页截图叠在一起，页面头、片、表头的左右沿重合；MCP 项目位置 5 列时名称列 158、面板宽仍 776。
- 表头结构线 y ≤ 180，第一行数据约 y 178 → 默认窗口截图量得到。
- 来源筛选：第一颗 `全部`、默认亮着；点一颗只看它（`全部` 灭），点 `全部` 回来；每颗来源胶囊带数；项上没有橙点（无论规则开关）。
- 位置页没有来源行：勾一个、几个来源，表头位置都不变 → 勾选来源时表格不下移；筛选行下没有路径、规则、`×`。
- 来源管理页规则：开关打开当场展开选目标浮层；开 / 关都不确认；规则关着时 `选目标 ▾` 禁用、按下说「先打开规则」 → 打开时浮层自动弹出；关掉后已建的链接一条不少。
- 来源管理页 `×`：锚定确认列出会撤掉的软链；原件在项目里的来源 `×` 禁用、按下即说原因 → 确认后这一行收起，`✓ 已移除` 浮在 `×` 原位下。
- ~~删来源管理页（skill 与 MCP 两页）与 `管理来源` 入口；`SourcesPage.tsx` 删除~~ （归档前改，2026-09-25）：2026-09-25「管理来源回到二级页」后，位置页页面头有 `管理来源`，按下推入来源管理页（`SourcesPage.tsx`），规则、移除只在那一页；位置页上没有来源行 → 按 `管理来源` 进来源管理页，`←` / Esc 滑回，表格的筛选、滚动、拉开的抽屉照旧。
- 选择行：勾了行后表头下插入 40 高 `surface` 带，名称列 `已选 N 个` + `取消`，来源列 `所有 agent` + 点，每个 agent 列正下方 ● / ○ → 点某列的点只改那一列；4 个长名 agent 时不折行；页面头与来源筛选在选择期间都还在。
- 选择行悬停光晕用 `track`、提示框列受影响的 skill；没有可改的格子时点 `ink-faint` 且按下即说原因 → 截图里光晕在 `surface` 带上看得见。
- 批量提示条锚在被按的点正下方 4、居中于该列 → 不盖住被按的点；靠右沿的列右对齐。
- 行首勾选框常驻、1px `ink-faint` 内环，手靠近抬起 → 58 行里没有一颗键被隐藏；环对机面对比度 ≥ 3:1。
- MCP：删 `传输` 列，点服务名就地展开 `传输` / `命令或地址` / `原件 + 打开 ↗` → MCP 表头里没有 `传输`；展开区左沿对齐名字。
- 空态五种按「位置页 › 空态」表：图、上距、文字、动作 → 逐一截图；`+ 来源` 不在任何空态里重复出现；「来源里还没有 skill」空态里有 `在访达中显示 ↗`（位置页没有来源行了）。
- 吸顶：页面头、来源筛选、列头、选择行 → 滚到底时这四样仍在原位，下面的行被 `face` 盖住、没有投影。

**添加来源（`AddSourcePage.tsx` / `AddSourcePanel.tsx`、`addSourceView.ts`）**
- 只替换机面，侧栏留着、当前位置仍选中；机面内从右推入、返回滑回 200ms → 添加期间侧栏可见；reduced-motion 下即时。
- 页面头 `←` + `添加来源到 CardBox`（`title` Condensed 20 / 700，原样、字距 0）；页面头下 18 是 `选择文件夹…`（默认键 32）+ 灰字 → `选择文件夹…` 在列表之上、不在页面头右端（D13）。
- 候选行：复选 22 ｜ ▸ 16 ｜ 两行内容，点整行展开四列 × 160 的 skill 名，勾选只归方框（命中区 28）→ 点名字不勾选；点方框不展开。
- 贴底 60 高、上 `hairline`，`添加 N 个来源` 墨键右对齐到 776；没勾时禁用并按下即说原因 → 列表滚动时贴底行不动。
- 加完一个滑回位置页、来源筛选选中它、筛选行下浮起 `✓ 已添加 …`；加了几个停在 `全部`、新行的格闪一下 → 表头位置不变，没有来源行出现。

**Codex 页（`ModelsTab.tsx` / `ModelsTab.css`、`ModelList.tsx`、`GatewayPage.tsx`、`modelsView.ts`）**
- 页面头：24px 图标 + `Codex`（`title` Condensed 20 / 700，原样、字距 0），右端空着 → 没有 `agent ｜ 生效模型` 表头、没有 `配置网关`、没有 `重启生效`。
- `第三方模型` 节头（`head` 16 / 600）+ 紧跟开关 + 16 + `重启生效` / `启动 Codex`（紧凑 24）；节头右端条件出 `卸下后台服务` → 拨完开关，下一步就在开关旁；重启确认锚在键下、左对齐键，`✓ 已生效` 浮在键原位下方、左对齐；`卸下后台服务` 只在开关关着且服务还装着时出现。
- 开关行为照「开关＝配置里开没开，拨了就写」：不确认、乐观翻转、没写成滑回并撤回、写成了按状态出 `重启生效`（Codex 在跑）/ `启动 Codex`（没在跑且开着）→ 四种情形（在跑 / 没在跑 × 打开 / 关掉）各走一遍，开关、侧栏橙点、托盘开关三处始终一致；只有点 `重启生效` 才出确认。
- `在用` + 模型片（白胶囊 + 细环、高 26、带 ×，不用墨）；开关关着时标签写 `已选`；没有 `103 ▾` → 页面上只有网关行里一种挑模型的控件；开关、待办条的键、`+ 网关`、行尾动作的右沿在同一条竖线上。
- 网关并进这一页：`网关` 小标 + `+ 网关`、一家一行、点整行展开挑模型（限制说明 → 440 宽勾选列表）、`编辑` 与 `+ 网关` 的表单就地展开 → 删 `GatewayPage.tsx` / `GatewayPage.css` 与 `配置网关` 入口，`grep -rn "配置网关\|Codex 的网关" src` 为空。
- 模型列表每个只列一家网关，行尾不写网关短名 → `tests/models-view.test.ts` 里跨网关短名的断言随汇总下拉删除，其余断言通过。
- 行内待办条（接管 / 重新写入 / 路由没在跑）挂在第三方模型节里、在用行下 → 不出现页级横幅。
- 没有网关：`还没有网关，先加一家`；开关禁用、按下即出原因；在用行不出 → 新装机首次打开 Codex 页截图对照。
- 离开页面时有没保存的网关表单 → 点侧栏别处、`⌘,` `⌘1`、应用菜单、托盘跳转都被拦下，行内出「地址改动没保存」+ `保存` / `丢弃` → `tests/shell-leave.test.ts`。

**设置（`SettingsPage.tsx` / `SettingsPage.css`、`AbsentAgents.tsx`）**
- 侧栏目的地，不再整窗替换；页面头 `设置` → 设置页里侧栏可见。
- `列表里的 agent · 最多 4 个` 三列、行高 36；`› 未安装的 32 个` 是一行展开（拉手在前），`恢复` 是默认键紧凑（未安装列表每行一颗） → 截图里没有下划线。
- 删「后台服务 · 使用中」一行 → `grep -rn "后台服务 · 使用中\|使用中" src/pages/SettingsPage.tsx` 为空。
- `关于`：`版本 0.1.0` + `检查更新`（默认键紧凑）；更新待办条在关于下 → 流程逐步截图。

**托盘（`TrayPanel.tsx` / `TrayPanel.css`、`trayView.ts`、`src-tauri/src/tray.rs`）**
- 一个 agent 一块（今天 Codex）：块头图标 + 名字、不放控件；块内 `第三方模型` 一行带开关；下一行在用的模型，名字之间 `、`，同名才加 ` · 网关短名`（放不下 `+N`，关着不出）→ 开着时看得到模型名，关着时这一行消失；块与行从 agent 注册表生成（托盘不自己写一份 Codex 名单）。
- 键位 `重启生效` / `启动 Codex` / `卸下后台服务` 同一位；拨开关直接写、不确认；重启确认在面板里展开、`取消` 是默认键 → 面板不出第二个窗口。
- 菜单只剩 `打开 Sophia` `退出`（`退出` 后不写 `⌘Q`），删 `设置` → 面板里没有 `设置`、没有 `⌘Q`。

**设计资产与测试**
- `V4Layouts.dc.html` 按本节改：侧栏小标 `模型` → `AGENT`；`第三方模型` 节头与开关；来源行的 `打开 ↗` 是浅键（~~浅键 / 外链区分~~，外链已并入浅键（归档前改，2026-09-25））；确认框 `取消` 默认键；托盘确认同；非 token 值（14px、8 圆角、26 高页签、`#e8e8e4` 等）改回 token → `node .superpowers/design/lint-artboards.mjs` 对它零报错。
- `scripts/lint-ui.mjs` 的 `accent-scope` 放宽到开关与指示点（`.led` / 侧栏 agent 点）→ 在按钮、文字、焦点环上用 `--accent` 仍报错。
- 收口 → `grep -rn "配置网关\|Codex 的网关\|选择操作条\|后台服务 · 使用中" src tests` 为空（~~`管理来源`~~ 已回到二级页，不在此列（归档前改，2026-09-25））；`make test` 全绿；`make dev` 里按上面每组走一遍并截图。

## 三、沿用旧设计审查（2026-09-24，D15–D24）

每条：做什么 → 怎么验。截图规格同「二」。

**应用菜单（D15；`src-tauri/src/lib.rs` 的菜单定义 + 前端命令）**
- 定义 `Sophia` `文件` `编辑` `显示` `窗口` 五个菜单，项与快捷键按「应用菜单」表 → 菜单栏里五个菜单齐全、没有 `帮助`；`⌘,` `⌘F` `⌘Z` `⌘A` `⌘1` `⌘2` `⌘[` 各按一次，效果与界面上对应入口完全相同。
- `设置…` `关于 Sophia` `检查更新…` 都落到侧栏的设置目的地（后两项停在「关于」，`检查更新…` 并开始检查）→ 不出现第二个窗口、不出现系统关于面板；版本号全应用只在设置「关于」一处。
- 菜单项的启用跟着界面走 → 没有可撤销的操作时 `撤销` 灰；不在位置页时 `筛选` 灰；不在添加来源页时 `返回` 灰；逐页打开菜单截图对照。
- `编辑` 菜单的剪切 / 拷贝 / 粘贴 / 全选在输入框里可用 → 筛选框、网关表单里 `⌘C` `⌘V` `⌘A` 作用于文字。

**拖窗区与红绿灯（D17；`App.tsx` / `App.css`、`tauri.conf.json`）**
- 红绿灯内缩到侧栏内边距（`trafficLightPosition`）→ 1x 截图量得第一颗左沿 x 20、圆心 y 15。
- 拖窗区按「壳 › 拖窗区」：红绿灯行、字标带空白、侧栏导航空白、机面上方 10 高的机壳、各页页面头空白处能拖；控件、字标框、页签、筛选框不能拖 → 逐处按住拖一次；页面头空白处双击按系统设置缩放；点任何控件都不带动窗口。

**右键菜单（D18）**
- skill / MCP 行、侧栏项目、来源项、网关行四处挂原生菜单，项按「右键菜单」表，不适用的不出 → 手动项目有 `从侧栏移除`、自动发现的项目没有右键菜单；只有同名行有 `只留这份…`；原件在项目里的来源项没有 `移除来源…`；格子、列头右键没有菜单。
- 每一项与界面入口是同一条命令 → `只留这份…` `移除来源…` `删掉…` 从菜单与从界面各做一次，确认框与结果提示条截图一致；右键前后勾选不变。

**禁用态（D20）**
- `borders.disabled` 改实线；禁用键、不可选片、禁用的 `+ 网关` 平贴（实线 `hairline`、无投影、按下不动）→ `grep -rn "dashed" src` 只剩链接失效的虚线环、没有目录的虚线列头与空态的虚线文件夹；lint 在按钮 / 片的禁用选择器里见到 `dashed` 报错。

**点状下划线（D21）**
- 删全部 `dotted` 下划线；`2 份不一样` 改浅键，`同名` `Codex 不支持` 改 `tag-weak` 纯文字（提示框照出）→ `grep -rn "dotted" src` 为空；截图里这三处没有装饰线，悬停 `2 份不一样` 出 `surface` 带、点它就地展开差异。

**格子记号（D22；`cellState.ts`、`mcpCellState.ts`、`cellTip.ts`、`StateDot`）**
- 删环内短横 ⊝，同名占位改画 ⊘，提示框 `Claude Code 里已有 WeiboAP 那份同名的 defuddle · 在这一行上只留一份` → 状态点组件里没有环内短横的分支；同名两行里被占的格截图是 ⊘；点它当即出这一句。

**光标、选取、列带（D23）**
- ~~`cursor: pointer` 只留在外链组件~~ 全应用没有 `cursor: pointer`（外链并入浅键，手形随下划线一起删除）（归档前改，2026-09-25） → `grep -rn "cursor: pointer" src` 为空；lint 拦截。
- 根上 `user-select: none`，路径 / id / 命令放开 → 在列头、行名、片、提示条上拖不出选区；来源行短路径、展开区原件路径、MCP 差异值、模型 id 能选中并 `⌘C`。
- 删格子悬停与列头悬停的列带，只留行带 → 悬停格子、列头时没有竖向 `surface` 带；22px 光晕在行带上看得见；悬停列头只出提示框。

**文案（D24）**
- 按「文案语域」表改全部界面字符串 → `grep -rn "写不进\|搬不过去\|连不上\|出来了\|探明\|顺手\|换一把\|拿主意\|没法\|来源管理页" src` 在界面字符串里为空（注释与标识符不算）；`lint-ui.mjs` 旧词表含这些词，写回去即报错。
- core `mcp::removal::ORIGINAL_MESSAGE`、前端 `src/cellTip.ts` 的 `MCP_OWN_TIP` 与 core 测试同一次改成新句 → 两处字符串逐字相同；`make test-core` 与 `make test-web` 通过。

**其余裁决（大小写、画板）**
- ~~agent 名是专名：位置页列头、选择行、MCP 列头第一行都写 `Claude Code` `Codex`；`text-transform: lowercase` 只作用于 `skills` `mcp` `agent` `local` `project`。~~（2026-09-24 被「字体与标志回到原设计」取代）现行：位置页列头与 MCP 列头第一行的 agent 名经 `Cap` 显示为 `CLAUDE CODE` `CODEX`；选择行、侧栏、页面名、设置、托盘写原样 `Claude Code` `Codex` → 截图里 agent 名的大写只出现在表格列头；src 里没有 `text-transform: lowercase`。
- 画板跟规范：`V4Layouts-feedback-confirm` 路径铭牌改凹面（本文件本来就写凹面）；`V4Layouts-tray` 删 `⌘Q`；`V4Layouts-mcp` 的 `2 份不一样` 改浅键；`V4Layouts-empty-source` 删空态里的 `打开目录 ↗`；主视图画板列头改原样大小写、删列带、禁用改平贴 → `node .superpowers/design/lint-artboards.mjs` 零报错，逐张与本文件对照。

**标志**：保持原资产（2026-09-24 回到原设计），验收见「一 · 标志」一组。
