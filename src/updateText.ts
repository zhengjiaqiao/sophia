/// 检查更新失败时给用户看的一句话（DESIGN「检查更新在应用里完成」）。
/// updater 插件的报错是英文原文，直接露出去既看不懂也不像产品的话：按几种常见原因归类，
/// 归不了类的才带上原文。纯逻辑，方便测试
export function updateCheckFailure(raw: string): string {
  const text = raw.replace(/^Error:\s*/i, "").trim();
  // 发布页上还没有更新清单（还没发过带签名的版本、或清单被删）
  if (/valid release JSON|404|Not Found/i.test(text)) return "暂时没有可用的更新信息";
  // 网络不通、DNS、超时、TLS
  if (
    /network|connect|dns|timed? ?out|tls|certificate|offline|unreachable|error sending request/i.test(
      text,
    )
  )
    return "无法连接更新服务器，请检查网络";
  return text ? `检查更新失败：${text}` : "检查更新失败";
}
