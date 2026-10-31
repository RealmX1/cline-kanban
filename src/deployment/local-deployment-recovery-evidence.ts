import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	readLocalDeploymentExecution,
	readLocalDeploymentExecutionRestriction,
	summarizeLocalDeploymentExecution,
} from "./local-deployment-execution";
import { localDeploymentEffectProofSchema } from "./local-deployment-execution-contract";

const executeReadOnlyEffectObservation = promisify(execFile);
const runtimeProcessRecoveryObservationSchema = z.object({
	result: z.object({
		data: z.object({
			runtimeIdentity: z.object({ runtimeHomeDirectoryPath: z.string(), runtimePort: z.number().int() }),
			runtimeProcessId: z.number().int().positive(),
			runtimeProcessStartTimeText: z.string().min(1),
		}),
	}),
});

/** 只提供唤醒证据，动作资格仍由冻结执行器重新核验；不把采样时间、日志或 nonce 纳入指纹。 */
export async function observeLocalDeploymentRecoveryEvidence(directory: string): Promise<{ evidenceSha256: string }> {
	const record = await readLocalDeploymentExecution(directory);
	const restriction = await readLocalDeploymentExecutionRestriction(directory);
	const analysis = summarizeLocalDeploymentExecution(record, restriction);
	const stage = record.manifest.stages.find((item) => item.stage === analysis.recovery.unfinishedStage);
	let effectObservation = "not_applicable";
	let runtimeProcessIdentity: unknown = "not_observed";
	if (!restriction && !record.finishedOutcome && stage?.effectVerificationCommand) {
		try {
			const command = stage.effectVerificationCommand;
			const { stdout } = await executeReadOnlyEffectObservation(command[0], command.slice(1), {
				cwd: record.manifest.sourceCheckoutPath,
				timeout: 7_000,
				maxBuffer: 1_048_576,
			});
			const proof = localDeploymentEffectProofSchema.safeParse(JSON.parse(stdout));
			effectObservation =
				proof.success &&
				proof.data.executionId === record.manifest.executionId &&
				proof.data.candidateSourceCommit === record.manifest.candidateSourceCommit &&
				proof.data.candidateDistributionSha256 === record.manifest.candidateDistributionSha256
					? "verified"
					: "unverified";
		} catch {
			effectObservation = "unavailable";
		}
	}
	if (!restriction && !record.finishedOutcome) {
		try {
			const identity = record.manifest.runtimeIdentity;
			const origin = new URL(
				`${process.env.KANBAN_RUNTIME_HTTPS === "1" ? "https" : "http"}://${identity.runtimeHost}`,
			);
			origin.port = String(identity.runtimePort);
			const response = await fetch(new URL("/api/trpc/runtime.getAgentSessionPtyHostDiagnostics", origin), {
				signal: AbortSignal.timeout(3_000),
			});
			const observed = runtimeProcessRecoveryObservationSchema.safeParse(await response.json());
			const report = observed.success ? observed.data.result.data : null;
			runtimeProcessIdentity =
				response.ok &&
				report?.runtimeIdentity.runtimeHomeDirectoryPath === identity.runtimeHomeDirectoryPath &&
				report.runtimeIdentity.runtimePort === identity.runtimePort
					? { processId: report.runtimeProcessId, processStartTimeText: report.runtimeProcessStartTimeText }
					: "identity_unproven";
		} catch {
			runtimeProcessIdentity = "unavailable";
		}
	}
	const pendingCommandOriginals = await Promise.all(
		record.observations
			.filter(
				(item) =>
					item.kind === "command_execution_intent_persisted" &&
					!record.observations.some(
						(result) =>
							result.stage === item.stage &&
							result.attemptNumber === item.attemptNumber &&
							["command_not_started", "command_succeeded", "command_failed"].includes(result.kind),
					),
			)
			.map(async (attempt) => {
				try {
					return createHash("sha256")
						.update(await readFile(join(attempt.commandOutputDirectory, "command-result.json")))
						.digest("hex");
				} catch {
					return "unavailable";
				}
			}),
	);
	return {
		evidenceSha256: createHash("sha256")
			.update(
				JSON.stringify({
					executionId: record.manifest.executionId,
					candidateSourceCommit: record.manifest.candidateSourceCommit,
					candidateDistributionSha256: record.manifest.candidateDistributionSha256,
					unfinishedStage: analysis.recovery.unfinishedStage,
					restriction,
					effectObservation,
					runtimeProcessIdentity,
					pendingCommandOriginals,
				}),
			)
			.digest("hex"),
	};
}
