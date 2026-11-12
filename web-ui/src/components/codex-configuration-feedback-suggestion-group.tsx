import type { ReactNode } from "react";
import {
	CodexConfigurationComparisonRows,
	CodexConfigurationFullComparisonControls,
	CodexConfigurationSourceEvidenceView,
} from "@/components/codex-configuration-change-comparison";
import { Button } from "@/components/ui/button";
import type {
	CodexConfigurationCandidateValueGroup,
	CodexConfigurationFeedbackSuggestionGroup,
} from "@/hooks/codex-configuration-feedback-suggestion-groups";
import { useCodexConfigurationChangeDetails } from "@/hooks/use-codex-configuration-change-details";
import type { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { CodexConfigurationChange } from "@/runtime/types";

type ConfigurationComparison = NonNullable<CodexConfigurationChange["comparison"]>;
type Controller = ReturnType<typeof useCodexConfigurationSync>;

function ConfigurationValueDecision({
	label,
	choice,
	rows,
	valueKind,
	action,
}: {
	label: string;
	choice: "current" | "candidate";
	rows: ConfigurationComparison["rows"];
	valueKind: "sharedCurrent" | "detected";
	action: ReactNode;
}) {
	return (
		<section aria-label={label} data-configuration-value-choice={choice} className="min-w-0 py-3">
			<p className="m-0 mb-2 text-xs font-medium text-text-secondary">{label}</p>
			<dl className="m-0 space-y-2">
				{rows.map((row, index) => (
					<div key={`${row.fieldKey}:${row.label}`} className="min-w-0">
						<dt className="mb-1 text-xs text-text-secondary break-words">{row.label}</dt>
						<dd className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
							<span
								data-configuration-compared-value
								className="min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-text-primary"
							>
								{row[valueKind]?.text ?? "未知：当前默认尚未恢复。"}
							</span>
							{index === rows.length - 1 && <div className="shrink-0">{action}</div>}
						</dd>
					</div>
				))}
			</dl>
			{!rows.length && <div className="mt-2">{action}</div>}
		</section>
	);
}

function ConfigurationCandidateSourceHistory({
	change,
	controller,
}: {
	change: CodexConfigurationChange;
	controller: Controller;
}) {
	const details = useCodexConfigurationChangeDetails(controller.workspaceId, change);
	return (
		<details className="py-2 text-xs text-text-secondary">
			<summary className="cursor-pointer break-words focus-visible:outline-2 focus-visible:outline-accent">
				{change.sourceConversationSessionId} · 记录版本 {change.version} ·{" "}
				{new Date(change.observedAt).toLocaleString()}
			</summary>
			{details.sourceEvidence && (
				<div className="mt-2">
					<CodexConfigurationSourceEvidenceView evidence={details.sourceEvidence} />
				</div>
			)}
			{change.feedbackExpiresAtMs !== undefined && (
				<p>有效期限：{new Date(change.feedbackExpiresAtMs).toLocaleString()}</p>
			)}
			{details.comparison && <CodexConfigurationComparisonRows comparison={details.comparison} />}
			<CodexConfigurationFullComparisonControls details={details} />
		</details>
	);
}

function ConfigurationCandidateValue({
	candidate,
	controller,
}: {
	candidate: CodexConfigurationCandidateValueGroup;
	controller: Controller;
}) {
	const representative = candidate.members[0]!;
	const details = useCodexConfigurationChangeDetails(controller.workspaceId, representative);
	return (
		<div className="border-t border-border">
			<ConfigurationValueDecision
				label={`候选值 · ${candidate.members.length} 个来源`}
				choice="candidate"
				rows={details.comparison?.rows ?? []}
				valueKind="detected"
				action={
					<Button
						size="sm"
						variant="primary"
						disabled={controller.pendingChangeId !== null || !details.comparison?.rows.length}
						onClick={() => {
							void controller.adoptCandidate(candidate.members, details.comparison?.expectedSharedValueDigest);
						}}
					>
						更新默认并同步
					</Button>
				}
			/>
			{!details.comparison && (
				<p className="text-xs text-text-secondary">{representative.valueSummary}；完整比较恢复后可采用。</p>
			)}
			{representative.hookExplanation && (
				<p className="text-xs text-text-secondary">{representative.hookExplanation}</p>
			)}
			<CodexConfigurationFullComparisonControls details={details} />
			<details className="mb-2 text-xs text-text-secondary">
				<summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-accent">
					来源历史 · {candidate.members.length} 条
				</summary>
				{candidate.members.map((change) => (
					<ConfigurationCandidateSourceHistory key={change.changeId} change={change} controller={controller} />
				))}
			</details>
		</div>
	);
}

export function CodexConfigurationFeedbackSuggestionGroupView({
	group,
	controller,
}: {
	group: CodexConfigurationFeedbackSuggestionGroup;
	controller: Controller;
}) {
	const representative = group.members[0]!;
	const fieldLabel =
		representative.exceptionGroup === "permissions"
			? "完整权限设置"
			: representative.exceptionGroup === "reasoning_effort"
				? "推理强度"
				: representative.exceptionGroup === "model"
					? "模型"
					: representative.fieldLabel;
	const rows = [
		...new Map(
			group.members
				.flatMap((change) => change.comparison?.rows ?? [])
				.map((row) => [`${row.fieldKey}:${row.label}`, row]),
		).values(),
	];
	return (
		<article
			className="min-w-0 flex-1 py-3"
			data-verification-anchor="codex-configuration-proposal-group"
			aria-label={`${representative.profileName ?? "看板默认"} · ${fieldLabel} 的候选值`}
		>
			<p className="m-0 text-sm font-medium text-text-primary break-words">{fieldLabel}</p>
			<p className="mt-1 text-xs text-text-secondary">
				{representative.profileName ?? "看板 Codex"} · 采用后更新所属配置
				并同步；保持默认时各会话继续使用自己的局部选择。
			</p>
			<ConfigurationValueDecision
				label="当前看板默认"
				choice="current"
				rows={rows}
				valueKind="sharedCurrent"
				action={
					<Button
						size="sm"
						disabled={
							controller.pendingChangeId !== null ||
							rows.some((row) => !row.sharedCurrent || row.sharedCurrent.state === "unknown")
						}
						onClick={() => {
							void controller.batch(
								"reject",
								group.members.map((change) => ({
									entryKind: "settings_proposal",
									changeId: change.changeId,
									expectedVersion: change.version,
								})),
							);
						}}
					>
						保持默认
					</Button>
				}
			/>
			{group.candidates.map((candidate) => (
				<ConfigurationCandidateValue
					key={candidate.candidateValueDigest}
					candidate={candidate}
					controller={controller}
				/>
			))}
			{group.members.some((change) => change.acknowledgedAt === null) && (
				<Button
					size="sm"
					variant="ghost"
					disabled={controller.pendingChangeId !== null}
					onClick={() => {
						void controller.batch(
							"defer",
							group.members.map((change) => ({
								entryKind: "settings_proposal",
								changeId: change.changeId,
								expectedVersion: change.version,
							})),
						);
					}}
				>
					稍后处理
				</Button>
			)}
		</article>
	);
}
