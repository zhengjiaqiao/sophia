/// 下载函数（spec R18、R19）：永远跳到最新版 .dmg；国内访客且配了 COS 基址、COS 上也有这个文件时跳 COS 上的同名文件，否则 GitHub。
/// COS 上的布局照 GitHub：<基址>/v<版本>/<文件>，由发版流水线传上去（packaging/cos-manifest.mjs）
const REPO = "https://github.com/zhengjiaqiao/sophia";

/// Tauri 更新清单的稳定地址（`version` 不带 v）；不走 GitHub API，免得吃匿名限流
export const MANIFEST_URL = `${REPO}/releases/latest/download/latest.json`;
/// 清单读不到时的退路
export const RELEASES_LATEST = `${REPO}/releases/latest`;

export interface DownloadEnv {
  /// 腾讯云 COS 桶的基址（#187 配进 Pages 的环境变量；不带版本目录，如 https://<桶>.cos.<地域>.myqcloud.com）；没配就不分流
  COS_BASE_URL?: string;
}

const DMG_ARCH = { arm64: "aarch64", x64: "x64" } as const;
/// 版本号只认 x.y.z[-预发布]，清单被改坏也拼不出奇怪的跳转地址
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function handleDownload(
  request: Request,
  env: DownloadEnv,
  country: string | undefined,
  getVersion: () => Promise<string | null>,
  /// COS 上有没有这个文件（探测在 _lib/cos.ts，带缓存）；读不到就当没有，改走 GitHub（R19）
  cosHas: (url: string) => Promise<boolean>,
): Promise<Response> {
  // 重定向本身不缓存：缓存只在清单上，这样 CN 与非 CN、两种芯片不会互相串
  const redirect = (location: string) =>
    new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });

  const version = await getVersion();
  if (!version || !VERSION_RE.test(version)) return redirect(RELEASES_LATEST);

  const arch = new URL(request.url).searchParams.get("arch") === "x64" ? "x64" : "arm64";
  const file = `Sophia_${version}_${DMG_ARCH[arch]}.dmg`;
  const cos = env.COS_BASE_URL?.trim().replace(/\/+$/, "");
  if (country === "CN" && cos) {
    const cosFile = `${cos}/v${version}/${file}`;
    if (await cosHas(cosFile)) return redirect(cosFile);
  }
  return redirect(`${REPO}/releases/download/v${version}/${file}`);
}
