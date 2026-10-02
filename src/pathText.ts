/// 路径的显示写法（DESIGN「提示框」：路径一律把用户主目录写成 `~`）。
///
/// 主目录在应用启动时读一次（`loadHome()`，App 挂载时调用），之后 `displayPath` 同步可用；
/// 还没读到或读取失败时原样返回路径，不猜。只替换开头整段主目录，按路径分量比较：
/// `/Users/jia` 不会误伤 `/Users/jiaqiao/...`。

let home: string | null = null;

/// 测试与启动用：直接设定主目录（去掉末尾分隔符）
export function setHome(dir: string | null): void {
  home = dir ? dir.replace(/[\\/]+$/, "") : null;
}

export async function loadHome(): Promise<void> {
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    setHome(await homeDir());
  } catch {
    // 非 Tauri 环境（测试、浏览器预览）读不到：保持原样显示
  }
}

/// 提示框里的短路径：主目录写成 ~；超过四级时留开头两级与末两级、中段写 …
/// （`~/Library/…/agent_1776/skills`，与来源行「中段省略、末两级完整」同一个意思，只是不按宽度量）
export function shortPath(path: string): string {
  const shown = displayPath(path);
  const sep = shown.includes("\\") && !shown.includes("/") ? "\\" : "/";
  const parts = shown.split(sep);
  if (parts.length <= 5) return shown;
  return [...parts.slice(0, 2), "…", ...parts.slice(-2)].join(sep);
}

export function displayPath(path: string): string {
  if (!home) return path;
  if (path === home) return "~";
  for (const sep of ["/", "\\"]) {
    if (path.startsWith(home + sep)) return "~" + sep + path.slice(home.length + 1);
  }
  return path;
}

/// MCP「配置文件」列的写法（spec 2026-09-30-mcp-config-scope R1）：主目录写成 ~；项目里的文件写成
/// `~/…/<项目里的相对路径>`（项目名已在前一列：`~/…/.mcp.json`、`~/…/.codex/config.toml`）；别处超过两级的，
/// 中段省成 …、留文件名（`~/…/claude_desktop_config.json`）。完整路径在提示框里
export function configPathText(path: string, projectRoot?: string): string {
  const shown = displayPath(path);
  const sep = shown.includes("\\") && !shown.includes("/") ? "\\" : "/";
  if (projectRoot !== undefined) {
    const root = projectRoot.replace(/[\\/]+$/, "");
    for (const s of ["/", "\\"]) {
      if (!path.startsWith(root + s)) continue;
      const first = displayPath(root).split(sep)[0];
      return [first, "…", path.slice(root.length + 1)].join(sep);
    }
  }
  const parts = shown.split(sep);
  if (parts.length <= 3) return shown;
  return [parts[0], "…", parts[parts.length - 1]].join(sep);
}
