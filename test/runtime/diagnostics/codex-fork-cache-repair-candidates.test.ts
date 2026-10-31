import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildCodexForkModeParameters,
	codexRepairContextIsComplete,
	codexRepairLiveRunIsComplete,
	persistedCodexThreadLoadMatchesFrozenConfiguration,
	recoverAppServerAcceptedTurnId,
	selectBoundRepairOperation,
	summarizeAppServerTurnMeasurement,
	verifyAppServerForkInheritance,
	verifyAppServerHistoryNonceRecall,
} from "../../../scripts/measure-codex-fork-cache-repair-candidates.mjs";

const repairScript = fileURLToPath(
	new URL("../../../scripts/measure-codex-fork-cache-repair-candidates.mjs", import.meta.url),
);
const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), ".codex-repair-resume-scratch");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function writeFakeCodex(directory: string) {
	const binary = join(directory, "fake-codex.mjs");
	const log = join(directory, "fake-requests.jsonl");
	const source = [
		"#!/usr/bin/env node",
		"import { appendFileSync } from 'node:fs';",
		"import { createInterface } from 'node:readline';",
		"if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.166.0\\n'); process.exit(0); }",
		`const logPath = ${JSON.stringify(log)};`,
		"const loadedThreads = new Set();",
		"const lines = createInterface({ input: process.stdin });",
		"lines.on('line', (line) => {",
		"  const frame = JSON.parse(line);",
		"  appendFileSync(logPath, JSON.stringify(frame) + '\\n');",
		"  if (frame.id === undefined) return;",
		"  if (frame.method === 'initialize') { process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n'); return; }",
		"  if (frame.method === 'thread/start') { loadedThreads.add('started-parent'); process.stdout.write(JSON.stringify({ id: frame.id, result: { thread: { id: 'started-parent' }, model: 'gpt-6.1-sol', reasoningEffort: 'max' } }) + '\\n'); return; }",
		"  if (frame.method === 'thread/resume') {",
		"    if (frame.params.threadId === 'missing-thread') { process.stdout.write(JSON.stringify({ id: frame.id, error: { code: -32000, message: 'thread not found' } }) + '\\n'); return; }",
		"    const model = frame.params.threadId === 'mismatch-thread' ? 'other-model' : 'gpt-6.1-sol';",
		"    const approvalPolicy = frame.params.threadId === 'approval-mismatch-thread' ? 'on-request' : 'never';",
		"    const thread = { id: frame.params.threadId };",
		"    if (frame.params.threadId === 'child-thread') thread.forkedFromId = 'parent-thread';",
		"    loadedThreads.add(frame.params.threadId);",
		"    process.stdout.write(JSON.stringify({ id: frame.id, result: { thread, model, reasoningEffort: 'max', approvalPolicy, sandbox: 'read-only' } }) + '\\n');",
		"    return;",
		"  }",
		"  if (frame.method === 'turn/start') process.stdout.write(JSON.stringify({ id: frame.id, error: { code: -32000, message: loadedThreads.has(frame.params.threadId) ? 'fixture-stop-before-model' : 'fixture-thread-not-loaded' } }) + '\\n');",
		"});",
		"process.stdin.on('end', () => process.exit(0));",
		"",
	].join("\n");
	writeFileSync(binary, source, { mode: 0o700 });
	chmodSync(binary, 0o700);
	return { binary, log };
}

function writeManifest(evidence: string, binary: string, context: unknown, modes: string[] = ["persistent"]) {
	writeFileSync(
		join(evidence, "repair-run-manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			createdAt: "2026-10-31T00:00:00.000Z",
			runId: "fixture-run",
			binary,
			binaryLabel: "official",
			version: "codex-cli 0.166.0",
			binarySha256: digest(readFileSync(binary)),
			options: {
				contexts: [32_000],
				modes,
				forkCount: 1,
				historyMode: "paginated",
				binaryLabel: "official",
				analyzeOnly: false,
				evidenceDirectory: evidence,
				binary,
			},
			configuration: { model: "gpt-6.1-sol", reasoning: "max" },
			contexts: [context],
		}),
		{ mode: 0o600 },
	);
}

function runRepair(evidence: string, binary: string, modes = "persistent") {
	const env = { ...process.env };
	delete env.OPENAI_API_KEY;
	return spawnSync(
		process.execPath,
		[
			repairScript,
			"--codex-binary",
			binary,
			"--evidence-directory",
			evidence,
			"--context-tokens",
			"32000",
			"--fork-modes",
			modes,
			"--fork-count",
			"1",
		],
		{ encoding: "utf8", env, timeout: 20_000 },
	);
}

function recordedMethods(log: string) {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { method?: string; params?: { threadId?: string } });
}

function completedOperation(key: string, threadId: string, inputTokens: number, cachedInputTokens: number) {
	return {
		key,
		threadId,
		status: "completed",
		marker: key,
		prompt: `${key}\n只答 OK。`,
		model: "gpt-6.1-sol",
		configurationFingerprint: "same-fingerprint",
		measurement: {
			completed: true,
			accepted: true,
			problems: [],
			requests: [
				{
					inputTokens,
					cachedInputTokens,
					outputTokens: 5,
					model: "gpt-6.1-sol",
					configurationFingerprint: "same-fingerprint",
				},
			],
		},
	};
}

const marker = "CACHE_MEASUREMENT_REQUEST=fixture-native-turn";
const userItem = {
	method: "item/completed",
	params: { threadId: "child", turnId: "turn", item: { type: "userMessage", content: [{ text: marker }] } },
};
const usage = (inputTokens = 32_000, cachedInputTokens = 31_872) => ({
	method: "thread/tokenUsage/updated",
	params: {
		threadId: "child",
		turnId: "turn",
		tokenUsage: {
			total: { inputTokens: 999_999, cachedInputTokens: 999_999 },
			last: { inputTokens, cachedInputTokens, outputTokens: 5 },
		},
	},
});
const completed = {
	method: "turn/completed",
	params: { threadId: "child", turn: { id: "turn", status: "completed", error: null } },
};

describe("Codex 修复候选的原生 app-server 计量", () => {
	it("响应落盘前中断时，只从唯一且绑定线程与随机标记的接受记录恢复回合身份", () => {
		expect(recoverAppServerAcceptedTurnId([userItem, userItem], "child", marker)).toBe("turn");
		expect(recoverAppServerAcceptedTurnId([userItem], "other-child", marker)).toBeNull();
		expect(recoverAppServerAcceptedTurnId([userItem], "child", "other-marker")).toBeNull();
		const duplicateSubmission = { ...userItem, params: { ...userItem.params, turnId: "second-turn" } };
		expect(recoverAppServerAcceptedTurnId([userItem, duplicateSubmission], "child", marker)).toBeNull();
	});
	it("临时、预测与持久化 fork 使用明确父身份；excludeTurns 只控制返回数据", () => {
		expect(buildCodexForkModeParameters("persistent", "parent")).toEqual({ threadId: "parent", excludeTurns: true });
		expect(buildCodexForkModeParameters("ephemeral", "parent")).toEqual({
			threadId: "parent",
			excludeTurns: true,
			ephemeral: true,
		});
		expect(buildCodexForkModeParameters("prediction-ephemeral", "parent")).toEqual({
			threadId: "parent",
			excludeTurns: true,
			ephemeral: true,
			experimentalPredictionMode: true,
		});
		expect(() => buildCodexForkModeParameters("unknown", "parent")).toThrow();
	});
	it("只取绑定 thread 与 turn 的 last，用量累计值和其他回合不混入", () => {
		const other = usage(100_000, 0);
		other.params.turnId = "inherited-turn";
		const result = summarizeAppServerTurnMeasurement(
			[other, userItem, usage(), usage(), completed],
			"child",
			"turn",
			marker,
		);
		expect(result).toMatchObject({ completed: true, accepted: true, problems: [] });
		expect(result.requests).toEqual([{ inputTokens: 32_000, cachedInputTokens: 31_872, outputTokens: 5 }]);
	});
	it("缺用量、缺用户接受、错误回合以及多模型请求不冒充成功", () => {
		for (const frames of [
			[userItem, completed],
			[usage(), completed],
			[userItem, usage()],
			[userItem, usage(), usage(33_000, 32_000), completed],
		]) {
			expect(summarizeAppServerTurnMeasurement(frames, "child", "turn", marker).problems.length).toBeGreaterThan(0);
		}
		const bad = usage();
		Reflect.deleteProperty(bad.params.tokenUsage.last, "cachedInputTokens");
		expect(
			summarizeAppServerTurnMeasurement([userItem, bad, completed], "child", "turn", marker).problems.length,
		).toBeGreaterThan(0);
	});
	it("压缩作为 item 事件出现时也不能作有效对照", () => {
		const compaction = {
			method: "item/completed",
			params: { threadId: "child", turnId: "turn", item: { type: "contextCompaction" } },
		};
		expect(
			summarizeAppServerTurnMeasurement([userItem, compaction, usage(), completed], "child", "turn", marker)
				.problems,
		).toContain("本轮发生压缩");
	});
	it("原生历史接口不可用时，绑定回合必须正确回读父历史中的两段随机标记", () => {
		const prompts = [
			"CACHE_MEASUREMENT_REQUEST=first-secret\n父资料",
			"CACHE_MEASUREMENT_REQUEST=second-secret\n热续跑",
		];
		const answer = (text: string, threadId = "child") => ({
			method: "item/completed",
			params: { threadId, turnId: "turn", item: { type: "agentMessage", text } },
		});
		expect(
			verifyAppServerHistoryNonceRecall([answer('["first-secret","second-secret"]')], "child", "turn", prompts),
		).toBe(true);
		for (const frame of [
			answer('["first-secret"]'),
			answer('["first-secret","wrong-secret"]'),
			answer('["first-secret","second-secret"]', "other"),
		]) {
			expect(verifyAppServerHistoryNonceRecall([frame], "child", "turn", prompts)).toBe(false);
		}
	});

	it("临时 fork 也必须有独立身份、原生父归属及完整父提示词", () => {
		const thread = { id: "child", forkedFromId: "parent" };
		expect(
			verifyAppServerForkInheritance(thread, "parent", [{ text: marker }, { text: "热续跑" }], [marker, "热续跑"]),
		).toBe(true);
		expect(verifyAppServerForkInheritance(thread, "parent", [{ text: marker }], [marker, "热续跑"])).toBe(false);
		expect(
			verifyAppServerForkInheritance({ ...thread, forkedFromId: "wrong" }, "parent", [{ text: marker }], [marker]),
		).toBe(false);
	});

	afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

	it("拒绝重复 fork 模式，并且不把一个子线程的计量绑到另一个子线程", () => {
		mkdirSync(scratchRoot, { recursive: true });
		const result = spawnSync(
			process.execPath,
			[
				repairScript,
				"--codex-binary",
				process.execPath,
				"--evidence-directory",
				join(scratchRoot, "duplicate-modes"),
				"--fork-modes",
				"persistent,persistent",
				"--context-tokens",
				"32000",
				"--fork-count",
				"1",
			],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("fork 模式不能重复");
		expect(
			selectBoundRepairOperation([{ key: "persistent-1-first", threadId: "child-a" }], {
				key: "persistent-1-first",
				thread: { id: "child-b" },
			}),
		).toBeUndefined();
		expect(
			selectBoundRepairOperation([{ key: "persistent-1-first", threadId: "child-a" }], {
				key: "persistent-1-first",
				thread: { id: "child-a" },
			})?.threadId,
		).toBe("child-a");
	});

	it("prepared 基线在同目录恢复时继续发送，submitting 不重发", () => {
		mkdirSync(scratchRoot, { recursive: true });
		const prepared = mkdtempSync(join(scratchRoot, "prepared-"));
		const submitting = mkdtempSync(join(scratchRoot, "submitting-"));
		try {
			const preparedFake = writeFakeCodex(prepared);
			writeManifest(prepared, preparedFake.binary, {
				targetTokens: 32_000,
				status: "awaiting_native_evidence",
				operations: [
					{
						key: "cold-prefix-baseline",
						threadId: "baseline-thread",
						marker: "CACHE_MEASUREMENT_REQUEST=prepared-baseline",
						prompt: "CACHE_MEASUREMENT_REQUEST=prepared-baseline\n不要调用工具，不要修改文件，只答 OK。",
						status: "prepared",
						model: "gpt-6.1-sol",
						configurationFingerprint: "fingerprint",
					},
				],
				forks: [],
			});
			const preparedRun = runRepair(prepared, preparedFake.binary);
			expect(preparedRun.status, preparedRun.stderr).toBe(2);
			const preparedFrames = recordedMethods(preparedFake.log);
			expect(preparedFrames.some((frame) => frame.method === "thread/start")).toBe(false);
			// 新 app-server 的内存注册表为空，必须先精确载入已有原生线程。
			expect(preparedFrames.filter((frame) => frame.method === "thread/resume")).toEqual([
				expect.objectContaining({ params: expect.objectContaining({ threadId: "baseline-thread" }) }),
			]);
			expect(preparedFrames.findIndex((frame) => frame.method === "thread/resume")).toBeLessThan(
				preparedFrames.findIndex((frame) => frame.method === "turn/start"),
			);
			expect(preparedFrames.filter((frame) => frame.method === "turn/start")).toEqual([
				expect.objectContaining({ params: expect.objectContaining({ threadId: "baseline-thread" }) }),
			]);

			const submittingFake = writeFakeCodex(submitting);
			writeManifest(submitting, submittingFake.binary, {
				targetTokens: 32_000,
				status: "running",
				operations: [
					{
						key: "cold-prefix-baseline",
						threadId: "baseline-thread",
						marker: "CACHE_MEASUREMENT_REQUEST=submitting-baseline",
						prompt: "CACHE_MEASUREMENT_REQUEST=submitting-baseline\n不要调用工具，不要修改文件，只答 OK。",
						status: "submitting",
						model: "gpt-6.1-sol",
						configurationFingerprint: "fingerprint",
					},
				],
				forks: [],
			});
			const submittingRun = runRepair(submitting, submittingFake.binary);
			expect(submittingRun.status, submittingRun.stderr).toBe(2);
			expect(recordedMethods(submittingFake.log).some((frame) => frame.method === "turn/start")).toBe(false);
		} finally {
			rmSync(prepared, { recursive: true, force: true });
			rmSync(submitting, { recursive: true, force: true });
		}
	});

	it("只完成冷基线时继续未创建的父步骤，第二轮失败则保留首轮并让矩阵未完成", () => {
		mkdirSync(scratchRoot, { recursive: true });
		const continued = mkdtempSync(join(scratchRoot, "continued-"));
		const second = mkdtempSync(join(scratchRoot, "second-"));
		try {
			const continuedFake = writeFakeCodex(continued);
			writeManifest(continued, continuedFake.binary, {
				targetTokens: 32_000,
				status: "running",
				operations: [completedOperation("cold-prefix-baseline", "baseline-thread", 11_400, 0)],
				forks: [],
			});
			const continuedRun = runRepair(continued, continuedFake.binary);
			expect(continuedRun.status, continuedRun.stderr).toBe(2);
			const continuedFrames = recordedMethods(continuedFake.log);
			expect(continuedFrames.some((frame) => frame.method === "thread/start")).toBe(true);
			expect(
				continuedFrames.some(
					(frame) => frame.method === "turn/start" && frame.params?.threadId === "baseline-thread",
				),
			).toBe(false);
			expect(continuedFrames.some((frame) => frame.method === "turn/start")).toBe(true);

			const parentTranscript = "parent-history\n";
			const parentPath = join(second, "parent.jsonl");
			writeFileSync(parentPath, parentTranscript, { mode: 0o600 });
			const secondFake = writeFakeCodex(second);
			writeManifest(second, secondFake.binary, {
				targetTokens: 32_000,
				status: "running",
				parent: { thread: { id: "parent-thread" }, model: "gpt-6.1-sol", reasoningEffort: "max" },
				parentTranscriptPath: parentPath,
				frozenParentSha256: digest(parentTranscript),
				operations: [
					completedOperation("cold-prefix-baseline", "baseline-thread", 11_400, 0),
					completedOperation("parent-create", "parent-thread", 32_000, 0),
					completedOperation("parent-hot-before", "parent-thread", 32_100, 31_872),
					completedOperation("parent-hot-after", "parent-thread", 32_200, 31_872),
					completedOperation("persistent-1-first", "child-thread", 32_100, 31_872),
					{
						key: "persistent-second-control",
						threadId: "child-thread",
						status: "insufficient_evidence",
						marker: "persistent-second-control",
						prompt: "persistent-second-control\n只答 OK。",
						model: "gpt-6.1-sol",
						measurement: {
							completed: false,
							accepted: false,
							problems: ["缺少绑定回合的成功结束记录"],
							requests: [],
						},
					},
				],
				forks: [
					{
						mode: "persistent",
						index: 1,
						key: "persistent-1-first",
						status: "completed",
						thread: { id: "child-thread" },
						historyVerified: true,
						parentUnchanged: true,
					},
				],
			});
			const secondRun = runRepair(second, secondFake.binary);
			expect(secondRun.status, secondRun.stderr).toBe(2);
			expect(recordedMethods(secondFake.log).some((frame) => frame.method === "turn/start")).toBe(false);
			const manifest = JSON.parse(readFileSync(join(second, "repair-run-manifest.json"), "utf8")) as {
				contexts: { status: string }[];
			};
			expect(manifest.contexts[0]?.status).not.toBe("completed");
			const report = JSON.parse(readFileSync(join(second, "repair-measurements.json"), "utf8")) as {
				rows: { status: string; threadId?: string }[];
			};
			expect(report.rows).toEqual([expect.objectContaining({ status: "measured", threadId: "child-thread" })]);
			expect(
				codexRepairContextIsComplete(
					{
						operations: [
							completedOperation("cold-prefix-baseline", "baseline-thread", 1, 0),
							completedOperation("parent-create", "parent-thread", 1, 0),
							completedOperation("parent-hot-before", "parent-thread", 1, 0),
							completedOperation("parent-hot-after", "parent-thread", 1, 0),
							completedOperation("persistent-1-first", "child-thread", 1, 0),
						],
					},
					1,
					["persistent"],
				),
			).toBe(false);
			expect(
				codexRepairLiveRunIsComplete(
					{
						options: { contexts: [32_000], modes: ["persistent"], forkCount: 1 },
						contexts: [
							{
								targetTokens: 32_000,
								operations: [completedOperation("persistent-second-control", "child-thread", 1, 0)],
							},
						],
					},
					[{ status: "measured" }],
				),
			).toBe(false);
		} finally {
			rmSync(continued, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("载入结果必须匹配冻结身份和模型、审批、沙箱配置", () => {
		const expected = {
			threadId: "baseline-thread",
			model: "gpt-6.1-sol",
			reasoningEffort: "max",
			approvalPolicy: "never",
			sandbox: "read-only",
		};
		const loaded = {
			thread: { id: "baseline-thread" },
			model: "gpt-6.1-sol",
			reasoningEffort: "max",
			approvalPolicy: "never",
			sandbox: "read-only" as const,
		};
		expect(persistedCodexThreadLoadMatchesFrozenConfiguration(loaded, expected)).toEqual([]);
		expect(
			persistedCodexThreadLoadMatchesFrozenConfiguration({ ...loaded, sandbox: { type: "readOnly" } }, expected),
		).toEqual([]);
		expect(
			persistedCodexThreadLoadMatchesFrozenConfiguration({ ...loaded, model: "other-model" }, expected).join(" "),
		).toContain("模型");
		expect(
			persistedCodexThreadLoadMatchesFrozenConfiguration({ ...loaded, approvalPolicy: "on-request" }, expected).join(
				" ",
			),
		).toContain("approvalPolicy");
		expect(
			persistedCodexThreadLoadMatchesFrozenConfiguration(
				{ ...loaded, sandbox: "danger-full-access" },
				expected,
			).join(" "),
		).toContain("sandbox");
		expect(
			persistedCodexThreadLoadMatchesFrozenConfiguration(
				{ ...loaded, thread: { id: "child-thread", forkedFromId: "other-parent" } },
				{ ...expected, threadId: "child-thread", forkedFromId: "parent-thread" },
			).join(" "),
		).toContain("父身份");
	});

	it("原生载入被拒绝时 prepared 请求不标成 submitting，也不发送 turn/start", () => {
		mkdirSync(scratchRoot, { recursive: true });
		const directory = mkdtempSync(join(scratchRoot, "missing-"));
		try {
			const fake = writeFakeCodex(directory);
			writeManifest(directory, fake.binary, {
				targetTokens: 32_000,
				status: "awaiting_native_evidence",
				operations: [
					{
						key: "cold-prefix-baseline",
						threadId: "missing-thread",
						marker: "CACHE_MEASUREMENT_REQUEST=missing-baseline",
						prompt: "CACHE_MEASUREMENT_REQUEST=missing-baseline\n不要调用工具，不要修改文件，只答 OK。",
						status: "prepared",
						model: "gpt-6.1-sol",
						configurationFingerprint: "fingerprint",
					},
				],
				forks: [],
			});
			const run = runRepair(directory, fake.binary);
			expect(run.status, run.stderr).toBe(2);
			const frames = recordedMethods(fake.log);
			expect(frames.some((frame) => frame.method === "thread/resume")).toBe(true);
			expect(frames.some((frame) => frame.method === "turn/start" || frame.method === "thread/start")).toBe(false);
			const manifest = JSON.parse(readFileSync(join(directory, "repair-run-manifest.json"), "utf8")) as {
				contexts: { operations: { key: string; status: string; recoveryCondition?: string }[] }[];
			};
			const operation = manifest.contexts[0]?.operations.find((item) => item.key === "cold-prefix-baseline");
			expect(operation?.status).toBe("prepared");
			expect(operation?.recoveryCondition).toContain("未标成 submitting");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("载入的模型与冻结配置不一致时不提交模型请求", () => {
		mkdirSync(scratchRoot, { recursive: true });
		const directory = mkdtempSync(join(scratchRoot, "mismatch-"));
		try {
			const fake = writeFakeCodex(directory);
			writeManifest(directory, fake.binary, {
				targetTokens: 32_000,
				status: "awaiting_native_evidence",
				operations: [
					{
						key: "cold-prefix-baseline",
						threadId: "mismatch-thread",
						marker: "CACHE_MEASUREMENT_REQUEST=mismatch-baseline",
						prompt: "CACHE_MEASUREMENT_REQUEST=mismatch-baseline\n不要调用工具，不要修改文件，只答 OK。",
						status: "prepared",
						model: "gpt-6.1-sol",
						configurationFingerprint: "fingerprint",
					},
				],
				forks: [],
			});
			const run = runRepair(directory, fake.binary);
			expect(run.status, run.stderr).toBe(2);
			const frames = recordedMethods(fake.log);
			expect(frames.filter((frame) => frame.method === "thread/resume")).toHaveLength(1);
			expect(frames.some((frame) => frame.method === "turn/start")).toBe(false);
			const manifest = JSON.parse(readFileSync(join(directory, "repair-run-manifest.json"), "utf8")) as {
				contexts: { operations: { key: string; status: string; problem?: string }[] }[];
			};
			const operation = manifest.contexts[0]?.operations.find((item) => item.key === "cold-prefix-baseline");
			expect(operation?.status).toBe("insufficient_evidence");
			expect(operation?.problem).toContain("模型");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("临时线程在原进程退出后记为不可恢复，持久子线程则先 resume 再提交", () => {
		mkdirSync(scratchRoot, { recursive: true });
		const ephemeral = mkdtempSync(join(scratchRoot, "ephemeral-"));
		const child = mkdtempSync(join(scratchRoot, "child-"));
		const parentTranscript = "parent-history\n";
		try {
			const ephemeralParent = join(ephemeral, "parent.jsonl");
			writeFileSync(ephemeralParent, parentTranscript, { mode: 0o600 });
			const ephemeralFake = writeFakeCodex(ephemeral);
			writeManifest(
				ephemeral,
				ephemeralFake.binary,
				{
					targetTokens: 32_000,
					status: "running",
					parent: { thread: { id: "parent-thread" }, model: "gpt-6.1-sol", reasoningEffort: "max" },
					parentTranscriptPath: ephemeralParent,
					frozenParentSha256: digest(parentTranscript),
					operations: [
						completedOperation("cold-prefix-baseline", "baseline-thread", 11_400, 0),
						completedOperation("parent-create", "parent-thread", 32_000, 0),
						completedOperation("parent-hot-before", "parent-thread", 32_100, 31_872),
						completedOperation("parent-hot-after", "parent-thread", 32_200, 31_872),
						{
							key: "ephemeral-1-first",
							threadId: "ephemeral-thread",
							marker: "CACHE_MEASUREMENT_REQUEST=ephemeral-child",
							prompt: "CACHE_MEASUREMENT_REQUEST=ephemeral-child\n只答 OK。",
							status: "prepared",
							model: "gpt-6.1-sol",
						},
					],
					forks: [
						{
							mode: "ephemeral",
							index: 1,
							key: "ephemeral-1-first",
							status: "prepared",
							thread: { id: "ephemeral-thread" },
							historyVerified: true,
							parentUnchanged: true,
						},
					],
				},
				["ephemeral"],
			);
			const ephemeralRun = runRepair(ephemeral, ephemeralFake.binary, "ephemeral");
			expect(ephemeralRun.status, ephemeralRun.stderr).toBe(2);
			expect(
				recordedMethods(ephemeralFake.log).some((frame) =>
					["thread/resume", "thread/start", "thread/fork", "turn/start"].includes(frame.method ?? ""),
				),
			).toBe(false);
			const ephemeralManifest = JSON.parse(readFileSync(join(ephemeral, "repair-run-manifest.json"), "utf8")) as {
				contexts: { operations: { key: string; status: string; problem?: string }[] }[];
			};
			const ephemeralOperation = ephemeralManifest.contexts[0]?.operations.find(
				(item) => item.key === "ephemeral-1-first",
			);
			expect(ephemeralOperation?.status).toBe("insufficient_evidence");
			expect(ephemeralOperation?.problem).toContain("不可恢复");

			const childParent = join(child, "parent.jsonl");
			writeFileSync(childParent, parentTranscript, { mode: 0o600 });
			const childFake = writeFakeCodex(child);
			writeManifest(child, childFake.binary, {
				targetTokens: 32_000,
				status: "running",
				parent: { thread: { id: "parent-thread" }, model: "gpt-6.1-sol", reasoningEffort: "max" },
				parentTranscriptPath: childParent,
				frozenParentSha256: digest(parentTranscript),
				operations: [
					completedOperation("cold-prefix-baseline", "baseline-thread", 11_400, 0),
					completedOperation("parent-create", "parent-thread", 32_000, 0),
					completedOperation("parent-hot-before", "parent-thread", 32_100, 31_872),
					completedOperation("parent-hot-after", "parent-thread", 32_200, 31_872),
					{
						key: "persistent-1-first",
						threadId: "child-thread",
						marker: "CACHE_MEASUREMENT_REQUEST=persistent-child",
						prompt: "CACHE_MEASUREMENT_REQUEST=persistent-child\n只答 OK。",
						status: "prepared",
						model: "gpt-6.1-sol",
					},
				],
				forks: [
					{
						mode: "persistent",
						index: 1,
						key: "persistent-1-first",
						status: "prepared",
						thread: { id: "child-thread", forkedFromId: "parent-thread" },
						historyVerified: true,
						parentUnchanged: true,
					},
				],
			});
			const childRun = runRepair(child, childFake.binary);
			expect(childRun.status, childRun.stderr).toBe(2);
			const childFrames = recordedMethods(childFake.log);
			const resumeAt = childFrames.findIndex((frame) => frame.method === "thread/resume");
			const turnAt = childFrames.findIndex((frame) => frame.method === "turn/start");
			expect(childFrames.filter((frame) => frame.method === "thread/resume")).toEqual([
				expect.objectContaining({ params: expect.objectContaining({ threadId: "child-thread" }) }),
			]);
			expect(resumeAt).toBeGreaterThanOrEqual(0);
			expect(resumeAt).toBeLessThan(turnAt);
			expect(childFrames.filter((frame) => frame.method === "turn/start")).toEqual([
				expect.objectContaining({ params: expect.objectContaining({ threadId: "child-thread" }) }),
			]);
			expect(childFrames.some((frame) => frame.method === "thread/start" || frame.method === "thread/fork")).toBe(
				false,
			);
		} finally {
			rmSync(ephemeral, { recursive: true, force: true });
			rmSync(child, { recursive: true, force: true });
		}
	});
});
