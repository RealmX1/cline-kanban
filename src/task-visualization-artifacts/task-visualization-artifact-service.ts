import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	TASK_VISUALIZATION_PUBLICATION_PROTOCOL_VERSION,
	type TaskVisualizationArtifact,
	type TaskVisualizationBrowserContextMessage,
	type TaskVisualizationPreviewAcknowledgmentMessage,
	type TaskVisualizationPreviewRequest,
	type TaskVisualizationPreviewRequestedMessage,
	taskVisualizationArtifactSchema,
	taskVisualizationPublicationRejectionCodeSchema,
} from "../core/task-visualization-artifact-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	pendingTaskVisualizationPublicationDirectory,
	pendingTaskVisualizationPublicationsDirectory,
	taskVisualizationStorageDirectory,
} from "./task-visualization-artifact-storage-paths";
import { TaskVisualizationArtifactStore } from "./task-visualization-artifact-store";

interface TaskVisualizationWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}
interface TaskVisualizationServiceDependencies {
	store?: TaskVisualizationArtifactStore;
	resolveWorkspaceScope: (workspaceId: string) => Promise<TaskVisualizationWorkspaceScope | null>;
	assertTaskMayPublish: (scope: TaskVisualizationWorkspaceScope, taskId: string) => Promise<void>;
	onArtifactsUpdated: (workspaceId: string, taskId: string) => void;
	warn: (message: string) => void;
	now?: () => number;
}
interface BrowserPreviewContext {
	workspaceId: string;
	declaration: TaskVisualizationBrowserContextMessage;
	taskFocusedAtMs: number;
	lastInteractionOrder: number;
	lastHeartbeatAtMs: number;
	send: (message: TaskVisualizationPreviewRequestedMessage) => void;
}
interface BrowserPreviewOffer {
	connection: unknown;
	workspaceId: string;
	taskId: string;
	browserPageId: string;
	deliveryAttemptId: string;
	previewRequest: TaskVisualizationPreviewRequest;
	offeredAtMs: number;
	acceptedAtMs?: number;
	cancellationRequestedAtMs?: number;
}
const MAXIMUM_PREVIEW_DELIVERY_ATTEMPTS = 3;
const contentCapabilitySchema = z.object({
	artifact: taskVisualizationArtifactSchema.pick({
		workspaceId: true,
		taskId: true,
		visualizationArtifactId: true,
		revisionId: true,
	}),
	expiresAtMs: z.number(),
	contentLoadConfirmationId: z.string().uuid(),
});

export function taskVisualizationViewerRelativeUrl(artifact: TaskVisualizationArtifact): string {
	const query = new URLSearchParams({
		workspaceId: artifact.workspaceId,
		taskId: artifact.taskId,
		visualizationArtifactId: artifact.visualizationArtifactId,
		revisionId: artifact.revisionId,
	});
	return `/task-visualization-preview?${query}`;
}

export class TaskVisualizationArtifactService {
	readonly store: TaskVisualizationArtifactStore;
	private readonly now: () => number;
	private readonly browserContexts = new Map<unknown, BrowserPreviewContext>();
	private readonly offeredRequests = new Map<string, BrowserPreviewOffer>();
	private readonly dispatchInFlightByTask = new Map<string, Promise<void>>();
	private readonly recoveryAttempts = new Map<string, { attempts: number; nextAttemptAtMs: number }>();
	private interactionOrder = 0;
	private secretPromise: Promise<Buffer> | null = null;
	private recoveryInterval: ReturnType<typeof setInterval> | null = null;
	private recoveryInFlight: Promise<void> | null = null;
	private readonly runtimeInstanceId = randomUUID();

	constructor(private readonly dependencies: TaskVisualizationServiceDependencies) {
		this.store = dependencies.store ?? new TaskVisualizationArtifactStore();
		this.now = dependencies.now ?? Date.now;
	}

	reportBrowserRoutingFailure(error: unknown): void {
		this.dependencies.warn(`可视化浏览器投递暂未完成：${String(error)}`);
	}

	async publish(scope: TaskVisualizationWorkspaceScope, input: { taskId: string; publicationRequestId: string }) {
		try {
			const rejection = await this.store.readPublicationRejection(input.publicationRequestId);
			if (rejection) throw new TRPCError({ code: rejection.failureCode, message: rejection.failure });
			const pending = await this.store.readPendingPublication(input.publicationRequestId);
			if (pending.taskId !== input.taskId)
				throw new TRPCError({ code: "BAD_REQUEST", message: "可视化发布包任务归属不匹配。" });
			await this.dependencies.assertTaskMayPublish(scope, input.taskId);
			const outcome = await this.store.acceptPublication(
				scope.workspaceId,
				scope.workspacePath,
				input.publicationRequestId,
			);
			if (outcome.isNewRevision) this.dependencies.onArtifactsUpdated(scope.workspaceId, input.taskId);
			await this.dispatchTaskPreviews(scope.workspaceId, input.taskId);
			return { ...outcome, viewerRelativeUrl: taskVisualizationViewerRelativeUrl(outcome.artifact) };
		} catch (error) {
			const rejectionCode =
				error instanceof TRPCError ? taskVisualizationPublicationRejectionCodeSchema.safeParse(error.code) : null;
			if (rejectionCode?.success)
				await this.store.recordPublicationRejection(input.publicationRequestId, {
					failureCode: rejectionCode.data,
					failure: error instanceof Error ? error.message : String(error),
				});
			throw error;
		}
	}

	async list(scope: TaskVisualizationWorkspaceScope, input: { taskId: string }) {
		return {
			artifacts: await this.store.list(scope.workspaceId, input.taskId),
			latestPreviewRequest:
				(await this.store.readRegistry(scope.workspaceId, input.taskId)).previewRequests.at(-1) ?? null,
			visualizationPublicationProtocolVersion: TASK_VISUALIZATION_PUBLICATION_PROTOCOL_VERSION,
		};
	}

	private async selectedArtifact(
		scope: TaskVisualizationWorkspaceScope,
		input: { taskId: string; visualizationArtifactId: string; revisionId?: string },
	): Promise<TaskVisualizationArtifact> {
		const artifact = (await this.store.list(scope.workspaceId, input.taskId)).find(
			(entry) => entry.visualizationArtifactId === input.visualizationArtifactId,
		);
		if (!artifact) throw new Error("未找到此任务的可视化。");
		return input.revisionId ? await this.store.readRevisionArtifact(artifact, input.revisionId) : artifact;
	}

	async preparePreview(
		scope: TaskVisualizationWorkspaceScope,
		input: { taskId: string; visualizationArtifactId: string; revisionId?: string },
	) {
		const artifact = await this.selectedArtifact(scope, input);
		await this.store.readRevisionFile(artifact, artifact.entryHtmlRelativePath);
		const contentAccessExpiresAtMs = this.now() + 24 * 60 * 60 * 1000;
		const contentLoadConfirmationId = randomUUID();
		const payload = Buffer.from(
			JSON.stringify(
				contentCapabilitySchema.parse({
					artifact,
					expiresAtMs: contentAccessExpiresAtMs,
					contentLoadConfirmationId,
				}),
			),
		).toString("base64url");
		const signature = createHmac("sha256", await this.readContentAccessSecret())
			.update(payload)
			.digest("base64url");
		const entryPath = artifact.entryHtmlRelativePath.split("/").map(encodeURIComponent).join("/");
		return {
			artifact,
			contentAccessExpiresAtMs,
			contentLoadConfirmationId,
			viewerRelativeUrl: taskVisualizationViewerRelativeUrl(artifact),
			contentRelativeUrl: `/api/task-visualization-content/${payload}.${signature}/${entryPath}`,
		};
	}

	async requestPreview(
		scope: TaskVisualizationWorkspaceScope,
		input: { taskId: string; visualizationArtifactId: string; revisionId?: string },
	) {
		await this.dependencies.assertTaskMayPublish(scope, input.taskId);
		const artifact = await this.selectedArtifact(scope, input);
		const previewRequestId = randomUUID();
		await this.store.mutateRegistry(scope.workspaceId, input.taskId, (state) => ({
			...state,
			previewRequests: [
				...state.previewRequests,
				{
					previewRequestId,
					visualizationArtifactId: artifact.visualizationArtifactId,
					revisionId: artifact.revisionId,
					requestedAtMs: this.now(),
					displayedAtMs: null,
				},
			],
		}));
		await this.dispatchTaskPreviews(scope.workspaceId, input.taskId);
		return { previewRequestId };
	}

	private readContentAccessSecret(): Promise<Buffer> {
		if (!this.secretPromise) {
			this.secretPromise = (async () => {
				const directory = taskVisualizationStorageDirectory(this.store.runtimeHomeDirectoryPath);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const secretPath = join(directory, "content-read-capability-signing-secret");
				try {
					await writeFile(secretPath, randomBytes(32), { mode: 0o600, flag: "wx" });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				const secret = await readFile(secretPath);
				if (secret.length !== 32) throw new Error("可视化只读凭据密钥损坏。");
				return secret;
			})().catch((error: unknown) => {
				this.secretPromise = null;
				throw error;
			});
		}
		return this.secretPromise;
	}

	async readContent(capability: string, relativeFilePath: string) {
		const [payload, signature, extra] = capability.split(".");
		if (!payload || !signature || extra || capability.length > 4096) throw new Error("可视化只读凭据无效。");
		const expected = createHmac("sha256", await this.readContentAccessSecret())
			.update(payload)
			.digest();
		const provided = Buffer.from(signature, "base64url");
		if (provided.length !== expected.length || !timingSafeEqual(expected, provided))
			throw new Error("可视化只读凭据无效。");
		const contentAccess = contentCapabilitySchema.parse(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
		if (contentAccess.expiresAtMs <= this.now()) throw new Error("可视化只读凭据已过期，请刷新查看器。");
		const latest = (await this.store.list(contentAccess.artifact.workspaceId, contentAccess.artifact.taskId)).find(
			(artifact) => artifact.visualizationArtifactId === contentAccess.artifact.visualizationArtifactId,
		);
		if (!latest) throw new Error("可视化资源不存在。");
		const revisionArtifact = await this.store.readRevisionArtifact(latest, contentAccess.artifact.revisionId);
		const resource = await this.store.readRevisionFile(revisionArtifact, relativeFilePath);
		return {
			...resource,
			contentLoadConfirmation:
				relativeFilePath === revisionArtifact.entryHtmlRelativePath
					? {
							type: "kanban_visualization_content_loaded" as const,
							...contentAccess.artifact,
							contentLoadConfirmationId: contentAccess.contentLoadConfirmationId,
						}
					: null,
		};
	}

	async observeBrowserContext(
		connection: unknown,
		workspaceId: string,
		declaration: TaskVisualizationBrowserContextMessage,
		send: BrowserPreviewContext["send"],
	): Promise<void> {
		const previous = this.browserContexts.get(connection);
		const taskChanged =
			!previous || previous.declaration.taskId !== declaration.taskId || previous.workspaceId !== workspaceId;
		const interacted =
			taskChanged ||
			previous.declaration.interactionSequence !== declaration.interactionSequence ||
			(!previous.declaration.isForeground && declaration.isForeground);
		this.browserContexts.set(connection, {
			workspaceId,
			declaration,
			send,
			taskFocusedAtMs: taskChanged ? this.now() : previous.taskFocusedAtMs,
			lastInteractionOrder: interacted ? ++this.interactionOrder : previous.lastInteractionOrder,
			lastHeartbeatAtMs: this.now(),
		});
		if (declaration.taskId && declaration.isForeground)
			await this.dispatchTaskPreviews(workspaceId, declaration.taskId);
	}

	forgetBrowserClient(connection: unknown): void {
		this.browserContexts.delete(connection);
		for (const offer of this.offeredRequests.values()) {
			if (offer.connection !== connection) continue;
			void this.withTaskPreviewRoutingLock(offer.workspaceId, offer.taskId, async () => {
				if (this.offeredRequests.get(offer.previewRequest.previewRequestId) !== offer) return;
				this.offeredRequests.delete(offer.previewRequest.previewRequestId);
				if (offer.acceptedAtMs !== undefined) {
					// 断线不能证明旧 frame 已卸载；终止自动路由，保留可手动重试的失败事实。
					await this.recordPreviewDeliveryFailure(offer, "已接受预览的页面断开连接，请手动重试预览。", true);
				} else {
					await this.dispatchTaskPreviewsInsideRoutingLock(offer.workspaceId, offer.taskId);
				}
			}).catch((error: unknown) => this.reportBrowserRoutingFailure(error));
		}
	}

	private async withTaskPreviewRoutingLock<T>(
		workspaceId: string,
		taskId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const taskKey = JSON.stringify([workspaceId, taskId]);
		const previous = this.dispatchInFlightByTask.get(taskKey) ?? Promise.resolve();
		const result = previous.catch(() => {}).then(operation);
		const completed = result.then(
			() => {},
			() => {},
		);
		this.dispatchInFlightByTask.set(taskKey, completed);
		try {
			return await result;
		} finally {
			if (this.dispatchInFlightByTask.get(taskKey) === completed) this.dispatchInFlightByTask.delete(taskKey);
		}
	}

	private sendPreviewDelivery(
		offer: BrowserPreviewOffer,
		deliveryState: TaskVisualizationPreviewRequestedMessage["deliveryState"],
		deliveryFailureReason?: string,
	): void {
		this.browserContexts.get(offer.connection)?.send({
			type: "task_visualization_preview_requested",
			workspaceId: offer.workspaceId,
			taskId: offer.taskId,
			browserPageId: offer.browserPageId,
			deliveryAttemptId: offer.deliveryAttemptId,
			deliveryState,
			previewRequest: offer.previewRequest,
			...(deliveryFailureReason ? { deliveryFailureReason } : {}),
		});
	}

	private async recordPreviewDeliveryFailure(
		offer: BrowserPreviewOffer,
		reason: string,
		isTerminal: boolean,
	): Promise<void> {
		await this.store.mutateRegistry(offer.workspaceId, offer.taskId, (state) => ({
			...state,
			previewRequests: state.previewRequests.map((request) =>
				request.previewRequestId === offer.previewRequest.previewRequestId
					? {
							...request,
							acceptedDeliveryAttemptId: undefined,
							acceptedByBrowserPageId: undefined,
							acceptedAtMs: undefined,
							deliveryFailureReason: reason,
							...(isTerminal ? { failedAtMs: this.now() } : {}),
						}
					: request,
			),
		}));
		this.dependencies.warn(`可视化预览 ${offer.previewRequest.previewRequestId}：${reason}`);
		this.dependencies.onArtifactsUpdated(offer.workspaceId, offer.taskId);
	}

	async acknowledgePreview(
		connection: unknown,
		workspaceId: string,
		acknowledgment: TaskVisualizationPreviewAcknowledgmentMessage,
	): Promise<void> {
		await this.withTaskPreviewRoutingLock(workspaceId, acknowledgment.taskId, async () => {
			const context = this.browserContexts.get(connection);
			const offer = this.offeredRequests.get(acknowledgment.previewRequestId);
			if (
				!context ||
				!offer ||
				offer.connection !== connection ||
				offer.workspaceId !== workspaceId ||
				offer.taskId !== acknowledgment.taskId ||
				context.workspaceId !== workspaceId ||
				context.declaration.taskId !== acknowledgment.taskId ||
				context.declaration.browserPageId !== acknowledgment.browserPageId ||
				offer.browserPageId !== acknowledgment.browserPageId ||
				offer.deliveryAttemptId !== acknowledgment.deliveryAttemptId
			)
				return;
			if (acknowledgment.outcome === "accepted") {
				if (offer.cancellationRequestedAtMs !== undefined) return;
				if (offer.acceptedAtMs === undefined) {
					if (this.now() - offer.offeredAtMs >= 5_000 || !context.declaration.isForeground) return;
					const acceptedAtMs = this.now();
					await this.store.mutateRegistry(workspaceId, acknowledgment.taskId, (state) => ({
						...state,
						previewRequests: state.previewRequests.map((request) =>
							request.previewRequestId === acknowledgment.previewRequestId
								? {
										...request,
										acceptedDeliveryAttemptId: offer.deliveryAttemptId,
										acceptedByBrowserPageId: offer.browserPageId,
										acceptedAtMs,
									}
								: request,
						),
					}));
					offer.acceptedAtMs = acceptedAtMs;
				}
				// 页面必须等服务端授予唯一接受权，才可以准备和挂载 iframe。
				this.sendPreviewDelivery(offer, "accepted");
				return;
			}
			if (
				acknowledgment.outcome === "displayed" &&
				(offer.acceptedAtMs === undefined || offer.cancellationRequestedAtMs !== undefined)
			)
				return;
			if (acknowledgment.outcome === "declined" && offer.acceptedAtMs !== undefined) return;
			this.offeredRequests.delete(acknowledgment.previewRequestId);
			if (acknowledgment.outcome === "displayed" || acknowledgment.outcome === "dismissed") {
				await this.store.mutateRegistry(workspaceId, acknowledgment.taskId, (state) => ({
					...state,
					previewRequests: state.previewRequests.map((request) =>
						request.previewRequestId === acknowledgment.previewRequestId
							? {
									...request,
									...(acknowledgment.outcome === "displayed"
										? { displayedAtMs: this.now() }
										: { dismissedAtMs: this.now() }),
								}
							: request,
					),
				}));
			} else {
				// failed 由页面卸载 frame 后发出；declined 表示页面从未挂载，二者才允许改派。
				await this.recordPreviewDeliveryFailure(
					offer,
					acknowledgment.failureReason ?? "页面未接受或加载失败，尝试其他前台页面。",
					false,
				);
				await this.dispatchTaskPreviewsInsideRoutingLock(workspaceId, acknowledgment.taskId);
			}
		});
	}

	private async dispatchTaskPreviews(workspaceId: string, taskId: string): Promise<void> {
		await this.withTaskPreviewRoutingLock(workspaceId, taskId, () =>
			this.dispatchTaskPreviewsInsideRoutingLock(workspaceId, taskId),
		);
	}

	private async dispatchTaskPreviewsInsideRoutingLock(workspaceId: string, taskId: string): Promise<void> {
		const registry = await this.store.readRegistry(workspaceId, taskId);
		const lastCompletedIndex = registry.previewRequests.reduce(
			(lastCompleted, request, index) =>
				request.displayedAtMs !== null || request.dismissedAtMs != null || request.failedAtMs !== undefined
					? index
					: lastCompleted,
			-1,
		);
		const pending = registry.previewRequests.slice(lastCompletedIndex + 1).at(-1);
		if (!pending) return;
		const offered = this.offeredRequests.get(pending.previewRequestId);
		if (offered?.acceptedAtMs !== undefined) {
			if (offered.cancellationRequestedAtMs !== undefined) {
				if (this.now() - offered.cancellationRequestedAtMs >= 10_000) {
					this.offeredRequests.delete(pending.previewRequestId);
					await this.recordPreviewDeliveryFailure(
						offered,
						"页面未确认取消，已停止自动改派，请手动重试预览。",
						true,
					);
				}
			} else if (this.now() - offered.acceptedAtMs >= 45_000) {
				offered.cancellationRequestedAtMs = this.now();
				this.sendPreviewDelivery(offered, "cancelled", "预览加载超时，正在取消当前页面。请手动重试预览。");
			}
			return;
		}
		if (pending.acceptedDeliveryAttemptId) {
			// 接受事实持久化后不会因服务重建而退回待投递，避免未知旧页面继续显示时复制打开。
			await this.store.mutateRegistry(workspaceId, taskId, (state) => ({
				...state,
				previewRequests: state.previewRequests.map((request) =>
					request.previewRequestId === pending.previewRequestId
						? {
								...request,
								failedAtMs: this.now(),
								deliveryFailureReason: "运行时重启中断预览确认，请手动重试预览。",
							}
						: request,
				),
			}));
			this.dependencies.warn(`可视化预览 ${pending.previewRequestId}：运行时重启中断预览确认。`);
			this.dependencies.onArtifactsUpdated(workspaceId, taskId);
			return;
		}
		if (offered && this.now() - offered.offeredAtMs < 5_000) return;
		if (offered) this.offeredRequests.delete(pending.previewRequestId);
		const attemptedPages = pending.attemptedBrowserPageIds ?? [];
		const candidates = [...this.browserContexts.entries()]
			.filter(
				([, context]) =>
					context.workspaceId === workspaceId &&
					context.declaration.taskId === taskId &&
					context.declaration.isForeground &&
					context.declaration.previewDeliveryProtocolVersion === "page-acceptance-and-content-confirmation/v1" &&
					this.now() - context.lastHeartbeatAtMs < 30_000 &&
					context.taskFocusedAtMs <= pending.requestedAtMs &&
					!attemptedPages.includes(context.declaration.browserPageId),
			)
			.sort((left, right) => right[1].lastInteractionOrder - left[1].lastInteractionOrder);
		const selected = candidates[0];
		if (
			(pending.deliveryAttemptCount ?? 0) >= MAXIMUM_PREVIEW_DELIVERY_ATTEMPTS ||
			(!selected && attemptedPages.length > 0)
		) {
			const reason = `${pending.deliveryFailureReason ?? "页面没有确认接受。"} 自动预览已达到重试上限或无其他可接收页面，请手动选择产物重试。`;
			await this.store.mutateRegistry(workspaceId, taskId, (state) => ({
				...state,
				previewRequests: state.previewRequests.map((request) =>
					request.previewRequestId === pending.previewRequestId
						? { ...request, failedAtMs: this.now(), deliveryFailureReason: reason }
						: request,
				),
			}));
			this.dependencies.warn(`可视化预览 ${pending.previewRequestId}：${reason}`);
			this.dependencies.onArtifactsUpdated(workspaceId, taskId);
			return;
		}
		if (!selected) return;
		const nextRequest = {
			...pending,
			deliveryAttemptCount: (pending.deliveryAttemptCount ?? 0) + 1,
			attemptedBrowserPageIds: [...attemptedPages, selected[1].declaration.browserPageId],
		};
		await this.store.mutateRegistry(workspaceId, taskId, (state) => ({
			...state,
			previewRequests: state.previewRequests.map((request) =>
				request.previewRequestId === pending.previewRequestId ? nextRequest : request,
			),
		}));
		const offer: BrowserPreviewOffer = {
			connection: selected[0],
			workspaceId,
			taskId,
			browserPageId: selected[1].declaration.browserPageId,
			deliveryAttemptId: randomUUID(),
			previewRequest: nextRequest,
			offeredAtMs: this.now(),
		};
		this.offeredRequests.set(pending.previewRequestId, offer);
		this.sendPreviewDelivery(offer, "offered");
	}

	startRecovery(): void {
		if (this.recoveryInterval) return;
		const recover = () => {
			void this.recoverPendingPublications()
				.then(async () => {
					for (const offer of [...this.offeredRequests.values()])
						await this.dispatchTaskPreviews(offer.workspaceId, offer.taskId);
				})
				.catch((error: unknown) => this.dependencies.warn(`可视化发布恢复扫描失败：${String(error)}`));
		};
		recover();
		this.recoveryInterval = setInterval(recover, 15_000);
		this.recoveryInterval.unref();
	}

	async stop(): Promise<void> {
		if (this.recoveryInterval) clearInterval(this.recoveryInterval);
		this.recoveryInterval = null;
		await this.recoveryInFlight;
		this.browserContexts.clear();
		this.offeredRequests.clear();
	}

	async recoverPendingPublications(): Promise<void> {
		if (this.recoveryInFlight) return await this.recoveryInFlight;
		const recovery = this.scanPendingPublications();
		this.recoveryInFlight = recovery;
		try {
			await recovery;
		} finally {
			if (this.recoveryInFlight === recovery) this.recoveryInFlight = null;
		}
	}

	private async scanPendingPublications(): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(pendingTaskVisualizationPublicationsDirectory(this.store.runtimeHomeDirectoryPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const requestId of entries) {
			if (!z.string().uuid().safeParse(requestId).success) continue;
			const attempt = this.recoveryAttempts.get(requestId);
			if (attempt && (attempt.attempts >= 5 || attempt.nextAttemptAtMs > this.now())) continue;
			const directory = pendingTaskVisualizationPublicationDirectory(this.store.runtimeHomeDirectoryPath, requestId);
			try {
				try {
					await readFile(join(directory, "accepted-artifact.json"));
					continue;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (await this.store.readPublicationRejection(requestId)) continue;
				const pending = await this.store.readPendingPublication(requestId);
				const scope = await this.dependencies.resolveWorkspaceScope(pending.workspaceId);
				if (!scope) continue;
				await this.publish(scope, { taskId: pending.taskId, publicationRequestId: requestId });
				this.recoveryAttempts.delete(requestId);
			} catch (error) {
				if (
					error instanceof TRPCError &&
					taskVisualizationPublicationRejectionCodeSchema.safeParse(error.code).success
				) {
					this.recoveryAttempts.delete(requestId);
					this.dependencies.warn(`可视化发布 ${requestId} 已被明确拒绝：${String(error)}`);
					continue;
				}
				const attempts = (attempt?.attempts ?? 0) + 1;
				const nextAttemptAtMs = this.now() + Math.min(300_000, 15_000 * 2 ** (attempts - 1));
				this.recoveryAttempts.set(requestId, { attempts, nextAttemptAtMs });
				await lockedFileSystem.writeJsonFileAtomic(join(directory, "latest-runtime-acceptance-failure.json"), {
					runtimeInstanceId: this.runtimeInstanceId,
					attemptsInThisRuntime: attempts,
					nextAttemptAtMs: attempts < 5 ? nextAttemptAtMs : null,
					recoveryCondition:
						attempts < 5
							? "bounded_retry_after_deadline_or_runtime_restart"
							: "next_runtime_restart_or_explicit_publication_retry",
					failure: error instanceof Error ? error.message : String(error),
					observedAtMs: this.now(),
				});
				this.dependencies.warn(`可视化发布 ${requestId} 暂未接受：${String(error)}`);
			}
		}
	}
}
