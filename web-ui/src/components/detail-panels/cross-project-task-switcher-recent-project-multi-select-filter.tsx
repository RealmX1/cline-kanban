import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { CrossProjectRecentlyActiveTaskSwitcherSectionsModel } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";

/** 项目多选保留在共享模型；搜索和弹层开关只属于当前呈现面。空项目选择表示全部项目。 */
export function CrossProjectTaskSwitcherRecentProjectMultiSelectFilter({
	projectOptions,
	selectedProjectWorkspaceIds,
	onSelectedProjectWorkspaceIdsChange,
}: {
	projectOptions: CrossProjectRecentlyActiveTaskSwitcherSectionsModel["recentProjectFilterOptions"];
	selectedProjectWorkspaceIds: readonly string[];
	onSelectedProjectWorkspaceIdsChange: (workspaceIds: readonly string[]) => void;
}) {
	const [projectSearchText, setProjectSearchText] = useState("");
	const normalizedSearchText = projectSearchText.trim().toLocaleLowerCase();
	const matchingProjects = projectOptions.filter((project) =>
		`${project.projectName} ${project.projectPath}`.toLocaleLowerCase().includes(normalizedSearchText),
	);
	return (
		<Popover.Root onOpenChange={() => setProjectSearchText("")}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label="Filter recent tasks by project"
					className="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md border border-border-bright bg-surface-2 px-2 text-xs text-text-primary hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
				>
					<span className="truncate">
						{selectedProjectWorkspaceIds.length === 0
							? "Projects: All"
							: `Projects: ${selectedProjectWorkspaceIds.length}`}
					</span>
					<ChevronDown size={12} aria-hidden className="shrink-0" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={5}
					collisionPadding={8}
					aria-label="Choose projects for recent tasks"
					className="z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-border bg-surface-2 p-2 text-xs text-text-primary"
				>
					<input
						type="search"
						aria-label="Search projects for recent tasks"
						placeholder="Search projects"
						value={projectSearchText}
						onChange={(event) => setProjectSearchText(event.target.value)}
						className="h-8 w-full rounded-md border border-border bg-surface-1 px-2 text-text-primary placeholder:text-text-secondary focus-visible:outline-2 focus-visible:outline-accent"
					/>
					<label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 hover:bg-surface-3">
						<input
							type="checkbox"
							checked={selectedProjectWorkspaceIds.length === 0}
							onChange={() => onSelectedProjectWorkspaceIdsChange([])}
							className="accent-accent"
						/>
						All projects
					</label>
					<div className="max-h-60 overflow-y-auto border-t border-border pt-1">
						{matchingProjects.map((project) => {
							const isSelected = selectedProjectWorkspaceIds.includes(project.workspaceId);
							return (
								<label
									key={project.workspaceId}
									title={project.projectPath}
									className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-2 hover:bg-surface-3"
								>
									<input
										type="checkbox"
										checked={isSelected}
										onChange={() =>
											onSelectedProjectWorkspaceIdsChange(
												isSelected
													? selectedProjectWorkspaceIds.filter(
															(workspaceId) => workspaceId !== project.workspaceId,
														)
													: [...selectedProjectWorkspaceIds, project.workspaceId],
											)
										}
										className="shrink-0 accent-accent"
									/>
									<span className="flex min-w-0 flex-col gap-1">
										<span className="truncate">{project.projectName}</span>
										<span className="truncate text-[10px] text-text-secondary">{project.projectPath}</span>
									</span>
								</label>
							);
						})}
						{matchingProjects.length === 0 ? (
							<p className="m-0 px-1 py-2 text-text-secondary">No matching projects.</p>
						) : null}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
