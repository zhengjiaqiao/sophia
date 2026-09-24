/// 展示组件库：只吃 props，不碰 api，不含业务逻辑。
/// 实现依据是 docs/DESIGN.md（视觉 V4），视觉对照是 V4 画板。
/// 样式与 token 在这里一次性引进来，用组件的页面不必自己 import css。
import "./ui.css";

export { StateDot, DupMark, DOT_LABEL } from "./StateDot.tsx";
export type { Dot, StateDotProps, DupMarkProps } from "./StateDot.tsx";

export { Button, IconButton, AddButton } from "./Button.tsx";
export type {
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  IconButtonProps,
  AddButtonProps,
} from "./Button.tsx";

export { Switch, Checkbox, CheckboxGlyph, Indicator } from "./Switch.tsx";
export type { SwitchProps, SwitchSize, CheckboxProps, IndicatorProps } from "./Switch.tsx";

export { Tabs } from "./Tabs.tsx";
export type { TabItem, TabsProps } from "./Tabs.tsx";

export { Chip, ModelChip } from "./Chip.tsx";
export type { ChipProps, ModelChipProps } from "./Chip.tsx";

export { Tag } from "./Tag.tsx";
export type { TagProps } from "./Tag.tsx";

export {
  Tooltip,
  ReasonTip,
  TruncTip,
  isClipped,
  TIP_DELAY_MS,
  PINNED_TIP_MS,
  TIP_IDLE,
  nextTip,
  tipCeiling,
} from "./Tooltip.tsx";
export type { TipEvent, TipState, TooltipProps } from "./Tooltip.tsx";

export { BUSY_DELAY_MS, BusySlot, Spinner, useBusyShown } from "./Spinner.tsx";
export type { BusySlotProps, SpinnerProps } from "./Spinner.tsx";

export { Toast, ToastCount, TOAST_DWELL_MS, CELL_TOAST_DWELL_MS } from "./Toast.tsx";

export { CornerToast, FloatingToast, ToastHost, ToastStack } from "./FloatingToast.tsx";
export type { FloatingToastProps } from "./FloatingToast.tsx";
export type { ToastAction, ToastAgent, ToastKind, ToastProps } from "./Toast.tsx";

export { ErrorBanner, NoticePanel } from "./ErrorBanner.tsx";
export type { ErrorBannerProps, NoticePanelAction, NoticePanelProps } from "./ErrorBanner.tsx";

export { Confirm } from "./Confirm.tsx";
export type { ConfirmAnchor, ConfirmProps } from "./Confirm.tsx";

export { SubPage } from "./SubPage.tsx";
export type { SubPageProps } from "./SubPage.tsx";

export { AgentIcon, AgentMark, agentInitial, hasAgentIcon } from "./AgentMark.tsx";
export type { AgentIconProps, AgentMarkProps } from "./AgentMark.tsx";

export {
  IconArrowLeft,
  IconAttention,
  IconCannot,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconEdit,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
} from "./icons.tsx";
export type { IconProps } from "./icons.tsx";

export { Empty } from "./Empty.tsx";
export type { EmptyAction, EmptyArt, EmptyKind, EmptyProps } from "./Empty.tsx";
