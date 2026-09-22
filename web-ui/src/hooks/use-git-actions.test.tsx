import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UseGitActionsResult, useGitActions } from "@/hooks/use-git-actions";
import type { RuntimeConfigResponse, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import { clearTaskWorkspaceInfo, clearTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardCard, BoardData, CardSelection } from "@/types";

const showAppToastMock = vi.hoisted(() => vi.fn());
const useGitHistoryDataMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

vi.mock("@/components/git-history/use-git-history-data", () => ({
	useGitHistoryData: useGitHistoryDataMock,
}));

interface HookSnapshot {
	handleAgentCommitTask: UseGitActionsResult["handleAgentCommitTask"];
}

function createGitHistoryResult(): UseGitActionsResult["gitHistory"] {
	return {
		viewMode: "commit",
		refs: [],
		activeRef: null,
		refsErrorMessage: null,
		isRefsLoading: false,
		workingCopyFileCount: 0,
		hasWorkingCopy: false,
		commits: [],
		totalCommitCount: 0,
		selectedCommitHash: null,
		selectedCommit: null,
		isLogLoading: false,
		isLoadingMoreCommits: false,
		logErrorMessage: null,
		diffSource: null,
		isDiffLoading: false,
		diffErrorMessage: null,
		selectedDiffPath: null,
		selectWorkingCopy: () => {},
		selectRef: () => {},
		selectCommit: () => {},
		selectDiffPath: () => {},
		loadCommitFileDiffPatch: async () => {},
		loadAllCommitFileDiffPatches: async () => {},
		loadMoreCommits: () => {},
		refresh: () => {},
		isLoadingAllCommitFilePatches: false,
	};
}

function createBoard(cardOverrides?: Partial<BoardCard>): BoardData {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Ship it",
						prompt: "Ship it",
						startInPlanMode: false,
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
						...cardOverrides,
					},
				],
			},
		],
		dependencies: [],
	};
}

function createCardSelection(board: BoardData): CardSelection {
	const column = board.columns[0];
	const card = column?.cards[0];
	if (!column || !card) {
		throw new Error("Expected a board with at least one card.");
	}
	return { card, column, allColumns: board.columns };
}

function createRuntimeConfig(selectedAgentId: RuntimeConfigResponse["selectedAgentId"]): RuntimeConfigResponse {
	return {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		newTaskStartInPlanModeByDefault: true,
		userInterfacePreferencesSharedAcrossBrowserOrigins:
			USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
		ompAgentSessionTransportForNewTasks: "pty_terminal",
		effectiveCommand: null,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		readyForReviewNotificationsEnabled: true,
		notificationSoundEnabled: true,
		autoContinueOnConnectionDropEnabled: true,
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: true,
		postDeployVerificationForceCompleteEnabled: false,
		detectedCommands: [],
		agents: [
			{
				id: selectedAgentId,
				label: selectedAgentId,
				binary: selectedAgentId,
				command: selectedAgentId,
				defaultArgs: [],
				installed: true,
				configured: true,
			},
		],
		shortcuts: [],
		clineProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-sonnet-4",
			baseUrl: null,
			apiKeyConfigured: true,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
	};
}

function createWorkspaceInfo(): RuntimeTaskWorkspaceInfoResponse {
	return {
		taskId: "task-1",
		path: "/tmp/task-1",
		exists: true,
		baseRef: "main",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc1234",
	};
}

function HookHarness({
	board,
	selectedCard = null,
	onSnapshot,
	sendTaskSessionInput,
	sendTaskChatMessage,
}: {
	board?: BoardData;
	selectedCard?: CardSelection | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
	sendTaskSessionInput: Parameters<typeof useGitActions>[0]["sendTaskSessionInput"];
	sendTaskChatMessage: Parameters<typeof useGitActions>[0]["sendTaskChatMessage"];
}): null {
	const gitActions = useGitActions({
		currentProjectId: "project-1",
		board: board ?? createBoard(),
		selectedCard,
		runtimeProjectConfig: createRuntimeConfig("cline"),
		sendTaskSessionInput,
		sendTaskChatMessage,
		fetchTaskWorkspaceInfo: async () => createWorkspaceInfo(),
		taskConversationSessionSummariesByTaskId: {},
		isGitHistoryOpen: false,
		refreshWorkspaceState: async () => {},
	});

	useEffect(() => {
		onSnapshot({
			handleAgentCommitTask: gitActions.handleAgentCommitTask,
		});
	}, [gitActions.handleAgentCommitTask, onSnapshot]);

	return null;
}

describe("useGitActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		showAppToastMock.mockReset();
		useGitHistoryDataMock.mockReset();
		useGitHistoryDataMock.mockReturnValue(createGitHistoryResult());
		clearTaskWorkspaceInfo("task-1");
		clearTaskWorkspaceSnapshot("task-1");
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		clearTaskWorkspaceInfo("task-1");
		clearTaskWorkspaceSnapshot("task-1");
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("commit/PR 入口跨 summary 和 board 更新稳定，调用时使用最新列门控", async () => {
		let actions: UseGitActionsResult | null = null;
		const stableInput: Parameters<typeof useGitActions>[0] = {
			currentProjectId: "project-1",
			board: createBoard(),
			selectedCard: null,
			runtimeProjectConfig: createRuntimeConfig("cline"),
			sendTaskSessionInput: vi.fn(),
			sendTaskChatMessage: vi.fn(),
			fetchTaskWorkspaceInfo: async () => createWorkspaceInfo(),
			taskConversationSessionSummariesByTaskId: {},
			isGitHistoryOpen: false,
			refreshWorkspaceState: async () => {},
		};
		function Harness({ input }: { input: Parameters<typeof useGitActions>[0] }) {
			actions = useGitActions(input);
			return null;
		}
		await act(async () => root.render(<Harness input={stableInput} />));
		const first = actions!;
		const changedBoard = createBoard();
		changedBoard.columns[0]!.id = "validation";
		await act(async () =>
			root.render(
				<Harness input={{ ...stableInput, board: changedBoard, taskConversationSessionSummariesByTaskId: {} }} />,
			),
		);
		expect(actions!.handleAgentCommitTask).toBe(first.handleAgentCommitTask);
		expect(actions!.handleAgentOpenPrTask).toBe(first.handleAgentOpenPrTask);
		await act(async () => first.handleAgentCommitTask("task-1"));
		expect(stableInput.sendTaskChatMessage).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Commit and PR actions are only available for tasks in Review." }),
		);
	});

	it.each(["commit", "pr"] as const)("自动 Review 的 %s 投递保持来源、防重与失败清理", async (action) => {
		let actions: UseGitActionsResult | null = null;
		let finishDelivery: ((result: { ok: boolean; message?: string }) => void) | undefined;
		const sendTaskChatMessage = vi.fn(
			() =>
				new Promise<{ ok: boolean; message?: string }>((resolve) => {
					finishDelivery = resolve;
				}),
		);
		function Harness() {
			actions = useGitActions({
				currentProjectId: "project-1",
				board: createBoard(),
				selectedCard: null,
				runtimeProjectConfig: createRuntimeConfig("cline"),
				sendTaskSessionInput: vi.fn(),
				sendTaskChatMessage,
				fetchTaskWorkspaceInfo: async () => createWorkspaceInfo(),
				taskConversationSessionSummariesByTaskId: {},
				isGitHistoryOpen: false,
				refreshWorkspaceState: async () => {},
			});
			return null;
		}
		await act(async () => root.render(<Harness />));
		let delivery: Promise<boolean> | undefined;
		await act(async () => {
			delivery = actions!.runAutoReviewGitAction("task-1", action);
		});
		const sourceField = action === "commit" ? "commitSource" : "prSource";
		expect(actions!.taskGitActionLoadingByTaskId["task-1"]?.[sourceField]).toBe("automatic_review");
		expect(actions!.agentCommitTaskLoadingById).toEqual({});
		expect(actions!.agentOpenPrTaskLoadingById).toEqual({});
		await act(async () => {
			expect(await actions!.runAutoReviewGitAction("task-1", action)).toBe(false);
		});
		expect(sendTaskChatMessage).toHaveBeenCalledExactlyOnceWith("task-1", action, { mode: "act" });
		await act(async () => {
			finishDelivery!({ ok: false, message: "模拟投递失败" });
			await delivery;
		});
		expect(await delivery).toBe(false);
		expect(actions!.taskGitActionLoadingByTaskId).toEqual({});
		expect(showAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ message: "模拟投递失败" }));
		await act(async () => {
			delivery = actions!.runAutoReviewGitAction("task-1", action);
		});
		await act(async () => {
			finishDelivery!({ ok: true });
			await delivery;
		});
		expect(await delivery).toBe(true);
		expect(actions!.taskGitActionLoadingByTaskId).toEqual({});
	});

	it.each(["commit", "pr"] as const)("终端 %s 仍粘贴提示词后提交回车", async (action) => {
		vi.useFakeTimers();
		try {
			let actions: UseGitActionsResult | null = null;
			const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
			const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
			function Harness() {
				actions = useGitActions({
					currentProjectId: "project-1",
					board: createBoard({ agentId: "codex" }),
					selectedCard: null,
					runtimeProjectConfig: {
						...createRuntimeConfig("codex"),
						commitPromptTemplate: "commit {{base_ref}}",
						openPrPromptTemplate: "pr {{base_ref}}",
					},
					sendTaskSessionInput,
					sendTaskChatMessage,
					fetchTaskWorkspaceInfo: async () => createWorkspaceInfo(),
					taskConversationSessionSummariesByTaskId: {},
					isGitHistoryOpen: false,
					refreshWorkspaceState: async () => {},
				});
				return null;
			}
			await act(async () => root.render(<Harness />));
			await act(async () => {
				if (action === "commit") actions!.handleAgentCommitTask("task-1");
				else actions!.handleAgentOpenPrTask("task-1");
			});
			expect(sendTaskSessionInput).toHaveBeenCalledExactlyOnceWith("task-1", `${action} main`, {
				appendNewline: false,
				mode: "paste",
			});
			expect(
				(action === "commit" ? actions!.agentCommitTaskLoadingById : actions!.agentOpenPrTaskLoadingById)["task-1"],
			).toBe(true);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
			expect(sendTaskSessionInput).toHaveBeenNthCalledWith(2, "task-1", "\r", { appendNewline: false });
			expect(sendTaskChatMessage).not.toHaveBeenCalled();
			expect(actions!.taskGitActionLoadingByTaskId).toEqual({});
		} finally {
			vi.useRealTimers();
		}
	});

	it("passes the selected card's worktreeMode to the git history task scope", async () => {
		const board = createBoard({ worktreeMode: "inplace" });
		const selection = createCardSelection(board);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					selectedCard={selection}
					onSnapshot={() => {
						/* noop */
					}}
					sendTaskSessionInput={async () => ({ ok: true })}
					sendTaskChatMessage={async () => ({ ok: true })}
				/>,
			);
		});

		expect(useGitHistoryDataMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskScope: {
					taskId: "task-1",
					baseRef: "main",
					worktreeMode: "inplace",
				},
			}),
		);
	});

	it("omits worktreeMode from the git history task scope when the card has none", async () => {
		const board = createBoard();
		const selection = createCardSelection(board);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					selectedCard={selection}
					onSnapshot={() => {
						/* noop */
					}}
					sendTaskSessionInput={async () => ({ ok: true })}
					sendTaskChatMessage={async () => ({ ok: true })}
				/>,
			);
		});

		const lastOptions = useGitHistoryDataMock.mock.calls.at(-1)?.[0] as
			| { taskScope?: { taskId: string; baseRef: string } | null }
			| undefined;
		expect(lastOptions?.taskScope).toEqual({ taskId: "task-1", baseRef: "main" });
		expect(lastOptions?.taskScope).not.toHaveProperty("worktreeMode");
	});

	it("sends commit prompts through the native cline chat API", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					sendTaskChatMessage={sendTaskChatMessage}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot?.handleAgentCommitTask("task-1");
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(sendTaskChatMessage).toHaveBeenCalledWith("task-1", expect.any(String), { mode: "act" });
		expect(sendTaskSessionInput).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});
});
