// `taskCardAction.*` 的按卡串行器：同一项目里同一张卡的生命周期命令在进程内排队，一条跑完下一条才开始。
//
// 为什么 board 锁不够：一个卡片动作是「board 锁内移列 → 锁外 ensure worktree / 起停会话 / 删 worktree」的多步链，
// board 锁只护住其中写盘那一步。双击「开始」、或「移入 Done」与「开始」交错时，两条链的锁外步骤会互相穿插——
// 一边刚删掉 worktree，另一边在同一路径上起会话。按 (workspaceId, taskId) 串起来之后，后到的命令看到的一定是
// 前一条命令完整落定之后的卡片，各 procedure 的幂等判据（已在目标列 / 会话已在 agent 回合）才成立。
//
// 只在 runtime 进程内有效：CLI 与浏览器的请求都经 runtime 进来，进程内一把就覆盖了全部入口。
// 前一条命令失败不影响后一条（链上吞掉失败，只把它交给原调用方）。

export interface TaskCardActionPerTaskCommandSerializer {
	// 多张卡（永久删除整列 / 多选）时同时排进每张卡的队列：等它们各自之前的命令都落定才开始，
	// 期间这些卡上新到的命令排在它后面。
	runTaskCardActionCommandSeriallyForTaskCards<TResult>(
		workspaceId: string,
		taskIds: readonly string[],
		taskCardActionCommand: () => Promise<TResult>,
	): Promise<TResult>;
}

function buildPerTaskCommandSerializationKey(workspaceId: string, taskId: string): string {
	// 换行不会出现在 workspace id / task id 里，拼接后不会有两组 (workspaceId, taskId) 撞到同一个键。
	return `${workspaceId}\n${taskId}`;
}

export function createTaskCardActionPerTaskCommandSerializer(): TaskCardActionPerTaskCommandSerializer {
	// 每张卡队尾那条命令「落定」的 promise（永不 reject）。队空时删键，Map 不随卡片数无限增长。
	const settledTailOfQueuedCommandsBySerializationKey = new Map<string, Promise<void>>();
	return {
		runTaskCardActionCommandSeriallyForTaskCards: (workspaceId, taskIds, taskCardActionCommand) => {
			const serializationKeys = [...new Set(taskIds)].map((taskId) =>
				buildPerTaskCommandSerializationKey(workspaceId, taskId),
			);
			const previousSettledTails = serializationKeys.map(
				(serializationKey) =>
					settledTailOfQueuedCommandsBySerializationKey.get(serializationKey) ?? Promise.resolve(),
			);
			const commandRun = Promise.all(previousSettledTails).then(taskCardActionCommand);
			const settledTailOfThisCommand = commandRun.then(
				() => undefined,
				() => undefined,
			);
			// 同步登记：两条几乎同时到达的命令也有确定的先后，不会都看到「队空」。
			for (const serializationKey of serializationKeys) {
				settledTailOfQueuedCommandsBySerializationKey.set(serializationKey, settledTailOfThisCommand);
			}
			void settledTailOfThisCommand.then(() => {
				for (const serializationKey of serializationKeys) {
					if (settledTailOfQueuedCommandsBySerializationKey.get(serializationKey) === settledTailOfThisCommand) {
						settledTailOfQueuedCommandsBySerializationKey.delete(serializationKey);
					}
				}
			});
			return commandRun;
		},
	};
}
