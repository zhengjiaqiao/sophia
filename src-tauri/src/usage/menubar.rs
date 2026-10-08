//! 菜单栏用量的绘制（spec R9，设计 §5）：把「Sophia 图标 + 每个 agent 的标志与数字」整体画成一张模板图，
//! 设到菜单栏按钮上。系统按深浅色给模板图着色，失焦的显示器上自动变暗。
//!
//! 为什么画成一张图而不用 `set_title` 或富文本标题：`set_title` 只能是纯文本（`tray-icon 0.24.2` 里
//! `set_title(None)` 还清不掉）；富文本标题里的换行会让整个标题一起变两行，做不到「Claude 叠两行、Codex 单行」。
//! 技术验证见 `docs/specs/2026-09-26-menubar-usage-spike.png`（2026-09-27）。
//!
//! 文字内容（哪几行、剩余还是已用、倒计时、「—」、过期、字号档）全在 core 的 `usage::format::menu_bar_view`
//! 里算好，这里只管画。
#![allow(deprecated)] // `NSImage::lockFocus` 自 macOS 14 标为弃用但仍可用；换成 drawingHandler 需要 block2，留作以后

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSAttributedStringNSStringDrawing, NSColor, NSCompositingOperation, NSFont,
    NSFontAttributeName, NSFontWeightMedium, NSForegroundColorAttributeName, NSImage,
};
use objc2_foundation::{
    NSAttributedString, NSAttributedStringKey, NSData, NSDictionary, NSPoint, NSRect, NSSize,
    NSString,
};
use sophia_core::usage::format::MenuBarSegment;
use sophia_core::usage::{AgentId, StackedSize};

/// 菜单栏内容区高度（点）。刘海屏的菜单栏更高（33pt），图在按钮里垂直居中
const HEIGHT: f64 = 22.0;
/// Sophia 图标边长：与 `tray-icon` 自己设图标时的 18pt 一致，开关菜单栏数字时图标大小不变
const APP_ICON: f64 = 18.0;
/// agent 标志边长
const GLYPH: f64 = 12.0;
/// 相邻两段（图标与第一个 agent、agent 与 agent）之间
const SEGMENT_GAP: f64 = 6.0;
/// agent 标志与它的数字之间
const GLYPH_GAP: f64 = 3.0;
/// 单行数字的字号（菜单栏系统文字的大小）
const SINGLE_PT: f64 = 13.0;
/// 读数过期时整段的不透明度
const STALE_ALPHA: f64 = 0.45;

/// 叠放字号（spec R9：小 9 / 中 10 / 大 11pt，默认小）
pub fn stacked_pt(size: StackedSize) -> f64 {
    match size {
        StackedSize::Small => 9.0,
        StackedSize::Medium => 10.0,
        StackedSize::Large => 11.0,
    }
}

fn text(s: &str, pt: f64, alpha: f64) -> Retained<NSAttributedString> {
    unsafe {
        let font = NSFont::monospacedDigitSystemFontOfSize_weight(pt, NSFontWeightMedium);
        // 模板图只看不透明度：一律画黑色，过期时降低不透明度
        let color = NSColor::colorWithWhite_alpha(0.0, alpha);
        let keys: [&NSAttributedStringKey; 2] =
            [NSFontAttributeName, NSForegroundColorAttributeName];
        let values: [&AnyObject; 2] = [&font, &color];
        let attrs = NSDictionary::from_slices(&keys, &values);
        NSAttributedString::initWithString_attributes(
            NSAttributedString::alloc(),
            &NSString::from_str(s),
            Some(&attrs),
        )
    }
}

fn image_from(bytes: &'static [u8]) -> Option<Retained<NSImage>> {
    NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))
}

/// agent 标志：与 `src/ui/AgentIcon.tsx` 同一份路径（`tests/agent-glyphs.test.ts` 核对）。
/// SVG 要 macOS 14 起才读得出来，读不出就画名字首字母。提供商还没有标志素材（#326），一律画首字母
fn glyph(seg: &MenuBarSegment) -> Option<Retained<NSImage>> {
    match seg.key.agent()? {
        AgentId::ClaudeCode => image_from(include_bytes!("../../icons/agents/claude-code.svg")),
        AgentId::Codex => image_from(include_bytes!("../../icons/agents/codex.svg")),
    }
}

fn initial(seg: &MenuBarSegment) -> String {
    match seg.key.agent() {
        Some(AgentId::ClaudeCode) => "C".into(),
        Some(AgentId::Codex) => "X".into(),
        None => seg
            .brand
            .chars()
            .next()
            .map(|c| c.to_uppercase().collect())
            .unwrap_or_default(),
    }
}

/// 一段数字占多宽（多行取最宽的一行）
fn lines_width(seg: &MenuBarSegment) -> f64 {
    let pt = if seg.lines.len() > 1 {
        stacked_pt(seg.stacked_size)
    } else {
        SINGLE_PT
    };
    seg.lines
        .iter()
        .map(|l| text(l, pt, 1.0).size().width)
        .fold(0.0, f64::max)
}

/// 画整张图。`segments` 为空时只有 Sophia 图标（菜单栏显示关着，spec AC22）
pub fn draw(app_icon: &NSImage, segments: &[MenuBarSegment]) -> Retained<NSImage> {
    let widths: Vec<f64> = segments.iter().map(lines_width).collect();
    let total = APP_ICON
        + segments.len() as f64 * (SEGMENT_GAP + GLYPH + GLYPH_GAP)
        + widths.iter().sum::<f64>()
        + if segments.is_empty() { 0.0 } else { 1.0 };
    let img = NSImage::initWithSize(NSImage::alloc(), NSSize::new(total.ceil(), HEIGHT));
    img.lockFocus();
    app_icon.drawInRect(NSRect::new(
        NSPoint::new(0.0, (HEIGHT - APP_ICON) / 2.0),
        NSSize::new(APP_ICON, APP_ICON),
    ));
    let mut x = APP_ICON;
    for (seg, width) in segments.iter().zip(&widths) {
        let alpha = if seg.stale { STALE_ALPHA } else { 1.0 };
        x += SEGMENT_GAP;
        let rect = NSRect::new(
            NSPoint::new(x, (HEIGHT - GLYPH) / 2.0),
            NSSize::new(GLYPH, GLYPH),
        );
        match glyph(seg) {
            Some(g) => g.drawInRect_fromRect_operation_fraction(
                rect,
                NSRect::ZERO,
                NSCompositingOperation::SourceOver,
                alpha,
            ),
            None => {
                let t = text(&initial(seg), 10.0, alpha);
                let sz = t.size();
                t.drawAtPoint(NSPoint::new(
                    x + (GLYPH - sz.width) / 2.0,
                    (HEIGHT - sz.height) / 2.0,
                ));
            }
        }
        x += GLYPH + GLYPH_GAP;
        match seg.lines.as_slice() {
            [one] => {
                let t = text(one, SINGLE_PT, alpha);
                let sz = t.size();
                t.drawAtPoint(NSPoint::new(x, (HEIGHT - sz.height) / 2.0));
            }
            [top, bottom, ..] => {
                // 两行各占一半高度；三档字号在 22pt 内都不重叠（技术验证实测）
                let stacked = stacked_pt(seg.stacked_size);
                let top = text(top, stacked, alpha);
                let bottom = text(bottom, stacked, alpha);
                let th = top.size().height;
                bottom.drawAtPoint(NSPoint::new(x, HEIGHT / 2.0 - th + 2.0));
                top.drawAtPoint(NSPoint::new(x, HEIGHT / 2.0 - 1.0));
            }
            [] => {}
        }
        x += width;
    }
    img.unlockFocus();
    img.setTemplate(true);
    img
}

/// Sophia 的菜单栏图标（与托盘建图标时用的是同一个文件）
pub fn app_icon() -> Option<Retained<NSImage>> {
    image_from(include_bytes!("../../icons/tray.png"))
}

/// 在主线程上把图设到菜单栏按钮上。拿不到按钮（系统还没把它放上菜单栏）时什么都不做
pub fn apply(item: &objc2_app_kit::NSStatusItem, image: &NSImage) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(button) = item.button(mtm) else {
        return;
    };
    button.setImage(Some(image));
    // tray-icon 在按钮上盖了一层接点击的视图（`TaoTrayTarget`），它只在 tray-icon 自己设图标 / 标题时
    // 才跟着按钮改尺寸（`update_dimensions`）。这里绕开它设了更宽的图，得照它的做法把那一层撑满，
    // 否则只有原来图标那一块点得动，点数字没反应（2026-09-29 真机）
    let frame = button.frame();
    for view in button.subviews().iter() {
        if view.class().name().to_str() == Ok("TaoTrayTarget") {
            view.setFrame(frame);
        }
    }
}
