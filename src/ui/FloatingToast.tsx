import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeToast, type AnchorRect, type ToastAlign } from "../layerPlace.ts";

/// 浮起小窗的两种位置（DESIGN「反馈的两种形态 › 浮起小窗的位置」），全应用只有这两套：
///
/// - `FloatingToast`：锚在触发它的地方——被点那一格 / 那一行 / 那颗键正下方 4，
///   不盖住被点的控件，也不盖住它所说的那一格 / 那一行（`placeToast`）。
///   写法：把它放在锚点元素**里面**（它自己只留一个不占位的探针），默认锚点就是探针的父元素；
///   行这类要「整行的上下沿 + 名字的左沿」的，用 `anchor` 从探针找。
///   **出现的那一刻定位一次，之后钉在窗口上**（产品负责人：新提示不应该随页面滑动）：
///   浮层走 portal 挂到 body、fixed 定位，不跟着滚动、不被滚动容器裁掉；锚点滚走了它也留在原处，
///   到点淡出；改窗口大小也不挪。锚点在出现那一刻不在窗口里、或被二级页盖住（inert）时不出现
/// - `CornerToast`：不属于任何一处的（后台自动规则、新问题一次性提示、后台 MCP）：
///   右下，壳上一处 `ToastStack`，主视图不再另有一套
///
/// 各页不再自写 absolute / fixed 偏移。换一条内容就是新出现一次：调用方换 `key`。

export interface FloatingToastProps {
  children: ReactNode;
  /// 水平对齐（见 `ToastAlign`）；默认居中于锚点（单格）
  align?: ToastAlign;
  /// 从探针找锚点：返回元素或矩形。不给就是探针的父元素
  anchor?: (probe: HTMLElement) => Element | AnchorRect | null | undefined;
  /// 水平夹在哪个元素的左右沿之内（面板）；不给就是窗口
  bounds?: (probe: HTMLElement) => Element | null | undefined;
}

const rectOf = (target: Element | AnchorRect): AnchorRect => {
  if (!(target instanceof Element)) return target;
  const r = target.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
};

type Placed = { top: number; left: number } | "hidden";

export function FloatingToast({ children, align = "center", anchor, bounds }: FloatingToastProps) {
  const probeRef = useRef<HTMLSpanElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  // 首帧（含服务端渲染）先就地画出来；挂上之后搬进 body，在那里量尺寸、定位
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  // 主视图被二级页盖住（#root 加了 inert）时藏起来，二级页收起再露出来
  const [covered, setCovered] = useState(false);

  useLayoutEffect(() => setHost(document.body), []);

  // 出现的那一刻定位一次（只量这一次，之后不跟滚动、不跟改窗口大小）
  useLayoutEffect(() => {
    const probe = probeRef.current;
    const layer = layerRef.current;
    if (!probe || !layer || !host || placed !== null) return;
    // 锚点此刻被二级页盖着（加完来源、二级页还在滑回）：先不定，等盖着的那一层收起再量——
    // 在这里判成「不出现」的话，滑回之后这一窗就永远看不见了（产品负责人：根本看不见）
    if (covered || probe.closest("[inert]")) return;
    const target = anchor ? anchor(probe) : probe.parentElement;
    if (!target) {
      setPlaced("hidden");
      return;
    }
    const a = rectOf(target);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 锚点此刻不在窗口里（滚走了、被筛掉了）：不出现，不浮在别处
    if (a.bottom <= 0 || a.top >= vh || (a.top === a.bottom && a.left === a.right && a.top === 0)) {
      setPlaced("hidden");
      return;
    }
    const b = bounds?.(probe);
    const box = b ? b.getBoundingClientRect() : null;
    const p = placeToast(
      a,
      { width: layer.offsetWidth, height: layer.offsetHeight },
      { width: vw, height: vh },
      { align, bounds: box ? { left: box.left, right: box.right } : undefined },
    );
    setPlaced({ top: p.top, left: p.left });
  }, [host, placed, anchor, bounds, align, covered]);

  useEffect(() => {
    const probe = probeRef.current;
    if (!host || !probe || typeof MutationObserver === "undefined") return;
    const check = () => setCovered(probe.closest("[inert]") !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["inert"],
      subtree: true,
    });
    return () => observer.disconnect();
  }, [host]);

  const shown = placed !== null && placed !== "hidden" && !covered;
  const layer = (
    <div
      ref={layerRef}
      className="ss-floattoast"
      style={
        shown && typeof placed === "object"
          ? { top: placed.top, left: placed.left }
          : { visibility: "hidden" }
      }
    >
      {children}
    </div>
  );
  return (
    <>
      <span ref={probeRef} className="ss-floattoast__probe" hidden />
      {host ? createPortal(layer, host) : layer}
    </>
  );
}

// ===== 右下：全应用一套 =====

const HostContext = createContext<{
  el: HTMLElement | null;
  setEl: (el: HTMLElement | null) => void;
} | null>(null);

/// 壳在最外层包一次：右下那一叠提示小窗挂在哪
export function ToastHost({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ el, setEl }), [el]);
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

/// 右下那一叠（壳上一处）：右沿对齐内容区右沿、底 16，新的在下面。
/// `children` 是壳自己的（新问题一次性提示、后台 MCP），各页经 `CornerToast` 挂进来
export function ToastStack({ className, children }: { className: string; children?: ReactNode }) {
  // setEl 是 useState 的，身份不变：ref 只在挂上 / 卸下时各叫一次
  const setEl = useContext(HostContext)?.setEl;
  return (
    <div className={className}>
      {children}
      <div className="ss-toaststack__slot" ref={setEl} />
    </div>
  );
}

/// 不属于任何一处的提示小窗：挂到壳右下那一叠里（没有壳时就地画，测试与菜单栏面板）
export function CornerToast({ children }: { children: ReactNode }) {
  const host = useContext(HostContext);
  if (host?.el) return createPortal(children, host.el);
  return host ? null : <>{children}</>;
}
