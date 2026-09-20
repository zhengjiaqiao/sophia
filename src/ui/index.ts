/// 展示组件库：只吃 props，不碰 api，不含业务逻辑。
/// 实现依据是 docs/specs/2026-09-21-ui-components.md，与画稿不一致时以它为准。
/// 样式与 token 在这里一次性引进来，用组件的页面不必自己 import css。
import "./ui.css";

export { StateDot } from "./StateDot.tsx";
export type { Dot, StateDotProps } from "./StateDot.tsx";

export { Button } from "./Button.tsx";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button.tsx";

export { Chip } from "./Chip.tsx";
export type { ChipProps } from "./Chip.tsx";

export { Toast, TOAST_DWELL_MS } from "./Toast.tsx";
export type { ToastAction, ToastKind, ToastProps } from "./Toast.tsx";

export { ErrorBanner } from "./ErrorBanner.tsx";
export type { ErrorBannerProps } from "./ErrorBanner.tsx";

export { Confirm } from "./Confirm.tsx";
export type { ConfirmProps } from "./Confirm.tsx";

export { SubPage } from "./SubPage.tsx";
export type { SubPageProps } from "./SubPage.tsx";

export { RowNotice } from "./RowNotice.tsx";
export type { RowNoticeAction, RowNoticeProps } from "./RowNotice.tsx";

export { AgentIcon, AgentLamp, AgentMark, agentInitial, hasAgentIcon } from "./AgentMark.tsx";
export type { AgentIconProps, AgentLampProps, AgentMarkProps, LampState } from "./AgentMark.tsx";

export { Busy, Empty } from "./Empty.tsx";
export type { BusyProps, EmptyAction, EmptyKind, EmptyProps } from "./Empty.tsx";
