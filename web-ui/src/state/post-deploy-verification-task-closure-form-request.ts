import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import type { BoardCard } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

interface PostDeployVerificationTaskClosureFormRequest {
	requestId: string;
	workspaceId: string;
	card: BoardCard;
}
let pendingRequest: PostDeployVerificationTaskClosureFormRequest | null = null;
let resolvePendingRequest: ((comment: TaskCommentToAppendWhenMovingIntoDone | null) => void) | null = null;
let mountedHostCount = 0;
const listeners = new Set<() => void>();
export const readPostDeployVerificationTaskClosureFormRequest = () => pendingRequest;
export const subscribeToPostDeployVerificationTaskClosureFormRequest = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export function settlePostDeployVerificationTaskClosureFormRequest(
	requestId: string,
	comment: TaskCommentToAppendWhenMovingIntoDone | null,
) {
	if (pendingRequest?.requestId !== requestId) return;
	const resolve = resolvePendingRequest;
	pendingRequest = null;
	resolvePendingRequest = null;
	for (const listener of listeners) listener();
	resolve?.(comment);
}
export function registerPostDeployVerificationTaskClosureFormHost() {
	mountedHostCount += 1;
	return () => {
		mountedHostCount -= 1;
		if (mountedHostCount === 0 && pendingRequest)
			settlePostDeployVerificationTaskClosureFormRequest(pendingRequest.requestId, null);
	};
}

/** PDV 面板（含当前浏览器未水合的项目）通过同一表单补充结果；旧宿主仍按未标注兼容。 */
export async function requestPostDeployVerificationTaskClosureForm(
	workspaceId: string,
	taskId: string,
	expectedCreatedAt?: number,
) {
	if (mountedHostCount === 0) return undefined;
	if (pendingRequest) throw new Error("另一项结案表单仍在等待，请先完成或取消。");
	const found = await readTaskCardWithBoardColumnInWorkspace(workspaceId, taskId, expectedCreatedAt);
	if (found.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
		throw new Error("任务不存在，未执行结案。");
	if (found.taskCardSnapshot.boardColumnIdContainingTaskCard === "trash") return undefined;
	if (mountedHostCount === 0) return null;
	if (pendingRequest) throw new Error("另一项结案表单仍在等待，请先完成或取消。");
	return await new Promise<TaskCommentToAppendWhenMovingIntoDone | null>((resolve) => {
		pendingRequest = {
			requestId: createRandomUuidV4WithInsecureContextFallback(),
			workspaceId,
			card: found.taskCardSnapshot.taskCard,
		};
		resolvePendingRequest = resolve;
		for (const listener of listeners) listener();
	});
}
