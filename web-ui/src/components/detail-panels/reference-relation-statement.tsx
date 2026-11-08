import {
	type AssertedInterWorkUnitReferenceRelationKind,
	isAssertedInterWorkUnitReferenceRelationKind,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import { NativeSelect } from "@/components/ui/native-select";
import { getCrossProjectCounterpartSelectionProblem } from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";
import {
	getReferenceRelationDirectionLabel,
	getReferenceRelationDirectionSelectionValue,
	getReferenceRelationDisplayLabel,
	isReferenceRelationUndirected,
	MANUALLY_SELECTABLE_TASK_REFERENCE_RELATION_KINDS,
} from "@/hooks/work-unit-relation-kind-display-labels";

// 左右端点固定；选项同时承载关系语义、陈述方向与跨 project 资格。
export function ReferenceRelationStatement({
	relationKind,
	currentTaskIsStatementSubject,
	rootTitle,
	counterpartLabel,
	currentTaskTargetWorkspaceId,
	counterpartCurrentWorkspaceId,
	assertedRelationKindSpecificAttributes,
	onReferenceRelationKindAndDirectionChange,
	disabled,
	selectAriaLabel = "关系及方向",
}: {
	relationKind: string;
	currentTaskIsStatementSubject: boolean;
	rootTitle: string;
	counterpartLabel: string;
	currentTaskTargetWorkspaceId?: string | null;
	counterpartCurrentWorkspaceId?: string | null;
	assertedRelationKindSpecificAttributes?: Record<string, unknown>;
	onReferenceRelationKindAndDirectionChange?: (
		relationKind: AssertedInterWorkUnitReferenceRelationKind,
		currentTaskIsStatementSubject: boolean,
	) => void;
	disabled?: boolean;
	selectAriaLabel?: string;
}) {
	const knownKind = isAssertedInterWorkUnitReferenceRelationKind(relationKind);
	const undirected = isReferenceRelationUndirected(relationKind);
	const relationLabel = knownKind
		? getReferenceRelationDirectionLabel(
				relationKind,
				currentTaskIsStatementSubject,
				assertedRelationKindSpecificAttributes,
			)
		: `${getReferenceRelationDisplayLabel(relationKind, assertedRelationKindSpecificAttributes)} ${currentTaskIsStatementSubject ? "→" : "←"}`;
	const selectableKinds: readonly AssertedInterWorkUnitReferenceRelationKind[] =
		knownKind && !MANUALLY_SELECTABLE_TASK_REFERENCE_RELATION_KINDS.some((kind) => kind === relationKind)
			? [...MANUALLY_SELECTABLE_TASK_REFERENCE_RELATION_KINDS, relationKind]
			: MANUALLY_SELECTABLE_TASK_REFERENCE_RELATION_KINDS;
	const options = selectableKinds.flatMap((kind) =>
		(isReferenceRelationUndirected(kind) ? [true] : [true, false]).map((subject) => ({
			relationKind: kind,
			currentTaskIsStatementSubject: subject,
			value: getReferenceRelationDirectionSelectionValue(kind, subject),
			label: getReferenceRelationDirectionLabel(
				kind,
				subject,
				kind === relationKind ? assertedRelationKindSpecificAttributes : undefined,
			),
			disabled: Boolean(
				getCrossProjectCounterpartSelectionProblem(
					kind,
					currentTaskTargetWorkspaceId,
					counterpartCurrentWorkspaceId,
				),
			),
		})),
	);
	return (
		<div
			data-relation-statement-preview=""
			className="flex min-w-0 flex-col gap-2 @min-[700px]:flex-row @min-[700px]:items-center"
		>
			<span className="min-w-0 flex-1 break-words">本 Task：{rootTitle}</span>
			<div className="flex min-w-0 items-center gap-1">
				{undirected ? <span aria-hidden="true">─</span> : null}
				{onReferenceRelationKindAndDirectionChange ? (
					<NativeSelect
						size="sm"
						aria-label={selectAriaLabel}
						className="min-w-0 max-w-full"
						disabled={disabled}
						value={getReferenceRelationDirectionSelectionValue(relationKind, currentTaskIsStatementSubject)}
						onChange={(event) => {
							const option = options.find((entry) => entry.value === event.target.value);
							if (option && !option.disabled)
								onReferenceRelationKindAndDirectionChange(
									option.relationKind,
									option.currentTaskIsStatementSubject,
								);
						}}
					>
						{options.map((option) => (
							<option key={option.value} value={option.value} disabled={option.disabled}>
								{option.label}
								{option.disabled ? "（仅限不同 project）" : ""}
							</option>
						))}
					</NativeSelect>
				) : (
					<span>{relationLabel}</span>
				)}
				{undirected ? <span aria-hidden="true">─</span> : null}
			</div>
			<span className="min-w-0 flex-1 break-words">已有 Task：{counterpartLabel}</span>
		</div>
	);
}
