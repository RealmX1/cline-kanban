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
		});
	}, [onSnapshot, sessions.startTaskSession]);

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
