import * as RadixSwitch from "@radix-ui/react-switch";
import { Bug } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	buildBugReportBody,
	buildGitHubIssueUrl,
	collectBugReportDiagnostics,
	deriveBugReportTitle,
} from "@/components/bug-report/build-bug-report-content";
import { collectImageFilesFromDataTransfer, fileToTaskImage } from "@/components/task-image-input-utils";
import { TaskImageStrip } from "@/components/task-image-strip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { KANBAN_FORK_GITHUB_ISSUES_URL } from "@/config/issue-reporting-urls";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { TaskImage } from "@/types";

export interface BugReportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The detected cline-kanban developer project (git origin === realmx1/cline-kanban), or null. */
	devProject: RuntimeProjectSummary | null;
	/** The currently-viewed project, for diagnostic context. */
	currentProject: RuntimeProjectSummary | null;
	/** Short label of what the user is looking at (e.g. a task id or "board"). */
	activeView: string;
	/** Clean-page screenshot captured by the FAB before this dialog mounted, or null on failure. */
	initialScreenshot: TaskImage | null;
}

export function BugReportDialog({
	open,
	onOpenChange,
	devProject,
	currentProject,
	activeView,
	initialScreenshot,
}: BugReportDialogProps): ReactElement {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [images, setImages] = useState<TaskImage[]>([]);
	const [autoCreateTask, setAutoCreateTask] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const autoTaskSwitchId = useId();

	const canAutoCreateTask = devProject !== null && autoCreateTask;

	// On open: reset fields and seed the attachment strip with the FAB-captured screenshot.
	useEffect(() => {
		if (!open) {
			return;
		}
		setTitle("");
		setDescription("");
		setImages(initialScreenshot ? [initialScreenshot] : []);
		setAutoCreateTask(true);
		setIsSubmitting(false);
	}, [open, initialScreenshot]);

	const handlePaste = useCallback((event: React.ClipboardEvent) => {
		const files = collectImageFilesFromDataTransfer(event.clipboardData);
		if (files.length === 0) {
			return;
		}
		event.preventDefault();
		void Promise.all(files.map((file) => fileToTaskImage(file))).then((results) => {
			const added = results.filter((image): image is TaskImage => image !== null);
			if (added.length > 0) {
				setImages((current) => [...current, ...added]);
			}
		});
	}, []);

	const handleRemoveImage = useCallback((imageId: string) => {
		setImages((current) => current.filter((image) => image.id !== imageId));
	}, []);

	const handleSubmit = useCallback(async () => {
		const diagnostics = collectBugReportDiagnostics({
			currentProjectName: currentProject?.name ?? null,
			currentProjectPath: currentProject?.path ?? null,
			activeView,
			appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null,
			capturedAtIso: new Date().toISOString(),
		});
		const resolvedTitle = deriveBugReportTitle(title, description);

		setIsSubmitting(true);
		try {
			if (devProject && autoCreateTask) {
				const body = buildBugReportBody({
					title: resolvedTitle,
					description,
					diagnostics,
					hasScreenshot: images.length > 0,
					forGitHubIssue: false,
				});
				const client = getRuntimeTrpcClient(devProject.id);
				await client.workspace.addBacklogTask.mutate({
					prompt: body,
					title: resolvedTitle,
					images: images.length > 0 ? images : undefined,
				});
				showAppToast({
					intent: "success",
					message: `Bug report filed to ${devProject.name} backlog.`,
					timeout: 5000,
				});
				onOpenChange(false);
				return;
			}

			// Fallback: open a prefilled GitHub issue on the fork. Inline image attachments can't
			// ride a URL, so the body tells the reporter to paste the screenshot manually.
			const body = buildBugReportBody({
				title: resolvedTitle,
				description,
				diagnostics,
				hasScreenshot: images.length > 0,
				forGitHubIssue: true,
			});
			window.open(buildGitHubIssueUrl(KANBAN_FORK_GITHUB_ISSUES_URL, resolvedTitle, body), "_blank");
			onOpenChange(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({ intent: "danger", icon: "warning-sign", message, timeout: 7000 });
		} finally {
			setIsSubmitting(false);
		}
	}, [activeView, autoCreateTask, currentProject, description, devProject, images, onOpenChange, title]);

	const submitLabel = canAutoCreateTask ? "Create bug task" : "Open GitHub issue";

	return (
		<Dialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen && isSubmitting) {
					return;
				}
				onOpenChange(isOpen);
			}}
			contentClassName="max-w-lg"
			contentAriaDescribedBy="bug-report-dialog-description"
		>
			<DialogHeader title="Report a bug" icon={<Bug size={16} />} />
			<DialogBody className="flex flex-col gap-4">
				<p id="bug-report-dialog-description" className="sr-only">
					Report a bug with an automatic screenshot and diagnostic context.
				</p>

				<div>
					<label htmlFor="bug-report-title" className="mb-1.5 block text-[12px] text-text-secondary">
						Title <span className="text-text-tertiary">(optional)</span>
					</label>
					<input
						id="bug-report-title"
						type="text"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						placeholder="Short summary — derived from description if left blank"
						className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
					/>
				</div>

				<div>
					<label htmlFor="bug-report-description" className="mb-1.5 block text-[12px] text-text-secondary">
						What went wrong?
					</label>
					<textarea
						id="bug-report-description"
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						onPaste={handlePaste}
						rows={6}
						placeholder={"复现步骤 / 期望结果 / 实际结果。\n可直接粘贴图片作为附件。"}
						className="w-full resize-y rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
					/>
				</div>

				<div>
					<div className="mb-1.5 text-[12px] text-text-secondary">Attachments</div>
					{images.length > 0 ? (
						<TaskImageStrip images={images} onRemoveImage={handleRemoveImage} />
					) : (
						<p className="text-[12px] text-text-tertiary">
							No attachments. Paste an image to attach it (page screenshot is added automatically when
							available).
						</p>
					)}
				</div>
			</DialogBody>
			<DialogFooter>
				<label
					htmlFor={autoTaskSwitchId}
					className={`mr-auto flex items-center gap-2 text-[12px] ${
						devProject ? "cursor-pointer text-text-primary" : "cursor-not-allowed text-text-tertiary"
					} select-none`}
					title={
						devProject
							? `Files the bug straight to the ${devProject.name} board`
							: "No cline-kanban developer project detected — will open a GitHub issue instead"
					}
				>
					<RadixSwitch.Root
						id={autoTaskSwitchId}
						checked={canAutoCreateTask}
						onCheckedChange={setAutoCreateTask}
						disabled={devProject === null}
						className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent disabled:opacity-50"
					>
						<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
					</RadixSwitch.Root>
					<span>Create cline-kanban task</span>
				</label>
				<Button variant="default" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
					Cancel
				</Button>
				<Button variant="primary" onClick={() => void handleSubmit()} disabled={isSubmitting}>
					{isSubmitting ? (
						<>
							<Spinner size={14} />
							Submitting…
						</>
					) : (
						submitLabel
					)}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
