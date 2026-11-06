const openSideSessionCreationWorkbenchMock = vi.hoisted(() => vi.fn());
vi.mock("@/state/side-session-creation-workbench-store", () => ({
	refreshSideSessionCreationWorkbenchContext: vi.fn(),
	openSideSessionCreationWorkbench: openSideSessionCreationWorkbenchMock,
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskConversationSessionsPanel } from "@/components/detail-panels/task-conversation-sessions-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { SideSessionCreationWorkbenchTarget } from "@/state/side-session-creation-workbench-store";
import { LocalStorageKey } from "@/storage/local-storage-store";

const ORIGINAL_PROMPT_CARD = {
	title: "Build sessions",
	prompt: "Build sessions end to end.",
	images: undefined,
	createdAt: 1,
};

function createSessionSummary(
	taskId: string,
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

// 真实应用把 TooltipProvider 挂在 main.tsx 的根上（Radix 的 Tooltip 没有 Provider 会直接抛），
// 这里照同一个形态包裹整个 root，而不是给每一处 render 各加一层。
function createRootRenderingInsideTooltipProvider(mountContainer: HTMLElement): Root {
	const reactRoot = createRoot(mountContainer);
	return {
		...reactRoot,
		render: (children: React.ReactNode) => reactRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => reactRoot.unmount(),
	};
}

describe("TaskConversationSessionsPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRootRenderingInsideTooltipProvider(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows relationships and persists an answer as read when selected", async () => {
		const mainSessionSummary = createSessionSummary("task-1", {
			latestTurnCheckpoint: { commit: "abc", ref: "HEAD", turn: 5, createdAt: 5 },
		});
		const sideSessionSummary = createSessionSummary("side-1", {
			updatedAt: 20,
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: 20,
				signalConfidence: "harness_turn_complete",
				turnSequence: 1,
			},
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 3,
				mainSessionOriginUserMessagePreview: "Build sessions",
				latestUserMessagePreview: "Why is this read-only?",
			},
		});
		const onSelectTaskConversationSession = vi.fn();

		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary, "side-1": sideSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={onSelectTaskConversationSession}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});

		expect(document.body.textContent).toContain("Why is this read-only?");
		expect(document.body.textContent).toContain("Forked from main · 2 turns ago");
		expect(document.body.querySelector('[aria-label="Unread answer"]')).not.toBeNull();

		const sideSessionButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Why is this read-only?"),
		);
		await act(async () => sideSessionButton?.click());

		expect(onSelectTaskConversationSession).toHaveBeenCalledWith("side-1");
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toMatchObject({ "side-1": 20 });
	});

	function createSideSessionWithCompletedAnswer(
		overrides: Partial<RuntimeTaskSessionSummary> = {},
	): RuntimeTaskSessionSummary {
		return createSessionSummary("side-1", {
			updatedAt: 30,
			turnOwner: "user",
			userTurnKind: "review",
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: 20,
				signalConfidence: "harness_turn_complete",
				turnSequence: 1,
			},
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "task_collaborator",
				taskConversationSessionContextSource: "started_from_scratch",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: "主任务",
				latestUserMessagePreview: "侧会话问题",
			},
			...overrides,
		});
	}

	async function renderSessionsPanelForUnreadAnswerAssertion(
		sideSessionSummary: RuntimeTaskSessionSummary,
		selectedTaskConversationSessionId = "task-1",
		mainTaskConversationSessionId = "task-1",
	): Promise<void> {
		const mainSessionSummary = createSessionSummary(mainTaskConversationSessionId);
		await renderSessionsPanelWithSessionSummaries(
			mainSessionSummary,
			{
				[mainSessionSummary.taskId]: mainSessionSummary,
				[sideSessionSummary.taskId]: sideSessionSummary,
			},
			selectedTaskConversationSessionId,
		);
	}

	async function renderSessionsPanelWithSessionSummaries(
		mainSessionSummary: RuntimeTaskSessionSummary,
		taskSessions: Record<string, RuntimeTaskSessionSummary>,
		selectedTaskConversationSessionId = mainSessionSummary.taskId,
	): Promise<void> {
		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="主任务"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={taskSessions}
					selectedTaskConversationSessionId={selectedTaskConversationSessionId}
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});
	}

	it.each([
		[false, 0, "尚未发送消息"],
		[true, 0, "已发送消息"],
		[false, 1, "已发送消息"],
	] as const)(
		"无预览时根据真实接受或回答回合显示状态：accepted=%s，turn=%s",
		async (accepted, turnSequence, expectedText) => {
			const side = createSideSessionWithCompletedAnswer();
			if (side.taskConversationSessionMetadata) side.taskConversationSessionMetadata.latestUserMessagePreview = null;
			side.lastAgentConversationUserHandoffObservation = null;
			side.agentResponseGenerationTurnSequence = turnSequence;
			side.agentConversationPromptSubmissionAcceptance = accepted
				? {
						status: "accepted",
						attemptedAtMs: 1,
						confirmedAtMs: 2,
						eventId: "accepted-message",
						nativeSessionId: "side-native-id",
						runtimeSessionIncarnationId: "side-incarnation",
					}
				: null;
			await renderSessionsPanelForUnreadAnswerAssertion(side);
			expect(container.textContent).toContain(expectedText);
			if (expectedText === "已发送消息") expect(container.textContent).not.toContain("尚未发送消息");
		},
	);

	it.each([
		["协作会话", "task_collaborator", false],
		["By the way", "by_the_way", false],
		["前主会话", "task_collaborator", true],
	] as const)(
		"%s：已读后摘要更新、重新聚焦和重挂载均不重复显示白点",
		async (_, sessionRole, hasHeldMainResponsibility) => {
			const sideSessionSummary = createSideSessionWithCompletedAnswer();
			if (sideSessionSummary.taskConversationSessionMetadata) {
				sideSessionSummary.taskConversationSessionMetadata.taskConversationSessionRole = sessionRole;
				sideSessionSummary.taskConversationSessionMetadata.taskConversationSessionHasHeldMainResponsibility =
					hasHeldMainResponsibility;
			}
			await renderSessionsPanelForUnreadAnswerAssertion(sideSessionSummary);
			expect(container.querySelector('[aria-label="Unread answer"]')).not.toBeNull();
			const sideSessionButton = Array.from(container.querySelectorAll("button")).find((button) =>
				button.textContent?.includes("侧会话问题"),
			);
			expect(sideSessionButton).toBeInstanceOf(HTMLButtonElement);
			await act(async () => sideSessionButton?.click());
			expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();

			const redrawnSideSessionSummary = { ...sideSessionSummary, updatedAt: 40, lastOutputAt: 40 };
			await renderSessionsPanelForUnreadAnswerAssertion(redrawnSideSessionSummary);
			expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
			await act(async () => root.unmount());
			root = createRootRenderingInsideTooltipProvider(container);
			await renderSessionsPanelForUnreadAnswerAssertion(redrawnSideSessionSummary);
			expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
			expect(
				JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
			).toEqual({
				"side-1": 20,
			});
		},
	);

	it("已读后真正的新交棒会再次提示，即使摘要更新时间保持不变", async () => {
		const sideSessionSummary = createSideSessionWithCompletedAnswer({ updatedAt: 100 });
		await renderSessionsPanelForUnreadAnswerAssertion(sideSessionSummary, "side-1");
		const nextAnswerSummary = createSideSessionWithCompletedAnswer({
			updatedAt: 100,
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: 50,
				signalConfidence: "structured_user_turn",
				turnSequence: 2,
			},
		});
		await renderSessionsPanelForUnreadAnswerAssertion(nextAnswerSummary);
		expect(container.querySelector('[aria-label="Unread answer"]')).not.toBeNull();
		await renderSessionsPanelForUnreadAnswerAssertion(nextAnswerSummary, "side-1");
		await renderSessionsPanelForUnreadAnswerAssertion(nextAnswerSummary);
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
	});

	it("当前选中会话完成新回答时自动记为已读，后续重绘不更新已读时间", async () => {
		await renderSessionsPanelForUnreadAnswerAssertion(
			createSideSessionWithCompletedAnswer({ turnOwner: "agent", userTurnKind: null }),
			"side-1",
		);
		const completedSideSessionSummary = createSideSessionWithCompletedAnswer({
			updatedAt: 100,
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: 50,
				signalConfidence: "harness_turn_complete",
				turnSequence: 2,
			},
		});
		await renderSessionsPanelForUnreadAnswerAssertion(completedSideSessionSummary, "side-1");
		await renderSessionsPanelForUnreadAnswerAssertion({ ...completedSideSessionSummary, updatedAt: 150 }, "side-1");
		await renderSessionsPanelForUnreadAnswerAssertion({ ...completedSideSessionSummary, updatedAt: 200 });
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toEqual({
			"side-1": 50,
		});
	});

	it("主会话交接后，选中仍使用宿主任务 ID 的前主会话也会自动记为已读", async () => {
		const formerMainSessionSummary = createSideSessionWithCompletedAnswer({ taskId: "task-1" });
		if (formerMainSessionSummary.taskConversationSessionMetadata)
			formerMainSessionSummary.taskConversationSessionMetadata.taskConversationSessionHasHeldMainResponsibility = true;
		await renderSessionsPanelForUnreadAnswerAssertion(formerMainSessionSummary, "task-1", "promoted-main-session");
		const completedFormerMainSessionSummary: RuntimeTaskSessionSummary = {
			...formerMainSessionSummary,
			updatedAt: 100,
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: 50,
				signalConfidence: "harness_turn_complete",
				turnSequence: 2,
			},
		};
		await renderSessionsPanelForUnreadAnswerAssertion(
			completedFormerMainSessionSummary,
			"task-1",
			"promoted-main-session",
		);
		await renderSessionsPanelForUnreadAnswerAssertion(
			{ ...completedFormerMainSessionSummary, updatedAt: 150 },
			"promoted-main-session",
			"promoted-main-session",
		);
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toEqual({
			"task-1": 50,
		});
	});

	it("A→B→C：B 选中期间完成的主会话回答在再次交接后保持已读，后续新回答仍提示", async () => {
		const originalMainSessionSummary = createSessionSummary("task-1");
		const collaborationSessionSummary = createSideSessionWithCompletedAnswer({ taskId: "session-B" });
		const collaborationSessionMetadata = collaborationSessionSummary.taskConversationSessionMetadata;
		if (!collaborationSessionMetadata) throw new Error("回归场景缺少协作会话元数据");
		const nextMainSessionSummary = createSessionSummary("session-C");
		await renderSessionsPanelWithSessionSummaries(
			originalMainSessionSummary,
			{
				"task-1": originalMainSessionSummary,
				"session-B": collaborationSessionSummary,
				"session-C": nextMainSessionSummary,
			},
			"session-B",
		);
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toEqual({ "session-B": 20 });

		const promotedMainSessionSummary: RuntimeTaskSessionSummary = {
			...collaborationSessionSummary,
			turnOwner: "agent",
			userTurnKind: null,
			taskConversationSessionMetadata: {
				...collaborationSessionMetadata,
				taskConversationSessionRole: "main",
				taskConversationSessionHasHeldMainResponsibility: true,
			},
		};
		await renderSessionsPanelWithSessionSummaries(promotedMainSessionSummary, {
			"task-1": originalMainSessionSummary,
			"session-B": promotedMainSessionSummary,
			"session-C": nextMainSessionSummary,
		});
		const completedMainSessionSummary: RuntimeTaskSessionSummary = {
			...promotedMainSessionSummary,
			turnOwner: "user",
			userTurnKind: "review",
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: 50,
				signalConfidence: "harness_turn_complete",
				turnSequence: 2,
			},
		};
		await renderSessionsPanelWithSessionSummaries(completedMainSessionSummary, {
			"task-1": originalMainSessionSummary,
			"session-B": completedMainSessionSummary,
			"session-C": nextMainSessionSummary,
		});

		const formerMainSessionSummary: RuntimeTaskSessionSummary = {
			...completedMainSessionSummary,
			updatedAt: 100,
			taskConversationSessionMetadata: {
				...collaborationSessionMetadata,
				taskConversationSessionHasHeldMainResponsibility: true,
			},
		};
		await renderSessionsPanelWithSessionSummaries(nextMainSessionSummary, {
			"task-1": originalMainSessionSummary,
			"session-B": formerMainSessionSummary,
			"session-C": nextMainSessionSummary,
		});
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toEqual({ "session-B": 50 });

		await renderSessionsPanelWithSessionSummaries(nextMainSessionSummary, {
			"task-1": originalMainSessionSummary,
			"session-B": {
				...formerMainSessionSummary,
				lastAgentConversationUserHandoffObservation: {
					observedAtMs: 80,
					signalConfidence: "harness_turn_complete",
					turnSequence: 3,
				},
			},
			"session-C": nextMainSessionSummary,
		});
		expect(container.querySelector('[aria-label="Unread answer"]')).not.toBeNull();
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toEqual({ "session-B": 50 });
	});

	it("原始主会话在选中期间完成回答后，首次交接不会把已读回答重新标为未读", async () => {
		const originalMainSessionSummary = createSessionSummary("task-1");
		await renderSessionsPanelWithSessionSummaries(originalMainSessionSummary, {
			"task-1": originalMainSessionSummary,
		});
		const completedOriginalMainSessionSummary = createSideSessionWithCompletedAnswer({ taskId: "task-1" });
		const originalMainSessionMetadata = completedOriginalMainSessionSummary.taskConversationSessionMetadata;
		if (!originalMainSessionMetadata) throw new Error("回归场景缺少原始主会话元数据");
		const completedCurrentMainSessionSummary: RuntimeTaskSessionSummary = {
			...completedOriginalMainSessionSummary,
			taskConversationSessionMetadata: {
				...originalMainSessionMetadata,
				taskConversationSessionRole: "main",
			},
		};
		await renderSessionsPanelWithSessionSummaries(completedCurrentMainSessionSummary, {
			"task-1": completedCurrentMainSessionSummary,
		});

		const promotedMainSessionSummary = createSessionSummary("promoted-main-session");
		await renderSessionsPanelWithSessionSummaries(promotedMainSessionSummary, {
			"task-1": {
				...completedOriginalMainSessionSummary,
				taskConversationSessionMetadata: {
					...originalMainSessionMetadata,
					taskConversationSessionHasHeldMainResponsibility: true,
				},
			},
			"promoted-main-session": promotedMainSessionSummary,
		});
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toEqual({ "task-1": 20 });
	});

	it("兼容旧版摘要时间已读记录且不会在阅读较早交棒时回退", async () => {
		window.localStorage.setItem(
			LocalStorageKey.TaskConversationSessionReadReceipts,
			JSON.stringify({ "side-1": 100 }),
		);
		const sideSessionSummary = createSideSessionWithCompletedAnswer({ updatedAt: 200 });
		await renderSessionsPanelForUnreadAnswerAssertion(sideSessionSummary);
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
		await renderSessionsPanelForUnreadAnswerAssertion(sideSessionSummary, "side-1");
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts) ?? "{}"),
		).toEqual({
			"side-1": 100,
		});
		await renderSessionsPanelForUnreadAnswerAssertion(
			createSideSessionWithCompletedAnswer({
				updatedAt: 300,
				lastAgentConversationUserHandoffObservation: {
					observedAtMs: 250,
					signalConfidence: "harness_turn_complete",
					turnSequence: 2,
				},
			}),
		);
		expect(container.querySelector('[aria-label="Unread answer"]')).not.toBeNull();
	});

	it.each([undefined, null])("缺少真实交棒记录时不以摘要或进程待命时间制造未读（%s）", async (handoffObservation) => {
		const sideSessionSummary = createSideSessionWithCompletedAnswer({
			lastAgentConversationUserHandoffObservation: handoffObservation,
			agentResponseGenerationStopped: { stoppedAt: 25, signalConfidence: "prompt_ready_fallback", turnSequence: 1 },
			currentAgentProcessUserTurnIdleRetentionStarted: {
				stoppedAt: 25,
				signalConfidence: "prompt_ready_fallback",
				turnSequence: 1,
			},
		});
		await renderSessionsPanelForUnreadAnswerAssertion(sideSessionSummary);
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
		await renderSessionsPanelForUnreadAnswerAssertion(sideSessionSummary, "side-1");
		expect(window.localStorage.getItem(LocalStorageKey.TaskConversationSessionReadReceipts)).toBeNull();
	});

	it("其他标签页读过回答后同步清除白点，后续摘要更新不重新点亮", async () => {
		const sideSessionSummary = createSideSessionWithCompletedAnswer();
		await renderSessionsPanelForUnreadAnswerAssertion(sideSessionSummary);
		expect(container.querySelector('[aria-label="Unread answer"]')).not.toBeNull();
		const storedReadReceipts = JSON.stringify({ "side-1": 20 });
		window.localStorage.setItem(LocalStorageKey.TaskConversationSessionReadReceipts, storedReadReceipts);
		await act(async () => {
			window.dispatchEvent(
				new StorageEvent("storage", {
					key: LocalStorageKey.TaskConversationSessionReadReceipts,
					newValue: storedReadReceipts,
				}),
			);
		});
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
		await renderSessionsPanelForUnreadAnswerAssertion({ ...sideSessionSummary, updatedAt: 60 });
		expect(container.querySelector('[aria-label="Unread answer"]')).toBeNull();
	});

	it("创建入口固定完整宿主身份，并打开全局共享工作台", async () => {
		const main = createSessionSummary("task-1");
		const task = { ...ORIGINAL_PROMPT_CARD, id: "task-1", startInPlanMode: true, baseRef: "main", updatedAt: 1 };
		const onSelect = vi.fn();
		const renderPanel = (workspaceId: string) => (
			<TaskConversationSessionsPanel
				workspaceId={workspaceId}
				taskCard={task}
				workspaceTaskId="task-1"
				mainSessionSummary={main}
				mainSessionUserMessagePreview="原正文"
				mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
				effectiveAgentId="claude"
				taskSessions={{ "task-1": main }}
				selectedTaskConversationSessionId="task-1"
				onSelectTaskConversationSession={onSelect}
				onCreateTaskConversationSession={async () => ({ ok: true })}
			/>
		);
		await act(async () => root.render(renderPanel("project-a")));
		await act(async () =>
			Array.from(document.body.querySelectorAll("button"))
				.find((button) => button.textContent?.includes("新建会话"))
				?.click(),
		);
		expect(openSideSessionCreationWorkbenchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "project-a",
				task: expect.objectContaining({ id: "task-1", createdAt: ORIGINAL_PROMPT_CARD.createdAt }),
			}),
		);
		const openingTarget = openSideSessionCreationWorkbenchMock.mock.calls.at(-1)?.[0] as
			| SideSessionCreationWorkbenchTarget
			| undefined;
		await act(async () => openingTarget?.onCreated?.("created-at-a"));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("created-at-a");
		await act(async () => root.render(renderPanel("project-b")));
		await act(async () => openingTarget?.onCreated?.("late-from-a"));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	// 用户要拿会话 id 去对照日志 / 转录文件名，「看得见」与「拿得走」是两件事。
	it("exposes both identifiers on every row and copies them on click", async () => {
		const mainSessionSummary = createSessionSummary("task-1", {
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "aaaaaaaa-1111-4111-8111-111111111111",
				transcriptPath: "/home/u/.claude/projects/x/aaaaaaaa-1111-4111-8111-111111111111.jsonl",
				observedAt: 5,
			},
		});
		const sideSessionSummary = createSessionSummary("task-conversation-session-9", {
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "started_from_scratch",
				parentTaskConversationSessionId: null,
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: "Why read-only?",
			},
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude",
				nativeSessionId: "bbbbbbbb-2222-4222-8222-222222222222",
				transcriptPath: null,
				observedAt: 6,
			},
		});
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="claude"
					taskSessions={{ "task-1": mainSessionSummary, "task-conversation-session-9": sideSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});

		const copyButtons = Array.from(document.body.querySelectorAll("button")).filter((button) =>
			button.getAttribute("aria-label")?.startsWith("Copy the "),
		);
		const copiedIdentifiers = copyButtons.map((button) => button.getAttribute("aria-label"));
		// 两行 × 两个 id：会话 id 与 agent 原生会话 id。
		expect(copiedIdentifiers).toEqual([
			"Copy the Session id task-1",
			"Copy the claude id aaaaaaaa-1111-4111-8111-111111111111",
			"Copy the Session id task-conversation-session-9",
			"Copy the claude id bbbbbbbb-2222-4222-8222-222222222222",
		]);

		await act(async () => copyButtons[3]?.click());
		expect(writeText).toHaveBeenCalledWith("bbbbbbbb-2222-4222-8222-222222222222");
	});

	// sidecar 缺席（Cline / ACP 会话、还没触发过 hook 的老数据）时不摆占位符：
	// 一个空壳只会让人以为「这条会话的 id 是空的」。
	it("omits the agent native session chip when no identity has been observed", async () => {
		const mainSessionSummary = createSessionSummary("task-1");

		await act(async () => {
			root.render(
				<TaskConversationSessionsPanel
					workspaceTaskId="task-1"
					mainSessionSummary={mainSessionSummary}
					mainSessionUserMessagePreview="Build sessions"
					mainSessionOriginalPromptCard={ORIGINAL_PROMPT_CARD}
					effectiveAgentId="codex"
					taskSessions={{ "task-1": mainSessionSummary }}
					selectedTaskConversationSessionId="task-1"
					onSelectTaskConversationSession={() => {}}
					onCreateTaskConversationSession={async () => ({ ok: true })}
				/>,
			);
		});

		const copiedIdentifiers = Array.from(document.body.querySelectorAll("button"))
			.map((button) => button.getAttribute("aria-label"))
			.filter((label) => label?.startsWith("Copy the "));
		expect(copiedIdentifiers).toEqual(["Copy the Session id task-1"]);
	});
});
