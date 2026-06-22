import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalPanel, describeState, getStateTagStyle } from "@/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";

const { mockRefreshTerminal } = vi.hoisted(() => ({
	mockRefreshTerminal: vi.fn(async () => {}),
}));

vi.mock("@/terminal/use-persistent-terminal-session", () => ({
	usePersistentTerminalSession: () => ({
		containerRef: { current: null },
		lastError: null,
		isStopping: false,
		isRefreshing: false,
		isSearchOpen: false,
		searchOpenRequestKey: 0,
		searchResults: { resultCount: 0, resultIndex: -1 },
		clearTerminal: vi.fn(),
		closeTerminalSearch: vi.fn(),
		findNextInTerminal: vi.fn(() => false),
		findPreviousInTerminal: vi.fn(() => false),
		openTerminalSearch: vi.fn(),
		refreshTerminal: mockRefreshTerminal,
		stopTerminal: vi.fn(async () => {}),
	}),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
}));

function createSummary(agentId: RuntimeAgentId, taskId = "task-1"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId,
		workspacePath: "/tmp/repo",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("AgentTerminalPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockRefreshTerminal.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("shows refresh in the compact terminal header without requiring a close button", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createSummary("codex")}
						showSessionToolbar={false}
						minimalHeaderTitle="Terminal"
					/>
				</TooltipProvider>,
			);
		});

		const refreshButton = container.querySelector<HTMLButtonElement>('[aria-label="Refresh terminal session"]');
		expect(refreshButton).not.toBeNull();
		expect(refreshButton?.disabled).toBe(false);
		expect(container.querySelector('[aria-label="Close terminal"]')).toBeNull();

		act(() => {
			refreshButton?.click();
		});

		expect(mockRefreshTerminal).toHaveBeenCalledTimes(1);
	});

	it("does not show refresh for compact synthetic home terminals", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="__home_agent__:workspace-1:codex"
						workspaceId="workspace-1"
						summary={createSummary("codex", "__home_agent__:workspace-1:codex")}
						showSessionToolbar={false}
						minimalHeaderTitle="Agent"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[aria-label="Refresh terminal session"]')).toBeNull();
		expect(container.querySelector('[aria-label="Find in terminal"]')).not.toBeNull();
	});
});

describe("describeState / getStateTagStyle（facet 真相源驱动，行为与 legacy state 逐项等价）", () => {
	function makeStatusSummary(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
		return {
			taskId: "task-1",
			state: "idle",
			agentId: "claude",
			workspacePath: null,
			pid: null,
			startedAt: null,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			...overrides,
		};
	}

	it("null summary → No session yet / neutral", () => {
		expect(describeState(null)).toBe("No session yet");
		expect(getStateTagStyle(null)).toBe("neutral");
	});

	it("running（agent 回合）→ Running / success", () => {
		const summary = makeStatusSummary({ state: "running", pid: 123, lastOutputAt: 1 });
		expect(describeState(summary)).toBe("Running");
		expect(getStateTagStyle(summary)).toBe("success");
	});

	it("awaiting_review（live，有 pid）→ Ready for review / warning", () => {
		const summary = makeStatusSummary({ state: "awaiting_review", pid: 123 });
		expect(describeState(summary)).toBe("Ready for review");
		expect(getStateTagStyle(summary)).toBe("warning");
	});

	it("awaiting_review（exited，无 pid）→ 仍 Ready for review / warning（不因进程已退而改变展示）", () => {
		const summary = makeStatusSummary({ state: "awaiting_review", pid: null });
		expect(describeState(summary)).toBe("Ready for review");
		expect(getStateTagStyle(summary)).toBe("warning");
	});

	it("interrupted → Interrupted / danger", () => {
		const summary = makeStatusSummary({ state: "interrupted" });
		expect(describeState(summary)).toBe("Interrupted");
		expect(getStateTagStyle(summary)).toBe("danger");
	});

	it("failed → Failed / danger", () => {
		const summary = makeStatusSummary({ state: "failed" });
		expect(describeState(summary)).toBe("Failed");
		expect(getStateTagStyle(summary)).toBe("danger");
	});

	it("idle → Idle / neutral", () => {
		const summary = makeStatusSummary({ state: "idle" });
		expect(describeState(summary)).toBe("Idle");
		expect(getStateTagStyle(summary)).toBe("neutral");
	});

	it("采信已存在的显式 facet：exited 的 awaiting_review 仍走 user 分支", () => {
		const summary = makeStatusSummary({
			state: "awaiting_review",
			pid: null,
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
		});
		expect(describeState(summary)).toBe("Ready for review");
		expect(getStateTagStyle(summary)).toBe("warning");
	});
});
