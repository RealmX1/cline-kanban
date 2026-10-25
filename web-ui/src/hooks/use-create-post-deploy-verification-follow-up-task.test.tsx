import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostDeployVerificationTaskReadModelTestFixture } from "@/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";
import { createInitialBoardData } from "@/data/board-data";
import type { RuntimePostDeployVerificationDeploymentGroup, RuntimeProjectSummary } from "@/runtime/types";
import { useCreatePostDeployVerificationFollowUpTask } from "./use-create-post-deploy-verification-follow-up-task";

const readIdentity = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/post-deploy-verification-entry-navigation-query", () => ({
	readPostDeployVerificationFollowUpSourceTaskIdentity: readIdentity,
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: toast }));
type Inputs = Parameters<typeof useCreatePostDeployVerificationFollowUpTask>[0];
let root: Root;
let container: HTMLDivElement;
let createFollowUp: ReturnType<typeof useCreatePostDeployVerificationFollowUpTask>;
const group: RuntimePostDeployVerificationDeploymentGroup = {
	deploymentId: "history",
	workspaceId: "source-project",
	deployedSourceCommit: "abc",
	previousDeployedSourceCommit: null,
	deployedAtIso: "2026-10-01T00:00:00Z",
	foldedAtIso: "2026-10-02T00:00:00Z",
	tasks: [createPostDeployVerificationTaskReadModelTestFixture({ verifiedAt: "2026-10-01T01:00:00Z" })],
};
function inputs(): Inputs {
	return {
		activeGroup: null,
		historyGroups: [group],
		board: createInitialBoardData(),
		projects: [
			{ id: "source-project", name: "来源项目", availability: { status: "available" } } as RuntimeProjectSummary,
		],
		isTaskEditorOpen: false,
		canOpenTaskEditor: true,
		openTaskEditor: vi.fn(),
		initializeFollowUpDraft: vi.fn(),
	};
}
function Harness({ input }: { input: Inputs }) {
	createFollowUp = useCreatePostDeployVerificationFollowUpTask(input);
	return null;
}
function render(input: Inputs) {
	act(() => root.render(<Harness input={input} />));
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
describe("历史及已删除来源的续接建卡编排", () => {
	it("已结案历史来源不在看板上时，用保留身份创建来源项目的关联草稿", async () => {
		readIdentity.mockResolvedValue({ title: "已删除的来源任务", createdAt: 123 });
		const input = inputs();
		render(input);
		await act(async () => createFollowUp("history", "task-1", []));
		expect(readIdentity).toHaveBeenCalledWith({ workspaceId: "source-project", taskId: "task-1" });
		expect(input.openTaskEditor).toHaveBeenCalledWith("source-project");
		expect(input.initializeFollowUpDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				referenceRelationDrafts: [
					expect.objectContaining({
						counterpartWorkUnit: expect.objectContaining({ taskIncarnationCreatedAtEpochMs: 123 }),
						assertedRelationKindSpecificAttributes: expect.objectContaining({
							originatingPostDeployVerificationEntry: expect.objectContaining({ deploymentId: "history" }),
						}),
					}),
				],
			}),
		);
	});
	it("身份暂不可读时不伪造时间戳，重试恢复后正常建草稿", async () => {
		readIdentity
			.mockRejectedValueOnce(new Error("身份暂不可读"))
			.mockResolvedValueOnce({ title: "来源任务", createdAt: 1 });
		const input = inputs();
		render(input);
		await act(async () => createFollowUp("history", "task-1", []));
		expect(input.openTaskEditor).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: "身份暂不可读" }));
		await act(async () => createFollowUp("history", "task-1", []));
		expect(input.initializeFollowUpDraft).toHaveBeenCalledOnce();
	});
	it("等待读取期间打开其他编辑器，会取消迟到的续接结果", async () => {
		let resolveIdentity!: (value: { title: string; createdAt: number }) => void;
		readIdentity.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveIdentity = resolve;
				}),
		);
		const input = inputs();
		render(input);
		const pending = createFollowUp("history", "task-1", []);
		render({ ...input, isTaskEditorOpen: true });
		await act(async () => {
			resolveIdentity({ title: "来源", createdAt: 1 });
			await pending;
		});
		expect(input.openTaskEditor).not.toHaveBeenCalled();
		expect(input.initializeFollowUpDraft).not.toHaveBeenCalled();
	});
	it.each(["部分", "全部"])("身份读取期间%s所选项消失时拒绝草稿，重置后恢复且不会重复创建", async (removedScope) => {
		let resolveIdentity!: (value: { title: string; createdAt: number }) => void;
		readIdentity.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveIdentity = resolve;
				}),
		);
		const checklist = ["first", "second"].map((id) => ({
			id,
			label: `核对 ${id}`,
			checked: false,
			source: "custom" as const,
			kind: "guided_manual" as const,
			guidance: null,
			script: null,
			run: null,
			cleanup: null,
		}));
		const input = inputs();
		input.historyGroups = [
			{ ...group, tasks: [createPostDeployVerificationTaskReadModelTestFixture({ checklist })] },
		];
		render(input);
		const pending = createFollowUp("history", "task-1", ["first", "second"]);
		await createFollowUp("history", "task-1", ["first", "second"]);
		expect(readIdentity).toHaveBeenCalledOnce();
		expect(input.openTaskEditor).not.toHaveBeenCalled();
		expect(input.initializeFollowUpDraft).not.toHaveBeenCalled();
		const currentChecklist = removedScope === "部分" ? checklist.slice(0, 1) : [];
		render({
			...input,
			historyGroups: [
				{
					...group,
					tasks: [createPostDeployVerificationTaskReadModelTestFixture({ checklist: currentChecklist })],
				},
			],
		});
		await act(async () => {
			resolveIdentity({ title: "来源", createdAt: 123 });
			await pending;
		});
		expect(input.openTaskEditor).not.toHaveBeenCalled();
		expect(input.initializeFollowUpDraft).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalledWith({ intent: "warning", message: "所选核对项已变化，请刷新后重新选择。" });

		readIdentity.mockResolvedValueOnce({ title: "来源", createdAt: 123 });
		const resetSelectedChecklistItemIds = currentChecklist.map((item) => item.id);
		await act(async () => createFollowUp("history", "task-1", resetSelectedChecklistItemIds));
		expect(readIdentity).toHaveBeenCalledTimes(2);
		expect(input.openTaskEditor).toHaveBeenCalledExactlyOnceWith("source-project");
		expect(input.initializeFollowUpDraft).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				referenceRelationDrafts: [
					expect.objectContaining({
						counterpartWorkUnit: expect.objectContaining({ taskIncarnationCreatedAtEpochMs: 123 }),
						assertedRelationKindSpecificAttributes: expect.objectContaining({
							originatingPostDeployVerificationEntry: expect.objectContaining({
								selectedChecklistItemIds: resetSelectedChecklistItemIds,
							}),
						}),
					}),
				],
			}),
		);
	});
});
