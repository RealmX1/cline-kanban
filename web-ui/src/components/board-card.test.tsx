import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

let mockWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | undefined;

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => mockWorkspaceSnapshot,
}));

vi.mock("@/utils/task-prompt", async () => {
	const actual = await vi.importActual<typeof import("@/utils/task-prompt")>("@/utils/task-prompt");
	return {
		...actual,
		truncateTaskPromptLabel: (prompt: string) => prompt.split("||")[0]?.trim() ?? "",
		normalizePromptForDisplay: (value: string) => value.split("||")[0]?.trim() ?? value.trim(),
	};
});

function createCard(overrides?: Partial<Parameters<typeof BoardCard>[0]["card"]>) {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSummary(
	state: RuntimeTaskSessionSummary["state"],
	overrides?: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

// React 受控 input：直接赋值不会触发 onChange，需走原生 setter + input 事件。
function setControlledInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function Harness(): React.ReactElement {
	const [card, setCard] = useState(
		createCard({
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		}),
	);

	return (
		<BoardCard
			card={card}
			index={0}
			columnId="backlog"
			onCancelAutomaticAction={() => {
				setCard((currentCard) => ({
					...currentCard,
					autoReviewEnabled: false,
				}));
			}}
		/>
	);
}

// agent 角标改为纯图标 + accessible name（aria-label）+ hover tooltip：完整「agent · 模型」
// 信息不再作为可见正文渲染，故从角标的可访问名读取断言。
function getAgentBadgeLabel(container: HTMLElement): string {
	return container.querySelector("[data-agent-badge]")?.getAttribute("aria-label") ?? "";
}

describe("BoardCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		mockWorkspaceSnapshot = undefined;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		// Mirror the real app, which mounts every BoardCard under a TooltipProvider
		// (see main.tsx), so action-button tooltips render without per-call wrapping.
		const baseRoot = createRoot(container);
		root = {
			render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
			unmount: () => baseRoot.unmount(),
		};
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 240,
			height: 32,
			right: 240,
			bottom: 32,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows a mode-specific cancel button and hides it after canceling auto review", async () => {
		await act(async () => {
			root.render(<Harness />);
		});

		const cancelButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Cancel Auto-PR",
		);
		expect(cancelButton).toBeDefined();

		await act(async () => {
			cancelButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			cancelButton?.click();
		});

		const nextCancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Cancel Auto-"),
		);
		expect(nextCancelButton).toBeUndefined();
	});

	it("shows a loading state on the review done button while moving to done", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="review" isMoveToTrashLoading />
				</TooltipProvider>,
			);
		});

		const trashButton = container.querySelector('button[aria-label="Move task to done"]');
		expect(trashButton).toBeInstanceOf(HTMLButtonElement);
		expect((trashButton as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(trashButton?.querySelector("svg.animate-spin")).toBeTruthy();
	});

	it("uses an archive icon for moving review cards to done", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="review" />
				</TooltipProvider>,
			);
		});

		const doneButton = container.querySelector('button[aria-label="Move task to done"]');
		expect(doneButton?.querySelector("svg.lucide-archive")).toBeTruthy();
		expect(doneButton?.querySelector("svg.lucide-trash-2")).toBeFalsy();
	});

	// 双轴重构 Stage 3「computing 脉动」（distinction ①）：agent 回合且最近 5s 内仍在产出 → 状态点
	// animate-pulse；静默 / 非 agent 回合 → 静止点。下面三例钉住这条接线（派生逻辑本身见
	// session-activity.test.ts 的 deriveDisplayLiveness 单测）。
	it("pulses the session-activity dot while a running agent is actively producing output (computing)", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", { lastOutputAt: Date.now() })}
					/>
				</TooltipProvider>,
			);
		});

		const dot = container.querySelector("span.inline-block.shrink-0.rounded-full");
		expect(dot).toBeInstanceOf(HTMLSpanElement);
		expect(dot?.className).toContain("animate-pulse");
	});

	it("does not pulse the dot once a running agent has gone quiet (no recent output)", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", { lastOutputAt: Date.now() - 60_000 })}
					/>
				</TooltipProvider>,
			);
		});

		const dot = container.querySelector("span.inline-block.shrink-0.rounded-full");
		expect(dot).toBeInstanceOf(HTMLSpanElement);
		expect(dot?.className).not.toContain("animate-pulse");
	});

	it("never pulses on a user-turn card even when its agent process is still live (awaiting review)", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", { lastOutputAt: Date.now(), pid: 123 })}
					/>
				</TooltipProvider>,
			);
		});

		const dot = container.querySelector("span.inline-block.shrink-0.rounded-full");
		expect(dot).toBeInstanceOf(HTMLSpanElement);
		expect(dot?.className).not.toContain("animate-pulse");
	});

	// channel B（distinction ②）：exited（进程已退）的 awaiting 卡片状态点渲染为「空心环」
	// （transparent 底 + 同色描边），与实心 live 点区分；点色仍随 channel C。下面四例钉住这条接线，
	// 含「显式 facet」与「经 ②-prep 派生」两路径，及 Cline 恒 live 不误标的反证。
	it("renders the session-activity dot as a hollow ring for an exited (process-gone) awaiting card", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", {
							pid: null,
							turnOwner: "user",
							liveness: "exited",
							userTurnKind: "review",
						})}
					/>
				</TooltipProvider>,
			);
		});
		const dot = container.querySelector<HTMLSpanElement>("span.inline-block.shrink-0.rounded-full");
		expect(dot).toBeInstanceOf(HTMLSpanElement);
		expect(dot?.style.backgroundColor).toBe("transparent");
		expect(dot?.getAttribute("style") ?? "").toContain("1.5px solid");
		expect(dot?.getAttribute("title")).toContain("process exited");
	});

	it("renders the session-activity dot as a filled dot (no ring) for a live awaiting card", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", {
							pid: 123,
							turnOwner: "user",
							liveness: "live",
							userTurnKind: "review",
						})}
					/>
				</TooltipProvider>,
			);
		});
		const dot = container.querySelector<HTMLSpanElement>("span.inline-block.shrink-0.rounded-full");
		expect(dot).toBeInstanceOf(HTMLSpanElement);
		expect(dot?.style.backgroundColor).not.toBe("transparent");
		expect(dot?.getAttribute("style") ?? "").not.toContain("solid");
		expect(dot?.getAttribute("title")).toBeNull();
	});

	it("②-prep×②-visible：终端 agent awaiting（pid null、无显式 facet）派生 exited → 空心环", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", { agentId: "claude", pid: null })}
					/>
				</TooltipProvider>,
			);
		});
		const dot = container.querySelector<HTMLSpanElement>("span.inline-block.shrink-0.rounded-full");
		expect(dot?.style.backgroundColor).toBe("transparent");
		expect(dot?.getAttribute("style") ?? "").toContain("1.5px solid");
	});

	it("②-prep×②-visible 反证：Cline awaiting（pid null、无显式 facet）派生 live → 实心点（不误标空心）", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", { agentId: "cline", pid: null })}
					/>
				</TooltipProvider>,
			);
		});
		const dot = container.querySelector<HTMLSpanElement>("span.inline-block.shrink-0.rounded-full");
		expect(dot?.style.backgroundColor).not.toBe("transparent");
		expect(dot?.getAttribute("style") ?? "").not.toContain("solid");
	});

	// Stage 3 余区：in_progress 状态标记的 `state==="failed"` 读 → facet 真相源
	// （严格等价 turnOwner==="user" && liveness==="failed"；复用卡片已解析的 sessionFacets）。
	// 经渲染查询失败标记 AlertCircle 的 `text-status-red` svg 钉住，含 exited≠failed 反证 + 显式 facet 采信。
	it("renders the failed status marker (AlertCircle/red) on an in-progress card with a failed session", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("failed")}
					/>
				</TooltipProvider>,
			);
		});
		expect(container.querySelector("svg.text-status-red")).toBeTruthy();
	});

	it("反证：exited（进程已退）的 awaiting_review 不渲染失败标记（exited ≠ failed，退化为 Spinner）", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("awaiting_review", {
							pid: null,
							exitCode: 0,
							turnOwner: "user",
							liveness: "exited",
							userTurnKind: "review",
						})}
					/>
				</TooltipProvider>,
			);
		});
		expect(container.querySelector("svg.text-status-red")).toBeFalsy();
	});

	it("采信显式 facet：turnOwner=user/liveness=failed（即便 legacy state=idle）仍渲染失败标记", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("idle", {
							turnOwner: "user",
							liveness: "failed",
							userTurnKind: "error",
						})}
					/>
				</TooltipProvider>,
			);
		});
		expect(container.querySelector("svg.text-status-red")).toBeTruthy();
	});

	it("hides the move-to-validation and move-to-done actions on in-progress cards", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						onMoveToTrash={vi.fn()}
						onMoveToValidation={vi.fn()}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('button[aria-label="Move task to done"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Move task to validation"]')).toBeNull();
	});

	it("shows the move-to-review action on an in-progress terminal-agent card and fires onMoveToReview", async () => {
		const onMoveToReview = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", { agentId: "claude" })}
						onMoveToReview={onMoveToReview}
					/>
				</TooltipProvider>,
			);
		});

		const reviewButton = container.querySelector<HTMLButtonElement>('button[aria-label="Move task to review"]');
		expect(reviewButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			reviewButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			reviewButton?.click();
		});

		expect(onMoveToReview).toHaveBeenCalledWith("task-1");
	});

	it("hides the move-to-review action on an in-progress Cline (in-process SDK) card", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("running", { agentId: "cline" })}
						onMoveToReview={vi.fn()}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('button[aria-label="Move task to review"]')).toBeNull();
	});

	it("hides the move-to-review action on a terminal-agent card outside In Progress (review column)", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", { agentId: "claude" })}
						onMoveToReview={vi.fn()}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('button[aria-label="Move task to review"]')).toBeNull();
	});

	it("moves review cards to validation from the compact card action", async () => {
		const onMoveToValidation = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="review" onMoveToValidation={onMoveToValidation} />
				</TooltipProvider>,
			);
		});

		const validationButton = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Move task to validation"]',
		);
		expect(validationButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			validationButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			validationButton?.click();
		});

		expect(onMoveToValidation).toHaveBeenCalledWith("task-1");
	});

	it("shows only the move-to-done action on validation cards", async () => {
		const onMoveToTrash = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="validation" onMoveToTrash={onMoveToTrash} />
				</TooltipProvider>,
			);
		});

		const doneButton = container.querySelector<HTMLButtonElement>('button[aria-label="Move task to done"]');
		expect(doneButton).toBeInstanceOf(HTMLButtonElement);
		expect(container.querySelector('button[aria-label="Move task to validation"]')).toBeNull();

		await act(async () => {
			doneButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			doneButton?.click();
		});

		expect(onMoveToTrash).toHaveBeenCalledWith("task-1");
	});

	it("shows the permanent delete action on backlog cards", async () => {
		const onDeleteTask = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="backlog" onDeleteTask={onDeleteTask} />
				</TooltipProvider>,
			);
		});

		const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="Delete task permanently"]');
		expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
		expect(deleteButton?.className).toContain("text-status-red");
		expect(deleteButton?.className).toContain("bg-status-red/10");

		await act(async () => {
			deleteButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			deleteButton?.click();
		});

		expect(onDeleteTask).toHaveBeenCalledWith("task-1");
	});

	it("opens the original prompt dialog from a card with a failed session", async () => {
		const rawPrompt = "Task title||full raw prompt body that the dialog must show verbatim";

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard({ prompt: rawPrompt })}
						index={0}
						columnId="in_progress"
						sessionSummary={createSummary("failed")}
					/>
				</TooltipProvider>,
			);
		});

		const viewPromptButton = container.querySelector<HTMLButtonElement>('button[aria-label="View original prompt"]');
		expect(viewPromptButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			viewPromptButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			viewPromptButton?.click();
		});

		const promptBlock = document.body.querySelector("[role='dialog'] pre");
		expect(promptBlock?.textContent).toBe(rawPrompt);
	});

	it("does not select the card when clicking non-interactive content inside the prompt dialog", async () => {
		const onCardSelect = vi.fn();

		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="backlog" onClick={onCardSelect} />);
		});

		const viewPromptButton = container.querySelector<HTMLButtonElement>('button[aria-label="View original prompt"]');
		await act(async () => {
			viewPromptButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			viewPromptButton?.click();
		});

		// 弹窗内容由 Radix Portal 挂到 document.body，但 React 合成事件仍会沿
		// React 组件树冒泡回卡片 shell；点击弹窗内非按钮区域不得触发选卡。
		const promptBlock = document.body.querySelector<HTMLElement>("[role='dialog'] pre");
		expect(promptBlock).not.toBeNull();

		await act(async () => {
			promptBlock?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			promptBlock?.click();
		});

		expect(onCardSelect).not.toHaveBeenCalled();
		expect(document.body.querySelector("[role='dialog'] pre")).not.toBeNull();
	});

	it("does not start dependency linking from cmd+mousedown inside the prompt dialog", async () => {
		const onDependencyPointerDown = vi.fn();

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="backlog"
					onDependencyPointerDown={onDependencyPointerDown}
				/>,
			);
		});

		const viewPromptButton = container.querySelector<HTMLButtonElement>('button[aria-label="View original prompt"]');
		await act(async () => {
			viewPromptButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			viewPromptButton?.click();
		});

		const promptBlock = document.body.querySelector<HTMLElement>("[role='dialog'] pre");
		expect(promptBlock).not.toBeNull();

		await act(async () => {
			promptBlock?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, metaKey: true }));
		});

		expect(onDependencyPointerDown).not.toHaveBeenCalled();
	});

	it("reconstructs and shows trashed worktree path when workspace metadata is not tracked", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard({ id: "trash-task-1" })}
						index={0}
						columnId="trash"
						workspacePath="/Users/alice/projects/kanban"
					/>
				</TooltipProvider>,
			);
		});

		// 完整 worktree 路径不再作为可见正文渲染，改由简写目录行的 title（hover 揭示）+ 复制按钮承载。
		const directoryRow = container.querySelector("[data-task-directory]");
		expect(directoryRow?.getAttribute("title")).toContain("~/.cline/worktrees/trash-task-1/kanban");
	});

	it("shows formatted agent override details with model name and reasoning effort", async () => {
		mockWorkspaceSnapshot = {
			taskId: "task-1",
			path: "/tmp/worktrees/task-1",
			branch: "feature/override",
			isDetached: false,
			headCommit: "1234567890abcdef",
			baseCommit: null,
			changedFiles: 2,
			additions: 5,
			deletions: 1,
		};

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard({
							agentId: "cline",
							clineSettings: {
								modelId: "openai/gpt-5.5",
								reasoningEffort: "low",
							},
						})}
						index={0}
						columnId="review"
					/>
				</TooltipProvider>,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("Cline");
		expect(getAgentBadgeLabel(container)).toContain("GPT-5.5 (Low)");
		expect(container.textContent).not.toContain("openai/gpt-5.5");
	});

	it("shows the task-level indicator for reasoning-only overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("GPT-5.5 (Low)");
	});

	it("shows a fallback indicator for reasoning-only overrides without a resolved default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("Default model (Low)");
	});

	it("shows explicit default reasoning metadata for reasoning-only task overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("GPT-5.5 (Default)");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("does not mislabel provider-only overrides as the global default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							providerId: "groq",
						},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("Provider: groq");
		expect(container.textContent).not.toContain("GPT-5.5");
	});

	it("does not show inherited global reasoning for explicit model overrides using default effort", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {
							modelId: "openai/gpt-5.5",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("GPT-5.5");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("always shows the global default agent when the task has no agent override", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="backlog" defaultAgentId="claude" />);
		});

		expect(getAgentBadgeLabel(container)).toContain("Claude Code");
	});

	it("shows the agent locked from the previous run over the current default", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="review"
					sessionSummary={createSummary("awaiting_review", { agentId: "cline" })}
					defaultAgentId="claude"
				/>,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("Cline");
		expect(container.textContent).not.toContain("Claude Code");
	});

	it("shows the task-level agent override over the global default", async () => {
		await act(async () => {
			root.render(
				<BoardCard card={createCard({ agentId: "codex" })} index={0} columnId="backlog" defaultAgentId="claude" />,
			);
		});

		expect(getAgentBadgeLabel(container)).toContain("OpenAI Codex");
		expect(container.textContent).not.toContain("Claude Code");
	});

	it("shows no agent badge when there is no override, session, or default agent", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="backlog" />);
		});

		expect(container.querySelector("svg.lucide-bot")).toBeNull();
	});

	it("shows tool input details in the session preview text", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Using Read",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: null,
							hookEventName: "tool_call",
							notificationType: null,
							source: "cline-sdk",
						},
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Using Read");
	});

	it("shows non-cline tool activity in the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "claude",
						latestHookActivity: {
							activityText: "Completed Read: src/index.ts",
							toolName: "Read",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "tool_result",
							notificationType: null,
							source: "claude",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Completed Read");
	});

	it("keeps canonical tool names in the session preview label", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "kiro",
						latestHookActivity: {
							activityText: "Using fs_write: src/index.ts",
							toolName: "fs_write",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "preToolUse",
							notificationType: null,
							source: "kiro",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("fs_write(src/index.ts)");
	});

	it("parses codex tool activity into the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Calling Read: src/index.ts",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "raw_response_item",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Calling Read");
	});

	it("does not show a stale bare tool name for non-tool review updates", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", {
							agentId: "kiro",
							latestHookActivity: {
								activityText: "Waiting for review",
								toolName: "fs_write",
								toolInputSummary: null,
								finalMessage: null,
								hookEventName: "stop",
								notificationType: null,
								source: "kiro",
							},
						})}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("Waiting for review");
		expect(container.textContent).not.toContain("fs_write");
	});

	it("keeps showing the last cline tool label during assistant streaming", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Agent active",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: "Looking at the file now",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("renders session activity as single-line truncated text on trash cards", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="trash"
						sessionSummary={createSummary("awaiting_review", {
							latestHookActivity: {
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: preview,
								hookEventName: "assistant_delta",
								notificationType: null,
								source: "cline-sdk",
							},
						})}
					/>
				</TooltipProvider>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("renders session activity as single-line truncated text for running tasks", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: null,
							toolName: null,
							toolInputSummary: null,
							finalMessage: preview,
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("shows the latest assistant preview on active task cards", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: "Reviewing the final diff",
							toolName: null,
							toolInputSummary: null,
							finalMessage: "Reviewing the final diff",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Reviewing the final diff");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("shows normal agent messages without the agent prefix", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Agent: checking the next file",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "agent_message",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("checking the next file");
		expect(container.textContent).not.toContain("Agent:");
	});

	const getTitleParagraph = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("p")).find(
			(paragraph) => paragraph.textContent?.trim() === "Review API changes",
		);

	it("enters title edit mode on double-click for in-progress cards", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" onSaveTitle={() => {}} />);
		});

		expect(container.querySelector("input")).toBeNull();

		await act(async () => {
			getTitleParagraph(container)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});

		const input = container.querySelector<HTMLInputElement>("input");
		expect(input).toBeInstanceOf(HTMLInputElement);
		expect(input?.value).toBe("Review API changes");
	});

	it("enters title edit mode on double-click for done (trash) cards", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="trash" onSaveTitle={() => {}} />
				</TooltipProvider>,
			);
		});

		await act(async () => {
			getTitleParagraph(container)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});

		expect(container.querySelector("input")).toBeInstanceOf(HTMLInputElement);
	});

	it("saves the renamed title on Enter after double-click edit", async () => {
		const onSaveTitle = vi.fn();

		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="review" onSaveTitle={onSaveTitle} />);
		});

		await act(async () => {
			getTitleParagraph(container)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});

		const input = container.querySelector<HTMLInputElement>("input");
		expect(input).toBeInstanceOf(HTMLInputElement);

		await act(async () => {
			input?.focus();
			if (input) {
				setControlledInputValue(input, "Renamed via enter");
			}
			input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});

		expect(onSaveTitle).toHaveBeenCalledWith("task-1", "Renamed via enter");
	});

	it("delays single-click navigation and cancels it on double-click for navigating columns", async () => {
		vi.useFakeTimers();
		try {
			const onClick = vi.fn();

			await act(async () => {
				root.render(
					<BoardCard
						card={createCard()}
						index={0}
						columnId="in_progress"
						onClick={onClick}
						onSaveTitle={() => {}}
					/>,
				);
			});

			const shell = container.querySelector<HTMLElement>(".kb-board-card-shell");
			expect(shell).toBeInstanceOf(HTMLElement);

			// 单击不应立即导航——延迟窗口内挂起。
			await act(async () => {
				shell?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
			});
			expect(onClick).not.toHaveBeenCalled();

			// 推进延迟窗口后才真正导航。
			await act(async () => {
				vi.advanceTimersByTime(220);
			});
			expect(onClick).toHaveBeenCalledTimes(1);

			onClick.mockClear();

			// 双击：第一击排程后 dblclick 取消之，导航不触发、进入标题编辑。
			await act(async () => {
				shell?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
				shell?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
			});
			await act(async () => {
				vi.advanceTimersByTime(500);
			});
			expect(onClick).not.toHaveBeenCalled();
			expect(container.querySelector("input")).toBeInstanceOf(HTMLInputElement);
		} finally {
			vi.useRealTimers();
		}
	});
});
