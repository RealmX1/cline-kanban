import { useId } from "react";
import type { resolveCodexTaskReasoningEffortSelection } from "@/hooks/codex-task-reasoning-effort-selection";

export function CodexTaskReasoningEffortSelect({
	value,
	onChange,
	selection,
	onRetry,
	scope = "task_local",
}: {
	value: string | undefined;
	onChange: (value: string | undefined) => void;
	selection: ReturnType<typeof resolveCodexTaskReasoningEffortSelection>;
	onRetry: () => void;
	scope?: "task_local" | "profile_default";
}) {
	const id = useId();
	return (
		<div className="mt-3 space-y-1" data-verification-anchor="codex-task-reasoning-effort-select">
			<label htmlFor={id} className="block text-xs text-text-secondary">
				推理强度
			</label>
			<select
				id={id}
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value || undefined)}
				aria-invalid={Boolean(selection.validationError)}
				aria-describedby={`${id}-description`}
				className="min-h-9 w-full rounded border border-border bg-surface-2 px-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
			>
				<option value="">
					{scope === "profile_default" ? "沿用原生默认" : "沿用 Codex 配置"}
					{selection.inheritedEffort ? `（${selection.inheritedEffort}）` : ""}
				</option>
				{value && !selection.options.some((option) => option.effort === value) && (
					<option value={value}>{value}（保留原选择）</option>
				)}
				{selection.options.map((option) => (
					<option key={option.effort} value={option.effort}>
						{option.effort}
					</option>
				))}
			</select>
			<p id={`${id}-description`} className="m-0 text-xs text-text-secondary">
				{scope === "profile_default"
					? "保存后更新所属配置默认，并同步到此配置的会话。"
					: "手选值仅用于当前任务。启动成功后可在配置提醒中反馈到所属配置。"}
			</p>
			{selection.recoveryMessage && (
				<p role="status" className="text-xs text-text-secondary">
					{selection.recoveryMessage}{" "}
					<button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-text-primary">
						重新读取目录
					</button>
				</p>
			)}
		</div>
	);
}
