import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PasscodeGate } from "./passcode-gate";

afterEach(() => vi.unstubAllGlobals());

it("解锁原生表单沿用校验及请求锁，网络失败后可用另一种组合键重试", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const authenticate = vi.fn();
	let finishRequest!: (value: Response) => void;
	const fetchRequest = vi
		.fn()
		.mockRejectedValueOnce(new Error("断网"))
		.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					finishRequest = resolve;
				}),
		);
	vi.stubGlobal("fetch", fetchRequest);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	try {
		await act(async () => root.render(<PasscodeGate onAuthenticated={authenticate} />));
		const input = container.querySelector("input")!;
		const pressSubmit = async (options: KeyboardEventInit) => {
			await act(async () =>
				input.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options }),
				),
			);
		};
		await pressSubmit({ ctrlKey: true });
		expect(fetchRequest).not.toHaveBeenCalled();
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-only-passcode");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await pressSubmit({ ctrlKey: true, isComposing: true });
		expect(fetchRequest).not.toHaveBeenCalled();
		await pressSubmit({ metaKey: true });
		expect(container.textContent).toContain("Could not connect");
		expect(input.value).toBe("test-only-passcode");
		await pressSubmit({ ctrlKey: true });
		await pressSubmit({ ctrlKey: true, repeat: true });
		expect(fetchRequest).toHaveBeenCalledTimes(2);
		expect(fetchRequest.mock.lastCall?.[1]).toMatchObject({
			body: JSON.stringify({ passcode: "test-only-passcode" }),
		});
		await act(async () => finishRequest(new Response("{}", { status: 200 })));
		expect(authenticate).toHaveBeenCalledTimes(1);
	} finally {
		act(() => root.unmount());
		container.remove();
	}
});
