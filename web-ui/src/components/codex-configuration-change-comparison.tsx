import { Button } from "@/components/ui/button";
import type { useCodexConfigurationChangeDetails } from "@/hooks/use-codex-configuration-change-details";
import type { CodexConfigurationChange, CodexConfigurationSourceEvidence } from "@/runtime/types";

export function CodexConfigurationSourceEvidenceView({
	evidence,
	label = "来源",
}: {
	evidence: CodexConfigurationSourceEvidence;
	label?: string;
}) {
	const { detectedOwner, initiator } = evidence;
	const task = detectedOwner.task;
	const link = detectedOwner.currentTaskLink;
	const href = link ? `/${encodeURIComponent(link.workspaceId)}?task=${encodeURIComponent(link.taskId)}` : undefined;
	return (
		<div className="space-y-1 text-xs text-text-secondary break-words">
			<p className="m-0">
				{label} · 已确认的修改发起者：
				{initiator.status === "confirmed" ? initiator.description : `未知。${initiator.description}`}
			</p>
			<p className="m-0">
				检测到变更的会话归属：
				{task ? (
					<>
						{href ? (
							<a
								className="text-accent-hover underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
								href={href}
								target="_blank"
								rel="noreferrer"
							>
								{task.taskTitle} · {task.taskId}
							</a>
						) : (
							<span className="text-text-primary">
								{task.taskTitle} · {task.taskId}
							</span>
						)}
						{` · 项目 ${task.workspaceId}（${task.projectPath}） · 会话 ${task.conversationSessionId}`}
					</>
				) : (
					`${detectedOwner.description}${detectedOwner.workspaceId ? ` · 项目 ${detectedOwner.workspaceId}` : ""}${detectedOwner.conversationSessionId ? ` · 会话 ${detectedOwner.conversationSessionId}` : ""}`
				)}
			</p>
			{detectedOwner.unavailableReason && <p className="m-0">{detectedOwner.unavailableReason}</p>}
		</div>
	);
}

const changeKindLabels = { added: "新增", modified: "修改", deleted: "删除", unchanged: "未变化", unknown: "历史未知" };
export function CodexConfigurationComparisonRows({
	comparison,
}: {
	comparison: NonNullable<CodexConfigurationChange["comparison"]>;
}) {
	return (
		<div
			role="group"
			className="my-3 divide-y divide-border border-y border-border"
			aria-label={comparison.targetWriterId ? "来源与目标决定比较" : "配置字段比较"}
		>
			{comparison.rows.map((row) => (
				<div key={`${row.fieldKey}:${row.label}`} className="py-2">
					<p className="mt-0 mb-2 text-xs font-medium text-text-primary break-words">
						{row.label} <span className="text-text-secondary">· {changeKindLabels[row.changeKind]}</span>
					</p>
					<dl className="m-0 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
						{(comparison.targetWriterId
							? [
									["来源决定", row.detected],
									["目标自己的决定", row.target],
								]
							: [
									["修改前", row.previous],
									["检测到的新值", row.detected],
									["冲突发生时的共享值", row.sharedAtConflict],
									["当前共享默认值", row.sharedCurrent],
								]
						).map(([label, value]) =>
							value && typeof value !== "string" ? (
								<div key={String(label)} className="min-w-0">
									<dt className="mb-1 text-xs text-text-secondary">{String(label)}</dt>
									<dd className="m-0 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-text-primary">
										{value.text}
									</dd>
								</div>
							) : null,
						)}
					</dl>
					{row.sharedAtConflictOrigin && (
						<p className="mt-2 mb-0 text-xs text-text-secondary">
							冲突快照来源：{row.sharedAtConflictOrigin.description}
							{row.sharedAtConflictOrigin.changeId ? ` · 变更 ${row.sharedAtConflictOrigin.changeId}` : ""}
						</p>
					)}
					{row.sharedAtConflictOrigin?.sourceEvidence && (
						<CodexConfigurationSourceEvidenceView
							evidence={row.sharedAtConflictOrigin.sourceEvidence}
							label="冲突时共享方"
						/>
					)}
					{row.sharedOrigin && (
						<div className="mt-2 text-xs text-text-secondary">
							<p className="m-0">
								当前共享值来源：{row.sharedOrigin.description}
								{row.sharedOrigin.fieldVersion !== undefined
									? ` · 字段版本 ${row.sharedOrigin.fieldVersion}`
									: ""}
								{row.sharedOrigin.changeId ? ` · 变更 ${row.sharedOrigin.changeId}` : ""}
							</p>
							{row.sharedOrigin.sourceEvidence && (
								<CodexConfigurationSourceEvidenceView
									evidence={row.sharedOrigin.sourceEvidence}
									label="共享方"
								/>
							)}
						</div>
					)}
				</div>
			))}
		</div>
	);
}

export function CodexConfigurationFullComparisonControls({
	details,
}: {
	details: ReturnType<typeof useCodexConfigurationChangeDetails>;
}) {
	return (
		<div className="my-2">
			<Button
				size="sm"
				variant="ghost"
				aria-expanded={details.expanded}
				onClick={() => details.setExpanded(!details.expanded)}
			>
				{details.expanded ? "收起完整比较" : "展开完整比较"}
			</Button>
			{details.loading && (
				<p role="status" className="text-xs text-text-secondary">
					正在加载完整比较…
				</p>
			)}
			{details.error && (
				<div role="status" className="text-xs text-text-secondary">
					<p>完整比较暂不可读：{details.error}。连接恢复后自动重验，关键差异仍可阅读。</p>
					<Button size="sm" variant="ghost" onClick={details.retry}>
						重试加载完整比较
					</Button>
				</div>
			)}
		</div>
	);
}
