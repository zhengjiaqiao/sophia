/**
 * 模型勾选的写盘队列（DESIGN「勾选不闪」）：勾选、取消、点 `×` 先按用户的操作画出来，写盘在后台完成。
 * **不锁页、不置忙碌、不重读整页**——勾一下是例行操作；成功不出提示，片的增减本身就是反馈。
 *
 * - 写盘排成一队、一次一个：连点不抢跑，后端收到的顺序就是点的顺序
 * - 还有没写完的勾选时，别处读回来的状态（焦点重读、轮询、别的操作的结果）只记下、不画——
 *   否则片会跳回旧样子再跳回来，这正是「闪」
 * - 写失败：先回滚到后端上次给的状态，再读一次后端此刻的实际状态；排在它后面、还没开始写的
 *   勾选是在已回滚的画面上点的，一并作废
 *
 * 不依赖 React：页面把「画」「报给壳」「重读」这几件事交进来。
 */
export interface SelectionWriterIo<S> {
  /// 画到页面上（乐观状态与后端状态都走这里）
  paint: (state: S) => void;
  /// 每一份后端给的状态都报一声（壳拿它更新侧栏 Codex 后的指示点）
  report: (state: S) => void;
  /// 写失败后读后端此刻的实际状态
  reread: () => Promise<S>;
  /// 一次写成功（页面据此收起行下失败面板）
  onDone: () => void;
  /// 一次写失败：`message` 是调用方给的整句，`error` 原样交回
  onFail: (message: string, error: unknown) => void;
  /// 页面还在不在；不在了只把队列走完，不再碰界面
  alive: () => boolean;
}

export interface SelectionWriter<S> {
  /// 后端给的状态：记下、报给壳；没有还在写的勾选才画上去
  accept: (state: S) => void;
  /// 先画 `next`，再排队执行 `commit`；失败时说 `message`
  write: (message: string, next: S, commit: () => Promise<S>) => void;
  /// 等到此刻排着的写盘都结束（开关这类也写 Codex 设置的操作排在它们后面）
  idle: () => Promise<void>;
}

export function createSelectionWriter<S>(io: SelectionWriterIo<S>): SelectionWriter<S> {
  let confirmed: S | null = null;
  /// 这一轮还没写完的勾选数
  let pending = 0;
  /// 写失败一次翻一轮：旧一轮里还没开始写的作废
  let round = 0;
  let queue: Promise<void> = Promise.resolve();

  const accept = (state: S) => {
    confirmed = state;
    io.report(state);
    if (pending === 0) io.paint(state);
  };

  const write = (message: string, next: S, commit: () => Promise<S>) => {
    io.paint(next);
    pending += 1;
    const mine = round;
    queue = queue.then(async () => {
      if (mine !== round) return;
      try {
        const fresh = await commit();
        pending -= 1;
        if (!io.alive()) return;
        accept(fresh);
        io.onDone();
      } catch (error) {
        round += 1;
        pending = 0;
        if (!io.alive()) return;
        if (confirmed !== null) io.paint(confirmed);
        io.onFail(message, error);
        // 一次写可能做了一半（例如已关掉网关、勾选还没清）：以后端此刻的实际状态为准
        try {
          const actual = await io.reread();
          if (io.alive()) accept(actual);
        } catch {
          // 读不到就停在上次拿到的状态；下一次焦点或操作还会再读
        }
      }
    });
  };

  return { accept, write, idle: () => queue };
}
