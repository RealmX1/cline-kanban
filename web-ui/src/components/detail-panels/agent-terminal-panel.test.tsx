import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalPanel, describeState, getStateTagStyle } from "@/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { beginTaskAgentSessionStartRequestInFlight } from "@/stores/task-agent-session-start-request-in-flight-store";
import type { StaleAgentTerminalSessionAutomaticResumePhase } from "@/terminal/stale-agent-terminal-session-automatic-resume-scheduler";
import type { TerminalScrollbackTranscriptLogicalLine } from "@/terminal/terminal-scrollback-transcript-extraction";

// 返回类型直接绑定生产类型（而不是就地写一个窄结构），这样 transcript 逻辑行的形状再变时
// `tsc` 会在这里报错，而不是靠运行期是否恰好走到渲染路径来暴露漂移。
const {
	mockRefreshTerminal,
	mockResyncTerminalView,
	mockUseIsMobile,
	mockTerminalInput,
	mockReadScrollbackTranscript,
	mockHasRenderedAnyTerminalContent,
	mockAutomaticStaleSessionResumePhase,
} = vi.hoisted(() => ({
	mockRefreshTerminal: vi.fn(async () => {}),
	mockResyncTerminalView: vi.fn(async () => {}),
	mockUseIsMobile: vi.fn(() => false),
	mockTerminalInput: vi.fn((_sequence: string) => true),
	mockReadScrollbackTranscript: vi.fn((): TerminalScrollbackTranscriptLogicalLine[] => []),
	mockHasRenderedAnyTerminalContent: vi.fn(() => true),
	mockAutomaticStaleSessionResumePhase: vi.fn((): StaleAgentTerminalSessionAutomaticResumePhase | null => null),
}));

vi.mock("@/terminal/use-persistent-terminal-session", () => ({
	usePersistentTerminalSession: () => ({
		containerRef: { current: null },
		lastError: null,
		hasRenderedAnyTerminalContent: mockHasRenderedAnyTerminalContent(),
		isStopping: false,
		isRefreshing: false,
		isResyncingTerminalView: false,
		automaticStaleSessionResumePhase: mockAutomaticStaleSessionResumePhase(),
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
		resyncTerminalView: mockResyncTerminalView,
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

/** 一条只有单段默认样式的 transcript 逻辑行，形状与提取层产出的生产类型一致。 */
function createTranscriptLogicalLine(
	text: string,
	sourceBufferRowIndex: number,
): TerminalScrollbackTranscriptLogicalLine {
	return {
		text,
		segments: [
			{
				text,
				foregroundColor: null,
				backgroundColor: null,
				isBold: false,
				isDim: false,
				isItalic: false,
				isUnderline: false,
				isStrikethrough: false,
				isInverse: false,
				isInvisible: false,
			},
		],
		sourceBufferRowIndex,
	};
}

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

/**
 * 确认弹窗走 Radix Portal，挂在 document.body 上而不是测试容器里 —— 只查 container 会永远查不到它。
 */
function findPortalButtonByLabel(label: string): HTMLButtonElement | null {
	return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) ?? null;
}

describe("AgentTerminalPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockRefreshTerminal.mockClear();
		mockResyncTerminalView.mockClear();
		mockTerminalInput.mockClear();
		mockReadScrollbackTranscript.mockClear();
		mockUseIsMobile.mockReturnValue(false);
		mockHasRenderedAnyTerminalContent.mockReturnValue(true);
		mockAutomaticStaleSessionResumePhase.mockReturnValue(null);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("shows restart in the compact terminal header without requiring a close button", () => {
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

		const refreshButton = container.querySelector<HTMLButtonElement>('[aria-label="Restart agent session"]');
		expect(refreshButton).not.toBeNull();
		expect(refreshButton?.disabled).toBe(false);
		expect(container.querySelector('[aria-label="Close terminal"]')).toBeNull();

		// createSummary 是 running = 活跃回合，所以这一下点出来的是确认弹窗，不是直接重启。
		act(() => {
			refreshButton?.click();
		});
		expect(mockRefreshTerminal).not.toHaveBeenCalled();

		act(() => {
			findPortalButtonByLabel("Restart session")?.click();
		});
		expect(mockRefreshTerminal).toHaveBeenCalledTimes(1);
	});

	it("offers the transcript reader toggle on desktop too, not just on mobile", () => {
		mockUseIsMobile.mockReturnValue(false);
		mockReadScrollbackTranscript.mockReturnValue([createTranscriptLogicalLine("earlier output", 0)]);

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
		// 因而 itemContent 一次都不会被调用、不渲染任何 item。行数标签同样证明 transcript 已从终端读到。
		// 逐行渲染（含配色还原）由组件级测试 `terminal-scrollback-transcript-styled-line.test.tsx` 覆盖，
		// 别在这里补断言 —— 在这一层它只会因为「压根没渲染」而恒真，是假绿灯。
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

		expect(container.querySelector('[aria-label="Restart agent session"]')).toBeNull();
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

	// ── 「重启后 TUI 全白且重启按钮不可用」的前端回归护栏 ──────────────────────────────────
	// 会话在首轮结束前被系统重启 / 本地 redeploy 打断后，新运行时既没有快照可发也不会再有输出，
	// 而 summary.agentId 恰恰是这类中断里最容易丢的字段。以前这两件事叠在一起就是：一块纯白的 div，
	// 外加一个被 `summary.agentId !== null` 判据灰掉的「重启终端会话」按钮 —— 无解释、无出路。

	function createBlankInterruptedSummary(
		overrides: Partial<RuntimeTaskSessionSummary> = {},
	): RuntimeTaskSessionSummary {
		return {
			taskId: "task-1",
			state: "idle",
			agentId: null,
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
		} as RuntimeTaskSessionSummary;
	}

	it("空终端 + agentId 未知 → 给出可解释空态，且重启按钮可点", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary()}
						showSessionToolbar={false}
						minimalHeaderTitle="Terminal"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("This session is no longer running.");
		expect(container.textContent).toContain("machine restart or a local redeploy");
		const refreshButton = container.querySelector<HTMLButtonElement>('[aria-label="Restart agent session"]');
		expect(refreshButton?.disabled).toBe(false);
	});

	it("空态里的重启按钮真的会发起重启", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary()}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		const restartButtons = [...container.querySelectorAll("button")].filter((button) =>
			button.textContent?.includes("Restart terminal session"),
		);
		expect(restartButtons).toHaveLength(1);
		act(() => {
			restartButtons[0]?.click();
		});
		expect(mockRefreshTerminal).toHaveBeenCalledTimes(1);
	});

	it("会话是被回收掉的 → 空态换成回收措辞（契约要求 UI 讲清楚，而不是留个空终端）", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary({
							agentSessionRuntimeReclamationOutcome: {
								runtimeSessionIncarnationId: "incarnation-1",
								sessionTransport: "pty_terminal",
								reclamationTrigger: "response_generation_grace_period_expired",
								attemptedAt: 1,
								completedAt: 2,
								rootProcessExitConfirmed: true,
								descendantProcessesExitConfirmed: true,
								survivingDescendantPids: [],
								usedForcefulEscalation: false,
								releasedResources: ["pty"],
								failureReason: null,
								nextRetryAt: null,
							},
						})}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("reclaimed after sitting idle past its retention window");
		expect(container.textContent).not.toContain("This session is no longer running.");
	});

	// 打开任务时的陈旧会话自动续跑在路上：空态要说明正在续跑，且不给任何会和它抢 per-task 闸门的重启入口——
	// 日志里有过续跑 6 秒后用户点重启、把刚起的进程杀掉重来的实例。
	it.each(["waiting_for_visible_dwell", "resume_request_in_flight"] as const)(
		"自动续跑进行中（%s）→ 空态说明正在续跑，重启按钮禁用、不给续跑按钮",
		(phase) => {
			mockHasRenderedAnyTerminalContent.mockReturnValue(false);
			mockAutomaticStaleSessionResumePhase.mockReturnValue(phase);
			act(() => {
				root.render(
					<TooltipProvider>
						<AgentTerminalPanel
							taskId="task-1"
							workspaceId="workspace-1"
							summary={createBlankInterruptedSummary({ agentId: "claude" })}
							showSessionToolbar={false}
						/>
					</TooltipProvider>,
				);
			});

			expect(container.textContent).toContain("Resuming the previous conversation…");
			expect(container.textContent).not.toContain("This session is no longer running.");
			const restartButton = container.querySelector<HTMLButtonElement>('[aria-label="Restart agent session"]');
			expect(restartButton?.disabled).toBe(true);
			expect(
				[...container.querySelectorAll("button")].some((button) =>
					button.textContent?.includes("Restart terminal session"),
				),
			).toBe(false);
		},
	);

	it("自动续跑进行中、屏幕上还有旧输出 → 顶部横幅显示正在续跑，而不是「输出到此为止」", () => {
		mockAutomaticStaleSessionResumePhase.mockReturnValue("resume_request_in_flight");
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={{ ...createSummary("claude"), state: "awaiting_review", pid: null }}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("Resuming the previous conversation…");
		expect(container.textContent).not.toContain("The output above is final.");
	});

	it("当前活体是被空闲回收结束的 → 横幅说明打开即自动续跑，而不是「输出到此为止」", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={{
							...createSummary("claude"),
							state: "awaiting_review",
							pid: null,
							runtimeSessionIncarnationId: "incarnation-1",
							agentSessionRuntimeReclamationOutcome: {
								runtimeSessionIncarnationId: "incarnation-1",
								sessionTransport: "pty_terminal",
								reclamationTrigger: "response_generation_grace_period_expired",
								attemptedAt: 1,
								completedAt: 2,
								rootProcessExitConfirmed: true,
								descendantProcessesExitConfirmed: true,
								survivingDescendantPids: [],
								usedForcefulEscalation: true,
								releasedResources: ["pty"],
								failureReason: null,
								nextRetryAt: null,
							},
						}}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("reclaimed after sitting idle. It resumes when you open the task");
		expect(container.textContent).not.toContain("The output above is final.");
	});

	// 回收记录写了 failureReason（PTY 根进程已退、但 SIGKILL 后仍有后代存活）：资格判定不自动续跑，
	// 横幅也不能承诺「打开即续跑」，回落为原文案。
	it("当前活体的回收记录带 failureReason → 横幅不承诺自动续跑，回落为「输出到此为止」", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={{
							...createSummary("claude"),
							state: "awaiting_review",
							pid: null,
							runtimeSessionIncarnationId: "incarnation-1",
							agentSessionRuntimeReclamationOutcome: {
								runtimeSessionIncarnationId: "incarnation-1",
								sessionTransport: "pty_terminal",
								reclamationTrigger: "response_generation_grace_period_expired",
								attemptedAt: 1,
								completedAt: 2,
								rootProcessExitConfirmed: true,
								descendantProcessesExitConfirmed: false,
								survivingDescendantPids: [4242],
								usedForcefulEscalation: true,
								releasedResources: ["pty"],
								failureReason: "SIGKILL 后仍有 1 个后代进程存活",
								nextRetryAt: 3,
							},
						}}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain(
			"Terminal stream closed — the agent process has exited. The output above is final.",
		);
		expect(container.textContent).not.toContain("It resumes when you open the task");
	});

	it("对话面板 agent（Cline）仍然禁用重启，且空态不给重启按钮", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary({ agentId: "cline" })}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		const refreshButton = container.querySelector<HTMLButtonElement>('[aria-label="Restart agent session"]');
		expect(refreshButton?.disabled).toBe(true);
		expect(
			[...container.querySelectorAll("button")].filter((button) =>
				button.textContent?.includes("Restart terminal session"),
			),
		).toHaveLength(0);
	});

	it("detail shell 终端既不给重启按钮也不给空态（它不是 agent 会话）", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="__detail_terminal__:task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary({ taskId: "__detail_terminal__:task-1" })}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[aria-label="Restart agent session"]')).toBeNull();
		expect(container.textContent).not.toContain("This session is no longer running.");
	});

	it("终端有内容时不显示空态（哪怕会话已经不跑了）", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(true);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary()}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).not.toContain("This session is no longer running.");
	});

	// ── 「新任务在高负载下起不来」的前端回归护栏 ──────────────────────────────────────────
	// 新卡从进 In Progress 到 summary 变 running 之间，summary 是占位、终端是空的——和「随运行时没了」长得
	// 一模一样。此前一律显示「no longer running」并递出续跑式重启按钮；高负载下这个窗口长达数十秒，
	// 用户点下去就会和真正的启动抢同一把 per-task 闸门，把慢启动变成真失败。

	it.each([
		["preparing_task_worktree", "Preparing the task worktree…"],
		["launching_agent_session", "Launching the agent session…"],
	] as const)("启动请求在路上（%s）→ 显示正在启动，且不给任何重启入口", (phase, expectedHeadline) => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		const startRequestInFlight = beginTaskAgentSessionStartRequestInFlight("workspace-1", "task-1");
		startRequestInFlight.advanceToPhase(phase);
		try {
			act(() => {
				root.render(
					<TooltipProvider>
						<AgentTerminalPanel
							taskId="task-1"
							workspaceId="workspace-1"
							summary={createBlankInterruptedSummary()}
							taskAgentSessionLaunchHistoryEvidence="never_launched"
							onStartTaskAgentSessionWithTaskPrompt={vi.fn()}
							showSessionToolbar={false}
						/>
					</TooltipProvider>,
				);
			});

			expect(container.textContent).toContain(expectedHeadline);
			expect(container.textContent).not.toContain("This session is no longer running.");
			expect(container.textContent).not.toContain("Restart terminal session");
			expect(container.textContent).not.toContain("Start agent session");
			const toolbarRestartButton = container.querySelector<HTMLButtonElement>(
				'[aria-label="Restart agent session"]',
			);
			expect(toolbarRestartButton?.disabled).toBe(true);
		} finally {
			act(() => {
				startRequestInFlight.finish();
			});
		}
	});

	it("启动请求结束后，空态与重启入口恢复（标记不会粘住）", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		const startRequestInFlight = beginTaskAgentSessionStartRequestInFlight("workspace-1", "task-1");
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary()}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});
		expect(container.textContent).toContain("Preparing the task worktree…");

		act(() => {
			startRequestInFlight.finish();
		});

		expect(container.textContent).toContain("This session is no longer running.");
		const toolbarRestartButton = container.querySelector<HTMLButtonElement>('[aria-label="Restart agent session"]');
		expect(toolbarRestartButton?.disabled).toBe(false);
	});

	it("另一个 workspace 的同号任务在启动，不影响本面板", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		const startRequestInFlight = beginTaskAgentSessionStartRequestInFlight("workspace-other", "task-1");
		try {
			act(() => {
				root.render(
					<TooltipProvider>
						<AgentTerminalPanel
							taskId="task-1"
							workspaceId="workspace-1"
							summary={createBlankInterruptedSummary()}
							showSessionToolbar={false}
						/>
					</TooltipProvider>,
				);
			});

			expect(container.textContent).not.toContain("Preparing the task worktree…");
			expect(container.textContent).toContain("This session is no longer running.");
		} finally {
			startRequestInFlight.finish();
		}
	});

	it("有正面证据从没启动过（worktree 不存在）→ 说「还没启动」，动作只有启动（带原 prompt）", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		const onStartTaskAgentSessionWithTaskPrompt = vi.fn();
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary()}
						taskAgentSessionLaunchHistoryEvidence="never_launched"
						onStartTaskAgentSessionWithTaskPrompt={onStartTaskAgentSessionWithTaskPrompt}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("This task's agent session hasn't started.");
		expect(container.textContent).not.toContain("This session is no longer running.");
		expect(container.textContent).not.toContain("Restart terminal session");
		const startButtons = [...container.querySelectorAll("button")].filter((button) =>
			button.textContent?.includes("Start agent session"),
		);
		expect(startButtons).toHaveLength(1);
		act(() => {
			startButtons[0]?.click();
		});
		expect(onStartTaskAgentSessionWithTaskPrompt).toHaveBeenCalledTimes(1);
		expect(mockRefreshTerminal).not.toHaveBeenCalled();
	});

	it("说不清有没有启动过（卡片缺启动记录但 worktree 在）→ 如实说不知道，启动与续跑都给", () => {
		// 2026-08-13 前启动的存量卡、或写卡失败的卡：字段缺失 ≠ 从没启动过。压成任何一边都会伤到另一边。
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		const onStartTaskAgentSessionWithTaskPrompt = vi.fn();
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary()}
						taskAgentSessionLaunchHistoryEvidence="launch_history_unknown"
						onStartTaskAgentSessionWithTaskPrompt={onStartTaskAgentSessionWithTaskPrompt}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("This task's agent session isn't running.");
		expect(container.textContent).not.toContain("This session is no longer running.");
		expect(container.textContent).not.toContain("hasn't started");
		const buttons = [...container.querySelectorAll("button")];
		const startButton = buttons.find((button) => button.textContent?.includes("Start agent session"));
		const resumeButton = buttons.find((button) => button.textContent?.includes("Restart terminal session"));
		expect(startButton).toBeDefined();
		expect(resumeButton).toBeDefined();
		act(() => {
			resumeButton?.click();
		});
		expect(mockRefreshTerminal).toHaveBeenCalledTimes(1);
		expect(onStartTaskAgentSessionWithTaskPrompt).not.toHaveBeenCalled();
		act(() => {
			startButton?.click();
		});
		expect(onStartTaskAgentSessionWithTaskPrompt).toHaveBeenCalledTimes(1);
	});

	it("卡片确有启动史（硬中断后 summary 退化成占位）→ 仍是「随运行时没了」+ 续跑重启", () => {
		// a86d28ca 那个场景：首轮未结束被硬中断，summary 退化成占位，但卡片记得它启动过。
		// 这里必须保持原解释与续跑动作，不能被误判成「还没启动」去重发 prompt。
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary()}
						taskAgentSessionLaunchHistoryEvidence="launched_before"
						onStartTaskAgentSessionWithTaskPrompt={vi.fn()}
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("This session is no longer running.");
		expect(container.textContent).toContain("Restart terminal session");
		expect(container.textContent).not.toContain("Start agent session");
	});

	it("启动失败（liveness=failed）→ 说启动失败，而不是「随上一个运行时没了」", () => {
		mockHasRenderedAnyTerminalContent.mockReturnValue(false);
		act(() => {
			root.render(
				<TooltipProvider>
					<AgentTerminalPanel
						taskId="task-1"
						workspaceId="workspace-1"
						summary={createBlankInterruptedSummary({
							state: "failed",
							agentId: "claude",
							workspacePath: "/tmp/task-1",
							reviewReason: "error",
						})}
						taskAgentSessionLaunchHistoryEvidence="never_launched"
						showSessionToolbar={false}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("This agent session failed to start.");
		expect(container.textContent).not.toContain("This session is no longer running.");
		expect(container.textContent).toContain("Restart terminal session");
	});
});

// 「重新同步画面」与「重启 agent 会话」是两个语义完全不同的动作，而这两个按钮在本面板里要渲染两遍
// （完整工具栏 / 紧凑头部）。每条断言都在 showSessionToolbar 的两种取值下各跑一遍 —— 历史上这两处并列
// 的 JSX 正是「改了一处、忘了另一处」的常发地。
describe.each([true, false])(
	"画面 resync 与 agent 会话重启的分离（showSessionToolbar=%s）",
	(showSessionToolbar: boolean) => {
		let container: HTMLDivElement;
		let root: Root;

		beforeEach(() => {
			container = document.createElement("div");
			document.body.appendChild(container);
			root = createRoot(container);
			mockRefreshTerminal.mockClear();
			mockResyncTerminalView.mockClear();
			mockUseIsMobile.mockReturnValue(false);
			mockHasRenderedAnyTerminalContent.mockReturnValue(true);
		});

		afterEach(() => {
			act(() => {
				root.unmount();
			});
			container.remove();
		});

		function renderPanel(props: { taskId?: string; summary: RuntimeTaskSessionSummary }): void {
			act(() => {
				root.render(
					<TooltipProvider>
						<AgentTerminalPanel
							taskId={props.taskId ?? "task-1"}
							workspaceId="workspace-1"
							summary={props.summary}
							showSessionToolbar={showSessionToolbar}
							minimalHeaderTitle="Terminal"
						/>
					</TooltipProvider>,
				);
			});
		}

		it("resync 按钮只重画画面，绝不打到重启 agent 会话那条路上", () => {
			renderPanel({ summary: createSummary("codex") });

			const resyncButton = container.querySelector<HTMLButtonElement>('[aria-label="Resync terminal view"]');
			expect(resyncButton).not.toBeNull();
			expect(resyncButton?.disabled).toBe(false);

			act(() => {
				resyncButton?.click();
			});

			expect(mockResyncTerminalView).toHaveBeenCalledTimes(1);
			// 这是本次改动的核心不变式：resync 一路上不存在任何能到达 refreshTaskTerminal 的分支。
			expect(mockRefreshTerminal).not.toHaveBeenCalled();
			expect(findPortalButtonByLabel("Restart session")).toBeNull();
		});

		it("合成 shell 会话没有 agent 可重启，但画面冻住时照样要能 resync", () => {
			renderPanel({
				taskId: "__detail_terminal__:task-1",
				summary: createSummary("codex", "__detail_terminal__:task-1"),
			});

			expect(container.querySelector('[aria-label="Restart agent session"]')).toBeNull();
			const resyncButton = container.querySelector<HTMLButtonElement>('[aria-label="Resync terminal view"]');
			expect(resyncButton).not.toBeNull();

			act(() => {
				resyncButton?.click();
			});
			expect(mockResyncTerminalView).toHaveBeenCalledTimes(1);
		});

		it("活跃回合里点重启先弹确认；取消掉就什么都不发生", () => {
			renderPanel({ summary: createSummary("codex") });

			act(() => {
				container.querySelector<HTMLButtonElement>('[aria-label="Restart agent session"]')?.click();
			});
			expect(mockRefreshTerminal).not.toHaveBeenCalled();
			expect(findPortalButtonByLabel("Restart session")).not.toBeNull();

			act(() => {
				findPortalButtonByLabel("Cancel")?.click();
			});
			expect(mockRefreshTerminal).not.toHaveBeenCalled();
		});

		it("没有回合在跑时重启不打扰用户，直接执行", () => {
			renderPanel({ summary: { ...createSummary("codex"), state: "idle", pid: null } });

			act(() => {
				container.querySelector<HTMLButtonElement>('[aria-label="Restart agent session"]')?.click();
			});

			expect(mockRefreshTerminal).toHaveBeenCalledTimes(1);
			expect(findPortalButtonByLabel("Restart session")).toBeNull();
		});
	},
);

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
