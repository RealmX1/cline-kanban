import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalPanel, describeState, getStateTagStyle } from "@/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";

const { mockRefreshTerminal, mockUseIsMobile, mockTerminalInput, mockReadScrollbackTranscript } = vi.hoisted(() => ({
	mockRefreshTerminal: vi.fn(async () => {}),
	mockUseIsMobile: vi.fn(() => false),
	mockTerminalInput: vi.fn((_sequence: string) => true),
	mockReadScrollbackTranscript: vi.fn(() => [] as { text: string; sourceBufferRowIndex: number }[]),
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
		isScrolledAwayFromLatest: false,
		clearTerminal: vi.fn(),
		closeTerminalSearch: vi.fn(),
		findNextInTerminal: vi.fn(() => false),
		findPreviousInTerminal: vi.fn(() => false),
		openTerminalSearch: vi.fn(),
		refreshTerminal: mockRefreshTerminal,
		scrollTerminalToLatest: vi.fn(),
		stopTerminal: vi.fn(async () => {}),
	}),
}));

vi.mock("@/hooks/use-is-mobile", () => ({
	useIsMobile: () => mockUseIsMobile(),
}));

vi.mock("@/terminal/terminal-controller-registry", () => ({
	getTerminalController: () => ({ input: mockTerminalInput, paste: vi.fn(() => true) }),
	readTerminalScrollbackTranscript: () => mockReadScrollbackTranscript(),
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
		mockTerminalInput.mockClear();
		mockReadScrollbackTranscript.mockClear();
		mockUseIsMobile.mockReturnValue(false);
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

	it("offers the transcript reader toggle on desktop too, not just on mobile", () => {
		mockUseIsMobile.mockReturnValue(false);
		mockReadScrollbackTranscript.mockReturnValue([{ text: "earlier output", sourceBufferRowIndex: 0 }]);

		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createSummary("codex")}
						showSessionToolbar
					/>
				</TooltipProvider>,
			);
		});

		const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Read the transcript as a document"]');
		expect(toggle).not.toBeNull();
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");

		act(() => {
			toggle?.click();
		});

		// 阅读视图叠加在 xterm 之上；xterm 容器仍留在 DOM 里（终端不卸载、PTY 继续跑）。
		expect(container.querySelector('[aria-label="Filter transcript lines"]')).not.toBeNull();
		expect(container.querySelector(".kb-terminal-container")).not.toBeNull();
		// 断言行数标签而非行内容：列表走 react-virtuoso，jsdom 里没有真实布局高度、算不出可视区，
		// 因而不渲染任何 item。行数标签同样证明 transcript 已从终端读到。
		expect(container.textContent).toContain("1 lines");

		const backToTerminal = container.querySelector<HTMLButtonElement>('[aria-label="Back to the live terminal"]');
		expect(backToTerminal?.getAttribute("aria-pressed")).toBe("true");
		act(() => {
			backToTerminal?.click();
		});
		expect(container.querySelector('[aria-label="Filter transcript lines"]')).toBeNull();
	});

	it("shows the virtual key bar only on mobile and sends the exact control sequences", () => {
		mockUseIsMobile.mockReturnValue(false);
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
		expect(container.querySelector('[aria-label="Arrow up"]')).toBeNull();

		mockUseIsMobile.mockReturnValue(true);
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

		act(() => {
			container
				.querySelector<HTMLButtonElement>('[aria-label="Interrupt the agent, or clear the current input line"]')
				?.click();
		});
		act(() => {
			container
				.querySelector<HTMLButtonElement>('[aria-label="Open the rewind history view (double escape)"]')
				?.click();
		});
		act(() => {
			container.querySelector<HTMLButtonElement>('[aria-label="Arrow up"]')?.click();
		});

		expect(mockTerminalInput.mock.calls.map((call) => call[0])).toEqual(["\u0003", "\u001b\u001b", "\u001b[A"]);
	});

	it("keeps the virtual key bar off synthetic shell terminals, which are not agent TUIs", () => {
		mockUseIsMobile.mockReturnValue(true);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="__detail_terminal__:task-1"
						workspaceId="workspace-1"
						summary={createSummary("codex", "__detail_terminal__:task-1")}
						showSessionToolbar={false}
						minimalHeaderTitle="Terminal"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[aria-label="Arrow up"]')).toBeNull();
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

	// channel B（distinction ②）：终端 agent 进程已退（liveness="exited"）时面板顶部提示「stream closed」。
	it("exited（终端进程已退 = awaiting_review + pid null）→ 顶部显示 Terminal stream closed 提示", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={{ ...createSummary("codex"), state: "awaiting_review", pid: null }}
						showSessionToolbar={false}
						minimalHeaderTitle="Terminal"
					/>
				</TooltipProvider>,
			);
		});
		expect(container.textContent).toContain("Terminal stream closed");
	});

	it("live awaiting（进程仍在，pid 非 null）→ 不显示 stream closed 提示", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={{ ...createSummary("codex"), state: "awaiting_review", pid: 123 }}
						showSessionToolbar={false}
						minimalHeaderTitle="Terminal"
					/>
				</TooltipProvider>,
			);
		});
		expect(container.textContent).not.toContain("Terminal stream closed");
	});

	// ②-prep × ②-visible 合成反证：Cline SDK 在进程内运行、awaiting 恒 live，即便 pid null 也绝不误报 stream closed。
	it("Cline awaiting（pid null 但 in-process）→ 不显示 stream closed（harness-aware 恒 live）", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={{ ...createSummary("cline"), state: "awaiting_review", pid: null }}
						showSessionToolbar={false}
						minimalHeaderTitle="Terminal"
					/>
				</TooltipProvider>,
			);
		});
		expect(container.textContent).not.toContain("Terminal stream closed");
	});

	it("running（agent 回合）→ 不显示 stream closed 提示", () => {
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
		expect(container.textContent).not.toContain("Terminal stream closed");
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
