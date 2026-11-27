import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readTranscriptRecord } from "../agent-session-history/bounded-agent-transcript-reader";
import type {
	RuntimeTaskChatMessage,
	RuntimeTaskConversationHistoryPageResponse,
	RuntimeTaskMainSessionPlanResponse,
} from "../core/api-contract";

export interface CompleteTaskPlanVersion {
	messageId: string;
	markdown: string | null;
	filePaths: string[];
}

function containedPlanPath(path: string, workspacePath: string): string | null {
	if (path.includes("\0") || /^https?:/u.test(path) || path.split(/[\\/]/u).includes("..")) return null;
	if (isAbsolute(path)) return path;
	const resolved = resolve(workspacePath, path);
	const fromWorkspace = relative(workspacePath, resolved);
	if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) return null;
	return resolved;
}

function explicitPlanPaths(text: string, workspacePath: string): string[] {
	const paths: string[] = [];
	const namesPlan = /计划|\bplan\b/iu.test(text);
	for (const match of text.matchAll(
		/\]\(([^)\n]+\.md)\)|`([^`\n]+\.md)`|((?:\/[\w.\-~/]+|\.plan\/)[^\s`"<>]*\.md)/gu,
	)) {
		const path = match[1] ?? match[2] ?? match[3];
		if (!path || (!/\/plans\//u.test(path) && !namesPlan)) continue;
		const normalized = containedPlanPath(path, workspacePath);
		if (normalized) paths.push(normalized);
	}
	return [...new Set(paths)];
}

export function findLatestCompleteTaskPlan(
	messages: readonly RuntimeTaskChatMessage[],
	workspacePath: string,
): CompleteTaskPlanVersion | null {
	for (const message of [...messages].reverse()) {
		if (message.role === "assistant") {
			const plans = [...message.content.matchAll(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/gu)];
			if (message.content.includes("<proposed_plan>") && !plans.length) continue;
			const markdown = plans.at(-1)?.[1]?.trim() || null;
			const filePaths = explicitPlanPaths(message.content, workspacePath);
			if (markdown || filePaths.length) return { messageId: message.id, markdown, filePaths };
		}
		if (message.role !== "tool") continue;
		let input: Record<string, unknown> | null = null;
		try {
			input = readTranscriptRecord(JSON.parse(message.content));
		} catch {
			/* 普通工具文本不是计划证据。 */
		}
		if (!input) continue;
		const isPlanExit = /(?:^|\.)ExitPlanMode$/u.test(message.meta?.toolName ?? "");
		if (!isPlanExit && message.meta?.toolName !== "完整计划来源") continue;
		const rawPath = input.file_path ?? input.filePath ?? input.planFilePath;
		const normalizedPath = typeof rawPath === "string" ? containedPlanPath(rawPath, workspacePath) : null;
		const markdown = typeof input.plan === "string" ? input.plan.trim() || null : null;
		const filePaths = normalizedPath ? [normalizedPath] : [];
		if (markdown || filePaths.length) return { messageId: message.id, markdown, filePaths };
	}
	return null;
}

export function taskPlanCandidateId(sessionId: string, version: CompleteTaskPlanVersion, path: string | null): string {
	return createHash("sha256")
		.update(JSON.stringify([sessionId, version, path]))
		.digest("hex");
}

export async function readLatestTaskMainSessionPlan(input: {
	sessionId: string;
	workspacePath: string;
	readPage: (cursor: string | null) => Promise<RuntimeTaskConversationHistoryPageResponse>;
}): Promise<{ response: RuntimeTaskMainSessionPlanResponse; version: CompleteTaskPlanVersion | null }> {
	let cursor: string | null = null;
	let bytes = 0;
	const seenCursors = new Set<string>();
	for (let index = 0; index < 32; index++) {
		const page = await input.readPage(cursor);
		// 公开阅读入口会带回仅供阅读的补证。Plan 下载只接受当前绑定的可信历史。
		if (page.nativeHistorySource === "verified_read_only")
			return {
				response: {
					availability: "unknown",
					candidates: [],
					notice: "只读补证不能作为主会话 Plan 的可信来源。",
				},
				version: null,
			};
		if (page.availability !== "available")
			return {
				response: {
					availability: "unknown",
					candidates: [],
					notice: page.notice ?? "主会话历史暂不可完整读取，请重试。",
				},
				version: null,
			};
		bytes += page.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
		const version = findLatestCompleteTaskPlan(page.messages, input.workspacePath);
		if (version) {
			const candidates: RuntimeTaskMainSessionPlanResponse["candidates"] = version.filePaths.map((path) => ({
				candidateId: taskPlanCandidateId(input.sessionId, version, path),
				fileName: path.split(/[\\/]/u).at(-1) ?? "plan.md",
				sourceKind: "file",
				sourceReference: path,
			}));
			if (version.markdown && !candidates.length)
				candidates.push({
					candidateId: taskPlanCandidateId(input.sessionId, version, null),
					fileName: "main-session-plan.md",
					sourceKind: "markdown",
					sourceReference: `主会话 ${input.sessionId}，记录 ${version.messageId}`,
				});
			return { response: { availability: "available", candidates, notice: null }, version };
		}
		if (!page.nextCursor)
			return {
				response: { availability: "none", candidates: [], notice: "主会话历史中没有明确关联的完整 Plan。" },
				version: null,
			};
		if (bytes >= 8 * 1024 * 1024 || seenCursors.has(page.nextCursor)) break;
		seenCursors.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	return {
		response: { availability: "unknown", candidates: [], notice: "历史读取达到预算，尚不能确认 Plan 来源，请重试。" },
		version: null,
	};
}
