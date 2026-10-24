import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyCodexAutomaticCompactionPhaseObservation,
	createCodexRvfCloseoutCompactionAwareConfirmation,
} from "../../../src/core/codex-rvf-closeout-compaction-aware-confirmation";
import {
	createPendingTaskMessageInjectionRecord,
	persistTaskMessageNativeCompactionAwareConfirmation,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	resolvePendingRecordBecomesStaleAtEpochMs,
	sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart,
} from "../../../src/core/task-message-injection-ledger";

describe("单条 RVF 压缩确认快照的清扫与 CAS", () => {
	let root: string;
	let ledgerPath: string;
	const initial = () =>
		createCodexRvfCloseoutCompactionAwareConfirmation({
			binding: {
				workspaceId: "isolated",
				taskId: "task",
				conversationSessionId: "session",
				decisionToken: "token",
				runId: "run",
				handoffSha256: "a".repeat(64),
				idempotencyKey: "key",
				promptSha256: "b".repeat(64),
				nativeSessionId: "native",
				runtimeSessionIncarnationId: "generation",
				controlHostSocketPath: "/isolated/control.sock",
				terminalSessionSpawnedAtEpochMs: 1,
			},
			firstSubmissionAtEpochMs: 1_000,
			submissionTransport: "codex_native_request",
			clientUserMessageId: "client",
			predecessorNativeTurnId: "old-turn",
			lastHumanInputAtSubmission: null,
		});
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "rvf-compaction-ledger-"));
		ledgerPath = join(root, "task-message-injections.json");
		await writeFile(
			ledgerPath,
			JSON.stringify([
				createPendingTaskMessageInjectionRecord({
					taskId: "task",
					attemptId: "session",
					source: "rvf_automatic_closeout",
					idempotencyKey: "key",
					promptSha256: "b".repeat(64),
					nowIso: new Date(0).toISOString(),
				}),
			]),
		);
	});
	afterEach(async () => rm(root, { recursive: true, force: true }));
	const save = (snapshot: ReturnType<typeof initial>, expectedRevision: number | null) =>
		persistTaskMessageNativeCompactionAwareConfirmation({
			ledgerPath,
			ledgerTaskId: "task",
			snapshot,
			expectedRevision,
		});

	it("有界压缩超过旧 196.5 秒仍合法等待，新的固定截止后才清扫", async () => {
		const first = initial();
		expect(await save(first, null)).toBe(true);
		const compacting = applyCodexAutomaticCompactionPhaseObservation(first, {
			phase: "started",
			nativeTurnId: "new-turn",
			capturedAtEpochMs: 3_000,
			receivedAtEpochMs: 3_000,
			hookDeliveryId: "pre",
		});
		expect(await save(compacting, 0)).toBe(true);
		const sweep = (nowMs: number) =>
			sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
				ledgerPath,
				nowIso: new Date(nowMs).toISOString(),
				stalePendingThresholdMs: 201_500,
			});
		expect((await sweep(250_000)).sweptCount).toBe(0);
		expect((await sweep(308_001)).sweptCount).toBe(1);
		expect((await readTaskMessageInjectionLedger(ledgerPath))[0]).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "runtime_restarted_before_confirmation",
			nativeCompactionAwareConfirmation: compacting,
		});
	});

	it("并发旧 revision 不覆盖新阶段；已确认记录不被巡检或晚到写入改变", async () => {
		const first = initial();
		expect(await save(first, null)).toBe(true);
		expect(await save(first, null)).toBe(true);
		const next = { ...first, nativeTurnId: "turn", revision: 1 };
		expect(await save(next, 9)).toBe(false);
		expect(await save(next, 0)).toBe(true);
		expect(await save(first, null)).toBe(false);
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "task",
			idempotencyKey: "key",
			status: "delivered_and_submit_confirmed",
			nowIso: new Date(6_000).toISOString(),
		});
		const before = await readFile(ledgerPath, "utf8");
		expect(await save({ ...next, revision: 2 }, 1)).toBe(false);
		await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
			ledgerPath,
			nowIso: new Date(900_000).toISOString(),
			stalePendingThresholdMs: 201_500,
		});
		expect(await readFile(ledgerPath, "utf8")).toBe(before);
	});

	it("绑定与原文摘要不可换；旧记录不自动获得 5 分钟预算", async () => {
		const first = initial();
		expect(await save({ ...first, binding: { ...first.binding, promptSha256: "c".repeat(64) } }, null)).toBe(false);
		const oldRecord = (await readTaskMessageInjectionLedger(ledgerPath))[0];
		if (!oldRecord) throw new Error("隔离记录缺失");
		expect(resolvePendingRecordBecomesStaleAtEpochMs(oldRecord, 201_500)).toBe(201_500);
		expect(await save(first, null)).toBe(true);
		expect(await save({ ...first, revision: 1, binding: { ...first.binding, nativeSessionId: "other" } }, 0)).toBe(
			false,
		);
	});

	it("提交响应关联写入后不可换绑或删除，再写新 revision 也不能夺取归属", async () => {
		const first = initial();
		expect(await save(first, null)).toBe(true);
		const correlated = {
			...first,
			revision: 1,
			nativeTurnId: "submitted-turn",
			nativeTurnIdReturnedBySubmissionRequest: "submitted-turn",
		};
		expect(await save(correlated, 0)).toBe(true);
		expect((await readTaskMessageInjectionLedger(ledgerPath))[0]?.nativeCompactionAwareConfirmation).toMatchObject({
			nativeTurnIdReturnedBySubmissionRequest: "submitted-turn",
		});
		const before = await readFile(ledgerPath, "utf8");
		expect(
			await save(
				{
					...correlated,
					revision: 2,
					nativeTurnId: "unrelated-turn",
					nativeTurnIdReturnedBySubmissionRequest: "unrelated-turn",
				},
				1,
			),
		).toBe(false);
		expect(await save({ ...first, revision: 2, nativeTurnId: "submitted-turn" }, 1)).toBe(false);
		expect(await readFile(ledgerPath, "utf8")).toBe(before);
	});
});
