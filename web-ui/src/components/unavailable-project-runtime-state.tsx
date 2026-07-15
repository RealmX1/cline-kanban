import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { RuntimeProjectSummary, RuntimeProjectUnavailableReason } from "@/runtime/types";

const UNAVAILABLE_PROJECT_REASON_LABELS: Record<RuntimeProjectUnavailableReason, string> = {
	project_path_missing: "Project path does not exist",
	project_path_not_directory: "Project path is not a directory",
	project_path_access_could_not_be_verified: "Project path access could not be verified",
	git_work_tree_unavailable: "Git work tree could not be verified",
};

interface UnavailableProjectRuntimeStateProps {
	project: RuntimeProjectSummary;
	onRecheck: () => void;
}

export function UnavailableProjectRuntimeState({
	project,
	onRecheck,
}: UnavailableProjectRuntimeStateProps): React.ReactElement {
	if (project.availability.status !== "unavailable") {
		return <></>;
	}
	const taskCountItems = [
		["Backlog", project.taskCounts.backlog],
		["In Progress", project.taskCounts.in_progress],
		["Review", project.taskCounts.review],
		["Validation", project.taskCounts.validation],
		["Done", project.taskCounts.trash],
	] as const;

	return (
		<div className="flex flex-1 items-center justify-center bg-surface-0 p-6">
			<section className="flex w-full max-w-2xl flex-col gap-5 rounded-xl border border-status-orange/50 bg-surface-1 p-6 shadow-lg">
				<div className="flex items-start gap-3">
					<AlertTriangle size={22} className="mt-0.5 shrink-0 text-status-orange" />
					<div className="min-w-0">
						<h2 className="text-base font-semibold text-text-primary">Project unavailable</h2>
						<p className="mt-1 font-mono text-xs text-text-secondary break-all">{project.path}</p>
					</div>
				</div>

				<div className="rounded-lg border border-border bg-surface-2 p-4">
					<p className="text-sm text-text-primary">
						{UNAVAILABLE_PROJECT_REASON_LABELS[project.availability.reason]}
					</p>
					<p className="mt-2 text-sm font-medium text-status-green">Kanban data retained; no cleanup performed</p>
				</div>

				<div>
					<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
						Retained tasks
					</h3>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
						{taskCountItems.map(([label, count]) => (
							<div key={label} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-center">
								<div className="text-sm font-semibold text-text-primary">{count}</div>
								<div className="text-[11px] text-text-secondary">{label}</div>
								<span className="sr-only">{`${label} ${count}`}</span>
							</div>
						))}
					</div>
				</div>

				<div className="flex items-center justify-between gap-4 border-t border-border pt-4">
					<p className="text-xs text-text-secondary">
						Repair the path or Git work tree, then recheck. Kanban will not modify the project automatically.
					</p>
					<Button variant="primary" icon={<RefreshCw size={16} />} onClick={onRecheck}>
						Recheck
					</Button>
				</div>
			</section>
		</div>
	);
}
