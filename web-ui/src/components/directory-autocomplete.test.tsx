import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DirectoryAutocomplete } from "@/components/directory-autocomplete";

// 这个组件唯一的外部依赖是目录列举；本文件只测按键语义，返回空结果即可（下拉保持关闭）。
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		projects: {
			listDirectoryContents: {
				query: async () => ({ ok: true, entries: [], rootPath: "/repos" }),
			},
		},
	}),
}));

describe("DirectoryAutocomplete IME composition safety", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let keyDownReachingHostDialog: (event: KeyboardEvent) => void;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		// 宿主 Radix Dialog 的 dismiss 监听装在这个输入框之外；用一个 document 级监听器代表它——
		// 只要 Escape 冒泡到这里，真实环境里 Add Project 弹窗就已经被关掉了。
		keyDownReachingHostDialog = vi.fn<(event: KeyboardEvent) => void>();
		document.addEventListener("keydown", keyDownReachingHostDialog);
	});

	afterEach(() => {
		document.removeEventListener("keydown", keyDownReachingHostDialog);
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

	async function renderAutocomplete(): Promise<HTMLInputElement> {
		await act(async () => {
			root.render(<DirectoryAutocomplete value="/" onChange={vi.fn()} workspaceId="project-1" />);
		});
		const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
		if (!input) {
			throw new Error("Expected the directory input to be rendered.");
		}
		input.focus();
		return input;
	}

	async function pressEscape(input: HTMLInputElement, init: KeyboardEventInit = {}): Promise<void> {
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }));
		});
	}

	it("still swallows an Escape emitted while the IME is composing, without acting on it", async () => {
		// 组字中的 Escape 只是「撤掉候选词」。让开不等于放行冒泡：一旦冒到宿主 Dialog，
		// 用户会连整张 Add Project 表单一起丢掉（重开还是空的）。
		const input = await renderAutocomplete();

		await pressEscape(input, { isComposing: true });

		expect(keyDownReachingHostDialog).not.toHaveBeenCalled();
		// 同时不得执行本处理器自己的动作——组字中被失焦，输入法当场断掉。
		expect(document.activeElement).toBe(input);
	});

	it("keeps blurring the input on a real Escape once the composition has ended", async () => {
		// 守卫不能把正常路径也堵死：非组字的 Escape（下拉已关）照旧失焦，且照旧不冒泡。
		const input = await renderAutocomplete();

		await pressEscape(input);

		expect(keyDownReachingHostDialog).not.toHaveBeenCalled();
		expect(document.activeElement).not.toBe(input);
	});
});
