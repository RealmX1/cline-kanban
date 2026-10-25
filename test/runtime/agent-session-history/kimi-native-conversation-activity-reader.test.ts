import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeAgentConversationActivityReadCursor } from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import { readNativeAgentConversationActivity } from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";
import { createNativeAgentConversationActivityObserver } from "../../../src/server/native-agent-conversation-activity-observer";

const managedHome = vi.hoisted(() => vi.fn<() => string>());
vi.mock("../../../src/terminal/kimi-hook-config", () => ({ getKanbanManagedKimiCodeHome: managedHome }));
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const header = { type: "metadata", protocol_version: "1.5" };
const serialize = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
// Kimi 2.3.1 的 ContentPart：媒体类型用 snake_case，URL 载荷字段用 camelCase。
const kimiNativeWireMediaContentParts = [
	{ type: "image_url", imageUrl: { url: "https://example.invalid/fixture.png" } },
	{ type: "audio_url", audioUrl: { url: "https://example.invalid/fixture.wav" } },
	{ type: "video_url", videoUrl: { url: "https://example.invalid/fixture.mp4" } },
] as const;
function promptRecords(id: string, time: number, text = "重复正文\u2028\u2029中文", turnId = time) {
	return [
		{ type: "turn.prompt", agentId: "main", promptId: id, turnId, time, origin: { kind: "user" } },
		{
			type: "context.append_message",
			agentId: "main",
			time,
			message: {
				id,
				role: "user",
				origin: { kind: "user" },
				content: [
					{ type: "text", text },
					{
						type: "text",
						text: "hook 添加的上下文",
						meta: { source: "user prompt submit hook", contentType: "text/xml" },
					},
				],
			},
		},
	];
}
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "kanban-kimi-native-activity-"));
	directories.push(home);
	managedHome.mockReturnValue(home);
	const directory = join(home, "sessions", "cwd-bucket", "native");
	await mkdir(join(directory, "agents", "main"), { recursive: true });
	const cwd = join(home, "task-workspace");
	const statePath = join(directory, "state.json");
	await writeFile(statePath, JSON.stringify({ version: 2, id: "native", cwd }));
	await writeFile(
		join(home, "session_index.jsonl"),
		serialize([{ sessionId: "native", sessionDir: directory, workDir: cwd }]),
	);
	const path = join(directory, "agents", "main", "wire.jsonl");
	await writeFile(path, serialize([header]));
	const summary: RuntimeTaskSessionSummary = applySessionFacets({
		taskId: "kimi-task",
		state: "running",
		agentId: "kimi",
		workspacePath: cwd,
		pid: 12,
		startedAt: 100,
		updatedAt: 100,
		lastOutputAt: 100,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "kimi",
			nativeSessionId: "native",
			transcriptPath: null,
			observedAt: 100,
		},
	});
	const read = (cursor: NativeAgentConversationActivityReadCursor | null = null) =>
		readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary,
			cursor,
			observedAtMs: 1000,
		});
	return { home, directory, path, statePath, summary, read };
}
function markPending(summary: RuntimeTaskSessionSummary, attemptedAtMs = 1000) {
	summary.agentConversationPromptSubmissionAcceptance = {
		status: "unconfirmed",
		attemptedAtMs,
		runtimeSessionIncarnationId: "incarnation",
	};
}

describe("Kimi 主会话的可靠输入接受核验", () => {
	it("已确认水位之后追加较旧的历史复制记录，不覆盖当前接受事实", async () => {
		const { path, read, summary } = await fixture();
		const baseline = await read();
		summary.agentConversationPromptSubmissionAcceptance = {
			status: "accepted",
			attemptedAtMs: 1050,
			confirmedAtMs: 1200,
			eventId: "kimi:native:current",
			nativeSessionId: "native",
			runtimeSessionIncarnationId: "incarnation",
		};
		await appendFile(path, serialize(promptRecords("copied-history", 1100)));
		expect((await read(baseline?.cursor))?.events).toEqual([]);
	});
	it("压缩期间延迟追加的接受记录早于基线时间，仍可确认同代待确认输入", async () => {
		const { path, read, summary } = await fixture();
		markPending(summary, 900);
		const baseline = await read();
		await appendFile(
			path,
			serialize([
				...promptRecords("delayed-by-compaction", 950, "继续", 1),
				{ type: "turn.ended", agentId: "main", turnId: 1, reason: "completed", time: 975 },
			]),
		);
		expect((await read(baseline?.cursor))?.events).toMatchObject([
			{
				eventId: "kimi:native:delayed-by-compaction",
				observedAtMs: 950,
				acceptedNativeAgentTurnIsInProgress: false,
			},
		]);
	});
	it("已有游标的新 pending 已完整回查到仍在运行的尾部时，可确认进行中", async () => {
		const { path, read, summary } = await fixture();
		const baseline = await read();
		markPending(summary);
		await appendFile(path, serialize(promptRecords("running-after-baseline", 1100, "继续", 9)));
		const recovered = await read(baseline?.cursor);
		expect(recovered?.moreAppendedTranscriptBytesRemain).toBe(true);
		expect(recovered?.events).toMatchObject([
			{ eventId: "kimi:native:running-after-baseline", acceptedNativeAgentTurnIsInProgress: true },
		]);
		expect((await read(recovered?.cursor))?.events).toEqual([]);
	});
	it("已落盘结束记录超出增量预算时，只确认接受且不重开已结束回合", async () => {
		const { path, read, summary } = await fixture();
		markPending(summary);
		const baseline = await read();
		const appendedTranscript = serialize([
			...promptRecords("completed-across-read-batches", 1100, "继续", 7),
			...[240_000, 100_000].map((outputBytes) => ({
				type: "context.append_message",
				agentId: "main",
				time: 1150,
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(outputBytes) }] },
			})),
			{ type: "turn.ended", agentId: "main", turnId: 7, reason: "completed", time: 1200 },
		]);
		expect(Buffer.byteLength(appendedTranscript)).toBeGreaterThan(256 * 1024);
		await appendFile(path, appendedTranscript);
		const firstBatch = await read(baseline?.cursor);
		expect(firstBatch?.moreAppendedTranscriptBytesRemain).toBe(true);
		expect(firstBatch?.events).toMatchObject([
			{
				eventId: "kimi:native:completed-across-read-batches",
				evidenceKind: "native_user_prompt_acceptance",
				acceptedNativeAgentTurnIsInProgress: false,
			},
		]);
		const remainingBatch = await read(firstBatch?.cursor);
		expect(remainingBatch?.events).toEqual([]);
		expect(remainingBatch?.moreAppendedTranscriptBytesRemain).toBe(false);
		if (remainingBatch?.cursor?.transport !== "kimi_wire") throw new Error("缺少 Kimi 增量游标");
		expect(remainingBatch.cursor.endedTurnIds).toContain(7);
		expect((await read(remainingBatch.cursor))?.events).toEqual([]);
	});
	it("末尾半行结束记录尚未读全时，只确认接受而不推断回合进行中", async () => {
		const { path, read, summary } = await fixture();
		markPending(summary);
		const baseline = await read();
		const endedTurnLine = JSON.stringify({
			type: "turn.ended",
			agentId: "main",
			turnId: 8,
			reason: "completed",
			time: 1200,
		});
		await appendFile(
			path,
			serialize(promptRecords("partial-turn-ending", 1100, "继续", 8)) + endedTurnLine.slice(0, -3),
		);
		const partial = await read(baseline?.cursor);
		expect(partial?.moreAppendedTranscriptBytesRemain).toBe(false);
		expect(partial?.events).toMatchObject([
			{ eventId: "kimi:native:partial-turn-ending", acceptedNativeAgentTurnIsInProgress: false },
		]);
		await appendFile(path, `${endedTurnLine.slice(-3)}\n`);
		const complete = await read(partial?.cursor);
		expect(complete?.events).toEqual([]);
		if (complete?.cursor?.transport !== "kimi_wire") throw new Error("缺少 Kimi 增量游标");
		expect(complete.cursor.endedTurnIds).toContain(8);
	});
	it("大转录只回查有界尾部；尾部之外的旧接受证据不会被猜成已确认", async () => {
		const { path, read, summary } = await fixture();
		markPending(summary);
		await appendFile(
			path,
			serialize([
				...promptRecords("outside-budget", 1100),
				...Array.from({ length: 4 }, () => ({
					type: "context.append_message",
					agentId: "main",
					time: 1200,
					message: { role: "assistant", content: "x".repeat(100_000) },
				})),
			]),
		);
		const baseline = await read();
		expect(baseline?.events).toEqual([]);
		await appendFile(path, serialize(promptRecords("inside-budget", 1300)));
		expect((await read(baseline?.cursor))?.events).toMatchObject([{ eventId: "kimi:native:inside-budget" }]);
	});
	it("新 pending 回查不会跳过超预算增量，尾部半行完成后仅按原生 ID 确认一次", async () => {
		const { path, read, summary } = await fixture();
		const baseline = await read();
		if (baseline?.cursor?.transport !== "kimi_wire") throw new Error("缺少 Kimi 基线游标");
		markPending(summary);
		const assistantRecord = {
			type: "context.append_message",
			agentId: "main",
			time: 1150,
			message: { role: "assistant", content: "x".repeat(100_000) },
		};
		const appendedTranscript = serialize([
			assistantRecord,
			...promptRecords("before-lookback-tail", 1100),
			...Array.from({ length: 5 }, () => assistantRecord),
		]);
		const incrementalReadByteBudget = 256 * 1024;
		expect(Buffer.byteLength(appendedTranscript)).toBeGreaterThan(2 * incrementalReadByteBudget);
		const splitPrompt = Buffer.from(serialize(promptRecords("after-backlog", 1200)));
		const splitAt = splitPrompt.indexOf(Buffer.from("中文")) + 1;
		await appendFile(path, Buffer.concat([Buffer.from(appendedTranscript), splitPrompt.subarray(0, splitAt)]));
		let cursor: NativeAgentConversationActivityReadCursor = baseline.cursor;
		let previousByteOffset = baseline.cursor.nextByteOffset;
		const observedEventIds: Array<string | undefined> = [];
		const cursorByteAdvancements: number[] = [];
		for (let readAttempt = 0; readAttempt < 6; readAttempt += 1) {
			const result = await read(cursor);
			if (result?.cursor?.transport !== "kimi_wire") throw new Error("缺少 Kimi 增量游标");
			if (readAttempt === 0) expect(result.moreAppendedTranscriptBytesRemain).toBe(true);
			observedEventIds.push(...result.events.map((event) => event.eventId));
			cursorByteAdvancements.push(result.cursor.nextByteOffset - previousByteOffset);
			previousByteOffset = result.cursor.nextByteOffset;
			cursor = result.cursor;
		}
		expect(observedEventIds).toEqual(["kimi:native:before-lookback-tail"]);
		for (const byteAdvancement of cursorByteAdvancements) {
			expect(byteAdvancement).toBeGreaterThanOrEqual(0);
			expect(byteAdvancement).toBeLessThanOrEqual(incrementalReadByteBudget);
		}
		expect(previousByteOffset).toBe(
			baseline.cursor.nextByteOffset + Buffer.byteLength(appendedTranscript) + splitPrompt.indexOf(0x0a) + 1,
		);
		await appendFile(path, splitPrompt.subarray(splitAt));
		const complete = await read(cursor);
		expect(complete?.events).toMatchObject([{ eventId: "kimi:native:after-backlog" }]);
		await appendFile(path, serialize(promptRecords("before-lookback-tail", 1300)));
		expect((await read(complete?.cursor))?.events).toEqual([]);
	});
	it("首次只建基线，后续同正文按原生 ID 分开确认并排除 hook 附加正文", async () => {
		const { path, read } = await fixture();
		await appendFile(path, serialize(promptRecords("history", 200)));
		const baseline = await read();
		expect(baseline?.events).toEqual([]);
		await appendFile(path, serialize([...promptRecords("first", 1100), ...promptRecords("second", 1200)]));
		const result = await read(baseline?.cursor);
		expect(result?.events).toMatchObject([
			{
				eventId: "kimi:native:first",
				submittedPromptText: "重复正文\u2028\u2029中文",
				acceptedNativeAgentTurnIsInProgress: true,
			},
			{ eventId: "kimi:native:second", submittedPromptText: "重复正文\u2028\u2029中文" },
		]);
		await appendFile(path, serialize(promptRecords("first", 1300)));
		expect((await read(result?.cursor))?.events).toEqual([]);
	});
	it("首次身份观察晚于接受时，仅回查同代 pending 之后的记录；已结束回合不能重开", async () => {
		const { path, read, summary } = await fixture();
		markPending(summary);
		await appendFile(
			path,
			serialize([
				...promptRecords("old", 900),
				...promptRecords("accepted-before-baseline", 1100, "继续", 1),
				{ type: "context.apply_compaction", agentId: "main", time: 1150 },
				{ type: "turn.ended", agentId: "main", turnId: 1, reason: "completed", time: 1200 },
			]),
		);
		const result = await read();
		expect(result?.events).toMatchObject([
			{ eventId: "kimi:native:accepted-before-baseline", acceptedNativeAgentTurnIsInProgress: false },
		]);
		expect((await read(result?.cursor))?.events).toEqual([]);
	});
	it("候选晚于基线回调时仍可恢复该候选之后的真实接受，后续 hook null 路径不重置游标", async () => {
		const { path, summary } = await fixture();
		await appendFile(path, serialize(promptRecords("race", 1100)));
		const onAccepted = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({ onAccepted, cooldownMs: 0, nowMs: () => 1200 });
		try {
			await observer.observeTaskSessionSummary("workspace", summary, () => summary);
			expect(onAccepted).not.toHaveBeenCalled();
			markPending(summary);
			await observer.observeTaskSessionSummary("workspace", summary, () => summary);
			expect(onAccepted).toHaveBeenCalledTimes(1);
			await observer.observeTaskSessionSummary("workspace", { ...summary }, () => summary);
			expect(onAccepted).toHaveBeenCalledTimes(1);
			expect(summary.agentNativeConversationSessionIdentity?.transcriptPath).toBeNull();
		} finally {
			observer.dispose();
		}
	});
	it("LF 完成才确认，UTF-8 与 Unicode 分隔符不拆行", async () => {
		const { path, read } = await fixture();
		const baseline = await read();
		const data = Buffer.from(serialize(promptRecords("split", 1100)));
		const cut = data.indexOf(Buffer.from("中文")) + 1;
		await appendFile(path, data.subarray(0, cut));
		const partial = await read(baseline?.cursor);
		expect(partial?.events).toEqual([]);
		await appendFile(path, data.subarray(cut));
		const complete = await read(partial?.cursor);
		expect(complete?.events).toHaveLength(1);
	});
	it.each(kimiNativeWireMediaContentParts)("$type 真人仅附件输入可确认，正文保持缺省", async (mediaPart) => {
		const { path, read } = await fixture();
		const baseline = await read();
		await appendFile(
			path,
			serialize([
				{
					type: "context.append_message",
					agentId: "main",
					time: 1300,
					message: {
						id: "attachment",
						role: "user",
						origin: { kind: "user" },
						content: [mediaPart],
					},
				},
			]),
		);
		const attachment = await read(baseline?.cursor);
		expect(attachment?.events).toEqual([
			{
				observedAtMs: 1300,
				activityKind: "accepted_user_input",
				evidenceKind: "native_user_prompt_acceptance",
				eventId: "kimi:native:attachment",
				nativeSessionId: "native",
				acceptedNativeAgentTurnIsInProgress: false,
			},
		]);
	});
	it("空内容、未知媒体类型及缺失或无效 URL 载荷均不能确认", async () => {
		const { path, read } = await fixture();
		const baseline = await read();
		const invalidContents = [
			[],
			[null],
			[{ type: "text", text: " \n" }],
			...["image", "audio", "video", "file"].map((type) => [{ type, url: "https://example.invalid/fixture" }]),
			...[
				{ type: "image_url", payloadKey: "imageUrl" },
				{ type: "audio_url", payloadKey: "audioUrl" },
				{ type: "video_url", payloadKey: "videoUrl" },
			].flatMap(({ type, payloadKey }) =>
				[
					undefined,
					null,
					"https://example.invalid/fixture",
					{},
					{ url: null },
					{ url: 123 },
					{ url: "" },
					{ url: " \n" },
				].map((payload) => [{ type, [payloadKey]: payload }]),
			),
			[{ type: "image_url", image_url: { url: "https://example.invalid/fixture.png" } }],
			[{ type: "audio_url", audio_url: { url: "https://example.invalid/fixture.wav" } }],
			[{ type: "video_url", video_url: { url: "https://example.invalid/fixture.mp4" } }],
		];
		await appendFile(
			path,
			serialize(
				invalidContents.map((content, index) => ({
					type: "context.append_message",
					agentId: "main",
					time: 1100 + index,
					message: { id: `invalid-media-${index}`, role: "user", origin: { kind: "user" }, content },
				})),
			),
		);
		expect((await read(baseline?.cursor))?.events).toEqual([]);
	});
	it("有效媒体来自 hook、注入或子代理时仍不能确认", async () => {
		const { path, read } = await fixture();
		const baseline = await read();
		await appendFile(
			path,
			serialize(
				kimiNativeWireMediaContentParts.flatMap((mediaPart) => {
					const record = {
						type: "context.append_message",
						agentId: "main",
						time: 1300,
						message: {
							id: `non-user-${mediaPart.type}`,
							role: "user",
							origin: { kind: "user" },
							content: [mediaPart],
						},
					};
					return [
						{ ...record, agentId: "agent-1" },
						{ ...record, message: { ...record.message, origin: { kind: "injection" } } },
						{
							...record,
							message: {
								...record.message,
								content: [{ ...mediaPart, meta: { source: "user prompt submit hook" } }],
							},
						},
					];
				}),
			),
		);
		expect((await read(baseline?.cursor))?.events).toEqual([]);
	});
	it("基线末尾半行保留到后续 LF，不跳过首次输入", async () => {
		const { path, read } = await fixture();
		const line = JSON.stringify(promptRecords("partial-baseline", 1100)[1]);
		await appendFile(path, line.slice(0, -5));
		const baseline = await read();
		await appendFile(path, `${line.slice(-5)}\n`);
		expect((await read(baseline?.cursor))?.events).toHaveLength(1);
	});
	it("排队、子代理、注入、压缩、系统触发和 hook 结果均不能确认", async () => {
		const { path, read } = await fixture();
		const baseline = await read();
		const message = promptRecords("ignored", 1100)[1];
		await appendFile(
			path,
			serialize([
				{ type: "agent.message.appended", agentId: "main", time: 1100, message: message?.message },
				{ ...message, agentId: "agent-1" },
				...["injection", "system_trigger", "cron_job", "hook_result", "shell_command"].map((kind) => ({
					...message,
					message: { ...message?.message, origin: { kind } },
				})),
				{ type: "context.apply_compaction", agentId: "main", time: 1200, message: message?.message },
				{
					...message,
					message: {
						...message?.message,
						content: [{ type: "text", text: "hook", meta: { source: "user prompt submit hook" } }],
					},
				},
			]),
		);
		expect((await read(baseline?.cursor))?.events).toEqual([]);
	});
	it.each(["id", "cwd", "protocol", "index", "incarnation"])("%s 不匹配时保留未知", async (mismatch) => {
		const { path, read, statePath, home, summary } = await fixture();
		markPending(summary);
		await appendFile(path, serialize(promptRecords("candidate", 1100)));
		if (mismatch === "id" || mismatch === "cwd")
			await writeFile(
				statePath,
				JSON.stringify({
					version: 2,
					id: mismatch === "id" ? "other" : "native",
					cwd: mismatch === "cwd" ? "/other" : summary.workspacePath,
				}),
			);
		if (mismatch === "protocol")
			await writeFile(
				path,
				serialize([{ ...header, protocol_version: "9.9" }, ...promptRecords("candidate", 1100)]),
			);
		if (mismatch === "index")
			await writeFile(
				join(home, "session_index.jsonl"),
				serialize([{ sessionId: "other", sessionDir: home, workDir: summary.workspacePath }]),
			);
		if (mismatch === "incarnation" && summary.agentConversationPromptSubmissionAcceptance)
			summary.agentConversationPromptSubmissionAcceptance.runtimeSessionIncarnationId = "old";
		const result = await read();
		expect(result?.events ?? []).toEqual([]);
	});
	it("转录替换仅建立新基线，旧消息复制和未知记录不重报", async () => {
		const { path, read } = await fixture();
		const baseline = await read();
		await rename(path, `${path}.old`);
		await writeFile(
			path,
			serialize([header, ...promptRecords("old-copy", 900), { type: "future.record", time: 1300 }]),
		);
		expect((await read(baseline?.cursor))?.events).toEqual([]);
	});
});
