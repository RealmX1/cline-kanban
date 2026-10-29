import { randomUUID } from "node:crypto";
import { lstat, statfs } from "node:fs/promises";
import { delimiter } from "node:path";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { getGitStdout } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import {
	listTaskClosureOperations,
	logTaskClosureRecoveryFailure,
	readTaskClosureOperation,
	type TaskClosureOperation,
	taskClosureIdentityKey,
	withTaskClosureLifecycleLocks,
	writeTaskClosureOperation,
} from "./task-closure-operation-store";

const needsOperationRecovery = (operation: TaskClosureOperation) =>
	!!(operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase)) ||
	!["completed", "cancelled"].includes(operation.progress.phase);

async function readRecoveryConditionFingerprint(operation: TaskClosureOperation) {
	let source = "来源不存在";
	if (operation.sourceWorktreePath) {
		try {
			const [status, diff, untracked, disk] = await Promise.all([
				getGitStdout(["--no-optional-locks", "status", "--porcelain=v1"], operation.sourceWorktreePath),
				getGitStdout(["diff", "--binary", "--full-index", "HEAD", "--"], operation.sourceWorktreePath),
				getGitStdout(["ls-files", "--others", "--exclude-standard", "-z"], operation.sourceWorktreePath, {
					trimStdout: false,
				}),
				statfs(operation.sourceWorktreePath),
			]);
			const fileChanges = await Promise.all(
				[
					...untracked.split("\0").filter(Boolean),
					...(operation.request.closure?.selectedArtifactRelativePaths ?? []),
				].map(async (path) => {
					try {
						const info = await lstat(`${operation.sourceWorktreePath}/${path}`);
						return [path, info.size, info.mtimeMs];
					} catch {
						return [path, "不可读"];
					}
				}),
			);
			source = JSON.stringify([
				status,
				diff,
				fileChanges,
				Math.floor((disk.bavail * disk.bsize) / (64 * 1024 * 1024)),
			]);
		} catch (error) {
			source = String(error);
		}
	}
	let taskOwnershipEvidence: unknown;
	try {
		const board = await loadWorkspaceBoardById(operation.taskIdentity.workspaceId);
		const column = board.columns.find((entry) =>
			entry.cards.some((card) => card.id === operation.taskIdentity.taskId),
		);
		const card = column?.cards.find((entry) => entry.id === operation.taskIdentity.taskId);
		const worktree = card
			? await getTaskWorkspacePathInfo({
					cwd: operation.workspacePath,
					taskId: card.id,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
				})
			: null;
		taskOwnershipEvidence = [
			column?.id,
			card?.createdAt,
			card?.updatedAt,
			card?.taskShelvingState?.isShelved,
			card?.taskClosureSummary?.closureRequestId,
			worktree?.path,
			worktree?.exists,
		];
	} catch (error) {
		taskOwnershipEvidence = String(error);
	}
	const processExitEvidence = (operation.processIdsAwaitingExit ?? []).map((pid) => {
		try {
			process.kill(pid, 0);
			return [pid, "仍存活"];
		} catch (error) {
			return [pid, (error as NodeJS.ErrnoException).code ?? "未知"];
		}
	});
	const toolingDirectoryEvidence = await Promise.all(
		(process.env.PATH ?? "")
			.split(delimiter)
			.filter(Boolean)
			.map(async (path) => {
				try {
					const info = await lstat(path);
					return [path, info.mtimeMs];
				} catch {
					return [path, "不可读"];
				}
			}),
	);
	return taskClosureIdentityKey([source, taskOwnershipEvidence, processExitEvidence, toolingDirectoryEvidence]);
}

/** 条件无变化时不重复归档；运行时新一代有一次恢复预算，记录仍保留原失败历史。 */
export function createTaskClosureRecoveryMonitor(execute: (operation: TaskClosureOperation) => Promise<void>) {
	const runtimeInstanceId = randomUUID();
	let timer: ReturnType<typeof setInterval> | null = null;
	let running: Promise<void> | null = null;
	let closed = false;
	const sweep = async () => {
		for (const operation of await listTaskClosureOperations()) {
			if (closed || !needsOperationRecovery(operation)) continue;
			const fingerprint = await readRecoveryConditionFingerprint(operation);
			if (
				operation.lastAttemptRuntimeInstanceId === runtimeInstanceId &&
				operation.lastRecoveryProbeFingerprint === fingerprint
			)
				continue;
			// 状态条件先持久化，再执行；同一代条件未变只消费一次三次重试预算。
			const claimed = await withTaskClosureLifecycleLocks(
				operation.taskIdentity.workspaceId,
				[operation.taskIdentity.taskId],
				async () => {
					const current = await readTaskClosureOperation(
						operation.taskIdentity,
						operation.progress.closureRequestId,
					);
					if (!current || !needsOperationRecovery(current)) return null;
					current.lastAttemptRuntimeInstanceId = runtimeInstanceId;
					current.lastRecoveryProbeFingerprint = fingerprint;
					await writeTaskClosureOperation(current);
					return current;
				},
			);
			if (claimed) {
				await execute(claimed).catch(async (error: unknown) => {
					logTaskClosureRecoveryFailure(claimed.progress.closureRequestId, error);
					await withTaskClosureLifecycleLocks(
						claimed.taskIdentity.workspaceId,
						[claimed.taskIdentity.taskId],
						async () => {
							const current = await readTaskClosureOperation(
								claimed.taskIdentity,
								claimed.progress.closureRequestId,
							);
							if (!current || !needsOperationRecovery(current)) return;
							if (current.reopening && !["completed", "cancelled"].includes(current.reopening.phase))
								current.reopening.lastError = `自动恢复失败：${error instanceof Error ? error.message : String(error)}`;
							else
								current.progress.lastError = `自动恢复失败：${error instanceof Error ? error.message : String(error)}`;
							await writeTaskClosureOperation(current);
						},
					);
				});
				await withTaskClosureLifecycleLocks(
					operation.taskIdentity.workspaceId,
					[operation.taskIdentity.taskId],
					async () => {
						const current = await readTaskClosureOperation(
							operation.taskIdentity,
							operation.progress.closureRequestId,
						);
						if (!current || !needsOperationRecovery(current)) return;
						current.lastRecoveryProbeFingerprint = await readRecoveryConditionFingerprint(current);
						await writeTaskClosureOperation(current);
					},
				);
			}
		}
	};
	const kick = () => {
		if (!closed && !running)
			running = sweep()
				.catch((error: unknown) => logTaskClosureRecoveryFailure("扫描持久操作", error))
				.finally(() => {
					running = null;
				});
	};
	return {
		start() {
			kick();
			timer ??= setInterval(kick, 15_000);
			timer.unref();
		},
		async close() {
			closed = true;
			if (timer) clearInterval(timer);
			await running;
		},
	};
}
