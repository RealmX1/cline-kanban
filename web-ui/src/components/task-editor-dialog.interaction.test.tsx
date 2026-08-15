import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskEditorDialog } from "@/components/task-editor-dialog";

type Props = ComponentProps<typeof TaskEditorDialog>;

function makeProps(overrides: Partial<Props> = {}): Props {
	return {
		open: true,
		onOpenChange: vi.fn(),
		taskEditorMode: "create",
		prompt: "",
		onPromptChange: vi.fn(),
		images: [],
		onImagesChange: vi.fn(),
		onCreate: vi.fn(() => null),
		onCreateMultiple: vi.fn(() => []),
		startInPlanMode: false,
		onStartInPlanModeChange: vi.fn(),
		taskAgentPermissionMode: "bypass_all_permission_prompts",
		onTaskAgentPermissionModeChange: vi.fn(),
		autoReviewEnabled: false,
		onAutoReviewEnabledChange: vi.fn(),
		autoReviewMode: "commit",
		onAutoReviewModeChange: vi.fn(),
		workspaceId: "project-1",
		branchRef: "main",
		branchOptions: [{ value: "main", label: "main" }],
		onBranchRefChange: vi.fn(),
		worktreeMode: "branch",
		onWorktreeModeChange: vi.fn(),
		agents: [],
		defaultAgentId: "claude",
		...overrides,
	};
}

function findButtonByText(label: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === label) as
		| HTMLButtonElement
		| undefined;
}

function findCloseButton(): HTMLButtonElement | null {
	return document.body.querySelector<HTMLButtonElement>('[aria-label="Close"]');
}

function hasPlanModeOverridesPermissionTierNotice(): boolean {
	return document.body.textContent?.includes('"Start in plan mode" overrides this tier') ?? false;
}

describe("TaskEditorDialog interactions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		// Radix + rich inputs touch a few DOM APIs jsdom does not implement.
		if (typeof globalThis.ResizeObserver === "undefined") {
			globalThis.ResizeObserver = class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			} as unknown as typeof ResizeObserver;
		}
		Element.prototype.scrollIntoView ??= () => {};
		Element.prototype.hasPointerCapture ??= () => false;
		Element.prototype.setPointerCapture ??= () => {};
		Element.prototype.releasePointerCapture ??= () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "{}",
			})),
		);

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function render(props: Props): Promise<void> {
		await act(async () => {
			root.render(<TaskEditorDialog {...props} />);
		});
	}

	it("closes immediately via the X button when the form has no edits", async () => {
		const onOpenChange = vi.fn();
		await render(makeProps({ onOpenChange, prompt: "" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(findButtonByText("Discard")).toBeUndefined();
	});

	it("asks for confirmation via the X button when the form has edits, and does not close until confirmed", async () => {
		const onOpenChange = vi.fn();
		// 打开时基线为空 prompt；随后受控地填入内容，模拟用户输入。
		await render(makeProps({ onOpenChange, prompt: "" }));
		await render(makeProps({ onOpenChange, prompt: "Fix the bug" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		// 有编辑 → 弹确认，不直接关闭
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText("Discard")).toBeDefined();
		expect(findButtonByText("Keep editing")).toBeDefined();

		await act(async () => {
			findButtonByText("Discard")?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("keeps the dialog open when the user chooses to keep editing", async () => {
		const onOpenChange = vi.fn();
		await render(makeProps({ onOpenChange, prompt: "" }));
		await render(makeProps({ onOpenChange, prompt: "Fix the bug" }));

		await act(async () => {
			findCloseButton()?.click();
		});
		expect(findButtonByText("Discard")).toBeDefined();

		await act(async () => {
			findButtonByText("Keep editing")?.click();
		});

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText("Discard")).toBeUndefined();
	});

	it("does NOT guard in edit mode: closes directly even with edits (edit close saves a draft)", async () => {
		const onOpenChange = vi.fn();
		// edit 模式：即便表单有改动，关闭也不弹「放弃」确认——直通 base 的关闭语义。
		await render(makeProps({ onOpenChange, taskEditorMode: "edit", prompt: "" }));
		await render(makeProps({ onOpenChange, taskEditorMode: "edit", prompt: "Edited body" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(findButtonByText("Discard")).toBeUndefined();
	});

	// droid 的 autonomyMode 是单轴（spec / normal / auto-high）：勾了 plan 起步就写 spec，
	// 权限档根本不会被写入。用户看到的两条正交设置与实际执行不一致，必须当场明示。
	it("warns that plan-mode start swallows the permission tier on single-axis harnesses", async () => {
		await render(makeProps({ defaultAgentId: "droid", startInPlanMode: true }));
		expect(hasPlanModeOverridesPermissionTierNotice()).toBe(true);
	});

	it("does not warn about a plan-mode conflict when the harness keeps the two axes independent", async () => {
		await render(makeProps({ defaultAgentId: "droid", startInPlanMode: false }));
		expect(hasPlanModeOverridesPermissionTierNotice()).toBe(false);

		await render(makeProps({ defaultAgentId: "claude", startInPlanMode: true }));
		expect(hasPlanModeOverridesPermissionTierNotice()).toBe(false);
	});
	// （编辑既有卡片显示的是卡自己的 baseRef、用户手动改过显示的是他自己的选择），它们就是在撒谎。
	describe("base ref 来源提示的显示条件", () => {
		const rememberedBaseRefProps: Partial<Props> = {
			branchOptions: [
				{ value: "main", label: "main" },
				{ value: "feature/remembered", label: "feature/remembered" },
			],
			taskCreateBaseRefRememberedForCurrentProject: "feature/remembered",
			repositoryDefaultBranchRef: "main",
		};
		const discardedRememberedBaseRefProps: Partial<Props> = {
			rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists: "feature/deleted",
			repositoryDefaultBranchRef: "main",
			resolvedDefaultTaskCreateBaseRef: "main",
		};

		function hasRememberedHint(): boolean {
			return document.body.textContent?.includes("Remembered from the last task you created") ?? false;
		}
		function hasDiscardedRememberedHint(): boolean {
			return document.body.textContent?.includes("no longer exists") ?? false;
		}

		it("建卡模式下显示「记住的」提示，用户手动改回默认分支后不再显示", async () => {
			await render(makeProps({ ...rememberedBaseRefProps, branchRef: "feature/remembered" }));
			expect(hasRememberedHint()).toBe(true);

			await render(makeProps({ ...rememberedBaseRefProps, branchRef: "main" }));
			expect(hasRememberedHint()).toBe(false);
		});

		it("编辑既有卡片时不显示「记住的」提示——那显示的是卡自己的 baseRef", async () => {
			await render(
				makeProps({ ...rememberedBaseRefProps, taskEditorMode: "edit", branchRef: "feature/remembered" }),
			);
			expect(hasRememberedHint()).toBe(false);
		});

		it("建卡模式下显示「记忆分支已消失」提示", async () => {
			await render(makeProps({ ...discardedRememberedBaseRefProps, branchRef: "main" }));
			expect(hasDiscardedRememberedHint()).toBe(true);
		});

		it("编辑既有卡片时不显示「记忆分支已消失」提示", async () => {
			await render(makeProps({ ...discardedRememberedBaseRefProps, taskEditorMode: "edit", branchRef: "main" }));
			expect(hasDiscardedRememberedHint()).toBe(false);
		});

		it("用户手动挑了别的分支后不再把它说成自动回落的结果", async () => {
			await render(
				makeProps({
					...discardedRememberedBaseRefProps,
					branchOptions: [
						{ value: "main", label: "main" },
						{ value: "release/1", label: "release/1" },
					],
					branchRef: "release/1",
				}),
			);
			expect(hasDiscardedRememberedHint()).toBe(false);
		});
	});
});

/**
 * 逐字输入已下沉为对话框本地 state（A-P0-1）：不再每次按键都经 `onPromptChange` 打到
 * `App` 根节点连同整棵卡片树重渲。下面几例钉住这次下沉的三条不变量——不逐键上抛、
 * 失焦上抛、以及提交时必须把最新草稿交出去（否则用户刚敲完就点提交会丢掉最后一段）。
 */
describe("TaskEditorDialog prompt draft ownership", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		if (typeof globalThis.ResizeObserver === "undefined") {
			globalThis.ResizeObserver = class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			} as unknown as typeof ResizeObserver;
		}
		Element.prototype.scrollIntoView ??= () => {};
		Element.prototype.hasPointerCapture ??= () => false;
		Element.prototype.setPointerCapture ??= () => {};
		Element.prototype.releasePointerCapture ??= () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "{}",
			})),
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function getPromptTextarea(): HTMLTextAreaElement {
		const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) {
			throw new Error("Expected the prompt textarea to be rendered.");
		}
		return textarea;
	}

	// React 受控 textarea：直接赋值不触发 onChange，需走原生 setter + input 事件。
	async function typeIntoPrompt(value: string): Promise<void> {
		const textarea = getPromptTextarea();
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(textarea, value);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("does not push every keystroke up to the parent", async () => {
		const onPromptChange = vi.fn();
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange })} />);
		});

		for (const value of ["F", "Fi", "Fix", "Fix ", "Fix t", "Fix th", "Fix the"]) {
			await typeIntoPrompt(value);
		}

		expect(onPromptChange).not.toHaveBeenCalled();
		expect(getPromptTextarea().value).toBe("Fix the");
	});

	it("pushes the draft up on blur", async () => {
		const onPromptChange = vi.fn();
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange })} />);
		});

		await typeIntoPrompt("Fix the bug");
		expect(onPromptChange).not.toHaveBeenCalled();

		// React 的 onBlur 由委托在 root 上的 focusout 合成，派发不冒泡的 blur 事件到不了它。
		await act(async () => {
			getPromptTextarea().focus();
			getPromptTextarea().blur();
		});

		expect(onPromptChange).toHaveBeenCalledWith("Fix the bug");
	});

	it("hands the newest draft to onCreate even when the textarea never lost focus", async () => {
		// 回归保护：提交那一刻父层 state 必然落后一拍，若不经 promptOverride 显式交接，
		// 「敲完直接点 Create」会用上一次上抛的旧文本建卡。
		const onCreate: Props["onCreate"] = vi.fn(() => "task-1");
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onCreate, prompt: "" })} />);
		});

		await typeIntoPrompt("Ship the fix");

		await act(async () => {
			findButtonByText("Create")?.click();
		});

		expect(onCreate).toHaveBeenCalledTimes(1);
		expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ promptOverride: "Ship the fix" }));
	});

	it("adopts a prompt value changed by the parent (reopening on a different task)", async () => {
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ prompt: "First task body" })} />);
		});
		expect(getPromptTextarea().value).toBe("First task body");

		await typeIntoPrompt("Locally edited body");
		expect(getPromptTextarea().value).toBe("Locally edited body");

		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ prompt: "Second task body" })} />);
		});

		expect(getPromptTextarea().value).toBe("Second task body");
	});

	// 对话框关闭后组件仍保持挂载（App 无条件渲染 <TaskEditorDialog open={...}/>），
	// 所以「关闭」必须同时做两件事：把本地草稿拉回父层当前值、并让挂起的停顿上抛失效。
	// 下面三例分别钉住这两条以及它们不能误伤的既有行为。
	async function waitPastIdlePropagation(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => {
				// 需真实超过 PROMPT_DRAFT_IDLE_PROPAGATION_DELAY_MS（1500ms）。
				setTimeout(resolve, 1800);
			});
		});
	}

	it("does not write the submitted prompt back to the parent after the dialog closed", async () => {
		// 回归保护：提交后父层 newTaskPrompt 本就是空串，setNewTaskPrompt("") 被 React bail out、
		// prop 不变，渲染期 prop 同步无从触发。若挂起的停顿上抛不受 open 约束，它会在关闭之后
		// 才 fire，把已提交的文本写回父层——下次打开 New task 就是幽灵内容，再点一次 Create 即重复建卡。
		const onPromptChange = vi.fn();
		const onCreate: Props["onCreate"] = vi.fn(() => "task-1");
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange, onCreate, prompt: "" })} />);
		});

		await typeIntoPrompt("Ship the fix");
		await act(async () => {
			findButtonByText("Create")?.click();
		});

		// create 路径关闭：open 翻 false，而父层 prompt 依旧是空串。
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange, onCreate, prompt: "", open: false })} />);
		});

		await waitPastIdlePropagation();

		expect(onPromptChange).not.toHaveBeenCalled();
	});

	it("still propagates the draft after an idle pause while the dialog is open", async () => {
		// 守住崩溃兜底：给去抖回调加 open 守卫不能顺手把「停顿即上抛」杀掉，
		// 否则编辑模式的草稿写盘会永远等不到内容。
		const onPromptChange = vi.fn();
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange, prompt: "" })} />);
		});

		await typeIntoPrompt("Typed but never blurred");
		expect(onPromptChange).not.toHaveBeenCalled();

		await waitPastIdlePropagation();

		expect(onPromptChange).toHaveBeenCalledWith("Typed but never blurred");
	});

	it("restores the parent prompt into the local draft when an edit dialog is reopened", async () => {
		// 守住关闭同步不能吃掉编辑模式的正文：重新打开同一张卡时应看到父层正文，
		// 而不是上次未提交的本地草稿。
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ taskEditorMode: "edit", prompt: "Original body" })} />);
		});
		expect(getPromptTextarea().value).toBe("Original body");

		await typeIntoPrompt("Abandoned local edit");
		expect(getPromptTextarea().value).toBe("Abandoned local edit");

		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ taskEditorMode: "edit", prompt: "", open: false })} />);
		});
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ taskEditorMode: "edit", prompt: "Original body" })} />);
		});

		expect(getPromptTextarea().value).toBe("Original body");
	});

	// 这两条提示都在解释「下拉框里这个值是怎么来的」。只要下拉框显示的不是那个自动解析出来的值
});
