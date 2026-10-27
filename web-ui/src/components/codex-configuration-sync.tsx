import * as RadixSwitch from "@radix-ui/react-switch";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { CodexConfigurationChange } from "@/runtime/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

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
	pending_approval: "待审批。通过后更新未来看板会话默认；来源会话保留本地改动。",
	conflict: "检测到的设置与共享默认存在冲突，双方决定均已保留。",
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
			{change.approvalStatus === "rejected" && (
				<p className="mt-1 text-xs text-text-secondary">已拒绝采纳到看板默认。来源会话保留自己的配置。</p>
			)}
			{change.approvalStatus === "historical" && (
				<p className="mt-1 text-xs text-text-secondary">升级前的历史事实，保留此前已采用的默认值。</p>
			)}
			<p className="mt-1 mb-0 text-xs text-text-secondary break-words">
				检测位置：{change.sourceWorkspaceId ? `${change.sourceWorkspaceId} · ` : ""}
				{change.sourceConversationSessionId}（不表示修改者）
			</p>
			{change.settingDifferences.map((difference) => (
				<p key={difference.label} className="mt-1 mb-0 text-xs text-text-primary break-words">
					{difference.label}：{difference.previous} → {difference.current}
				</p>
			))}
			{change.settingDifferences.length === 0 && (
				<p className="mt-1 mb-0 text-xs text-text-secondary">设置值未变化，来源定义已更新；未重新授予信任。</p>
			)}
			<p className="mt-1 mb-2 text-xs text-text-secondary">
				{change.mergeStatus === "shared_default_updated"
					? change.sourceWriterId.startsWith("user-source:")
						? "已用于未来会话。现有会话保持各自配置。"
						: "已用于本会话及未来会话。现有会话保持各自配置。"
					: configurationChangeMergeStatusDescriptions[change.mergeStatus]}
			</p>
			{change.approvalStatus === "pending" && change.mergeStatus !== "conflict" ? (
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="primary"
						disabled={disabled}
						onClick={() => {
							void controller.batch("approve", [
								{ entryKind: "settings_proposal", changeId: change.changeId, expectedVersion: change.version },
							]);
						}}
					>
						通过
					</Button>
					<Button
						size="sm"
						disabled={disabled}
						onClick={() => {
							void controller.batch("reject", [
								{ entryKind: "settings_proposal", changeId: change.changeId, expectedVersion: change.version },
							]);
						}}
					>
						拒绝
					</Button>
				</div>
			) : change.mergeStatus === "conflict" && change.approvalStatus === "pending" ? (
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
									if (change.approvalStatus === "pending")
										void controller.batch("defer", [
											{
												entryKind: "settings_proposal",
												changeId: change.changeId,
												expectedVersion: change.version,
											},
										]);
									else void controller.act(change, "acknowledge");
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
						if (change.approvalStatus === "pending")
							void controller.batch("defer", [
								{ entryKind: "settings_proposal", changeId: change.changeId, expectedVersion: change.version },
							]);
						else void controller.act(change, "acknowledge");
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

type ReviewFilter = "all" | "settings" | "sources" | "history";
const selectionIdentity = (change: CodexConfigurationChange) => `${change.changeId}:${change.version}`;
function CodexConfigurationReviewList({
	controller,
	remindersOnly = false,
}: {
	controller: Controller;
	remindersOnly?: boolean;
}) {
	const [filter, setFilter] = useState<ReviewFilter>("all");
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState(new Set<string>());
	const matching = (text: string) => text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
	const changes = (controller.state?.changes ?? []).filter(
		(change) =>
			change.recordKind !== "source_observation" &&
			(!remindersOnly || (change.acknowledgedAt === null && change.recordKind !== "historical_record")) &&
			matching(`${change.fieldLabel} ${change.sourceConversationSessionId} ${change.sourceWorkspaceId}`),
	);
	const proposals = changes.filter((change) => change.approvalStatus === "pending");
	const history = changes.filter((change) => change.approvalStatus !== "pending");
	const observations = (controller.state?.sourceObservations ?? []).filter(
		(observation) => (!remindersOnly || observation.acknowledgedAt === null) && matching(observation.sourceLabel),
	);
	const selectable = filter === "all" || filter === "settings" ? proposals : [];
	const selectedProposals = selectable.filter((change) => selected.has(selectionIdentity(change)));
	const disabled = controller.pendingChangeId !== null;
	const batch = async (action: "approve" | "reject" | "defer") => {
		const results = await controller.batch(
			action,
			selectedProposals.map((change) => ({
				entryKind: "settings_proposal",
				changeId: change.changeId,
				expectedVersion: change.version,
			})),
		);
		const completed = new Set(
			results
				?.filter((result) => result.status === "applied" || result.status === "replayed")
				.map((result) => result.changeId),
		);
		setSelected(
			(previous) =>
				new Set(
					[...previous].filter(
						(key) =>
							!selectedProposals.some(
								(change) => selectionIdentity(change) === key && completed.has(change.changeId),
							),
					),
				),
		);
	};
	return (
		<>
			<div className="flex flex-wrap items-center gap-2 py-2">
				{(
					[
						["all", "全部"],
						["settings", "设置待审批"],
						["sources", "来源更新"],
						...(!remindersOnly ? [["history", "历史记录"]] : []),
					] as Array<[ReviewFilter, string]>
				).map(([value, label]) => (
					<Button
						key={value}
						size="sm"
						variant="ghost"
						aria-pressed={filter === value}
						onClick={() => setFilter(value)}
					>
						{label}
					</Button>
				))}
				<input
					type="search"
					aria-label="筛选配置记录"
					placeholder="筛选字段或检测位置"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					className="min-w-0 w-full sm:w-56 rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
				/>
			</div>
			{selectable.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 border-y border-border py-2">
					<label className="flex items-center gap-2 text-xs text-text-primary">
						<input
							type="checkbox"
							aria-label="全选当前筛选结果中的设置"
							checked={selectedProposals.length === selectable.length}
							disabled={disabled}
							onChange={(event) => {
								const checked = event.target.checked;
								setSelected((previous) => {
									const next = new Set(previous);
									for (const change of selectable) {
										if (checked) next.add(selectionIdentity(change));
										else next.delete(selectionIdentity(change));
									}
									return next;
								});
							}}
						/>
						全选当前筛选结果
					</label>
					<span className="text-xs text-text-secondary">已选 {selectedProposals.length} 项</span>
					{(
						[
							["approve", "批量通过"],
							["reject", "批量拒绝"],
							["defer", "批量稍后"],
						] as const
					).map(([action, label]) => (
						<Button
							key={action}
							size="sm"
							variant={action === "approve" ? "primary" : "ghost"}
							disabled={disabled || !selectedProposals.length}
							onClick={() => {
								void batch(action);
							}}
						>
							{label}
						</Button>
					))}
				</div>
			)}
			{(filter === "all" || filter === "settings") && (
				<div role="group" aria-label="设置待审批">
					<h3 className="mt-3 mb-0 text-sm font-semibold text-text-primary">设置待审批 · {proposals.length}</h3>
					{proposals.length === 0 && <p className="text-xs text-text-secondary">暂无待审批设置。</p>}
					<div className="divide-y divide-border">
						{proposals.map((change) => (
							<div key={change.changeId} className="flex min-w-0 items-start gap-2">
								<input
									type="checkbox"
									className="mt-4 shrink-0"
									aria-label={`选择 ${change.fieldLabel}`}
									checked={selected.has(selectionIdentity(change))}
									disabled={disabled}
									onChange={(event) => {
										const checked = event.target.checked;
										setSelected((previous) => {
											const next = new Set(previous);
											if (checked) next.add(selectionIdentity(change));
											else next.delete(selectionIdentity(change));
											return next;
										});
									}}
								/>
								<CodexConfigurationChangeActions change={change} controller={controller} />
							</div>
						))}
					</div>
				</div>
			)}
			{(filter === "all" || filter === "sources") && (
				<div role="group" aria-label="来源更新">
					<h3 className="mt-3 mb-0 text-sm font-semibold text-text-primary">来源更新 · {observations.length}</h3>
					{observations.length === 0 && <p className="text-xs text-text-secondary">暂无来源更新。</p>}
					<div className="divide-y divide-border">
						{observations.map((observation) => (
							<article
								key={observation.observationId}
								aria-label={`来源更新 ${observation.sourceLabel}`}
								className="py-3 text-xs text-text-secondary"
							>
								<p className="m-0 font-medium text-text-primary break-words">{observation.sourceLabel}</p>
								<p>来源定义或版本已变化；设置值未变化，未重新授予信任。</p>
								<p>
									检测位置：
									{observation.detectedLocations
										?.map(
											(location) =>
												`${location.workspaceId ? `${location.workspaceId} · ` : ""}${location.conversationSessionId}`,
										)
										.join("、") || "位置详情待恢复"}
									（不表示修改者）
								</p>
								<p>
									在 {observation.detectedLocationCount} 个位置检测到，保留 {observation.observationCount}{" "}
									条原始观测。发起者尚未证实。
								</p>
								<div className="flex flex-wrap gap-2">
									{(
										[
											["confirm_source", "确认"],
											["defer", "稍后处理"],
										] as const
									).map(([action, label]) => (
										<Button
											key={action}
											size="sm"
											disabled={disabled}
											onClick={() => {
												void controller.batch(action, [
													{
														entryKind: "source_observation",
														changeId: observation.observationId,
														expectedVersion: observation.version,
													},
												]);
											}}
										>
											{label}
										</Button>
									))}
								</div>
							</article>
						))}
					</div>
				</div>
			)}
			{(filter === "all" || filter === "history") && history.length > 0 && (
				<div role="group" aria-label="历史记录">
					<h3 className="mt-3 mb-0 text-sm font-semibold text-text-primary">历史记录 · {history.length}</h3>
					<div className="divide-y divide-border">
						{history.map((change) => (
							<CodexConfigurationChangeActions key={change.changeId} change={change} controller={controller} />
						))}
					</div>
				</div>
			)}
			{controller.batchResults
				.filter((result) => result.status !== "applied" && result.status !== "replayed")
				.map((result) => (
					<p key={result.changeId} role="alert" className="text-xs text-status-red break-words">
						{result.message}
					</p>
				))}
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
		</>
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
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue("codex-configuration-change-notice-collapsed", false);
	const contentId = useId();
	const scrollContainer = useRef<HTMLDivElement>(null);
	const readingPosition = useRef(0);
	const pending =
		controller.state?.changes.filter(
			(change) => change.recordKind === "settings_proposal" && change.acknowledgedAt === null,
		) ?? [];
	const sources =
		controller.state?.sourceObservations.filter((observation) => observation.acknowledgedAt === null) ?? [];
	useLayoutEffect(() => {
		if (!collapsed && scrollContainer.current) scrollContainer.current.scrollTop = readingPosition.current;
	}, [collapsed]);
	if (!pending.length && !sources.length) return null;
	return (
		<section
			className="shrink-0 min-w-0 border-b border-border bg-surface-1 px-3 sm:px-4"
			aria-label="Codex 配置变更提示"
			data-verification-anchor="codex-configuration-sync-notice"
		>
			<div className="flex items-center justify-between gap-2 py-2">
				<span className="min-w-0 text-xs font-medium text-text-primary" role="status">
					待审批 {pending.filter((change) => change.approvalStatus === "pending").length} 项 · 来源更新{" "}
					{sources.length} 条
				</span>
				<div className="flex shrink-0 items-center gap-1">
					<Button size="sm" variant="ghost" onClick={onOpenSettings}>
						配置同步设置
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-expanded={!collapsed}
						aria-controls={contentId}
						onClick={() => {
							if (!collapsed && scrollContainer.current)
								readingPosition.current = scrollContainer.current.scrollTop;
							setCollapsed(!collapsed);
						}}
					>
						{collapsed ? "展开" : "收起"}
					</Button>
				</div>
			</div>
			<div id={contentId} hidden={collapsed}>
				<div
					ref={scrollContainer}
					className="max-h-[38vh] overflow-y-auto overscroll-contain pb-2"
					onScroll={() => {
						if (!collapsed && scrollContainer.current)
							readingPosition.current = scrollContainer.current.scrollTop;
					}}
				>
					<CodexConfigurationReviewList controller={controller} remindersOnly />
				</div>
			</div>
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
				真实设置变化先审批，通过后更新未来看板会话默认。来源会话保留本地改动；同步到现有会话需单独选择。
			</p>
			{controller.state?.diagnosticCoverage && (
				<p className="text-xs text-text-secondary" role="status">
					基础诊断：
					{controller.state.diagnosticCoverage.fileObservation === "active" ? "正在只读观察" : "正在启动"} ·{" "}
					{controller.state.diagnosticCoverage.targetCount} 个目标 ·{" "}
					{controller.state.diagnosticCoverage.coverageGapCount}{" "}
					处覆盖缺口。系统级实际写入者采集需单独运行追踪脚本。
				</p>
			)}
			{!controller.state ? (
				<p className="text-xs text-text-secondary">正在读取配置记录…</p>
			) : (
				<CodexConfigurationReviewList controller={controller} />
			)}
		</section>
	);
}
