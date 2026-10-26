import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { useExpandedForegroundViewNavigation } from "@/expanded-foreground-view/expanded-foreground-view-context";
import {
	type FocusViewDesktopPanelArrangementPreference,
	selectTaskWorkbenchModuleInSlot,
	TASK_WORKBENCH_MODULE_LABELS,
	type TaskWorkbenchModule,
	type TaskWorkbenchModuleSlots,
} from "@/resize/focus-view-desktop-panel-arrangement";
import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { ResizeHandle } from "@/resize/resize-handle";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

const DEFAULT_SLOTS: TaskWorkbenchModuleSlots = ["task_sessions", "prompt_tools"];
function loadModuleSlots<Module extends string>(
	moduleLabels: Record<Module, string>,
	defaultSlots: readonly [Module, Module],
	storageKey: LocalStorageKey,
): readonly [Module, Module] {
	const availableModules = Object.keys(moduleLabels);
	try {
		const stored: unknown = JSON.parse(readLocalStorageItem(storageKey) ?? "null");
		if (
			Array.isArray(stored) &&
			stored.length === 2 &&
			stored[0] !== stored[1] &&
			stored.every((entry) => availableModules.includes(entry))
		)
			return stored as [Module, Module];
	} catch {
		/* 损坏的布局偏好回到默认格位。 */
	}
	return defaultSlots;
}

export function TaskWorkbench<Module extends string = TaskWorkbenchModule>({
	moduleLabels = TASK_WORKBENCH_MODULE_LABELS as unknown as Record<Module, string>,
	defaultSlots = DEFAULT_SLOTS as unknown as readonly [Module, Module],
	moduleSlotsStorageKey = LocalStorageKey.TaskWorkbenchModuleSlots,
	workbenchTitle = "任务工作台",
	moduleSelectionRequest,
	moduleSelectionResetKey,
	onModuleSelectionChange,
	modules,
	isBelowAgent,
	arrangementPreference,
	onArrangementPreferenceChange,
	slotRatio,
	onSlotRatioChange,
	queueNotice,
	queueAnnouncement,
	onOpenQueue,
	mobileModuleLayout,
}: {
	modules: Record<Module, ReactNode>;
	moduleLabels?: Record<Module, string>;
	defaultSlots?: readonly [Module, Module];
	moduleSlotsStorageKey?: LocalStorageKey;
	workbenchTitle?: string;
	moduleSelectionRequest?: { slot: 0 | 1; module: Module; requestKey: number; persistSelection?: boolean };
	onModuleSelectionChange?: (module: Module) => void;
	moduleSelectionResetKey?: string;
	isBelowAgent: boolean;
	arrangementPreference: FocusViewDesktopPanelArrangementPreference;
	onArrangementPreferenceChange: (value: FocusViewDesktopPanelArrangementPreference) => void;
	slotRatio: number;
	onSlotRatioChange: (value: number) => void;
	queueNotice?: ReactNode;
	queueAnnouncement?: string | null;
	onOpenQueue?: () => void;
	mobileModuleLayout?: { visibleModules: readonly Module[]; heightFillingModule: Module | null };
}) {
	const isMobileModuleLayout = mobileModuleLayout !== undefined;
	const availableModules = Object.keys(moduleLabels) as Module[];
	const foregroundView = useExpandedForegroundViewNavigation();
	const foregroundModule = foregroundView?.ownerSurfaceId
		? (
				{
					task_visualization: "task_visualizations",
					task_relations: "cross_task_relations",
					exploration_thread_graph: "exploration_map",
				} as const
			)[foregroundView.target?.viewKind ?? "task_visualization"]
		: null;
	const [slots, setSlots] = useState(() => loadModuleSlots(moduleLabels, defaultSlots, moduleSlotsStorageKey));
	useEffect(() => {
		if (moduleSelectionResetKey !== undefined)
			setSlots(loadModuleSlots(moduleLabels, defaultSlots, moduleSlotsStorageKey));
	}, [moduleSelectionResetKey, moduleLabels, defaultSlots, moduleSlotsStorageKey]);
	const rootRef = useRef<HTMLDivElement>(null);
	const slotAwaitingKeyboardFocus = useRef<number | null>(null);
	useEffect(() => {
		if (slotAwaitingKeyboardFocus.current === null) return;
		rootRef.current
			?.querySelector<HTMLSelectElement>(`[aria-label="工作台格位 ${slotAwaitingKeyboardFocus.current + 1}"]`)
			?.focus();
		slotAwaitingKeyboardFocus.current = null;
	}, [slots]);
	const { startDrag } = useResizeDrag();
	const requestedSlot = moduleSelectionRequest?.slot;
	const requestedModule = moduleSelectionRequest?.module;
	const requestKey = moduleSelectionRequest?.requestKey;
	const persistRequestedSelection = moduleSelectionRequest?.persistSelection !== false;
	useEffect(() => {
		if (!requestKey || requestedSlot === undefined || !requestedModule) return;
		setSlots((current) => {
			const next = selectTaskWorkbenchModuleInSlot(current, requestedSlot, requestedModule);
			if (persistRequestedSelection) writeLocalStorageItem(moduleSlotsStorageKey, JSON.stringify(next));
			return next;
		});
	}, [requestedSlot, requestedModule, requestKey, moduleSlotsStorageKey, persistRequestedSelection]);
	useLayoutResetEffect(() => setSlots(defaultSlots));
	const selectModule = (slot: 0 | 1, module: Module) => {
		onModuleSelectionChange?.(module);
		slotAwaitingKeyboardFocus.current = slot;
		setSlots((current) => {
			const next = selectTaskWorkbenchModuleInSlot(current, slot, module);
			writeLocalStorageItem(moduleSlotsStorageKey, JSON.stringify(next));
			return next;
		});
	};
	return (
		<section
			aria-label={workbenchTitle}
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-1"
		>
			<div
				className={cn(
					"min-h-8 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-xs",
					isMobileModuleLayout ? "hidden" : "flex",
				)}
			>
				<span className="font-medium">{workbenchTitle}</span>
				<span className="sr-only" role="status" aria-live="polite">
					{queueAnnouncement ?? ""}
				</span>
				{queueNotice ? (
					<button
						type="button"
						className="text-status-orange"
						onClick={() => {
							const promptModule = availableModules.find((module) => module === "prompt_tools");
							if (promptModule) selectModule(1, promptModule);
							onOpenQueue?.();
						}}
					>
						{queueNotice}
					</button>
				) : null}
				<label className="ml-auto flex items-center gap-1 text-text-secondary">
					布局
					<select
						aria-label="任务专注视图布局"
						className="h-6 rounded-sm bg-surface-2 px-1 text-text-primary"
						value={arrangementPreference}
						onChange={(event) =>
							onArrangementPreferenceChange(event.target.value as FocusViewDesktopPanelArrangementPreference)
						}
					>
						<option value="automatic">自动</option>
						<option value="agent_left_workbench_right">左右</option>
						<option value="agent_above_workbench_below">上下</option>
					</select>
				</label>
			</div>
			<div
				ref={rootRef}
				data-task-workbench-slots=""
				className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", isMobileModuleLayout ? "flex flex-col" : "grid")}
				style={
					isMobileModuleLayout
						? undefined
						: isBelowAgent
							? {
									gridTemplateColumns: `minmax(0, ${slotRatio}fr) 1px minmax(0, ${1 - slotRatio}fr)`,
									gridTemplateAreas: '"first divider second"',
								}
							: {
									gridTemplateRows: `minmax(0, ${slotRatio}fr) 1px minmax(0, ${1 - slotRatio}fr)`,
									gridTemplateAreas: '"first" "divider" "second"',
								}
				}
			>
				{availableModules.map((module) => {
					const slot = slots.indexOf(module);
					const isModuleVisible = mobileModuleLayout
						? mobileModuleLayout.visibleModules.includes(module)
						: slot !== -1 || module === foregroundModule;
					return (
						<div
							key={module}
							hidden={!isModuleVisible}
							data-task-workbench-module={module}
							className={cn(
								"min-h-0 min-w-0 overflow-hidden",
								isModuleVisible && "flex flex-col",
								isMobileModuleLayout &&
									(module === mobileModuleLayout.heightFillingModule ? "flex-1" : "shrink-0"),
							)}
							style={{
								gridArea: slot === 0 ? "first" : "second",
								order: mobileModuleLayout?.visibleModules.indexOf(module),
								display: isModuleVisible ? undefined : "none",
							}}
						>
							<div
								className={cn(
									"h-8 shrink-0 items-center border-b border-border px-2",
									isMobileModuleLayout ? "hidden" : "flex",
								)}
							>
								<select
									aria-label={`工作台格位 ${slot + 1}`}
									className="h-6 max-w-full rounded-sm bg-surface-2 px-1 text-xs text-text-primary"
									value={module}
									onChange={(event) => selectModule(slot as 0 | 1, event.target.value as Module)}
								>
									{availableModules.map((option) => (
										<option key={option} value={option}>
											{moduleLabels[option]}
										</option>
									))}
								</select>
							</div>
							<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
								{modules[module] ?? (
									<p className="p-3 text-xs text-text-secondary">
										此任务暂无可用的{moduleLabels[module]}内容。
									</p>
								)}
							</div>
						</div>
					);
				})}
				<ResizeHandle
					orientation={isBelowAgent ? "vertical" : "horizontal"}
					ariaLabel="调整任务工作台格位大小"
					className={cn("z-10", isMobileModuleLayout && "hidden")}
					style={{ gridArea: "divider" }}
					tabIndex={0}
					ariaValueNow={Math.round(slotRatio * 100)}
					ariaValueMin={15}
					ariaValueMax={85}
					onKeyDown={(event) => {
						if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
							event.preventDefault();
							onSlotRatioChange(slotRatio + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.05 : 0.05));
						}
					}}
					onMouseDown={(event) => {
						const size = isBelowAgent ? rootRef.current?.offsetWidth : rootRef.current?.offsetHeight;
						if (!size) return;
						const start = isBelowAgent ? event.clientX : event.clientY;
						const apply = (position: number) => onSlotRatioChange(slotRatio + (position - start) / size);
						startDrag(event, {
							axis: isBelowAgent ? "x" : "y",
							cursor: isBelowAgent ? "ew-resize" : "ns-resize",
							onMove: apply,
							onEnd: apply,
						});
					}}
				/>
			</div>
		</section>
	);
}
