/// 设置页存一项、再重读真值（界面以落盘结果为准）。纯逻辑，方便测试
///
/// 保存失败已经报了「设置保存失败」（两层：原文在「!」里、带「再试一次」，spec #239）；紧跟着的重读再失败
/// 不另报——另报会用一段没有失败句的原文盖掉那条横幅，「再试一次」也跟着丢了（#288 复审）。
/// 保存成功、重读失败时照常报重读的错
export async function saveThenReload(steps: {
  save: () => Promise<void>;
  reload: () => Promise<void>;
  saveFailed: (error: unknown) => void;
  reloadFailed: (error: unknown) => void;
}): Promise<void> {
  let saved = true;
  try {
    await steps.save();
  } catch (e) {
    saved = false;
    steps.saveFailed(e);
  }
  try {
    await steps.reload();
  } catch (e) {
    if (saved) steps.reloadFailed(e);
  }
}
