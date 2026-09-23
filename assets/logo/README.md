# Logo

一个 S，左下方带一重灰色重影，主体与重影重合处用更浅的一档灰——寓意复制。
扁平：没有渐变、阴影和透明度，三档灰都取自 `docs/DESIGN.md` 的灰阶。

S 的字形取自 Barlow Condensed 700（界面 wordmark 用的同一款字，SIL OFL 1.1），
是从字体文件里取出的轮廓，不是照着描的，所以图标的 S 和字标的 S 是同一个字。

| 文件 | 用途 |
|---|---|
| `app-icon.svg` | 应用图标的源文件：1024 画布，824 的圆角方形黑底板，四周留透明边 |
| `mark.svg` / `mark-inverse.svg` | 纯标志，透明底；白底用前者，黑底用后者 |
| `wordmark.svg` / `wordmark-inverse.svg` | 整条 SOPHIA 字标，首字母带同样的重影，字距按规范的 0.095em |
| `tray.svg` | 菜单栏托盘图标的源文件：主体实心、重影 45% 半透明，纯黑透明底 |

构图：错位是字高的 (0.25, 0.093)，重影在左下；主体与重影的整体外框在底板上居中。

## 重新生成整套图标

改了 `app-icon.svg` 之后：

```bash
npx tauri icon assets/logo/app-icon.svg
```

它会重写 `src-tauri/icons/`。仓库只收桌面端用到的那几个文件，
生成出来的 `android/`、`ios/` 和 `64x64.png` 不提交。
同时把 `app-icon.svg` 复制一份到 `public/icon.svg`（网页图标）。

## 重新生成托盘图标

托盘图标是 macOS 的**模板图**（`icon_as_template(true)`）：系统按菜单栏深浅自己着色，
颜色用不上，但**透明度保留**（2026-09-23 用 AppKit 离屏绘制验证过）——所以重影可以是半透明的。
试过三版都不好：只留主体 S（重影没了就不像这个标志）；把主体加粗一圈从重影上挖出缝隙
（缝隙贴着主体轮廓走，小尺寸下像把字描歪了）；重影只留轮廓（菜单栏尺寸下轮廓断成一圈毛边，
读成两个 S 并排）。**现在这版**：主体实心，重影填 45% 垫在左下，和应用图标同一构成。
标志里「重合处浅一档」这里不做——两个 S 错开得少，重合处占了主体的三分之二，16pt 下主体会读成一截碎片。
错位加到标志的 1.6 倍：按原比例，16pt 下重影只露出一道窄边，读成字边发虚；2.4 倍又分成「SS」两个字母。
取景用两个 S 的整体外框居中、高占 93%；旧版 600 见方的取景把上下各裁掉了一截。
改了它之后：

```bash
npx tauri icon assets/logo/tray.svg -o /tmp/tray-icons
cp /tmp/tray-icons/Square44x44Logo.png src-tauri/icons/tray.png
```

44×44 就是菜单栏 22pt 的 2x。`/tmp/tray-icons` 里其余的都不要，别覆盖 `src-tauri/icons/` 里的应用图标。
