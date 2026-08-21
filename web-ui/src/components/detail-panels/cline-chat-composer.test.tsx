import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClineChatComposer } from "@/components/detail-panels/cline-chat-composer";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/components/detail-panels/cline-chat-model-selector", () => ({
	ClineChatModelSelector: () => null,
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		listWorkspaceFiles: { query: vi.fn(async () => ({ files: [] })) },
		listSlashCommands: { query: vi.fn(async () => ({ commands: [] })) },
	}),
}));

function renderComposer(
	root: Root,
	overrides: { canSend?: boolean; agentEntryKeyboardFocusRequestKey?: number } = {},
): void {
	const element: ReactElement = (
		<TooltipProvider>
			<ClineChatComposer
				taskId="task-1"
				agentEntryKeyboardFocusRequestKey={overrides.agentEntryKeyboardFocusRequestKey}
				draft=""
				onDraftChange={() => {}}
				placeholder="Message the agent"
				mode="act"
				onModeChange={() => {}}
				canSend={overrides.canSend ?? true}
				canCancel={false}
				onSend={() => {}}
				onCancel={() => {}}
				modelOptions={[]}
				selectedModelId="model-1"
				selectedModelButtonText="Model"
				onSelectModel={() => {}}
				selectedReasoningEffort=""
				onSelectReasoningEffort={() => {}}
			/>
		</TooltipProvider>
	);
	act(() => {
		root.render(element);
	});
}

function requireComposerTextarea(container: HTMLElement): HTMLTextAreaElement {
	const textarea = container.querySelector("textarea");
	if (!(textarea instanceof HTMLTextAreaElement)) {
		throw new Error("Expected the composer textarea.");
	}
	return textarea;
}

describe("ClineChatComposer 的键盘焦点交接", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal(
			"matchMedia",
			vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
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
		window.getSelection()?.removeAllRanges();
		vi.unstubAllGlobals();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("聚焦请求 key 递增时把焦点交给输入框", () => {
		renderComposer(root, { agentEntryKeyboardFocusRequestKey: 1 });
		const textarea = requireComposerTextarea(container);
		textarea.blur();
		expect(document.activeElement).not.toBe(textarea);

		renderComposer(root, { agentEntryKeyboardFocusRequestKey: 2 });

		expect(document.activeElement).toBe(textarea);
	});

	it("输入框还禁用着时请求保持挂起，待其可用再兑现", () => {
		renderComposer(root, { canSend: false, agentEntryKeyboardFocusRequestKey: 1 });
		const textarea = requireComposerTextarea(container);

		renderComposer(root, { canSend: false, agentEntryKeyboardFocusRequestKey: 2 });
		expect(document.activeElement).not.toBe(textarea);

		renderComposer(root, { canSend: true, agentEntryKeyboardFocusRequestKey: 2 });
		expect(document.activeElement).toBe(textarea);
	});

	it("用户正拖选着文字时不抢焦点 —— 抢了会清掉选区", () => {
		renderComposer(root, { agentEntryKeyboardFocusRequestKey: 1 });
		const textarea = requireComposerTextarea(container);
		textarea.blur();

		const selectableText = document.createElement("p");
		selectableText.textContent = "task card title text";
		document.body.appendChild(selectableText);
		const range = document.createRange();
		range.selectNodeContents(selectableText);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		renderComposer(root, { agentEntryKeyboardFocusRequestKey: 2 });

		expect(document.activeElement).not.toBe(textarea);
		expect(window.getSelection()?.toString()).toContain("task card title text");
		selectableText.remove();
	});
});
