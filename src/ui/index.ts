/// 展示组件库：只吃 props，不碰 api，不含业务逻辑。
/// 实现依据是 docs/DESIGN.md（视觉 V4），视觉对照是 V4 画板；每个组件的活样张在 `src/ui/gallery/`（`npm run gallery`）。
/// 样式与 token 在这里一次性引进来，用组件的页面不必自己 import css。
import "./ui.css";

// ---- 键 ----
export { Button, IconButton, AddButton } from "./Button.tsx";
export type {
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  IconButtonProps,
  AddButtonProps,
} from "./Button.tsx";

// ---- 提示与反馈 ----
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

export { Toast, ToastCount, TOAST_DWELL_MS, CELL_TOAST_DWELL_MS } from "./Toast.tsx";
export type { ToastAction, ToastAgent, ToastBusyProps, ToastKind, ToastProps } from "./Toast.tsx";
export { CornerToast, FloatingToast, ToastHost, ToastStack } from "./FloatingToast.tsx";
export type { FloatingToastProps } from "./FloatingToast.tsx";

export { NoticePanel } from "./NoticePanel.tsx";
export type { NoticePanelAction, NoticePanelProps, NoticeScope } from "./NoticePanel.tsx";
/// 转接层：已并进 `NoticePanel scope="app"`，页面迁移完删
export { ErrorBanner } from "./ErrorBanner.tsx";
export type { ErrorBannerProps } from "./ErrorBanner.tsx";

export { HintStrip } from "./HintStrip.tsx";
export type { HintStripProps } from "./HintStrip.tsx";

export { Confirm } from "./Confirm.tsx";
export type { ConfirmAnchor, ConfirmProps } from "./Confirm.tsx";

export { BUSY_DELAY_MS, Spinner, SWEEP, useBusyShown } from "./Spinner.tsx";
export type { SpinnerProps } from "./Spinner.tsx";
export { BusySlot, BusyToast } from "./BusySlot.tsx";
export type { BusyMode, BusySlotProps } from "./BusySlot.tsx";

// ---- 选择 ----
export { Switch, Checkbox, CheckboxGlyph, Indicator } from "./Switch.tsx";
export type { SwitchProps, SwitchSize, CheckboxProps, IndicatorProps } from "./Switch.tsx";
export { CheckMark, CheckRow } from "./CheckRow.tsx";
export type { CheckRowProps } from "./CheckRow.tsx";
export { Tabs } from "./Tabs.tsx";
export type { TabItem, TabsProps } from "./Tabs.tsx";
export { Chip, ModelChip } from "./Chip.tsx";
export type { ChipProps, ModelChipProps } from "./Chip.tsx";
export { Menu, MenuItem } from "./Menu.tsx";
export type { MenuItemKind, MenuItemProps, MenuProps } from "./Menu.tsx";

// ---- 输入 ----
export { TextField } from "./TextField.tsx";
export type { TextFieldProps } from "./TextField.tsx";

// ---- 容器与层 ----
export { PushedPage, usePushedPage, holdInert } from "./PushedPage.tsx";
export type { PushedPageProps, PushedPageState } from "./PushedPage.tsx";
export { Section } from "./Section.tsx";
export type { SectionProps } from "./Section.tsx";
export { SectionLabel } from "./SectionLabel.tsx";
export type { SectionLabelProps } from "./SectionLabel.tsx";
export { ChipRow } from "./ChipRow.tsx";
export type { ChipRowProps } from "./ChipRow.tsx";
export { ListRow } from "./ListRow.tsx";
export type { ListRowProps } from "./ListRow.tsx";
export { Drawer, DrawerHandle } from "./Drawer.tsx";
export type { DrawerInset, DrawerProps, DrawerHandleProps } from "./Drawer.tsx";
export { FloatingLayer } from "./FloatingLayer.tsx";
export { FadeViewport, useEdgeFades, edgeFades } from "./EdgeFade.tsx";
export type { EdgeFade } from "./EdgeFade.tsx";
export { Empty } from "./Empty.tsx";
export type { EmptyAction, EmptyArt, EmptyKind, EmptyProps } from "./Empty.tsx";
export { Note } from "./Note.tsx";
export type { NoteProps } from "./Note.tsx";

// ---- 状态记号 ----
export { StateDot, DupMark, DOT_LABEL } from "./StateDot.tsx";
export type { Dot, StateDotProps, DupMarkProps } from "./StateDot.tsx";
export { Tag } from "./Tag.tsx";
export type { TagProps } from "./Tag.tsx";

// ---- 图标与排版原语 ----
export {
  IconArrowLeft,
  IconAttention,
  IconCannot,
  IconChevronDown,
  IconClose,
  IconDash,
  IconEdit,
  IconLeave,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSortArrow,
  IconTick,
  IconTrash,
} from "./icons.tsx";
export type { IconProps, MarkProps } from "./icons.tsx";
export { AgentIcon, agentInitial, hasAgentIcon } from "./AgentIcon.tsx";
export type { AgentIconProps } from "./AgentIcon.tsx";
export { Cap, capRuns } from "./Cap.tsx";
export type { CapProps, CapTone } from "./Cap.tsx";
export { Mono } from "./Mono.tsx";
export type { MonoProps } from "./Mono.tsx";

export { motionMs } from "./motion.ts";
