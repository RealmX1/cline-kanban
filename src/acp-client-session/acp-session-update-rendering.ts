// 把 ACP 的结构化载荷渲染成聊天面板可直接显示的 markdown。
// 刻意选择「渲染进 content」而不是「为 diff / plan / locations 各造一套 schema 字段 + 渲染分支」：
// 会话面板已经有 markdown 渲染器，复用它能在零新增前端分支的前提下把富信息显示出来。
import type { AcpContentBlock, AcpToolCallContent } from "./acp-protocol-boundary";

const TOOL_CONTENT_TEXT_CHARACTER_LIMIT = 4_000;

export function renderAcpContentBlockAsText(block: AcpContentBlock): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "resource_link":
			return `[${block.name}](${block.uri})`;
		case "image":
			return "_(image)_";
		case "audio":
			return "_(audio)_";
		case "resource":
			return renderEmbeddedResource(block.resource);
		default:
			return "";
	}
}

function renderEmbeddedResource(resource: { uri?: string; text?: string; blob?: string }): string {
	if (typeof resource.text === "string") {
		return resource.text;
	}
	return resource.uri ? `_(resource ${resource.uri})_` : "_(resource)_";
}

export function renderAcpToolCallContentAsMarkdown(contents: readonly AcpToolCallContent[]): string {
	const rendered = contents.map((content) => renderSingleToolCallContent(content)).filter((part) => part.length > 0);
	// tool_call_update 的 content 是整体替换语义，所以这里也整体重建、不做增量拼接。
	return dedupeConsecutive(rendered).join("\n\n");
}

function renderSingleToolCallContent(content: AcpToolCallContent): string {
	if (content.type === "content") {
		return truncateForDisplay(renderAcpContentBlockAsText(content.content));
	}
	if (content.type === "diff") {
		return renderDiffAsMarkdown(content);
	}
	if (content.type === "terminal") {
		return `_(live terminal ${content.terminalId})_`;
	}
	return "";
}

function renderDiffAsMarkdown(diff: { path: string; oldText?: string | null; newText: string }): string {
	const isNewFile = diff.oldText === null || diff.oldText === undefined;
	const header = isNewFile ? `**${diff.path}** _(new file)_` : `**${diff.path}**`;
	return `${header}\n\n\`\`\`diff\n${truncateForDisplay(buildUnifiedDiffBody(diff.oldText ?? "", diff.newText))}\n\`\`\``;
}

// 只做「整块删 + 整块增」的朴素呈现：ACP 给的是新旧全文，Kanban 的 diff 面板才是精确逐行 diff 的
// 归属地，这里的目标只是让聊天流里看得出改了什么。
function buildUnifiedDiffBody(oldText: string, newText: string): string {
	const removed = oldText ? splitLines(oldText).map((line) => `-${line}`) : [];
	const added = newText ? splitLines(newText).map((line) => `+${line}`) : [];
	return [...removed, ...added].join("\n");
}

function splitLines(value: string): string[] {
	return value.replace(/\n$/, "").split("\n");
}

export function renderAcpPlanEntriesAsMarkdown(
	entries: ReadonlyArray<{ content: string; status: string; priority: string }>,
): string {
	if (entries.length === 0) {
		return "_(plan cleared)_";
	}
	const lines = entries.map((entry) => `- ${renderPlanStatusCheckbox(entry.status)} ${entry.content}`);
	return `**Plan**\n\n${lines.join("\n")}`;
}

function renderPlanStatusCheckbox(status: string): string {
	if (status === "completed") {
		return "[x]";
	}
	if (status === "in_progress") {
		return "[~]";
	}
	return "[ ]";
}

export function renderAcpToolCallLocationsAsMarkdown(
	locations: ReadonlyArray<{ path: string; line?: number | null }>,
): string {
	if (locations.length === 0) {
		return "";
	}
	return locations
		.map((location) =>
			typeof location.line === "number" ? `\`${location.path}:${location.line}\`` : `\`${location.path}\``,
		)
		.join(" ");
}

function truncateForDisplay(value: string): string {
	if (value.length <= TOOL_CONTENT_TEXT_CHARACTER_LIMIT) {
		return value;
	}
	return `${value.slice(0, TOOL_CONTENT_TEXT_CHARACTER_LIMIT)}\n… (truncated)`;
}

function dedupeConsecutive(parts: readonly string[]): string[] {
	return parts.filter((part, index) => index === 0 || part !== parts[index - 1]);
}
