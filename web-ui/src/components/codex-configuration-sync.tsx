import * as RadixSwitch from "@radix-ui/react-switch";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { CodexConfigurationChange } from "@/runtime/types";

type Controller = ReturnType<typeof useCodexConfigurationSync>;
const targetStatusLabels = {
	accepted: "已受理",
	applied: "已应用",
	pending_reload: "待重载",
	pending_next_start: "待下次启动",
	conflict: "冲突",
	not_applicable: "不适用",
};

const configurationChangeMergeStatusDescriptions: Record<
	Exclude<CodexConfigurationChange["mergeStatus"], "shared_default_updated">,
	string
> = {
	conflict: "本会话与共享默认存在冲突，双方决定均已保留。",
	superseded: "共享默认已有较新决定；来源会话保留自己的配置。",
	kept_shared_value: "已保留共享默认。",
	target_conflict_source_change_selected: "已选择来源决定；保存与加载状态以会话同步进度为准。",
	target_conflict_target_value_kept: "已明确保留本会话自己的决定，共享默认保持原值。",
};

function CodexConfigurationChangeActions({
	change,
	controller,
}: {
	change: CodexConfigurationChange;
	controller: Controller;
}) {
	const [synchronizeExistingSessions, setSynchronizeExistingSessions] = useState(false);
	const synchronizationToggleId = useId();
	const disabled = controller.pendingChangeId !== null;
	const isPending = controller.pendingChangeId === change.changeId;
	return (
		<article className="min-w-0 py-3" aria-label={`来自 ${change.sourceConversationSessionId} 的配置变更`}>
			<p className="m-0 text-sm font-medium text-text-primary break-words">{change.fieldLabel}</p>
			<p className="mt-1 mb-0 text-xs text-text-secondary break-words">
				来源：{change.sourceConversationSessionId} · {change.previousValueSummary} → {change.valueSummary}
			</p>
			<p className="mt-1 mb-2 text-xs text-text-secondary">
				{change.mergeStatus === "shared_default_updated"
					? change.sourceWriterId.startsWith("user-source:")
						? "已用于未来会话。现有会话保持各自配置。"
						: "已用于本会话及未来会话。现有会话保持各自配置。"
					: configurationChangeMergeStatusDescriptions[change.mergeStatus]}
			</p>
			{change.mergeStatus === "conflict" ? (
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						disabled={disabled}
						onClick={() => {
							void controller.act(change, "use_session_value");
						}}
					>
						采用此会话决定
					</Button>
					<Button
						size="sm"
						disabled={disabled}
						onClick={() => {
							void controller.act(change, "keep_shared_value");
						}}
					>
						保留共享默认
					</Button>
				</div>
			) : change.mergeStatus === "shared_default_updated" ? (
				<>
					<div className="flex items-start gap-2 text-xs text-text-primary">
						<RadixSwitch.Root
							id={synchronizationToggleId}
							checked={synchronizeExistingSessions}
							onCheckedChange={setSynchronizeExistingSessions}
							disabled={disabled}
							className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-surface-4 data-[state=checked]:bg-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<label htmlFor={synchronizationToggleId} className="pt-0.5 cursor-pointer">
							同步到所有看板 Codex 会话（{change.eligibleTargetCount} 个符合来源条件）
						</label>
					</div>
					<div className="mt-3 flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="primary"
							disabled={disabled}
							onClick={() => {
								void controller.act(change, "synchronize", synchronizeExistingSessions);
							}}
						>
							{isPending ? "正在同步…" : "同步设置"}
						</Button>
						{change.acknowledgedAt === null && (
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled}
								onClick={() => {
									void controller.act(change, "acknowledge");
								}}
							>
								稍后处理
							</Button>
						)}
					</div>
				</>
			) : null}
			{change.mergeStatus !== "shared_default_updated" && change.acknowledgedAt === null && (
				<Button
					className="mt-2"
					size="sm"
					variant="ghost"
					disabled={disabled}
					onClick={() => {
						void controller.act(change, "acknowledge");
					}}
				>
					稍后处理
				</Button>
			)}
			{change.targets.length > 0 && (
				<ul className="mt-3 mb-0 pl-4 space-y-1 text-xs text-text-secondary" aria-label="会话同步进度">
					{change.targets.map((target) => (
						<li key={target.writerId} className="break-words">
							<span className="text-text-primary">
								{target.conversationSessionId}：{targetStatusLabels[target.status]}
							</span>{" "}
							· {target.reason}
							{target.recoveryCondition && <span> 恢复条件：{target.recoveryCondition}。</span>}
							{target.status === "conflict" && target.conflictingTargetValueDigest && (
								<div className="mt-1 flex flex-wrap gap-2">
									<Button
										size="sm"
										disabled={disabled}
										onClick={() => {
											void controller.resolveTarget(change, target, "use_source_change");
										}}
									>
										向 {target.conversationSessionId} 应用来源决定
									</Button>
									<Button
										size="sm"
										disabled={disabled}
										onClick={() => {
											void controller.resolveTarget(change, target, "keep_target_value");
										}}
									>
										保留 {target.conversationSessionId} 的决定
									</Button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</article>
	);
}

export function CodexConfigurationSyncNotice({
	workspaceId,
	onOpenSettings,
}: {
	workspaceId: string | null;
	onOpenSettings: () => void;
}) {
	const controller = useCodexConfigurationSync(workspaceId);
	const changes = controller.state?.changes.filter((change) => change.acknowledgedAt === null) ?? [];
	const change = changes[0];
	if (!change) return null;
	return (
		<section
			className="shrink-0 max-h-[45vh] overflow-y-auto border-b border-border bg-surface-1 px-4"
			aria-label="Codex 配置变更提示"
			aria-live="polite"
			data-verification-anchor="codex-configuration-sync-notice"
		>
			<div className="flex items-center justify-between gap-3 pt-3">
				<span className="text-sm font-semibold text-text-primary">
					Codex 配置已变更{changes.length > 1 ? `（${changes.length} 项待处理）` : ""}
				</span>
				<Button size="sm" variant="ghost" onClick={onOpenSettings}>
					配置同步设置
				</Button>
			</div>
			<CodexConfigurationChangeActions key={change.changeId} change={change} controller={controller} />
			{controller.error && (
				<p role="alert" className="text-xs text-status-red">
					{controller.error}
				</p>
			)}
		</section>
	);
}

export function CodexConfigurationSyncSettings({
	workspaceId,
	enabled = true,
}: {
	workspaceId: string | null;
	enabled?: boolean;
}) {
	const controller = useCodexConfigurationSync(workspaceId, enabled);
	return (
		<section
			aria-label="Codex 配置同步"
			className="mb-5 min-w-0"
			data-verification-anchor="codex-configuration-sync-settings"
		>
			<div className="sticky top-0 pt-4 pb-2 bg-surface-1 z-10">
				<h2 className="m-0 text-base font-semibold text-text-primary">Codex 配置同步</h2>
			</div>
			<p className="text-[13px] text-text-secondary">
				原生界面的决定默认用于本会话及未来会话。每次选择同步时，只传播该条变更。
			</p>
			{controller.error && (
				<p role="alert" className="text-xs text-status-red">
					{controller.error}
				</p>
			)}
			{controller.state?.observationProblem && (
				<p role="status" className="text-xs text-text-secondary">
					{controller.state.observationProblem}
				</p>
			)}
			{!controller.state ? (
				<p className="text-xs text-text-secondary">正在读取配置变更…</p>
			) : controller.state.changes.length === 0 ? (
				<p className="text-xs text-text-secondary">
					暂无配置变更。会话中的 hook 信任、启用和禁用决定会保留在这里。
				</p>
			) : (
				<div className="divide-y divide-border">
					{controller.state.changes.map((change) => (
						<CodexConfigurationChangeActions key={change.changeId} change={change} controller={controller} />
					))}
				</div>
			)}
		</section>
	);
}
