/// 模型状态的读与写的先后（走查连拍 fly/f08）。勾选、排序、开关都是先画成做成之后的样子（乐观更新）再写；
/// 同时还有后台轻查（壳的「gateway-changed」、`重启生效` / `启动 Codex` 显示着时每 5 秒一次）。一次轻查要是在写之前
/// 发出、写之后才回来，它拿到的是写之前的状态，交给页面就把乐观更新盖回去一帧。
///
/// 规则（只在本窗口里排先后；菜单栏面板另有一份）：
/// - **读**：手上有写在路上就先等它们落地；读的过程中又有新的写开始，这一份作废、等落地后重读
/// - **写**：照常交出自己的结果；要是它回来时已经有更晚的写开始了（连着勾了两下），它那份不含后一下，
///   换成都落地之后重读的一份
///
/// 只排先后，不缓存、不合并：读写各自还是一条命令
export interface GatewayGate {
  read<T>(job: () => Promise<T>): Promise<T>;
  write<T>(job: () => Promise<T>, reread: () => Promise<T>): Promise<T>;
}

export function createGatewayGate(): GatewayGate {
  /// 开始过的写的个数：读前读后比一比，就知道中间有没有写开始
  let started = 0;
  /// 还在路上的写
  let inflight = 0;
  let waiting: Array<() => void> = [];

  const settled = (): Promise<void> =>
    inflight === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve));

  const read = async <T>(job: () => Promise<T>): Promise<T> => {
    for (;;) {
      await settled();
      const mark = started;
      const value = await job();
      if (started === mark) return value;
    }
  };

  const write = async <T>(job: () => Promise<T>, reread: () => Promise<T>): Promise<T> => {
    started += 1;
    const mine = started;
    inflight += 1;
    let value: T;
    try {
      value = await job();
    } finally {
      inflight -= 1;
      if (inflight === 0) {
        const wake = waiting;
        waiting = [];
        wake.forEach((resolve) => resolve());
      }
    }
    return started === mine ? value : read(reread);
  };

  return { read, write };
}
