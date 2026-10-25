import { createRoot } from "react-dom/client";
import { DailyWorkProgressExpandedRegion, DailyWorkProgressSummaryButton } from "@/components/daily-work-progress-statistics";
import { TopBar } from "@/components/top-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDailyWorkProgressStatistics } from "@/hooks/use-daily-work-progress-statistics";
import { observeDailyWorkProgressStatisticsUpdated } from "@/runtime/daily-work-progress-statistics-invalidation-events";
import "@/styles/globals.css";

window.addEventListener("daily-work-progress-browser-test-update", (event) => {
	observeDailyWorkProgressStatisticsUpdated((event as CustomEvent<{ quiet?: boolean }>).detail?.quiet);
});
function Harness() {
	const progress = useDailyWorkProgressStatistics();
	return <TooltipProvider><div className="flex h-screen min-w-0 flex-col bg-surface-0 text-text-primary">
		<TopBar openTargetOptions={[]} selectedOpenTargetId="vscode" onSelectOpenTarget={() => {}} onOpenWorkspace={() => {}} canOpenWorkspace={false} isOpeningWorkspace={false} shortcuts={[]} onRunShortcut={() => {}} dailyWorkProgressSummaryControl={<DailyWorkProgressSummaryButton progress={progress} />} />
		<main className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
			<DailyWorkProgressExpandedRegion progress={progress} onOpenTask={(workspaceId, taskId) => { document.body.dataset.openedTask = workspaceId + ":" + taskId; }} />
			<h1 className="text-sm font-semibold">任务工作区</h1>
			<textarea aria-label="正在编辑的任务指令" className="h-28 rounded border border-border bg-surface-1 p-3 text-sm text-text-primary focus:outline-accent" placeholder="继续当前任务…" />
			<p className="text-xs text-text-secondary">庆祝展开时，任务输入和导航保持可用。</p>
		</main>
	</div></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
