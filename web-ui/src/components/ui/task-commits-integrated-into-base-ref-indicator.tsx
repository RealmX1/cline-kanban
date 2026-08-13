import { GitCommitHorizontal } from "lucide-react";

import { cn } from "@/components/ui/cn";

export function TaskCommitsIntegratedIntoBaseRefIndicator({
	taskCommitsIntegratedIntoBaseRef,
}: {
	taskCommitsIntegratedIntoBaseRef: number | null;
}) {
	const hasEvidenceBackedCount = taskCommitsIntegratedIntoBaseRef !== null;
	return (
		<span
			data-task-commits-integrated-into-base-ref=""
			className={cn(
				"inline-flex items-center gap-0.5",
				hasEvidenceBackedCount ? "text-status-green" : "text-text-tertiary",
			)}
		>
			<GitCommitHorizontal size={10} aria-hidden="true" />
			<span>{taskCommitsIntegratedIntoBaseRef ?? "?"}</span>
		</span>
	);
}
