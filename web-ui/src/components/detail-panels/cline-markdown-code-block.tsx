import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-c";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-css";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { useMemo } from "react";
import type { ExtraProps } from "react-markdown";

import { cn } from "@/components/ui/cn";

const PRISM_LANGUAGE_ALIASES: Record<string, string> = {
	bash: "bash",
	c: "c",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	go: "go",
	html: "markup",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "jsx",
	md: "markdown",
	mdx: "markdown",
	php: "php",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	sql: "sql",
	swift: "swift",
	ts: "typescript",
	tsx: "tsx",
	typescript: "typescript",
	xml: "markup",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

function normalizeLanguageTag(className: string | undefined): string | null {
	if (!className) {
		return null;
	}
	const match = /language-([A-Za-z0-9_-]+)/.exec(className);
	if (!match?.[1]) {
		return null;
	}
	const requestedLanguage = match[1].toLowerCase();
	const resolvedLanguage = PRISM_LANGUAGE_ALIASES[requestedLanguage] ?? requestedLanguage;
	return Prism.languages[resolvedLanguage] ? resolvedLanguage : null;
}

function toCodeString(children: ReactNode): string {
	const value = String(children ?? "");
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}

export type ClineMarkdownCodeBlockProps = ComponentPropsWithoutRef<"code"> & ExtraProps;

/**
 * ReactMarkdown 的 `code` 渲染器。抽成独立组件是为了拿到一个可以挂 hook 的
 * 渲染边界：`Prism.highlight` 是整条聊天渲染链上最贵的一步，而流式输出会让
 * `ClineMarkdownContent` 在每个 chunk 重渲整棵 markdown 树。代码块在树中的
 * 位置稳定，React 复用同一个组件实例，于是下面这层 `useMemo` 把「每 chunk
 * 重新高亮全部代码块」降成「只高亮正在增长的那一个」。
 */
export function ClineMarkdownCodeBlock({
	className,
	children,
	node: _node,
	...props
}: ClineMarkdownCodeBlockProps): ReactElement {
	const code = toCodeString(children);
	const isInline = !className || !className.includes("language-");

	const highlighted = useMemo((): { language: string; html: string } | null => {
		if (isInline) {
			return null;
		}
		const language = normalizeLanguageTag(className);
		const grammar = language ? (Prism.languages[language] ?? null) : null;
		if (!language || !grammar) {
			return null;
		}
		return { language, html: Prism.highlight(code, grammar, language) };
	}, [className, code, isInline]);

	if (isInline) {
		return (
			<code
				className={cn(
					"rounded bg-surface-2 px-1 py-0.5 font-mono text-xs whitespace-pre-wrap break-all text-text-primary",
					className,
				)}
				{...props}
			>
				{code}
			</code>
		);
	}

	if (highlighted) {
		return (
			<pre className="my-0.5 overflow-x-auto rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs leading-5 text-text-primary">
				{/* Prism 输出的是它自己转义过的 token HTML，不含用户原样注入的标记。 */}
				<code
					className={`language-${highlighted.language}`}
					dangerouslySetInnerHTML={{ __html: highlighted.html }}
				/>
			</pre>
		);
	}

	return (
		<pre className="my-0.5 overflow-x-auto rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs leading-5 text-text-primary">
			<code className={cn("font-mono", className)}>{code}</code>
		</pre>
	);
}
