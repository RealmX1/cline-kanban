import { z } from "zod";
import { runtimeDailyWorkProgressMetricSchema } from "../core/api-contract";
import {
	measureDailyWorkProgressAsynchronousStage,
	measureDailyWorkProgressSynchronousStage,
	readUtf8FileWithDailyWorkProgressCostObservation,
} from "../diagnostics/daily-work-progress-collection-cost-recorder";
import { lockedFileSystem } from "../fs/locked-file-system";
import { taskUserPromptStatisticsCursorSchema } from "./task-user-prompt-statistics-transcript-reader";

const taskReferenceSchema = z.object({
	workspaceId: z.string(),
	taskId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
	taskTitle: z.string(),
});
const nativeSourceSchema = taskReferenceSchema.extend({
	kanbanConversationSessionId: z.string().optional(),
	sourceAgentId: z.string(),
	nativeSessionId: z.string(),
	transcriptPath: z.string(),
});
export type DailyWorkProgressNativeSource = z.infer<typeof nativeSourceSchema>;
export const dailyWorkProgressStatisticsStoreSchema = z.object({
	schemaVersion: z.literal(1),
	recordingStartedAtEpochMs: z.number(),
	revision: z.number().int().nonnegative(),
	ledgerCursor: z.number().int().nonnegative(),
	ledgerCaughtUp: z.boolean(),
	tasksByWorkspaceAndTaskKey: z.record(z.string(), taskReferenceSchema),
	nativeSourcesByIdentityKey: z.record(z.string(), nativeSourceSchema),
	transcriptCursorsByIdentityKey: z.record(z.string(), taskUserPromptStatisticsCursorSchema),
	workspaceCaptureStartedAtEpochMs: z.record(z.string(), z.number()),
	workspacePromptSourceInventoryDiscoveryCompleted: z.record(z.string(), z.boolean()).default({}),
	workspaceWarnings: z.record(z.string(), z.array(z.string())),
	factsByEventId: z.record(
		z.string(),
		taskReferenceSchema.extend({
			eventId: z.string(),
			metric: runtimeDailyWorkProgressMetricSchema,
			occurredAtEpochMs: z.number(),
		}),
	),
	eligibleAchievementIds: z.record(z.string(), z.number()),
	claimedAchievementIds: z.record(z.string(), z.number()),
});
export type DailyWorkProgressStatisticsStore = z.infer<typeof dailyWorkProgressStatisticsStoreSchema>;
export function createEmptyDailyWorkProgressStatisticsStore(now: number): DailyWorkProgressStatisticsStore {
	return {
		schemaVersion: 1,
		recordingStartedAtEpochMs: now,
		revision: 0,
		ledgerCursor: 0,
		ledgerCaughtUp: false,
		tasksByWorkspaceAndTaskKey: {},
		nativeSourcesByIdentityKey: {},
		transcriptCursorsByIdentityKey: {},
		workspaceCaptureStartedAtEpochMs: {},
		workspacePromptSourceInventoryDiscoveryCompleted: {},
		workspaceWarnings: {},
		factsByEventId: {},
		eligibleAchievementIds: {},
		claimedAchievementIds: {},
	};
}
export async function readDailyWorkProgressStatisticsStore(path: string): Promise<DailyWorkProgressStatisticsStore> {
	try {
		const raw = await measureDailyWorkProgressAsynchronousStage("statistics_read", async () => {
			const text = await readUtf8FileWithDailyWorkProgressCostObservation(path);
			return text;
		});
		return measureDailyWorkProgressSynchronousStage("statistics_parse", () =>
			dailyWorkProgressStatisticsStoreSchema.parse(JSON.parse(raw)),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return createEmptyDailyWorkProgressStatisticsStore(Date.now());
		throw error;
	}
}
/** 所有读改写与庆祝领取共享文件锁，多个页面及运行时不能覆盖彼此的领取结果。 */
export async function mutateDailyWorkProgressStatisticsStore<T>(
	path: string,
	operation: (state: DailyWorkProgressStatisticsStore) => Promise<T>,
): Promise<{ state: DailyWorkProgressStatisticsStore; result: T }> {
	let stopLockWait: (() => void) | undefined;
	const enteredLock = new Promise<void>((resolve) => {
		stopLockWait = resolve;
	});
	const lockWait = measureDailyWorkProgressAsynchronousStage("statistics_lock_wait", () => enteredLock);
	try {
		return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
			stopLockWait?.();
			const state = await readDailyWorkProgressStatisticsStore(path);
			// EXPERIMENT_NODE: 仅当序列化成为主要成本时，再评估覆盖全部持久状态的变更标记。
			const before = measureDailyWorkProgressSynchronousStage("statistics_stringify", () => JSON.stringify(state));
			const result = await operation(state);
			if (measureDailyWorkProgressSynchronousStage("statistics_stringify", () => JSON.stringify(state)) !== before) {
				const serialized = measureDailyWorkProgressSynchronousStage("statistics_stringify", () =>
					JSON.stringify(state, null, 2),
				);
				await measureDailyWorkProgressAsynchronousStage("statistics_write", () =>
					lockedFileSystem.writeTextFileAtomic(path, serialized, { lock: null }),
				);
			}
			return { state, result };
		});
	} finally {
		stopLockWait?.();
		await lockWait;
	}
}
