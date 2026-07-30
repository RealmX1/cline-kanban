import { Bug } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";

import { BugReportDialog } from "@/components/bug-report/bug-report-dialog";
import { capturePageScreenshotAsTaskImage } from "@/components/bug-report/capture-page-screenshot";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useClineKanbanDevProject } from "@/hooks/use-cline-kanban-dev-project";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { TaskImage } from "@/types";

export interface BugReportFabProps {
	projects: RuntimeProjectSummary[];
	currentProjectId: string | null;
	/** Short label of what the user is currently looking at (e.g. a task id or "board"). */
	activeView: string;
}

/**
 * Always-visible red pill button pinned to the bottom-right corner that opens the
 * comprehensive bug-report dialog. The sonner Toaster is offset upward (see main.tsx) so
 * toasts stack above this button instead of colliding with it.
 *
 * On mobile it collapses to an icon-only circle and rides above the terminal's virtual key
 * bar (via `.kb-viewport-bottom-pill-primary`): a full-width labelled pill parked at the
 * viewport bottom sits right on top of the arrow keys and Enter, which is exactly where the
 * user's thumb needs to be while answering an agent prompt.
 *
 * The page screenshot is captured HERE, before the dialog mounts, so the shot shows the
 * clean app instead of the dialog's own dimming overlay.
 */
export function BugReportFab({ projects, currentProjectId, activeView }: BugReportFabProps): ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [isCapturing, setIsCapturing] = useState(false);
	const [initialScreenshot, setInitialScreenshot] = useState<TaskImage | null>(null);
	const devProject = useClineKanbanDevProject(projects);
	const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
	const isMobile = useIsMobile();

	const handleOpen = useCallback(async () => {
		setIsCapturing(true);
		const image = await capturePageScreenshotAsTaskImage();
		setInitialScreenshot(image);
		setIsCapturing(false);
		setIsOpen(true);
	}, []);

	return (
		<>
			<button
				type="button"
				onClick={() => void handleOpen()}
				disabled={isCapturing}
				aria-label="Report a bug"
				className={cn(
					"kb-viewport-bottom-pill-primary fixed right-4 z-40 inline-flex cursor-pointer items-center gap-2 rounded-full border-none bg-status-red text-sm font-semibold text-white shadow-lg transition-colors hover:bg-status-red/90 active:bg-status-red/80 disabled:cursor-default disabled:opacity-80",
					isMobile ? "p-2.5" : "px-4 py-2.5",
				)}
			>
				{isCapturing ? <Spinner size={16} /> : <Bug size={16} />}
				{isMobile ? null : "Report bug"}
			</button>
			<BugReportDialog
				open={isOpen}
				onOpenChange={setIsOpen}
				devProject={devProject}
				currentProject={currentProject}
				activeView={activeView}
				initialScreenshot={initialScreenshot}
			/>
		</>
	);
}
