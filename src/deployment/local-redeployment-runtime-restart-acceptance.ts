import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readLocalDeploymentExecution } from "./local-deployment-execution";
import type { LocalDeploymentExecutionManifest } from "./local-deployment-execution-contract";
import {
	LocalRedeploymentIdentityMismatch,
	localRedeploymentRuntimeBaselineSchema,
	localRedeploymentSha256,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";

const runtimeRestartAcceptanceSchema = z.object({
	executionId: z.string(),
	candidateDistributionSha256: z.string(),
	observedAtEpochMs: z.number().nonnegative(),
	readinessCommandOriginalDirectoryPath: z.string().optional(),
	runtime: z
		.object({
			ok: z.literal(true),
			runtimeLoadedEntrypointSha256: z.string(),
			runtimeProcessId: z.number().int().positive(),
			runtimeProcessStartTimeText: z.string().min(1),
			runtimeIdentity: z
				.object({ runtimeHomeDirectoryPath: z.string(), runtimePort: z.number().int() })
				.passthrough(),
			validatedHostedSessions: z.array(z.unknown()),
		})
		.passthrough(),
});

const readinessCommandIntentSchema = z.object({
	requestSha256: z.string(),
	command: z.array(z.string()),
	cwd: z.string(),
	startedAtEpochMs: z.number().nonnegative(),
});
const successfulReadinessCommandResultSchema = readinessCommandIntentSchema.extend({
	exitCode: z.literal(0),
	finishedAtEpochMs: z.number().nonnegative(),
});

function runtimeMatchesFrozenCandidate(
	runtime: z.infer<typeof runtimeRestartAcceptanceSchema.shape.runtime>,
	manifest: LocalDeploymentExecutionManifest,
	candidateEntrypointSha256: string,
): boolean {
	return (
		runtime.runtimeIdentity.runtimeHomeDirectoryPath === manifest.runtimeIdentity.runtimeHomeDirectoryPath &&
		runtime.runtimeIdentity.runtimePort === manifest.runtimeIdentity.runtimePort &&
		runtime.runtimeLoadedEntrypointSha256 === candidateEntrypointSha256
	);
}

async function recoverSuccessfulReadinessCommandOriginal(
	directory: string,
	manifest: LocalDeploymentExecutionManifest,
	candidateEntrypointSha256: string,
): Promise<z.infer<typeof runtimeRestartAcceptanceSchema> | null> {
	if (manifest.schemaVersion !== 2) return null;
	const record = await readLocalDeploymentExecution(directory);
	if (
		record.manifest.executionId !== manifest.executionId ||
		record.manifest.schemaVersion !== 2 ||
		record.manifest.redeploymentRequestSha256 !== manifest.redeploymentRequestSha256 ||
		record.manifest.candidateDistributionSha256 !== manifest.candidateDistributionSha256
	)
		throw new LocalRedeploymentIdentityMismatch("部署阶段原件与本次冻结执行不匹配");
	const restartIntent = record.observations.find(
		(observation) =>
			observation.stage === "runtime_restart" && observation.kind === "command_execution_intent_persisted",
	);
	if (!restartIntent) return null;
	const restartTargetBaseline = localRedeploymentRuntimeBaselineSchema.safeParse(
		await readLocalRedeploymentJson(join(directory, "runtime-restart-target-baseline.json")),
	);
	const previousRuntime =
		restartTargetBaseline.success && restartTargetBaseline.data.state === "verified_online"
			? restartTargetBaseline.data.runtimeBefore
			: manifest.runtimeBefore;
	const originalsRoot = join(directory, "standard-command-originals");
	const originalEntries = await readdir(originalsRoot, { withFileTypes: true }).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	const expectedCommand = [
		manifest.deploymentNodeBinaryPath,
		join(manifest.sourceCheckoutPath, "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
		"--candidate-source-commit",
		manifest.candidateSourceCommit,
	];
	let earliestAcceptance: z.infer<typeof runtimeRestartAcceptanceSchema> | null = null;
	for (const entry of originalEntries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory() || !entry.name.startsWith("current-runtime-readiness-")) continue;
		const originalDirectory = join(originalsRoot, entry.name);
		try {
			if (
				!(
					await Promise.all(
						["intent.json", "result.json", "stdout.txt"].map((name) => lstat(join(originalDirectory, name))),
					)
				).every((metadata) => metadata.isFile())
			)
				continue;
			const intent = readinessCommandIntentSchema.safeParse(
				await readLocalRedeploymentJson(join(originalDirectory, "intent.json")),
			);
			const result = successfulReadinessCommandResultSchema.safeParse(
				await readLocalRedeploymentJson(join(originalDirectory, "result.json")),
			);
			if (
				!intent.success ||
				!result.success ||
				[intent.data, result.data].some(
					(command) =>
						command.requestSha256 !== manifest.redeploymentRequestSha256 ||
						command.cwd !== manifest.sourceCheckoutPath ||
						JSON.stringify(command.command) !== JSON.stringify(expectedCommand),
				) ||
				intent.data.startedAtEpochMs !== result.data.startedAtEpochMs ||
				intent.data.startedAtEpochMs < restartIntent.observedAtEpochMs ||
				result.data.finishedAtEpochMs < result.data.startedAtEpochMs
			)
				continue;
			const runtime = runtimeRestartAcceptanceSchema.shape.runtime.safeParse(
				JSON.parse(await readFile(join(originalDirectory, "stdout.txt"), "utf8")),
			);
			if (!runtime.success || !runtimeMatchesFrozenCandidate(runtime.data, manifest, candidateEntrypointSha256))
				continue;
			if (
				previousRuntime &&
				runtime.data.runtimeProcessId === previousRuntime.processId &&
				runtime.data.runtimeProcessStartTimeText.trim().replace(/\s+/gu, " ") ===
					previousRuntime.processStartTimeText.trim().replace(/\s+/gu, " ")
			)
				continue;
			if (earliestAcceptance && earliestAcceptance.observedAtEpochMs <= result.data.finishedAtEpochMs) continue;
			earliestAcceptance = {
				executionId: manifest.executionId,
				candidateDistributionSha256: manifest.candidateDistributionSha256,
				observedAtEpochMs: result.data.finishedAtEpochMs,
				readinessCommandOriginalDirectoryPath: originalDirectory,
				runtime: runtime.data,
			};
		} catch (error) {
			if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
	return earliestAcceptance;
}

export async function preserveLocalRedeploymentRuntimeRestartAcceptance(
	directory: string,
	manifest: LocalDeploymentExecutionManifest,
	runtime: Record<string, unknown>,
): Promise<void> {
	const path = join(directory, "runtime-restart-acceptance.json");
	const existing = await readLocalRedeploymentJson(path);
	const candidateEntrypointSha256 = localRedeploymentSha256(
		await readFile(join(manifest.candidateDistributionDirectoryPath, "cli.js")),
	);
	const acceptance = runtimeRestartAcceptanceSchema.parse(
		existing ??
			(await recoverSuccessfulReadinessCommandOriginal(directory, manifest, candidateEntrypointSha256)) ?? {
				executionId: manifest.executionId,
				candidateDistributionSha256: manifest.candidateDistributionSha256,
				observedAtEpochMs: Date.now(),
				runtime,
			},
	);
	if (
		acceptance.executionId !== manifest.executionId ||
		acceptance.candidateDistributionSha256 !== manifest.candidateDistributionSha256 ||
		!runtimeMatchesFrozenCandidate(acceptance.runtime, manifest, candidateEntrypointSha256)
	)
		throw new LocalRedeploymentIdentityMismatch("重启接受快照与本次冻结候选或运行实例不匹配");
	// 后续正常回收不覆盖已经核实的历史会话接受原件。
	if (existing === null) await writeLocalRedeploymentJson(path, acceptance);
}
