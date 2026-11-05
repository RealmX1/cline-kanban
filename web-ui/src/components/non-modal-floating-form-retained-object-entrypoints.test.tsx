import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRestartWithAdditionalStartupArgumentsDialog } from "@/components/detail-panels/agent-session-restart-with-additional-startup-arguments-dialog";
import { SaveFindingDialog } from "@/components/findings/save-finding-dialog";
import { NonModalFloatingFormWindowHostProvider } from "@/components/non-modal-floating-form-window-host-provider";
import {
	TaskPinboardPinReasonDialog,
	type TaskPinboardPinReasonDialogRequest,
} from "@/components/task-pinboard-pin-reason-dialog";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function ObjectFormEntrypoint({ formKind }: { formKind: "置顶原因" | "Finding" | "带参数重启" }) {
	const [openingRequestSequence, setOpeningRequestSequence] = useState(0);
	const [pinRequest, setPinRequest] = useState<TaskPinboardPinReasonDialogRequest | null>(null);
	return (
		<>
			<button
				type="button"
				data-source-form-entrypoint
				onClick={() => {
					setOpeningRequestSequence((sequence) => sequence + 1);
					setPinRequest({
						workspaceId: "project-a",
						taskId: "task-a",
						taskTitle: "原任务",
						taskIncarnationCreatedAtEpochMs: 100,
						isEditingExistingPin: false,
						initialPinReason: "",
					});
				}}
			>
				打开填写窗
			</button>
			{formKind === "置顶原因" && (
				<TaskPinboardPinReasonDialog
					request={pinRequest}
					onCancel={() => setPinRequest(null)}
					onConfirm={vi.fn()}
				/>
			)}
			{openingRequestSequence > 0 && formKind === "Finding" && (
				<SaveFindingDialog
					workspaceId="project-a"
					conversationSessionTaskId="session-a"
					anchor={null}
					initialBodyMarkdown="原会话正文"
					existingFindings={[]}
					openingRequestIdentity={openingRequestSequence}
					onClose={() => setOpeningRequestSequence(0)}
				/>
			)}
			{openingRequestSequence > 0 && formKind === "带参数重启" && (
				<AgentSessionRestartWithAdditionalStartupArgumentsDialog
					open
					workspaceId="project-a"
					conversationSessionId="session-a"
					openingRequestSequence={openingRequestSequence}
					onOpenChange={() => setOpeningRequestSequence(0)}
					isAgentSessionInActiveTurn={false}
					onRestartAgentSession={vi.fn()}
				/>
			)}
		</>
	);
}

describe("真实对象填写入口的重复唤起", () => {
	it.each(["置顶原因", "Finding", "带参数重启"] as const)("%s 收起后再次打开保留原节点和草稿", async (formKind) => {
		await act(async () =>
			root.render(
				<NonModalFloatingFormWindowHostProvider>
					<ObjectFormEntrypoint formKind={formKind} />
				</NonModalFloatingFormWindowHostProvider>,
			),
		);
		const trigger = container.querySelector<HTMLButtonElement>("[data-source-form-entrypoint]")!;
		await act(async () => trigger.click());
		const dialog = document.querySelector<HTMLElement>("[data-non-modal-floating-form-window]")!;
		const field = dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
		await act(async () => {
			const prototype =
				field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, "不可覆盖的草稿");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!.click());
		expect(dialog.getAttribute("data-collapsed")).toBe("true");
		await act(async () => trigger.click());
		expect(document.querySelectorAll("[data-non-modal-floating-form-window]")).toHaveLength(1);
		expect(dialog.getAttribute("data-collapsed")).toBe("false");
		expect(dialog.querySelector("input,textarea")).toBe(field);
		expect(field.value).toBe("不可覆盖的草稿");
	});
});
