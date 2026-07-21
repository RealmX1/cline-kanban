import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixSwitch from "@radix-ui/react-switch";
import { Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { TaskSpotlightSearchResultRow } from "@/components/task-spotlight-search-result-row";
import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import type { TaskSpotlightSearchController } from "@/hooks/use-task-spotlight-search-controller";
import type { TaskBoardSearchMode } from "@/search/task-board-search";

const SEARCH_MODE_OPTIONS: ReadonlyArray<{ mode: TaskBoardSearchMode; label: string }> = [
	{ mode: "direct", label: "Direct" },
	{ mode: "fuzzy", label: "Fuzzy" },
	{ mode: "semantic", label: "Semantic" },
	{ mode: "hybrid", label: "Hybrid" },
];

export function TaskSpotlightSearchDialog({
	controller,
}: {
	controller: TaskSpotlightSearchController;
}): React.ReactElement {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const virtuosoRef = useRef<VirtuosoHandle | null>(null);
	const {
		isOpen,
		close,
		query,
		setQuery,
		mode,
		setMode,
		stageOptions,
		toggleStage,
		includeOtherProjects,
		setIncludeOtherProjects,
		crossProjectStatus,
		isSearchActive,
		semanticSearchStatus,
		results,
		activeIndex,
		setActiveIndex,
		moveActive,
		openActiveResult,
		openResultAt,
		currentProjectId,
	} = controller;

	const showSemanticSpinner = semanticSearchStatus === "loading" && (mode === "hybrid" || mode === "semantic");

	useEffect(() => {
		if (!isOpen || activeIndex < 0) {
			return;
		}
		virtuosoRef.current?.scrollIntoView({ index: activeIndex });
	}, [isOpen, activeIndex]);

	const focusInput = () => {
		window.requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
	};

	const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveActive(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveActive(-1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			openActiveResult();
		}
	};

	return (
		<RadixDialog.Root
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) {
					close();
				}
			}}
		>
			<RadixDialog.Portal>
				<RadixDialog.Overlay
					className="fixed inset-0 z-50 bg-black/60"
					style={{ animation: "kb-overlay-show 150ms ease" }}
				/>
				<RadixDialog.Content
					data-task-spotlight-search-dialog=""
					aria-describedby={undefined}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						inputRef.current?.focus();
					}}
					className="fixed left-1/2 top-[12vh] z-50 flex h-[min(70vh,640px)] w-[92vw] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border-bright bg-surface-1 shadow-2xl focus:outline-none"
				>
					<RadixDialog.Title className="sr-only">Search tasks</RadixDialog.Title>

					<div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
						<Search size={16} className="pointer-events-none shrink-0 text-text-tertiary" />
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							onKeyDown={handleInputKeyDown}
							placeholder="Search tasks"
							aria-label="Search tasks"
							className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
						/>
						{showSemanticSpinner ? <Spinner size={14} /> : null}
						{isSearchActive ? (
							<span className="shrink-0 text-xs text-text-tertiary">{results.length}</span>
						) : null}
					</div>

					<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-2">
						<div className="flex flex-wrap items-center gap-1">
							{stageOptions.map((stage) => (
								<button
									key={stage.columnId}
									type="button"
									aria-pressed={stage.isSelected}
									onClick={() => {
										toggleStage(stage.columnId);
										focusInput();
									}}
									className={cn(
										"h-6 rounded-md border px-2 text-xs font-medium",
										stage.isSelected
											? "border-border-bright bg-surface-3 text-text-primary"
											: "border-border bg-surface-1 text-text-tertiary hover:text-text-secondary",
									)}
								>
									{stage.label}
								</button>
							))}
						</div>

						<label
							htmlFor="task-spotlight-include-other-projects"
							className="ml-auto flex cursor-pointer select-none items-center gap-1.5 text-xs text-text-secondary"
						>
							<RadixSwitch.Root
								id="task-spotlight-include-other-projects"
								checked={includeOtherProjects}
								onCheckedChange={(checked) => {
									setIncludeOtherProjects(checked);
									focusInput();
								}}
								className="relative h-4 w-7 rounded-full bg-surface-4 outline-none data-[state=checked]:bg-accent"
							>
								<RadixSwitch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-3.5" />
							</RadixSwitch.Root>
							<span>All projects</span>
							{includeOtherProjects && crossProjectStatus === "loading" ? <Spinner size={12} /> : null}
							{includeOtherProjects && crossProjectStatus === "error" ? (
								<span className="text-status-red">failed</span>
							) : null}
						</label>

						<div className="inline-flex h-6 items-center rounded-md border border-border bg-surface-1 p-0.5">
							{SEARCH_MODE_OPTIONS.map((option) => (
								<button
									key={option.mode}
									type="button"
									aria-pressed={option.mode === mode}
									onClick={() => {
										setMode(option.mode);
										focusInput();
									}}
									className={cn(
										"h-5 rounded-sm px-2 text-[11px] font-medium text-text-secondary hover:text-text-primary",
										option.mode === mode && "bg-surface-4 text-text-primary",
									)}
								>
									{option.label}
								</button>
							))}
						</div>
					</div>

					<div className="min-h-0 flex-1">
						{!isSearchActive ? (
							<div className="flex h-full min-h-[120px] items-center justify-center px-4 py-8 text-center text-xs text-text-tertiary">
								Type to search tasks by name or prompt
							</div>
						) : results.length === 0 ? (
							<div className="flex h-full min-h-[120px] items-center justify-center px-4 py-8 text-center text-xs text-text-tertiary">
								{semanticSearchStatus === "loading" ? "Searching…" : "No matching tasks"}
							</div>
						) : (
							<Virtuoso
								ref={virtuosoRef}
								style={{ height: "100%" }}
								className="min-h-[120px]"
								data={results}
								computeItemKey={(_, result) => `${result.document.projectId}:${result.document.taskId}`}
								itemContent={(index, result) => (
									<div className="px-1.5 first:pt-1.5">
										<TaskSpotlightSearchResultRow
											result={result}
											isActive={index === activeIndex}
											isCrossProject={result.document.projectId !== currentProjectId}
											onSelect={() => openResultAt(index)}
											onHover={() => setActiveIndex(index)}
										/>
									</div>
								)}
							/>
						)}
					</div>

					<div className="flex shrink-0 items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-text-tertiary">
						<span className="flex items-center gap-1">
							<Kbd>↑</Kbd>
							<Kbd>↓</Kbd>
							<span>navigate</span>
						</span>
						<span className="flex items-center gap-1">
							<Kbd>↵</Kbd>
							<span>open</span>
						</span>
						<span className="flex items-center gap-1">
							<Kbd>esc</Kbd>
							<span>close</span>
						</span>
					</div>
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}
