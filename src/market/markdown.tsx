/// 介绍页正文：渲染后的 SKILL.md / README（DESIGN「发现与安装 › 介绍页」；spec 非功能「介绍页的 Markdown 渲染」）。
///
/// 安全限制，一条都不能松（react-markdown 升级要重跑 tests/market-markdown.test.ts）：
/// - **不执行、不嵌入原始 HTML**：不引 rehype-raw；HTML 节点先由 `remarkPlainHtml` 换成纯文字
/// - **图片不加载**：`img` 画成替代文字（没有替代文字就什么都不画），不出 `<img>`，也就没有预加载
/// - **链接一律在系统浏览器打开、带 ↗**：画成 `role=link` 的一段字（不是 `<a href>`，webview 里点了不会跳走），
///   按下交给 `onOpenLink`；只放 http(s) 与 mailto，相对地址按原文件在 GitHub 上的页补全，其余只留文字
/// - **渲染失败退回纯文字**
///
/// 字与色：正文 15 / 1.65 `ink`，小标题 15 / 600，代码块 `recess` 底 `mono` 12（markdown.css）
import { Component } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import { IconLeave } from "../ui/icons.tsx";
import { Mono } from "../ui/Mono.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { remarkPlainHtml, safeHref } from "./markdownText.ts";
import "./markdown.css";

export interface MarkdownBodyProps {
  /// Markdown 原文（frontmatter 已去掉）
  text: string;
  /// 相对链接按它补全：原文件在 GitHub 上的页
  base: string | null;
  /// 按下正文里的链接（系统浏览器打开）
  onOpenLink: (url: string) => void;
}

const REMARK = [remarkPlainHtml];

function components(base: string | null, onOpenLink: (url: string) => void): Components {
  // 小标题一律一档（15 / 600）：页面名才是这一页的 h1，正文里的标题都降到 h3
  const heading = ({ children }: { children?: ReactNode }) => (
    <h3 className="md-heading">{children}</h3>
  );
  return {
    h1: heading,
    h2: heading,
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    // 图片不加载：只留替代文字
    img: ({ alt }) => (alt ? <span className="md-alt">{alt}</span> : null),
    a: ({ href, children }) => {
      const url = safeHref(href, base);
      if (url === null) return <span>{children}</span>;
      const open = () => onOpenLink(url);
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          open();
        }
      };
      return (
        // 去哪儿经提示框说（不写原生 title：悬停弹系统灰框）；包层是行内的，链接文字照常折行
        <Tooltip content={<Mono inherit>{url}</Mono>} fit="inline">
          <span className="md-link" role="link" tabIndex={0} onClick={open} onKeyDown={onKey}>
            {children}
            <IconLeave className="md-link__leave" />
          </span>
        </Tooltip>
      );
    },
    pre: ({ children }) => <pre className="md-pre">{children}</pre>,
    code: ({ children, className }) => (
      <code className={className ? `md-code ${className}` : "md-code"}>{children}</code>
    ),
    table: ({ children }) => (
      <div className="md-tablewrap">
        <table className="md-table">{children}</table>
      </div>
    ),
    hr: () => <hr className="md-rule" />,
  };
}

/// 渲染失败时退回纯文字
class PlainOnError extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <pre className="md-plain">{this.props.text}</pre>;
    return this.props.children;
  }
}

export function MarkdownBody({ text, base, onOpenLink }: MarkdownBodyProps) {
  return (
    <div className="md">
      <PlainOnError text={text}>
        <Markdown remarkPlugins={REMARK} components={components(base, onOpenLink)}>
          {text}
        </Markdown>
      </PlainOnError>
    </div>
  );
}
