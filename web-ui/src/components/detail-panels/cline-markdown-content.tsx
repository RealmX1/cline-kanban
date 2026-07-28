import React, { type ReactElement } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ClineMarkdownCodeBlock } from "@/components/detail-panels/cline-markdown-code-block";
import { cn } from "@/components/ui/cn";

const markdownComponents: Components = {
	h1: ({ className, ...props }) => (
		<h1 className={cn("mt-3 text-base font-semibold text-text-primary", className)} {...props} />
	),
	h2: ({ className, ...props }) => (
		<h2 className={cn("mt-3 text-base font-semibold text-text-primary", className)} {...props} />
	),
	h3: ({ className, ...props }) => (
		<h3 className={cn("mt-2 text-sm font-semibold text-text-primary", className)} {...props} />
	),
	p: ({ className, ...props }) => (
		<p className={cn("leading-snug whitespace-pre-wrap text-sm text-text-primary", className)} {...props} />
	),
	ul: ({ className, ...props }) => (
		<ul className={cn("list-disc pl-5 leading-snug text-sm text-text-primary", className)} {...props} />
	),
	ol: ({ className, ...props }) => (
		<ol className={cn("list-decimal pl-5 leading-snug text-sm text-text-primary", className)} {...props} />
	),
	li: ({ className, ...props }) => (
		<li className={cn("leading-snug text-sm text-text-primary", className)} {...props} />
	),
	a: ({ className, ...props }) => (
		<a className={cn("text-accent-2 underline", className)} target="_blank" rel="noreferrer" {...props} />
	),
	blockquote: ({ className, ...props }) => (
		<blockquote
			className={cn("border-l-2 border-border-bright pl-3 text-sm leading-snug text-text-secondary", className)}
			{...props}
		/>
	),
	hr: ({ className, ...props }) => <hr className={cn("border-border", className)} {...props} />,
	code: ClineMarkdownCodeBlock,
};

/**
 * `React.memo` 在这里不是保险式优化，而是命中率有保证的：
 * `use-cline-chat-session.ts` 的 `upsertMessage` 用浅拷贝更新消息数组，未变消息的
 * 对象引用完整保留，因此流式输出期间只有正在增长的那条消息会真正重新解析 markdown。
 */
export const ClineMarkdownContent = React.memo(function ClineMarkdownContent({
	content,
}: {
	content: string;
}): ReactElement {
	if (!content.trim()) {
		return <span className="text-text-secondary" />;
	}
	return (
		<div className="kb-markdown min-w-0">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
				{content}
			</ReactMarkdown>
		</div>
	);
});
