import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useFormPrimaryActionSubmitKeyboardShortcut } from "./use-form-primary-action-submit-keyboard-shortcut";

afterEach(() => vi.unstubAllGlobals());

function Form({
	onSubmit,
	disabled = false,
	children,
}: {
	onSubmit: Parameters<typeof useFormPrimaryActionSubmitKeyboardShortcut>[0]["onSubmit"];
	disabled?: boolean;
	children?: React.ReactNode;
}) {
	const onKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({ onSubmit, disabled });
	return (
		<div onKeyDown={onKeyDown}>
			<textarea aria-label="表单正文" />
			{children}
		</div>
	);
}

async function withForm(
	verify: (container: HTMLDivElement, render: (children: React.ReactNode) => void) => Promise<void>,
) {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	try {
		await verify(container, (children) => act(() => root.render(children)));
	} finally {
		act(() => root.unmount());
		container.remove();
	}
}

function press(target: Element, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
	act(() => target.dispatchEvent(event));
	return event;
}

it("两种提交组合键保留原始事件；Enter、Shift、Alt 和组字不提交，长按不重复", async () => {
	await withForm(async (container, render) => {
		const submit = vi.fn();
		render(<Form onSubmit={submit} />);
		const textarea = container.querySelector("textarea")!;
		for (const options of [
			{},
			{ ctrlKey: true, shiftKey: true },
			{ metaKey: true, altKey: true },
			{ ctrlKey: true, isComposing: true },
			{ metaKey: true, keyCode: 229 },
		]) {
			expect(press(textarea, options).defaultPrevented).toBe(false);
		}
		expect(submit).not.toHaveBeenCalled();
		for (const options of [{ metaKey: true }, { ctrlKey: true }]) {
			const event = press(textarea, options);
			expect(event.defaultPrevented).toBe(true);
			expect(submit.mock.lastCall?.[0].nativeEvent).toBe(event);
		}
		press(textarea, { ctrlKey: true, repeat: true });
		expect(submit).toHaveBeenCalledTimes(2);
	});
});

it("忙碌及无效表单消费组合键，请求完成后允许重试", async () => {
	await withForm(async (container, render) => {
		const outerSubmit = vi.fn();
		let finishSubmission!: () => void;
		const submit = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishSubmission = resolve;
				}),
		);
		render(
			<Form onSubmit={outerSubmit}>
				<Form disabled onSubmit={submit} />
			</Form>,
		);
		const textarea = container.querySelectorAll("textarea")[1]!;
		expect(press(textarea, { ctrlKey: true }).defaultPrevented).toBe(true);
		expect(submit).not.toHaveBeenCalled();
		render(
			<Form onSubmit={outerSubmit}>
				<Form onSubmit={submit} />
			</Form>,
		);
		press(textarea, { ctrlKey: true });
		press(textarea, { ctrlKey: true });
		expect(submit).toHaveBeenCalledTimes(1);
		await act(async () => finishSubmission());
		press(textarea, { metaKey: true });
		expect(submit).toHaveBeenCalledTimes(2);
		expect(outerSubmit).not.toHaveBeenCalled();
		await act(async () => finishSubmission());
	});
});

it("沿用宿主 fieldset 的忙碌锁，阻止禁用的评论等嵌套表单提交", async () => {
	await withForm(async (container, render) => {
		const submit = vi.fn();
		render(
			<fieldset disabled>
				<Form onSubmit={submit} />
			</fieldset>,
		);
		expect(press(container.querySelector("textarea")!, { ctrlKey: true }).defaultPrevented).toBe(true);
		expect(submit).not.toHaveBeenCalled();
	});
});

it("子编辑器优先消费，Portal 选择器不能提交宿主表单或外层面板", async () => {
	await withForm(async (container, render) => {
		const submit = vi.fn();
		const outerSubmit = vi.fn();
		const selector = document.body.appendChild(document.createElement("div"));
		try {
			render(
				<Form onSubmit={outerSubmit}>
					<Form onSubmit={submit}>
						<textarea aria-label="自动保存编辑器" onKeyDown={(event) => event.preventDefault()} />
						{createPortal(<input aria-label="Portal 选择器" />, selector)}
					</Form>
				</Form>,
			);
			press(container.querySelector('[aria-label="自动保存编辑器"]')!, { ctrlKey: true });
			press(selector.querySelector("input")!, { metaKey: true });
			expect(submit).not.toHaveBeenCalled();
			expect(outerSubmit).not.toHaveBeenCalled();
		} finally {
			selector.remove();
		}
	});
});
