import { ChevronDown, ChevronUp, EyeOff, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { useTaskEditorSettingPresentationPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";

export type TaskEditorSettingPresentation = "expanded" | "collapsed_in_group" | "hidden";
export interface TaskEditorSetting {
	key: string;
	label: string;
	summary?: string;
	content: ReactNode;
}
const TaskEditorSettingPresentationContext = createContext<{
	preferences: Record<string, TaskEditorSettingPresentation>;
	setPresentation: (key: string, presentation: TaskEditorSettingPresentation) => void;
	temporarilyRevealedKeys: ReadonlySet<string>;
} | null>(null);

export function TaskEditorSettingPresentationProvider({
	children,
	temporarilyRevealedKeys,
	onUserPresentationChange,
}: {
	children: ReactNode;
	temporarilyRevealedKeys: ReadonlySet<string>;
	onUserPresentationChange?: (key: string) => void;
}) {
	const [preferences, setPresentation] = useTaskEditorSettingPresentationPreference();
	return (
		<TaskEditorSettingPresentationContext.Provider
			value={{
				preferences,
				setPresentation: (key, value) => {
					onUserPresentationChange?.(key);
					setPresentation(key, value);
				},
				temporarilyRevealedKeys,
			}}
		>
			{children}
		</TaskEditorSettingPresentationContext.Provider>
	);
}

export function TaskEditorSettingGroup({
	title,
	settings,
	className = "",
}: {
	title: string;
	settings: TaskEditorSetting[];
	className?: string;
}) {
	const context = useContext(TaskEditorSettingPresentationContext);
	if (!context) throw new Error("任务设置缺少偏好上下文");
	const presentation = (key: string) =>
		context.temporarilyRevealedKeys.has(key) ? "expanded" : (context.preferences[key] ?? "expanded");
	const visible = settings.filter((setting) => presentation(setting.key) !== "hidden");
	return (
		<section
			hidden={!visible.length}
			className={`min-w-0 space-y-3 border-t border-border pt-4 ${className}`}
			aria-label={title}
		>
			<h3 className="text-sm font-semibold text-text-primary">{title}</h3>
			{settings.map((setting) => (
				<div
					key={setting.key}
					data-task-editor-setting={setting.key}
					hidden={presentation(setting.key) !== "expanded"}
					className="min-w-0"
				>
					<div className="mb-1.5 flex items-center gap-2">
						<span className="mr-auto text-xs font-medium text-text-secondary">{setting.label}</span>
						<button
							type="button"
							aria-label={`收起${setting.label}`}
							title={`收起${setting.label}`}
							className="rounded p-1 text-text-secondary hover:bg-surface-3"
							onClick={() => context.setPresentation(setting.key, "collapsed_in_group")}
						>
							<ChevronUp size={14} />
						</button>
						<button
							type="button"
							aria-label={`隐藏${setting.label}`}
							title={`隐藏${setting.label}`}
							className="rounded p-1 text-text-secondary hover:bg-surface-3"
							onClick={() => context.setPresentation(setting.key, "hidden")}
						>
							<EyeOff size={14} />
						</button>
					</div>
					{setting.content}
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				{visible
					.filter((setting) => presentation(setting.key) === "collapsed_in_group")
					.map((setting) => (
						<button
							type="button"
							key={setting.key}
							aria-expanded={false}
							className="inline-flex max-w-full items-center gap-1 rounded-md border border-border-bright bg-surface-2 px-2 py-1 text-xs text-text-secondary hover:bg-surface-3"
							onClick={() => context.setPresentation(setting.key, "expanded")}
						>
							<ChevronDown size={13} />
							<span className="truncate">
								{setting.label}
								{setting.summary ? `：${setting.summary}` : ""}
							</span>
						</button>
					))}
			</div>
		</section>
	);
}

/** 隐藏项的恢复入口只在主滚动区末尾出现。 */
export function TaskEditorHiddenSettingsManager({
	settings,
}: {
	settings: Array<Pick<TaskEditorSetting, "key" | "label">>;
}) {
	const context = useContext(TaskEditorSettingPresentationContext);
	const [open, setOpen] = useState(false);
	if (!context) return null;
	const hidden = settings.filter((setting) => context.preferences[setting.key] === "hidden");
	return (
		<div className="mt-5 border-t border-border pt-3">
			<button
				type="button"
				aria-expanded={open}
				className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
				onClick={() => setOpen((value) => !value)}
			>
				<Settings2 size={14} />
				管理隐藏设置{hidden.length ? `（${hidden.length}）` : ""}
			</button>
			{open ? (
				<div className="mt-3 flex flex-wrap gap-2">
					{hidden.length ? (
						hidden.map((setting) => (
							<button
								type="button"
								key={setting.key}
								className="rounded-md border border-border-bright px-2 py-1 text-xs text-text-primary hover:bg-surface-3"
								onClick={() => context.setPresentation(setting.key, "expanded")}
							>
								显示{setting.label}
							</button>
						))
					) : (
						<p className="text-xs text-text-secondary">没有隐藏的设置。</p>
					)}
				</div>
			) : null}
		</div>
	);
}
