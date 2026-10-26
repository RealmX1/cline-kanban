import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type TaskAssistanceModelProviderAttempt,
	type TaskAssistanceModelProviderRoutingSettings,
	taskAssistanceModelProviderRoutingSettingsSchema,
} from "../core/task-assistance-model-provider-routing-contract";
import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	readTaskAssistanceModelProviderRoutingSettings,
	resolveKanbanProviderAccess,
} from "./kanban-model-provider-settings";
import {
	type ModelProviderCredential,
	resolveModelProviderCredential,
} from "./model-provider-credentials-from-environment";
import {
	type ModelProviderChatCompletionRequest,
	type ModelProviderJsonObjectResult,
	type ModelProviderRequestOptions,
	requestModelProviderJsonObject,
} from "./request-model-provider-chat-completion";

export const TASK_ASSISTANCE_PREFERRED_PROVIDER_COOLDOWN_MS = 60_000;
const providerRecoveryStateSchema = z.record(
	z.string(),
	z.object({
		configurationFingerprint: z.string(),
		cooldownUntilEpochMs: z.number(),
		lastFailure: z
			.object({ occurredAtEpochMs: z.number(), operationId: z.string(), stage: z.string(), reason: z.string() })
			.optional(),
	}),
);

export interface TaskAssistanceModelRequest extends ModelProviderChatCompletionRequest {
	operationId: string;
	stage: string;
}
export interface TaskAssistanceModelRequestOptions<T> extends ModelProviderRequestOptions {
	storageDirectoryPath?: string;
	routingSettings?: TaskAssistanceModelProviderRoutingSettings;
	now?: () => number;
	/** 业务身份、范围及可用性校验也属于结果验收，失败可以切换备用。 */
	validateParsedJsonObject?: (value: T) => void;
	onAttempt?: (attempt: TaskAssistanceModelProviderAttempt) => void;
}
export type TaskAssistanceModelResult<T> = ModelProviderJsonObjectResult<T> & {
	attempts: TaskAssistanceModelProviderAttempt[];
};

function fingerprint(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function readProviderRecoveryState(path: string) {
	try {
		return providerRecoveryStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		// 缓存状态损坏不阻塞请求：忽略冷却，下次失败/成功会原子修复；原错误留在诊断。
		appendDiagnosticEventToRotatingJsonlJournal("task-assistance-routing", {
			event: "provider_recovery_state_unreadable",
		});
		return {};
	}
}
async function resolveProviderCredential(
	providerId: string,
	environment?: NodeJS.ProcessEnv,
): Promise<{ credential: ModelProviderCredential; supportsImages: boolean } | null> {
	if (environment) {
		const credential = resolveModelProviderCredential(providerId, environment);
		return credential ? { credential, supportsImages: /^MiniMax-M3(?:\.|$)/iu.test(credential.modelId) } : null;
	}
	const access = await resolveKanbanProviderAccess(providerId);
	if (
		!access ||
		access.profile.providerProtocol !== "openai_compatible" ||
		!access.profile.baseUrl ||
		!access.profile.defaultModelId
	)
		return null;
	return {
		credential: {
			modelProviderId: providerId,
			apiKey: access.apiKey,
			baseUrl: access.profile.baseUrl.replace(/\/+$/u, ""),
			modelId: access.profile.defaultModelId,
		},
		supportsImages: access.profile.supportsImageInput ?? /^MiniMax-M3(?:\.|$)/iu.test(access.profile.defaultModelId),
	};
}

/** 每个逻辑阶段每家最多一次；取消不降级，首选冷却状态可跨运行时重启。 */
export async function requestTaskAssistanceJsonObject<T>(
	request: TaskAssistanceModelRequest,
	outputSchema: z.ZodType<T>,
	options: TaskAssistanceModelRequestOptions<T> = {},
): Promise<TaskAssistanceModelResult<T>> {
	request = { ...request, abortSignal: request.abortSignal ?? options.abortSignal };
	const attempts: TaskAssistanceModelProviderAttempt[] = [];
	const cancelled = (): TaskAssistanceModelResult<T> => ({
		status: "unavailable",
		unavailableReason: "execution_cancelled",
		unavailableDetail: "分析已取消。",
		attempts,
	});
	if (request.abortSignal?.aborted) return cancelled();
	let routing: TaskAssistanceModelProviderRoutingSettings;
	try {
		routing =
			options.routingSettings ??
			(options.environmentVariables
				? taskAssistanceModelProviderRoutingSettingsSchema.parse({})
				: await readTaskAssistanceModelProviderRoutingSettings());
	} catch {
		appendDiagnosticEventToRotatingJsonlJournal("task-assistance-routing", {
			event: "routing_settings_unreadable",
			operationId: request.operationId,
			stage: request.stage,
		});
		return {
			status: "unavailable",
			unavailableReason: "model_provider_not_configured",
			unavailableDetail: "辅助 AI 主备设置暂不可读；配置恢复后新请求会自动重验。",
			attempts,
		};
	}
	const providerIds = [
		...new Set(
			[routing.preferredModelProviderId, routing.fallbackModelProviderId].filter((id): id is string => Boolean(id)),
		),
	];
	const recoveryPath = join(
		options.storageDirectoryPath ??
			join(
				process.env.KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT ?? getRuntimeHomePath(),
				"task-assistance-model-routing",
			),
		"provider-recovery-state.json",
	);
	const prefixHash = request.stablePromptPrefixSha256 ?? fingerprint(request.systemPrompt);
	const now = options.now ?? Date.now;
	let fallbackReason: string | undefined;
	let lastResult: ModelProviderJsonObjectResult<T> = {
		status: "unavailable",
		unavailableReason: "model_provider_not_configured",
	};
	const publish = (attempt: TaskAssistanceModelProviderAttempt) => {
		attempts.push(attempt);
		appendDiagnosticEventToRotatingJsonlJournal("task-assistance-routing", { ...attempt });
		options.onAttempt?.(attempt);
	};
	for (const providerId of providerIds) {
		if (request.abortSignal?.aborted) return cancelled();
		const baseAttempt = {
			operationId: request.operationId,
			stage: request.stage,
			modelUsagePurpose: request.modelUsagePurpose,
			modelProviderId: providerId,
			stablePromptPrefixSha256: prefixHash,
		};
		let access: Awaited<ReturnType<typeof resolveProviderCredential>> = null;
		try {
			access = await resolveProviderCredential(providerId, options.environmentVariables);
		} catch {
			/* 凭据库失效也允许等价备用路径。 */
		}
		if (request.abortSignal?.aborted) return cancelled();
		const skip = (reason: string, modelId: string | null) => {
			publish({
				...baseAttempt,
				requestedModelId: modelId,
				resolvedModelId: null,
				elapsedMs: 0,
				outcome: "skipped",
				failureReason: reason,
				fallbackReason,
			});
			fallbackReason = `${providerId}:${reason}`;
		};
		if (!access) {
			skip("model_provider_not_configured", null);
			continue;
		}
		const { credential } = access;
		if (request.questionImages?.length && !access.supportsImages) {
			skip("image_input_not_supported", credential.modelId);
			lastResult = {
				status: "unavailable",
				unavailableReason: "request_failed",
				unavailableDetail: "已配置的模型不支持查卡图片；请配置兼容图片的 provider。图片已保留。",
			};
			continue;
		}
		const configurationFingerprint = fingerprint([routing, credential, access.supportsImages]);
		const recoveryState = (await readProviderRecoveryState(recoveryPath))[providerId];
		if (
			providerId === routing.preferredModelProviderId &&
			recoveryState?.configurationFingerprint === configurationFingerprint &&
			recoveryState.cooldownUntilEpochMs > now()
		) {
			skip("preferred_provider_cooling_down", credential.modelId);
			lastResult = {
				status: "unavailable",
				unavailableReason: "request_failed",
				unavailableDetail: "首选模型暂时冷却，将在冷却结束后的新请求自动重验。",
			};
			continue;
		}
		const schemaWithBusinessValidation = outputSchema.superRefine((value, context) => {
			try {
				options.validateParsedJsonObject?.(value);
			} catch {
				context.addIssue({ code: "custom", message: "模型结果未通过业务身份或内容校验" });
			}
		});
		const timeout =
			request.requestTimeoutMs ??
			(["task_name_suggestion", "task_project_assignment_analysis"].includes(request.modelUsagePurpose)
				? 15_000
				: 60_000);
		const result = await requestModelProviderJsonObject(
			{
				...request,
				modelProviderId: providerId,
				requestTimeoutMs: timeout,
				stablePromptPrefixSha256: prefixHash,
				fallbackReason,
				systemPrompt: `${request.systemPrompt}\n\n只输出最终 JSON 正文，不调用工具。输出 JSON schema：\n${JSON.stringify(z.toJSONSchema(outputSchema, { target: "draft-7", unrepresentable: "any" }))}`,
			},
			schemaWithBusinessValidation,
			{
				...options,
				credential,
				observeAttempt: async (observation) => {
					publish({
						...baseAttempt,
						requestedModelId: credential.modelId,
						resolvedModelId: observation.resolvedModelId ?? null,
						elapsedMs: observation.elapsedMs,
						outcome: observation.result.status,
						inputTokens: observation.promptTokenCount,
						outputTokens: observation.completionTokenCount,
						cacheReadTokens: observation.cacheReadTokenCount,
						cacheWriteTokens: observation.cacheWriteTokenCount,
						fallbackReason,
						failureReason:
							observation.result.status === "unavailable"
								? (observation.result.unavailableDetail ?? observation.result.unavailableReason)
								: undefined,
					});
					await options.observeAttempt?.(observation);
				},
			},
		);
		if (
			request.abortSignal?.aborted ||
			(result.status === "unavailable" && result.unavailableReason === "execution_cancelled")
		)
			return cancelled();
		if (providerId === routing.preferredModelProviderId) {
			await lockedFileSystem
				.withLock({ path: recoveryPath }, async () => {
					const persisted = await readProviderRecoveryState(recoveryPath);
					// 取锁与读盘都可能等待；取消后不得新增冷却、清除冷却或覆盖原有失败历史。
					if (request.abortSignal?.aborted) return;
					persisted[providerId] = {
						configurationFingerprint,
						cooldownUntilEpochMs:
							result.status === "completed" ? 0 : now() + TASK_ASSISTANCE_PREFERRED_PROVIDER_COOLDOWN_MS,
						lastFailure:
							result.status === "completed"
								? persisted[providerId]?.lastFailure
								: {
										occurredAtEpochMs: now(),
										operationId: request.operationId,
										stage: request.stage,
										reason: result.unavailableDetail ?? result.unavailableReason,
									},
					};
					await lockedFileSystem.writeJsonFileAtomic(recoveryPath, persisted, { lock: null });
				})
				.catch(() =>
					appendDiagnosticEventToRotatingJsonlJournal("task-assistance-routing", {
						event: "provider_recovery_state_write_failed",
						...baseAttempt,
					}),
				);
		}
		if (request.abortSignal?.aborted) return cancelled();
		if (result.status === "completed") return { ...result, attempts };
		fallbackReason = `${providerId}:${result.unavailableDetail ?? result.unavailableReason}`;
		lastResult = result;
	}
	return { ...lastResult, attempts };
}
