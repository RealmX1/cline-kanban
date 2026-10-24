import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import {
	parseCodexNativeCloseoutUserMessageContent,
	readCodexNativeCloseoutCandidateText,
} from "./codex-native-closeout-user-message-content";

const nativeRecordSchema = z.object({
	type: z.string(),
	timestamp: z.string().optional(),
	payload: z.looseObject({
		type: z.string().optional(),
		turn_id: z.string().optional(),
		turn_attribution: z.object({ turn_trigger: z.string().optional() }).optional(),
		item: z
			.object({
				id: z.string(),
				type: z.string(),
				content: z.array(z.unknown()).optional(),
			})
			.optional(),
	}),
});
const nativeSkillExpansionAttributionSchema = z.object({
	turn_id: z.string().min(1),
	content_item_kinds: z.array(z.literal("skills.selected_skill_instructions")),
	content_item_metadata: z.array(z.object({ provenance: z.object({ type: z.literal("skills") }) })),
});

// 收尾允许已经出现后续回合；不能复用要求「当前独立开审回合」的 reader 而削弱开审门禁。
export async function readCodexNativeCloseoutPromptAcceptanceEvidence(input: {
	transcriptPath: string;
	nativeSessionId: string;
	worktree: string;
	promptSha256: string;
	deliveryCreatedAt: string;
	decisionToken: string;
	runId: string;
	handoffSha256: string;
	handoffPath: string;
	previousTranscriptSnapshot?: { transcriptByteLength: number; transcriptSha256: string };
}) {
	const bytes = await readFile(input.transcriptPath);
	const prior = input.previousTranscriptSnapshot;
	if (
		prior &&
		(bytes.length < prior.transcriptByteLength ||
			computeRvfTextSha256(bytes.subarray(0, prior.transcriptByteLength)) !== prior.transcriptSha256)
	)
		throw new Error("补证时保存的原生转录前缀已改变。");
	let records: z.infer<typeof nativeRecordSchema>[];
	try {
		records = bytes
			.toString("utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => nativeRecordSchema.parse(JSON.parse(line)));
	} catch {
		// JSON 异常可能摘录正文；公开诊断只说明格式或写入尚未完整。
		throw new Error("原生转录包含不完整或不受支持的 JSONL 记录。");
	}
	const metadata = records.filter((record) => record.type === "session_meta");
	if (
		metadata.length !== 1 ||
		metadata[0]?.payload.id !== input.nativeSessionId ||
		metadata[0]?.payload.originator !== "codex-tui" ||
		!["cli", "vscode"].includes(String(metadata[0]?.payload.source)) ||
		typeof metadata[0]?.payload.cwd !== "string" ||
		(await realpath(metadata[0].payload.cwd)) !== (await realpath(input.worktree))
	)
		throw new Error("原生转录的 session_meta 身份、来源或工作目录不符。");
	const startedUserTurns = new Map<string, string>();
	let currentNativeTurnId: string | undefined;
	const matches: {
		nativeUserMessageId: string;
		nativeTurnId: string;
		nativeTurnStartedAt: string;
		nativeUserMessageRecordedAt: string;
		text: string;
		content: unknown[];
		recordIndex: number;
		observedCurrentNativeTurnId: string | undefined;
	}[] = [];
	for (const [recordIndex, record] of records.entries()) {
		if (record.type !== "event_msg") continue;
		const event = record.payload;
		if (event.type === "task_started") currentNativeTurnId = event.turn_id;
		if (event.type === "task_started" && event.turn_id && event.turn_attribution?.turn_trigger === "user") {
			if (record.timestamp) startedUserTurns.set(event.turn_id, record.timestamp);
		}
		if (event.type !== "item_completed" || event.item?.type !== "UserMessage") continue;
		const content = event.item.content ?? [];
		const text = readCodexNativeCloseoutCandidateText(content);
		if (computeRvfTextSha256(text) !== input.promptSha256) continue;
		if (event.thread_id !== undefined && event.thread_id !== input.nativeSessionId)
			throw new Error("精确正文的原生 thread 身份不符。");
		const startedAt = startedUserTurns.get(event.turn_id ?? "");
		if (!startedAt || !record.timestamp || !event.turn_id) throw new Error("精确正文缺少原生用户回合时间证据。");
		const lines = text.split("\n");
		if (
			![
				`RVF_AUTOMATIC_CLOSEOUT_TOKEN=${input.decisionToken}`,
				`run_id=${input.runId}`,
				`handoff_sha256=${input.handoffSha256}`,
				input.handoffPath,
			].every((line) => lines.includes(line)) ||
			![startedAt, record.timestamp, input.deliveryCreatedAt].every((time) => Number.isFinite(Date.parse(time))) ||
			Date.parse(startedAt) < Date.parse(input.deliveryCreatedAt) ||
			Date.parse(record.timestamp) < Date.parse(startedAt) ||
			Date.parse(record.timestamp) > Date.now() + 60_000
		)
			throw new Error("原生正文中的收尾绑定或事件时间与原投递不符。");
		matches.push({
			nativeUserMessageId: event.item.id,
			nativeTurnId: event.turn_id,
			nativeTurnStartedAt: startedAt,
			nativeUserMessageRecordedAt: record.timestamp,
			text,
			content,
			recordIndex,
			observedCurrentNativeTurnId: currentNativeTurnId,
		});
	}
	if (matches.length !== 1) throw new Error("原生转录未提供唯一的精确收尾正文与 user turn。");
	const match = matches[0];
	if (!match) throw new Error("缺少原生正文证据。");
	const { skillReferences } = parseCodexNativeCloseoutUserMessageContent(match.content);
	const nativeSkillExpansionTexts: string[] = [];
	if (skillReferences.length) {
		if (match.observedCurrentNativeTurnId !== match.nativeTurnId)
			throw new Error("Skill 附件消息不属于转录中的当前原生回合。");
		// 相邻位置只界定已知格式的候选范围；回合与逐内容块来源仍须由原生元数据证明。
		for (const record of records.slice(match.recordIndex + 1)) {
			if (record.type !== "response_item" || record.payload.type !== "message" || record.payload.role !== "user")
				break;
			const content = z.array(z.unknown()).safeParse(record.payload.content);
			if (!content.success) throw new Error("Skill 展开记录缺少完整正文。");
			const expansion = parseCodexNativeCloseoutUserMessageContent(content.data);
			if (!expansion.text.startsWith("<skill>\n")) break;
			const attribution = nativeSkillExpansionAttributionSchema.safeParse(
				record.payload.internal_chat_message_metadata_passthrough,
			);
			if (
				!attribution.success ||
				attribution.data.turn_id !== match.nativeTurnId ||
				attribution.data.content_item_kinds.length !== content.data.length ||
				attribution.data.content_item_metadata.length !== content.data.length
			)
				throw new Error("Skill 展开记录缺少可信的同回合逐内容块来源证据。");
			if (
				expansion.skillReferences.length ||
				!record.timestamp ||
				!Number.isFinite(Date.parse(record.timestamp)) ||
				Date.parse(record.timestamp) < Date.parse(match.nativeUserMessageRecordedAt) ||
				Date.parse(record.timestamp) > Date.now() + 60_000
			)
				throw new Error("Skill 展开记录的内容或同回合时间证据不完整。");
			nativeSkillExpansionTexts.push(expansion.text);
		}
		if (nativeSkillExpansionTexts.length !== skillReferences.length)
			throw new Error("Skill 附件缺少唯一的同回合原生展开记录。");
	}
	return {
		nativeUserMessageId: match.nativeUserMessageId,
		nativeTurnId: match.nativeTurnId,
		nativeTurnStartedAt: match.nativeTurnStartedAt,
		nativeUserMessageRecordedAt: match.nativeUserMessageRecordedAt,
		text: match.text,
		// 这里只提供结构证据；服务端还须查询本代 catalog、安装内容和活动分支才可恢复。
		skillReferences,
		nativeSkillExpansionTexts,
		transcriptPath: await realpath(input.transcriptPath),
		transcriptSha256: computeRvfTextSha256(bytes),
		transcriptByteLength: bytes.length,
	};
}
