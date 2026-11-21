import pLimit from "p-limit";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import {
	type BacklogTaskStartReadinessOperation,
	listBacklogTaskStartReadinessOperations,
} from "./backlog-task-start-readiness-operation-store";
import { BacklogTaskStartReadinessRuntimeClosingError } from "./backlog-task-start-readiness-service";

// 仅接续已持久受理的启动意图；从不枚举或主动开启未请求的 Backlog。
export function createBacklogTaskStartReadinessRecovery(dependencies: {
	resolveScope: (record: BacklogTaskStartReadinessOperation) => Promise<RuntimeTrpcWorkspaceScope | null>;
	resume: (
		scope: RuntimeTrpcWorkspaceScope,
		record: BacklogTaskStartReadinessOperation,
		assertStillOpen: () => Promise<void>,
	) => Promise<unknown>;
	warn: (message: string) => void;
}) {
	const limit = pLimit(2);
	const warned = new Set<string>();
	let closed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let sweeping: Promise<void> | undefined;
	const sweep = async () => {
		const records = await listBacklogTaskStartReadinessOperations((path, error) => {
			if (warned.has(path)) return;
			warned.add(path);
			dependencies.warn(`开启复核记录不可读，保留原文件并继续其他任务 ${path}: ${String(error)}`);
		});
		await Promise.allSettled(
			records
				.filter(
					(record) =>
						record.startRequested &&
						[
							"reviewing",
							"waiting_for_evidence",
							"conditions_not_met",
							"human_decision_required",
							"invalidated",
							"ready",
							"launching",
						].includes(record.review.phase) &&
						record.nextAttemptAtEpochMs <= Date.now(),
				)
				.map((record) =>
					limit(async () => {
						if (closed) return;
						const scope = await dependencies.resolveScope(record);
						if (!scope) return;
						try {
							await dependencies.resume(scope, record, async () => {
								if (closed) throw new BacklogTaskStartReadinessRuntimeClosingError();
							});
						} catch (error) {
							const key = `${record.review.operationId}:${String(error)}`;
							if (!warned.has(key)) {
								warned.add(key);
								dependencies.warn(`开启复核等待重新核验：${key}`);
							}
						}
					}),
				),
		);
	};
	const tick = () => {
		if (closed || sweeping) return;
		sweeping = sweep()
			.catch((error) => dependencies.warn(`开启复核恢复读取失败：${String(error)}`))
			.finally(() => {
				sweeping = undefined;
			});
	};
	return {
		start() {
			if (timer || closed) return;
			tick();
			timer = setInterval(tick, 15000);
			timer.unref();
		},
		async close() {
			closed = true;
			clearInterval(timer);
			await sweeping;
		},
	};
}
