/// 延迟提交：可撤销的删除（只留这份、替换现有的、删原件）先挂起，界面上当它已经发生；
/// 提示条到期、被关掉、离开页面或窗口关闭时才真正执行。撤销 = 丢掉挂起的提交，什么都没发生。
/// 同一个 key 再挂一次会先提交旧的。窗口关闭时 App 调 `flushAll()`，保证退出前不丢删除。
///
/// 用法：
///   const d = defer(`keep:${name}`, () => api.deleteSource(planId));
///   <Toast action={{ label: "撤销", onClick: d.undo }} onDismiss={() => void d.commit()} />

type Commit = () => Promise<unknown>;

const pending = new Map<string, Commit>();

export interface Deferred {
  /// 真正执行；已提交或已撤销时什么都不做
  commit(): Promise<void>;
  /// 丢掉挂起的提交
  undo(): void;
  /// 还挂着没提交也没撤销
  isPending(): boolean;
}

export function defer(key: string, run: Commit): Deferred {
  const previous = pending.get(key);
  if (previous) {
    pending.delete(key);
    void previous();
  }
  pending.set(key, run);
  const mine = () => pending.get(key) === run;
  return {
    async commit() {
      if (!mine()) return;
      pending.delete(key);
      await run();
    },
    undo() {
      if (mine()) pending.delete(key);
    },
    isPending: mine,
  };
}

/// 提交全部挂起的删除；单个失败不影响其余，返回失败的原因
export async function flushAll(): Promise<string[]> {
  const runs = [...pending.values()];
  pending.clear();
  const results = await Promise.allSettled(runs.map((run) => run()));
  return results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
}

export function pendingCount(): number {
  return pending.size;
}
