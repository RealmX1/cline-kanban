import * as fileSystem from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as verificationState from "../../../src/deployment/post-deploy-verification-state";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";

vi.mock("node:fs/promises", { spy: true });

it("最初的状态读取挂起时，RPC 在清理预算内明确拒绝且不开始受理", async () => {
	let allowInitialReadToFinish: () => void = () => {};
	const initialReadMayFinish = new Promise<void>((resolve) => {
		allowInitialReadToFinish = resolve;
	});
	vi.mocked(fileSystem.readFile).mockImplementationOnce(async () => {
		await initialReadMayFinish;
		return JSON.stringify({ deploymentGroups: [] });
	});
	const loadBoardTasksForWorkspace = vi.fn(async () => []);
	const setVerificationRunState = vi.spyOn(verificationState, "setVerificationRunState");
	const api = createDeploymentApi({
		loadBoardTasksForWorkspace,
		loadTaskAgentResponsePreview: async () => null,
	});
	vi.useFakeTimers();
	const pendingResponse = api.runPostDeployVerificationItem(
		{ workspaceId: "isolated-initial-read-workspace", workspacePath: "/isolated-initial-read-workspace" },
		{ deploymentId: "isolated-initial-read-deployment", taskId: "initial-read-task", itemId: "initial-read-item" },
	);
	let response: Awaited<typeof pendingResponse> | undefined;
	void pendingResponse.then((value) => {
		response = value;
	});
	try {
		await vi.advanceTimersByTimeAsync(5_001);
		expect(response).toMatchObject({ ok: false, task: null, error: expect.any(String) });
		expect(loadBoardTasksForWorkspace).not.toHaveBeenCalled();
		expect(setVerificationRunState).not.toHaveBeenCalled();
	} finally {
		allowInitialReadToFinish();
		await pendingResponse;
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});
