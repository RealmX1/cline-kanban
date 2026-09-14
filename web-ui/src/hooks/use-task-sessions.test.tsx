import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { MIN_DETAIL_DIFF_PANEL_WIDTH_PX } from "@/resize/use-card-detail-layout";
import {
	clampPanelWidthToWindow,
	estimateColsForPanelWidth,
	estimateTaskAgentTerminalGeometry,
} from "@/runtime/task-session-geometry";
import type { BoardCard } from "@/types";

// Persisted detail terminal panel width the (unmounted) task start path reads.
// Chosen non-default so the derived PTY column count differs from the legacy
// fixed 60-column estimate — that difference is exactly the bug this guards.
const PERSISTED_PANEL_WIDTH_PX = 720;

// The start path clamps the persisted width by what the current window can
// display before deriving columns. Compute the expected post-clamp width the
// same way the hook does, so these assertions stay correct regardless of the
// jsdom default window.innerWidth.
function expectedStartPanelWidth(persistedWidthPx: number): number {
	return clampPanelWidthToWindow(persistedWidthPx, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, window.innerWidth);
}

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const trackTaskResumedFromTrashMock = vi.hoisted(() => vi.fn());
const loadDetailTerminalPanelWidthMock = vi.hoisted(() => vi.fn(() => 0));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			startTaskSession: {
				mutate: startTaskSessionMutateMock,
			},
		},
	}),
}));

// Real task-session-geometry is exercised; only the persisted panel-width read
// is mocked so the test controls the input and asserts the real derivation.
vi.mock("@/resize/detail-terminal-panel-width", () => ({
	loadDetailTerminalPanelWidth: loadDetailTerminalPanelWidthMock,
}));

vi.mock("@/telemetry/events", () => ({
	trackTaskResumedFromTrash: trackTaskResumedFromTrashMock,
}));

interface HookSnapshot {
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
	createByTheWayTaskConversationSession: ReturnType<typeof useTaskSessions>["createByTheWayTaskConversationSession"];
}

function createTask(): BoardCard {
	return {
		id: "task-1",
		title: "Resume me",
		prompt: "Resume me",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function HookHarness({ onSnapshot }: { onSnapshot: (snapshot: HookSnapshot) => void }): null {
	const sessions = useTaskSessions({
		currentProjectId: "project-1",
		setSessions: () => {},
	});

	useEffect(() => {
		onSnapshot({
			startTaskSession: sessions.startTaskSession,
			createByTheWayTaskConversationSession: sessions.createByTheWayTaskConversationSession,
		});
	}, [onSnapshot, sessions.createByTheWayTaskConversationSession, sessions.startTaskSession]);

	return null;
}

describe("useTaskSessions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		startTaskSessionMutateMock.mockReset();
		trackTaskResumedFromTrashMock.mockReset();
		loadDetailTerminalPanelWidthMock.mockReset();
		loadDetailTerminalPanelWidthMock.mockReturnValue(PERSISTED_PANEL_WIDTH_PX);
		startTaskSessionMutateMock.mockResolvedValue({
			ok: true,
			summary: {
				taskId: "task-1",
				state: "running",
				agentId: "codex",
				workspacePath: "/tmp/task-1",
				pid: 123,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			},
		});
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("tracks successful resume-from-trash starts", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask(), { resumeFromTrash: true });
		});

		expect(trackTaskResumedFromTrashMock).toHaveBeenCalledTimes(1);
	});

	it("does not track regular task starts", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask());
		});

		expect(trackTaskResumedFromTrashMock).not.toHaveBeenCalled();
	});

	it("logs the original client-side task start failure with task identity and elapsed time", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		startTaskSessionMutateMock.mockRejectedValue(new Error("response transport closed"));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const hookSnapshot = latestSnapshot as HookSnapshot | null;
		if (hookSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		const result = await hookSnapshot.startTaskSession(createTask());

		expect(result).toEqual({ ok: false, message: "response transport closed" });
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[task-session-start-client]"));
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("workspaceId=project-1"));
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("taskId=task-1"));
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('error="response transport closed"'));
	});

	it("creates a read-only By the way session related to the current main turn", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		let result: Awaited<ReturnType<HookSnapshot["createByTheWayTaskConversationSession"]>> | null = null;
		await act(async () => {
			result =
				(await latestSnapshot?.createByTheWayTaskConversationSession({
					task: createTask(),
					agentId: "codex",
					initialUserQuestion: "  Why does this type exist?  ",
					contextSource: "forked_from_main_current_turn",
					mainSessionOriginTurnNumber: 4,
					mainSessionOriginUserMessagePreview: "Implement the feature",
				})) ?? null;
		});

		const taskConversationSessionId = "task-conversation-session-11111111-1111-4111-8111-111111111111";
		expect(result).toEqual({ ok: true, taskConversationSessionId });
		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: taskConversationSessionId,
				workspaceTaskId: "task-1",
				prompt: "Why does this type exist?",
				agentId: "codex",
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "by_the_way",
					taskConversationSessionContextSource: "forked_from_main_current_turn",
					parentTaskConversationSessionId: "task-1",
					mainSessionOriginTurnNumber: 4,
					mainSessionOriginUserMessagePreview: "Implement the feature",
					latestUserMessagePreview: "Why does this type exist?",
				},
			}),
		);
	});

	it("forwards the card's conversation mode declaration when starting a task（蓝图 §A.1：漏传 = 静默掉回 operational）", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				taskConversationMode: "exploratory",
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				taskConversationMode: "exploratory",
			}),
		);
	});

	it("forwards the card's conversation mode on resume-from-trash starts too", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(
				{
					...createTask(),
					taskConversationMode: "exploratory",
				},
				{ resumeFromTrash: true },
			);
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				resumeFromTrash: true,
				taskConversationMode: "exploratory",
			}),
		);
	});

	it("by-the-way 侧会话不带卡片的会话模式声明（侧会话只读，恒按 operational 语义启动）", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.createByTheWayTaskConversationSession({
				task: { ...createTask(), taskConversationMode: "exploratory" },
				agentId: "codex",
				initialUserQuestion: "Why does this type exist?",
				contextSource: "started_from_scratch",
				mainSessionOriginTurnNumber: 4,
				mainSessionOriginUserMessagePreview: "Implement the feature",
			});
		});

		const payload = startTaskSessionMutateMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		// 侧会话被强制只读（无命令执行），带上 exploratory 会让服务端注入它永远履行不了的
		// 「kanban exploratory CLI 写回 map」维护协议；省略该字段 = 服务端缺省 operational。
		expect("taskConversationMode" in payload).toBe(false);
		// 其余载荷保持原样（防过度删除回归）：role 元数据与问题文本仍照常转发。
		expect(payload).toEqual(
			expect.objectContaining({
				taskId: "task-conversation-session-11111111-1111-4111-8111-111111111111",
				workspaceTaskId: "task-1",
				prompt: "Why does this type exist?",
				taskConversationSessionMetadata: expect.objectContaining({
					taskConversationSessionRole: "by_the_way",
				}),
			}),
		);
	});

	it("forwards start-in-plan-mode from the task card when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				startInPlanMode: true,
			});
		});

		const expectedGeometry = estimateTaskAgentTerminalGeometry(
			expectedStartPanelWidth(PERSISTED_PANEL_WIDTH_PX),
			window.innerHeight,
		);
		expect(startTaskSessionMutateMock).toHaveBeenCalledWith({
			taskId: "task-1",
			prompt: "Resume me",
			taskTitle: "Resume me",
			images: undefined,
			startInPlanMode: true,
			resumeFromTrash: undefined,
			baseRef: "main",
			cols: expectedGeometry.cols,
			rows: expectedGeometry.rows,
			agentId: undefined,
			clineSettings: undefined,
		});
	});

	it("derives PTY columns from the persisted detail terminal panel width when no terminal is mounted", async () => {
		loadDetailTerminalPanelWidthMock.mockReturnValue(900);

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession(createTask());
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cols: estimateColsForPanelWidth(expectedStartPanelWidth(900)),
			}),
		);
	});

	it("clamps the spawn columns to the current window when the persisted width exceeds it", async () => {
		// Persist the maximum width (1400px → 170 cols). In a narrow window that
		// can only show window.innerWidth − MIN_DETAIL_DIFF_PANEL_WIDTH_PX, the PTY
		// must not spawn at the full 170 cols — that is the residual the fix kills.
		const NARROW_WINDOW_INNER_WIDTH = 1100;
		const originalInnerWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: NARROW_WINDOW_INNER_WIDTH,
		});
		loadDetailTerminalPanelWidthMock.mockReturnValue(1400);

		try {
			let latestSnapshot: HookSnapshot | null = null;

			await act(async () => {
				root.render(
					<HookHarness
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			if (latestSnapshot === null) {
				throw new Error("Expected a hook snapshot.");
			}

			await act(async () => {
				await latestSnapshot?.startTaskSession(createTask());
			});

			const windowDisplayableWidth = clampPanelWidthToWindow(
				1400,
				MIN_DETAIL_DIFF_PANEL_WIDTH_PX,
				NARROW_WINDOW_INNER_WIDTH,
			);
			const clampedCols = estimateColsForPanelWidth(windowDisplayableWidth);
			expect(clampedCols).toBeLessThan(estimateColsForPanelWidth(1400));
			expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					cols: clampedCols,
				}),
			);
		} finally {
			Object.defineProperty(window, "innerWidth", {
				configurable: true,
				value: originalInnerWidth,
			});
		}
	});

	it("forwards task images when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			}),
		);
	});

	it("forwards task-level Cline reasoning effort overrides when starting a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				agentId: "cline",
				clineSettings: {
					providerId: "openrouter",
					modelId: "anthropic/claude-opus-4.6",
					reasoningEffort: "low",
				},
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				clineSettings: {
					providerId: "openrouter",
					modelId: "anthropic/claude-opus-4.6",
					reasoningEffort: "low",
				},
			}),
		);
	});

	it("forwards reasoning-only overrides even when provider/model remain inherited", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await latestSnapshot?.startTaskSession({
				...createTask(),
				clineSettings: {
					reasoningEffort: "high",
				},
			});
		});

		expect(startTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				clineSettings: {
					reasoningEffort: "high",
				},
			}),
		);
	});
});
