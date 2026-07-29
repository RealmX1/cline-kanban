// transport-aware 会话回收：三种 transport 各自的审计结果形状、后代进程复核、失败上报、
// dry-run 演练，以及进程树探针的解析 / 展开 / 存活判定。
import { describe, expect, it, vi } from "vitest";

import type { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	collectDescendantPidsFromParentTable,
	isProcessAlive,
	listSurvivingPids,
	parsePosixProcessParentTable,
	snapshotDescendantPids,
} from "../../../src/server/agent-session-descendant-process-inspection";
import type { AgentSessionReclamationRequest } from "../../../src/server/agent-session-inactivity-reclamation-scheduler";
import {
	createDryRunAgentSessionReclamationExecutor,
	createTransportAwareAgentSessionReclamationExecutor,
} from "../../../src/server/transport-aware-agent-session-reclamation";
import type { PersistedAgentSessionReclamationDeadlineRecord } from "../../../src/state/agent-session-reclamation-deadline-store";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

const NOW = 1_700_000_000_000;
const ROOT_PID = 4242;

function makeRequest(
	overrides: Partial<PersistedAgentSessionReclamationDeadlineRecord> = {},
	summaryOverrides: Partial<RuntimeTaskSessionSummary> = {},
): AgentSessionReclamationRequest {
	const record: PersistedAgentSessionReclamationDeadlineRecord = {
		recordId: "task-a:incarnation-1:1",
		taskId: "task-a",
		agentId: "claude",
		sessionTransport: "pty_terminal",
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 1,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt: NOW - 60 * 60_000,
		responseGenerationStopSignalConfidence: "harness_turn_complete",
		reclamationEligibleAt: NOW,
		reclamationState: "grace_running",
		reclamationAttemptCount: 0,
		nextReclaimRetryAt: null,
		lastReclaimFailureReason: null,
		createdAt: NOW - 60 * 60_000,
		updatedAt: NOW - 60 * 60_000,
		schemaVersion: 1,
		...overrides,
	};
	const summary: RuntimeTaskSessionSummary = {
		taskId: "task-a",
		state: "awaiting_review",
		agentId: record.agentId,
		workspacePath: "/repo",
		pid: ROOT_PID,
		startedAt: NOW - 7_200_000,
		updatedAt: NOW - 60 * 60_000,
		lastOutputAt: NOW - 60 * 60_000,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: record.runtimeSessionIncarnationId,
		agentResponseGenerationTurnSequence: record.agentResponseGenerationTurnSequence,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		...summaryOverrides,
	};
	return { workspaceId: "ws-1", record, summary, attemptedAt: NOW };
}

function stubTerminalManager(forceStop = vi.fn(async () => {})): TerminalSessionManager {
	return { forceStopTaskSession: forceStop } as unknown as TerminalSessionManager;
}

function stubClineService(stop = vi.fn(async () => null)): ClineTaskSessionService {
	return { stopTaskSession: stop } as unknown as ClineTaskSessionService;
}

function stubAcpService(
	stopForReclamation = vi.fn(async () => ({
		rootPid: ROOT_PID,
		rootProcessExitConfirmed: true,
		usedForcefulEscalation: false,
	})),
): AcpTaskSessionService {
	return { stopTaskSessionForReclamation: stopForReclamation } as unknown as AcpTaskSessionService;
}

function createExecutor(overrides: {
	terminalManager?: TerminalSessionManager | null;
	clineService?: ClineTaskSessionService | null;
	acpService?: AcpTaskSessionService | null;
	descendantPids?: number[];
	alivePids?: Set<number>;
}) {
	const alivePids = overrides.alivePids ?? new Set<number>();
	return createTransportAwareAgentSessionReclamationExecutor({
		now: () => NOW + 10,
		getTerminalManager: () => overrides.terminalManager ?? null,
		getClineTaskSessionService: () => overrides.clineService ?? null,
		getAcpTaskSessionService: () => overrides.acpService ?? null,
		snapshotDescendantPids: async () => overrides.descendantPids ?? [],
		isProcessAlive: (pid) => alivePids.has(pid),
	});
}

describe("dry-run 执行器（上线前演练）", () => {
	it("不动任何资源，但审计结果一眼可辨是演练", async () => {
		const outcome = await createDryRunAgentSessionReclamationExecutor({ now: () => NOW + 5 })(makeRequest());
		expect(outcome.failureReason).toBeNull();
		expect(outcome.rootProcessExitConfirmed).toBe(false);
		expect(outcome.releasedResources).toEqual(["dry_run_no_resource_released"]);
		expect(outcome.completedAt).toBe(NOW + 5);
	});

	it("park 到期的演练如实标 park_abandoned 触发原因", async () => {
		const outcome = await createDryRunAgentSessionReclamationExecutor()(
			makeRequest({ retentionAnchorKind: "session_parked_awaiting_dispatched_background_work" }),
		);
		expect(outcome.reclamationTrigger).toBe("park_abandoned");
	});
});

describe("pty_terminal", () => {
	it("根进程与后代都确认退出 → 成功，释放 PTY 与全屏镜像", async () => {
		const forceStop = vi.fn(async () => {});
		const outcome = await createExecutor({
			terminalManager: stubTerminalManager(forceStop),
			descendantPids: [5001, 5002],
			alivePids: new Set(),
		})(makeRequest());

		expect(forceStop).toHaveBeenCalledWith("task-a", 2_000);
		expect(outcome.sessionTransport).toBe("pty_terminal");
		expect(outcome.rootProcessExitConfirmed).toBe(true);
		expect(outcome.descendantProcessesExitConfirmed).toBe(true);
		expect(outcome.survivingDescendantPids).toEqual([]);
		expect(outcome.releasedResources).toEqual(["pty", "terminal_state_mirror"]);
		expect(outcome.failureReason).toBeNull();
	});

	it("根进程仍存活 → 失败并如实写明", async () => {
		const outcome = await createExecutor({
			terminalManager: stubTerminalManager(),
			alivePids: new Set([ROOT_PID]),
		})(makeRequest());

		expect(outcome.rootProcessExitConfirmed).toBe(false);
		expect(outcome.failureReason).toContain(String(ROOT_PID));
	});

	it("后代进程仍存活 → 失败并带上幸存 pid（仅存活性，绝不据此求和内存）", async () => {
		const outcome = await createExecutor({
			terminalManager: stubTerminalManager(),
			descendantPids: [5001, 5002, 5003],
			alivePids: new Set([5002]),
		})(makeRequest());

		expect(outcome.rootProcessExitConfirmed).toBe(true);
		expect(outcome.descendantProcessesExitConfirmed).toBe(false);
		expect(outcome.survivingDescendantPids).toEqual([5002]);
		expect(outcome.failureReason).toContain("1");
	});

	it("终端管理器已不存在 → 没有可回收的东西，直接成功", async () => {
		const outcome = await createExecutor({ terminalManager: null })(makeRequest());
		expect(outcome.rootProcessExitConfirmed).toBe(true);
		expect(outcome.failureReason).toBeNull();
	});
});

describe("in_process_cline_sdk", () => {
	it("stop SDK 会话并释放 MCP tool bundle；退出确认语义随 transport 收窄", async () => {
		const stop = vi.fn(async () => null);
		const outcome = await createExecutor({ clineService: stubClineService(stop) })(
			makeRequest({ agentId: "cline", sessionTransport: "in_process_cline_sdk" }, { pid: null }),
		);

		expect(stop).toHaveBeenCalledWith("task-a");
		expect(outcome.sessionTransport).toBe("in_process_cline_sdk");
		expect(outcome.releasedResources).toEqual(["cline_sdk_session", "cline_mcp_tool_bundle"]);
		// 这条 transport 没有 OS 进程；true 表示「SDK 会话已 stop 且 bundle 已释放」，
		// 读它必须同时读 sessionTransport。
		expect(outcome.rootProcessExitConfirmed).toBe(true);
		expect(outcome.survivingDescendantPids).toEqual([]);
	});
});

describe("acp_stdio_subprocess", () => {
	it("走回收专用停止路径（先 cancel pending 决策、再等退出），并如实转述退出确认", async () => {
		const stopForReclamation = vi.fn(async () => ({
			rootPid: ROOT_PID,
			rootProcessExitConfirmed: true,
			usedForcefulEscalation: true,
		}));
		const outcome = await createExecutor({
			acpService: stubAcpService(stopForReclamation),
			descendantPids: [6001],
			alivePids: new Set(),
		})(makeRequest({ agentId: "omp", sessionTransport: "acp_stdio_subprocess" }));

		expect(stopForReclamation).toHaveBeenCalledWith("task-a", { gracefulTimeoutMs: 2_000, forcefulTimeoutMs: 500 });
		expect(outcome.sessionTransport).toBe("acp_stdio_subprocess");
		expect(outcome.usedForcefulEscalation).toBe(true);
		expect(outcome.releasedResources).toEqual(["acp_connection", "acp_agent_subprocess"]);
		expect(outcome.failureReason).toBeNull();
	});

	it("子进程在 SIGKILL 后仍存活 → 失败", async () => {
		const outcome = await createExecutor({
			acpService: stubAcpService(
				vi.fn(async () => ({ rootPid: ROOT_PID, rootProcessExitConfirmed: false, usedForcefulEscalation: true })),
			),
		})(makeRequest({ agentId: "omp", sessionTransport: "acp_stdio_subprocess" }));

		expect(outcome.rootProcessExitConfirmed).toBe(false);
		expect(outcome.failureReason).toContain(String(ROOT_PID));
	});
});

describe("进程树探针", () => {
	const processTableText = ["  100     1", "  200   100", "  300   200", "  400     1", "malformed line", ""].join(
		"\n",
	);

	it("解析 ps 输出为 ppid → pid 邻接表，容忍畸形行", () => {
		const table = parsePosixProcessParentTable(processTableText);
		expect(table.get(1)).toEqual([100, 400]);
		expect(table.get(100)).toEqual([200]);
		expect(table.get(200)).toEqual([300]);
	});

	it("BFS 展开整棵子树（不含根），不受兄弟分支干扰", () => {
		const table = parsePosixProcessParentTable(processTableText);
		expect(collectDescendantPidsFromParentTable(table, 100)).toEqual([200, 300]);
		expect(collectDescendantPidsFromParentTable(table, 400)).toEqual([]);
	});

	it("ppid 成环时不死循环", () => {
		const cyclicTable = new Map<number, number[]>([
			[10, [20]],
			[20, [10, 30]],
		]);
		expect(collectDescendantPidsFromParentTable(cyclicTable, 10)).toEqual([20, 30]);
	});

	it("Windows 不做枚举（该平台靠 tree-kill 处理整棵树）", async () => {
		await expect(snapshotDescendantPids(ROOT_PID, { platform: "win32" })).resolves.toEqual([]);
	});

	it("ps 调用失败 → 按「没枚举到」处理，不阻断回收", async () => {
		await expect(
			snapshotDescendantPids(ROOT_PID, {
				platform: "darwin",
				readProcessTable: async () => {
					throw new Error("ps unavailable");
				},
			}),
		).resolves.toEqual([]);
	});

	it("非法 pid 不探测", () => {
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(Number.NaN)).toBe(false);
	});

	it("当前进程自身一定存活（真实 kill(pid,0) 探针的健全性检查）", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("listSurvivingPids 只保留仍存活的", () => {
		expect(listSurvivingPids([1, 2, 3], { isProcessAlive: (pid) => pid === 2 })).toEqual([2]);
	});
});
