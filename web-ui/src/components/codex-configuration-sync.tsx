import * as Popover from "@radix-ui/react-popover";
import * as RadixSwitch from "@radix-ui/react-switch";
import { ChevronDown, ClipboardCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
	CodexConfigurationComparisonRows,
	CodexConfigurationFullComparisonControls,
	CodexConfigurationSourceEvidenceView,
} from "@/components/codex-configuration-change-comparison";
import { CodexConfigurationFeedbackSuggestionGroupView } from "@/components/codex-configuration-feedback-suggestion-group";
import { CodexConfigurationProfileManagement } from "@/components/codex-configuration-profile-management";
import { CodexConfigurationSessionAdoptionProgress } from "@/components/codex-configuration-session-adoption-progress";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	type CodexConfigurationFeedbackSuggestionGroup,
	groupCodexConfigurationFeedbackSuggestions,
} from "@/hooks/codex-configuration-feedback-suggestion-groups";
import { useCodexConfigurationChangeDetails } from "@/hooks/use-codex-configuration-change-details";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import { useCodexConfigurationSyncHistory } from "@/hooks/use-codex-configuration-sync-history";
import type { CodexConfigurationSyncNoticePresentation } from "@/hooks/use-codex-configuration-sync-notice";
import type {
	CodexConfigurationChange,
	CodexConfigurationPropagationTarget,
	CodexConfigurationSourceObservation,
} from "@/runtime/types";

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
	pending_approval: "待反馈。明确反馈将更新 profile 并广播；未反馈时保留局部选择。",
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
	const details = useCodexConfigurationChangeDetails(controller.workspaceId, change);
	const [synchronizeExistingSessions, setSynchronizeExistingSessions] = useState(false);
	const synchronizationToggleId = useId();
	const disabled = controller.pendingChangeId !== null;
	const isPending = controller.pendingChangeId === change.changeId;
	const isProfileManaged = Boolean(change.codexConfigurationProfileId);
	const isArchivedBySettingsIsolation = change.settingsIsolationArchivedAtMs !== undefined;
	const feedbackExpired =
		change.approvalStatus === "expired" ||
		(change.approvalStatus === "pending" &&
			change.feedbackExpiresAtMs !== undefined &&
			change.feedbackExpiresAtMs <= Date.now());
	return (
		<article
			className="min-w-0 flex-1 py-3"
			data-verification-anchor="codex-configuration-change-comparison"
			aria-label={`来自 ${change.sourceConversationSessionId} 的配置变更`}
		>
			<p className="m-0 text-sm font-medium text-text-primary break-words">{change.fieldLabel}</p>
			{change.profileName && (
				<p className="mt-1 mb-0 text-xs text-text-secondary">
					{change.profileName} ·{" "}
					{change.sharingScope === "all_profiles_hook_trust"
						? "同来源同定义的所有 profile"
						: "所属 profile 的现有及未来会话"}
				</p>
			)}
			{!change.profileName && (
				<p className="mt-1 mb-0 text-xs text-text-secondary">
					选择范围：看板 Codex 的未来默认；现有会话的实际采用见会话同步进度。
				</p>
			)}
			{change.feedbackExpiresAtMs !== undefined && (
				<p className="mt-1 mb-0 text-xs text-text-secondary">
					{change.approvalStatus === "approved"
						? "已反馈到 profile；所属现有和未来会话自动采用。"
						: change.approvalStatus === "historical"
							? "此反馈机会已被较新决定取代；当前有效值与采用进度见 profile。"
							: feedbackExpired || change.approvalStatus === "expired"
								? "反馈机会已结束，局部选择保留。"
								: `本次仅调整当前会话；可在 ${new Date(change.feedbackExpiresAtMs).toLocaleTimeString()} 前反馈到 profile。`}
				</p>
			)}
			{change.approvalStatus === "rejected" && (
				<p className="mt-1 text-xs text-text-secondary">已拒绝采纳到看板默认。来源会话保留自己的配置。</p>
			)}
			{isArchivedBySettingsIsolation && (
				<p className="mt-1 text-xs text-text-secondary">
					设置隔离升级时归档；原始观测和已应用事实保留，后续不再审批或传播。
				</p>
			)}
			{change.approvalStatus === "historical" &&
				change.feedbackExpiresAtMs === undefined &&
				!isArchivedBySettingsIsolation && (
					<p className="mt-1 text-xs text-text-secondary">升级前的历史事实，保留此前已采用的默认值。</p>
				)}
			{details.sourceEvidence ? (
				<div className="mt-2">
					<CodexConfigurationSourceEvidenceView evidence={details.sourceEvidence} />
				</div>
			) : (
				<p className="mt-1 mb-0 text-xs text-text-secondary break-words">
					检测位置：{change.sourceWorkspaceId ? `${change.sourceWorkspaceId} · ` : ""}
					{change.sourceConversationSessionId}（不表示修改者）
				</p>
			)}
			<p className="mt-1 text-xs text-text-secondary">
				观测时间：
				<time dateTime={new Date(change.observedAt).toISOString()}>
					{new Date(change.observedAt).toLocaleString()}
				</time>
			</p>
			{change.hookExplanation && <p className="mt-2 text-xs text-text-primary">{change.hookExplanation}</p>}
			{details.comparison ? (
				<CodexConfigurationComparisonRows comparison={details.comparison} />
			) : (
				change.settingDifferences.map((difference) => (
					<p key={difference.label} className="mt-1 mb-0 text-xs text-text-primary break-words">
						{difference.label}：{difference.previous} → {difference.current}
					</p>
				))
			)}
			{!details.comparison && change.settingDifferences.length === 0 && (
				<p className="mt-1 mb-0 text-xs text-text-secondary">设置值未变化，来源定义已更新；未重新授予信任。</p>
			)}
			{change.comparison && <CodexConfigurationFullComparisonControls details={details} />}
			<p className="mt-1 mb-2 text-xs text-text-secondary">
				{isArchivedBySettingsIsolation
					? "此记录已退出设置同步；此前的接受、保存与加载事实以下方历史进度为准。"
					: change.mergeStatus === "shared_default_updated"
						? isProfileManaged
							? "配置默认已保存；原所有者在安全时采用，确认进度另行展示。"
							: change.sourceWriterId.startsWith("user-source:")
								? "已用于未来会话。现有会话保持各自配置。"
								: "已用于本会话及未来会话。现有会话保持各自配置。"
						: configurationChangeMergeStatusDescriptions[change.mergeStatus]}
			</p>
			{feedbackExpired && <p className="text-sm text-text-secondary">未更新默认，局部选择保留。</p>}
			{feedbackExpired && !isArchivedBySettingsIsolation && change.codexConfigurationProfileId && (
				<Button
					size="sm"
					variant="ghost"
					disabled={disabled}
					onClick={() => void controller.beginHistoricalDefaultEdit(change)}
				>
					重新发起共享
				</Button>
			)}
			{change.approvalStatus === "pending" && change.mergeStatus !== "conflict" && !feedbackExpired ? (
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
						{isProfileManaged ? "反馈到 profile 并广播" : "采用新值作为未来默认"}
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
						{isProfileManaged ? "保留本次局部选择" : "拒绝更新未来默认"}
					</Button>
				</div>
			) : change.mergeStatus === "conflict" && change.approvalStatus === "pending" ? (
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						disabled={disabled}
						onClick={() => {
							void controller.act(
								change,
								"use_session_value",
								false,
								details.comparison?.expectedSharedValueDigest,
							);
						}}
					>
						采用检测到的新值，更新共享默认
					</Button>
					<Button
						size="sm"
						disabled={disabled}
						onClick={() => {
							void controller.act(
								change,
								"keep_shared_value",
								false,
								details.comparison?.expectedSharedValueDigest,
							);
						}}
					>
						保留当前共享默认
					</Button>
				</div>
			) : change.mergeStatus === "shared_default_updated" && !isProfileManaged && !isArchivedBySettingsIsolation ? (
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
			{change.mergeStatus !== "shared_default_updated" &&
				change.acknowledgedAt === null &&
				!feedbackExpired &&
				!isArchivedBySettingsIsolation && (
					<Button
						className="mt-2"
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
			{change.targets.length > 0 && (
				<ul className="mt-3 mb-0 pl-4 space-y-1 text-xs text-text-secondary" aria-label="会话同步进度">
					{(details.propagationTargets ?? change.targets).map((target) => (
						<li key={target.writerId} className="break-words">
							<span className="text-text-primary">
								{target.conversationSessionId}：{targetStatusLabels[target.status]}
							</span>{" "}
							· {target.reason}
							{target.recoveryCondition && <span> 恢复条件：{target.recoveryCondition}。</span>}
							{target.status === "conflict" &&
								target.conflictingTargetValueDigest &&
								!isArchivedBySettingsIsolation && (
									<CodexConfigurationTargetConflict change={change} target={target} controller={controller} />
								)}
						</li>
					))}
				</ul>
			)}
		</article>
	);
}

function CodexConfigurationTargetConflict({
	change,
	target,
	controller,
}: {
	change: CodexConfigurationChange;
	target: CodexConfigurationPropagationTarget;
	controller: Controller;
}) {
	const details = useCodexConfigurationChangeDetails(controller.workspaceId, change, target.writerId);
	const comparison = details.comparison;
	const displayedDigest = comparison?.expectedTargetValueDigest;
	const disabled =
		controller.pendingChangeId !== null ||
		Boolean(comparison && displayedDigest !== target.conflictingTargetValueDigest);
	return (
		<div className="mt-2">
			{comparison?.targetSourceEvidence && (
				<CodexConfigurationSourceEvidenceView evidence={comparison.targetSourceEvidence} label="目标方" />
			)}
			{comparison && (
				<CodexConfigurationComparisonRows
					comparison={comparison}
					detectedAction={
						<Button
							size="sm"
							disabled={disabled}
							onClick={() => {
								void controller.resolveTarget(
									change,
									{
										...target,
										conflictingTargetValueDigest: displayedDigest ?? target.conflictingTargetValueDigest,
									},
									"use_source_change",
								);
							}}
						>
							向 {target.conversationSessionId} 应用来源决定
						</Button>
					}
					targetAction={
						<Button
							size="sm"
							disabled={disabled}
							onClick={() => {
								void controller.resolveTarget(
									change,
									{
										...target,
										conflictingTargetValueDigest: displayedDigest ?? target.conflictingTargetValueDigest,
									},
									"keep_target_value",
								);
							}}
						>
							保留 {target.conversationSessionId} 的决定
						</Button>
					}
				/>
			)}
			{!comparison && <p className="text-xs text-text-secondary">双方值暂不可读，恢复比较后可处理冲突。</p>}
			{change.targetComparisons?.[target.writerId] && <CodexConfigurationFullComparisonControls details={details} />}
		</div>
	);
}

function CodexConfigurationSourceObservationEntry({
	observation,
	controller,
}: {
	observation: CodexConfigurationSourceObservation;
	controller: Controller;
}) {
	const operation = controller.sourceOperations[observation.observationId];
	const isHistorySection = observation.acknowledgedAt !== null;
	const observedChanges = (controller.state?.changes ?? []).filter((change) =>
		observation.changeIds?.includes(change.changeId),
	);
	return (
		<article aria-label={`来源更新 ${observation.sourceLabel}`} className="py-3 text-xs text-text-secondary">
			<p className="m-0 font-medium text-text-primary break-words">{observation.sourceLabel}</p>
			<p>来源定义或版本已变化；标记已读只处理提醒，不改变设置或授予 Hook 信任。</p>
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
			{observedChanges
				.filter((change, index, all) => all.findIndex((entry) => entry.fieldKey === change.fieldKey) === index)
				.map((change) => (
					<CodexConfigurationObservedDefinitionChange
						key={change.changeId}
						change={change}
						controller={controller}
					/>
				))}
			{isHistorySection && (
				<p>
					{observation.reminderDisposition === "deferred" ? "已稍后处理" : "已标记已读"} ·{" "}
					<time dateTime={new Date(observation.acknowledgedAt!).toISOString()}>
						{new Date(observation.acknowledgedAt!).toLocaleString()}
					</time>
				</p>
			)}
			{(!isHistorySection || observation.reminderDisposition === "deferred") && (
				<div className="flex flex-wrap gap-2">
					{(
						[["confirm_source", "标记已读"], ...(!isHistorySection ? [["defer", "稍后处理"]] : [])] as Array<
							["confirm_source" | "defer", string]
						>
					).map(([action, label]) => (
						<Button
							key={action}
							size="sm"
							disabled={Boolean(operation)}
							onClick={() => {
								void controller.batch(action, [
									{
										entryKind: "source_observation",
										changeId: observation.observationId,
										expectedVersion: observation.version,
										observation,
									},
								]);
							}}
						>
							{label}
						</Button>
					))}
				</div>
			)}
			{operation && (
				<p role="status">
					{operation.phase === "sending"
						? "正在保存提醒处理状态…"
						: operation.phase === "verifying"
							? "回执未确认，正在核验。"
							: "回执仍未确认；连接恢复或页面重新可见后自动核验。"}
				</p>
			)}
			{operation?.phase === "unknown" && (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => controller.retryUnconfirmedSourceActions(observation.observationId)}
				>
					重新核验
				</Button>
			)}
			{!operation && controller.sourceActionMessages[observation.observationId] && (
				<p role="status">{controller.sourceActionMessages[observation.observationId]}</p>
			)}
		</article>
	);
}

function CodexConfigurationObservedDefinitionChange({
	change,
	controller,
}: {
	change: CodexConfigurationChange;
	controller: Controller;
}) {
	const details = useCodexConfigurationChangeDetails(controller.workspaceId, change);
	return (
		<div className="my-3 border-t border-border pt-2">
			<p className="font-medium text-text-primary break-words">{change.fieldLabel}</p>
			{details.sourceEvidence && <CodexConfigurationSourceEvidenceView evidence={details.sourceEvidence} />}
			<p>
				观测时间：
				<time dateTime={new Date(change.observedAt).toISOString()}>
					{new Date(change.observedAt).toLocaleString()}
				</time>
			</p>
			{change.hookExplanation && <p>{change.hookExplanation}</p>}
			{details.comparison && <CodexConfigurationComparisonRows comparison={details.comparison} />}
			<CodexConfigurationFullComparisonControls details={details} />
		</div>
	);
}

const selectionIdentity = (group: CodexConfigurationFeedbackSuggestionGroup) =>
	JSON.stringify(group.members.map((change) => [change.changeId, change.version]));
function CodexConfigurationReviewList({
	controller,
	section,
	profileId,
}: {
	controller: Controller;
	section: "feedback" | "history";
	profileId?: string;
}) {
	const isHistorySection = section === "history";
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState(new Set<string>());
	const [historyCategory, setHistoryCategory] = useState<"all" | "settings" | "sources">("all");
	const usesActiveResponse =
		controller.state?.stateResponseScope === "active" || controller.state?.stateResponseScope === "overview";
	const pagedHistory = useCodexConfigurationSyncHistory(
		controller.workspaceId,
		usesActiveResponse && isHistorySection,
		search,
		historyCategory,
		controller.state,
	);
	const historyController = {
		...controller,
		state: controller.state
			? {
					...controller.state,
					changes: [...controller.state.changes, ...pagedHistory.changes],
					sourceObservations: [...controller.state.sourceObservations, ...pagedHistory.sourceObservations],
				}
			: null,
	};

	const matching = (text: string) => text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
	const changes = (controller.state?.changes ?? []).filter(
		(change) =>
			change.recordKind !== "source_observation" &&
			(!profileId || !change.codexConfigurationProfileId || change.codexConfigurationProfileId === profileId) &&
			matching(
				`${change.fieldLabel} ${change.fieldKey ?? ""} ${change.sourceConversationSessionId} ${change.sourceWorkspaceId} ${JSON.stringify(change.sourceEvidence ?? {})} ${(change.comparison?.rows ?? []).map((row) => row.label).join(" ")}`,
			),
	);
	const proposals = changes.filter(
		(change) =>
			change.approvalStatus === "pending" &&
			(change.feedbackExpiresAtMs === undefined || change.feedbackExpiresAtMs > Date.now()),
	);
	const proposalGroups = groupCodexConfigurationFeedbackSuggestions(proposals);
	const history = (
		usesActiveResponse ? pagedHistory.changes.filter((change) => change.recordKind !== "source_observation") : changes
	).filter(
		(change) =>
			change.approvalStatus !== "pending" ||
			(change.feedbackExpiresAtMs !== undefined && change.feedbackExpiresAtMs <= Date.now()),
	);
	const observationSearchText = (observation: CodexConfigurationSourceObservation) =>
		`${observation.sourceLabel} ${JSON.stringify(
			(controller.state?.changes ?? [])
				.filter((change) => observation.changeIds?.includes(change.changeId))
				.map((change) => [
					change.fieldLabel,
					change.fieldKey,
					change.sourceEvidence,
					change.comparison?.rows.map((row) => row.label),
				]),
		)}`;
	const observations = (controller.state?.sourceObservations ?? []).filter(
		(observation) => observation.acknowledgedAt === null && matching(observationSearchText(observation)),
	);
	const processedObservations = (
		usesActiveResponse ? pagedHistory.sourceObservations : (controller.state?.sourceObservations ?? [])
	).filter(
		(observation) =>
			observation.acknowledgedAt !== null && (usesActiveResponse || matching(observationSearchText(observation))),
	);
	const selectable = isHistorySection ? [] : proposalGroups;
	const selectedProposalGroups = selectable.filter((group) => selected.has(selectionIdentity(group)));
	const selectedProposals = selectedProposalGroups.flatMap((group) => group.members);
	const disabled = controller.pendingChangeId !== null;
	const batch = async (action: "approve" | "reject" | "defer") => {
		const results = [];
		if (action === "approve" && selectedProposalGroups.some((group) => group.members.length > 1)) {
			for (const group of selectedProposalGroups) {
				const outcomes = await controller.adoptCandidate(group.candidates[0]?.members ?? []);
				if (outcomes) results.push(...outcomes);
			}
		} else {
			const outcomes = await controller.batch(
				action,
				(action === "approve"
					? selectedProposalGroups.flatMap((group) =>
							group.candidates.length === 1 ? group.candidates[0]!.members.slice(0, 1) : [],
						)
					: selectedProposals
				).map((change) => ({
					entryKind: "settings_proposal",
					changeId: change.changeId,
					expectedVersion: change.version,
					expectedSharedValueDigest:
						action === "approve" && change.candidateFieldGroupKey
							? change.comparison?.expectedSharedValueDigest
							: undefined,
				})),
			);
			if (outcomes) results.push(...outcomes);
		}
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
							!selectedProposalGroups.some(
								(group) =>
									selectionIdentity(group) === key &&
									group.members.some((change) => completed.has(change.changeId)),
							),
					),
				),
		);
	};
	return (
		<>
			<div className="flex flex-wrap items-center gap-2 py-2">
				<input
					type="search"
					aria-label="筛选配置记录"
					placeholder="搜索任务标题、ID、插件或字段"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					className="min-w-0 w-full sm:w-56 rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
				/>
			</div>
			{selectable.length > 1 && (
				<div className="flex flex-wrap items-center gap-2 border-y border-border py-2">
					<label className="flex items-center gap-2 text-xs text-text-primary">
						<input
							type="checkbox"
							aria-label="全选当前筛选结果中的设置"
							checked={selectedProposalGroups.length === selectable.length}
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
					<span className="text-xs text-text-secondary">已选 {selectedProposalGroups.length} 项</span>
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
							disabled={
								disabled ||
								!selectedProposals.length ||
								(action === "approve" && selectedProposalGroups.some((group) => group.candidates.length !== 1))
							}
							onClick={() => {
								void batch(action);
							}}
						>
							{label}
						</Button>
					))}
				</div>
			)}
			{!isHistorySection && (
				<div role="group" aria-label="设置待反馈">
					<h3 className="mt-3 mb-0 text-sm font-semibold text-text-primary">可选反馈 · {proposalGroups.length}</h3>
					{proposals.length === 0 && <p className="text-xs text-text-secondary">暂无可选反馈，默认保持不变。</p>}
					<div className="divide-y divide-border">
						{proposalGroups.map((group) => {
							const change = group.members[0]!;
							return (
								<div key={group.fieldGroupKey} className="flex min-w-0 items-start gap-2">
									{selectable.length > 1 && (
										<input
											type="checkbox"
											className="mt-4 shrink-0"
											aria-label={`选择 ${change.fieldLabel}`}
											checked={selected.has(selectionIdentity(group))}
											disabled={disabled}
											onChange={(event) => {
												const checked = event.target.checked;
												setSelected((previous) => {
													const next = new Set(previous);
													if (checked) next.add(selectionIdentity(group));
													else next.delete(selectionIdentity(group));
													return next;
												});
											}}
										/>
									)}
									{change.candidateFieldGroupKey ? (
										<CodexConfigurationFeedbackSuggestionGroupView group={group} controller={controller} />
									) : (
										<CodexConfigurationChangeActions change={change} controller={controller} />
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
			{!isHistorySection && (
				<div role="group" aria-label="来源更新">
					<h3 className="mt-3 mb-0 text-sm font-semibold text-text-primary">来源更新 · {observations.length}</h3>
					{observations.length === 0 && <p className="text-xs text-text-secondary">暂无来源更新。</p>}
					<div className="divide-y divide-border">
						{observations.map((observation) => (
							<CodexConfigurationSourceObservationEntry
								key={observation.observationId}
								observation={observation}
								controller={controller}
							/>
						))}
					</div>
				</div>
			)}
			{isHistorySection && (usesActiveResponse || history.length + processedObservations.length > 0) && (
				<div role="group" aria-label="历史记录">
					<h3 className="mt-3 mb-0 text-sm font-semibold text-text-primary">
						历史记录 ·{" "}
						{usesActiveResponse ? pagedHistory.totalCount : history.length + processedObservations.length}
					</h3>
					{usesActiveResponse && (
						<div className="flex flex-wrap items-center gap-2 py-2">
							<select
								aria-label="历史记录类别"
								value={historyCategory}
								onChange={(event) => setHistoryCategory(event.target.value as "all" | "settings" | "sources")}
								className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary"
							>
								<option value="all">全部历史</option>
								<option value="settings">设置历史</option>
								<option value="sources">来源历史</option>
							</select>
							{pagedHistory.hasNewHistory && (
								<span role="status" className="text-xs text-text-secondary">
									有新的历史记录
								</span>
							)}
							<Button
								size="sm"
								variant="ghost"
								disabled={pagedHistory.loading}
								onClick={() => void pagedHistory.refresh()}
							>
								刷新历史
							</Button>
						</div>
					)}
					<div className="divide-y divide-border">
						{history.map((change) => (
							<CodexConfigurationChangeActions
								key={change.changeId}
								change={change}
								controller={historyController}
							/>
						))}
						{processedObservations.map((observation) => (
							<CodexConfigurationSourceObservationEntry
								key={observation.observationId}
								observation={observation}
								controller={historyController}
							/>
						))}
					</div>
					{usesActiveResponse && (
						<div className="py-2">
							{pagedHistory.loading && (
								<p role="status" className="text-xs text-text-secondary">
									正在读取历史记录…
								</p>
							)}
							{pagedHistory.error && (
								<p role="alert" className="text-xs text-status-red">
									{pagedHistory.error}
								</p>
							)}
							{!pagedHistory.loading &&
								!pagedHistory.error &&
								history.length + processedObservations.length === 0 && (
									<p className="text-xs text-text-secondary">没有匹配的历史记录。</p>
								)}
							{pagedHistory.hasMore && (
								<Button
									size="sm"
									variant="ghost"
									disabled={pagedHistory.loading}
									onClick={() => void pagedHistory.loadMore()}
								>
									加载更多历史
								</Button>
							)}
						</div>
					)}
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

export function CodexConfigurationSyncSummaryButton({ notice }: { notice: CodexConfigurationSyncNoticePresentation }) {
	if (!notice.hasReminders) return null;
	const summary = `可选反馈 ${notice.pendingApprovalCount} 项 · 来源更新 ${notice.sourceUpdateCount} 条`;
	return (
		<button
			ref={notice.summaryButtonRef}
			type="button"
			aria-label={`配置提醒，${summary}`}
			aria-expanded={notice.isExpanded}
			aria-controls={notice.contentId}
			title={summary}
			data-verification-anchor="codex-configuration-sync-summary"
			onClick={(event) => notice.toggleExpanded(event.detail === 0)}
			className={cn(
				"inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-text-primary hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent md:min-h-8",
				notice.isExpanded && "bg-surface-3",
			)}
		>
			<ClipboardCheck size={14} aria-hidden="true" />
			<span className="hidden xl:inline">配置</span>
			<span className="font-mono tabular-nums">
				{notice.pendingApprovalCount + notice.sourceUpdateCount ||
					(notice.controller.state?.observationHealth
						? { healthy: "观察正常", recovering: "自动恢复中", limited: "观察受限", unverified: "待核验" }[
								notice.controller.state.observationHealth.status
							]
						: 0)}
			</span>
			<ChevronDown
				size={12}
				aria-hidden="true"
				className={cn("transition-transform motion-reduce:transition-none", notice.isExpanded && "rotate-180")}
			/>
		</button>
	);
}

function CodexConfigurationFeedbackPopoverCandidate({
	change,
	members,
	controller,
}: {
	change: CodexConfigurationChange;
	members: CodexConfigurationChange[];
	controller: Controller;
}) {
	const current = controller.state?.changes.find((entry) => entry.changeId === change.changeId);
	const expired = change.feedbackExpiresAtMs !== undefined && change.feedbackExpiresAtMs <= Date.now();
	const stale = !current || current.version !== change.version || current.approvalStatus !== "pending";
	const disabled = controller.pendingChangeId !== null || stale || expired || !change.comparison;
	const label =
		change.exceptionGroup === "reasoning_effort"
			? "推理强度"
			: change.exceptionGroup === "model"
				? "模型"
				: change.exceptionGroup === "permissions"
					? "完整权限"
					: change.fieldLabel;
	const rows = change.comparison?.rows ?? [];
	return (
		<article className="min-w-0 space-y-3 py-3" aria-label={`${label}建议`}>
			<h3 className="m-0 text-base font-semibold text-text-primary">
				{label}：
				<span className="break-all font-mono">
					{rows[0]?.sharedCurrent?.text ?? change.previousValueSummary} →{" "}
					{rows[0]?.detected.text ?? change.valueSummary}
				</span>
			</h3>
			<p className="m-0 break-words text-sm text-text-secondary">
				来源：{change.sourceEvidence?.detectedOwner.task?.taskTitle ?? change.sourceConversationSessionId} ·{" "}
				{change.profileName ?? "默认配置"}
			</p>
			{rows.length > 1 && <CodexConfigurationComparisonRows comparison={change.comparison!} />}
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="primary"
					className="min-h-9"
					disabled={disabled}
					onClick={() => void controller.adoptCandidate(members, change.comparison?.expectedSharedValueDigest)}
				>
					更新默认并同步
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="min-h-9"
					disabled={controller.pendingChangeId !== null || stale || expired}
					onClick={() =>
						void controller.batch("reject", [
							{ entryKind: "settings_proposal", changeId: change.changeId, expectedVersion: change.version },
						])
					}
				>
					保持默认
				</Button>
			</div>
			<p className="m-0 text-xs text-text-secondary">
				{expired
					? "未更新默认，局部选择保留。"
					: stale
						? "此比较已更新或处理，请重新核对建议。"
						: "同配置的现有会话在安全时采用；不操作会保留默认。"}
			</p>
		</article>
	);
}
export function CodexConfigurationSyncNotice({
	notice,
	onOpenSettings,
}: {
	notice: CodexConfigurationSyncNoticePresentation;
	onOpenSettings: () => void;
}) {
	const anchor = useRef({
		getBoundingClientRect: () => notice.summaryButtonRef.current?.getBoundingClientRect() ?? new DOMRect(),
	});
	const [showOtherCandidates, setShowOtherCandidates] = useState(false);
	const candidates = groupCodexConfigurationFeedbackSuggestions(
		notice.displayedChanges,
		Number.NEGATIVE_INFINITY,
	).flatMap((group) =>
		group.candidates.flatMap((candidate) => {
			const representative = candidate.members[0];
			return representative ? [{ representative, members: candidate.members }] : [];
		}),
	);
	if (!notice.hasReminders) return null;
	return (
		<Popover.Root
			modal={false}
			open={notice.isVisible}
			onOpenChange={(open) => {
				if (!open) notice.closeForSettings();
			}}
		>
			<Popover.Anchor virtualRef={anchor} />
			<Popover.Portal>
				<Popover.Content
					ref={notice.bindPanelRef}
					id={notice.contentId}
					side="bottom"
					align="end"
					sideOffset={8}
					collisionPadding={12}
					aria-label="Codex 配置变更提示"
					data-codex-configuration-feedback-popover=""
					data-verification-anchor="codex-configuration-sync-notice"
					data-mobile-focus-view-idle-collapse-suspension=""
					className="z-50 flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(27rem,calc(100vw-1.5rem))] min-w-0 flex-col rounded-lg border border-border bg-surface-1 p-4 focus-visible:outline-2 focus-visible:outline-accent"
					onOpenAutoFocus={(event) => event.preventDefault()}
					onCloseAutoFocus={(event) => event.preventDefault()}
					onEscapeKeyDown={() => notice.closeAndRestoreSummaryFocus()}
				>
					<div className="flex shrink-0 items-center justify-between gap-2">
						<span className="text-xs text-text-secondary">可选反馈 · {notice.pendingApprovalCount} 项</span>
						<Button size="sm" variant="ghost" onClick={notice.closeAndRestoreSummaryFocus}>
							收起
						</Button>
					</div>
					{notice.hasNewSuggestions && (
						<Button
							size="sm"
							variant="ghost"
							className="my-2 justify-start text-accent"
							disabled={notice.controller.pendingChangeId !== null}
							onClick={notice.showLatestSuggestions}
						>
							有新建议，查看最新比较
						</Button>
					)}
					<div
						ref={notice.scrollContainerRef}
						className="min-h-0 overflow-y-auto overscroll-contain"
						onScroll={notice.recordReadingPosition}
					>
						{candidates[0] ? (
							<CodexConfigurationFeedbackPopoverCandidate
								change={candidates[0].representative}
								members={candidates[0].members}
								controller={notice.controller}
							/>
						) : (
							<p className="text-sm text-text-secondary">
								暂无可选反馈。
								{notice.controller.state?.observationHealth?.impact ?? "默认保持不变，观察状态可在配置页查看。"}
							</p>
						)}
						{candidates.length > 1 && (
							<>
								<Button
									size="sm"
									variant="ghost"
									aria-expanded={showOtherCandidates}
									onClick={() => setShowOtherCandidates((value) => !value)}
								>
									其他建议 · {candidates.length - 1} 项
								</Button>
								{showOtherCandidates &&
									candidates
										.slice(1)
										.map((candidate) => (
											<CodexConfigurationFeedbackPopoverCandidate
												key={candidate.representative.changeId}
												change={candidate.representative}
												members={candidate.members}
												controller={notice.controller}
											/>
										))}
							</>
						)}
						{candidates.some(
							(candidate) =>
								!notice.controller.state?.changes.some(
									(entry) =>
										entry.changeId === candidate.representative.changeId &&
										entry.version === candidate.representative.version,
								),
						) && (
							<Button
								size="sm"
								variant="ghost"
								disabled={notice.controller.pendingChangeId !== null}
								onClick={notice.showLatestSuggestions}
							>
								重新核对建议
							</Button>
						)}
						{notice.controller.error && (
							<p
								role={notice.controller.errorIsConfirmed ? "alert" : "status"}
								className={
									notice.controller.errorIsConfirmed ? "text-sm text-status-red" : "text-sm text-status-orange"
								}
							>
								{notice.controller.error}
							</p>
						)}
					</div>
					<div className="mt-2 flex shrink-0 items-center justify-between border-t border-border pt-2">
						<span className="text-xs text-text-secondary">来源更新 {notice.sourceUpdateCount} 条</span>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								notice.closeForSettings();
								onOpenSettings();
							}}
						>
							配置同步设置
						</Button>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
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
	const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
	const [section, setSection] = useState<"feedback" | "adoption" | "history">("feedback");
	const sectionId = useId();
	const sections = [
		["feedback", "可选反馈"],
		["adoption", "自动采用"],
		["history", "历史"],
	] as const;
	useEffect(() => {
		if (controller.historicalDefaultEditRequest) {
			setSelectedProfileId(controller.historicalDefaultEditRequest.profileId);
			setSection("feedback");
		}
	}, [controller.historicalDefaultEditRequest]);
	const profileId =
		selectedProfileId ??
		controller.state?.defaultCodexConfigurationProfileId ??
		controller.state?.profiles?.[0]?.profileId;
	return (
		<section
			aria-label="Codex 配置同步"
			className="mb-5 min-w-0 space-y-4"
			data-verification-anchor="codex-configuration-sync-settings"
		>
			<h2 className="m-0 pt-4 text-xl font-semibold text-text-primary">Codex 配置</h2>
			{controller.state && (
				<CodexConfigurationProfileManagement
					controller={controller}
					selectedProfileId={selectedProfileId}
					onSelectedProfileIdChange={setSelectedProfileId}
				/>
			)}
			<p className="max-w-prose text-sm leading-relaxed text-text-secondary">
				普通偏好自动共享。模型、推理强度和完整权限先保留为会话局部选择，明确反馈后才更新默认。hook
				信任来自原生确认。外部 Codex 配置只在首次导入，后续修改不会自动成为 Kanban 默认。
			</p>
			<div role="tablist" aria-label="配置记录分区" className="flex gap-1 border-b border-border pb-2">
				{sections.map(([value, label], index) => (
					<Button
						key={value}
						id={`${sectionId}-${value}-tab`}
						role="tab"
						tabIndex={section === value ? 0 : -1}
						aria-controls={`${sectionId}-${value}-panel`}
						aria-selected={section === value}
						variant={section === value ? "primary" : "ghost"}
						onClick={() => setSection(value)}
						onKeyDown={(event) => {
							const targetIndex =
								event.key === "ArrowRight"
									? (index + 1) % sections.length
									: event.key === "ArrowLeft"
										? (index + sections.length - 1) % sections.length
										: event.key === "Home"
											? 0
											: event.key === "End"
												? sections.length - 1
												: null;
							if (targetIndex === null) return;
							event.preventDefault();
							setSection(sections[targetIndex]![0]);
							event.currentTarget.parentElement
								?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
								[targetIndex]?.focus();
						}}
					>
						{label}
					</Button>
				))}
			</div>
			<div role="tabpanel" id={`${sectionId}-${section}-panel`} aria-labelledby={`${sectionId}-${section}-tab`}>
				{!controller.state ? (
					<p role="status" className="text-sm text-text-secondary">
						{controller.error ?? "正在读取配置概览…"}
					</p>
				) : section === "adoption" && profileId ? (
					<CodexConfigurationSessionAdoptionProgress controller={controller} profileId={profileId} />
				) : (
					<CodexConfigurationReviewList
						key={section}
						controller={controller}
						section={section === "history" ? "history" : "feedback"}
						profileId={profileId ?? undefined}
					/>
				)}
			</div>
			{controller.error && (
				<p
					role={controller.errorIsConfirmed ? "alert" : "status"}
					className={controller.errorIsConfirmed ? "text-sm text-status-red" : "text-sm text-status-orange"}
				>
					{controller.error}
				</p>
			)}
		</section>
	);
}
