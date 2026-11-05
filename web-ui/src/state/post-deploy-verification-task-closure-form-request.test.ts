import { afterEach, expect, it, vi } from "vitest";
import {
	readPostDeployVerificationTaskClosureFormRequests,
	registerPostDeployVerificationTaskClosureFormHost,
	requestPostDeployVerificationTaskClosureForm,
	settlePostDeployVerificationTaskClosureFormRequest,
} from "./post-deploy-verification-task-closure-form-request";

vi.mock("@/runtime/task-card-action-query", () => ({
	readTaskCardWithBoardColumnInWorkspace: vi.fn(async (_workspaceId: string, taskId: string, createdAt?: number) => ({
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: {
			boardColumnIdContainingTaskCard: "validation",
			taskCard: { id: taskId, title: taskId, createdAt: createdAt ?? 100 },
		},
	})),
}));

let unregisterHost: (() => void) | undefined;
afterEach(() => unregisterHost?.());

it("多个任务的结案填写独立等待，同一对象重复请求复用窗口，关闭与响应只结算所属请求", async () => {
	unregisterHost = registerPostDeployVerificationTaskClosureFormHost();
	const first = requestPostDeployVerificationTaskClosureForm("project-a", "a1b2c", 100);
	const duplicate = requestPostDeployVerificationTaskClosureForm("project-a", "a1b2c", 100);
	const second = requestPostDeployVerificationTaskClosureForm("project-b", "d3e4f", 200);
	await vi.waitFor(() => expect(readPostDeployVerificationTaskClosureFormRequests()).toHaveLength(2));
	const [firstRequest, secondRequest] = readPostDeployVerificationTaskClosureFormRequests();
	settlePostDeployVerificationTaskClosureFormRequest(firstRequest!.requestId, null);
	expect(await first).toBeNull();
	expect(await duplicate).toBeNull();
	expect(readPostDeployVerificationTaskClosureFormRequests()).toEqual([secondRequest]);
	settlePostDeployVerificationTaskClosureFormRequest(firstRequest!.requestId, null);
	expect(readPostDeployVerificationTaskClosureFormRequests()).toHaveLength(1);
	settlePostDeployVerificationTaskClosureFormRequest(secondRequest!.requestId, null);
	expect(await second).toBeNull();
});
