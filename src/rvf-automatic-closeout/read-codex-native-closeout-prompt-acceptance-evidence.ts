import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";

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
				content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
			})
			.optional(),
	}),
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
	const matches: {
		nativeUserMessageId: string;
		nativeTurnId: string;
		nativeTurnStartedAt: string;
		nativeUserMessageRecordedAt: string;
		text: string;
	}[] = [];
	for (const record of records) {
		if (record.type !== "event_msg") continue;
		const event = record.payload;
		if (event.type === "task_started" && event.turn_id && event.turn_attribution?.turn_trigger === "user") {
			if (record.timestamp) startedUserTurns.set(event.turn_id, record.timestamp);
		}
		if (event.type !== "item_completed" || event.item?.type !== "UserMessage") continue;
		const content = event.item.content ?? [];
		if (
			!content.length ||
			content.some((part) => !["text", "input_text"].includes(part.type) || part.text === undefined)
		)
			continue;
		const text = content.map((part) => part.text).join("");
		if (computeRvfTextSha256(text) !== input.promptSha256) continue;
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
		});
	}
	if (matches.length !== 1) throw new Error("原生转录未提供唯一的精确收尾正文与 user turn。");
	const match = matches[0];
	if (!match) throw new Error("缺少原生正文证据。");
	return {
		...match,
		transcriptPath: await realpath(input.transcriptPath),
		transcriptSha256: computeRvfTextSha256(bytes),
		transcriptByteLength: bytes.length,
	};
}
