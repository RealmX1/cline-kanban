import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildUserRequestedRvfPromptRequest,
	createUnsentRvfTarget,
	dispatchUnsentRvfPromptOnce,
	evaluateHostResourcesBeforeRvfPromptDispatch,
	type HostResourceIntervalObservation,
	observeCodexTranscriptRecord,
	observeRvfRunArtifacts,
	RVF_PROMPT_TEXT,
	readNewTranscriptRecords,
	reconcileTargetNativeTranscriptLocation,
	rvfDecisionTokenBelongsToDispatch,
	selectNextRvfTarget,
} from "../../scripts/dispatch-review-validate-fix-prompts-when-host-resources-allow";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";

const fixtureDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(fixtureDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function target(taskId = "first-target", workspaceId = "project-a") {
	return createUnsentRvfTarget({
		taskId,
		workspaceId,
		taskWorktreePath: `/isolated/worktrees/${taskId}/repo`,
		mainProjectPath: "/isolated/main-repository",
	});
}

function observations(cpuBusyPercent = 80): HostResourceIntervalObservation[] {
	return Array.from({ length: 30 }, (_, index) => ({
		startedAtMs: index * 10_000,
		endedAtMs: (index + 1) * 10_000,
		cpuBusyPercent,
		memoryPressureLevel: 1,
	}));
}

function state(targets = [target(), target("second-target", "project-b")]): Parameters<typeof selectNextRvfTarget>[0] {
	return { schemaVersion: 1 as const, promptText: RVF_PROMPT_TEXT, cpuAverageLimitPercent: 80, targets };
}

async function transcriptFixture() {
	const directory = await mkdtemp(join(tmpdir(), "kanban-rvf-resource-gated-prompt-scheduler-"));
	fixtureDirectories.push(directory);
	const transcriptPath = join(directory, "native-conversation.jsonl");
	await writeFile(transcriptPath, "");
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "selected-main-conversation",
		state: "awaiting_review",
		agentId: "codex",
		workspacePath: "/isolated/repo",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		lastHookAt: 1,
		reviewReason: "attention",
		exitCode: null,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "needs_input",
		runtimeSessionIncarnationId: "selected-incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "selected-native-session",
			transcriptPath,
			observedAt: 1,
		},
	});
	return { directory, transcriptPath, summary };
}

describe("RVF 发送前的整机资源门槛", () => {
	it("允许尖峰，按时间加权均值判断，并在 Running 达到 8 时阻止", () => {
		const samples = observations(78);
		samples[0].cpuBusyPercent = 100;
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(samples, 300_000, 7).allowed).toBe(true);
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(samples, 300_000, 8).allowed).toBe(false);
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(observations(80), 300_000, 7).allowed).toBe(true);
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(observations(80.01), 300_000, 7).allowed).toBe(false);
	});

	it("对跨窗口的第一个采样按重叠时长加权", () => {
		const samples = [
			...observations(75),
			{ startedAtMs: 300_000, endedAtMs: 310_000, cpuBusyPercent: 100, memoryPressureLevel: 1 },
		];
		const gate = evaluateHostResourcesBeforeRvfPromptDispatch(samples, 305_000, 7);
		expect(gate.allowed).toBe(false);
		const completedWindow = evaluateHostResourcesBeforeRvfPromptDispatch(samples.slice(0, 30), 300_005, 7);
		expect(completedWindow.allowed).toBe(true);
		expect(completedWindow.averageCpuBusyPercent).toBeCloseTo(75);
	});

	it.each([2, 4, null])("pressure=%s 阻止发送，直到该采样完全离开窗口", (memoryPressureLevel) => {
		const samples = observations(20);
		samples[0].memoryPressureLevel = memoryPressureLevel;
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(samples, 300_000, 0).allowed).toBe(false);
		const shifted = [
			...samples.slice(1),
			{ startedAtMs: 300_000, endedAtMs: 310_000, cpuBusyPercent: 20, memoryPressureLevel: 1 },
		];
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(shifted, 310_000, 0).allowed).toBe(true);
	});

	it("启动不足五分钟、采样过期、缺口和未知 Running 均阻止发送", () => {
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(observations().slice(1), 300_000, 0).allowed).toBe(false);
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(observations(), 320_000, 0).allowed).toBe(false);
		expect(
			evaluateHostResourcesBeforeRvfPromptDispatch(
				observations().filter((_, index) => index !== 15),
				300_000,
				0,
			).allowed,
		).toBe(false);
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(observations(), 300_000, null).allowed).toBe(false);
		const invalid = observations();
		invalid[1].cpuBusyPercent = Number.NaN;
		expect(evaluateHostResourcesBeforeRvfPromptDispatch(invalid, 300_000, 0).allowed).toBe(false);
	});
});

describe("一次发送意图、用户通道与续跑", () => {
	it("先保存发送意图，再按所选主会话发送原样文本，保留 needs_input 用户回合", async () => {
		const fixture = await transcriptFixture();
		const selected = target();
		const savedStatuses: string[] = [];
		const sendUserMessage = vi.fn(async (_target, request) => {
			expect(savedStatuses).toEqual(["send_intent_recorded"]);
			expect(request).toEqual({
				taskId: "first-target",
				targetTaskConversationSessionId: "selected-main-conversation",
				text: "$review-validate-fix",
			});
			expect(request).not.toHaveProperty("source");
			expect(request).not.toHaveProperty("mode");
			return { ok: true };
		});
		await dispatchUnsentRvfPromptOnce(selected, {
			now: () => 100,
			saveState: async () => {
				savedStatuses.push(selected.status);
			},
			resolveTargetSession: async () => fixture.summary,
			sendUserMessage,
		});
		expect(selected.status).toBe("accepted_by_runtime");
		expect(selected.nativeSessionId).toBe("selected-native-session");
		expect(savedStatuses).toEqual(["send_intent_recorded", "accepted_by_runtime"]);
		await expect(
			dispatchUnsentRvfPromptOnce(selected, {
				now: () => 200,
				saveState: async () => {},
				resolveTargetSession: async () => fixture.summary,
				sendUserMessage,
			}),
		).rejects.toThrow("禁止再次发送");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("发送响应丢失保留未知态，不重投；意图落盘失败时不发送", async () => {
		const fixture = await transcriptFixture();
		const selected = target();
		const sendUserMessage = vi.fn(async () => {
			throw new Error("socket reset after write");
		});
		await dispatchUnsentRvfPromptOnce(selected, {
			now: () => 100,
			saveState: async () => {},
			resolveTargetSession: async () => fixture.summary,
			sendUserMessage,
		});
		expect(selected.status).toBe("outcome_unknown");
		expect(() => selectNextRvfTarget(state([selected]), "pilot")).toThrow("不会自动重投");
		const another = target("another");
		await expect(
			dispatchUnsentRvfPromptOnce(another, {
				now: () => 100,
				saveState: async () => {
					throw new Error("write failed");
				},
				resolveTargetSession: async () => fixture.summary,
				sendUserMessage,
			}),
		).rejects.toThrow("write failed");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("崩溃后的发送意图只进入监测；首轮成功后才可续跑第二个项目", () => {
		const schedulerState = state();
		expect(() => selectNextRvfTarget(schedulerState, "remaining")).toThrow("首轮尚未证实");
		schedulerState.targets[0].status = "send_intent_recorded";
		expect(selectNextRvfTarget(schedulerState, "pilot")?.status).toBe("send_intent_recorded");
		schedulerState.targets[0].status = "reviewers_started";
		expect(selectNextRvfTarget(schedulerState, "pilot")).toBeNull();
		expect(selectNextRvfTarget(schedulerState, "remaining")?.workspaceId).toBe("project-b");
		expect(() => buildUserRequestedRvfPromptRequest(target())).toThrow("绑定目标主会话");
	});
});

describe("原生消息、hook 和真实 reviewer 输出的分层证据", () => {
	it("识别 TUI 自动展开的等价命名空间命令，分别记录 skill 内容与结构化引用证据", () => {
		const selected = target();
		selected.sendRequestedAtMs = 1000;
		const record = (text: string) => ({
			timestamp: new Date(1001).toISOString(),
			type: "response_item",
			payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
		});
		observeCodexTranscriptRecord(selected, record("$review-validate-fix:rvf-land"));
		expect(selected.transcriptUserMessageObserved).toBe(false);
		observeCodexTranscriptRecord(selected, record("$review-validate-fix:review-validate-fix"));
		expect(selected.transcriptUserMessageObserved).toBe(true);
		expect(selected.nativeUserMessageText).toBe("$review-validate-fix:review-validate-fix");
		expect(selected.structuredSkillReferenceObserved).toBe(false);
		observeCodexTranscriptRecord(
			selected,
			record(
				"<skill>\n<name>review-validate-fix:review-validate-fix</name>\n<path>/installed/SKILL.md</path>\n</skill>",
			),
		);
		expect(selected.skillExpansionObserved).toBe(true);
	});

	it("跟随同一原生会话及进程代次的新转录路径，拒绝会话或代次替换", async () => {
		const fixture = await transcriptFixture();
		const selected = target();
		selected.conversationSessionId = fixture.summary.taskId;
		selected.nativeSessionId = "selected-native-session";
		selected.runtimeSessionIncarnationId = "selected-incarnation";
		selected.transcriptPath = "/previous/native-conversation.jsonl";
		selected.transcriptByteOffset = 10_000;
		expect(reconcileTargetNativeTranscriptLocation(selected, fixture.summary)).toBe(true);
		expect(selected.transcriptPath).toBe(fixture.transcriptPath);
		expect(selected.transcriptByteOffset).toBe(0);
		selected.transcriptByteOffset = 20;
		expect(reconcileTargetNativeTranscriptLocation(selected, fixture.summary)).toBe(false);
		expect(selected.transcriptByteOffset).toBe(20);
		expect(() =>
			reconcileTargetNativeTranscriptLocation(selected, {
				...fixture.summary,
				runtimeSessionIncarnationId: "different-incarnation",
			}),
		).toThrow("停止归因");
		expect(() =>
			reconcileTargetNativeTranscriptLocation(selected, { ...fixture.summary, taskId: "different-conversation" }),
		).toThrow("停止归因");
	});

	it("忽略历史命令、伪时间与 assistant 引用，纯文本 user message 不冒充结构化 skill", () => {
		const selected = target();
		selected.sendRequestedAtMs = 1000;
		for (const timestamp of ["invalid", new Date(999).toISOString()])
			observeCodexTranscriptRecord(selected, {
				timestamp,
				type: "event_msg",
				payload: { type: "user_message", message: RVF_PROMPT_TEXT },
			});
		observeCodexTranscriptRecord(selected, {
			timestamp: new Date(1001).toISOString(),
			type: "response_item",
			payload: { type: "message", role: "assistant", content: [{ text: RVF_PROMPT_TEXT }] },
		});
		expect(selected.transcriptUserMessageObserved).toBe(false);
		observeCodexTranscriptRecord(selected, {
			timestamp: new Date(1001).toISOString(),
			type: "event_msg",
			payload: { type: "user_message", message: RVF_PROMPT_TEXT },
		});
		expect(selected.transcriptUserMessageObserved).toBe(true);
		expect(selected.structuredSkillReferenceObserved).toBe(false);
	});

	it("增量读取保留半条记录，U+2028 不作为记录分界", async () => {
		const fixture = await transcriptFixture();
		const selected = target();
		selected.sendRequestedAtMs = 1;
		selected.transcriptPath = fixture.transcriptPath;
		const first = JSON.stringify({
			timestamp: new Date(2).toISOString(),
			type: "event_msg",
			payload: { type: "task_complete", last_agent_message: "RVF\u2028继续" },
		});
		const second = JSON.stringify({
			timestamp: new Date(3).toISOString(),
			type: "event_msg",
			payload: { type: "user_message", message: RVF_PROMPT_TEXT },
		});
		await writeFile(fixture.transcriptPath, `${first}\n${second.slice(0, 20)}`);
		await readNewTranscriptRecords(selected);
		expect(selected.lastAgentCompletion).toBe("RVF\u2028继续");
		expect(selected.transcriptUserMessageObserved).toBe(false);
		await appendFile(fixture.transcriptPath, `${second.slice(20)}\n`);
		await readNewTranscriptRecords(selected);
		expect(selected.transcriptUserMessageObserved).toBe(true);
		expect(selected.transcriptByteOffset).toBe(Buffer.byteLength(await readFile(fixture.transcriptPath, "utf8")));
	});

	it("符号链接别名可归属同一目录，仍拒绝其他会话与历史 token，且 PID 不证明启动", async () => {
		const fixture = await transcriptFixture();
		const selected = target();
		const physicalWorktreePath = join(fixture.directory, "selected-worktree");
		await mkdir(physicalWorktreePath);
		selected.taskWorktreePath = await realpath(physicalWorktreePath);
		const worktreeAliasPath = join(fixture.directory, "selected-worktree-symbolic-alias");
		await symlink(selected.taskWorktreePath, worktreeAliasPath, "dir");
		selected.sendRequestedAtMs = 100;
		selected.nativeSessionId = "selected-native-session";
		selected.transcriptUserMessageObserved = true;
		const token = {
			token: "0123456789abcdef",
			worktree: worktreeAliasPath,
			session_id: selected.nativeSessionId,
			created_at: new Date(101).toISOString(),
			initiated_by_explicit_user_request: true,
			state: "dispatched",
		};
		for (const patch of [
			{ worktree: "/other/task" },
			{ session_id: "other-session" },
			{ created_at: new Date(99).toISOString() },
			{ created_at: "invalid" },
		])
			expect(await rvfDecisionTokenBelongsToDispatch(selected, { ...token, ...patch })).toBe(false);
		expect(await rvfDecisionTokenBelongsToDispatch(selected, token)).toBe(true);
		expect(
			await rvfDecisionTokenBelongsToDispatch({ ...selected, transcriptUserMessageObserved: false }, token),
		).toBe(false);
		const tokenDirectory = join(fixture.directory, "agentic-initiation-decision-tokens");
		const overlayDirectory = join(fixture.directory, "agentic-initiation-scope-adjustments");
		const runDirectory = join(fixture.directory, "bound-review-run");
		const reviewersDirectory = join(runDirectory, "artifacts/reviewers");
		await Promise.all(
			[tokenDirectory, overlayDirectory, join(reviewersDirectory, "reviewer-one")].map((directory) =>
				mkdir(directory, { recursive: true }),
			),
		);
		await writeFile(join(tokenDirectory, `${token.token}.json`), JSON.stringify(token));
		await writeFile(join(overlayDirectory, `${token.token}.json`), JSON.stringify({ run_dir: runDirectory }));
		await writeFile(join(runDirectory, "summary.json"), JSON.stringify({ repo: worktreeAliasPath }));
		await writeFile(
			join(reviewersDirectory, ".dispatch-thread.status.json"),
			JSON.stringify({ state: "running", pid: 123 }),
		);
		await observeRvfRunArtifacts(selected, fixture.directory);
		expect(selected.hookRecognized).toBe(true);
		expect(selected.status).toBe("not_sent");
		const unrelatedRunReviewerDirectory = join(fixture.directory, "unrelated-review-run/artifacts/reviewers/other");
		await mkdir(unrelatedRunReviewerDirectory, { recursive: true });
		await writeFile(join(unrelatedRunReviewerDirectory, "reviewer.stdout.txt"), "其他 run 的输出\n");
		await observeRvfRunArtifacts(selected, fixture.directory);
		expect(selected.status).toBe("not_sent");
		expect(selected.reviewerOutputEvidencePaths).toEqual([]);
		const evidencePath = join(reviewersDirectory, "reviewer-one/reviewer.stdout.txt");
		await writeFile(evidencePath, '{"type":"system","subtype":"init"}\n');
		await observeRvfRunArtifacts(selected, fixture.directory);
		expect(selected.status).toBe("reviewers_started");
		expect(selected.reviewerOutputEvidencePaths).toEqual([evidencePath]);
	});

	it.each([
		["token.worktree", "其他真实目录"],
		["token.worktree", "不存在的目录"],
		["token.worktree", "普通文件"],
		["token.worktree", "失效的符号链接"],
		["summary.repo", "其他真实目录"],
		["summary.repo", "不存在的目录"],
		["summary.repo", "普通文件"],
		["summary.repo", "失效的符号链接"],
	] as const)("%s 指向%s时，即使存在 reviewer 输出也不归因成功", async (pathSource, invalidPathKind) => {
		const fixture = await transcriptFixture();
		const selected = target();
		selected.taskWorktreePath = join(fixture.directory, "selected-worktrees/first-target/repo");
		selected.status = "accepted_by_runtime";
		selected.sendRequestedAtMs = 100;
		selected.nativeSessionId = "selected-native-session";
		selected.transcriptUserMessageObserved = true;
		const otherWorktreePath = join(fixture.directory, "other-worktrees/first-target/repo");
		await Promise.all([selected.taskWorktreePath, otherWorktreePath].map((path) => mkdir(path, { recursive: true })));
		const missingWorktreePath = join(fixture.directory, "missing-worktree");
		const brokenWorktreeAliasPath = join(fixture.directory, "broken-worktree-symbolic-alias");
		await symlink(missingWorktreePath, brokenWorktreeAliasPath, "dir");
		const invalidPath = {
			其他真实目录: otherWorktreePath,
			不存在的目录: missingWorktreePath,
			普通文件: fixture.transcriptPath,
			失效的符号链接: brokenWorktreeAliasPath,
		}[invalidPathKind];
		const tokenDirectory = join(fixture.directory, "agentic-initiation-decision-tokens");
		const runDirectory = join(fixture.directory, "bound-review-run");
		const reviewerDirectory = join(runDirectory, "artifacts/reviewers/reviewer-one");
		await Promise.all([tokenDirectory, reviewerDirectory].map((path) => mkdir(path, { recursive: true })));
		const token = {
			token: "0123456789abcdef",
			worktree: pathSource === "token.worktree" ? invalidPath : selected.taskWorktreePath,
			session_id: selected.nativeSessionId,
			created_at: new Date(101).toISOString(),
			state: "dispatched",
			initiated_by_explicit_user_request: true,
			run_anchor_dir: runDirectory,
		};
		await writeFile(join(tokenDirectory, `${token.token}.json`), JSON.stringify(token));
		await writeFile(
			join(runDirectory, "summary.json"),
			JSON.stringify({ repo: pathSource === "summary.repo" ? invalidPath : selected.taskWorktreePath }),
		);
		await writeFile(join(reviewerDirectory, "reviewer.stdout.txt"), "隔离 reviewer 输出\n");
		await observeRvfRunArtifacts(selected, fixture.directory);
		expect(selected.status).toBe("accepted_by_runtime");
		expect(selected.reviewerOutputEvidencePaths).toEqual([]);
		expect(selected.hookRecognized).toBe(pathSource === "summary.repo");
	});

	it("两个相同但无法核验的目录字符串不能证明 token 属于目标", async () => {
		const fixture = await transcriptFixture();
		const selected = target();
		selected.taskWorktreePath = join(fixture.directory, "missing-worktree");
		selected.sendRequestedAtMs = 100;
		selected.nativeSessionId = "selected-native-session";
		selected.transcriptUserMessageObserved = true;
		expect(
			await rvfDecisionTokenBelongsToDispatch(selected, {
				worktree: selected.taskWorktreePath,
				session_id: selected.nativeSessionId,
				created_at: new Date(101).toISOString(),
			}),
		).toBe(false);
	});
});
