import { act, forwardRef, type ReactNode, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import { DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX } from "@/resize/use-card-detail-layout";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard, BoardColumn, BoardColumnId, CardSelection } from "@/types";

const mockUseRuntimeWorkspaceChanges = vi.fn();
const {
	mockAgentTerminalPanel,
	mockClineAgentChatPanel,
	mockDiffViewerPanel,
	mockClineAppendToDraft,
	mockClineSendText,
	mockUseIsMobile,
	mockPromptLibraryPanel,
	mockUseAgentRaisedPendingUserDecision,
	mockAgentRaisedPendingUserDecisionPanel,
} = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn((_props: { panelBackgroundColor?: string; terminalBackgroundColor?: string }) => null),
	mockClineAgentChatPanel: vi.fn((..._args: unknown[]) => null),
	mockDiffViewerPanel: vi.fn((..._args: unknown[]) => null),
	mockClineAppendToDraft: vi.fn(),
	mockClineSendText: vi.fn(async () => {}),
	mockUseIsMobile: vi.fn(() => false),
	mockPromptLibraryPanel: vi.fn((_props: unknown) => null),
	mockUseAgentRaisedPendingUserDecision: vi.fn(),
	mockAgentRaisedPendingUserDecisionPanel: vi.fn((_props: unknown) => null),
}));

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

vi.mock("@/hooks/use-is-mobile", () => ({
	useIsMobile: () => mockUseIsMobile(),
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: mockAgentTerminalPanel,
}));

vi.mock("@/components/detail-panels/agent-raised-pending-user-decision-panel", () => ({
	AgentRaisedPendingUserDecisionPanel: mockAgentRaisedPendingUserDecisionPanel,
}));

vi.mock("@/hooks/use-agent-raised-pending-user-decision", () => ({
	useAgentRaisedPendingUserDecision: (input: unknown) => mockUseAgentRaisedPendingUserDecision(input),
}));

vi.mock("@/components/detail-panels/cline-agent-chat-panel", () => ({
	ClineAgentChatPanel: forwardRef((props: unknown, ref) => {
		mockClineAgentChatPanel(props);
		useImperativeHandle(ref, () => ({
			appendToDraft: mockClineAppendToDraft,
			sendText: mockClineSendText,
		}));
		return <div data-testid="cline-agent-chat-panel" />;
	}),
}));

vi.mock("@/components/detail-panels/column-context-panel", () => ({
	ColumnContextPanel: () => <div data-testid="column-context-panel" />,
}));

vi.mock("@/components/detail-panels/diff-viewer-panel", () => ({
	DiffViewerPanel: (props: unknown) => {
		mockDiffViewerPanel(props);
		return <div data-testid="diff-viewer-panel" />;
	},
}));

vi.mock("@/components/detail-panels/file-tree-panel", () => ({
	FileTreePanel: () => <div data-testid="file-tree-panel" />,
}));

vi.mock("@/components/detail-panels/prompt-library-panel", () => ({
	PromptLibraryPanel: (props: { headerContent?: ReactNode }) => {
		mockPromptLibraryPanel(props);
		return <div data-testid="prompt-library-panel">{props.headerContent}</div>;
	},
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/runtime/use-runtime-workspace-changes", () => ({
	useRuntimeWorkspaceChanges: (...args: unknown[]) => mockUseRuntimeWorkspaceChanges(...args),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceStateVersionValue: () => 0,
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Task ${id}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [
		{
			id: "backlog",
			title: "Backlog",
			cards: [card],
		},
		{
			id: "in_progress",
			title: "In Progress",
			cards: [],
		},
		{
			id: "review",
			title: "Review",
			cards: [],
		},
		{
			id: "trash",
			title: "Done",
			cards: [],
		},
	];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

function createSessionSummary(
	taskId = "task-1",
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		...overrides,
	};
}

function createSelectionInColumn(columnId: BoardColumnId): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "validation", title: "Validation", cards: [] },
		{ id: "trash", title: "Done", cards: [] },
	];
	const targetColumn = columns.find((column) => column.id === columnId);
	if (!targetColumn) {
		throw new Error(`Unknown column ${columnId}`);
	}
	targetColumn.cards.push(card);
	return {
		card,
		column: targetColumn,
		allColumns: columns,
	};
}

type MockedDiffViewerProps = {
	onAddToTerminal?: (formatted: string) => void;
	onSendToTerminal?: (formatted: string) => void;
};

function getLastMockFirstArg<T>(mockFn: { mock: { calls: unknown[][] } }): T {
	const lastCall = mockFn.mock.calls.at(-1);
	expect(lastCall).toBeDefined();
	return lastCall?.[0] as T;
}

function requireResizeSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize agent and diff panels"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a resize separator.");
	}
	return separator;
}

function requireAgentPanel(container: HTMLElement): HTMLElement {
	const separator = requireResizeSeparator(container);
	const panel = separator.previousElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected an agent panel element.");
	}
	return panel;
}

function setMainRowWidthForAgentResize(container: HTMLElement, width: number): void {
	const separator = requireResizeSeparator(container);
	if (!(separator.parentElement instanceof HTMLElement)) {
		throw new Error("Expected a main row element.");
	}
	Object.defineProperty(separator.parentElement, "offsetWidth", {
		configurable: true,
		value: width,
	});
}

function requireDetailDiffSeparator(container: HTMLElement): HTMLElement {
	const separator = container.querySelector('[aria-label="Resize detail diff panels"]');
	if (!(separator instanceof HTMLElement)) {
		throw new Error("Expected a detail diff resize separator.");
	}
	return separator;
}

function requireDetailDiffFileTreePanel(container: HTMLElement): HTMLElement {
	const separator = requireDetailDiffSeparator(container);
	const panel = separator.nextElementSibling;
	if (!(panel instanceof HTMLElement)) {
		throw new Error("Expected a detail diff file tree panel element.");
	}
	return panel;
}

function requireButtonWithExactText(container: HTMLElement, buttonText: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidateButton) => candidateButton.textContent?.trim() === buttonText,
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Expected a button with text "${buttonText}".`);
	}
	return button;
}

describe("CardDetailView", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		window.localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockAgentTerminalPanel.mockClear();
		mockClineAgentChatPanel.mockClear();
		mockDiffViewerPanel.mockClear();
		mockClineAppendToDraft.mockClear();
		mockClineSendText.mockClear();
		mockUseIsMobile.mockReturnValue(false);
		mockPromptLibraryPanel.mockClear();
		mockUseAgentRaisedPendingUserDecision.mockReset();
		mockUseAgentRaisedPendingUserDecision.mockReturnValue({
			decision: null,
			isLoading: false,
			isSubmitting: false,
			answer: vi.fn(),
			dismiss: vi.fn(),
		});
		mockAgentRaisedPendingUserDecisionPanel.mockClear();
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: {
				files: [
					{
						path: "src/example.ts",
						status: "modified",
						additions: 1,
						deletions: 0,
						oldText: "before\n",
						newText: "after\n",
					},
				],
			},
			error: null,
			queryPhase: "ready",
			isRequestInFlight: false,
			refresh: vi.fn(),
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		mockUseRuntimeWorkspaceChanges.mockReset();
		mockAgentTerminalPanel.mockClear();
		mockClineAgentChatPanel.mockClear();
		mockDiffViewerPanel.mockClear();
		mockClineAppendToDraft.mockClear();
		mockClineSendText.mockClear();
		mockUseIsMobile.mockReset();
		mockPromptLibraryPanel.mockClear();
		mockUseAgentRaisedPendingUserDecision.mockReset();
		mockAgentRaisedPendingUserDecisionPanel.mockClear();
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("defaults to Sessions and Prompts without collecting workspace changes", async () => {
		const sessionSummary = createSessionSummary();
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="codex"
					sessionSummary={sessionSummary}
					taskSessions={{ "task-1": sessionSummary }}
					onCreateByTheWayTaskConversationSession={async () => ({ ok: true })}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(mockUseRuntimeWorkspaceChanges.mock.calls.at(-1)?.[0]).toBeNull();
		expect(container.textContent).toContain("Sessions");
		expect(container.textContent).toContain("Main session");
		expect(container.querySelector('[data-testid="prompt-library-panel"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="diff-viewer-panel"]')).toBeNull();
	});

	it("按当前选中的主/By-the-way 会话隔离待答 taskId、实时 hook signal 与 turn sequence", async () => {
		const mainHookActivity = {
			activityText: "main activity",
			toolName: "Read",
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "PostToolUse",
			notificationType: null,
			source: "claude",
		};
		const childHookActivity = {
			...mainHookActivity,
			activityText: "child question",
			toolName: "AskUserQuestion",
			hookEventName: "PreToolUse",
		};
		const mainSummary = createSessionSummary("task-1", {
			latestHookActivity: mainHookActivity,
			agentResponseGenerationTurnSequence: 3,
		});
		const childTaskId = "task-conversation-session-child";
		const childSummary = createSessionSummary(childTaskId, {
			latestHookActivity: childHookActivity,
			agentResponseGenerationTurnSequence: 9,
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "started_from_scratch",
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: "main prompt",
				latestUserMessagePreview: "side question",
			},
		});
		mockUseAgentRaisedPendingUserDecision.mockImplementation(({ taskId }: { taskId: string }) => ({
			decision:
				taskId === childTaskId
					? {
							decisionId: `${childTaskId}:question-1`,
							taskId: childTaskId,
							agentId: "claude",
							decisionKind: "ordinary_user_question",
							questionMarkdown: "side question",
							options: [],
							allowsFreeformAnswer: true,
							orderedQuestions: [],
							askedAt: 1,
							reclaimedAt: null,
							answerDeliveryState: "not_answered",
							lastAnswerDeliveryFailureReason: null,
						}
					: null,
			isLoading: false,
			isSubmitting: false,
			answer: vi.fn(),
			dismiss: vi.fn(),
		}));

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={mainSummary}
					taskSessions={{ "task-1": mainSummary, [childTaskId]: childSummary }}
					onCreateByTheWayTaskConversationSession={async () => ({ ok: true })}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});
		expect(mockUseAgentRaisedPendingUserDecision).toHaveBeenLastCalledWith({
			workspaceId: "workspace-1",
			taskId: "task-1",
			runtimeSessionLatestHookActivity: mainHookActivity,
		});

		const byTheWaySessionButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("By the way"),
		);
		expect(byTheWaySessionButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			byTheWaySessionButton?.click();
		});

		expect(mockUseAgentRaisedPendingUserDecision).toHaveBeenLastCalledWith({
			workspaceId: "workspace-1",
			taskId: childTaskId,
			runtimeSessionLatestHookActivity: childHookActivity,
		});
		expect(mockAgentRaisedPendingUserDecisionPanel.mock.calls.at(-1)?.[0]).toEqual(
			expect.objectContaining({
				decision: expect.objectContaining({ taskId: childTaskId }),
				agentResponseGenerationTurnSequence: 9,
			}),
		);
	});

	it("keeps mobile Sessions and Prompts reachable without rendering disabled workspace changes", async () => {
		mockUseIsMobile.mockReturnValue(true);
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: null,
			error: null,
			queryPhase: "disabled",
			isRequestInFlight: false,
			refresh: vi.fn(),
		});
		const sessionSummary = createSessionSummary();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="codex"
					sessionSummary={sessionSummary}
					taskSessions={{ "task-1": sessionSummary }}
					onCreateByTheWayTaskConversationSession={async () => ({ ok: true })}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(mockUseRuntimeWorkspaceChanges.mock.calls.at(-1)?.[0]).toBeNull();
		expect(container.querySelector(".kb-skeleton")).toBeNull();
		expect(() => requireButtonWithExactText(container, "Diff")).toThrow();
		expect(() => requireButtonWithExactText(container, "Files")).toThrow();

		const sessionsButton = requireButtonWithExactText(container, "Sessions");
		await act(async () => sessionsButton.click());
		expect(sessionsButton.className).toContain("text-accent");
		expect(container.textContent).toContain("Main session");

		const promptsButton = requireButtonWithExactText(container, "Prompts");
		await act(async () => promptsButton.click());
		expect(promptsButton.className).toContain("text-accent");
		expect(container.querySelector('[data-testid="prompt-library-panel"]')).not.toBeNull();
	});

	it("enables mobile workspace changes tabs and queries the main task when Changes is open", async () => {
		mockUseIsMobile.mockReturnValue(true);
		const sessionSummary = createSessionSummary();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="codex"
					isTaskChangesSidebarOpen
					sessionSummary={sessionSummary}
					taskSessions={{ "task-1": sessionSummary }}
					onCreateByTheWayTaskConversationSession={async () => ({ ok: true })}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(mockUseRuntimeWorkspaceChanges.mock.calls.at(-1)?.[0]).toBe("task-1");
		expect(requireButtonWithExactText(container, "Diff")).toBeInstanceOf(HTMLButtonElement);
		expect(requireButtonWithExactText(container, "Files")).toBeInstanceOf(HTMLButtonElement);
		expect(requireButtonWithExactText(container, "Sessions")).toBeInstanceOf(HTMLButtonElement);
		expect(requireButtonWithExactText(container, "Prompts")).toBeInstanceOf(HTMLButtonElement);
	});

	it("keeps the Changes toolbar mounted during an initial request error and retries on demand", async () => {
		const refresh = vi.fn(async () => {});
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: null,
			error: new Error("temporary changes failure"),
			queryPhase: "initial_error",
			isRequestInFlight: false,
			refresh,
		});

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireButtonWithExactText(container, "All Changes")).toBeInstanceOf(HTMLButtonElement);
		expect(requireButtonWithExactText(container, "Last Turn")).toBeInstanceOf(HTMLButtonElement);
		expect(container.textContent).toContain("Could not load changes");
		expect(container.textContent).toContain("temporary changes failure");

		await act(async () => requireButtonWithExactText(container, "Retry").click());
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("keeps the last successful diff visible with a stale-data warning after a refresh error", async () => {
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: {
				files: [
					{
						path: "src/last-good.ts",
						status: "modified",
						additions: 1,
						deletions: 0,
						oldText: "before\n",
						newText: "after\n",
					},
				],
			},
			error: new Error("poll failed"),
			queryPhase: "stale_after_refresh_error",
			isRequestInFlight: false,
			refresh: vi.fn(),
		});

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireButtonWithExactText(container, "All Changes")).toBeInstanceOf(HTMLButtonElement);
		expect(container.textContent).toContain("Changes may be out of date");
		expect(container.textContent).toContain("poll failed");
		expect(container.querySelector('[data-testid="diff-viewer-panel"]')).toBeInstanceOf(HTMLDivElement);
		expect(container.querySelector('[data-testid="file-tree-panel"]')).toBeInstanceOf(HTMLDivElement);
	});

	it("shows a stable unavailable state instead of empty diff and file icons when workspace scope is missing", async () => {
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: null,
			error: null,
			queryPhase: "missing_workspace_scope",
			isRequestInFlight: false,
			refresh: vi.fn(),
		});

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId={null}
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireButtonWithExactText(container, "All Changes")).toBeInstanceOf(HTMLButtonElement);
		expect(container.textContent).toContain("Workspace changes unavailable");
		expect(container.querySelector('[data-testid="diff-viewer-panel"]')).toBeNull();
		expect(container.querySelector('[data-testid="file-tree-panel"]')).toBeNull();
	});

	it("keeps the mobile Changes toolbar mounted during an initial request error", async () => {
		mockUseIsMobile.mockReturnValue(true);
		mockUseRuntimeWorkspaceChanges.mockReturnValue({
			changes: null,
			error: new Error("mobile changes failure"),
			queryPhase: "initial_error",
			isRequestInFlight: true,
			refresh: vi.fn(),
		});

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		await act(async () => requireButtonWithExactText(container, "Diff").click());
		expect(requireButtonWithExactText(container, "All Changes")).toBeInstanceOf(HTMLButtonElement);
		expect(container.textContent).toContain("Could not load changes");
	});

	it("collapses the expanded diff on Escape without closing the detail view", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expandButton.click();
		});

		const toolbarButtons = Array.from(container.querySelectorAll("button"));
		expect(toolbarButtons[0]?.getAttribute("aria-label")).toBe("Collapse expanded diff view");
		expect(toolbarButtons[1]?.textContent?.trim()).toBe("All Changes");
		expect(toolbarButtons[2]?.textContent?.trim()).toBe("Last Turn");
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeNull();

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(container.querySelector('button[aria-label="Collapse expanded diff view"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("clears stale diff content when switching from all changes to last turn", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastTurnButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Last Turn",
		);
		expect(lastTurnButton).toBeInstanceOf(HTMLButtonElement);
		if (!(lastTurnButton instanceof HTMLButtonElement)) {
			throw new Error("Expected a Last Turn button.");
		}

		await act(async () => {
			lastTurnButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lastTurnButton.click();
		});

		const lastCall = mockUseRuntimeWorkspaceChanges.mock.calls.at(-1);
		expect(lastCall?.[4]).toBe("last_turn");
		expect(lastCall?.[8]).toBe(true);
	});

	it("keeps the active diff mode visually highlighted", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const getDiffModeButton = (label: string): HTMLButtonElement => {
			const button = Array.from(container.querySelectorAll("button")).find(
				(candidate) => candidate.textContent?.trim() === label,
			);
			if (!(button instanceof HTMLButtonElement)) {
				throw new Error(`Expected a ${label} button.`);
			}
			return button;
		};

		const allChangesButton = getDiffModeButton("All Changes");
		const lastTurnButton = getDiffModeButton("Last Turn");

		expect(allChangesButton.getAttribute("aria-pressed")).toBe("true");
		expect(allChangesButton.getAttribute("style")).toContain(
			"background-color: color-mix(in srgb, var(--color-surface-3) 80%, var(--color-text-primary))",
		);
		expect(lastTurnButton.getAttribute("aria-pressed")).toBe("false");
		expect(lastTurnButton.style.backgroundColor).toBe("");

		await act(async () => {
			lastTurnButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lastTurnButton.click();
		});

		expect(getDiffModeButton("All Changes").getAttribute("aria-pressed")).toBe("false");
		expect(getDiffModeButton("All Changes").style.backgroundColor).toBe("");
		expect(getDiffModeButton("Last Turn").getAttribute("aria-pressed")).toBe("true");
		expect(getDiffModeButton("Last Turn").getAttribute("style")).toContain(
			"background-color: color-mix(in srgb, var(--color-surface-3) 80%, var(--color-text-primary))",
		);
	});

	it("switches the top-right detail utility panel from prompts to task comments and saves a new comment", async () => {
		const onTaskCommentEntriesChange = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onTaskCommentEntriesChange={onTaskCommentEntriesChange}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="prompt-library-panel"]')).toBeInstanceOf(HTMLDivElement);
		const commentsTab = Array.from(container.querySelectorAll("button")).find(
			(button) => button.getAttribute("role") === "tab" && button.textContent?.trim() === "Comments",
		);
		expect(commentsTab).toBeInstanceOf(HTMLButtonElement);
		if (!(commentsTab instanceof HTMLButtonElement)) {
			throw new Error("Expected a Comments tab.");
		}

		await act(async () => {
			commentsTab.click();
		});

		const textarea = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Write a task comment..."]');
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		if (!(textarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected a task comment textarea.");
		}

		await act(async () => {
			const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			valueSetter?.call(textarea, "Investigate this before final validation.");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const addButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Add comment",
		);
		expect(addButton).toBeInstanceOf(HTMLButtonElement);
		if (!(addButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an Add comment button.");
		}

		await act(async () => {
			addButton.click();
		});

		expect(onTaskCommentEntriesChange).toHaveBeenCalledTimes(1);
		expect(onTaskCommentEntriesChange.mock.calls[0]?.[0]).toBe("task-1");
		expect(onTaskCommentEntriesChange.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({
				commentText: "Investigate this before final validation.",
			}),
		]);
	});

	it("closes git history before handling other Escape behavior", async () => {
		const onCloseGitHistory = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					gitHistoryPanel={<div data-testid="git-history-panel">Git history</div>}
					onCloseGitHistory={onCloseGitHistory}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const input = document.createElement("input");
		container.appendChild(input);
		input.focus();

		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(onCloseGitHistory).toHaveBeenCalledTimes(1);
	});

	it("renders native chat panel for cline agent", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeInstanceOf(HTMLDivElement);
		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).toBeNull();
	});

	it("does not render native chat panel when the task explicitly uses a non-cline agent", async () => {
		const selection = createSelection();
		selection.card.agentId = "codex";

		await act(async () => {
			root.render(
				<CardDetailView
					selection={selection}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeNull();
	});

	it("shows cline chat panel when task session agentId is cline even if global agent is claude", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						warningMessage: null,
					}}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeInstanceOf(HTMLDivElement);
	});

	it("shows terminal panel when task session agentId is claude even if global agent is cline", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "claude",
						workspacePath: null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						warningMessage: null,
					}}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeNull();
		expect(mockAgentTerminalPanel).toHaveBeenCalled();
	});

	it("uses surface-primary colors for the detail terminal panel", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastCall = mockAgentTerminalPanel.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			panelBackgroundColor: "var(--color-surface-0)",
			terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
		});
	});

	it("shows a resize handle and default fixed width for the non-cline terminal panel", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireResizeSeparator(container)).toBeInstanceOf(HTMLElement);
		expect(requireAgentPanel(container).style.width).toBe(`${DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX}px`);
	});

	it("persists the resized non-cline terminal panel width as pixels", async () => {
		const renderDetail = async (): Promise<void> => {
			await act(async () => {
				root.render(
					<CardDetailView
						selection={createSelection()}
						currentProjectId="workspace-1"
						selectedAgentId="claude"
						sessionSummary={null}
						taskSessions={{}}
						onSessionSummary={() => {}}
						onCardSelect={() => {}}
						onTaskDragEnd={() => {}}
						onMoveToTrash={() => {}}
						bottomTerminalOpen={false}
						bottomTerminalTaskId={null}
						bottomTerminalSummary={null}
						onBottomTerminalClose={() => {}}
					/>,
				);
			});
		};

		await renderDetail();
		setMainRowWidthForAgentResize(container, 1400);
		const separator = requireResizeSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200 }));
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 480 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 480 }));
		});

		const savedWidth = window.localStorage.getItem(LocalStorageKey.DetailTerminalPanelWidth);
		expect(savedWidth).toBe("800");
		expect(requireAgentPanel(container).style.width).toBe("800px");

		await act(async () => {
			root.unmount();
			root = createRoot(container);
		});

		await renderDetail();
		expect(requireAgentPanel(container).style.width).toBe("800px");
	});

	it("queues Add diff comments into the cline composer without sending them", async () => {
		const onAddReviewComments = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onAddReviewComments={onAddReviewComments}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const diffProps = getLastMockFirstArg<MockedDiffViewerProps>(mockDiffViewerPanel);
		expect(diffProps.onAddToTerminal).toBeTypeOf("function");

		await act(async () => {
			diffProps.onAddToTerminal?.("src/example.ts:4 | value\n> Add tests");
		});

		expect(onAddReviewComments).not.toHaveBeenCalled();
		expect(mockClineAppendToDraft).toHaveBeenCalledWith("src/example.ts:4 | value\n> Add tests");
	});

	it("routes Send diff comments through the mounted cline panel", async () => {
		const onSendReviewComments = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onSendReviewComments={onSendReviewComments}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const diffProps = getLastMockFirstArg<MockedDiffViewerProps>(mockDiffViewerPanel);
		expect(diffProps.onSendToTerminal).toBeTypeOf("function");

		await act(async () => {
			diffProps.onSendToTerminal?.("src/example.ts:8 | done\n> Ship this");
			await Promise.resolve();
		});

		expect(onSendReviewComments).not.toHaveBeenCalled();
		expect(mockClineSendText).toHaveBeenCalledWith("src/example.ts:8 | done\n> Ship this");
	});

	it("loads the saved agent-to-diff panel ratio from local storage", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailAgentPanelRatio, "0.62");

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireAgentPanel(container).style.width).toBe("62%");
	});

	it("persists the resized agent-to-diff panel ratio globally", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const separator = requireResizeSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 160 }));
		});
		await act(async () => {
			window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 320 }));
		});

		const savedRatioRaw = window.localStorage.getItem(LocalStorageKey.DetailAgentPanelRatio);
		expect(savedRatioRaw).not.toBeNull();
		const savedRatio = Number(savedRatioRaw);
		expect(savedRatio).toBeGreaterThan(0.4);
		expect(savedRatio).toBeLessThanOrEqual(0.75);
		expect(requireAgentPanel(container).style.width).not.toBe("40%");
	});

	it("keeps the saved divider position after leaving and reopening task detail", async () => {
		const renderDetail = async (): Promise<void> => {
			await act(async () => {
				root.render(
					<CardDetailView
						selection={createSelection()}
						currentProjectId="workspace-1"
						selectedAgentId="cline"
						sessionSummary={null}
						taskSessions={{}}
						onSessionSummary={() => {}}
						onCardSelect={() => {}}
						onTaskDragEnd={() => {}}
						onMoveToTrash={() => {}}
						bottomTerminalOpen={false}
						bottomTerminalTaskId={null}
						bottomTerminalSummary={null}
						onBottomTerminalClose={() => {}}
					/>,
				);
			});
		};

		await renderDetail();

		const separator = requireResizeSeparator(container);
		const dragHandle = separator.firstElementChild;
		expect(dragHandle).toBeInstanceOf(HTMLDivElement);
		if (!(dragHandle instanceof HTMLDivElement)) {
			throw new Error("Expected a draggable resize handle.");
		}

		await act(async () => {
			dragHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200 }));
			window.dispatchEvent(new MouseEvent("mouseup", { clientX: 420 }));
		});

		const expectedRatio = window.localStorage.getItem(LocalStorageKey.DetailAgentPanelRatio);
		expect(expectedRatio).not.toBeNull();

		await act(async () => {
			root.unmount();
			root = createRoot(container);
		});

		await renderDetail();

		const restoredWidth = requireAgentPanel(container).style.width;
		const restoredRatio = Number.parseFloat(restoredWidth) / 100;
		expect(restoredRatio).toBeCloseTo(Number(expectedRatio), 2);
	});

	it("uses separate file-tree ratios for collapsed and expanded diff layouts", async () => {
		window.localStorage.setItem(LocalStorageKey.DetailDiffFileTreePanelRatio, "0.42");
		window.localStorage.setItem(LocalStorageKey.DetailExpandedDiffFileTreePanelRatio, "0.18");

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					isTaskChangesSidebarOpen
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 42%");

		const expandButton = container.querySelector('button[aria-label="Expand split diff view"]');
		expect(expandButton).toBeInstanceOf(HTMLButtonElement);
		if (!(expandButton instanceof HTMLButtonElement)) {
			throw new Error("Expected an expand diff button.");
		}

		await act(async () => {
			expandButton.click();
		});

		expect(requireDetailDiffFileTreePanel(container).style.flex).toBe("0 0 18%");
	});

	it("hides the agent-panel Move to Validation / Move to Done actions for in-progress cards", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelectionInColumn("in_progress")}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					onMoveToValidation={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const panelProps = getLastMockFirstArg<{
			showMoveToTrash?: boolean;
			showMoveToValidation?: boolean;
		}>(mockClineAgentChatPanel);
		expect(panelProps.showMoveToTrash).toBe(false);
		expect(panelProps.showMoveToValidation).toBe(false);
	});

	it("forwards the review agent-panel Move to Done to the parent handler (confirmation is centralized)", async () => {
		const onMoveToTrash = vi.fn();
		const onMoveToValidation = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelectionInColumn("review")}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={onMoveToTrash}
					onMoveToValidation={onMoveToValidation}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const panelProps = getLastMockFirstArg<{
			onMoveToTrash?: () => void;
			showMoveToTrash?: boolean;
			showMoveToValidation?: boolean;
		}>(mockClineAgentChatPanel);
		expect(panelProps.showMoveToTrash).toBe(true);
		expect(panelProps.showMoveToValidation).toBe(true);

		// The confirmation now lives at the App level (driven by useBoardInteractions), so CardDetailView
		// just forwards the click to the parent handler — no local dialog.
		await act(async () => {
			panelProps.onMoveToTrash?.();
		});
		expect(document.body.textContent).not.toContain("Move directly to Done?");
		expect(onMoveToTrash).toHaveBeenCalledTimes(1);
	});

	it("moves a validation card to Done without confirmation", async () => {
		const onMoveToTrash = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelectionInColumn("validation")}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={onMoveToTrash}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const panelProps = getLastMockFirstArg<{
			onMoveToTrash?: () => void;
			showMoveToTrash?: boolean;
			showMoveToValidation?: boolean;
		}>(mockClineAgentChatPanel);
		expect(panelProps.showMoveToTrash).toBe(true);
		expect(panelProps.showMoveToValidation).toBe(false);

		await act(async () => {
			panelProps.onMoveToTrash?.();
		});
		expect(document.body.textContent).not.toContain("Move directly to Done?");
		expect(onMoveToTrash).toHaveBeenCalledTimes(1);
	});
});
