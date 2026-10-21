import { readFile } from "node:fs/promises";
import { z } from "zod";
import { boundaryCaptureError } from "./review-start-boundary-capture-diagnostic";

const nativeRecordSchema = z.object({
	type: z.string(),
	timestamp: z.string().optional(),
	payload: z.looseObject({
		id: z.string().optional(),
		type: z.string().optional(),
		turn_id: z.string().optional(),
		originator: z.string().optional(),
		cli_version: z.string().optional(),
		source: z.unknown().optional(),
		turn_attribution: z.object({ turn_trigger: z.string().optional() }).optional(),
		item: z
			.object({
				id: z.string().optional(),
				type: z.string(),
				content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
			})
			.optional(),
	}),
});

export async function readCodexNativeReviewStartMessageEvidence(input: {
	transcriptPath: string;
	nativeSessionId: string;
	nativeTurnId: string;
	nativeMessageId: string;
	text: string;
}) {
	const records = (await readFile(input.transcriptPath, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => nativeRecordSchema.parse(JSON.parse(line)));
	const metadata = records.find((record) => record.type === "session_meta")?.payload;
	if (
		metadata?.id !== input.nativeSessionId ||
		metadata.originator !== "codex-tui" ||
		metadata.cli_version !== "0.163.0" ||
		!["cli", "vscode"].includes(String(metadata.source))
	)
		throw boundaryCaptureError(
			"此原生会话或 Codex 版本的独立回退能力尚未取证。",
			"native_independent_user_turn_capability_unverified",
			"pending",
			"repair_host_capability",
		);
	let currentTurn: string | undefined;
	let userInitiated = false;
	let userMessagesInBoundaryTurn = 0;
	let receivedAt: string | undefined;
	let foundCount = 0;
	for (const record of records) {
		if (record.type !== "event_msg") continue;
		const event = record.payload;
		if (event.type === "task_started") {
			currentTurn = event.turn_id;
			userInitiated = event.turn_attribution?.turn_trigger === "user";
			if (receivedAt && userInitiated && currentTurn !== input.nativeTurnId)
				throw boundaryCaptureError("开审消息之后已进入另一用户回合。", "review_start_boundary_binding_invalidated");
		}
		if (receivedAt && ["thread_rolled_back", "thread_reverted", "conversation_reverted"].includes(event.type ?? ""))
			throw boundaryCaptureError("开审消息之后原生历史已回退。", "review_start_boundary_binding_invalidated");
		if (event.type !== "item_completed" || event.item?.type !== "UserMessage") continue;
		if (event.turn_id === input.nativeTurnId) userMessagesInBoundaryTurn++;
		if (event.item.id !== input.nativeMessageId) continue;
		foundCount++;
		const content = event.item.content ?? [];
		if (
			!userInitiated ||
			currentTurn !== input.nativeTurnId ||
			event.turn_id !== currentTurn ||
			!content.length ||
			content.some((part) => !["text", "input_text"].includes(part.type) || typeof part.text !== "string") ||
			content.map((part) => part.text).join("") !== input.text
		)
			throw boundaryCaptureError(
				"原生消息正文、独立 user turn 与当前分界不一致。",
				"review_start_boundary_binding_invalidated",
			);
		receivedAt = record.timestamp;
	}
	if (foundCount !== 1 || userMessagesInBoundaryTurn !== 1 || !receivedAt || !Number.isFinite(Date.parse(receivedAt)))
		throw boundaryCaptureError(
			"当前消息没有唯一的原生独立 user turn 证据。",
			"review_start_boundary_binding_invalidated",
		);
	return { receivedAt };
}

// 与 RVF UPS 和 verifier 的同源文本规则对齐；调用方先验证 manual UPS provenance。
export function isExplicitRvfManualCommand(text: string) {
	const commandPresent =
		/(?:^|\s)[$/:]review-validate-fix(?!:rvf-)\b/mu.test(text) ||
		/(?:^|\s)\$[^\s:$]+:review-validate-fix(?![\p{L}\p{N}_:-])/u.test(text);
	if (!commandPresent || /^\s*[$/:](?:rvf:|review-validate-fix:)?rvf-[a-z0-9][a-z0-9-]*\b/u.test(text)) return false;
	const handoffRunIdentifier = /\brvf-\d{8}T\d{6}Z-[A-Za-z0-9_.:-]+/u.test(text);
	const handoffSectionMarkers = [
		"handoff intake hints",
		"deterministic intake hints",
		"validate/fix",
		"处理结果",
		"repo delta",
		"继续指引",
		"升级事项",
		"本次 review",
	];
	const handoffSectionPresent = text.split("\n").some((line) => {
		const heading = /^##+\s+(.+?)\s*$/u.exec(line)?.[1]?.toLowerCase();
		return heading && handoffSectionMarkers.some((marker) => heading.includes(marker));
	});
	return !(handoffRunIdentifier && handoffSectionPresent);
}
