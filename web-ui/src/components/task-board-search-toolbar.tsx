import { Search, X } from "lucide-react";
import type { ChangeEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { TaskBoardSearchMode } from "@/search/task-board-search";
import type { TaskBoardSemanticSearchStatus } from "@/search/use-task-board-search";

const SEARCH_MODES: Array<{ mode: TaskBoardSearchMode; label: string }> = [
	{ mode: "hybrid", label: "Hybrid" },
	{ mode: "fuzzy", label: "Fuzzy" },
	{ mode: "semantic", label: "Semantic" },
];

export function TaskBoardSearchToolbar({
	query,
	mode,
	visibleTaskCount,
	totalTaskCount,
	semanticSearchStatus,
	onQueryChange,
	onModeChange,
}: {
	query: string;
	mode: TaskBoardSearchMode;
	visibleTaskCount: number;
	totalTaskCount: number;
	semanticSearchStatus: TaskBoardSemanticSearchStatus;
	onQueryChange: (query: string) => void;
	onModeChange: (mode: TaskBoardSearchMode) => void;
}): React.ReactElement {
	const isSearchActive = query.trim().length > 0;
	const showSemanticSpinner = semanticSearchStatus === "loading" && (mode === "hybrid" || mode === "semantic");

	const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
		onQueryChange(event.currentTarget.value);
	};

	return (
		<div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-divider bg-surface-0 px-3 py-2">
			<div className="relative flex min-w-[220px] flex-1 items-center">
				<Search size={14} className="pointer-events-none absolute left-2.5 text-text-tertiary" />
				<input
					type="search"
					value={query}
					onChange={handleInputChange}
					placeholder="Search tasks"
					aria-label="Search tasks"
					className="h-8 w-full rounded-md border border-border bg-surface-2 pl-8 pr-8 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
				/>
				{query.length > 0 ? (
					<Button
						variant="ghost"
						size="xs"
						icon={<X size={12} />}
						className="absolute right-1 top-1.5"
						aria-label="Clear task search"
						onClick={() => onQueryChange("")}
					/>
				) : null}
			</div>
			<div className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-surface-2 p-0.5">
				{SEARCH_MODES.map((item) => {
					const isActive = item.mode === mode;
					return (
						<button
							key={item.mode}
							type="button"
							className={cn(
								"h-6 rounded-sm px-2 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary",
								isActive && "bg-surface-4 text-text-primary",
							)}
							aria-pressed={isActive}
							onClick={() => onModeChange(item.mode)}
						>
							{item.label}
						</button>
					);
				})}
			</div>
			<div className="flex h-8 min-w-[68px] shrink-0 items-center justify-end gap-1.5 text-xs text-text-secondary">
				{showSemanticSpinner ? <Spinner size={12} /> : null}
				{isSearchActive ? (
					<span>
						{visibleTaskCount}/{totalTaskCount}
					</span>
				) : null}
			</div>
		</div>
	);
}
