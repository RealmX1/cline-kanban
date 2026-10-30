import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRestartWithAdditionalStartupArgumentsDialog } from "./agent-session-restart-with-additional-startup-arguments-dialog";

describe("Codex 带参数重启弹窗", () => {
	let host: HTMLDivElement;
	let root: Root;
	const restart = vi.fn<(arguments_: string[]) => Promise<void>>();
	const close = vi.fn();
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		restart.mockReset().mockResolvedValue(undefined);
		close.mockReset();
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
	});
	async function render(active = false) {
		await act(async () =>
			root.render(
				<AgentSessionRestartWithAdditionalStartupArgumentsDialog
					open
					onOpenChange={close}
					isAgentSessionInActiveTurn={active}
					onRestartAgentSession={restart}
				/>,
			),
		);
	}
	async function fill(value: string) {
		const textarea = document.querySelector("textarea")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
	async function submit() {
		await act(async () =>
			document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
		);
	}
	it.each(["metaKey", "ctrlKey"])("%s+Enter 复用参数解析与重启入口", async (submitShortcutModifierPropertyName) => {
		await render();
		await fill('--cd "/path with spaces" ""');
		await act(async () =>
			document.querySelector("textarea")!.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					[submitShortcutModifierPropertyName]: true,
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(restart).toHaveBeenCalledOnce();
		expect(restart).toHaveBeenCalledWith(["--cd", "/path with spaces", ""]);
		expect(close).toHaveBeenCalledWith(false);
	});
	it("普通 Enter、组字和长按不触发重启", async () => {
		await render();
		for (const properties of [{}, { ctrlKey: true, isComposing: true }, { metaKey: true, repeat: true }]) {
			await act(async () =>
				document
					.querySelector("textarea")!
					.dispatchEvent(
						new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...properties }),
					),
			);
		}
		expect(restart).not.toHaveBeenCalled();
	});
	it("取消不重启，空输入可提交", async () => {
		await render();
		await act(async () =>
			[...document.querySelectorAll("button")].find((button) => button.textContent === "取消")!.click(),
		);
		expect(restart).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledWith(false);
		await submit();
		expect(restart).toHaveBeenCalledWith([]);
	});
	it("先显示解析错误，修正后保留带空格路径与空参数", async () => {
		await render(true);
		expect(document.body.textContent).toContain("当前回合仍在运行");
		await fill('--cd "未闭合');
		await submit();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("双引号未闭合");
		expect(restart).not.toHaveBeenCalled();
		await fill('--cd "/path with spaces" ""');
		await submit();
		expect(restart).toHaveBeenCalledWith(["--cd", "/path with spaces", ""]);
	});
	it("提交期间禁止重复提交和关闭，失败保留输入并允许重试", async () => {
		let rejectRestart: (reason: Error) => void = () => {};
		restart.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectRestart = reject;
				}),
		);
		await render();
		await fill("--future-debug");
		await submit();
		await submit();
		expect(restart).toHaveBeenCalledOnce();
		expect(document.querySelector("textarea")!.disabled).toBe(true);
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
		expect(close).not.toHaveBeenCalled();
		await act(async () => rejectRestart(new Error("原生启动失败")));
		expect(document.querySelector('[role="alert"]')?.textContent).toBe("原生启动失败");
		expect(document.querySelector("textarea")!.value).toBe("--future-debug");
		await submit();
		expect(restart).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledWith(false);
	});
});
