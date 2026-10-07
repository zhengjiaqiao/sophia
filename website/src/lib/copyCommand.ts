/// 「复制」键的逻辑：能写剪贴板就写，写不进就把命令选中，让访客自己按 ⌘C。
/// 返回 copied（已写入）或 manual（已选中、请手动复制），页面据此换键上的字。
export type CopyResult = "copied" | "manual";

export async function copyCommand(
  text: string,
  io: { writeText?: (t: string) => Promise<void>; select: () => void },
): Promise<CopyResult> {
  try {
    if (io.writeText) {
      await io.writeText(text);
      return "copied";
    }
  } catch {
    // 被拒绝（权限、非安全上下文）：落到下面选中命令
  }
  io.select();
  return "manual";
}
