import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { useFormPrimaryActionSubmitKeyboardShortcut } from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";

const attachmentPreparation = vi.hoisted(() => ({ pending: false }));
vi.mock("@/hooks/use-persistent-agent-prompt-image-attachments", () => ({
	usePersistentAgentPromptImageAttachments: ({
		value,
		onValueChange,
	}: {
		value: string;
		onValueChange: (value: string) => void;
	}) => ({
		visibleText: value,
		onVisibleTextChange: onValueChange,
		images: [],
		onImagesChange: () => {},
		isPreparingImages: attachmentPreparation.pending,
		errorMessage: null,
	}),
}));

afterEach(() => {
	attachmentPreparation.pending = false;
	vi.unstubAllGlobals();
});

it("有匹配回调时由编辑器提交，否则交给宿主；图片准备和长按阻止提交", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const submitHost = vi.fn();
	const submitComposer = vi.fn();
	function Harness({ composerHandlesSubmit = false }: { composerHandlesSubmit?: boolean }) {
		const handleHostKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({ onSubmit: submitHost });
		return (
			<div onKeyDown={handleHostKeyDown}>
				<TaskPromptComposer
					value="正文"
					onValueChange={() => {}}
					onSubmit={composerHandlesSubmit ? submitComposer : undefined}
					showPseudoHtmlBlockInsertButton={false}
				/>
			</div>
		);
	}
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	try {
		const press = async (options: KeyboardEventInit = {}) => {
			await act(async () =>
				container.querySelector("textarea")!.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Enter",
						ctrlKey: true,
						bubbles: true,
						cancelable: true,
						...options,
					}),
				),
			);
		};
		await act(async () => root.render(<Harness />));
		await press();
		expect(submitHost).toHaveBeenCalledTimes(1);
		attachmentPreparation.pending = true;
		await act(async () => root.render(<Harness />));
		await press();
		expect(submitHost).toHaveBeenCalledTimes(1);
		attachmentPreparation.pending = false;
		await act(async () => root.render(<Harness composerHandlesSubmit />));
		await press({ repeat: true });
		await press({ isComposing: true });
		await press({ shiftKey: true });
		await press({ altKey: true });
		expect(submitComposer).not.toHaveBeenCalled();
		await press();
		expect(submitComposer).toHaveBeenCalledTimes(1);
		expect(submitHost).toHaveBeenCalledTimes(1);
	} finally {
		act(() => root.unmount());
		container.remove();
	}
});
