/// 顶栏语言菜单的状态机（spec R5）：点击与悬停都能打开；鼠标离开 0.2 秒后收起（留出从键挪到菜单的时间）；
/// 悬停打开后再点一下不收起；Esc 收起并把焦点还给键；触屏（touch / pen）只认点击。
/// 不碰 DOM：定时器与「焦点还给键」由调用方注入，DOM 接线在 Header.astro 的脚本里。

/// 鼠标离开后多久收起
export const LEAVE_DELAY_MS = 200;

export interface MenuTimer {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface LangMenuDeps {
  timer: MenuTimer;
  onChange: (open: boolean) => void;
  focusButton: () => void;
}

export class LangMenu {
  private isOpen = false;
  private byHover = false;
  private leaveTimer: number | null = null;

  private readonly deps: LangMenuDeps;

  constructor(deps: LangMenuDeps) {
    this.deps = deps;
  }

  get open(): boolean {
    return this.isOpen;
  }

  click(): void {
    this.cancelLeave();
    if (this.isOpen && this.byHover) {
      // 悬停已经把它打开了，这一下点击只是「确认」：不收起
      this.byHover = false;
      return;
    }
    this.set(!this.isOpen);
  }

  pointerEnter(type: string): void {
    if (type !== "mouse") return;
    this.cancelLeave();
    if (!this.isOpen) this.byHover = true;
    this.set(true);
  }

  pointerLeave(type: string): void {
    if (type !== "mouse") return;
    this.cancelLeave();
    this.leaveTimer = this.deps.timer.set(() => {
      this.leaveTimer = null;
      this.set(false);
    }, LEAVE_DELAY_MS);
  }

  escape(): void {
    if (!this.isOpen) return;
    this.cancelLeave();
    this.set(false);
    this.deps.focusButton();
  }

  outsideClick(): void {
    this.cancelLeave();
    this.set(false);
  }

  /// 选了一种语言（页面随后跳转）
  select(): void {
    this.cancelLeave();
    this.set(false);
  }

  private set(open: boolean): void {
    if (!open) this.byHover = false;
    if (open === this.isOpen) return;
    this.isOpen = open;
    this.deps.onChange(open);
  }

  private cancelLeave(): void {
    if (this.leaveTimer !== null) this.deps.timer.clear(this.leaveTimer);
    this.leaveTimer = null;
  }
}
