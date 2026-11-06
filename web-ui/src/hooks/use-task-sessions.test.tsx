import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import {
	loadDetailTaskCardsPanelRatioPreference,
	MIN_DETAIL_DIFF_PANEL_WIDTH_PX,
} from "@/resize/use-card-detail-layout";
import {
	clampPanelWidthToWindow,
	estimateColsForPanelWidth,
	estimateTaskAgentTerminalGeometry,
} from "@/runtime/task-session-geometry";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";
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
	const detailContentWidth = window.innerWidth * (1 - loadDetailTaskCardsPanelRatioPreference()) - 1;
	return clampPanelWidthToWindow(persistedWidthPx, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, detailContentWidth);
}

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const createTaskConversationSessionMutateMock = vi.hoisted(() => vi.fn());
const sendTaskSessionInputMutateMock = vi.hoisted(() => vi.fn());
const trackTaskResumedFromTrashMock = vi.hoisted(() => vi.fn());
const loadDetailTerminalPanelWidthMock = vi.hoisted(() => vi.fn(() => 0));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			sendTaskSessionInput: { mutate: sendTaskSessionInputMutateMock },
			createTaskConversationSession: { mutate: createTaskConversationSessionMutateMock },
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
	sendTaskSessionInput: ReturnType<typeof useTaskSessions>["sendTaskSessionInput"];
	startTaskSession: ReturnType<typeof useTaskSessions>["startTaskSession"];
	createTaskConversationSession: ReturnType<typeof useTaskSessions>["createTaskConversationSession"];
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
			sendTaskSessionInput: sessions.sendTaskSessionInput,
			startTaskSession: sessions.startTaskSession,
			createTaskConversationSession: sessions.createTaskConversationSession,
		});
	}, [onSnapshot, sessions.createTaskConversationSession, sessions.startTaskSession, sessions.sendTaskSessionInput]);

	return null;
}

describe("useTaskSessions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		sendTaskSessionInputMutateMock.mockReset();
		startTaskSessionMutateMock.mockReset();
		createTaskConversationSessionMutateMock.mockReset();
		createTaskConversationSessionMutateMock.mockImplementation(async (input: { idempotencyKey: string }) => {
			const taskId = `task-conversation-session-${input.idempotencyKey}`;
			return {
				ok: true,
				creation: { taskConversationSessionId: taskId },
				summary: {
					taskId,
					state: "running",
					agentId: "codex",
					pid: 124,
					startedAt: 1,
					updatedAt: 1,
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
				},
			};
		});
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

	it.each(["成功粘贴", "粘贴失败", "无终端", "禁用终端", "请求提交"])(
		"严格填入只走终端粘贴通道，不回落为原始写入：%s",
		async (scenario) => {
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
			const paste = vi.fn(() => scenario === "成功粘贴");
			const input = vi.fn(() => true);
			const unregister = scenario === "无终端" ? () => {} : registerTerminalController("task-1", { paste, input });
			try {
				await act(async () => {
					const result = await latestSnapshot?.sendTaskSessionInput("task-1", "\n提示词\n", {
						mode: "paste",
						requireTerminalPasteSuccess: true,
						appendNewline: scenario === "请求提交",
						preferTerminal: scenario !== "禁用终端",
					});
					expect(result?.ok).toBe(scenario === "成功粘贴");
				});
				if (scenario === "成功粘贴" || scenario === "粘贴失败") {
					expect(paste).toHaveBeenCalledExactlyOnceWith("\n提示词\n");
				} else {
					expect(paste).not.toHaveBeenCalled();
				}
				expect(input).not.toHaveBeenCalled();
				expect(sendTaskSessionInputMutateMock).not.toHaveBeenCalled();
			} finally {
				unregister();
			}
		},
	);

	it("后台程序化粘贴在未挂载终端时仍由运行时投递", async () => {
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
		sendTaskSessionInputMutateMock.mockResolvedValue({ ok: true });
		await act(async () => {
			expect(
				(
					await latestSnapshot?.sendTaskSessionInput("task-1", "自动提交指令", {
						appendNewline: false,
						mode: "paste",
					})
				)?.ok,
			).toBe(true);
		});
		expect(sendTaskSessionInputMutateMock).toHaveBeenCalledExactlyOnceWith({
			taskId: "task-1",
			text: "自动提交指令",
			appendNewline: false,
		});
	});

	it.each([true, false])("普通键入仍可使用终端或运行时回退：终端接收=%s", async (terminalAcceptsInput) => {
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
		const input = vi.fn(() => terminalAcceptsInput);
		const paste = vi.fn(() => true);
		const unregister = registerTerminalController("task-1", { input, paste });
		sendTaskSessionInputMutateMock.mockResolvedValue({ ok: true });
		try {
			await act(async () => {
				expect((await latestSnapshot?.sendTaskSessionInput("task-1", "继续"))?.ok).toBe(true);
			});
			expect(input).toHaveBeenCalledExactlyOnceWith("继续\n");
			expect(paste).not.toHaveBeenCalled();
			if (terminalAcceptsInput) {
				expect(sendTaskSessionInputMutateMock).not.toHaveBeenCalled();
			} else {
				expect(sendTaskSessionInputMutateMock).toHaveBeenCalledExactlyOnceWith({
					taskId: "task-1",
					text: "继续",
					appendNewline: true,
				});
			}
		} finally {
			unregister();
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

	it.each(
		(["by_the_way", "task_collaborator"] as const).flatMap((sessionRole) =>
			(["started_from_scratch", "forked_from_main_current_turn"] as const).flatMap((contextSource) =>
				["", " \n\t "].map((initialUserQuestion) => ({ sessionRole, contextSource, initialUserQuestion })),
			),
		),
	)("$sessionRole/$contextSource 允许空首条消息并保存空预览", async (input) => {
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
		await act(async () => {
			const result = await latestSnapshot?.createTaskConversationSession({
				...input,
				task: createTask(),
				agentId: "codex",
				mainSessionOriginTurnNumber: 4,
				mainSessionOriginUserMessagePreview: "主任务",
			});
			expect(result?.ok).toBe(true);
		});
		expect(createTaskConversationSessionMutateMock).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				taskId: "task-1",
				initialMessage: "",
				sessionRole: input.sessionRole,
				contextSource: input.contextSource === "started_from_scratch" ? "fresh" : "current_main",
				creatorTaskConversationSessionId: "task-1",
				idempotencyKey: expect.any(String),
			}),
		);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
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

		let result: Awaited<ReturnType<HookSnapshot["createTaskConversationSession"]>> | null = null;
		await act(async () => {
			result =
				(await latestSnapshot?.createTaskConversationSession({
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
		expect(createTaskConversationSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				sessionRole: "by_the_way",
				creatorTaskConversationSessionId: "task-1",
				contextSource: "current_main",
				initialMessage: "Why does this type exist?",
				agentId: "codex",
				idempotencyKey: "11111111-1111-4111-8111-111111111111",
			}),
		);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("协作 fork 透传父会话和上下文，由服务端按主身份解析模型", async () => {
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

		let result: Awaited<ReturnType<HookSnapshot["createTaskConversationSession"]>> | null = null;
		await act(async () => {
			result =
				(await latestSnapshot?.createTaskConversationSession({
					task: {
						...createTask(),
						startInPlanMode: false,
						taskAgentPermissionMode: "bypass_all_permission_prompts",
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opus" },
					},
					sessionRole: "task_collaborator",
					agentId: "codex",
					initialUserQuestion: "  Why does this type exist?  ",
					contextSource: "forked_from_main_current_turn",
					mainSessionOriginTurnNumber: 4,
					mainSessionOriginUserMessagePreview: "Implement the feature",
				})) ?? null;
		});

		const taskConversationSessionId = "task-conversation-session-11111111-1111-4111-8111-111111111111";
		expect(result).toEqual({ ok: true, taskConversationSessionId });
		expect(createTaskConversationSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				sessionRole: "task_collaborator",
				creatorTaskConversationSessionId: "task-1",
				contextSource: "current_main",
				initialMessage: "Why does this type exist?",
				agentId: "codex",
				idempotencyKey: "11111111-1111-4111-8111-111111111111",
			}),
		);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
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
			await latestSnapshot?.createTaskConversationSession({
				task: { ...createTask(), taskConversationMode: "exploratory" },
				agentId: "codex",
				initialUserQuestion: "Why does this type exist?",
				contextSource: "started_from_scratch",
				mainSessionOriginTurnNumber: 4,
				mainSessionOriginUserMessagePreview: "Implement the feature",
			});
		});

		const payload = createTaskConversationSessionMutateMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect("taskConversationMode" in payload).toBe(false);
		expect(payload).toEqual(
			expect.objectContaining({
				taskId: "task-1",
				initialMessage: "Why does this type exist?",
				sessionRole: "by_the_way",
				contextSource: "fresh",
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
				NARROW_WINDOW_INNER_WIDTH * (1 - loadDetailTaskCardsPanelRatioPreference()) - 1,
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
});
