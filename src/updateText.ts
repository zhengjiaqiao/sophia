import { t } from "./i18n.ts";

/// 网络不通、DNS、超时、TLS：检查更新与安装更新共用一组
const NETWORK_FAILURE =
  /network|connect|dns|timed? ?out|tls|certificate|offline|unreachable|error sending request/i;

/// 检查更新失败时给用户看的一句话（DESIGN「检查更新在应用里完成」）。
/// updater 插件的报错是英文原文，直接露出去既看不懂也不像产品的话：按几种常见原因归类，
/// 归不了类的才带上原文。纯逻辑，方便测试
export function updateCheckFailure(raw: string): string {
  const text = raw.replace(/^Error:\s*/i, "").trim();
  // 发布页上还没有更新清单（还没发过带签名的版本、或清单被删）
  if (/valid release JSON|404|Not Found/i.test(text)) return t("toast.updateCheck.noInfo");
  // 网络不通、DNS、超时、TLS
  if (NETWORK_FAILURE.test(text)) return t("toast.updateCheck.offline");
  return text ? t("toast.updateCheck.failedWith", { text }) : t("toast.updateCheck.failed");
}

/// 安装更新失败时给用户看的一句原因（设置「关于」的待办条，原文进 `详情`）。
/// 先认权限与校验（报错里常夹着别的字眼），网络那组正则与检查更新共用
export function updateInstallFailure(raw: string): string {
  const text = raw.replace(/^Error:\s*/i, "").trim();
  if (/permission denied|os error 13\b|os error 1\b|operation not permitted|EACCES/i.test(text))
    return t("settings.update.failedReason.permission");
  if (/signature|minisign|verif|public key/i.test(text))
    return t("settings.update.failedReason.verify");
  if (NETWORK_FAILURE.test(text)) return t("settings.update.failedReason.network");
  if (/no space left|os error 28\b/i.test(text)) return t("settings.update.failedReason.disk");
  return t("settings.update.failedReason.unknown");
}
