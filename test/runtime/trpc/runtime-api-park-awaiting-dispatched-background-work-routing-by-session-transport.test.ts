// dd2db 2x：park 三件套按会话当下的 transport 分派——ACP（omp）会话的 summary 归 ACP 服务，PTY 归终端管理器。
// 分错的后果是「has no active agent session to park」（ACP 任务在终端那边没有活体），RVF 在 omp 卡里就 park 不上。
import { describe, expect, it, vi } from "vitest";

import { createRuntimeApi } from "../../../src/trpc/runtime-api";

const workspaceScope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };

function createRuntimeApiWithSessionHolders(input: { acpSummaryTransport: "acp_stdio_subprocess" | null }) {
	const acpTaskSessionService = {
		getSummary: vi.fn(() =>
			input.acpSummaryTransport === null
				? null
				: { taskId: "task-1", agentId: "omp", sessionTransport: input.acpSummaryTransport },
		),
		parkTaskSessionAwaitingDispatchedBackgroundWork: vi.fn(() => ({ ok: true, summary: { holder: "acp" } })),
		unparkTaskSession: vi.fn(() => ({ holder: "acp" })),
		getAwaitingDispatchedBackgroundWork: vi.fn(() => ({ parked: true, label: "acp", sinceMs: 1 })),
	};
	const terminalManager = {
		parkTaskSessionAwaitingDispatchedBackgroundWork: vi.fn(() => ({ ok: true, summary: { holder: "pty" } })),
		unparkTaskSession: vi.fn(() => ({ holder: "pty" })),
		getAwaitingDispatchedBackgroundWork: vi.fn(() => ({ parked: true, label: "pty", sinceMs: 2 })),
	};
	const runtimeApi = createRuntimeApi({
		getActiveWorkspaceId: vi.fn(() => "workspace-1"),
		loadScopedRuntimeConfig: vi.fn(),
		setActiveRuntimeConfig: vi.fn(),
		getScopedTerminalManager: vi.fn(async () => terminalManager as never),
		getScopedClineTaskSessionService: vi.fn(),
		getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
		resolveInteractiveShellCommand: vi.fn(),
		runCommand: vi.fn(),
		getUpdateStatus: vi.fn(),
		runUpdateNow: vi.fn(),
	} as never);
	return { runtimeApi, acpTaskSessionService, terminalManager };
}

describe("park awaiting dispatched background work routing by session transport", () => {
	it("routes park, unpark and the is-parked query of an ACP-driven session to the ACP task session service", async () => {
		const { runtimeApi, acpTaskSessionService, terminalManager } = createRuntimeApiWithSessionHolders({
			acpSummaryTransport: "acp_stdio_subprocess",
		});

		await runtimeApi.parkTaskAwaitingDispatchedBackgroundWork(workspaceScope, { taskId: "task-1", label: "rvf" });
		await runtimeApi.unparkTaskAwaitingDispatchedBackgroundWork(workspaceScope, { taskId: "task-1" });
		const parkedState = await runtimeApi.isTaskParkedAwaitingDispatchedBackgroundWork(workspaceScope, {
			taskId: "task-1",
		});

		expect(acpTaskSessionService.parkTaskSessionAwaitingDispatchedBackgroundWork).toHaveBeenCalledWith("task-1", {
			label: "rvf",
		});
		expect(acpTaskSessionService.unparkTaskSession).toHaveBeenCalledWith("task-1");
		expect(parkedState).toMatchObject({ ok: true, parked: true, label: "acp" });
		expect(terminalManager.parkTaskSessionAwaitingDispatchedBackgroundWork).not.toHaveBeenCalled();
		expect(terminalManager.unparkTaskSession).not.toHaveBeenCalled();
	});

	it("keeps routing sessions without an ACP ledger entry to the terminal session manager", async () => {
		const { runtimeApi, acpTaskSessionService, terminalManager } = createRuntimeApiWithSessionHolders({
			acpSummaryTransport: null,
		});

		await runtimeApi.parkTaskAwaitingDispatchedBackgroundWork(workspaceScope, { taskId: "task-1", label: "rvf" });
		await runtimeApi.unparkTaskAwaitingDispatchedBackgroundWork(workspaceScope, { taskId: "task-1" });
		const parkedState = await runtimeApi.isTaskParkedAwaitingDispatchedBackgroundWork(workspaceScope, {
			taskId: "task-1",
		});

		expect(terminalManager.parkTaskSessionAwaitingDispatchedBackgroundWork).toHaveBeenCalledWith("task-1", {
			label: "rvf",
		});
		expect(terminalManager.unparkTaskSession).toHaveBeenCalledWith("task-1");
		expect(parkedState).toMatchObject({ ok: true, parked: true, label: "pty" });
		expect(acpTaskSessionService.parkTaskSessionAwaitingDispatchedBackgroundWork).not.toHaveBeenCalled();
	});
});
