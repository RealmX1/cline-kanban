import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
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
