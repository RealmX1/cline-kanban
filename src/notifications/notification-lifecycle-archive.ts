import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
	type NotificationArchiveListRequest,
	type NotificationCandidate,
	notificationArchiveListRequestSchema,
	notificationArchiveListResponseSchema,
	notificationCandidateLifecycleSchema,
	notificationCandidateSchema,
} from "../core/notification-lifecycle-contract";
import { getRuntimeHomePath } from "../state/runtime-home-path";

export type CaptureNotificationCandidate = Pick<
	NotificationCandidate,
	"candidateId" | "workspaceId" | "taskId" | "triggeredAt" | "userTurnKind" | "sourceKind"
> &
	Partial<Omit<NotificationCandidate, "sequence">>;
export function getNotificationArchiveDirectory(): string {
	const testRoot = process.env.KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT;
	return testRoot
		? join(testRoot, createHash("sha256").update(getRuntimeHomePath()).digest("hex"))
		: join(getRuntimeHomePath(), "notification-lifecycle-archive");
}

export class NotificationLifecycleArchive {
	private worker: Worker | null = null;
	private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	constructor(readonly directory: string) {}
	private async request(command: string, input: unknown): Promise<unknown> {
		if (!this.worker) {
			const worker = new Worker(new URL("./notification-lifecycle-database-worker.mjs", import.meta.url), {
				workerData: { directory: this.directory },
			});
			this.worker = worker;
			worker.on("message", (message: { requestId: string; result?: unknown; error?: string }) => {
				const request = this.pending.get(message.requestId);
				this.pending.delete(message.requestId);
				if (message.error) request?.reject(new Error(message.error));
				else request?.resolve(message.result);
				if (this.pending.size === 0) worker.unref();
			});
			const fail = (error: Error) => {
				if (this.worker !== worker) return;
				for (const request of this.pending.values()) request.reject(error);
				this.pending.clear();
				if (this.worker === worker) this.worker = null;
			};
			worker.on("error", fail);
			worker.on("exit", () => fail(new Error("Notification archive worker exited")));
		}
		const requestId = randomUUID();
		this.worker.ref();
		return await new Promise((resolve, reject) => {
			this.pending.set(requestId, { resolve, reject });
			this.worker?.postMessage({ requestId, command, input });
		});
	}
	async capture(input: CaptureNotificationCandidate): Promise<NotificationCandidate> {
		return notificationCandidateSchema.parse(await this.request("capture", input));
	}
	async update(
		candidateId: string,
		patch: Partial<NotificationCandidate>,
		eventType: string,
		details: unknown,
	): Promise<NotificationCandidate> {
		return notificationCandidateSchema.parse(
			await this.request("update", { candidateId, patch, eventType, details }),
		);
	}
	async get(candidateId: string) {
		return notificationCandidateLifecycleSchema.nullable().parse(await this.request("get", { candidateId }));
	}
	async list(input: NotificationArchiveListRequest) {
		return notificationArchiveListResponseSchema.parse(
			await this.request("list", notificationArchiveListRequestSchema.parse(input)),
		);
	}
	async panelGroups(input: NotificationArchiveListRequest = {}) {
		return notificationArchiveListResponseSchema.parse(
			await this.request("panelGroups", notificationArchiveListRequestSchema.parse(input)),
		);
	}
	async syncTaskPanelStates(workspaceId: string, tasks: { taskId: string; isDone: boolean }[]) {
		return await this.request("taskStates", { workspaceId, tasks });
	}
	async markAllVisited(includeCompletedTasks: boolean) {
		return z.number().parse(await this.request("markAllVisited", { includeCompletedTasks }));
	}
	async clearAllPanels() {
		return z.number().parse(await this.request("clearAll", {}));
	}
	async clearPanel(workspaceId: string) {
		return z.number().parse(await this.request("clear", { workspaceId }));
	}
	async markVisited(workspaceId: string, taskId: string, visitedAt: number) {
		return await this.request("visited", { workspaceId, taskId, visitedAt });
	}
	async claimDelivery(candidateId: string, clientId: string) {
		return z.boolean().parse(await this.request("claim", { candidateId, clientId }));
	}
	async hasImportedLegacySource(sourcePath: string): Promise<boolean> {
		return z.boolean().parse(await this.request("hasImportedLegacySource", { sourcePath }));
	}
	async importLegacy(sourcePath: string, candidates: CaptureNotificationCandidate[]) {
		return await this.request("import", { sourcePath, candidates });
	}
	async recentReady(workspaceId: string, since: number) {
		return z.array(notificationCandidateSchema).parse(await this.request("recentReady", { workspaceId, since }));
	}
	async pendingAudioPersistenceCandidates() {
		return z.array(z.string()).parse(await this.request("pendingAudioPersistence", {}));
	}
	async pendingCandidates(afterSequence = 0) {
		return z.array(notificationCandidateSchema).parse(await this.request("pending", { afterSequence }));
	}
	async close(): Promise<void> {
		if (!this.worker) return;
		const worker = this.worker;
		await this.request("close", {});
		if (this.worker === worker) this.worker = null;
		await worker.terminate();
	}
}

let defaultArchive: NotificationLifecycleArchive | undefined;
export function getNotificationLifecycleArchive(): NotificationLifecycleArchive {
	const directory = getNotificationArchiveDirectory();
	if (defaultArchive?.directory !== directory) {
		const previous = defaultArchive;
		defaultArchive = new NotificationLifecycleArchive(directory);
		void previous?.close();
	}
	return defaultArchive;
}

export async function closeDefaultNotificationLifecycleArchive(): Promise<void> {
	await defaultArchive?.close();
	defaultArchive = undefined;
}
