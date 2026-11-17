import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostNonModalFloatingForm } from "@/components/host-non-modal-floating-form";
import { NonModalFloatingFormWindow } from "@/components/non-modal-floating-form-window";
import {
	NonModalFloatingFormWindowHostProvider,
	useNonModalFloatingFormWindowHost,
} from "@/components/non-modal-floating-form-window-host-provider";

let root: Root;
afterEach(() => act(() => root?.unmount()));

describe("常驻填写浮窗", () => {
	it("入口重挂载后重新唤起保留草稿，关闭通知交还当前入口，旧实例迟到关闭不影响重开窗口", async () => {
		const oldSourceClosed = vi.fn();
		const newSourceClosed = vi.fn();
		let oldClose: (() => void) | undefined;
		function Form(props: { open: boolean; requestSequence: number; close: () => void }) {
			oldClose ??= props.close;
			return (
				<NonModalFloatingFormWindow open title="重新唤起" onOpenChange={props.close}>
					<textarea defaultValue="保留的草稿" />
				</NonModalFloatingFormWindow>
			);
		}
		const Entry = hostNonModalFloatingForm(Form, {
			formKind: "reopen",
			isOpen: (props) => props.open,
			instanceIdentity: () => "same-task",
			ownership: () => ({ workspaceId: "project-a", taskId: "a1b2c", taskIncarnationCreatedAtEpochMs: 100 }),
			openingRequestIdentity: (props) => props.requestSequence,
			withClose: (props, close) => ({ ...props, close }),
			onClosed: (props) => props.close(),
		});
		const container = document.body.appendChild(document.createElement("div"));
		root = createRoot(container);
		const render = (entry: React.ReactNode) =>
			root.render(<NonModalFloatingFormWindowHostProvider>{entry}</NonModalFloatingFormWindowHostProvider>);
		await act(async () => render(<Entry open requestSequence={1} close={oldSourceClosed} />));
		const textarea = document.querySelector("textarea");
		await act(async () => render(null));
		await act(async () => render(<Entry open requestSequence={2} close={newSourceClosed} />));
		expect(document.querySelector("textarea")).toBe(textarea);
		await act(async () => oldClose?.());
		expect(oldSourceClosed).not.toHaveBeenCalled();
		expect(newSourceClosed).toHaveBeenCalledOnce();
		await act(async () => render(<Entry open requestSequence={3} close={newSourceClosed} />));
		await act(async () => oldClose?.());
		expect(document.querySelector("textarea")).not.toBeNull();
		expect(newSourceClosed).toHaveBeenCalledOnce();
		container.remove();
	});
	it("入口卸载后草稿保留，重复打开唤起原窗口，不同任务可并存且迟到关闭不影响新实例", async () => {
		const submissions = vi.fn();
		let closeFirst: (() => void) | undefined;
		function Form({ target, close }: { target: string; close: () => void }) {
			const [value, setValue] = useState("");
			return (
				<NonModalFloatingFormWindow open title={target} onOpenChange={close}>
					<input aria-label={target} value={value} onChange={(event) => setValue(event.target.value)} />
					<button type="button" onClick={() => submissions(target, value)}>
						保存 {target}
					</button>
				</NonModalFloatingFormWindow>
			);
		}
		function Entry({ target }: { target: string }) {
			const host = useNonModalFloatingFormWindowHost();
			return (
				<button
					type="button"
					onClick={() =>
						host?.openWindow({
							formKind: "测试表单",
							instanceIdentity: target,
							ownership: { workspaceId: target },
							render: ({ close }) => {
								if (target === "A" && !closeFirst) closeFirst = close;
								return <Form target={target} close={close} />;
							},
						})
					}
				>
					打开 {target}
				</button>
			);
		}
		function App({ target }: { target: string | null }) {
			return (
				<NonModalFloatingFormWindowHostProvider>
					{target && <Entry key={target} target={target} />}
				</NonModalFloatingFormWindowHostProvider>
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => root.render(<App target="A" />));
		await act(async () => container.querySelector("button")?.click());
		const input = document.querySelector<HTMLInputElement>('input[aria-label="A"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "A 的草稿");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => root.render(<App target="B" />));
		await act(async () => container.querySelector("button")?.click());
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
		expect(input.value).toBe("A 的草稿");
		await act(async () => root.render(<App target="A" />));
		await act(async () => container.querySelector("button")?.click());
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
		await act(async () => closeFirst?.());
		await act(async () => container.querySelector("button")?.click());
		await act(async () => closeFirst?.());
		expect(document.querySelector('input[aria-label="A"]')).not.toBeNull();
		container.remove();
	});

	it("迁移后的历史身份展开原编辑窗并收起其他窗，不新建实例", async () => {
		function Form({ label }: { label: string }) {
			const [value, setValue] = useState("未保存正文");
			return (
				<NonModalFloatingFormWindow open title={label} onOpenChange={() => undefined}>
					<textarea aria-label={label} value={value} onChange={(event) => setValue(event.target.value)} />
				</NonModalFloatingFormWindow>
			);
		}
		function App() {
			const host = useNonModalFloatingFormWindowHost();
			return (
				<>
					<button
						type="button"
						onClick={() =>
							host?.openWindow({
								formKind: "task-editor",
								instanceIdentity: JSON.stringify(["project-a", "task", 100]),
								ownership: { workspaceId: "project-a", taskId: "task", taskIncarnationCreatedAtEpochMs: 100 },
								render: () => <Form label="原窗口" />,
							})
						}
					>
						打开原窗口
					</button>
					<button
						type="button"
						onClick={() =>
							host?.openWindow({
								formKind: "task-editor",
								instanceIdentity: JSON.stringify(["project-c", "other", 200]),
								ownership: { workspaceId: "project-c", taskId: "other", taskIncarnationCreatedAtEpochMs: 200 },
								render: () => <Form label="其他窗口" />,
							})
						}
					>
						打开其他窗口
					</button>
					<button
						type="button"
						onClick={() =>
							host?.revealTaskEditorPreservingEarlierWorkspace({
								workspaceId: "project-b",
								taskId: "task",
								taskIncarnationCreatedAtEpochMs: 100,
								workspaceIdsUsedByTaskIncarnation: ["project-a", "project-b"],
							})
						}
					>
						按迁移后身份展开
					</button>
				</>
			);
		}
		const container = document.body.appendChild(document.createElement("div"));
		root = createRoot(container);
		await act(async () =>
			root.render(
				<NonModalFloatingFormWindowHostProvider>
					<App />
				</NonModalFloatingFormWindowHostProvider>,
			),
		);
		const buttons = [...container.querySelectorAll("button")];
		await act(async () => buttons[0]?.click());
		await act(async () => buttons[1]?.click());
		const original = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="原窗口"]');
		expect(original).not.toBeNull();
		await act(async () => buttons[2]?.click());
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
		expect(document.querySelector('textarea[aria-label="原窗口"]')).toBe(original);
		expect(original?.value).toBe("未保存正文");
		const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
		expect(dialogs.find((dialog) => dialog.textContent?.includes("原窗口"))?.getAttribute("data-collapsed")).not.toBe(
			"true",
		);
		expect(dialogs.find((dialog) => dialog.textContent?.includes("其他窗口"))?.getAttribute("data-collapsed")).toBe(
			"true",
		);
		container.remove();
	});
});
