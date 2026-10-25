import type { RuntimePostDeployVerificationDeploymentGroup } from "../core/api-contract";
import type { AssertedInterWorkUnitRelation } from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { InterWorkUnitRelationWorkUnitReference } from "../core/inter-work-unit-relation-ledger-event-contract";
import {
	type PostDeployVerificationEntryReference,
	type PostDeployVerificationFollowUpSourceEntryReference,
	postDeployVerificationFollowUpSourceEntryReferenceSchema,
	type RuntimePostDeployVerificationEntryNavigationTarget,
} from "../core/post-deploy-verification-entry-navigation-contract";

function readOriginEntriesFromRequirementRelation(
	relation: AssertedInterWorkUnitRelation,
): PostDeployVerificationFollowUpSourceEntryReference[] {
	const anchor = relation.relationStatementAnchorWorkUnitRef;
	if (anchor.workUnitType !== "kanban_board_card") return [];
	const attributes = relation.assertedRelationKindSpecificAttributes;
	if (attributes.originatingPostDeployVerificationEntry !== undefined) {
		const parsed = postDeployVerificationFollowUpSourceEntryReferenceSchema.safeParse(
			attributes.originatingPostDeployVerificationEntry,
		);
		if (!parsed.success) return [];
		const source = parsed.data;
		return source.workspaceId === anchor.workspaceId &&
			source.taskId === anchor.taskId &&
			source.taskIncarnationCreatedAtEpochMs === anchor.taskIncarnationCreatedAtEpochMs
			? [source]
			: [];
	}
	// 只兼容旧生成器的完整证据行和摘要首行，不从任务 Prompt 或任意自然语言猜测来源。
	const summary = attributes.originatedRequirementPortionSummary;
	const legacyPointers = [
		...relation.relationAssertionEvidencePointers,
		...(typeof summary === "string" ? [summary.split("\n", 1)[0] ?? ""] : []),
	];
	return legacyPointers.flatMap((pointer) => {
		const match = /^PDV workspace=([^\s=]+) deployment=([^\s=]+) task=([^\s=]+)$/.exec(pointer);
		if (!match || match[1] !== anchor.workspaceId || match[3] !== anchor.taskId || !match[2]) return [];
		return [
			{
				workspaceId: anchor.workspaceId,
				deploymentId: match[2],
				taskId: anchor.taskId,
				taskIncarnationCreatedAtEpochMs: anchor.taskIncarnationCreatedAtEpochMs,
				selectedChecklistItemIds: [],
			},
		];
	});
}

export function resolveTaskPostDeployVerificationEntryNavigationTargetsFromSnapshot(input: {
	workspaceId: string;
	taskId: string;
	deploymentGroups: readonly RuntimePostDeployVerificationDeploymentGroup[];
	subjectWorkUnit: InterWorkUnitRelationWorkUnitReference | null;
	assertedRelations: readonly AssertedInterWorkUnitRelation[];
}): RuntimePostDeployVerificationEntryNavigationTarget[] {
	const targets: RuntimePostDeployVerificationEntryNavigationTarget[] = [];
	const ownGroups = input.deploymentGroups.filter(
		(group) => group.workspaceId === input.workspaceId && group.tasks.some((task) => task.taskId === input.taskId),
	);
	ownGroups.sort(
		(left, right) =>
			Number(left.foldedAtIso !== null) - Number(right.foldedAtIso !== null) ||
			right.deployedAtIso.localeCompare(left.deployedAtIso),
	);
	const ownGroup = ownGroups[0];
	if (ownGroup)
		targets.push({
			entry: { workspaceId: input.workspaceId, deploymentId: ownGroup.deploymentId, taskId: input.taskId },
			navigationKind: "task_own_entry",
			deployedAtIso: ownGroup.deployedAtIso,
			availability: "retained",
			selectedChecklistItemIds: [],
		});
	const subject = input.subjectWorkUnit;
	if (
		subject?.workUnitType !== "kanban_board_card" ||
		subject.workspaceId !== input.workspaceId ||
		subject.taskId !== input.taskId
	)
		return targets;
	const originKeys = new Set<string>();
	for (const relation of input.assertedRelations) {
		const relationSubject = relation.relationStatementSubjectWorkUnitRef;
		if (
			relation.relationKind !== "reference_requirement_originates_from" ||
			relation.assertionEffectivenessState !== "applied_and_effective" ||
			relationSubject.workUnitType !== "kanban_board_card" ||
			relationSubject.workspaceId !== subject.workspaceId ||
			relationSubject.taskId !== subject.taskId ||
			relationSubject.taskIncarnationCreatedAtEpochMs !== subject.taskIncarnationCreatedAtEpochMs
		)
			continue;
		for (const source of readOriginEntriesFromRequirementRelation(relation)) {
			const key = JSON.stringify([source.workspaceId, source.deploymentId, source.taskId]);
			if (originKeys.has(key)) continue;
			originKeys.add(key);
			const group = input.deploymentGroups.find(
				(group) =>
					group.workspaceId === source.workspaceId &&
					group.deploymentId === source.deploymentId &&
					group.tasks.some((task) => task.taskId === source.taskId),
			);
			const entry: PostDeployVerificationEntryReference = {
				workspaceId: source.workspaceId,
				deploymentId: source.deploymentId,
				taskId: source.taskId,
			};
			targets.push({
				entry,
				navigationKind: "follow_up_origin_entry",
				deployedAtIso: group?.deployedAtIso ?? null,
				availability: group ? "retained" : "deployment_record_not_retained",
				selectedChecklistItemIds: source.selectedChecklistItemIds,
			});
		}
	}
	return targets;
}
