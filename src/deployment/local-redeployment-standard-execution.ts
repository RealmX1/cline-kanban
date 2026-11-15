import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as waitForRuntimeReadiness } from "node:timers/promises";
import { getRuntimeFetch } from "../core/runtime-endpoint";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { loadPersistedWorkspaceStateById } from "../state/workspace-state";
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
import {
	fingerprintLocalDeploymentDistribution,
	verifyLocalDeploymentPublishedFiles,
} from "./local-deployment-distribution-manifest";
import { initializeLocalDeploymentExecution, readLocalDeploymentExecution } from "./local-deployment-execution";
import {
	LOCAL_DEPLOYMENT_IRREVERSIBLE_STAGES,
	LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER,
	type LocalDeploymentStage,
	localDeploymentExecutionManifestSchema,
} from "./local-deployment-execution-contract";
import { observeLocalDeploymentRecoveryEvidence } from "./local-deployment-recovery-evidence";
import {
	clearLocalRedeploymentFilesystemEvidenceRequests,
	observeLocalRedeploymentDiskAvailability,
	observeLocalRedeploymentFilesystemEvidence,
	readLocalRedeploymentMachineEvidenceRequests,
	reuseLocalRedeploymentCheck,
} from "./local-redeployment-persistent-checks";
import {
	assertLocalRedeploymentNotRevoked,
	assertLocalRedeploymentOwnerStillEligible,
	executeLocalRedeploymentFile,
	type FrozenLocalRedeploymentRequest,
	LocalRedeploymentIdentityMismatch,
	localRedeploymentRuntimeBaselineSchema,
	localRedeploymentSha256,
	readFrozenLocalRedeploymentRequest,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";
import { preserveLocalRedeploymentRuntimeRestartAcceptance } from "./local-redeployment-runtime-restart-acceptance";
import {
	backupLocalRedeploymentRuntimeState,
	captureLocalRedeploymentState,
	queryLocalRedeploymentRuntime,
} from "./local-redeployment-state-preservation";

export class LocalRedeploymentQualityFailure extends Error {}
const normalizeStart = (value: string): string => value.trim().replace(/\s+/gu, " ");
const candidateCheckout = (directory: string) => join(directory, "candidate-source-checkout");
const frozenExecutor = (directory: string) => join(directory, "frozen-local-redeployment-executor.mjs");

export async function observeLocalRedeploymentRuntimeBaseline(frozen: FrozenLocalRedeploymentRequest) {
	const request = frozen.request;
	try {
		const report = (await queryLocalRedeploymentRuntime(request, "runtime.getAgentSessionPtyHostDiagnostics")) as {
			runtimeProcessId: number;
			runtimeProcessStartTimeText: string;
			runtimeIdentity: { runtimeHomeDirectoryPath: string; runtimePort: number };
		};
		if (
			report.runtimeIdentity.runtimeHomeDirectoryPath !== request.runtimeIdentity.runtimeHomeDirectoryPath ||
			report.runtimeIdentity.runtimePort !== request.runtimeIdentity.runtimePort
		)
			throw new Error("监听实例 home 或端口与冻结目标不匹配");
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
				try {
					await executeLocalRedeploymentFile(
						"lsof",
						["-nP", `-iTCP:${request.runtimeIdentity.runtimePort}`, "-sTCP:LISTEN"],
						{ timeout: 3_000 },
					);
				} catch (nativeError) {
					noListener = (nativeError as { code?: number }).code === 1;
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

export async function runLocalRedeploymentStandardCommand(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	name: string,
	command: string[],
	cwd: string,
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
		await writeLocalRedeploymentJson(join(original, "result.json"), {
			requestSha256: frozen.requestSha256,
			command,
			cwd,
			startedAtEpochMs,
			exitCode,
			finishedAtEpochMs: Date.now(),
		});
	}
	const output = await readFile(join(original, "stdout.txt"), "utf8");
	if (exitCode !== 0) {
		if (name === "source-validation" && output.includes('"quality_validation_failed"'))
			throw new LocalRedeploymentQualityFailure(`源码验证真实失败，读取 ${original}`);
		throw new Error(`标准部署命令未成功：${name}；原件 ${original}`);
	}
	assertLocalRedeploymentNotRevoked(directory);
	return output;
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
		const sourceValidation = join(
			candidate,
			".codex/skills/cline-kanban-local-deploy/scripts/prepare-source-validation-with-evidence-reuse.mjs",
		);
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
				sourceValidation,
				"--source-checkout-path",
				candidate,
				"--candidate-source-commit",
				request.candidateSourceCommit,
				"--runtime-home-directory",
				request.runtimeIdentity.runtimeHomeDirectoryPath,
				"--output-directory",
				join(directory, "source-validation"),
				"--validation-plan",
				plan,
			],
			candidate,
		);
		const buildReceipt = (await readLocalRedeploymentJson(join(directory, "candidate-build-receipt.json"))) as {
			candidateDistributionSha256?: string;
		} | null;
		if (buildReceipt && existsSync(join(candidate, "dist/cli.js"))) {
			if (
				(await fingerprintLocalDeploymentDistribution(join(candidate, "dist"))).candidateDistributionSha256 !==
				buildReceipt.candidateDistributionSha256
			)
				throw new Error("已构建候选摘要变化，拒绝用新产物替换同一执行");
			return;
		}
		await runLocalRedeploymentStandardCommand(
			directory,
			frozen,
			"production-build",
			[request.deploymentNodeBinaryPath, frozen.npmCliEntrypointPath, "run", "build"],
			candidate,
		);
		await runLocalRedeploymentStandardCommand(
			directory,
			frozen,
			"candidate-native-abi",
			[request.deploymentNodeBinaryPath, join(candidate, "scripts/verify-notification-archive-native-runtime.mjs")],
			candidate,
		);
		await writeLocalRedeploymentJson(join(directory, "candidate-build-receipt.json"), {
			requestSha256: frozen.requestSha256,
			...(await fingerprintLocalDeploymentDistribution(join(candidate, "dist"))),
		});
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
		throw new Error("实例起点身份仍未知，候选已保留，等待原生监听证据恢复");
	const marker = (await readLocalRedeploymentJson(
		join(frozen.request.runtimeIdentity.runtimeHomeDirectoryPath, "last-deployed-source-commit.json"),
	)) as { deployedSourceCommit?: string } | null;
	const candidateDistributionDirectoryPath = join(candidateCheckout(directory), "dist");
	const { serviceLaunch: _serviceLaunch, ...manifestFields } = frozen.request;
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
		throw new Error("锁协议切换等待既有迁移 producer 的真实退休写入者清单；不凭 HTTP 健康捏造 admission closed");
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
	if (evidence?.status !== "ready_for_protocol_switch") throw new Error("锁协议切换仍待原生补证，禁止发布");
}

async function verifyReadiness(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	before: boolean,
): Promise<Record<string, unknown>> {
	const arguments_ = [
		frozen.request.deploymentNodeBinaryPath,
		join(candidateCheckout(directory), "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
		"--candidate-source-commit",
		frozen.request.candidateSourceCommit,
	];
	if (before) arguments_.push("--before-runtime-restart");
	const output = await runLocalRedeploymentStandardCommand(
		directory,
		frozen,
		before ? "before-runtime-restart-readiness" : "current-runtime-readiness",
		arguments_,
		candidateCheckout(directory),
	);
	const evidence = JSON.parse(output) as Record<string, unknown>;
	if (evidence.ok !== true) throw new Error("会话连续性门禁未通过，等待自然结束或等价补证");
	if (
		!before &&
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
		await backupLocalRedeploymentRuntimeState(request, directory);
		if ((await observeLocalRedeploymentRuntimeBaseline(frozen)).state === "verified_online")
			await writeLocalRedeploymentJson(
				join(directory, "runtime-config-before.json"),
				await queryLocalRedeploymentRuntime(request, "runtime.getConfig"),
			);
		await captureLocalRedeploymentState(request, directory, "before-publication", true);
		const current = await observeLocalRedeploymentRuntimeBaseline(frozen);
		if (current.state === "unknown") throw new Error("实例当前身份待补");
		if (current.state === "verified_online")
			await writeLocalRedeploymentJson(
				join(directory, "before-runtime-restart.json"),
				await verifyReadiness(directory, frozen, true),
			);
		await run("immediate-candidate-abi", [
			node,
			join(candidate, "scripts/verify-notification-archive-native-runtime.mjs"),
		]);
	}
	if (stage === "build_publication") {
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
		const current = await observeLocalRedeploymentRuntimeBaseline(frozen);
		if (current.state === "unknown") throw new Error("发布前监听归属未知");
		if (!existsSync(join(directory, "publication-runtime-baseline.json")))
			await writeLocalRedeploymentJson(join(directory, "publication-runtime-baseline.json"), current);
		if (current.state === "verified_online") await verifyReadiness(directory, frozen, true);
		await verifyBoundFilesystemLockProtocolBeforePublication(directory, frozen);
		if (!(await verifyLocalDeploymentPublishedFiles(manifest))) {
			const staging = join(request.distributionDirectoryPath, `.kanban-redeployment-staging-${request.executionId}`);
			await mkdir(staging, { recursive: true });
			const fingerprint = await fingerprintLocalDeploymentDistribution(manifest.candidateDistributionDirectoryPath);
			for (const file of fingerprint.files) {
				const destination = join(staging, file.relativeFilePath);
				await mkdir(dirname(destination), { recursive: true });
				await cp(join(manifest.candidateDistributionDirectoryPath, file.relativeFilePath), destination);
			}
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
		await run(
			"preserve-global-cli-link",
			[node, frozen.npmCliEntrypointPath, "link", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
			request.sourceCheckoutPath,
		);
		if ((await realpath(join(dirname(node), "kanban"))) !== (await realpath(cli)))
			throw new Error("实际 Node 的 CLI 链接与冻结目标不一致");
	}
	if (stage === "runtime_restart") {
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
				const readiness = await verifyReadiness(directory, frozen, true);
				if (
					readiness.runtimeProcessId !== restartBaseline.processId ||
					normalizeStart(String(readiness.runtimeProcessStartTimeText)) !==
						normalizeStart(restartBaseline.processStartTimeText)
				)
					throw new Error("连续性门禁所见代际已变化，禁止交接未核验实例");
				await writeLocalRedeploymentJson(join(directory, "runtime-restart-target-baseline.json"), current);
				await writeLocalRedeploymentJson(join(directory, "before-runtime-restart.json"), readiness);
				try {
					await run("handover-restart", [
						node,
						cli,
						"runtime",
						"handover-restart",
						"--wait-for-successor-seconds",
						"60",
					]);
				} catch (error) {
					await writeLocalRedeploymentJson(join(directory, "handover-command-failure.json"), {
						error: String(error),
						historicalCommandFailurePreserved: true,
					});
				}
			}
		}
		const successor = await observeLocalRedeploymentRuntimeBaseline(frozen);
		if (successor.state === "verified_offline") await startBoundLocalRedeploymentService(directory, frozen);
		else if (successor.state !== "verified_online") throw new Error("重启效果仍未知，禁止重复停止或启动");
		const after = await verifyReadiness(directory, frozen, false);
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
		const current = await verifyReadiness(directory, frozen, false);
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
	if (stage === "deployment_record")
		await run(
			"record-deployment",
			[node, cli, "deployment", "record", "--execution-directory", directory],
			request.sourceCheckoutPath,
		);
	if (stage === "staging_cleanup") {
		const staging = join(request.distributionDirectoryPath, `.kanban-redeployment-staging-${request.executionId}`);
		if (existsSync(staging) && (await lstat(staging)).isSymbolicLink()) throw new Error("拒绝清理非本次真实暂存目录");
		await rm(staging, { recursive: true, force: true });
	}
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
			);
	}
}

export async function observeStandardLocalRedeploymentRecoveryEvidence(
	directory: string,
): Promise<{ evidenceSha256: string }> {
	if (existsSync(join(directory, "local-deployment-execution.json")))
		return await observeLocalDeploymentRecoveryEvidence(directory);
	return await observeStandardLocalRedeploymentStageRecoveryEvidence(directory, "candidate_bootstrap");
}

export async function observeStandardLocalRedeploymentStageRecoveryEvidence(
	directory: string,
	activeStage: LocalDeploymentStage | "candidate_bootstrap",
): Promise<{ evidenceSha256: string }> {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	const revoked =
		existsSync(join(directory, "redeployment-revocation.json")) ||
		existsSync(join(directory, "local-deployment-execution-restriction.json"));
	if (revoked) return { evidenceSha256: localRedeploymentSha256("persistently_revoked") };
	const baseline = await observeLocalRedeploymentRuntimeBaseline(frozen);
	const requests = (await readLocalRedeploymentMachineEvidenceRequests(directory)).filter((request) =>
		request.kind === "filesystem_path"
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
					const state = await loadPersistedWorkspaceStateById(workspaceId);
					return {
						checkKey: request.checkKey,
						status:
							state.workspaceId === workspaceId && Array.isArray(state.board.columns)
								? "equivalent_snapshot_readable"
								: "unknown",
					};
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
		machineEvidence,
		diskAvailability: await observeLocalRedeploymentDiskAvailability(directory),
		baseline: baseline.state === "unknown" ? { state: "unknown" } : baseline,
		sourceValidation: "unknown",
		lockProtocolInventory: localRedeploymentSha256(
			JSON.stringify(
				await readLocalRedeploymentJson(join(directory, "filesystem-lock-protocol-retiring-writer-inventory.json")),
			),
		),
		sessionReadiness: "not_applicable",
	};
	const candidate = candidateCheckout(directory);
	if (
		baseline.state === "verified_online" &&
		["state_preservation", "build_publication", "runtime_restart", "runtime_validation"].includes(activeStage)
	) {
		const command = [
			join(candidate, "scripts/verify-agent-session-pty-host-runtime-readiness.mjs"),
			"--candidate-source-commit",
			frozen.request.candidateSourceCommit,
			...(activeStage === "runtime_validation" ? [] : ["--before-runtime-restart"]),
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
			const sessionIdentity = (value: unknown) => {
				if (!Array.isArray(value)) return "unknown";
				return value.map((session: Record<string, unknown>) =>
					Object.fromEntries(
						[
							"workspaceId",
							"conversationSessionId",
							"runtimeSessionIncarnationId",
							"nativeConversationSessionId",
							"hostedSessionKey",
							"processId",
							"processStartedAtEpochMs",
							"hostProcessId",
						].map((field) => [field, session[field] ?? null]),
					),
				);
			};
			semantic.sessionReadiness = JSON.stringify({
				ok: readiness.ok === true,
				runtimeLoadedEntrypointSha256: readiness.runtimeLoadedEntrypointSha256 ?? null,
				blockingSessions: sessionIdentity(readiness.blockingSessions),
				validatedHostedSessions: sessionIdentity(readiness.validatedHostedSessions),
			});
		} catch {
			semantic.sessionReadiness = "unavailable";
		}
	}
	if (existsSync(join(candidate, ".git"))) {
		try {
			const response = await executeLocalRedeploymentFile(
				frozen.request.deploymentNodeBinaryPath,
				[
					join(
						candidate,
						".codex/skills/cline-kanban-local-deploy/scripts/prepare-source-validation-with-evidence-reuse.mjs",
					),
					"--source-checkout-path",
					candidate,
					"--candidate-source-commit",
					frozen.request.candidateSourceCommit,
					"--runtime-home-directory",
					frozen.request.runtimeIdentity.runtimeHomeDirectoryPath,
					"--output-directory",
					join(directory, "source-validation"),
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
	return { evidenceSha256: localRedeploymentSha256(JSON.stringify(semantic)) };
}
