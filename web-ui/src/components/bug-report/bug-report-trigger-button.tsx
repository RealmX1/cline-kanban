import { MessageSquareWarning } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";

import { BugReportDialog } from "@/components/bug-report/bug-report-dialog";
import { capturePageScreenshotAsTaskImage } from "@/components/bug-report/capture-page-screenshot";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useClineKanbanDevProject } from "@/hooks/use-cline-kanban-dev-project";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { TaskImage } from "@/types";

export interface BugReportTriggerButtonProps {
	projects: RuntimeProjectSummary[];
	currentProjectId: string | null;
	/** Short label of what the user is currently looking at (e.g. a task id or "board"). */
	activeView: string;
}

/** 顶栏的报告入口在对话框挂载前截图，保留当前页面的完整诊断上下文。 */
export function BugReportTriggerButton({
	projects,
	currentProjectId,
	activeView,
}: BugReportTriggerButtonProps): ReactElement {
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
			<Tooltip side="bottom" content="Report bug">
				<Button
					variant="ghost"
					size="sm"
					icon={isCapturing ? <Spinner size={16} /> : <MessageSquareWarning size={16} />}
					onClick={() => void handleOpen()}
					disabled={isCapturing}
					aria-label="Report a bug"
					aria-busy={isCapturing}
					data-testid="open-bug-report-button"
					className={cn("ml-0.5 shrink-0", isMobile && MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
				/>
			</Tooltip>
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
