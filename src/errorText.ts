/// 一个抛出值的技术原文（详情与日志共用，不进界面文案）。
/// WebKit 的 `error.stack` 只有调用栈、没有 `Name: message` 那一行（V8 有），所以先写 `Name: message`，
/// 再接调用栈；栈本来就以它开头的不重复。
/// **全函数，不抛**：它在出错页和日志里用，自己再抛就没人接了——字段不是字符串、读取时抛错都兜住
export function errorText(value: unknown): string {
  try {
    if (value instanceof Error) {
      const head = `${String(value.name)}: ${String(value.message)}`;
      const raw = value.stack;
      const stack = (typeof raw === "string" ? raw : raw == null ? "" : String(raw)).trim();
      if (!stack) return head;
      return stack.startsWith(head) ? stack : `${head}\n${stack}`;
    }
    if (typeof value === "object" && value !== null) {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    }
    return String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "(unprintable)";
    }
  }
}
