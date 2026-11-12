import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fileToTaskImage } from "@/components/task-image-input-utils";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentPromptFileAttachmentQueries } from "@/runtime/agent-prompt-file-attachment-query";
import type { TaskImage } from "@/types";

vi.mock("@/runtime/agent-prompt-file-attachment-query", () => ({
	agentPromptFileAttachmentQueries: { save: vi.fn() },
}));
let container: HTMLDivElement;
let root: Root;
const submit = vi.fn();
const pendingChanged = vi.fn();
function Harness({ allowFileAttachments = true }: { allowFileAttachments?: boolean }) {
	const [prompt, setPrompt] = useState("初始正文");
	const [images, setImages] = useState<TaskImage[]>([]);
	return (
		<TooltipProvider>
			<TaskPromptComposer
				value={prompt}
				onValueChange={setPrompt}
				images={images}
				onImagesChange={setImages}
				allowFileAttachments={allowFileAttachments}
				onAttachmentPreparationPendingChange={pendingChanged}
				onSubmit={submit}
				onSubmitAndStart={submit}
			/>
		</TooltipProvider>
	);
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	vi.mocked(agentPromptFileAttachmentQueries.save).mockImplementation(async (file) => ({
		fileName: file.fileName,
		filePath: `/persistent-attachments/${file.fileName}`,
	}));
	await act(async () => root.render(<Harness />));
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function selectFiles(files: File[]) {
	await act(async () => {
		const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(input, "files", { configurable: true, value: files });
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
async function waitUntilUploadCompletes() {
	await act(async () => vi.waitFor(() => expect(pendingChanged).toHaveBeenLastCalledWith(false)));
	expect(container.querySelector('[role="status"]')).toBeNull();
}

it("文件选择接受任意类型，普通文件写入正文，支持的图片仍显示缩略图", async () => {
	expect(container.querySelector('input[type="file"]')?.getAttribute("accept")).toBeNull();
	expect(container.textContent).toContain("添加附件");
	await selectFiles([
		new File(["参考材料"], "参考.pdf", { type: "application/pdf" }),
		new File(["image"], "参考.png", { type: "image/png" }),
	]);
	await waitUntilUploadCompletes();
	expect(agentPromptFileAttachmentQueries.save).toHaveBeenCalledTimes(1);
	expect(agentPromptFileAttachmentQueries.save).toHaveBeenCalledWith({
		fileName: "参考.pdf",
		fileContentBase64: btoa(String.fromCharCode(...new TextEncoder().encode("参考材料"))),
	});
	expect(container.querySelector("textarea")?.value).toContain("/persistent-attachments/参考.pdf");
	expect(container.querySelector('img[alt="参考.png"]')?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
});

it("拖放保留空文件与未支持的图片格式，文件引用按文本写入", async () => {
	await act(async () => {
		const event = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", {
			value: { files: [new File([], "empty.txt"), new File(["svg"], "图.svg", { type: "image/svg+xml" })] },
		});
		container.querySelector("textarea")!.dispatchEvent(event);
	});
	await waitUntilUploadCompletes();
	expect(agentPromptFileAttachmentQueries.save).toHaveBeenCalledWith({ fileName: "empty.txt", fileContentBase64: "" });
	expect(container.querySelector("textarea")?.value).toContain("empty.txt");
	expect(container.querySelector("textarea")?.value).toContain("图.svg");
	expect(container.querySelector("img")).toBeNull();
});

it("从 FileReader 开始拦截提交，上传期间继续编辑并合并到最新正文", async () => {
	let finishUpload!: (value: { fileName: string; filePath: string }) => void;
	vi.mocked(agentPromptFileAttachmentQueries.save).mockReturnValue(
		new Promise((resolve) => {
			finishUpload = resolve;
		}),
	);
	const readFile = vi.spyOn(FileReader.prototype, "readAsDataURL");
	await selectFiles([new File(["text"], "notes.txt")]);
	expect(readFile).toHaveBeenCalledOnce();
	expect(pendingChanged).toHaveBeenCalledWith(true);
	await act(async () => {
		const textarea = container.querySelector("textarea")!;
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "上传期间的新正文");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		for (const shiftKey of [false, true])
			textarea.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey, bubbles: true, cancelable: true }),
			);
	});
	expect(submit).not.toHaveBeenCalled();
	await act(async () => vi.waitFor(() => expect(agentPromptFileAttachmentQueries.save).toHaveBeenCalledOnce()));
	await act(async () => finishUpload({ fileName: "notes.txt", filePath: "/persistent/notes.txt" }));
	expect(container.querySelector("textarea")?.value).toBe(
		'上传期间的新正文\n\n附件："notes.txt"\n持久路径："/persistent/notes.txt"',
	);
	expect(pendingChanged).toHaveBeenLastCalledWith(false);
});

it("失败显示错误且可重新选择同一文件，超限文件不读取", async () => {
	vi.mocked(agentPromptFileAttachmentQueries.save).mockRejectedValueOnce(new Error("上传失败"));
	const file = new File(["text"], "retry.txt");
	await selectFiles([file]);
	await waitUntilUploadCompletes();
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("上传失败");
	expect(container.querySelector("textarea")?.value).toBe("初始正文");
	await selectFiles([file]);
	await waitUntilUploadCompletes();
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(container.querySelector("textarea")?.value).toContain("retry.txt");
	const oversize = new File([], "oversize.bin");
	Object.defineProperty(oversize, "size", { value: 20 * 1024 * 1024 + 1 });
	const readFile = vi.spyOn(FileReader.prototype, "readAsDataURL");
	await selectFiles([oversize]);
	expect(readFile).not.toHaveBeenCalled();
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("20MB");
});

it.each(["error", "abort"])("图片读取 %s 时返回失败，不留下悬挂的读取", async (eventType) => {
	vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
		this.dispatchEvent(new ProgressEvent(eventType));
	});
	expect(await fileToTaskImage(new File(["image"], "unreadable.png", { type: "image/png" }))).toBeNull();
});

it("读取错误释放提交拦截，关闭或进入新草稿后忽略迟到响应", async () => {
	const readFile = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
		this.dispatchEvent(new ProgressEvent("error"));
	});
	await selectFiles([new File(["text"], "unreadable.txt")]);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("读取");
	expect(pendingChanged).toHaveBeenLastCalledWith(false);
	readFile.mockRestore();
	let finishUpload!: (value: { fileName: string; filePath: string }) => void;
	vi.mocked(agentPromptFileAttachmentQueries.save).mockReturnValue(
		new Promise((resolve) => {
			finishUpload = resolve;
		}),
	);
	await selectFiles([new File(["text"], "late.txt")]);
	await act(async () => vi.waitFor(() => expect(agentPromptFileAttachmentQueries.save).toHaveBeenCalledOnce()));
	await act(async () => root.render(<Harness key="next-draft" />));
	await act(async () => finishUpload({ fileName: "late.txt", filePath: "/persistent/late.txt" }));
	expect(container.querySelector("textarea")?.value).toBe("初始正文");
	expect(container.querySelector('[role="status"]')).toBeNull();
});

it("其他输入入口继续只接受现有图片类型", async () => {
	await act(async () => root.render(<Harness allowFileAttachments={false} />));
	expect(container.querySelector('input[type="file"]')?.getAttribute("accept")).toContain("image/png");
	await selectFiles([new File(["text"], "not-supported.txt")]);
	expect(agentPromptFileAttachmentQueries.save).not.toHaveBeenCalled();
	expect(container.querySelector("textarea")?.value).toBe("初始正文");
});

it("多次选择的上传分别完成时保留全部引用，最后一批完成才释放提交", async () => {
	const finishUploads: ((value: { fileName: string; filePath: string }) => void)[] = [];
	vi.mocked(agentPromptFileAttachmentQueries.save).mockImplementation(
		() => new Promise((resolve) => finishUploads.push(resolve)),
	);
	await selectFiles([new File(["first"], "first.txt")]);
	await selectFiles([new File(["second"], "second.txt")]);
	await act(async () => vi.waitFor(() => expect(finishUploads).toHaveLength(2)));
	await act(async () => finishUploads[1]!({ fileName: "second.txt", filePath: "/persistent/second.txt" }));
	expect(pendingChanged).toHaveBeenLastCalledWith(true);
	await act(async () => finishUploads[0]!({ fileName: "first.txt", filePath: "/persistent/first.txt" }));
	expect(pendingChanged).toHaveBeenLastCalledWith(false);
	expect(container.querySelector("textarea")?.value).toContain("/persistent/first.txt");
	expect(container.querySelector("textarea")?.value).toContain("/persistent/second.txt");
});

it("读取完成前切换草稿，不发起上传或写入新草稿", async () => {
	let pendingReader!: FileReader;
	vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
		pendingReader = this;
	});
	await selectFiles([new File(["late"], "late-read.txt")]);
	await act(async () => root.render(<Harness key="next-draft-before-file-read" />));
	await act(async () => {
		Object.defineProperty(pendingReader, "result", { value: "data:text/plain;base64,bGF0ZQ==" });
		pendingReader.dispatchEvent(new ProgressEvent("load"));
	});
	expect(agentPromptFileAttachmentQueries.save).not.toHaveBeenCalled();
	expect(container.querySelector("textarea")?.value).toBe("初始正文");
	expect(container.querySelector('[role="status"]')).toBeNull();
});
