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

export function displayPath(path: string): string {
  if (!home) return path;
  if (path === home) return "~";
  for (const sep of ["/", "\\"]) {
    if (path.startsWith(home + sep)) return "~" + sep + path.slice(home.length + 1);
  }
  return path;
}
