import type { RuntimeBoardCard, RuntimeExternalWorkflowRunBinding } from "./api-contract";

export function validateExternalWorkflowRunBindingUpdate(
	card: RuntimeBoardCard,
	binding: RuntimeExternalWorkflowRunBinding,
	workspaceId: string,
	expectedTaskIncarnationCreatedAtEpochMs: number | undefined,
): void {
	if (
		expectedTaskIncarnationCreatedAtEpochMs !== card.createdAt ||
		binding.owningWorkspaceId !== workspaceId ||
		binding.owningTaskId !== card.id ||
		binding.owningTaskIncarnationCreatedAtEpochMs !== card.createdAt
	)
		throw new Error("外部流程引用与当前工作区、任务或代次不符，未写入。");
	const existing = card.externalWorkflowRunBinding;
	if (!existing) return;
	const { lastObservedState: previousObservation, ...previousReference } = existing;
	const { lastObservedState: nextObservation, ...nextReference } = binding;
	if (
		Object.keys(previousReference).some(
			(key) =>
				previousReference[key as keyof typeof previousReference] !==
				nextReference[key as keyof typeof nextReference],
		)
	)
		throw new Error("任务已绑定原外部 Run，不能以替换引用绕过原执行。");
	if (
		previousObservation &&
		(!nextObservation ||
			nextObservation.observedAtEpochMs < previousObservation.observedAtEpochMs ||
			(nextObservation.observedAtEpochMs === previousObservation.observedAtEpochMs &&
				JSON.stringify(nextObservation) !== JSON.stringify(previousObservation)))
	)
		throw new Error("外部流程观察已更新，拒绝倒序或同时间的不同观察。");
}
