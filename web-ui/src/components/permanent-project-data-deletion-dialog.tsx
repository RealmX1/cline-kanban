import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type {
	RuntimeProjectPermanentDeletionPreview,
	RuntimeProjectPermanentDeletionRequest,
	RuntimeProjectPermanentDeletionResult,
	RuntimeProjectSummary,
} from "@/runtime/types";

function getPermanentDeletionResultStatusLabel(result: RuntimeProjectPermanentDeletionResult): string {
	switch (result.status) {
		case "completed":
			return "Permanent deletion completed.";
		case "completed_with_retained_staging_directory":
			return "Project data was removed from Kanban, but a staging directory was retained.";
		case "aborted_before_project_data_deletion":
			return "Permanent deletion was aborted before project data was deleted.";
	}
}

export function PermanentProjectDataDeletionDialog({
	project,
	isPermanentDeletionPending,
	onGetPermanentDeletionPreview,
	onPermanentlyDeleteProjectData,
	onClose,
}: {
	project: RuntimeProjectSummary | null;
	isPermanentDeletionPending: boolean;
	onGetPermanentDeletionPreview: (projectId: string) => Promise<RuntimeProjectPermanentDeletionPreview | null>;
	onPermanentlyDeleteProjectData: (
		input: RuntimeProjectPermanentDeletionRequest,
	) => Promise<RuntimeProjectPermanentDeletionResult | null>;
	onClose: () => void;
}): React.ReactElement {
	const [preview, setPreview] = useState<RuntimeProjectPermanentDeletionPreview | null>(null);
	const [isPreviewLoading, setIsPreviewLoading] = useState(false);
	const [confirmationProjectName, setConfirmationProjectName] = useState("");
	const [result, setResult] = useState<RuntimeProjectPermanentDeletionResult | null>(null);
	const [previewRefreshNotice, setPreviewRefreshNotice] = useState<string | null>(null);
	const previewLoadGenerationRef = useRef(0);

	const loadPermanentDeletionPreview = useCallback(
		async (projectId: string): Promise<void> => {
			const loadGeneration = previewLoadGenerationRef.current + 1;
			previewLoadGenerationRef.current = loadGeneration;
			setIsPreviewLoading(true);
			setPreview(null);
			const nextPreview = await onGetPermanentDeletionPreview(projectId);
			if (previewLoadGenerationRef.current !== loadGeneration) {
				return;
			}
			setPreview(nextPreview);
			setIsPreviewLoading(false);
		},
		[onGetPermanentDeletionPreview],
	);

	useEffect(() => {
		previewLoadGenerationRef.current += 1;
		setPreview(null);
		setIsPreviewLoading(false);
		setConfirmationProjectName("");
		setResult(null);
		setPreviewRefreshNotice(null);
		if (project) {
			void loadPermanentDeletionPreview(project.id);
		}
	}, [loadPermanentDeletionPreview, project]);

	const canConfirmPermanentDeletion =
		preview?.deletionAllowed === true &&
		preview.workspaceStateRevision !== null &&
		confirmationProjectName === preview.requiredConfirmationProjectName &&
		!isPreviewLoading &&
		!isPermanentDeletionPending;

	const confirmPermanentDeletion = useCallback(async (): Promise<void> => {
		if (!project || !preview || preview.workspaceStateRevision === null || !canConfirmPermanentDeletion) {
			return;
		}
		const deletionResult = await onPermanentlyDeleteProjectData({
			projectId: project.id,
			expectedWorkspaceStateRevision: preview.workspaceStateRevision,
			confirmationProjectName,
		});
		if (!deletionResult) {
			return;
		}
		if (deletionResult.failureCode === "preview_stale") {
			setConfirmationProjectName("");
			setPreviewRefreshNotice(
				"The project changed after the previous preview. Review the updated impact and confirm again.",
			);
			await loadPermanentDeletionPreview(project.id);
			return;
		}
		setResult(deletionResult);
	}, [
		canConfirmPermanentDeletion,
		confirmationProjectName,
		loadPermanentDeletionPreview,
		onPermanentlyDeleteProjectData,
		preview,
		project,
	]);

	return (
		<AlertDialog
			open={project !== null}
			onOpenChange={(open) => {
				if (!open && !isPermanentDeletionPending) {
					onClose();
				}
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Permanently Delete Project Data</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription asChild>
					<div className="flex flex-col gap-3">
						{result ? (
							<PermanentDeletionResultDetails result={result} />
						) : (
							<>
								{previewRefreshNotice ? (
									<p className="rounded-md border border-status-orange/40 bg-status-orange/10 p-3 text-status-orange">
										{previewRefreshNotice}
									</p>
								) : null}
								{isPreviewLoading ? (
									<div className="flex items-center gap-2 py-4 text-text-primary">
										<Spinner size={14} /> Loading deletion impact preview...
									</div>
								) : preview ? (
									<PermanentDeletionPreviewDetails
										preview={preview}
										confirmationProjectName={confirmationProjectName}
										isPermanentDeletionPending={isPermanentDeletionPending}
										onConfirmationProjectNameChange={setConfirmationProjectName}
									/>
								) : (
									<p className="rounded-md border border-status-red/40 bg-status-red/10 p-3 text-status-red">
										The deletion impact preview could not be loaded. No cleanup was performed.
									</p>
								)}
							</>
						)}
					</div>
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				{result ? (
					<AlertDialogCancel asChild>
						<Button variant="default" autoFocus onClick={onClose}>
							Close
						</Button>
					</AlertDialogCancel>
				) : (
					<>
						<AlertDialogCancel asChild>
							<Button variant="default" autoFocus disabled={isPermanentDeletionPending} onClick={onClose}>
								Cancel
							</Button>
						</AlertDialogCancel>
						<Button variant="danger" disabled={!canConfirmPermanentDeletion} onClick={confirmPermanentDeletion}>
							{isPermanentDeletionPending ? (
								<>
									<Spinner size={14} /> Permanently deleting...
								</>
							) : (
								"Permanently Delete Project Data"
							)}
						</Button>
					</>
				)}
			</AlertDialogFooter>
		</AlertDialog>
	);
}

function PermanentDeletionPreviewDetails({
	preview,
	confirmationProjectName,
	isPermanentDeletionPending,
	onConfirmationProjectNameChange,
}: {
	preview: RuntimeProjectPermanentDeletionPreview;
	confirmationProjectName: string;
	isPermanentDeletionPending: boolean;
	onConfirmationProjectNameChange: (projectName: string) => void;
}): React.ReactElement {
	return (
		<>
			<p className="font-medium text-text-primary">{preview.projectName}</p>
			<dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 rounded-md border border-border bg-surface-2 p-3">
				<dt>Tasks</dt>
				<dd className="text-text-primary">{preview.totalTaskCount}</dd>
				<dt>Active sessions</dt>
				<dd className="text-text-primary">{preview.activeSessionCount}</dd>
				<dt>Managed worktrees</dt>
				<dd className="text-text-primary">{preview.managedWorktreeCount}</dd>
			</dl>
			<div>
				<p className="mb-1 text-text-primary">State directory</p>
				<p className="m-0 break-all rounded-md border border-border bg-surface-2 p-2 font-mono text-xs">
					{preview.workspaceStateDirectoryPath}
				</p>
			</div>
			{preview.deletionAllowed ? (
				<>
					<p className="text-text-primary">This action cannot be undone.</p>
					<label className="flex flex-col gap-1 text-text-primary">
						<span>
							Type <strong>{preview.requiredConfirmationProjectName}</strong> to confirm
						</span>
						<input
							aria-label="Confirmation project name"
							value={confirmationProjectName}
							onChange={(event) => onConfirmationProjectNameChange(event.target.value)}
							disabled={isPermanentDeletionPending}
							className="h-8 rounded-md border border-border-bright bg-surface-2 px-2 font-mono text-sm text-text-primary outline-none focus:border-focus"
						/>
					</label>
				</>
			) : (
				<div className="rounded-md border border-status-red/40 bg-status-red/10 p-3 text-status-red">
					Permanent deletion is blocked because the impact could not be fully verified:{" "}
					{preview.blockingReasons.join(", ")}.
				</div>
			)}
		</>
	);
}

function PermanentDeletionResultDetails({
	result,
}: {
	result: RuntimeProjectPermanentDeletionResult;
}): React.ReactElement {
	return (
		<>
			<p className="font-medium text-text-primary">{getPermanentDeletionResultStatusLabel(result)}</p>
			<dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 rounded-md border border-border bg-surface-2 p-3">
				<dt>Stopped sessions</dt>
				<dd className="text-text-primary">{result.stoppedSessionCount}</dd>
				<dt>Worktrees attempted</dt>
				<dd className="text-text-primary">{result.worktreeDeletionResults.length}</dd>
				<dt>Project index deleted</dt>
				<dd className="text-text-primary">{result.projectIndexDeleted ? "Yes" : "No"}</dd>
				<dt>State directory deleted</dt>
				<dd className="text-text-primary">{result.workspaceStateDirectoryDeleted ? "Yes" : "No"}</dd>
			</dl>
			{result.worktreeDeletionResults.length > 0 ? (
				<div>
					<p className="mb-1 font-medium text-text-primary">Worktree results</p>
					<ul className="m-0 list-disc space-y-1 pl-5">
						{result.worktreeDeletionResults.map((worktreeResult) => (
							<li key={worktreeResult.taskId} className="break-all">
								<div>
									{worktreeResult.taskId}:{" "}
									{worktreeResult.ok
										? worktreeResult.removed
											? "deleted"
											: "not present"
										: (worktreeResult.error ?? "failed")}
								</div>
								<div className="font-mono text-xs text-text-secondary">{worktreeResult.path}</div>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{result.failures.length > 0 ? (
				<div className="rounded-md border border-status-red/40 bg-status-red/10 p-3 text-status-red">
					<p className="mb-1 font-medium">Failures and retained data</p>
					<ul className="m-0 list-disc space-y-1 pl-5">
						{result.failures.map((failure, index) => (
							<li key={`${failure.code}-${failure.taskId ?? failure.path ?? index}`}>{failure.message}</li>
						))}
					</ul>
				</div>
			) : null}
			{result.retainedPaths.length > 0 ? (
				<div>
					<p className="mb-1 font-medium text-text-primary">Retained paths</p>
					<ul className="m-0 list-disc space-y-1 break-all pl-5 font-mono text-xs">
						{result.retainedPaths.map((retainedPath) => (
							<li key={retainedPath}>{retainedPath}</li>
						))}
					</ul>
				</div>
			) : null}
		</>
	);
}
