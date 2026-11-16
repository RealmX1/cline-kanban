import { isAbsolute } from "node:path";
import { z } from "zod";
import { taskCommandExecutionSpecificationSchema } from "../core/task-command-execution-contract";

export const LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER = [
	"candidate_preparation",
	"state_preservation",
	"build_publication",
	"runtime_restart",
	"runtime_validation",
	"deployment_record",
	"staging_cleanup",
	"task_comment",
] as const;

export const LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES = new Set<LocalDeploymentStage>([
	"build_publication",
	"runtime_restart",
	"deployment_record",
]);

export type LocalDeploymentStage = (typeof LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER)[number];
const nonemptyText = z.string().trim().min(1);
const absolutePath = nonemptyText.refine(isAbsolute, "必须使用绝对路径");
const commandArguments = taskCommandExecutionSpecificationSchema.shape.command.refine(
	(argv) => argv[0].length > 0,
	"命令不得为空",
);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourceCommit = z.string().regex(/^[a-f0-9]{40}$/);

export const localDeploymentAcceptedRecordIdentitySchema = z.object({
	ok: z.literal(true),
	deploymentId: z.uuid(),
	deployedSourceCommit: sourceCommit,
});
export const localDeploymentEffectProofSchema = z.object({
	ok: z.literal(true),
	executionId: z.uuid(),
	candidateSourceCommit: sourceCommit,
	candidateDistributionSha256: sha256,
});

export const localDeploymentStageCommandSchema = z.strictObject({
	stage: z.enum(LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER),
	command: commandArguments,
	effectVerificationCommand: commandArguments.optional(),
	idempotentEffectRecoveryCommand: commandArguments.optional(),
	readOnlyRecoveryEvidenceObservationCommand: commandArguments.optional(),
	recoveryEvidenceObservationMode: z.enum(["semantic_observation_only"]).optional(),
	recoveryEvidenceFilePaths: z.array(absolutePath).optional(),
});

const localDeploymentExecutionManifestFieldsSchema = z.strictObject({
	schemaVersion: z.literal(1),
	executionId: z.uuid(),
	workspaceId: nonemptyText,
	taskId: nonemptyText,
	originatingTaskWorktreePath: absolutePath,
	sourceCheckoutPath: absolutePath,
	deploymentNodeBinaryPath: absolutePath,
	candidateSourceCommit: sourceCommit,
	previousDeployedSourceCommit: sourceCommit.nullable(),
	candidateDistributionSha256: sha256,
	candidateDistributionDirectoryPath: absolutePath,
	distributionDirectoryPath: absolutePath,
	runtimeIdentity: z.strictObject({
		runtimeHomeDirectoryPath: absolutePath,
		runtimeHost: nonemptyText,
		runtimePort: z.number().int().min(1).max(65535),
	}),
	runtimeBefore: z.strictObject({ processId: z.number().int().positive(), processStartTimeText: nonemptyText }),
	authorization: z.strictObject({ sourceReference: nonemptyText, userRequestQuote: nonemptyText }),
	stages: z.array(localDeploymentStageCommandSchema).length(LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.length),
});
export const localDeploymentExecutionManifestSchema = z
	.union([
		localDeploymentExecutionManifestFieldsSchema,
		localDeploymentExecutionManifestFieldsSchema.extend({
			schemaVersion: z.literal(2),
			runtimeBefore: localDeploymentExecutionManifestFieldsSchema.shape.runtimeBefore.nullable(),
			runtimeStartingState: z.enum(["verified_online", "verified_offline"]),
			runtimeStartingStateEvidenceFilePath: absolutePath,
			redeploymentRequestSha256: sha256,
		}),
	])
	.superRefine((manifest, context) => {
		if (
			manifest.schemaVersion === 2 &&
			(manifest.runtimeStartingState === "verified_online") !== (manifest.runtimeBefore !== null)
		) {
			context.addIssue({
				code: "custom",
				message: "在线起点必须绑定真实进程，离线起点不能填写虚拟 PID",
				path: ["runtimeBefore"],
			});
		}
		for (const [index, stage] of manifest.stages.entries()) {
			if (stage.stage !== LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER[index]) {
				context.addIssue({ code: "custom", message: "阶段必须按固定顺序完整声明", path: ["stages", index] });
			}
			if (LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage.stage) && !stage.effectVerificationCommand) {
				context.addIssue({
					code: "custom",
					message: "不可重复的动作必须声明效果核验命令",
					path: ["stages", index],
				});
			}
		}
	});

export type LocalDeploymentExecutionManifest = z.infer<typeof localDeploymentExecutionManifestSchema>;
export type LocalDeploymentStageCommand = z.infer<typeof localDeploymentStageCommandSchema>;

export const localDeploymentExecutionRestrictionSchema = z.strictObject({
	kind: z.enum(["permission_revoked", "human_decision_required"]),
	reason: nonemptyText,
	sourceReference: nonemptyText,
});
export type LocalDeploymentExecutionRestriction = z.infer<typeof localDeploymentExecutionRestrictionSchema>;

export const localDeploymentObservationSchema = z.strictObject({
	sequence: z.number().int().positive(),
	stage: z.enum(LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER),
	kind: z.enum([
		"command_execution_intent_persisted",
		"command_succeeded",
		"command_failed",
		"command_not_started",
		"effect_verified",
		"effect_verification_failed",
	]),
	observedAtEpochMs: z.number().nonnegative(),
	attemptNumber: z.number().int().positive(),
	recoveryEvidenceSha256: sha256,
	exitCode: z.number().int().nullable(),
	commandOutputDirectory: absolutePath,
	detail: z.string(),
	commandFailureKind: z
		.enum(["quality_validation_failed", "machine_evidence_pending", "human_decision_required"])
		.optional(),
});

export const localDeploymentExecutionRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	manifest: localDeploymentExecutionManifestSchema,
	createdAtEpochMs: z.number().nonnegative(),
	observations: z.array(localDeploymentObservationSchema),
	finishedOutcome: z.enum(["failed", "rolled_back", "abandoned"]).nullable(),
	retrospective: z.strictObject({
		status: z.enum(["not_requested", "request_material_pending", "pending", "independent_findings_frozen"]),
		analysisFingerprint: sha256.nullable(),
		independentFindingsFilePath: absolutePath.nullable(),
		requestPreparationError: z.string().optional(),
	}),
});

export type LocalDeploymentExecutionRecord = z.infer<typeof localDeploymentExecutionRecordSchema>;
export type LocalDeploymentObservation = z.infer<typeof localDeploymentObservationSchema>;

export const localDeploymentCommandOriginalSchema = z.object({
	command: commandArguments,
	cwd: absolutePath,
	processWasStarted: z.boolean(),
	processId: z.number().int().positive().nullable(),
	exitCode: z.number().int().nullable(),
	startedAtEpochMs: z.number().nonnegative(),
	finishedAtEpochMs: z.number().nonnegative(),
	attemptIdentity: z
		.strictObject({
			executionId: z.uuid(),
			stage: z.enum(LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER),
			attemptNumber: z.number().int().positive(),
			commandOutputDirectory: absolutePath,
		})
		.optional(),
});

export const localDeploymentIndependentFindingsSchema = z.strictObject({
	analysisFingerprint: sha256,
	existingIssueCatalogConsulted: z.literal(false),
	successfulPractices: z.array(nonemptyText).default([]),
	costObservations: z.array(nonemptyText).default([]),
	findings: z.array(
		z.strictObject({
			problemKey: nonemptyText,
			nature: z.enum(["defect", "improvement_proposal"]),
			description: nonemptyText,
			evidenceReferences: z.array(nonemptyText).min(1),
			evidenceStatus: z.enum(["single_observation", "independently_supported", "counter_evidence_present"]),
			findingTargetKind: z
				.enum(["target_repository_behavior", "local_deployment_workflow"])
				.default("local_deployment_workflow"),
			primaryFixRepository: z
				.string()
				.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
				.nullable()
				.default(null),
			sourceTaskScopeRelation: z.enum(["inside_source_task", "outside_source_task", "unknown"]).default("unknown"),
			adoptionDisposition: z.literal("awaiting_triage").default("awaiting_triage"),
		}),
	),
});

export type LocalDeploymentIndependentFindings = z.input<typeof localDeploymentIndependentFindingsSchema>;
