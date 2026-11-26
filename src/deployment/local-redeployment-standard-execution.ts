import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as waitForRuntimeReadiness } from "node:timers/promises";
import {
	type AuthorizedUnretainableHandoverSession,
	authorizedUnretainableHandoverSessionSchema,
	authorizedUnretainableSessionHandoverSchema,
} from "../core/api-contract";
import { getRuntimeFetch } from "../core/runtime-endpoint";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	liveRuntimeAcceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions,
	plannedRedeploymentHandoverDispatch,
} from "../server/authorized-unretainable-session-handover";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { loadPersistedWorkspaceSessionsById, readRegisteredWorkspaceRawSnapshot } from "../state/workspace-state";
import { assertTaskClosureStorageProtocolCompatibleWithDistribution } from "../task-closure/task-closure-storage-protocol-compatibility";
import {
	readProcessIdentity,
	readSystemBootIdentity,
} from "../task-command-execution/task-command-execution-supervisor";
import {
	type HostedSessionRuntimeAdoptionAcceptanceReceipt,
	hostedSessionAdoptionReceiptMatchesDeploymentRestart,
	hostedSessionRuntimeAdoptionAcceptanceReceiptDirectory,
	hostedSessionRuntimeAdoptionAcceptanceReceiptSchema,
} from "../terminal/hosted-session-runtime-adoption-acceptance-receipt";
import { inspectFilesystemLockProtocolTransitionPreflight } from "./filesystem-lock-protocol-transition-preflight";
import {
	fingerprintLocalDeploymentDistribution,
	verifyLocalDeploymentPublishedFiles,
} from "./local-deployment-distribution-manifest";
import { initializeLocalDeploymentExecution, readLocalDeploymentExecution } from "./local-deployment-execution";
import {
	LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES,
	LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER,
	type LocalDeploymentStage,
	localDeploymentCommandOriginalSchema,
	localDeploymentExecutionManifestSchema,
} from "./local-deployment-execution-contract";
import { observeLocalDeploymentRecoveryEvidence } from "./local-deployment-recovery-evidence";
import { readLocalDeploymentTargetStageRecoveryBudget } from "./local-deployment-target-stage-recovery-budget";
import { registerLocalRedeploymentRebuildableArtifact } from "./local-redeployment-failed-attempt-artifact-cleanup";
import { observeLocalRedeploymentBlockingFailureRecovery } from "./local-redeployment-failure-recovery-evidence";
import {
	clearLocalRedeploymentFilesystemEvidenceRequests,
	observeLocalRedeploymentFilesystemEvidence,
	readLocalRedeploymentMachineEvidenceRequests,
	reuseLocalRedeploymentCheck,
} from "./local-redeployment-persistent-checks";
import {
	assertLocalRedeploymentNotRevoked,
	assertLocalRedeploymentOwnerStillEligible,
	createBoundLocalRedeploymentSourceValidationArguments,
	executeLocalRedeploymentFile,
	type FrozenLocalRedeploymentRequest,
	LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME,
	LOCAL_REDEPLOYMENT_SESSION_CONTINUITY_PREFLIGHT_FILENAME,
	LocalRedeploymentIdentityMismatch,
	localRedeploymentAuthorizedOwnerInterruptionSchema,
	localRedeploymentRuntimeBaselineSchema,
	localRedeploymentSha256,
	readBoundPreviousLocalRedeployment,
	readFrozenLocalRedeploymentRequest,
	readLocalRedeploymentJson,
	readLocalRedeploymentSessionInterruptionAuthorization,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";
import { observeLocalRedeploymentRepairValidationEligibility } from "./local-redeployment-repair-continuation";
import { preserveLocalRedeploymentRuntimeRestartAcceptance } from "./local-redeployment-runtime-restart-acceptance";
import {
	backupLocalRedeploymentRuntimeState,
	captureLocalRedeploymentState,
	queryLocalRedeploymentRuntime,
} from "./local-redeployment-state-preservation";

export class LocalRedeploymentQualityFailure extends Error {
	override name = "LocalRedeploymentQualityFailure";
}

export function localRedeploymentStageCommandStatus(
	error: unknown,
): "quality_validation_failed" | "human_decision_required" | "machine_evidence_pending" {
	if (error instanceof LocalRedeploymentIdentityMismatch) return "human_decision_required";
	if (error instanceof LocalRedeploymentQualityFailure) return "quality_validation_failed";
	return "machine_evidence_pending";
}
const normalizeStart = (value: string): string => value.trim().replace(/\s+/gu, " ");

class LocalRedeploymentStandardCommandFailure extends Error {
	readonly stdout: string;
	readonly exitCode: number | null;
	constructor(name: string, original: string, stdout: string, exitCode: number | null) {
		super(`标准部署命令未成功：${name}；原件 ${original}`);
		this.name = "LocalRedeploymentStandardCommandFailure";
		this.stdout = stdout;
		this.exitCode = exitCode;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function canonicalizeInterruptedSessionsForHandover(
	blockingSessions: readonly unknown[],
): { ok: true; interruptedSessions: AuthorizedUnretainableHandoverSession[] } | { ok: false; reason: string } {
	const interruptedSessions: AuthorizedUnretainableHandoverSession[] = [];
	for (const session of blockingSessions) {
		if (!isRecord(session)) return { ok: false, reason: "不可保留会话清单含无法识别的条目" };
		const { workspaceId, conversationSessionId } = session;
		if (typeof workspaceId !== "string" || workspaceId.length === 0) {
			return { ok: false, reason: "不可保留会话缺少工作区身份" };
		}
		if (typeof conversationSessionId !== "string" || conversationSessionId.length === 0) {
			return { ok: false, reason: "不可保留会话缺少会话身份" };
		}
		const processId =
			session.processId === null
				? null
				: typeof session.processId === "number" && Number.isInteger(session.processId) && session.processId > 0
					? session.processId
					: undefined;
		if (processId === undefined) return { ok: false, reason: "不可保留会话缺少可核对的进程身份" };
		const nativeConversationSessionId =
			typeof session.nativeConversationSessionId === "string" ? session.nativeConversationSessionId : null;
		const runtimeSessionIncarnationId =
			typeof session.runtimeSessionIncarnationId === "string" ? session.runtimeSessionIncarnationId : null;
		const sessionKind =
			session.sessionTransport === "acp_stdio_subprocess" || session.sessionTransport === "in_process_cline_sdk"
				? session.sessionTransport
				: session.ownership === "runtime_process"
					? "runtime_process_pty"
					: session.ownership === "ownership_unknown"
						? "ownership_unknown_pty"
						: null;
		if (!sessionKind) return { ok: false, reason: "不可保留会话缺少可绑定的通道或归属" };
		interruptedSessions.push({
			workspaceId,
			conversationSessionId,
			processId,
			nativeConversationSessionId,
			runtimeSessionIncarnationId,
			sessionKind,
		});
	}
	return { ok: true, interruptedSessions };
}

export function resolveAuthorizedOwnerSessionFromBlockingInventory(input: {
	blockingSessions: readonly unknown[];
	workspaceId: string;
	owner: {
		conversationSessionId: string;
		nativeSessionId: string;
		runtimeSessionIncarnationId: string | null;
	};
	persistedOwnerSummary: {
		nativeSessionId: string | null;
		runtimeSessionIncarnationId: string | null;
	} | null;
}):
	| {
			status: "matched";
			session: {
				workspaceId: string;
				conversationSessionId: string;
				nativeConversationSessionId: string;
				runtimeSessionIncarnationId: string | null;
			};
	  }
	| { status: "not_present" }
	| { status: "unconfirmed" } {
	let sawUnconfirmedOwner = false;
	for (const session of input.blockingSessions) {
		if (!isRecord(session)) continue;
		if (session.workspaceId !== input.workspaceId) continue;
		if (session.conversationSessionId !== input.owner.conversationSessionId) continue;
		const identityOnDiagnostic = "nativeConversationSessionId" in session || "runtimeSessionIncarnationId" in session;
		if (identityOnDiagnostic) {
			const native = session.nativeConversationSessionId;
			const incarnation = session.runtimeSessionIncarnationId ?? null;
			if (native === input.owner.nativeSessionId && incarnation === input.owner.runtimeSessionIncarnationId) {
				return {
					status: "matched",
					session: {
						workspaceId: input.workspaceId,
						conversationSessionId: input.owner.conversationSessionId,
						nativeConversationSessionId: input.owner.nativeSessionId,
						runtimeSessionIncarnationId: input.owner.runtimeSessionIncarnationId,
					},
				};
			}
			continue;
		}
		if (session.sessionTransport !== "acp_stdio_subprocess" && session.sessionTransport !== "in_process_cline_sdk") {
			sawUnconfirmedOwner = true;
			continue;
		}
		const persisted = input.persistedOwnerSummary;
		if (
			persisted?.nativeSessionId === input.owner.nativeSessionId &&
			persisted.runtimeSessionIncarnationId === input.owner.runtimeSessionIncarnationId
		) {
			return {
				status: "matched",
				session: {
					workspaceId: input.workspaceId,
					conversationSessionId: input.owner.conversationSessionId,
					nativeConversationSessionId: input.owner.nativeSessionId,
					runtimeSessionIncarnationId: input.owner.runtimeSessionIncarnationId,
				},
			};
		}
		sawUnconfirmedOwner = true;
	}
	return sawUnconfirmedOwner ? { status: "unconfirmed" } : { status: "not_present" };
}

function readNativeHandoverOutcome(stdout: string): {
	outcome?: string;
	runtimeProcessId?: number;
	runtimeProcessStartTimeText?: string;
	authorizedUnretainableSessionHandoverBound?: boolean;
	authorizedUnretainableSessionsAtHandoverAcceptance?: AuthorizedUnretainableHandoverSession[];
} | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as {
			outcome?: unknown;
			runtimeProcessId?: unknown;
			runtimeProcessStartTimeText?: unknown;
			authorizedUnretainableSessionHandoverBound?: unknown;
			authorizedUnretainableSessionsAtHandoverAcceptance?: unknown;
		};
		if (!parsed || typeof parsed !== "object") return null;
		return {
			outcome: typeof parsed.outcome === "string" ? parsed.outcome : undefined,
			runtimeProcessId: typeof parsed.runtimeProcessId === "number" ? parsed.runtimeProcessId : undefined,
			runtimeProcessStartTimeText:
				typeof parsed.runtimeProcessStartTimeText === "string" ? parsed.runtimeProcessStartTimeText : undefined,
			authorizedUnretainableSessionHandoverBound: parsed.authorizedUnretainableSessionHandoverBound === true,
			authorizedUnretainableSessionsAtHandoverAcceptance: authorizedUnretainableHandoverSessionSchema
				.array()
				.safeParse(parsed.authorizedUnretainableSessionsAtHandoverAcceptance).data,
		};
	} catch {
		return null;
	}
}
const candidateCheckout = (directory: string) => join(directory, "candidate-source-checkout");
const frozenExecutor = (directory: string) => join(directory, "frozen-local-redeployment-executor.mjs");

export async function observeLocalRedeploymentRuntimeBaseline(
	frozen: FrozenLocalRedeploymentRequest,
	expectedLoadedEntrypointSha256?: string,
) {
	const request = frozen.request;
	try {
		const report = (await queryLocalRedeploymentRuntime(request, "runtime.getAgentSessionPtyHostDiagnostics")) as {
			runtimeProcessId: number;
			runtimeProcessStartTimeText: string;
			runtimeLoadedEntrypointSha256?: string;
			runtimeIdentity: { runtimeHomeDirectoryPath: string; runtimePort: number };
		};
		if (
			report.runtimeIdentity.runtimeHomeDirectoryPath !== request.runtimeIdentity.runtimeHomeDirectoryPath ||
			report.runtimeIdentity.runtimePort !== request.runtimeIdentity.runtimePort
		)
			throw new Error("监听实例 home 或端口与冻结目标不匹配");
		if (
			expectedLoadedEntrypointSha256 !== undefined &&
			report.runtimeLoadedEntrypointSha256 !== expectedLoadedEntrypointSha256
		)
			return localRedeploymentRuntimeBaselineSchema.parse({
				state: "unknown",
				runtimeBefore: null,
				reason: "监听实例已加载的入口与待登记候选不一致",
			});
		const current = await readProcessIdentity(report.runtimeProcessId);
		if (
			!current ||
			!normalizeStart(current.startAndCommand).startsWith(`${normalizeStart(report.runtimeProcessStartTimeText)} `)
		)
			throw new Error("监听实例原生进程代际尚未核实");
		return localRedeploymentRuntimeBaselineSchema.parse({
			state: "verified_online",
			runtimeBefore: {
				processId: report.runtimeProcessId,
				processStartTimeText: report.runtimeProcessStartTimeText,
			},
		});
	} catch (error) {
		let refused = false;
		try {
			await (await getRuntimeFetch())(
				`http://${request.runtimeIdentity.runtimeHost === "::1" ? "[::1]" : request.runtimeIdentity.runtimeHost}:${request.runtimeIdentity.runtimePort}`,
				{ signal: AbortSignal.timeout(2_000) },
			);
		} catch (connectionError) {
			refused =
				connectionError instanceof Error &&
				"cause" in connectionError &&
				(connectionError.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED";
		}
		if (refused) {
			try {
				let noListener = false;
				const listenerProbeArguments = ["-nP", `-iTCP:${request.runtimeIdentity.runtimePort}`, "-sTCP:LISTEN"];
				const listenerProbeBinaries = process.platform === "darwin" ? ["lsof", "/usr/sbin/lsof"] : ["lsof"];
				for (const binary of listenerProbeBinaries) {
					try {
						await executeLocalRedeploymentFile(binary, listenerProbeArguments, { timeout: 3_000 });
						noListener = false;
						break;
					} catch (nativeError) {
						const code = (nativeError as { code?: number | string }).code;
						if (code === "ENOENT") continue;
						noListener = code === 1;
						break;
					}
				}
				const systemBootIdentity = await readSystemBootIdentity();
				if (noListener && systemBootIdentity)
					return localRedeploymentRuntimeBaselineSchema.parse({
						state: "verified_offline",
						runtimeBefore: null,
						listenerObservation: "connection_refused_and_no_listener",
						systemBootIdentity,
					});
			} catch {
				/* 原生证据不可读时保留未知，不能用超时冒充离线。 */
			}
		}
		return localRedeploymentRuntimeBaselineSchema.parse({
			state: "unknown",
			runtimeBefore: null,
			reason: String(error),
		});
	}
}

type ObservedLocalRedeploymentRuntimeBaseline = Awaited<ReturnType<typeof observeLocalRedeploymentRuntimeBaseline>>;

async function observeLocalRedeploymentSessionContinuity(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	baseline: ObservedLocalRedeploymentRuntimeBaseline,
) {
	const { request } = frozen;
	if (baseline.state !== "verified_online")
		return {
			status: baseline.state === "verified_offline" ? "offline" : "unavailable",
			blockingReasons: baseline.state === "unknown" ? [baseline.reason] : [],
			blockingSessions: [],
			readiness: null,
		};
	let output: string;
	let readinessCommandSucceeded = false;
	const authorization = await readLocalRedeploymentSessionInterruptionAuthorization(directory, frozen);
	try {
		output = (
			await executeLocalRedeploymentFile(
				request.deploymentNodeBinaryPath,
				[
					join(candidateCheckout(directory), "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
					"--candidate-source-commit",
					request.candidateSourceCommit,
					...(authorization ? [] : ["--before-runtime-restart"]),
					"--expected-runtime-process-id",
					String(baseline.runtimeBefore.processId),
				],
				{
					timeout: 10_000,
					maxBuffer: 4_194_304,
					env: {
						...process.env,
						KANBAN_RUNTIME_HOST: request.runtimeIdentity.runtimeHost,
						KANBAN_RUNTIME_PORT: String(request.runtimeIdentity.runtimePort),
					},
				},
			)
		).stdout;
		readinessCommandSucceeded = true;
	} catch (error) {
		output = error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
	}
	try {
		const readiness = JSON.parse(output) as Record<string, unknown>;
		const runtimeIdentity = readiness.runtimeIdentity as Partial<typeof request.runtimeIdentity> | undefined;
		const currentGenerationMatches =
			readiness.runtimeProcessId === baseline.runtimeBefore.processId &&
			normalizeStart(String(readiness.runtimeProcessStartTimeText)) ===
				normalizeStart(baseline.runtimeBefore.processStartTimeText) &&
			runtimeIdentity?.runtimeHomeDirectoryPath === request.runtimeIdentity.runtimeHomeDirectoryPath &&
			runtimeIdentity.runtimePort === request.runtimeIdentity.runtimePort;
		const blockingSessions = Array.isArray(readiness.blockingSessions) ? readiness.blockingSessions : [];
		const blockingReasons = Array.isArray(readiness.failures)
			? readiness.failures.filter((reason: unknown): reason is string => typeof reason === "string")
			: [];
		if (!currentGenerationMatches) blockingReasons.push("连续性诊断尚未核对当前运行代际");
		if (readiness.ok === true && !readinessCommandSucceeded) blockingReasons.push("连续性诊断未成功退出");
		const ready = currentGenerationMatches && readiness.ok === true && readinessCommandSucceeded;
		return {
			status: ready ? "ready" : currentGenerationMatches && readiness.ok === false ? "blocked" : "unavailable",
			blockingReasons,
			blockingSessions,
			readiness: ready
				? { ...readiness, blockingSessions, nonPreservableSessionInterruptionAuthorization: authorization }
				: null,
		};
	} catch {
		return {
			status: "unavailable",
			blockingReasons: ["会话连续性诊断暂不可读"],
			blockingSessions: [],
			readiness: null,
		};
	}
}

async function recordLocalRedeploymentSessionContinuity(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	baseline: ObservedLocalRedeploymentRuntimeBaseline,
) {
	const observation = await observeLocalRedeploymentSessionContinuity(directory, frozen, baseline);
	const checkedAtEpochMs = Date.now();
	const waiting = observation.status === "blocked" || observation.status === "unavailable";
	const receipt = {
		requestSha256: frozen.requestSha256,
		runtimeBaseline: baseline,
		status: observation.status,
		blockingReasons: observation.blockingReasons,
		blockingSessions: observation.blockingSessions,
		checkedAtEpochMs,
		nextCheckAtEpochMs: waiting ? checkedAtEpochMs + 30_000 : null,
		recoveryCondition: waiting
			? "阻塞会话自然退出、登记已获准的会话中断，或当前实例诊断恢复后，重新核验会话与运行代际"
			: null,
	};
	const firstObservationPath = join(directory, "initial-session-continuity-preflight.json");
	if (!existsSync(firstObservationPath)) await writeLocalRedeploymentJson(firstObservationPath, receipt);
	await writeLocalRedeploymentJson(join(directory, LOCAL_REDEPLOYMENT_SESSION_CONTINUITY_PREFLIGHT_FILENAME), receipt);
	return observation;
}

async function requireLocalRedeploymentSessionContinuity(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	baseline: ObservedLocalRedeploymentRuntimeBaseline,
) {
	const observation = await recordLocalRedeploymentSessionContinuity(directory, frozen, baseline);
	await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
	if (observation.status !== "ready" && observation.status !== "offline")
		throw Object.assign(new Error("会话连续性门禁待证，等待会话自然结束或诊断恢复"), {
			verificationCheckKey: "session-readiness",
		});
	return observation.readiness;
}

export async function runLocalRedeploymentStandardCommand(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	name: string,
	command: string[],
	cwd: string,
	acceptCompletedOriginal?: (resultPath: string) => void,
	candidateBuildInputsSha256?: string,
): Promise<string> {
	assertLocalRedeploymentNotRevoked(directory);
	const original = join(directory, "standard-command-originals", `${name}-${randomUUID()}`);
	await mkdir(original, { recursive: true });
	const stdout = await open(join(original, "stdout.txt"), "wx", 0o600);
	const stderr = await open(join(original, "stderr.txt"), "wx", 0o600);
	const startedAtEpochMs = Date.now();
	await writeLocalRedeploymentJson(join(original, "intent.json"), {
		requestSha256: frozen.requestSha256,
		command,
		cwd,
		startedAtEpochMs,
	});
	let exitCode: number | null = null;
	let candidateDistributionVerificationError: unknown;
	try {
		assertLocalRedeploymentNotRevoked(directory);
		exitCode = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(command[0], command.slice(1), {
				cwd,
				stdio: ["ignore", stdout.fd, stderr.fd],
				env: {
					...process.env,
					...(name === "start-bound-service-in-new-tmux-window"
						? { KANBAN_OWNED_COMMAND_EXECUTION_NONCE: undefined }
						: {}),
					PATH: `${dirname(frozen.request.deploymentNodeBinaryPath)}:${process.env.PATH ?? ""}`,
					HUSKY: "0",
					KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY: join(candidateCheckout(directory), "dist"),
					KANBAN_3484_SERVICE_NODE_EXECUTABLE: frozen.request.deploymentNodeBinaryPath,
					KANBAN_3484_SERVICE_REPOSITORY_DIRECTORY: frozen.request.sourceCheckoutPath,
					KANBAN_3484_SERVICE_CLI_ENTRYPOINT: join(frozen.request.distributionDirectoryPath, "cli.js"),
					KANBAN_3484_SERVICE_RUNTIME_PORT: String(frozen.request.runtimeIdentity.runtimePort),
					KANBAN_RUNTIME_HOST: frozen.request.runtimeIdentity.runtimeHost,
					KANBAN_RUNTIME_PORT: String(frozen.request.runtimeIdentity.runtimePort),
				},
			});
			child.once("error", reject);
			child.once("close", resolve);
		});
	} finally {
		await stdout.sync();
		await stderr.sync();
		await stdout.close();
		await stderr.close();
		let completedCandidateBuild: { inputsSha256: string; candidateDistributionSha256: string } | undefined;
		if (exitCode === 0 && candidateBuildInputsSha256) {
			try {
				const expectedDistribution = join(cwd, "dist");
				const distribution = await fingerprintLocalDeploymentDistribution(expectedDistribution);
				if (distribution.distributionDirectoryPath === expectedDistribution)
					completedCandidateBuild = {
						inputsSha256: candidateBuildInputsSha256,
						candidateDistributionSha256: distribution.candidateDistributionSha256,
					};
				else
					candidateDistributionVerificationError = new LocalRedeploymentIdentityMismatch(
						"命令的私有分发目录已改写为外部路径",
					);
			} catch (error) {
				candidateDistributionVerificationError = error;
			}
		}
		await writeLocalRedeploymentJson(join(original, "result.json"), {
			requestSha256: frozen.requestSha256,
			command,
			cwd,
			startedAtEpochMs,
			exitCode,
			finishedAtEpochMs: Date.now(),
			...(completedCandidateBuild ? { completedCandidateBuild } : {}),
			...(candidateDistributionVerificationError
				? { candidateDistributionVerificationError: String(candidateDistributionVerificationError) }
				: {}),
		});
	}
	if (candidateDistributionVerificationError) throw candidateDistributionVerificationError;
	const output = await readFile(join(original, "stdout.txt"), "utf8");
	if (exitCode !== 0) {
		if (name === "source-validation" && output.includes('"quality_validation_failed"'))
			throw new LocalRedeploymentQualityFailure(`源码验证真实失败，读取 ${original}`);
		throw new LocalRedeploymentStandardCommandFailure(name, original, output, exitCode);
	}
	assertLocalRedeploymentNotRevoked(directory);
	acceptCompletedOriginal?.(join(original, "result.json"));
	return output;
}

const importedCandidateBuildOriginalFilename = "previous-candidate-build-command-result.json";
const importedCandidateBuildAcceptanceFilename = "previous-candidate-build-import-receipt.json";

export async function readCompletedCandidateBuildCommandOriginal(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	commandName: string,
	command: string[],
	inputsSha256: string,
): Promise<string | null> {
	const originals = join(directory, "standard-command-originals");
	const checkout = candidateCheckout(directory);
	const results = [];
	const originalEntries = await readdir(originals, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	for (const entry of originalEntries) {
		if (!entry.isDirectory() || !entry.name.startsWith(`${commandName}-`)) continue;
		const path = join(originals, entry.name, "result.json");
		const result = (await readLocalRedeploymentJson(path)) as {
			requestSha256: string;
			command: string[];
			cwd: string;
			exitCode: number | null;
			startedAtEpochMs: number;
			finishedAtEpochMs: number;
			completedCandidateBuild?: { inputsSha256: string; candidateDistributionSha256: string };
		} | null;
		if (
			result?.exitCode === 0 &&
			result.requestSha256 === frozen.requestSha256 &&
			result.cwd === checkout &&
			JSON.stringify(result.command) === JSON.stringify(command) &&
			Number.isFinite(result.finishedAtEpochMs) &&
			result.completedCandidateBuild?.inputsSha256 === inputsSha256 &&
			/^[a-f0-9]{64}$/u.test(result.completedCandidateBuild.candidateDistributionSha256) &&
			(await realpath(path)) === path
		) {
			const intentPath = join(originals, entry.name, "intent.json");
			const intent = (await readLocalRedeploymentJson(intentPath)) as Pick<
				NonNullable<typeof result>,
				"requestSha256" | "command" | "cwd" | "startedAtEpochMs"
			> | null;
			if (
				intent?.requestSha256 !== result.requestSha256 ||
				intent.cwd !== result.cwd ||
				JSON.stringify(intent.command) !== JSON.stringify(command) ||
				!Number.isFinite(result.startedAtEpochMs) ||
				intent.startedAtEpochMs !== result.startedAtEpochMs ||
				result.finishedAtEpochMs < result.startedAtEpochMs ||
				(await realpath(intentPath)) !== intentPath
			)
				continue;
			results.push({ path, result, digest: result.completedCandidateBuild.candidateDistributionSha256 });
		}
	}
	let completed: { path: string; digest: string } | undefined = results.sort(
		(a, b) => b.result.finishedAtEpochMs - a.result.finishedAtEpochMs,
	)[0];
	if (!completed && commandName === "production-build" && frozen.request.previousDeploymentExecution) {
		const acceptance = (await readLocalRedeploymentJson(
			join(directory, importedCandidateBuildAcceptanceFilename),
		)) as {
			requestSha256: string;
			buildCommandResultSha256: string;
		} | null;
		if (acceptance) {
			const path = join(directory, importedCandidateBuildOriginalFilename);
			const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (!bytes) return null;
			const result = JSON.parse(bytes.toString("utf8"));
			if (
				acceptance.requestSha256 !== frozen.requestSha256 ||
				acceptance.buildCommandResultSha256 !== localRedeploymentSha256(bytes) ||
				(await realpath(path)) !== path ||
				result?.exitCode !== 0 ||
				JSON.stringify(result.command) !== JSON.stringify(command) ||
				result.completedCandidateBuild?.inputsSha256 !== inputsSha256 ||
				!/^[a-f0-9]{64}$/u.test(result.completedCandidateBuild.candidateDistributionSha256)
			)
				throw new LocalRedeploymentIdentityMismatch("已接受的前序构建原件与当前冻结请求或构建输入不匹配");
			completed = { path, digest: result.completedCandidateBuild.candidateDistributionSha256 };
		}
	}
	if (!completed) return null;
	const distribution = await fingerprintLocalDeploymentDistribution(join(checkout, "dist"));
	if (
		distribution.distributionDirectoryPath !== join(checkout, "dist") ||
		distribution.candidateDistributionSha256 !== completed.digest
	)
		throw new LocalRedeploymentIdentityMismatch("已完成命令绑定的私有分发产物发生变化");
	return completed.path;
}

interface LocalRedeploymentCandidateBuildReceipt {
	requestSha256: string;
	inputsSha256: string;
	candidateDistributionSha256: string;
	distributionDirectoryPath: string;
	buildCommandResultPath: string;
	buildCommandResultSha256: string;
	nativeAbiResultPath: string;
	nativeAbiResultSha256: string;
}

async function fingerprintLocalRedeploymentCandidateBuildInputs(
	candidate: string,
	frozen: FrozenLocalRedeploymentRequest,
	directory: string,
) {
	const validation = (await readLocalRedeploymentJson(
		join(directory, "source-validation", "source-validation-evidence-reuse-report.json"),
	)) as {
		candidateSourceCommit: string;
		treeOid: string;
		contentManifestSha256: string;
		validationEnvironmentIdentity: unknown;
	} | null;
	if (
		validation?.candidateSourceCommit !== frozen.request.candidateSourceCommit ||
		!validation.treeOid ||
		!validation.contentManifestSha256
	)
		throw new Error("构建缺少与冻结候选匹配的完整源码验证输入");
	const localBuildConfiguration = await Promise.all(
		[".", "web-ui"].flatMap((project) =>
			[".env", ".env.local", ".env.production", ".env.production.local"].map(async (filename) => {
				const path = join(candidate, project, filename);
				const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return null;
					throw error;
				});
				return [project, filename, bytes ? localRedeploymentSha256(bytes) : null];
			}),
		),
	);
	const environment = Object.entries(process.env)
		.filter(
			([key]) =>
				![
					"KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY",
					"KANBAN_OWNED_COMMAND_EXECUTION_NONCE",
					"KANBAN_COMMAND_EXECUTION_ID",
					"KANBAN_COMMAND_EXECUTION_REVOCATION_FILE",
					"PWD",
					"OLDPWD",
					"SHLVL",
					"_",
				].includes(key),
		)
		.sort(([left], [right]) => left.localeCompare(right));
	return localRedeploymentSha256(
		JSON.stringify({
			tree: validation.treeOid,
			content: validation.contentManifestSha256,
			validationEnvironment: validation.validationEnvironmentIdentity,
			environment,
			localBuildConfiguration,
			nodeSha256: localRedeploymentSha256(await readFile(frozen.request.deploymentNodeBinaryPath)),
			npmSha256: localRedeploymentSha256(await readFile(frozen.npmCliEntrypointPath)),
		}),
	);
}

export async function verifyLocalRedeploymentCandidateBuildReceipt(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	receipt: LocalRedeploymentCandidateBuildReceipt,
) {
	const checkout = candidateCheckout(directory);
	const expectedDistribution = join(checkout, "dist");
	if (
		receipt.requestSha256 !== frozen.requestSha256 ||
		receipt.distributionDirectoryPath !== expectedDistribution ||
		(await realpath(expectedDistribution)) !== expectedDistribution ||
		(await fingerprintLocalDeploymentDistribution(expectedDistribution)).candidateDistributionSha256 !==
			receipt.candidateDistributionSha256
	)
		throw new LocalRedeploymentIdentityMismatch("已绑定的候选产物位置或完整摘要变化");
	await verifyLocalRedeploymentCandidateBuildCommandResults(directory, frozen, receipt);
}

async function verifyLocalRedeploymentCandidateBuildCommandResults(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	receipt: LocalRedeploymentCandidateBuildReceipt,
) {
	const checkout = candidateCheckout(directory);
	for (const [path, digest, commandName, expectedCommand] of [
		[
			receipt.buildCommandResultPath,
			receipt.buildCommandResultSha256,
			"production-build",
			[frozen.request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "build"],
		],
		[
			receipt.nativeAbiResultPath,
			receipt.nativeAbiResultSha256,
			"candidate-native-abi",
			[
				frozen.request.deploymentNodeBinaryPath,
				join(checkout, "scripts/verify-notification-archive-native-runtime.mjs"),
			],
		],
	] as const) {
		const bytes = await readFile(path);
		const result = JSON.parse(bytes.toString("utf8"));
		const originalParent = dirname(path);
		const directlyProduced =
			dirname(originalParent) === join(directory, "standard-command-originals") &&
			originalParent.startsWith(join(directory, "standard-command-originals", `${commandName}-`)) &&
			path === join(originalParent, "result.json") &&
			result?.requestSha256 === frozen.requestSha256 &&
			result.cwd === checkout &&
			JSON.stringify(result.command) === JSON.stringify(expectedCommand);
		const importedProductionProof =
			commandName === "production-build" &&
			!!frozen.request.previousDeploymentExecution &&
			path === join(directory, importedCandidateBuildOriginalFilename) &&
			JSON.stringify(result?.command) === JSON.stringify(expectedCommand);
		if (
			(!directlyProduced && !importedProductionProof) ||
			(await realpath(path)) !== path ||
			result?.exitCode !== 0 ||
			localRedeploymentSha256(bytes) !== digest ||
			result.completedCandidateBuild?.inputsSha256 !== receipt.inputsSha256 ||
			result.completedCandidateBuild?.candidateDistributionSha256 !== receipt.candidateDistributionSha256
		)
			throw new LocalRedeploymentIdentityMismatch("构建或原生 ABI 的成功原件与候选回执的输入、分发或归属不匹配");
	}
}

async function preparePrivateCandidate(directory: string, frozen: FrozenLocalRedeploymentRequest): Promise<void> {
	const request = frozen.request;
	const candidate = candidateCheckout(directory);
	await lockedFileSystem.withLock({ path: join(directory, "candidate-preparation-single-flight") }, async () => {
		if (!existsSync(join(candidate, ".git"))) {
			await runLocalRedeploymentStandardCommand(
				directory,
				frozen,
				"private-source-checkout",
				[
					"git",
					"-c",
					"core.hooksPath=/dev/null",
					"-C",
					request.sourceCheckoutPath,
					"worktree",
					"add",
					"--detach",
					candidate,
					request.candidateSourceCommit,
				],
				request.sourceCheckoutPath,
			);
		}
		const head = (
			await executeLocalRedeploymentFile("git", ["--no-optional-locks", "-C", candidate, "rev-parse", "HEAD"])
		).stdout.trim();
		if (head !== request.candidateSourceCommit) throw new Error("私有源码候选与冻结 commit 不一致");
		await recordLocalRedeploymentSessionContinuity(
			directory,
			frozen,
			await observeLocalRedeploymentRuntimeBaseline(frozen),
		);
		for (const path of ["dist", "web-ui/dist", "node_modules", "web-ui/node_modules"]) {
			if (existsSync(join(candidate, path)) && (await lstat(join(candidate, path))).isSymbolicLink())
				throw new Error(`私有构建拒绝共享软链接：${path}`);
		}
		for (const [key, workingDirectory] of [
			["root-dependencies", candidate],
			["web-dependencies", join(candidate, "web-ui")],
		]) {
			const receipt = join(directory, `${key}-receipt.json`);
			if ((await readLocalRedeploymentJson(receipt)) && existsSync(join(workingDirectory, "node_modules"))) continue;
			await runLocalRedeploymentStandardCommand(
				directory,
				frozen,
				key,
				[request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "ci", "--no-audit", "--no-fund"],
				workingDirectory,
			);
			await writeLocalRedeploymentJson(receipt, {
				requestSha256: frozen.requestSha256,
				node: request.deploymentNodeBinaryPath,
			});
		}
		const plan = join(directory, "frozen-source-validation-plan.json");
		await writeLocalRedeploymentJson(plan, {
			schemaVersion: 1,
			commands: [
				{
					name: "runtime-typecheck",
					argv: [request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "typecheck"],
				},
				{
					name: "web-typecheck",
					argv: [request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "web:typecheck"],
				},
				{
					name: "runtime-tests",
					argv: [request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "test"],
					timeoutMs: 3_600_000,
				},
				{
					name: "web-tests",
					argv: [request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "web:test"],
				},
				{
					name: "source-lint",
					argv: [request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "lint"],
				},
			],
		});
		await runLocalRedeploymentStandardCommand(
			directory,
			frozen,
			"source-validation",
			[
				request.deploymentNodeBinaryPath,
				...(await createBoundLocalRedeploymentSourceValidationArguments(directory, frozen)),
				"--validation-plan",
				plan,
			],
			candidate,
		);
		const buildReceiptPath = join(directory, "candidate-build-receipt.json");
		const buildReceipt = (await readLocalRedeploymentJson(
			buildReceiptPath,
		)) as LocalRedeploymentCandidateBuildReceipt | null;
		const inputsSha256 = await fingerprintLocalRedeploymentCandidateBuildInputs(candidate, frozen, directory);
		if (buildReceipt) {
			await verifyLocalRedeploymentCandidateBuildReceipt(directory, frozen, buildReceipt);
			if (buildReceipt.inputsSha256 !== inputsSha256)
				throw new LocalRedeploymentIdentityMismatch("同一执行的构建输入已变化");
			return;
		}
		const buildCommand = [request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "build"];
		const nativeAbiCommand = [
			request.deploymentNodeBinaryPath,
			join(candidate, "scripts/verify-notification-archive-native-runtime.mjs"),
		];
		let buildCommandResultPath = await readCompletedCandidateBuildCommandOriginal(
			directory,
			frozen,
			"production-build",
			buildCommand,
			inputsSha256,
		);
		const predecessor = buildCommandResultPath ? null : await readBoundPreviousLocalRedeployment(directory, frozen);
		const previousDirectory = request.previousDeploymentExecution?.executionDirectory;
		if (!buildCommandResultPath && request.previousDeploymentExecution && !predecessor)
			await writeLocalRedeploymentJson(join(directory, "candidate-build-reuse-observation.json"), {
				previousExecutionId: request.previousDeploymentExecution.executionId,
				status: "previous_execution_ownership_unverified",
				reason: "前序执行缺少本任务代际及工作树实体归属原件，当前执行独立验证、构建和保全",
			});
		if (!buildCommandResultPath && previousDirectory && predecessor) {
			const previousReceipt = (await readLocalRedeploymentJson(
				join(previousDirectory, "candidate-build-receipt.json"),
			)) as LocalRedeploymentCandidateBuildReceipt | null;
			if (previousReceipt?.inputsSha256 === inputsSha256) {
				await verifyLocalRedeploymentCandidateBuildReceipt(previousDirectory, predecessor, previousReceipt);
				const privateDistribution = join(candidate, "dist");
				const alreadyImported = existsSync(privateDistribution);
				const privateCopy = alreadyImported
					? privateDistribution
					: join(directory, `candidate-distribution-import-${randomUUID()}`);
				if (!alreadyImported)
					await cp(previousReceipt.distributionDirectoryPath, privateCopy, {
						recursive: true,
						dereference: false,
					});
				if (
					(await fingerprintLocalDeploymentDistribution(privateCopy)).candidateDistributionSha256 !==
					previousReceipt.candidateDistributionSha256
				)
					throw new LocalRedeploymentIdentityMismatch("私有候选分发清单与前序原件不同");
				if (!alreadyImported) await rename(privateCopy, privateDistribution);
				const previousBuildBytes = await readFile(previousReceipt.buildCommandResultPath);
				const buildCommandResultSha256 = localRedeploymentSha256(previousBuildBytes);
				if (buildCommandResultSha256 !== previousReceipt.buildCommandResultSha256)
					throw new LocalRedeploymentIdentityMismatch("前序构建原件在导入期间发生变化");
				buildCommandResultPath = join(directory, importedCandidateBuildOriginalFilename);
				await writeLocalRedeploymentJson(join(directory, importedCandidateBuildAcceptanceFilename), {
					requestSha256: frozen.requestSha256,
					buildCommandResultSha256,
				});
				await lockedFileSystem.writeTextFileAtomic(buildCommandResultPath, previousBuildBytes.toString("utf8"), {
					durable: true,
					fileMode: 0o600,
				});
			}
			await writeLocalRedeploymentJson(join(directory, "candidate-build-reuse-observation.json"), {
				previousExecutionId: predecessor.request.executionId,
				status: buildCommandResultPath ? "candidate_distribution_reused" : "build_inputs_unmatched",
				reason: buildCommandResultPath ? null : "缺少绑定构建输入的前序回执，或完整树、Node、依赖和构建环境有变化",
			});
		}
		if (!buildCommandResultPath)
			await runLocalRedeploymentStandardCommand(
				directory,
				frozen,
				"production-build",
				buildCommand,
				candidate,
				(path) => {
					buildCommandResultPath = path;
				},
				inputsSha256,
			);
		const distributionBeforeAbi = await fingerprintLocalDeploymentDistribution(join(candidate, "dist"));
		let nativeAbiResultPath = await readCompletedCandidateBuildCommandOriginal(
			directory,
			frozen,
			"candidate-native-abi",
			nativeAbiCommand,
			inputsSha256,
		);
		if (!nativeAbiResultPath)
			await runLocalRedeploymentStandardCommand(
				directory,
				frozen,
				"candidate-native-abi",
				nativeAbiCommand,
				candidate,
				(path) => {
					nativeAbiResultPath = path;
				},
				inputsSha256,
			);
		if (!buildCommandResultPath || !nativeAbiResultPath) throw new Error("构建或 ABI 核验缺少成功原件");
		const distribution = await fingerprintLocalDeploymentDistribution(join(candidate, "dist"));
		if (
			distribution.candidateDistributionSha256 !== distributionBeforeAbi.candidateDistributionSha256 ||
			distribution.distributionDirectoryPath !== join(candidate, "dist")
		)
			throw new LocalRedeploymentIdentityMismatch("ABI 核验时私有分发发生变化");
		const completedBuildReceipt = {
			requestSha256: frozen.requestSha256,
			inputsSha256,
			buildCommandResultPath,
			buildCommandResultSha256: localRedeploymentSha256(await readFile(buildCommandResultPath)),
			nativeAbiResultPath,
			nativeAbiResultSha256: localRedeploymentSha256(await readFile(nativeAbiResultPath)),
			...distribution,
		};
		await verifyLocalRedeploymentCandidateBuildCommandResults(directory, frozen, completedBuildReceipt);
		await writeLocalRedeploymentJson(buildReceiptPath, completedBuildReceipt);
	});
}

export async function initializeStandardLocalRedeployment(directory: string): Promise<void> {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
	assertLocalRedeploymentNotRevoked(directory);
	if (getRuntimeHomePath() !== frozen.request.runtimeIdentity.runtimeHomeDirectoryPath)
		throw new Error("独立执行宿主 HOME 与冻结 runtime home 不一致");
	if (existsSync(join(directory, "local-deployment-execution.json"))) return;
	const baselinePath = join(directory, "runtime-starting-state-evidence.json");
	let baseline = localRedeploymentRuntimeBaselineSchema.safeParse(await readLocalRedeploymentJson(baselinePath));
	if (!baseline.success || baseline.data.state === "unknown") {
		await writeLocalRedeploymentJson(baselinePath, await observeLocalRedeploymentRuntimeBaseline(frozen));
		baseline = localRedeploymentRuntimeBaselineSchema.safeParse(await readLocalRedeploymentJson(baselinePath));
	}
	await preparePrivateCandidate(directory, frozen);
	if (!baseline.success || baseline.data.state === "unknown")
		throw Object.assign(new Error("实例起点身份仍未知，候选已保留，等待原生监听证据恢复"), {
			verificationCheckKey: "native_listener_and_boot_identity",
		});
	const marker = (await readLocalRedeploymentJson(
		join(frozen.request.runtimeIdentity.runtimeHomeDirectoryPath, "last-deployed-source-commit.json"),
	)) as { deployedSourceCommit?: string } | null;
	const candidateDistributionDirectoryPath = join(candidateCheckout(directory), "dist");
	const {
		serviceLaunch: _serviceLaunch,
		sourceValidationEvidenceFilePaths: _sourceEvidence,
		previousDeploymentExecution: _previousExecution,
		nonPreservableSessionInterruptionAuthorization: _sessionInterruptionAuthorization,
		...manifestFields
	} = frozen.request;
	const manifest = localDeploymentExecutionManifestSchema.parse({
		...manifestFields,
		schemaVersion: 2,
		sourceCheckoutPath: candidateCheckout(directory),
		previousDeployedSourceCommit: marker?.deployedSourceCommit ?? null,
		candidateDistributionDirectoryPath,
		candidateDistributionSha256: (await fingerprintLocalDeploymentDistribution(candidateDistributionDirectoryPath))
			.candidateDistributionSha256,
		runtimeBefore: baseline.data.runtimeBefore,
		runtimeStartingState: baseline.data.state,
		runtimeStartingStateEvidenceFilePath: baselinePath,
		redeploymentRequestSha256: frozen.requestSha256,
		stages: LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.map((stage) => ({
			stage,
			command: [
				frozen.request.deploymentNodeBinaryPath,
				frozenExecutor(directory),
				"redeployment-stage",
				"--execution-directory",
				directory,
				"--stage",
				stage,
			],
			...(LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES.has(stage)
				? {
						effectVerificationCommand: [
							frozen.request.deploymentNodeBinaryPath,
							frozenExecutor(directory),
							stage === "build_publication"
								? "verify-publication"
								: stage === "runtime_restart"
									? "verify-runtime-restart"
									: "verify-deployment-record",
							"--execution-directory",
							directory,
						],
						idempotentEffectRecoveryCommand: [
							frozen.request.deploymentNodeBinaryPath,
							frozenExecutor(directory),
							"redeployment-stage",
							"--execution-directory",
							directory,
							"--stage",
							stage,
						],
					}
				: {}),
			recoveryEvidenceFilePaths: [join(directory, "source-validation/source-validation-evidence-reuse-report.json")],
			recoveryEvidenceObservationMode: "semantic_observation_only",
			readOnlyRecoveryEvidenceObservationCommand: [
				frozen.request.deploymentNodeBinaryPath,
				frozenExecutor(directory),
				"observe-redeployment-stage",
				"--execution-directory",
				directory,
				"--stage",
				stage,
			],
		})),
	});
	await initializeLocalDeploymentExecution(directory, manifest);
	await clearLocalRedeploymentFilesystemEvidenceRequests(directory, "candidate_bootstrap");
}

async function verifyBoundFilesystemLockProtocolBeforePublication(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<void> {
	const originalCli = await readFile(join(directory, "preserved-previous-distribution/cli.js"), "utf8");
	const candidateCli = await readFile(join(candidateCheckout(directory), "dist/cli.js"), "utf8");
	const originalUsesKernelLocks = originalCli.includes("filesystem-kernel-write-locks");
	const candidateUsesKernelLocks = candidateCli.includes("filesystem-kernel-write-locks");
	if (originalUsesKernelLocks === candidateUsesKernelLocks) return;
	const inventoryPath = join(directory, "filesystem-lock-protocol-retiring-writer-inventory.json");
	if (!existsSync(inventoryPath))
		throw Object.assign(
			new Error("锁协议切换等待既有迁移 producer 的真实退休写入者清单；不凭 HTTP 健康捏造 admission closed"),
			{ verificationCheckKey: "filesystem-lock-protocol-transition" },
		);
	await runLocalRedeploymentStandardCommand(
		directory,
		frozen,
		"filesystem-lock-protocol-preflight",
		[
			frozen.request.deploymentNodeBinaryPath,
			"--import",
			"tsx",
			join(candidateCheckout(directory), "scripts/verify-filesystem-lock-protocol-transition-preflight.ts"),
			"--retiring-writer-inventory",
			inventoryPath,
			"--evidence-file",
			join(directory, "filesystem-lock-protocol-preflight-readiness.json"),
			"--candidate-source-commit",
			frozen.request.candidateSourceCommit,
			"--runtime-home",
			frozen.request.runtimeIdentity.runtimeHomeDirectoryPath,
			...(!candidateUsesKernelLocks ? ["--rollback-to-legacy-locks"] : []),
		],
		candidateCheckout(directory),
	);
	const evidence = (await readLocalRedeploymentJson(
		join(directory, "filesystem-lock-protocol-preflight-readiness.json"),
	)) as { status?: string } | null;
	if (evidence?.status !== "ready_for_protocol_switch")
		throw Object.assign(new Error("锁协议切换仍待原生补证，禁止发布"), {
			verificationCheckKey: "filesystem-lock-protocol-transition",
		});
}

async function verifyCandidateRuntimeReadiness(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<Record<string, unknown>> {
	const arguments_ = [
		frozen.request.deploymentNodeBinaryPath,
		join(candidateCheckout(directory), "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
		"--candidate-source-commit",
		frozen.request.candidateSourceCommit,
	];
	const output = await runLocalRedeploymentStandardCommand(
		directory,
		frozen,
		"current-runtime-readiness",
		arguments_,
		candidateCheckout(directory),
	).catch((error: unknown) => {
		throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
			verificationCheckKey: "session-readiness",
		});
	});
	const evidence = JSON.parse(output) as Record<string, unknown>;
	if (evidence.ok !== true)
		throw Object.assign(new Error("会话连续性门禁未通过，等待自然结束或等价补证"), {
			verificationCheckKey: "session-readiness",
		});
	if (
		evidence.runtimeLoadedEntrypointSha256 !==
		localRedeploymentSha256(await readFile(join(candidateCheckout(directory), "dist/cli.js")))
	)
		throw new Error("监听进程实际载入的入口与候选产物不一致");
	return evidence;
}

export async function startBoundLocalRedeploymentService(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<void> {
	assertLocalRedeploymentNotRevoked(directory);
	if (
		localRedeploymentSha256(await readFile(frozen.request.serviceLaunch.command[0])) !==
		frozen.serviceExecutableSha256
	)
		throw new Error("冻结服务启动入口内容变化");
	const current = await observeLocalRedeploymentRuntimeBaseline(frozen);
	if (current.state === "verified_online") return;
	if (current.state !== "verified_offline") throw new Error("监听归属仍未知，禁止另起实例");
	const session =
		frozen.request.serviceLaunch.tmuxSessionName ?? `kanban-${frozen.request.runtimeIdentity.runtimePort}`;
	let sessionExists = false;
	try {
		await executeLocalRedeploymentFile("tmux", ["has-session", "-t", session]);
		sessionExists = true;
	} catch (error) {
		if ((error as { code?: number }).code !== 1) throw error;
	}
	let hasLivingStartupPane = false;
	if (sessionExists) {
		const panes = (
			await executeLocalRedeploymentFile("tmux", [
				"list-panes",
				"-s",
				"-t",
				session,
				"-F",
				"#{window_name}\t#{pane_dead}",
			])
		).stdout;
		hasLivingStartupPane = panes
			.split("\n")
			.some((line) => line === `redeploy-${frozen.request.executionId.slice(0, 8)}\t0`);
	}
	const intentPath = join(directory, "service-start-attempts.json");
	const attempts = ((await readLocalRedeploymentJson(intentPath)) ?? []) as Array<{
		systemBootIdentity: string | null;
		state: string;
	}>;
	const systemBootIdentity = await readSystemBootIdentity();
	if (!hasLivingStartupPane) {
		if (attempts.filter((attempt) => attempt.systemBootIdentity === systemBootIdentity).length >= 2)
			throw new LocalRedeploymentQualityFailure(
				"本 boot 的两次服务启动均未成功；保留原 pane 和启动原件供 Agent 修复",
			);
		attempts.push({ systemBootIdentity, state: "dispatch_intent_persisted" });
		await writeLocalRedeploymentJson(intentPath, attempts);
		await runLocalRedeploymentStandardCommand(
			directory,
			frozen,
			"start-bound-service-in-new-tmux-window",
			[
				"tmux",
				...(sessionExists ? ["new-window", "-d", "-t", session] : ["new-session", "-d", "-s", session]),
				"-n",
				`redeploy-${frozen.request.executionId.slice(0, 8)}`,
				"--",
				...frozen.request.serviceLaunch.command,
			],
			frozen.request.sourceCheckoutPath,
		);
	}
	const readinessDeadlineAtEpochMs = Date.now() + 30_000;
	while (Date.now() < readinessDeadlineAtEpochMs) {
		assertLocalRedeploymentNotRevoked(directory);
		if ((await observeLocalRedeploymentRuntimeBaseline(frozen)).state === "verified_online") return;
		await waitForRuntimeReadiness(1_000);
	}
	throw new Error("绑定服务尚未就绪，保留原 tmux pane 与启动原件");
}

async function validateHistoricalSessionAdoption(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<void> {
	const before = (await readLocalRedeploymentJson(join(directory, "before-runtime-restart.json"))) as {
		validatedHostedSessions?: Array<Record<string, unknown>>;
	} | null;
	const originals = before?.validatedHostedSessions ?? [];
	const root = hostedSessionRuntimeAdoptionAcceptanceReceiptDirectory(
		frozen.request.runtimeIdentity.runtimeHomeDirectoryPath,
	);
	const receipts: Array<HostedSessionRuntimeAdoptionAcceptanceReceipt & { originalFilePath: string }> = [];
	if (existsSync(root))
		for (const name of await readdir(root)) {
			if (!name.endsWith(".json")) continue;
			const parsed = hostedSessionRuntimeAdoptionAcceptanceReceiptSchema.safeParse(
				await readLocalRedeploymentJson(join(root, name)),
			);
			if (parsed.success) receipts.push({ ...parsed.data, originalFilePath: join(root, name) });
		}
	const binding = await readLocalDeploymentExecution(directory);
	const restartTargetBaseline = localRedeploymentRuntimeBaselineSchema.safeParse(
		await readLocalRedeploymentJson(join(directory, "runtime-restart-target-baseline.json")),
	);
	const restartIntent = binding.observations.find(
		(observation) =>
			observation.stage === "runtime_restart" && observation.kind === "command_execution_intent_persisted",
	);
	const candidateCliSha256 = localRedeploymentSha256(
		await readFile(join(binding.manifest.candidateDistributionDirectoryPath, "cli.js")),
	);
	const restartAcceptance = (await readLocalRedeploymentJson(join(directory, "runtime-restart-acceptance.json"))) as {
		executionId?: string;
		candidateDistributionSha256?: string;
		observedAtEpochMs?: number;
		runtime?: Record<string, unknown>;
	} | null;
	const accepted = originals.map((original) => {
		const receipt = restartIntent
			? receipts.find((receipt) =>
					hostedSessionAdoptionReceiptMatchesDeploymentRestart({
						receipt,
						originalSession: original,
						candidateEntrypointSha256: candidateCliSha256,
						restartIntentAtEpochMs: restartIntent.observedAtEpochMs,
						previousRuntimeProcessId:
							(restartTargetBaseline.success ? restartTargetBaseline.data.runtimeBefore?.processId : null) ??
							binding.manifest.runtimeBefore?.processId ??
							null,
					}),
				)
			: undefined;
		if (receipt) return { evidenceKind: "structured_runtime_adoption_acceptance", receipt };
		const acceptedRuntime = restartAcceptance?.runtime;
		const acceptedSessions = acceptedRuntime?.validatedHostedSessions;
		const equivalent =
			restartIntent &&
			restartAcceptance?.executionId === binding.manifest.executionId &&
			restartAcceptance.candidateDistributionSha256 === binding.manifest.candidateDistributionSha256 &&
			typeof restartAcceptance.observedAtEpochMs === "number" &&
			restartAcceptance.observedAtEpochMs >= restartIntent.observedAtEpochMs &&
			acceptedRuntime?.runtimeLoadedEntrypointSha256 === candidateCliSha256 &&
			Array.isArray(acceptedSessions) &&
			acceptedSessions.some((session) =>
				[
					"workspaceId",
					"conversationSessionId",
					"hostedSessionKey",
					"hostSocketPath",
					"processId",
					"processStartedAtEpochMs",
					"runtimeSessionIncarnationId",
					"nativeConversationSessionId",
					"hostProcessId",
					"hostProcessStartTimeText",
				].every((field) => original[field] !== undefined && session[field] === original[field]),
			);
		if (equivalent)
			return {
				evidenceKind: "bound_restart_readiness_snapshot",
				originalFilePath: join(directory, "runtime-restart-acceptance.json"),
				originalSession: original,
				exactOriginalAdoptionEventTime: null,
			};
		throw new Error(`原会话历史接管证据待补：${original.workspaceId}/${original.conversationSessionId}`);
	});
	await writeLocalRedeploymentJson(join(directory, "historical-session-adoption-evidence.json"), {
		executionId: frozen.request.executionId,
		candidateSourceCommit: frozen.request.candidateSourceCommit,
		candidateDistributionSha256: binding.manifest.candidateDistributionSha256,
		status: originals.length ? "historical_acceptance_verified" : "not_applicable_without_hosted_baseline",
		accepted,
		naturalInputOutputContinuity: "unknown_until_natural_activity_observed",
	});
}

async function readVerifiedPredecessorBackupDirectories(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<string[]> {
	const stage = "state_preservation";
	const verifiedDirectories: string[] = [];
	const visitedDirectories = new Set([directory]);
	const visitedExecutionIds = new Set([frozen.request.executionId]);
	let successorDirectory = directory;
	let successor = frozen;
	while (successor.request.previousDeploymentExecution) {
		const { executionDirectory: predecessorDirectory, executionId: predecessorExecutionId } =
			successor.request.previousDeploymentExecution;
		if (
			successorDirectory !== directory &&
			(visitedDirectories.has(predecessorDirectory) || visitedExecutionIds.has(predecessorExecutionId))
		)
			break;
		const predecessor = await readBoundPreviousLocalRedeployment(successorDirectory, successor).catch(
			(error: unknown) => {
				if (successorDirectory !== directory && error instanceof LocalRedeploymentIdentityMismatch) return null;
				throw error;
			},
		);
		if (!predecessor) break;
		const record = await readLocalDeploymentExecution(predecessorDirectory).catch(() => null);
		const latest = record?.observations
			.filter(
				(item) =>
					item.stage === stage &&
					["command_execution_intent_persisted", "command_succeeded", "command_failed"].includes(item.kind),
			)
			.at(-1);
		if (
			record?.manifest.schemaVersion !== 2 ||
			record.manifest.executionId !== predecessor.request.executionId ||
			record.manifest.redeploymentRequestSha256 !== predecessor.requestSha256 ||
			!latest ||
			!["command_succeeded", "command_failed"].includes(latest.kind) ||
			latest.commandOutputDirectory !==
				join(predecessorDirectory, "stage-command-originals", stage, `attempt-${latest.attemptNumber}`)
		)
			break;
		const command = localDeploymentCommandOriginalSchema.safeParse(
			await readLocalRedeploymentJson(join(latest.commandOutputDirectory, "command-result.json")).catch(() => null),
		);
		if (
			!command.success ||
			!command.data.processWasStarted ||
			command.data.cwd !== candidateCheckout(predecessorDirectory) ||
			!command.data.processId ||
			(command.data.exitCode === null && !command.data.signal) ||
			command.data.attemptIdentity?.executionId !== predecessor.request.executionId ||
			command.data.attemptIdentity.attemptNumber !== latest.attemptNumber ||
			command.data.attemptIdentity.stage !== stage ||
			command.data.attemptIdentity.commandOutputDirectory !== latest.commandOutputDirectory ||
			JSON.stringify(command.data.command) !==
				JSON.stringify(record.manifest.stages.find((item) => item.stage === stage)?.command)
		)
			break;
		verifiedDirectories.push(predecessorDirectory);
		visitedDirectories.add(predecessorDirectory);
		visitedExecutionIds.add(predecessorExecutionId);
		successorDirectory = predecessorDirectory;
		successor = predecessor;
	}
	return verifiedDirectories;
}

export async function executeStandardLocalRedeploymentStage(
	directory: string,
	stage: LocalDeploymentStage,
): Promise<void> {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
	const { request } = frozen;
	const { manifest } = await readLocalDeploymentExecution(directory);
	if (
		manifest.schemaVersion !== 2 ||
		manifest.redeploymentRequestSha256 !== frozen.requestSha256 ||
		manifest.executionId !== request.executionId
	)
		throw new Error("标准动作与冻结 manifest 身份不一致");
	assertLocalRedeploymentNotRevoked(directory);
	const candidate = candidateCheckout(directory);
	const node = request.deploymentNodeBinaryPath;
	const cli = join(request.distributionDirectoryPath, "cli.js");
	const run = (name: string, command: string[], cwd = candidate) =>
		runLocalRedeploymentStandardCommand(directory, frozen, name, command, cwd);
	if (stage === "candidate_preparation") {
		if (
			(await fingerprintLocalDeploymentDistribution(manifest.candidateDistributionDirectoryPath))
				.candidateDistributionSha256 !== manifest.candidateDistributionSha256
		)
			throw new Error("候选产物变化");
	}
	if (stage === "state_preservation") {
		await requireLocalRedeploymentSessionContinuity(
			directory,
			frozen,
			await observeLocalRedeploymentRuntimeBaseline(frozen),
		);
		const attemptNumber = Number(process.env.KANBAN_LOCAL_DEPLOYMENT_STAGE_ATTEMPT_NUMBER ?? "1");
		if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("复制产物缺少合法尝试身份");
		await registerLocalRedeploymentRebuildableArtifact(directory, {
			kind: "runtime_state_backup_capture_collection",
			stage,
			attemptNumber,
			path: join(directory, "runtime-state-backup-capture-attempts"),
		});
		if (!existsSync(join(directory, "previous-distribution-backup.json")))
			await registerLocalRedeploymentRebuildableArtifact(directory, {
				kind: "previous_distribution_copy",
				stage,
				attemptNumber,
				path: join(directory, "preserved-previous-distribution"),
			});
		try {
			await backupLocalRedeploymentRuntimeState(
				request,
				directory,
				await readVerifiedPredecessorBackupDirectories(directory, frozen),
			);
		} finally {
			if (process.connected) process.send?.("runtime_state_backup_finished", () => undefined);
		}
		if ((await observeLocalRedeploymentRuntimeBaseline(frozen)).state === "verified_online")
			await writeLocalRedeploymentJson(
				join(directory, "runtime-config-before.json"),
				await queryLocalRedeploymentRuntime(request, "runtime.getConfig"),
			);
		await captureLocalRedeploymentState(request, directory, "before-publication", true);
		const readiness = await requireLocalRedeploymentSessionContinuity(
			directory,
			frozen,
			await observeLocalRedeploymentRuntimeBaseline(frozen),
		);
		if (readiness) await writeLocalRedeploymentJson(join(directory, "before-runtime-restart.json"), readiness);
		await run("immediate-candidate-abi", [
			node,
			join(candidate, "scripts/verify-notification-archive-native-runtime.mjs"),
		]);
	}
	if (stage === "build_publication") {
		await assertTaskClosureStorageProtocolCompatibleWithDistribution(
			manifest.candidateDistributionDirectoryPath,
			request.runtimeIdentity.runtimeHomeDirectoryPath,
		);
		const sourcePackage = (await readLocalRedeploymentJson(join(request.sourceCheckoutPath, "package.json"))) as {
			name?: string;
			bin?: { kanban?: string };
		} | null;
		if (
			sourcePackage?.name !== "kanban" ||
			typeof sourcePackage.bin?.kanban !== "string" ||
			resolve(request.sourceCheckoutPath, sourcePackage.bin.kanban) !== cli
		)
			throw new LocalRedeploymentIdentityMismatch(
				"当前源码 package 的 CLI 名称或链接目标与授权发布目录不一致，禁止发布或 relink",
			);
		if (!existsSync(join(directory, "runtime-state-backup-receipt.json"))) throw new Error("发布前缺少持久备份");
		await verifyBoundFilesystemLockProtocolBeforePublication(directory, frozen);
		const needsCandidatePublication = !(await verifyLocalDeploymentPublishedFiles(manifest));
		const staging = join(request.distributionDirectoryPath, `.kanban-redeployment-staging-${request.executionId}`);
		if (needsCandidatePublication) {
			await registerLocalRedeploymentRebuildableArtifact(directory, {
				kind: "publication_staging_copy",
				stage,
				attemptNumber: Number(process.env.KANBAN_LOCAL_DEPLOYMENT_STAGE_ATTEMPT_NUMBER ?? "1"),
				path: staging,
			});
			await mkdir(staging, { recursive: true });
			const fingerprint = await fingerprintLocalDeploymentDistribution(manifest.candidateDistributionDirectoryPath);
			for (const file of fingerprint.files) {
				const destination = join(staging, file.relativeFilePath);
				await mkdir(dirname(destination), { recursive: true });
				await cp(join(manifest.candidateDistributionDirectoryPath, file.relativeFilePath), destination);
			}
		}
		const current = await observeLocalRedeploymentRuntimeBaseline(frozen);
		await requireLocalRedeploymentSessionContinuity(directory, frozen, current);
		if (!existsSync(join(directory, "publication-runtime-baseline.json")))
			await writeLocalRedeploymentJson(join(directory, "publication-runtime-baseline.json"), current);
		if (needsCandidatePublication) {
			await run("promote-bound-candidate", [
				node,
				join(candidate, "scripts/promote-staged-kanban-build-output-into-distribution-directory.mjs"),
				"--staging-directory",
				staging,
				"--distribution-directory",
				request.distributionDirectoryPath,
			]);
			if (!(await verifyLocalDeploymentPublishedFiles(manifest))) throw new Error("发布文件清单尚未完整");
		}
		await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
		await run(
			"preserve-global-cli-link",
			[node, frozen.npmCliEntrypointPath, "link", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
			request.sourceCheckoutPath,
		);
		if ((await realpath(join(dirname(node), "kanban"))) !== (await realpath(cli)))
			throw new Error("实际 Node 的 CLI 链接与冻结目标不一致");
	}
	if (stage === "runtime_restart") {
		await assertTaskClosureStorageProtocolCompatibleWithDistribution(
			request.distributionDirectoryPath,
			request.runtimeIdentity.runtimeHomeDirectoryPath,
		);
		let restartBaseline: typeof manifest.runtimeBefore = null;
		await run(
			"published-runtime-abi",
			[node, join(request.sourceCheckoutPath, "scripts/verify-notification-archive-native-runtime.mjs")],
			request.sourceCheckoutPath,
		);
		const current = await observeLocalRedeploymentRuntimeBaseline(frozen);
		if (current.state === "unknown") throw new Error("重启前监听归属未知");
		if (current.state === "verified_online") {
			const diagnostic = (await queryLocalRedeploymentRuntime(
				request,
				"runtime.getAgentSessionPtyHostDiagnostics",
			)) as {
				runtimeProcessId?: number;
				runtimeProcessStartTimeText?: string;
				runtimeLoadedEntrypointSha256?: string;
				acceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions?: boolean;
			};
			if (
				diagnostic.runtimeProcessId !== current.runtimeBefore.processId ||
				normalizeStart(diagnostic.runtimeProcessStartTimeText ?? "") !==
					normalizeStart(current.runtimeBefore.processStartTimeText)
			)
				throw new Error("重启前 runtime 代际已变化，重新核验当前代际后接续");
			if (
				(current.runtimeBefore.processId === manifest.runtimeBefore?.processId &&
					normalizeStart(current.runtimeBefore.processStartTimeText) ===
						normalizeStart(manifest.runtimeBefore.processStartTimeText)) ||
				diagnostic.runtimeLoadedEntrypointSha256 !==
					localRedeploymentSha256(await readFile(join(candidate, "dist/cli.js")))
			) {
				restartBaseline = current.runtimeBefore;
				const readiness = await requireLocalRedeploymentSessionContinuity(directory, frozen, current);
				if (!readiness) throw new Error("原监听实例未通过当前代际核验");
				await writeLocalRedeploymentJson(join(directory, "runtime-restart-target-baseline.json"), current);
				await writeLocalRedeploymentJson(join(directory, "before-runtime-restart.json"), readiness);
				const allowInterruption = readiness.nonPreservableSessionInterruptionAuthorization !== null;
				const blockingSessions = Array.isArray(readiness.blockingSessions) ? readiness.blockingSessions : [];
				const handoverDispatch = plannedRedeploymentHandoverDispatch({
					allowInterruption,
					receiverAcceptsDedicatedProcedure:
						liveRuntimeAcceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions(diagnostic),
					blockingSessionCount: blockingSessions.length,
				});
				if (handoverDispatch === "wait_for_unretainable_sessions") {
					throw new Error("当前 runtime 没有专用交接入口，拒绝用布尔值重启；等这些会话自然结束后重新核验");
				}
				const sendBoundInterruption = handoverDispatch === "send_dedicated_binding";
				const interruptedSessions = sendBoundInterruption
					? canonicalizeInterruptedSessionsForHandover(blockingSessions)
					: { ok: true as const, interruptedSessions: [] };
				if (!interruptedSessions.ok) {
					throw new Error(`${interruptedSessions.reason}，拒绝把中断授权放宽到未核验会话`);
				}
				let persistedOwnerSummary: {
					nativeSessionId: string | null;
					runtimeSessionIncarnationId: string | null;
				} | null = null;
				if (sendBoundInterruption && frozen.owner) {
					try {
						const summary = (
							await loadPersistedWorkspaceSessionsById(request.workspaceId, { requireCompleteRead: true })
						)[frozen.owner.conversationSessionId];
						persistedOwnerSummary = summary
							? {
									nativeSessionId: summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
									runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
								}
							: null;
					} catch {
						persistedOwnerSummary = null;
					}
				}
				const authorizedOwner =
					sendBoundInterruption && frozen.owner
						? resolveAuthorizedOwnerSessionFromBlockingInventory({
								blockingSessions,
								workspaceId: request.workspaceId,
								owner: frozen.owner,
								persistedOwnerSummary,
							})
						: { status: "not_present" as const };
				if (authorizedOwner.status === "unconfirmed") {
					throw new Error("发起会话位于不可保留清单，交接前无法核对原生身份，拒绝重启");
				}
				const handoverArguments = [node, cli, "runtime", "handover-restart"];
				if (sendBoundInterruption) {
					handoverArguments.push(
						"--authorized-unretainable-session-handover",
						JSON.stringify(
							authorizedUnretainableSessionHandoverSchema.parse({
								runtimeProcessId: restartBaseline.processId,
								runtimeProcessStartTimeText: restartBaseline.processStartTimeText,
								interruptedSessions: interruptedSessions.interruptedSessions,
							}),
						),
					);
				}
				handoverArguments.push("--wait-for-successor-seconds", "60");
				let handoverStdout = "";
				try {
					handoverStdout = await run("handover-restart", handoverArguments);
				} catch (error) {
					handoverStdout = error instanceof LocalRedeploymentStandardCommandFailure ? error.stdout : "";
					await writeLocalRedeploymentJson(join(directory, "handover-command-failure.json"), {
						error: String(error),
						historicalCommandFailurePreserved: true,
					});
				}
				const nativeHandover = readNativeHandoverOutcome(handoverStdout);
				if (
					authorizedOwner.status === "matched" &&
					nativeHandover?.outcome === "handover_restart_started" &&
					nativeHandover.runtimeProcessId === restartBaseline.processId &&
					nativeHandover.authorizedUnretainableSessionHandoverBound === true &&
					typeof nativeHandover.runtimeProcessStartTimeText === "string" &&
					normalizeStart(nativeHandover.runtimeProcessStartTimeText) ===
						normalizeStart(restartBaseline.processStartTimeText)
				) {
					const ownerInterruption = localRedeploymentAuthorizedOwnerInterruptionSchema.safeParse({
						requestSha256: frozen.requestSha256,
						dispatchedAtEpochMs: Date.now(),
						runtimeBefore: restartBaseline,
						nativeHandover: {
							outcome: "handover_restart_started",
							runtimeProcessId: nativeHandover.runtimeProcessId,
							runtimeProcessStartTimeText: nativeHandover.runtimeProcessStartTimeText,
							authorizedUnretainableSessionHandoverBound: true,
							authorizedUnretainableSessionsAtHandoverAcceptance:
								nativeHandover.authorizedUnretainableSessionsAtHandoverAcceptance,
						},
						authorizedOwnerSession: authorizedOwner.session,
					});
					if (ownerInterruption.success)
						await writeLocalRedeploymentJson(
							join(directory, LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME),
							ownerInterruption.data,
						);
				}
			}
		}
		const successor = await observeLocalRedeploymentRuntimeBaseline(frozen);
		if (successor.state === "verified_offline") await startBoundLocalRedeploymentService(directory, frozen);
		else if (successor.state !== "verified_online") throw new Error("重启效果仍未知，禁止重复停止或启动");
		const after = await verifyCandidateRuntimeReadiness(directory, frozen);
		if (
			restartBaseline &&
			after.runtimeProcessId === restartBaseline.processId &&
			normalizeStart(String(after.runtimeProcessStartTimeText)) ===
				normalizeStart(restartBaseline.processStartTimeText)
		)
			throw new Error("原 runtime 尚未交接，保留待证");
		await preserveLocalRedeploymentRuntimeRestartAcceptance(directory, manifest, after);
	}
	if (stage === "runtime_validation") {
		const current = await verifyCandidateRuntimeReadiness(directory, frozen);
		const runtimeFingerprint = localRedeploymentSha256(
			JSON.stringify([
				current.runtimeProcessId,
				current.runtimeProcessStartTimeText,
				manifest.candidateDistributionSha256,
			]),
		);
		for (const [key, procedure, input] of [
			["notification-archive", "notificationIntelligence.listArchive", { limit: 1 }],
			["detected-agent-commands", "runtime.getConfig", undefined],
		] as const) {
			const value = await reuseLocalRedeploymentCheck({
				directory,
				checkKey: key,
				inputFingerprint: runtimeFingerprint,
				read: async () => ({
					value: await queryLocalRedeploymentRuntime(request, procedure, undefined, input),
					evidenceSource: procedure,
				}),
				validate: (value): value is Record<string, unknown> =>
					!!value &&
					typeof value === "object" &&
					(key === "notification-archive"
						? "entries" in value &&
							Array.isArray(value.entries) &&
							"totalCount" in value &&
							typeof value.totalCount === "number" &&
							"nextBeforeSequence" in value
						: "detectedCommands" in value && Array.isArray(value.detectedCommands)),
			});
			if (key === "detected-agent-commands") {
				const previous = (await readLocalRedeploymentJson(join(directory, "runtime-config-before.json"))) as {
					detectedCommands?: string[];
				} | null;
				const current = value as { detectedCommands: string[] };
				const missing = (previous?.detectedCommands ?? []).filter(
					(command) => !current.detectedCommands.includes(command),
				);
				if (missing.length)
					throw new LocalRedeploymentQualityFailure(`服务 PATH 丢失原有工具：${missing.join("、")}`);
			}
		}
		await reuseLocalRedeploymentCheck({
			directory,
			checkKey: "homepage-health",
			inputFingerprint: runtimeFingerprint,
			read: async () => {
				const response = await (await getRuntimeFetch())(
					`http://${request.runtimeIdentity.runtimeHost === "::1" ? "[::1]" : request.runtimeIdentity.runtimeHost}:${request.runtimeIdentity.runtimePort}/`,
					{ signal: AbortSignal.timeout(5_000) },
				);
				const html = await response.text();
				if (!response.ok || !/<html[\s>]/iu.test(html)) throw new Error("部署后首页未返回有效 HTML");
				return { value: { ok: true }, evidenceSource: "runtime_http_homepage" };
			},
			validate: (value): value is { ok: true } =>
				!!value && typeof value === "object" && "ok" in value && value.ok === true,
		});
		await validateHistoricalSessionAdoption(directory, frozen);
		const afterInventory = await captureLocalRedeploymentState(request, directory, "after-runtime-validation", false);
		const beforeInventory = (await readLocalRedeploymentJson(
			join(directory, "before-publication/state-and-worktree-inventory.json"),
		)) as typeof afterInventory | null;
		if (!beforeInventory) throw new Error("缺少发布前状态保全清单");
		const changedWorktrees = beforeInventory.worktrees.flatMap((before) => {
			const after = afterInventory.worktrees.find((after) => after.path === before.path);
			if ("missing" in before) return [];
			if (!after || "missing" in after)
				throw new LocalRedeploymentQualityFailure(`部署后工作树路径缺失，保留原始快照供核对：${before.path}`);
			return before.headCommit === after.headCommit &&
				before.statusSha256 === after.statusSha256 &&
				before.diffSha256 === after.diffSha256 &&
				before.stagedSha256 === after.stagedSha256 &&
				JSON.stringify(before.files) === JSON.stringify(after.files)
				? []
				: [
						{
							path: before.path,
							attribution:
								before.path === request.sourceCheckoutPath
									? "source_checkout_changes_require_comparison_with_preserved_content"
									: "concurrent_changes_outside_deployment_working_file_write_set",
							originalSnapshotPreserved: true,
						},
					];
		});
		await writeLocalRedeploymentJson(join(directory, "state-preservation-comparison.json"), {
			changedWorktrees,
			beforeInventoryFilePath: join(directory, "before-publication/state-and-worktree-inventory.json"),
			afterInventoryFilePath: join(directory, "after-runtime-validation/state-and-worktree-inventory.json"),
			mappingChanges: beforeInventory.mappings.filter(
				(before) =>
					JSON.stringify(before.cards) !==
					JSON.stringify(afterInventory.mappings.find((after) => after.workspaceId === before.workspaceId)?.cards),
			),
			parallelChangesAreNotAutomaticallyAttributedToDeployment: true,
		});
		await writeLocalRedeploymentJson(join(directory, "runtime-validation-receipt.json"), {
			requestSha256: frozen.requestSha256,
			runtimeFingerprint,
			historicalAcceptanceAndCurrentStateSeparated: true,
		});
	}
	if (stage === "deployment_record") {
		if (!(await observeLocalRedeploymentRegistrationRecovery(directory, frozen)).recoveryEvidenceReady)
			throw Object.assign(new Error("等待核对当前候选与本次登记身份"), {
				verificationCheckKey: "deployment-registration",
			});
		await run(
			"record-deployment",
			[node, cli, "deployment", "record", "--execution-directory", directory],
			request.sourceCheckoutPath,
		).catch((error: unknown) => {
			throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
				verificationCheckKey: "deployment-registration",
			});
		});
	}
	// 清理意图已在复制前登记；实际删除由通用退出后 argv 核验全部子进程退出后接续。
	if (stage === "task_comment") {
		await lockedFileSystem.writeTextFileAtomic(
			join(directory, "deployment-result-task-comment.txt"),
			`本地重部署已完成，源 commit ${request.candidateSourceCommit}；执行原件 ${directory}`,
			{ durable: true, fileMode: 0o600 },
		);
		if (frozen.owner)
			await run(
				"append-idempotent-task-comment",
				[
					node,
					cli,
					"task",
					"append-comment",
					"--task-id",
					request.taskId,
					"--comment-id",
					request.executionId,
					"--comment-file",
					join(directory, "deployment-result-task-comment.txt"),
					"--project-path",
					request.sourceCheckoutPath,
				],
				request.sourceCheckoutPath,
			).catch((error: unknown) => {
				throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
					verificationCheckKey: "task-comment",
				});
			});
	}
}

async function observeBoundFilesystemLockProtocol(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<{ inventorySha256: string | null; status: string }> {
	const inventoryPath = join(directory, "filesystem-lock-protocol-retiring-writer-inventory.json");
	let inventoryText: string | null = null;
	try {
		inventoryText = await readFile(inventoryPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return { inventorySha256: null, status: "evidence_unavailable" };
	}
	const inventorySha256 = inventoryText === null ? null : localRedeploymentSha256(inventoryText);
	let direction: "activate_kernel_write_locks" | "rollback_to_legacy_locks" | "unchanged" | null = null;
	try {
		const originalCli = await readFile(join(directory, "preserved-previous-distribution/cli.js"), "utf8");
		const candidateCli = await readFile(join(candidateCheckout(directory), "dist/cli.js"), "utf8");
		const originalUsesKernelLocks = originalCli.includes("filesystem-kernel-write-locks");
		const candidateUsesKernelLocks = candidateCli.includes("filesystem-kernel-write-locks");
		direction =
			originalUsesKernelLocks === candidateUsesKernelLocks
				? "unchanged"
				: candidateUsesKernelLocks
					? "activate_kernel_write_locks"
					: "rollback_to_legacy_locks";
	} catch {
		direction = null;
	}
	if (direction === "unchanged") return { inventorySha256: null, status: "protocol_unchanged" };
	if (inventoryText === null) return { inventorySha256: null, status: "missing" };
	if (!direction) return { inventorySha256, status: "evidence_unavailable" };
	try {
		const assessment = await inspectFilesystemLockProtocolTransitionPreflight({
			inventory: JSON.parse(inventoryText),
			expectedCandidateSourceCommit: frozen.request.candidateSourceCommit,
			expectedRuntimeHomeDirectoryPath: frozen.request.runtimeIdentity.runtimeHomeDirectoryPath,
			direction,
		});
		return { inventorySha256, status: assessment.status };
	} catch {
		return { inventorySha256, status: "evidence_unavailable" };
	}
}

export async function observeStandardLocalRedeploymentRecoveryEvidence(
	directory: string,
): Promise<{ evidenceSha256: string; recoveryEvidenceReady?: boolean }> {
	if (existsSync(join(directory, "local-deployment-execution.json")))
		return await observeLocalDeploymentRecoveryEvidence(directory);
	return await observeStandardLocalRedeploymentStageRecoveryEvidence(directory, "candidate_bootstrap");
}

async function observeLocalRedeploymentRegistrationRecovery(directory: string, frozen: FrozenLocalRedeploymentRequest) {
	let recoveryEvidenceReady = false;
	let recoveryEvidence: unknown = "unavailable";
	const { manifest, observations } = await readLocalDeploymentExecution(directory);
	if (
		manifest.schemaVersion === 2 &&
		manifest.executionId === frozen.request.executionId &&
		manifest.redeploymentRequestSha256 === frozen.requestSha256 &&
		observations.some((item) => item.stage === "runtime_validation" && item.kind === "command_succeeded")
	) {
		try {
			const runtimeHome = frozen.request.runtimeIdentity.runtimeHomeDirectoryPath;
			const marker = (await readLocalRedeploymentJson(join(runtimeHome, "last-deployed-source-commit.json"))) as {
				deploymentId?: string;
				deployedSourceCommit?: string;
			} | null;
			const state = (await readLocalRedeploymentJson(join(runtimeHome, "post-deploy-verification-state.json"))) as {
				deploymentGroups: Array<{
					deploymentId: string;
					workspaceId: string;
					deployedSourceCommit: string;
					previousDeployedSourceCommit: string | null;
				}>;
			} | null;
			const sameExecutionGroup = state?.deploymentGroups.find(
				(group) => group.deploymentId === manifest.executionId,
			);
			const expectedGroup =
				sameExecutionGroup?.workspaceId === manifest.workspaceId &&
				sameExecutionGroup.deployedSourceCommit === manifest.candidateSourceCommit &&
				sameExecutionGroup.previousDeployedSourceCommit === manifest.previousDeployedSourceCommit;
			const hasPreviousMarker = (marker?.deployedSourceCommit ?? null) === manifest.previousDeployedSourceCommit;
			const liveCandidateMatches =
				!sameExecutionGroup && hasPreviousMarker
					? (
							await observeLocalRedeploymentRuntimeBaseline(
								frozen,
								localRedeploymentSha256(await readFile(join(candidateCheckout(directory), "dist/cli.js"))),
							)
						).state === "verified_online"
					: null;
			recoveryEvidenceReady = sameExecutionGroup ? expectedGroup : liveCandidateMatches === true;
			recoveryEvidence = {
				runtimeValidationAccepted: true,
				liveCandidateMatches,
				markerIdentity: marker ? [marker.deploymentId, marker.deployedSourceCommit] : null,
				sameExecutionRegistration: sameExecutionGroup ? (expectedGroup ? "accepted" : "conflicting") : "absent",
				// 原登记可能已经启动，同一 ID 可在效果探测后补做一次。
				registrationAttempted: observations.some(
					(item) => item.stage === "deployment_record" && item.kind === "command_execution_intent_persisted",
				),
			};
		} catch {
			/* 持久登记状态不可读时维持同一未知条件。 */
		}
	}
	return { evidenceSha256: localRedeploymentSha256(JSON.stringify(recoveryEvidence)), recoveryEvidenceReady };
}

export async function observeStandardLocalRedeploymentStageRecoveryEvidence(
	directory: string,
	activeStage: LocalDeploymentStage | "candidate_bootstrap",
): Promise<{ evidenceSha256: string; recoveryEvidenceReady: boolean }> {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	const revoked =
		existsSync(join(directory, "redeployment-revocation.json")) ||
		existsSync(join(directory, "local-deployment-execution-restriction.json"));
	if (revoked)
		return { evidenceSha256: localRedeploymentSha256("persistently_revoked"), recoveryEvidenceReady: false };
	if (activeStage === "deployment_record") return observeLocalRedeploymentRegistrationRecovery(directory, frozen);
	const targetBudget = await readLocalDeploymentTargetStageRecoveryBudget(frozen.request, activeStage);
	const failure = targetBudget?.blockingFailure;
	if (failure) {
		const repair = await observeLocalRedeploymentRepairValidationEligibility(directory, failure);
		if (repair) return repair;
	}
	if (
		activeStage === "candidate_bootstrap" &&
		failure?.classification === "unclassified_failure" &&
		failure.logicalResource === activeStage &&
		(failure.originalErrorReference === directory ||
			dirname(failure.originalErrorReference) === join(directory, "stage-failure-originals", activeStage))
	) {
		try {
			const candidate = candidateCheckout(directory);
			const inputs = await fingerprintLocalRedeploymentCandidateBuildInputs(candidate, frozen, directory);
			const command = [frozen.request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "build"];
			const original = await readCompletedCandidateBuildCommandOriginal(
				directory,
				frozen,
				"production-build",
				command,
				inputs,
			);
			if (original)
				return { evidenceSha256: localRedeploymentSha256(await readFile(original)), recoveryEvidenceReady: true };
		} catch {
			// 部分构建、工具变化和产物漂移都不能给同一输入补发预算。
		}
	}
	if (failure && failure.classification !== "verification_evidence_pending")
		return observeLocalRedeploymentBlockingFailureRecovery(directory, failure);
	if (failure?.logicalResource === "filesystem-lock-protocol-transition") {
		const protocol = await observeBoundFilesystemLockProtocol(directory, frozen);
		const ready = protocol.status === "protocol_unchanged" || protocol.status === "ready_for_protocol_switch";
		return {
			evidenceSha256: localRedeploymentSha256(
				JSON.stringify({
					logicalResource: failure.logicalResource,
					inventorySha256: protocol.status === "protocol_unchanged" ? null : protocol.inventorySha256,
					status: protocol.status,
				}),
			),
			recoveryEvidenceReady: ready,
		};
	}
	const baseline = await observeLocalRedeploymentRuntimeBaseline(frozen);
	if (activeStage === "task_comment") {
		const execution = await readLocalDeploymentExecution(directory);
		const previouslyAttempted = execution.observations.some(
			(item) => item.stage === "task_comment" && item.kind === "command_failed",
		);
		return {
			evidenceSha256: localRedeploymentSha256(JSON.stringify({ baseline, previouslyAttempted })),
			recoveryEvidenceReady: baseline.state === "verified_online",
		};
	}
	const originalDirectory = failure?.originalErrorReference.includes(
		`${join("stage-failure-originals", activeStage)}/`,
	)
		? dirname(dirname(dirname(failure.originalErrorReference)))
		: directory;
	const originalRequests =
		originalDirectory === directory ? [] : await readLocalRedeploymentMachineEvidenceRequests(originalDirectory);
	const requests = [...(await readLocalRedeploymentMachineEvidenceRequests(directory)), ...originalRequests].filter(
		(request) =>
			request.kind === "filesystem_path"
				? request.stage === activeStage
				: request.stage
					? request.stage === activeStage
					: activeStage === "state_preservation"
						? request.scope === "before-publication"
						: activeStage === "runtime_validation" && request.scope !== "before-publication",
	);
	const machineEvidence = await Promise.all(
		requests.map(async (request) => {
			if (request.kind === "filesystem_path" && request.path)
				return { path: request.path, observation: await observeLocalRedeploymentFilesystemEvidence(request.path) };
			try {
				if (request.checkKey?.startsWith("workspace-state:")) {
					const workspaceId = request.checkKey.slice("workspace-state:".length);
					await readRegisteredWorkspaceRawSnapshot(
						frozen.request.runtimeIdentity.runtimeHomeDirectoryPath,
						workspaceId,
					);
					return { checkKey: request.checkKey, status: "equivalent_snapshot_readable" };
				}
				const procedure =
					request.checkKey === "notification-archive"
						? "notificationIntelligence.listArchive"
						: request.checkKey === "detected-agent-commands"
							? "runtime.getConfig"
							: null;
				if (procedure) {
					const response = (await queryLocalRedeploymentRuntime(
						frozen.request,
						procedure,
						undefined,
						procedure === "notificationIntelligence.listArchive" ? { limit: 1 } : undefined,
					)) as Record<string, unknown>;
					return {
						checkKey: request.checkKey,
						status: Array.isArray(
							procedure === "runtime.getConfig" ? response.detectedCommands : response.entries,
						)
							? "api_contract_available"
							: "unknown",
					};
				}
				if (request.checkKey === "homepage-health") {
					const response = await (await getRuntimeFetch())(
						`http://${frozen.request.runtimeIdentity.runtimeHost === "::1" ? "[::1]" : frozen.request.runtimeIdentity.runtimeHost}:${frozen.request.runtimeIdentity.runtimePort}/`,
						{ signal: AbortSignal.timeout(3_000) },
					);
					return {
						checkKey: request.checkKey,
						status: response.ok && /<html[\s>]/iu.test(await response.text()) ? "html_available" : "unknown",
					};
				}
			} catch {
				/* 缺口未恢复时仍是同一未知状态。 */
			}
			return { checkKey: request.checkKey, status: "unknown" };
		}),
	);
	const semantic = {
		activeStage,
		sessionContinuityWaitRecorded: failure?.logicalResource === "session-readiness",
		machineEvidence,
		baseline: { state: baseline.state },
		sourceValidation: "unknown",
		sessionReadiness: "not_applicable",
	};
	const candidate = candidateCheckout(directory);
	if (["state_preservation", "build_publication", "runtime_restart"].includes(activeStage))
		semantic.sessionReadiness = (await observeLocalRedeploymentSessionContinuity(directory, frozen, baseline)).status;
	if (baseline.state === "verified_online" && activeStage === "runtime_validation") {
		const command = [
			join(candidate, "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
			"--candidate-source-commit",
			frozen.request.candidateSourceCommit,
		];
		let output = "";
		try {
			output = (
				await executeLocalRedeploymentFile(frozen.request.deploymentNodeBinaryPath, command, {
					timeout: 7_000,
					maxBuffer: 1024 * 1024,
					env: {
						...process.env,
						KANBAN_RUNTIME_HOST: frozen.request.runtimeIdentity.runtimeHost,
						KANBAN_RUNTIME_PORT: String(frozen.request.runtimeIdentity.runtimePort),
					},
				})
			).stdout;
		} catch (error) {
			if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") output = error.stdout;
		}
		try {
			const readiness = JSON.parse(output) as Record<string, unknown>;
			semantic.sessionReadiness = readiness.ok === true ? "ready" : "blocked";
		} catch {
			semantic.sessionReadiness = "unavailable";
		}
	}
	if (["candidate_bootstrap", "candidate_preparation"].includes(activeStage) && existsSync(join(candidate, ".git"))) {
		try {
			const response = await executeLocalRedeploymentFile(
				frozen.request.deploymentNodeBinaryPath,
				[
					...(await createBoundLocalRedeploymentSourceValidationArguments(directory, frozen)),
					"--observe-recovery-evidence",
				],
				{ timeout: 7_000, maxBuffer: 1024 * 1024 },
			);
			const result = JSON.parse(response.stdout) as { evidenceSha256: string };
			if (/^[a-f0-9]{64}$/u.test(result.evidenceSha256)) semantic.sourceValidation = result.evidenceSha256;
		} catch {
			/* 观察失败是稳定未知，不用采样时间重置预算。 */
		}
	}
	return {
		evidenceSha256: localRedeploymentSha256(
			JSON.stringify({
				...semantic,
				// 相同的就绪结论可以来自不同进程，只有同一已核验代际才共用会话重试资格。
				...(semantic.sessionContinuityWaitRecorded &&
				semantic.sessionReadiness === "ready" &&
				baseline.runtimeBefore
					? {
							verifiedSessionReadinessRuntimeGeneration: {
								processId: baseline.runtimeBefore.processId,
								processStartTimeText: normalizeStart(baseline.runtimeBefore.processStartTimeText),
							},
						}
					: {}),
			}),
		),
		recoveryEvidenceReady:
			baseline.state !== "unknown" &&
			!["unavailable", "blocked"].includes(semantic.sessionReadiness) &&
			machineEvidence.every((entry) => "status" in entry && entry.status !== "unknown"),
	};
}
