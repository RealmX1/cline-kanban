import type { Command } from "commander";
import {
	ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS,
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitReferenceRelationKind,
	type AssertedReferenceRelationKindSpecificAttributes,
	REFERENCE_CLAIM_VERIFICATION_VERDICTS,
	REFERENCE_CONCERN_NATURES,
	type ReferenceClaimVerificationVerdict,
	type ReferenceConcernNature,
} from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import {
	isRelationAffectingConfirmableChangeConfirmationStrategy,
	RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES,
	RELATION_ASSERTION_REVOCATION_REASONS,
	type RelationAffectingConfirmableChangeConfirmationStrategy,
	type RelationAssertionRevocationReason,
} from "../core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import {
	parseWorkUnitReferenceCommandLineArgument,
	resolveWorkUnitSelectorOfInvokingProcessEnvironment,
	WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION,
} from "../core/work-unit-reference-command-line-argument";
import type { InterWorkUnitRelationAssertionWriteResponse } from "../core/work-unit-relation-assertion-write-api-contract";
import type { WorkUnitSelectorForRelationRead } from "../core/work-unit-relation-read-api-contract";
import { createRuntimeTrpcClient, printJson } from "./task";

// dd2db `kanban work-unit`（R3.4）：1b 的读动词，加 2.1 的参照断言写动词。关系账本只在 runtime 内打开，所以全部经
// runtime procedure；runtime 离线或账本不可用时如实失败，绝不打印空邻域冒充「没有关系」，也绝不假装写成。
// 写动词的主语一律是调用方自己（由 CLI 声明头里的环境变量解析，不接受 --from/--to）；flag 按对端角色命名（d-vocab §1.4）。

function resolveSubjectWorkUnitSelector(
	workUnitReferenceArgument: string | undefined,
): WorkUnitSelectorForRelationRead {
	if (workUnitReferenceArgument !== undefined) {
		return parseWorkUnitReferenceCommandLineArgument(workUnitReferenceArgument);
	}
	const selectorOfInvokingProcess = resolveWorkUnitSelectorOfInvokingProcessEnvironment(process.env);
	if (!selectorOfInvokingProcess) {
		throw new Error(
			`This process is neither a Kanban task session nor a recognizable agent session; pass the work unit explicitly (${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}).`,
		);
	}
	return selectorOfInvokingProcess;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

async function runWorkUnitCommandPrintingTextOrJson(
	handler: () => Promise<{ text: string } | { json: unknown }>,
): Promise<void> {
	try {
		const output = await handler();
		if ("text" in output) {
			process.stdout.write(`${output.text}\n`);
		} else {
			printJson(output.json);
		}
	} catch (error) {
		printJson({
			ok: false,
			error: `Work unit command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

function collectRepeatableOptionValue(value: string, previousValues: string[]): string[] {
	return [...previousValues, value];
}

// commander 把 `--concerns-behavior-or-state-of` 存成 `concernsBehaviorOrStateOf`。
function toCommanderOptionAttributeName(commandLineFlagName: string): string {
	return commandLineFlagName
		.replace(/^--/u, "")
		.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function parseConfirmationStrategyOption(
	confirmationStrategy: string | undefined,
): RelationAffectingConfirmableChangeConfirmationStrategy | undefined {
	if (confirmationStrategy === undefined) {
		return undefined;
	}
	if (!isRelationAffectingConfirmableChangeConfirmationStrategy(confirmationStrategy)) {
		throw new Error(
			`Unknown --confirmation-strategy "${confirmationStrategy}"; use one of ${RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES.join(", ")}.`,
		);
	}
	return confirmationStrategy;
}

function renderRelationAssertionWriteResponseText(response: InterWorkUnitRelationAssertionWriteResponse): string {
	const headlineByOutcome: Record<
		InterWorkUnitRelationAssertionWriteResponse["relationAssertionWriteOutcome"],
		string
	> = {
		asserted_relation_applied_and_effective: "Asserted (effective now):",
		reassertion_merged_into_already_effective_assertion:
			"Already asserted; merged this assertion's evidence and attributes into the effective relation:",
		effective_relation_assertion_revoked: "Revoked:",
		relation_assertion_was_already_revoked: "Already revoked; nothing changed:",
		dry_run_would_apply_asserted_relation: "Dry run, nothing was written. Would assert:",
		dry_run_would_merge_into_already_effective_assertion:
			"Dry run, nothing was written. Would merge into the effective relation:",
		dry_run_would_revoke_effective_relation_assertion: "Dry run, nothing was written. Would revoke:",
	};
	const lines = [
		headlineByOutcome[response.relationAssertionWriteOutcome],
		`  ${response.relationStatementReadFromSubjectPerspective}`,
		`  (read from the other side: ${response.relationStatementReadFromAnchorPerspective})`,
		`Relation id: ${response.assertedRelation.relationId}`,
	];
	if (response.userRejectionSuppressionTombstoneRecorded) {
		lines.push(
			"Marked as incorrect: asserting the same relation again with no new evidence (and unchanged requirements) is refused.",
		);
	}
	return lines.join("\n");
}

interface AssertReferenceRelationCommandOptions {
	relationAssertionRationale: string;
	evidencePointer: string[];
	concernedAspectSummary?: string;
	concernNature?: string;
	claimUnderVerification: string[];
	claimVerificationVerdict: string;
	reusedOutputPointer: string[];
	reusedOutputSummary?: string;
	originatedRequirementPortionSummary?: string;
	sharedCrossRepositoryContractPointer?: string;
	confirmationStrategy?: string;
	strategySelectionRationale?: string;
	dryRun?: boolean;
	json?: boolean;
	[counterpartRoleOptionAttributeName: string]: unknown;
}

function resolveRelationKindAndCounterpartFromCounterpartRoleFlags(options: AssertReferenceRelationCommandOptions): {
	relationKind: AssertedInterWorkUnitReferenceRelationKind;
	counterpartWorkUnit: WorkUnitSelectorForRelationRead;
} {
	const passedCounterpartRoles = ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS.flatMap((relationKind) => {
		const flagName =
			ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind]
				.assertReferenceRelationCounterpartRoleCommandLineFlagName;
		const counterpartReference = options[toCommanderOptionAttributeName(flagName)];
		return typeof counterpartReference === "string" ? [{ relationKind, flagName, counterpartReference }] : [];
	});
	const [passedCounterpartRole, ...extraCounterpartRoles] = passedCounterpartRoles;
	if (!passedCounterpartRole || extraCounterpartRoles.length > 0) {
		throw new Error(
			`Pass exactly one counterpart role flag (${ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS.map(
				(relationKind) =>
					ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind]
						.assertReferenceRelationCounterpartRoleCommandLineFlagName,
			).join(" | ")}); one invocation asserts one relation.`,
		);
	}
	return {
		relationKind: passedCounterpartRole.relationKind,
		counterpartWorkUnit: parseWorkUnitReferenceCommandLineArgument(passedCounterpartRole.counterpartReference),
	};
}

function buildKindSpecificAttributesFromCommandOptions(
	options: AssertReferenceRelationCommandOptions,
): AssertedReferenceRelationKindSpecificAttributes {
	if (
		options.concernNature !== undefined &&
		!(REFERENCE_CONCERN_NATURES as readonly string[]).includes(options.concernNature)
	) {
		throw new Error(
			`Unknown --concern-nature "${options.concernNature}"; use one of ${REFERENCE_CONCERN_NATURES.join(", ")}.`,
		);
	}
	if (!(REFERENCE_CLAIM_VERIFICATION_VERDICTS as readonly string[]).includes(options.claimVerificationVerdict)) {
		throw new Error(
			`Unknown --claim-verification-verdict "${options.claimVerificationVerdict}"; use one of ${REFERENCE_CLAIM_VERIFICATION_VERDICTS.join(", ")}.`,
		);
	}
	const attributes: AssertedReferenceRelationKindSpecificAttributes = {};
	if (options.concernedAspectSummary !== undefined) attributes.concernedAspectSummary = options.concernedAspectSummary;
	if (options.concernNature !== undefined) attributes.concernNature = options.concernNature as ReferenceConcernNature;
	if (options.claimUnderVerification.length > 0) {
		attributes.claimsUnderVerification = options.claimUnderVerification.map((claimSummary) => ({
			claimSummary,
			verificationVerdict: options.claimVerificationVerdict as ReferenceClaimVerificationVerdict,
		}));
	}
	if (options.reusedOutputPointer.length > 0) attributes.reusedOutputPointers = options.reusedOutputPointer;
	if (options.reusedOutputSummary !== undefined) attributes.reusedOutputSummary = options.reusedOutputSummary;
	if (options.originatedRequirementPortionSummary !== undefined) {
		attributes.originatedRequirementPortionSummary = options.originatedRequirementPortionSummary;
	}
	if (options.sharedCrossRepositoryContractPointer !== undefined) {
		attributes.sharedCrossRepositoryContractPointer = options.sharedCrossRepositoryContractPointer;
	}
	return attributes;
}

export function registerWorkUnitCommand(program: Command): void {
	const workUnit = program
		.command("work-unit")
		.description(
			"Read and assert relations between Kanban work units (task cards and standalone agent sessions). The subject defaults to the invoking session.",
		);

	workUnit
		.command("get-relation-neighborhood-summary")
		.description(
			"Show who created, forked, adopted, dispatched or amended this work unit, which work units it acted on (recorded relations), and the reference relations asserted about it.",
		)
		.option(
			"--work-unit <ref>",
			`Subject work unit: ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		)
		.option("--depth <depth>", "1 = direct neighbors (default); 2 = also the neighbors' own relations.", "1")
		.option("--json", "Print the full structured neighborhood instead of the text summary.")
		.action(async (options: { workUnit?: string; depth: string; json?: boolean }) => {
			await runWorkUnitCommandPrintingTextOrJson(async () => {
				if (options.depth !== "1" && options.depth !== "2") {
					throw new Error(`Unsupported --depth "${options.depth}"; use 1 or 2.`);
				}
				const response = await createRuntimeTrpcClient(null).workUnit.getRelationNeighborhoodSummary.query({
					workUnit: resolveSubjectWorkUnitSelector(options.workUnit),
					relationNeighborhoodDepth: options.depth === "2" ? 2 : 1,
				});
				return options.json
					? { json: { ok: true, ...response } }
					: { text: response.renderedNeighborhoodSummaryText };
			});
		});

	const assertReferenceRelation = workUnit
		.command("assert-reference-relation")
		.description(
			"Record a reference relation from this work unit (always the subject, resolved from the calling session) to another work unit. It takes effect immediately; the other side sees it as a unilateral declaration until the user confirms it. Revoke with revoke-effective-relation-assertion.",
		);
	for (const relationKind of ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS) {
		const registryEntry = ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind];
		assertReferenceRelation.option(
			`${registryEntry.assertReferenceRelationCounterpartRoleCommandLineFlagName} <ref>`,
			`This work unit ${registryEntry.forwardReadingPhraseFromSubject} <ref> (${relationKind}). <ref>: ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		);
	}
	assertReferenceRelation
		.requiredOption("--relation-assertion-rationale <sentence>", "One sentence: why the relation holds.")
		.option(
			"--evidence-pointer <pointer>",
			"Evidence (path, commit, URL, task id); repeatable. Needed to re-assert a relation once marked incorrect.",
			collectRepeatableOptionValue,
			[],
		)
		.option("--concerned-aspect-summary <text>", "concerns: which behavior or state is studied (required).")
		.option("--concern-nature <nature>", `concerns: ${REFERENCE_CONCERN_NATURES.join(" | ")}.`)
		.option(
			"--claim-under-verification <summary>",
			"verifies: a claim being verified (required, repeatable).",
			collectRepeatableOptionValue,
			[],
		)
		.option(
			"--claim-verification-verdict <verdict>",
			`verifies: verdict for the claims passed in this invocation: ${REFERENCE_CLAIM_VERIFICATION_VERDICTS.join(" | ")}.`,
			"pending",
		)
		.option(
			"--reused-output-pointer <pointer>",
			"reuses: an output pointer (repeatable; this or --reused-output-summary is required).",
			collectRepeatableOptionValue,
			[],
		)
		.option("--reused-output-summary <text>", "reuses: what is reused.")
		.option("--originated-requirement-portion-summary <text>", "requirement origin: which part of the requirements.")
		.option(
			"--shared-cross-repository-contract-pointer <pointer>",
			"cross-repository counterpart: the shared contract document (required).",
		)
		.option(
			"--confirmation-strategy <strategy>",
			`Confirmation strategy; defaults to the matched matrix row's default. Only ${RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES[0]} is available in this runtime; others are refused, never silently weakened.`,
		)
		.option(
			"--strategy-selection-rationale <text>",
			"Required when --confirmation-strategy deviates from the row default.",
		)
		.option("--dry-run", "Route and validate, print what would be written, write nothing.")
		.option("--json", "Print the structured response.")
		.action(async (options: AssertReferenceRelationCommandOptions) => {
			await runWorkUnitCommandPrintingTextOrJson(async () => {
				const { relationKind, counterpartWorkUnit } =
					resolveRelationKindAndCounterpartFromCounterpartRoleFlags(options);
				const response = await createRuntimeTrpcClient(
					null,
				).workUnit.assertReferenceRelationAsActingWorkUnit.mutate({
					relationKind,
					counterpartWorkUnit,
					relationAssertionRationaleOneSentence: options.relationAssertionRationale,
					relationAssertionEvidencePointers: options.evidencePointer,
					assertedRelationKindSpecificAttributes: buildKindSpecificAttributesFromCommandOptions(options),
					agentSelectedConfirmationStrategy: parseConfirmationStrategyOption(options.confirmationStrategy),
					strategySelectionRationale: options.strategySelectionRationale,
					dryRunWithoutWritingIntoLedger: options.dryRun === true,
				});
				return options.json
					? { json: { ok: true, ...response } }
					: { text: renderRelationAssertionWriteResponseText(response) };
			});
		});

	workUnit
		.command("revoke-effective-relation-assertion")
		.description(
			"Revoke an asserted relation. relation_ended_naturally leaves no trace; relation_was_incorrect also refuses re-asserting it later without new evidence. Revoking a relation someone else asserted, or one the user agreed to, needs the user (Web UI).",
		)
		.requiredOption(
			"--relation-id <relationId>",
			"The asserted relation id (from get-relation-neighborhood-summary).",
		)
		.requiredOption("--revocation-reason <reason>", `${RELATION_ASSERTION_REVOCATION_REASONS.join(" | ")}.`)
		.option("--confirmation-strategy <strategy>", "Confirmation strategy; defaults to the matched row's default.")
		.option(
			"--strategy-selection-rationale <text>",
			"Required when --confirmation-strategy deviates from the row default.",
		)
		.option("--dry-run", "Route and validate, print what would be written, write nothing.")
		.option("--json", "Print the structured response.")
		.action(
			async (options: {
				relationId: string;
				revocationReason: string;
				confirmationStrategy?: string;
				strategySelectionRationale?: string;
				dryRun?: boolean;
				json?: boolean;
			}) => {
				await runWorkUnitCommandPrintingTextOrJson(async () => {
					if (!(RELATION_ASSERTION_REVOCATION_REASONS as readonly string[]).includes(options.revocationReason)) {
						throw new Error(
							`Unknown --revocation-reason "${options.revocationReason}"; use one of ${RELATION_ASSERTION_REVOCATION_REASONS.join(", ")}.`,
						);
					}
					const response = await createRuntimeTrpcClient(
						null,
					).workUnit.revokeEffectiveRelationAssertionAsActingWorkUnit.mutate({
						relationId: options.relationId,
						relationAssertionRevocationReason: options.revocationReason as RelationAssertionRevocationReason,
						agentSelectedConfirmationStrategy: parseConfirmationStrategyOption(options.confirmationStrategy),
						strategySelectionRationale: options.strategySelectionRationale,
						dryRunWithoutWritingIntoLedger: options.dryRun === true,
					});
					return options.json
						? { json: { ok: true, ...response } }
						: { text: renderRelationAssertionWriteResponseText(response) };
				});
			},
		);

	workUnit
		.command("get-work-unit-context")
		.description("Read the context of a work unit. Only global-recap is available in this phase.")
		.option(
			"--work-unit <ref>",
			`Subject work unit: ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		)
		.requiredOption("--context-level <level>", "Context level: global-recap.")
		.option("--json", "Print the structured response, including completeness and provider availability.")
		.action(async (options: { workUnit?: string; contextLevel: string; json?: boolean }) => {
			await runWorkUnitCommandPrintingTextOrJson(async () => {
				if (options.contextLevel !== "global-recap") {
					throw new Error(
						`Unsupported --context-level "${options.contextLevel}"; only global-recap is available until full-intent-dossier and transcript-excerpt land.`,
					);
				}
				const response = await createRuntimeTrpcClient(null).workUnit.getWorkUnitContext.query({
					workUnit: resolveSubjectWorkUnitSelector(options.workUnit),
					workUnitContextLevel: "global_recap",
				});
				if (options.json || response.globalRecapText === null) {
					return { json: { ok: response.workUnitContextProviderAvailability === "available", ...response } };
				}
				return { text: response.globalRecapText };
			});
		});

	workUnit
		.command("list-conversation-session-ownership-periods")
		.description("List which native agent conversation sessions belonged to a work unit, and when.")
		.option(
			"--of-work-unit <ref>",
			`Work unit whose sessions to list: ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		)
		.action(async (options: { ofWorkUnit?: string }) => {
			await runWorkUnitCommandPrintingTextOrJson(async () => ({
				json: {
					ok: true,
					...(await createRuntimeTrpcClient(null).workUnit.listConversationSessionOwnershipPeriods.query({
						workUnit: resolveSubjectWorkUnitSelector(options.ofWorkUnit),
					})),
				},
			}));
		});
}
