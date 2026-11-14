import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../../package.json";
import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	KANBAN_CLI_INVOCATION_ENVIRONMENT_ACTOR_CLAIMS_REQUEST_HEADER_NAME,
} from "../core/kanban-cli-invocation-environment-actor-claims";
import { getRuntimeFetch } from "../core/runtime-endpoint";
import {
	taskCommandExecutionAdoptExistingSupervisorRequestSchema,
	taskCommandExecutionSpecificationSchema,
} from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readRuntimeProcessInstanceLiveness } from "../state/runtime-process-instance-heartbeat-registry";
import {
	mutateTaskCommandExecutions,
	readTaskCommandExecutions,
	taskCommandExecutionArtifactDirectory,
} from "../task-command-execution/task-command-execution-store";
import {
	cancelOwnedCommandProcesses,
	hasSameProcessGeneration,
	inspectOwnedCommandSupervisor,
	launchOwnedCommandSupervisor,
	readProcessIdentity,
	readSystemBootIdentity,
} from "../task-command-execution/task-command-execution-supervisor";
import { restrictLocalDeploymentExecution } from "./local-deployment-execution";
import {
	assertLocalRedeploymentNotRevoked,
	assertLocalRedeploymentOwnerStillEligible,
	createLocalRedeploymentOwnedCommandSpecification,
	LocalRedeploymentIdentityMismatch,
	localRedeploymentRuntimeBaselineSchema,
	localRedeploymentSha256,
	readFrozenLocalRedeploymentRequest,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";
import {
	observeLocalRedeploymentRuntimeBaseline,
	observeStandardLocalRedeploymentRecoveryEvidence,
} from "./local-redeployment-standard-execution";

export async function startPreparedLocalRedeployment(directory: string) {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	const { request } = frozen;
	await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
	const specification = taskCommandExecutionSpecificationSchema.parse(
		await readLocalRedeploymentJson(join(directory, "owned-command-specification.json")),
	);
	if (
		JSON.stringify(specification) !==
		JSON.stringify(createLocalRedeploymentOwnedCommandSpecification(directory, frozen))
	)
		throw new LocalRedeploymentIdentityMismatch("所属命令规格与冻结请求不匹配");
	const idempotencyKey = `local-redeployment:${request.executionId}`;
	return lockedFileSystem.withLock({ path: join(directory, "redeployment-start-single-flight") }, async () => {
		const readExistingRegistration = async () => {
			const registered = (await readTaskCommandExecutions(request.workspaceId)).find(
				(record) => record.idempotencyKey === idempotencyKey && record.taskId === request.taskId,
			);
			if (!registered) return null;
			if (registered.specification.materialSha256 !== specification.materialSha256)
				throw new Error("已有所属执行绑定不同材料");
			if (
				frozen.owner &&
				(registered.taskIncarnationCreatedAtEpochMs !== frozen.owner.taskIncarnationCreatedAtEpochMs ||
					registered.originatingConversationSessionId !== frozen.owner.conversationSessionId ||
					registered.originatingNativeSessionId !== frozen.owner.nativeSessionId ||
					registered.originatingRuntimeSessionIncarnationId !== frozen.owner.runtimeSessionIncarnationId ||
					JSON.stringify(registered.worktreeIdentity) !== JSON.stringify(frozen.owner.worktreeIdentity))
			)
				throw new LocalRedeploymentIdentityMismatch("已有所属执行与冻结 owner 不匹配");
			return registered;
		};
		const registered = await readExistingRegistration();
		const registeredReceipt = () => ({
			ok: true,
			mode: "registered_owned_execution",
			executionId: registered?.executionId,
			resultFile: specification.resultFile,
		});
		const businessResult = (await readLocalRedeploymentJson(specification.resultFile)) as {
			disposition?: string;
		} | null;
		const terminalResult = ["agent_review_ready", "agent_judgment_required", "cancelled"].includes(
			businessResult?.disposition ?? "",
		);
		if (registered && (registered.revokedAtEpochMs !== null || terminalResult)) return registeredReceipt();
		const referencePath = join(directory, "independent-redeployment-supervisor-reference.json");
		let reference = (await readLocalRedeploymentJson(referencePath)) as {
			workspaceId: string;
			executionId: string;
			launchNonce: string;
			revocationFile: string;
			launchAttemptCount: number;
			previousLaunchNonces?: string[];
		} | null;
		const baseline = await observeLocalRedeploymentRuntimeBaseline(frozen);
		if (registered && baseline.state === "verified_online") return registeredReceipt();
		if (registered) {
			const worker = await inspectOwnedCommandSupervisor(registered);
			if (worker === "running") return registeredReceipt();
			if (
				baseline.state !== "verified_offline" ||
				(worker !== "exited" && worker !== "not_started") ||
				(await readRuntimeProcessInstanceLiveness(registered.custodianRuntimeProcessInstanceId)) !== "dead"
			)
				return {
					ok: true,
					mode: "machine_evidence_pending",
					resultFile: specification.resultFile,
					recoveryCondition: "等待原 runtime 与原监督执行者退出的原生证据",
				};
			if (reference && reference.executionId !== registered.executionId)
				throw new LocalRedeploymentIdentityMismatch("已有独立监督引用与所属执行身份不匹配");
			reference = {
				workspaceId: registered.workspaceId,
				executionId: registered.executionId,
				launchNonce: registered.launchNonce,
				revocationFile: registered.revocationFile,
				launchAttemptCount: registered.launchAttemptCount,
				previousLaunchNonces: registered.previousLaunchNonces,
			};
		}
		const onlineRegistrationIntentPath = join(directory, "online-registration-intent.json");
		if (!reference && frozen.owner && baseline.state === "verified_online") {
			const url = new URL(
				`/api/trpc/taskCommandExecution.start`,
				`http://${request.runtimeIdentity.runtimeHost === "::1" ? "[::1]" : request.runtimeIdentity.runtimeHost}:${request.runtimeIdentity.runtimePort}`,
			);
			// 超时后仍只使用同一幂等键；不把未知的在线受理改为第二次离线派发。
			await writeLocalRedeploymentJson(onlineRegistrationIntentPath, {
				idempotencyKey,
				requestSha256: frozen.requestSha256,
				runtimeBaseline: baseline,
				systemBootIdentity: await readSystemBootIdentity(),
			});
			const response = await (await getRuntimeFetch())(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-kanban-workspace-id": request.workspaceId,
					[KANBAN_CLI_INVOCATION_ENVIRONMENT_ACTOR_CLAIMS_REQUEST_HEADER_NAME]:
						encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
							collectKanbanCliInvocationEnvironmentActorClaims({
								environment: process.env,
								invokingKanbanCliCodeVersion: packageJson.version,
								invokingProcessWorkingDirectory: process.cwd(),
							}),
						),
				},
				body: JSON.stringify({
					taskId: request.taskId,
					idempotencyKey,
					specification,
					expectedOwner: frozen.owner,
				}),
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) throw new Error(`在线所属执行登记未确认：HTTP ${response.status}`);
			return {
				ok: true,
				mode: "online_owned_execution",
				receipt: await response.json(),
				resultFile: specification.resultFile,
			};
		}
		if (baseline.state === "unknown") throw new Error("实例在线/离线身份未知，暂不派发第二个执行者");
		const onlineIntent = (await readLocalRedeploymentJson(onlineRegistrationIntentPath)) as {
			idempotencyKey?: string;
			requestSha256?: string;
			runtimeBaseline?: unknown;
			systemBootIdentity?: string | null;
		} | null;
		if (!reference && onlineIntent) {
			if (onlineIntent.idempotencyKey !== idempotencyKey || onlineIntent.requestSha256 !== frozen.requestSha256)
				throw new LocalRedeploymentIdentityMismatch("在线登记意图与冻结请求不匹配");
			const original = localRedeploymentRuntimeBaselineSchema.safeParse(onlineIntent.runtimeBaseline);
			let originatingRuntimeHasExited =
				baseline.state === "verified_offline" &&
				!!onlineIntent.systemBootIdentity &&
				onlineIntent.systemBootIdentity !== baseline.systemBootIdentity;
			if (!originatingRuntimeHasExited && original.success && original.data.state === "verified_online") {
				try {
					const expected = original.data.runtimeBefore;
					const current = await readProcessIdentity(expected.processId);
					if (current)
						originatingRuntimeHasExited = !hasSameProcessGeneration(current, {
							pid: expected.processId,
							startAndCommand: `${expected.processStartTimeText} bound-runtime`,
						});
					else {
						// ps 不可用也可能返回 null，须用原生 PID 不存在补证，不能据此重复派发。
						try {
							process.kill(expected.processId, 0);
						} catch (error) {
							originatingRuntimeHasExited = (error as NodeJS.ErrnoException).code === "ESRCH";
						}
					}
				} catch {
					/* 原生身份缺证时保留在线受理未知状态。 */
				}
			}
			if (!originatingRuntimeHasExited)
				return {
					ok: true,
					mode: "machine_evidence_pending",
					resultFile: specification.resultFile,
					recoveryCondition: "等待在线受理回执或原 runtime 原生退出证据；恢复后复用同一入口",
				};
			const completedRegistration = await readExistingRegistration();
			if (completedRegistration)
				return {
					ok: true,
					mode: "machine_evidence_pending",
					executionId: completedRegistration.executionId,
					resultFile: specification.resultFile,
					recoveryCondition: "在线登记已出现；同一入口下次核验既有执行者，不另建执行身份",
				};
		}
		if (!reference) {
			reference = {
				workspaceId: request.workspaceId,
				executionId: request.executionId,
				launchNonce: randomUUID(),
				launchAttemptCount: 1,
				revocationFile: join(
					taskCommandExecutionArtifactDirectory(request.workspaceId, request.executionId),
					"execution-revocation.json",
				),
			};
			await writeLocalRedeploymentJson(referencePath, reference);
		}
		if (
			reference.workspaceId !== request.workspaceId ||
			reference.executionId !== (registered?.executionId ?? request.executionId) ||
			existsSync(reference.revocationFile)
		)
			throw new Error("独立监督引用身份变化或已撤销");
		const inspection = await inspectOwnedCommandSupervisor(reference);
		if (inspection === "exited" && !terminalResult) {
			const evidence = await observeStandardLocalRedeploymentRecoveryEvidence(directory);
			const budgetPath = join(directory, "independent-supervisor-resume-attempt-budgets.json");
			const budgets = ((await readLocalRedeploymentJson(budgetPath)) ?? {}) as Record<string, number>;
			if ((budgets[evidence.evidenceSha256] ?? 0) >= 2)
				return {
					ok: true,
					mode: "machine_evidence_pending",
					resultFile: specification.resultFile,
					recoveryCondition: "相同语义证据恢复预算已用尽，等待证据变化",
				};
			budgets[evidence.evidenceSha256] = (budgets[evidence.evidenceSha256] ?? 0) + 1;
			await writeLocalRedeploymentJson(budgetPath, budgets);
			reference = {
				...reference,
				previousLaunchNonces: [...(reference.previousLaunchNonces ?? []), reference.launchNonce],
				launchNonce: randomUUID(),
				launchAttemptCount: reference.launchAttemptCount + 1,
			};
			await writeLocalRedeploymentJson(referencePath, reference);
		}
		const record = { ...reference, specification };
		const supervisorArtifactDirectory = taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
		await mkdir(supervisorArtifactDirectory, { recursive: true });
		return lockedFileSystem.withLock({ path: join(supervisorArtifactDirectory, "execution-dispatch") }, async () => {
			if (registered) {
				await mutateTaskCommandExecutions(request.workspaceId, async (records) => {
					const current = records.find((value) => value.executionId === registered.executionId);
					if (
						!current ||
						current.launchNonce !== registered.launchNonce ||
						current.revokedAtEpochMs !== null ||
						current.custodianRuntimeProcessInstanceId !== registered.custodianRuntimeProcessInstanceId ||
						(await readRuntimeProcessInstanceLiveness(current.custodianRuntimeProcessInstanceId)) !== "dead"
					)
						throw new Error("离线恢复期间原托管权、撤销或监督代际已变化");
					return {
						records: records.map((value) =>
							value !== current
								? value
								: {
										...value,
										launchNonce: record.launchNonce,
										launchAttemptCount: record.launchAttemptCount,
										previousLaunchNonces: record.previousLaunchNonces ?? [],
										launchState: "launching" as const,
										updatedAtEpochMs: Date.now(),
									},
						),
						result: undefined,
					};
				});
			}
			await launchOwnedCommandSupervisor(
				record,
				async () => {
					await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
					assertLocalRedeploymentNotRevoked(directory);
					if (existsSync(record.revocationFile)) throw new Error("既有独立执行已被 Stop");
					const materialsPath = join(supervisorArtifactDirectory, `launch-materials-${record.launchNonce}.json`);
					if (!registered && frozen.owner && existsSync(materialsPath)) {
						await writeLocalRedeploymentJson(
							join(supervisorArtifactDirectory, "pending-existing-supervisor-adoption.json"),
							taskCommandExecutionAdoptExistingSupervisorRequestSchema.parse({
								taskId: request.taskId,
								idempotencyKey,
								specification,
								executionId: record.executionId,
								launchNonce: record.launchNonce,
								expectedOwner: frozen.owner,
								launchMaterialsSha256: localRedeploymentSha256(await readFile(materialsPath)),
							}),
						);
					}
					await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
					assertLocalRedeploymentNotRevoked(directory);
					if (existsSync(record.revocationFile)) throw new Error("既有独立执行已被 Stop");
				},
				{ preventRedispatch: true },
			);
			return {
				ok: true,
				mode: frozen.owner ? "independent_execution_pending_runtime_adoption" : "external_caller_persistent_result",
				...reference,
				supervisorState: await inspectOwnedCommandSupervisor(record),
				resultFile: specification.resultFile,
			};
		});
	});
}

export async function cancelPreparedLocalRedeployment(directory: string): Promise<void> {
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	await writeLocalRedeploymentJson(join(directory, "redeployment-revocation.json"), {
		executionId: frozen.request.executionId,
		source: "explicit_redeployment_cancel",
		revokedAtEpochMs: Date.now(),
	});
	if (existsSync(join(directory, "local-deployment-execution.json")))
		await restrictLocalDeploymentExecution(directory, {
			kind: "permission_revoked",
			reason: "本次重部署收到持久取消",
			sourceReference: `local-redeployment:${frozen.request.executionId}`,
		});
	const reference = (await readLocalRedeploymentJson(
		join(directory, "independent-redeployment-supervisor-reference.json"),
	)) as {
		workspaceId: string;
		executionId: string;
		launchNonce: string;
		revocationFile: string;
		launchAttemptCount: number;
		previousLaunchNonces?: string[];
	} | null;
	if (reference) {
		await writeLocalRedeploymentJson(reference.revocationFile, {
			executionId: reference.executionId,
			revokedAtEpochMs: Date.now(),
		});
		await cancelOwnedCommandProcesses({
			...reference,
			previousLaunchNonces: reference.previousLaunchNonces ?? [],
			specification: { workingDirectory: frozen.request.originatingTaskWorktreePath },
		});
	}
}
