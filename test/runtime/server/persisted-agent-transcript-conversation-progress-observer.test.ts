// 观察器守的是「什么时候该去读一次转录」这个闸门本身：summary 在 agent 产出时按 spinner 速率刷新，
// 闸门没关严就是一条恒定的 IO 风暴；关太死则会话重开时纠不了偏。探测实现被注入成假的，
// 因为本套件要验的是**调度决策**，不是读盘（读盘在探针自己的套件里用真实文件系统验）。

import { describe, expect, it, vi } from "vitest";
import type { PersistedAgentTranscriptProbeInput } from "../../../src/agent-session-history/persisted-agent-transcript-last-conversation-progress-probe";
import type {
	RuntimeLastConversationProgressObservation,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";
import {
	createPersistedAgentTranscriptConversationProgressObserver,
	IMMEDIATE_LANE_DISPATCHES_BEFORE_YIELDING_ONE_SLOT_TO_REGULAR_LANE,
	MAX_CONCURRENT_PERSISTED_AGENT_TRANSCRIPT_PROBES,
	PERSISTED_AGENT_TRANSCRIPT_PROBE_COOLDOWN_MS,
} from "../../../src/server/persisted-agent-transcript-conversation-progress-observer";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

const TRANSCRIPT_OBSERVATION: RuntimeLastConversationProgressObservation = {
	observedAtMs: 1_700_000_000_000,
	evidenceKind: "persisted_agent_transcript",
};

// 观察器是进程级单例、被所有 project 共享，而 taskId 是 board-local 短 id——跨 workspace 撞号是常态，
// 故本套件里凡是「同一个任务」的断言都必须钉在同一个 workspaceId 上，跨 workspace 的用例则刻意复用同一 taskId。
const WORKSPACE_ALPHA = "workspace-alpha";
const WORKSPACE_BETA = "workspace-beta";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return applySessionFacets({
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 7,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: 1_000,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation-first",
		...overrides,
	});
}

// 只实现观察器真正会调的那一个方法；其余成员在本套件里不可达，故断言式地留空。
function createRecordingManager(): {
	manager: TerminalSessionManager;
	recorded: Array<{ taskId: string; observation: RuntimeLastConversationProgressObservation }>;
} {
	const recorded: Array<{ taskId: string; observation: RuntimeLastConversationProgressObservation }> = [];
	const manager = {
		recordPersistedAgentTranscriptConversationProgress: (
			taskId: string,
			observation: RuntimeLastConversationProgressObservation,
		) => {
			recorded.push({ taskId, observation });
			return null;
		},
	} as unknown as TerminalSessionManager;
	return { manager, recorded };
}

function createObserver(overrides: Parameters<typeof createPersistedAgentTranscriptConversationProgressObserver>[0]) {
	return createPersistedAgentTranscriptConversationProgressObserver(overrides);
}

// 逐次放行的假探针：把「谁拿到下一个名额」变成可逐步观察的序列。配合 maxConcurrentProbes: 1 使用，
// 排队顺序就是 probedWorkspacePaths 的顺序（探针只收得到 workspacePath，故用它给任务编号）。
function createManuallyReleasedProbe() {
	const pendingProbeReleases: Array<() => void> = [];
	const probedWorkspacePaths: string[] = [];
	const probe = vi.fn((input: PersistedAgentTranscriptProbeInput) => {
		probedWorkspacePaths.push(input.workspacePath ?? "");
		return new Promise<RuntimeLastConversationProgressObservation | null>((resolveProbe) => {
			pendingProbeReleases.push(() => resolveProbe(TRANSCRIPT_OBSERVATION));
		});
	});
	return {
		probe,
		probedWorkspacePaths,
		// 放行最早的那次在途探测，并把 then/catch/finally 链跑完——下一次发车就发生在 finally 里。
		releaseNextProbe: async () => {
			pendingProbeReleases.shift()?.();
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		},
	};
}

describe("持久转录推进观察器", () => {
	it("首次见到一个任务即探测，并把结果写回管理器", async () => {
		const probe = vi.fn(async () => TRANSCRIPT_OBSERVATION);
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		await vi.waitFor(() => expect(recorded).toHaveLength(1));

		expect(probe).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledWith({ agentId: "claude", workspacePath: "/tmp/worktree" });
		expect(recorded[0]).toEqual({ taskId: "task-1", observation: TRANSCRIPT_OBSERVATION });
	});

	// 闸门①：不支持按工作目录寻址转录的 agent 一律不发起探测（否则就是给每个任务白跑一次读盘）。
	it.each(["codex", "cursor", "gemini", "cline", "omp"] as const)("agent=%s ⇒ 不探测", async (agentId) => {
		const probe = vi.fn(async () => TRANSCRIPT_OBSERVATION);
		const { manager } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ agentId }), manager);

		expect(probe).not.toHaveBeenCalled();
	});

	it("没有 workspacePath ⇒ 不探测（无从定位转录目录）", () => {
		const probe = vi.fn(async () => TRANSCRIPT_OBSERVATION);
		const { manager } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ workspacePath: null }), manager);

		expect(probe).not.toHaveBeenCalled();
	});

	// 闸门③：spinner 期 summary 高频刷新，冷却窗口内的后续 summary 一律不再探测。
	it("冷却窗口内的后续 summary 不重复探测；窗口过后恢复", async () => {
		const probe = vi.fn(async () => TRANSCRIPT_OBSERVATION);
		const { manager, recorded } = createRecordingManager();
		let clock = 0;
		const observer = createObserver({ probe, nowMs: () => clock });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		await vi.waitFor(() => expect(recorded).toHaveLength(1));

		for (let tick = 1; tick <= 20; tick += 1) {
			clock = tick * 100;
			observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ lastOutputAt: clock }), manager);
		}
		expect(probe).toHaveBeenCalledTimes(1);

		clock = PERSISTED_AGENT_TRANSCRIPT_PROBE_COOLDOWN_MS;
		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ lastOutputAt: clock }), manager);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
	});

	// 闸门③的例外，也是整个纠偏链条最要紧的一刻：会话被重开 / 进程重启 ⇒ 换活体。
	// 旧对话此刻正被重播进新 TUI 把时间戳刷成「刚刚」，纠偏必须立即发生，不能等冷却。
	it("换活体时绕过冷却立刻重探", async () => {
		const probe = vi.fn(async () => TRANSCRIPT_OBSERVATION);
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		await vi.waitFor(() => expect(recorded).toHaveLength(1));

		// 同一时刻（冷却完全没走）+ 新活体 ⇒ 仍应探测。
		observer.observeTaskSessionSummary(
			WORKSPACE_ALPHA,
			summary({ runtimeSessionIncarnationId: "incarnation-second" }),
			manager,
		);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
	});

	// 闸门②：上一次探测还没回来就不发第二次，否则慢盘上会堆起一串并发读。
	it("在途探测未返回时不叠发第二次", async () => {
		let releaseProbe: (value: RuntimeLastConversationProgressObservation | null) => void = () => {};
		const probe = vi.fn(
			() =>
				new Promise<RuntimeLastConversationProgressObservation | null>((resolve) => {
					releaseProbe = resolve;
				}),
		);
		const { manager, recorded } = createRecordingManager();
		let clock = 0;
		const observer = createObserver({ probe, nowMs: () => clock });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		expect(probe).toHaveBeenCalledTimes(1);

		// 即便冷却早已过去，只要上一次还在途就不发。
		clock = PERSISTED_AGENT_TRANSCRIPT_PROBE_COOLDOWN_MS * 10;
		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ lastOutputAt: clock }), manager);
		expect(probe).toHaveBeenCalledTimes(1);

		releaseProbe(TRANSCRIPT_OBSERVATION);
		await vi.waitFor(() => expect(recorded).toHaveLength(1));

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ lastOutputAt: clock }), manager);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
	});

	// 探测返回 null 的含义是「这次问不出结论」，绝不是「对话没推进过」——必须保持原值、不写回。
	it("探测返回 null ⇒ 不写回任何东西", async () => {
		const probe = vi.fn(async () => null);
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

		expect(recorded).toHaveLength(0);
	});

	it("探测抛错 ⇒ 走告警回调、不写回，且不影响后续探测", async () => {
		const onProbeFailed = vi.fn();
		const probe = vi.fn(async () => {
			throw new Error("读盘失败");
		});
		const { manager, recorded } = createRecordingManager();
		let clock = 0;
		const observer = createObserver({ probe, nowMs: () => clock, onProbeFailed });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		await vi.waitFor(() => expect(onProbeFailed).toHaveBeenCalledTimes(1));
		expect(recorded).toHaveLength(0);

		clock = PERSISTED_AGENT_TRANSCRIPT_PROBE_COOLDOWN_MS;
		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ lastOutputAt: clock }), manager);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
	});

	it("dispose 之后既不再探测，在途探测的结果也不再写回", async () => {
		let releaseProbe: (value: RuntimeLastConversationProgressObservation | null) => void = () => {};
		const probe = vi.fn(
			() =>
				new Promise<RuntimeLastConversationProgressObservation | null>((resolve) => {
					releaseProbe = resolve;
				}),
		);
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		observer.dispose();
		releaseProbe(TRANSCRIPT_OBSERVATION);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

		expect(recorded).toHaveLength(0);
		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary({ taskId: "task-2" }), manager);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	// 闸门②③的账本必须按 workspace 隔离：taskId 是 board-local 短 id，两个 project 各有一个 5 位同号任务
	// 是完全正常的局面。只用 taskId 计账时，先到的那个会把冷却状态留在账本里，把后到那个的探测整个吞掉——
	// 而对水合任务来说，hub 那次 listSummaries() 回填是它唯一一次探测机会。
	it("同 taskId 分属两个 workspace ⇒ 各自独立探测，不被对方的冷却挡掉", async () => {
		const probe = vi.fn(async () => TRANSCRIPT_OBSERVATION);
		const { manager: alphaManager } = createRecordingManager();
		const { manager: betaManager } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(
			WORKSPACE_ALPHA,
			summary({ workspacePath: "/tmp/worktree-alpha" }),
			alphaManager,
		);
		observer.observeTaskSessionSummary(WORKSPACE_BETA, summary({ workspacePath: "/tmp/worktree-beta" }), betaManager);

		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
		expect(probe).toHaveBeenNthCalledWith(1, { agentId: "claude", workspacePath: "/tmp/worktree-alpha" });
		expect(probe).toHaveBeenNthCalledWith(2, { agentId: "claude", workspacePath: "/tmp/worktree-beta" });
	});

	// 在途去重同理：另一个 workspace 的同号任务不该被它挡住。
	it("同 taskId 分属两个 workspace ⇒ 在途去重也各算各的", () => {
		const probe = vi.fn(() => new Promise<RuntimeLastConversationProgressObservation | null>(() => {}));
		const { manager: alphaManager } = createRecordingManager();
		const { manager: betaManager } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), alphaManager);
		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), alphaManager);
		expect(probe).toHaveBeenCalledTimes(1);

		observer.observeTaskSessionSummary(WORKSPACE_BETA, summary(), betaManager);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	// 与 hub 的 disposeWorkspace 对位：project 被移除后条目必须退场，否则这个进程级单例会随「加了又删的
	// project」无界累积。清理只能命中被移除的那个 workspace。
	it("forgetWorkspace 只清该 workspace 的账本，其它 workspace 的冷却照常生效", async () => {
		const probe = vi.fn(async () => TRANSCRIPT_OBSERVATION);
		const { manager: alphaManager } = createRecordingManager();
		const { manager: betaManager } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), alphaManager);
		observer.observeTaskSessionSummary(WORKSPACE_BETA, summary(), betaManager);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

		observer.forgetWorkspace(WORKSPACE_ALPHA);

		// alpha 的账本已清空 ⇒ 冷却窗口内也会被当成「首次见到」重新探测。
		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), alphaManager);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));

		// beta 没被碰过 ⇒ 冷却仍然拦着。
		observer.observeTaskSessionSummary(WORKSPACE_BETA, summary(), betaManager);
		expect(probe).toHaveBeenCalledTimes(3);
	});

	it("forgetWorkspace 之后，该 workspace 在途探测的结果不再写回（管理器正在被拆）", async () => {
		let releaseProbe: (value: RuntimeLastConversationProgressObservation | null) => void = () => {};
		const probe = vi.fn(
			() =>
				new Promise<RuntimeLastConversationProgressObservation | null>((resolve) => {
					releaseProbe = resolve;
				}),
		);
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		observer.observeTaskSessionSummary(WORKSPACE_ALPHA, summary(), manager);
		observer.forgetWorkspace(WORKSPACE_ALPHA);
		releaseProbe(TRANSCRIPT_OBSERVATION);
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

		expect(recorded).toHaveLength(0);
	});

	// 闸门④：①②③全是按任务计账的，只保证「同一任务不重复探」，管不住「同一瞬间多少任务在探」。
	// hub 的水合回填正是一次性把该 project 下全部历史任务（本机数百条）同步喂进来的形状——回归前这里
	// 的在途数就等于任务数，每个探针内部还要再对该目录下全部转录文件做一轮 stat。
	it("一次性喂入大量水合 summary ⇒ 在途探测数有上界，且每条最终都被探测到", async () => {
		const HYDRATED_TASK_COUNT = 120;
		let inFlightProbeCount = 0;
		let peakInFlightProbeCount = 0;
		const probe = vi.fn(async () => {
			inFlightProbeCount += 1;
			peakInFlightProbeCount = Math.max(peakInFlightProbeCount, inFlightProbeCount);
			await new Promise((resolveProbeDelay) => setTimeout(resolveProbeDelay, 0));
			inFlightProbeCount -= 1;
			return TRANSCRIPT_OBSERVATION;
		});
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0 });

		for (let index = 0; index < HYDRATED_TASK_COUNT; index += 1) {
			observer.observeTaskSessionSummary(
				WORKSPACE_ALPHA,
				summary({ taskId: `hydrated-${index}`, workspacePath: `/tmp/hydrated-${index}` }),
				manager,
			);
		}

		// 入队是同步的、发车不是：喂完的那一刻在途数就必须已经被压住（回归前这里等于 HYDRATED_TASK_COUNT）。
		expect(inFlightProbeCount).toBeLessThanOrEqual(MAX_CONCURRENT_PERSISTED_AGENT_TRANSCRIPT_PROBES);

		// 限流只是排队，不是丢弃：每一条最终都得被探到并写回，否则「水合任务一辈子仅有的一次探测机会」
		// 就被闸门④吃掉了。
		await vi.waitFor(() => expect(recorded).toHaveLength(HYDRATED_TASK_COUNT), { timeout: 4_000 });
		expect(probe).toHaveBeenCalledTimes(HYDRATED_TASK_COUNT);
		expect(new Set(recorded.map((entry) => entry.taskId)).size).toBe(HYDRATED_TASK_COUNT);
		expect(peakInFlightProbeCount).toBe(MAX_CONCURRENT_PERSISTED_AGENT_TRANSCRIPT_PROBES);
	});

	// 闸门④不得把闸门③的例外条款（换活体立刻纠偏）抵消掉：排在几百条水合回填后面 ≈ 没有及时纠偏。
	it("换活体的纠偏插到排队中的水合回填之前", async () => {
		const { probe, probedWorkspacePaths, releaseNextProbe } = createManuallyReleasedProbe();
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0, maxConcurrentProbes: 1 });

		// 先让活跃任务完成一次探测：没有已探过的活体就构不成「换活体」。
		observer.observeTaskSessionSummary(
			WORKSPACE_ALPHA,
			summary({ taskId: "live", workspacePath: "/tmp/live" }),
			manager,
		);
		await releaseNextProbe();
		await vi.waitFor(() => expect(recorded).toHaveLength(1));

		// 水合回填灌满队列：名额被 hydrated-0 占住，其余全在常规车道排着。
		for (let index = 0; index < 10; index += 1) {
			observer.observeTaskSessionSummary(
				WORKSPACE_ALPHA,
				summary({ taskId: `hydrated-${index}`, workspacePath: `/tmp/hydrated-${index}` }),
				manager,
			);
		}
		expect(probedWorkspacePaths).toEqual(["/tmp/live", "/tmp/hydrated-0"]);

		observer.observeTaskSessionSummary(
			WORKSPACE_ALPHA,
			summary({ taskId: "live", workspacePath: "/tmp/live", runtimeSessionIncarnationId: "incarnation-second" }),
			manager,
		);

		// 下一个让出来的名额必须给它，而不是队首的 hydrated-1。
		await releaseNextProbe();
		expect(probedWorkspacePaths[2]).toBe("/tmp/live");
	});

	// 优先车道的另一半：多个 project 的会话在同一段时间里接连重开是现实形状，纯优先级会把水合回填
	// 永久压在队尾——而回填对「已回收 / 停在等人审查」的任务是一辈子仅有的一次探测机会。
	it("换活体持续插队时，水合回填仍按固定配额发车（不被饿死）", async () => {
		const LIVE_TASK_COUNT = IMMEDIATE_LANE_DISPATCHES_BEFORE_YIELDING_ONE_SLOT_TO_REGULAR_LANE + 2;
		const { probe, probedWorkspacePaths, releaseNextProbe } = createManuallyReleasedProbe();
		const { manager, recorded } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0, maxConcurrentProbes: 1 });

		for (let index = 0; index < LIVE_TASK_COUNT; index += 1) {
			observer.observeTaskSessionSummary(
				WORKSPACE_ALPHA,
				summary({ taskId: `live-${index}`, workspacePath: `/tmp/live-${index}` }),
				manager,
			);
		}
		for (let index = 0; index < LIVE_TASK_COUNT; index += 1) {
			await releaseNextProbe();
		}
		await vi.waitFor(() => expect(recorded).toHaveLength(LIVE_TASK_COUNT));

		for (let index = 0; index < 10; index += 1) {
			observer.observeTaskSessionSummary(
				WORKSPACE_ALPHA,
				summary({ taskId: `hydrated-${index}`, workspacePath: `/tmp/hydrated-${index}` }),
				manager,
			);
		}
		// 全部活跃任务同时换活体 ⇒ 优先车道一直非空。
		for (let index = 0; index < LIVE_TASK_COUNT; index += 1) {
			observer.observeTaskSessionSummary(
				WORKSPACE_ALPHA,
				summary({
					taskId: `live-${index}`,
					workspacePath: `/tmp/live-${index}`,
					runtimeSessionIncarnationId: "incarnation-second",
				}),
				manager,
			);
		}

		const dispatchCountBeforeContention = probedWorkspacePaths.length;
		for (let index = 0; index <= IMMEDIATE_LANE_DISPATCHES_BEFORE_YIELDING_ONE_SLOT_TO_REGULAR_LANE; index += 1) {
			await releaseNextProbe();
		}

		const dispatchesUnderContention = probedWorkspacePaths.slice(dispatchCountBeforeContention);
		expect(
			dispatchesUnderContention
				.slice(0, IMMEDIATE_LANE_DISPATCHES_BEFORE_YIELDING_ONE_SLOT_TO_REGULAR_LANE)
				.every((workspacePath) => workspacePath.startsWith("/tmp/live-")),
		).toBe(true);
		expect(dispatchesUnderContention[IMMEDIATE_LANE_DISPATCHES_BEFORE_YIELDING_ONE_SLOT_TO_REGULAR_LANE]).toMatch(
			/^\/tmp\/hydrated-/,
		);
	});

	it("探测失败的告警上下文带 workspaceId（board-local taskId 单独指认不到任务）", async () => {
		const onProbeFailed = vi.fn();
		const probe = vi.fn(async () => {
			throw new Error("读盘失败");
		});
		const { manager } = createRecordingManager();
		const observer = createObserver({ probe, nowMs: () => 0, onProbeFailed });

		observer.observeTaskSessionSummary(WORKSPACE_BETA, summary(), manager);

		await vi.waitFor(() => expect(onProbeFailed).toHaveBeenCalledTimes(1));
		expect(onProbeFailed.mock.calls[0]?.[1]).toEqual({ workspaceId: WORKSPACE_BETA, taskId: "task-1" });
	});
});
