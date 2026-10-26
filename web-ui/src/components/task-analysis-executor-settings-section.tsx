import { NativeSelect } from "@/components/ui/native-select";
import type { useTaskAnalysisExecutorSettingsDraft } from "@/hooks/use-task-analysis-executor-settings-draft";

export function TaskAnalysisExecutorSettingsSection({
	draft,
	disabled,
}: {
	draft: ReturnType<typeof useTaskAnalysisExecutorSettingsDraft>;
	disabled: boolean;
}) {
	const settings = draft.settings;
	return (
		<section className="space-y-3 border-t border-border pt-4" aria-label="AI 任务分析">
			<h2 className="text-base font-semibold text-text-primary">AI 任务分析</h2>
			<p className="text-xs text-text-secondary">
				项目归属、查卡第一阶段和关系建议共用此全局配置。每次分析为允许推理的单轮结构化输出，工具调用关闭。
			</p>
			{draft.loadError ? (
				<p role="alert" className="text-xs text-status-red">
					{draft.loadError}
				</p>
			) : null}
			<label htmlFor="task-analysis-executor-agent" className="flex flex-col gap-1 text-xs text-text-secondary">
				执行器
				<NativeSelect
					id="task-analysis-executor-agent"
					aria-label="任务分析执行器"
					value={settings?.agentId ?? "codex"}
					disabled={disabled || !settings}
					onChange={(event) =>
						settings && draft.setSettings({ ...settings, agentId: event.target.value as "codex" | "claude" })
					}
				>
					<option value="codex">Codex</option>
					<option value="claude">Claude</option>
				</NativeSelect>
			</label>
			<label className="flex flex-col gap-1 text-xs text-text-secondary">
				模型
				<input
					aria-label="任务分析模型"
					className="rounded-md border border-border-bright bg-surface-2 px-2 py-2 text-sm text-text-primary placeholder:text-text-secondary"
					value={settings?.modelId ?? ""}
					disabled={disabled || !settings}
					placeholder="使用执行器默认模型"
					onChange={(event) =>
						settings && draft.setSettings({ ...settings, modelId: event.target.value.trim() || null })
					}
				/>
			</label>
			<p className="text-xs text-text-secondary">
				提供商与凭据沿用所选 CLI 的本机配置。更改将在点击设置底部“保存”后全局生效。
			</p>
		</section>
	);
}
