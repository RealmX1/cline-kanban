// 会话流里的「等你拍板」卡片：ACP agent 请求工具授权，或请求批准一份计划（form 型 elicitation）。
// 决策随消息本身持久化（meta.userDecision），所以刷新页面 / 重连之后按钮仍在，不会丢。
import { Check, ShieldQuestion, X } from "lucide-react";
import { type ReactElement, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeTaskAgentUserDecision, RuntimeTaskAgentUserDecisionOption } from "@/runtime/types";

function isRejectOption(option: RuntimeTaskAgentUserDecisionOption): boolean {
	return option.kind.startsWith("reject") || option.kind.startsWith("deny");
}

function resolveOptionLabel(decision: RuntimeTaskAgentUserDecision, optionId: string | null): string {
	if (!optionId) {
		return "";
	}
	return decision.options.find((option) => option.optionId === optionId)?.label ?? optionId;
}

export function TaskAgentUserDecisionBlock({
	taskId,
	decision,
	promptMarkdown,
	onResolveDecision,
}: {
	taskId: string;
	decision: RuntimeTaskAgentUserDecision;
	promptMarkdown: string;
	onResolveDecision: (
		taskId: string,
		decisionId: string,
		optionId: string | null,
	) => Promise<{ ok: boolean; message?: string }>;
}): ReactElement {
	const [isSubmitting, setIsSubmitting] = useState(false);
	const isResolved = decision.resolvedOutcome !== null;

	const submitDecision = async (optionId: string | null): Promise<void> => {
		setIsSubmitting(true);
		try {
			const response = await onResolveDecision(taskId, decision.decisionId, optionId);
			if (!response.ok) {
				notifyError(response.message ?? "Could not send that decision to the agent.");
			}
		} catch (error) {
			notifyError(error instanceof Error ? error.message : String(error));
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="w-full rounded-md border border-status-orange/40 bg-surface-3/70 px-3 py-2 text-sm text-text-primary">
			<div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wide text-status-orange">
				<ShieldQuestion size={12} />
				{decision.kind === "tool_permission" ? "Permission requested" : "Approval requested"}
			</div>
			<ClineMarkdownContent content={promptMarkdown} />
			{isResolved ? (
				<div className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary">
					{decision.resolvedOutcome === "selected" ? <Check size={12} /> : <X size={12} />}
					{decision.resolvedOutcome === "selected"
						? `You chose "${resolveOptionLabel(decision, decision.resolvedOptionId)}"`
						: "Cancelled"}
				</div>
			) : (
				<div className="mt-2 flex flex-wrap gap-1.5">
					{decision.options.map((option) => (
						<Button
							key={option.optionId}
							size="sm"
							variant={isRejectOption(option) ? "danger" : "primary"}
							disabled={isSubmitting}
							onClick={() => {
								void submitDecision(option.optionId);
							}}
							className={cn(isSubmitting && "opacity-60")}
						>
							{option.label}
						</Button>
					))}
				</div>
			)}
		</div>
	);
}
