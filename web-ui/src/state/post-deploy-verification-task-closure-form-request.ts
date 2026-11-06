import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import type { BoardCard } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

interface PostDeployVerificationTaskClosureFormRequest {
	requestId: string;
	workspaceId: string;
	card: BoardCard;
}
interface PendingPostDeployVerificationTaskClosureForm {
	request: PostDeployVerificationTaskClosureFormRequest;
	promise: Promise<TaskCommentToAppendWhenMovingIntoDone | null>;
	resolve: (comment: TaskCommentToAppendWhenMovingIntoDone | null) => void;
}
const pendingRequests = new Map<string, PendingPostDeployVerificationTaskClosureForm>();
let pendingRequestSnapshot: PostDeployVerificationTaskClosureFormRequest[] = [];
let mountedHostCount = 0;
const listeners = new Set<() => void>();
export const readPostDeployVerificationTaskClosureFormRequest = () => pendingRequestSnapshot[0] ?? null;
export const readPostDeployVerificationTaskClosureFormRequests = () => pendingRequestSnapshot;
export const subscribeToPostDeployVerificationTaskClosureFormRequest = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
function publishPendingClosureFormRequests() {
	pendingRequestSnapshot = Array.from(pendingRequests.values(), (pending) => pending.request);
	for (const listener of listeners) listener();
}
export function settlePostDeployVerificationTaskClosureFormRequest(
	requestId: string,
	comment: TaskCommentToAppendWhenMovingIntoDone | null,
) {
	const pending = pendingRequests.get(requestId);
	if (!pending) return;
	pendingRequests.delete(requestId);
	publishPendingClosureFormRequests();
	pending.resolve(comment);
}
export function registerPostDeployVerificationTaskClosureFormHost() {
	mountedHostCount += 1;
	return () => {
		mountedHostCount -= 1;
		if (mountedHostCount === 0)
			for (const requestId of pendingRequests.keys())
				settlePostDeployVerificationTaskClosureFormRequest(requestId, null);
	};
}

/** PDV 面板（含当前浏览器未水合的项目）通过同一表单补充结果；旧宿主仍按未标注兼容。 */
export async function requestPostDeployVerificationTaskClosureForm(
	workspaceId: string,
	taskId: string,
	expectedCreatedAt?: number,
) {
	if (mountedHostCount === 0) return undefined;
	const found = await readTaskCardWithBoardColumnInWorkspace(workspaceId, taskId, expectedCreatedAt);
	if (found.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
		throw new Error("任务不存在，未执行结案。");
	if (expectedCreatedAt !== undefined && found.taskCardSnapshot.taskCard.createdAt !== expectedCreatedAt)
		throw new Error("原任务身份已失效，未打开结案填写窗口。");
	if (found.taskCardSnapshot.boardColumnIdContainingTaskCard === "trash") return undefined;
	if (mountedHostCount === 0) return null;
	const existing = Array.from(pendingRequests.values()).find(
		(pending) =>
			pending.request.workspaceId === workspaceId &&
			pending.request.card.id === taskId &&
			pending.request.card.createdAt === found.taskCardSnapshot.taskCard.createdAt,
	);
	if (existing) return await existing.promise;
	const request = {
		requestId: createRandomUuidV4WithInsecureContextFallback(),
		workspaceId,
		card: found.taskCardSnapshot.taskCard,
	};
	let settle!: (comment: TaskCommentToAppendWhenMovingIntoDone | null) => void;
	const promise = new Promise<TaskCommentToAppendWhenMovingIntoDone | null>((resolve) => {
		settle = resolve;
	});
	pendingRequests.set(request.requestId, { request, promise, resolve: settle });
	publishPendingClosureFormRequests();
	return await promise;
}
