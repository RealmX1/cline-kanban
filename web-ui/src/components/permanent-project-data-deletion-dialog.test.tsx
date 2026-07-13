import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermanentProjectDataDeletionDialog } from "@/components/permanent-project-data-deletion-dialog";
import type {
	RuntimeProjectPermanentDeletionPreview,
	RuntimeProjectPermanentDeletionResult,
	RuntimeProjectSummary,
} from "@/runtime/types";

const PROJECT: RuntimeProjectSummary = {
	id: "project-1",
	name: "Kanban",
	path: "/tmp/Kanban",
	taskCounts: { backlog: 1, in_progress: 1, review: 0, validation: 0, trash: 0 },
	availability: { status: "available" },
	inProgressTaskDetails: [],
};

const PREVIEW: RuntimeProjectPermanentDeletionPreview = {
	projectId: "project-1",
	projectName: "Kanban",
	projectPath: "/tmp/Kanban",
	workspaceStateRevision: 7,
	totalTaskCount: 2,
	activeSessionCount: 1,
	managedWorktreeCount: 1,
	workspaceStateDirectoryPath: "/tmp/.cline/kanban/workspaces/project-1",
	deletionAllowed: true,
	blockingReasons: [],
	requiredConfirmationProjectName: "Kanban",
};

const PARTIAL_FAILURE_RESULT: RuntimeProjectPermanentDeletionResult = {
	status: "aborted_before_project_data_deletion",
	failureCode: "managed_worktree_deletion_failed",
	projectId: "project-1",
	stoppedSessionCount: 1,
	worktreeDeletionResults: [
		{
			taskId: "task-1",
			path: "/tmp/worktrees/task-1",
			ok: false,
			removed: false,
			error: "permission denied",
		},
	],
	projectIndexDeleted: false,
	workspaceStateDirectoryDeleted: false,
	failures: [
		{
			code: "managed_worktree_deletion_failed",
			message: "permission denied",
			path: "/tmp/worktrees/task-1",
			taskId: "task-1",
		},
	],
	retainedPaths: ["/tmp/.cline/kanban/workspaces/project-1"],
	newCurrentProjectId: null,
};

function getButtonByText(text: string): HTMLButtonElement {
	const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent === text);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Button with text "${text}" was not rendered.`);
	}
	return button;
}

function changeInputValue(input: HTMLInputElement, value: string): void {
	const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	if (!nativeValueSetter) {
		throw new Error("Native HTML input value setter is unavailable.");
	}
	nativeValueSetter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function getConfirmationProjectNameInput(): HTMLInputElement {
	const confirmationInput = document.querySelector('[aria-label="Confirmation project name"]');
	if (!(confirmationInput instanceof HTMLInputElement)) {
		throw new Error("Confirmation project name input was not rendered.");
	}
	return confirmationInput;
}

describe("PermanentProjectDataDeletionDialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	async function renderPermanentProjectDataDeletionDialogForTest(options: {
		onGetPermanentDeletionPreview: () => Promise<RuntimeProjectPermanentDeletionPreview | null>;
		onPermanentlyDeleteProjectData: () => Promise<RuntimeProjectPermanentDeletionResult>;
	}): Promise<void> {
		await act(async () => {
			root.render(
				<PermanentProjectDataDeletionDialog
					project={PROJECT}
					isPermanentDeletionPending={false}
					onGetPermanentDeletionPreview={options.onGetPermanentDeletionPreview}
					onPermanentlyDeleteProjectData={options.onPermanentlyDeleteProjectData}
					onClose={() => {}}
				/>,
			);
			await Promise.resolve();
		});
	}

	async function enterExactConfirmationProjectNameAndSubmitDeletion(): Promise<void> {
		await act(async () => {
			changeInputValue(getConfirmationProjectNameInput(), "Kanban");
			getButtonByText("Permanently Delete Project Data").click();
			await Promise.resolve();
		});
	}

	it("focuses Cancel and requires an exact project-name match before enabling permanent deletion", async () => {
		const onPermanentlyDeleteProjectData = vi.fn(async () => PARTIAL_FAILURE_RESULT);
		await renderPermanentProjectDataDeletionDialogForTest({
			onGetPermanentDeletionPreview: async () => PREVIEW,
			onPermanentlyDeleteProjectData,
		});

		const cancelButton = getButtonByText("Cancel");
		const deletionButton = getButtonByText("Permanently Delete Project Data");
		expect(document.activeElement).toBe(cancelButton);
		expect(deletionButton.disabled).toBe(true);
		expect(document.body.textContent).toContain("Tasks");
		expect(document.body.textContent).toContain("Active sessions");
		expect(document.body.textContent).toContain("Managed worktrees");
		expect(document.body.textContent).toContain(PREVIEW.workspaceStateDirectoryPath);

		const confirmationInput = getConfirmationProjectNameInput();
		await act(async () => {
			changeInputValue(confirmationInput, "kanban");
		});
		expect(deletionButton.disabled).toBe(true);

		await act(async () => {
			changeInputValue(confirmationInput, "Kanban");
		});
		expect(deletionButton.disabled).toBe(false);

		await act(async () => {
			deletionButton.click();
			await Promise.resolve();
		});
		expect(onPermanentlyDeleteProjectData).toHaveBeenCalledWith({
			projectId: "project-1",
			expectedWorkspaceStateRevision: 7,
			confirmationProjectName: "Kanban",
		});
		expect(document.body.textContent).toContain("Permanent deletion was aborted before project data was deleted.");
		expect(document.body.textContent).toContain("permission denied");
		expect(document.body.textContent).toContain("/tmp/.cline/kanban/workspaces/project-1");
	});

	it("refreshes a stale preview and requires confirmation again", async () => {
		const refreshedPreview = { ...PREVIEW, workspaceStateRevision: 8, totalTaskCount: 3 };
		const onGetPermanentDeletionPreview = vi
			.fn<() => Promise<RuntimeProjectPermanentDeletionPreview | null>>()
			.mockResolvedValueOnce(PREVIEW)
			.mockResolvedValueOnce(refreshedPreview);
		const onPermanentlyDeleteProjectData = vi.fn(
			async (): Promise<RuntimeProjectPermanentDeletionResult> => ({
				...PARTIAL_FAILURE_RESULT,
				failureCode: "preview_stale",
				failures: [{ code: "preview_stale", message: "stale" }],
				worktreeDeletionResults: [],
				stoppedSessionCount: 0,
			}),
		);

		await renderPermanentProjectDataDeletionDialogForTest({
			onGetPermanentDeletionPreview,
			onPermanentlyDeleteProjectData,
		});
		await enterExactConfirmationProjectNameAndSubmitDeletion();
		await act(async () => {
			await Promise.resolve();
		});

		expect(onGetPermanentDeletionPreview).toHaveBeenCalledTimes(2);
		expect(document.body.textContent).toContain("Review the updated impact and confirm again.");
		const refreshedConfirmationInput = document.querySelector('[aria-label="Confirmation project name"]');
		expect(refreshedConfirmationInput).toBeInstanceOf(HTMLInputElement);
		expect((refreshedConfirmationInput as HTMLInputElement).value).toBe("");
		expect(getButtonByText("Permanently Delete Project Data").disabled).toBe(true);
	});

	it("shows retained-path and worktree results when state changes after worktree deletion", async () => {
		const onGetPermanentDeletionPreview = vi.fn(async () => PREVIEW);
		const onPermanentlyDeleteProjectData = vi.fn(
			async (): Promise<RuntimeProjectPermanentDeletionResult> => ({
				...PARTIAL_FAILURE_RESULT,
				failureCode: "workspace_state_changed_after_managed_worktree_deletion",
				failures: [
					{
						code: "workspace_state_changed_after_managed_worktree_deletion",
						message: "Workspace state changed after managed worktree deletion.",
					},
				],
				worktreeDeletionResults: [{ taskId: "task-a", path: "/worktrees/task-a", ok: true, removed: true }],
				retainedPaths: ["/state/project-1", "/projects/project-1"],
			}),
		);

		await renderPermanentProjectDataDeletionDialogForTest({
			onGetPermanentDeletionPreview,
			onPermanentlyDeleteProjectData,
		});
		await enterExactConfirmationProjectNameAndSubmitDeletion();

		expect(onGetPermanentDeletionPreview).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("Workspace state changed after managed worktree deletion.");
		expect(document.body.textContent).toContain("/worktrees/task-a");
		expect(document.body.textContent).toContain("/state/project-1");
	});
});
