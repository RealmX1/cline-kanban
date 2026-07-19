import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimePostDeployVerificationState } from "../../../src/core/api-contract";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import { ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";
import { createTempDir } from "../../utilities/temp-dir";

// server 端「运行自动脚本」全链路（不经 HTTP/tRPC 传输，直接调 handler）：置 running → spawn 脚本 → 写结果 + 自动勾选。
describe.sequential("runPostDeployVerificationItem integration", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-verification-run-integ-");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = sandbox.path;
		process.env.USERPROFILE = sandbox.path;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		sandbox.cleanup();
	});

	const deploymentApi = createDeploymentApi({
		loadBoardTasksForWorkspace: async () => [],
		loadTaskAgentResponsePreview: async () => null,
	});

	async function seedAutomatedItem(scriptBody: string): Promise<{
		deploymentId: string;
		taskId: string;
		itemId: string;
	}> {
		const deploymentId = randomUUID();
		const verificationId = randomUUID();
		const itemId = `authored:${verificationId}`;
		const taskId = "task-run-integ";

		// 资产目录 + run.sh
		const assetsDir = await ensureVerificationAssetsDir(verificationId);
		writeFileSync(join(assetsDir, "run.sh"), scriptBody, "utf8");

		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				{
					deploymentId,
					workspaceId: "ws-1",
					deployedSourceCommit: "a".repeat(40),
					previousDeployedSourceCommit: null,
					deployedAtIso: "2026-06-01T00:00:00.000Z",
					foldedAtIso: null,
					tasks: [
						{
							taskId,
							columnIdAtMatch: "review",
							matchedCommits: [],
							inclusionReason: "commit_correlation",
							checklist: [
								{
									id: itemId,
									label: "自动脚本验证",
									checked: false,
									source: "authored",
									kind: "automated_script",
									guidance: null,
									script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 10000 },
									run: null,
									cleanup: { mode: "manual", assetsDir, manualSteps: [] },
								},
							],
							verifiedAt: null,
							boardMovedToDoneAt: null,
							pendingConfirmation: null,
							droppedReason: null,
						},
					],
				},
			],
		};
		const statePath = getPostDeployVerificationStatePath();
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

		return { deploymentId, taskId, itemId };
	}

	it("exit 0 → passed 且自动勾选 checked=true", async () => {
		const { deploymentId, taskId, itemId } = await seedAutomatedItem("exit 0\n");

		const response = await deploymentApi.runPostDeployVerificationItem(
			{ workspaceId: "ws-1", workspacePath: "/tmp/ws-1" },
			{ deploymentId, taskId, itemId },
		);

		expect(response.ok).toBe(true);
		const item = response.task?.checklist.find((entry) => entry.id === itemId);
		expect(item?.run?.status).toBe("passed");
		expect(item?.checked).toBe(true);
	});

	it("exit 1 → failed 且取消勾选 checked=false", async () => {
		const { deploymentId, taskId, itemId } = await seedAutomatedItem("exit 1\n");

		const response = await deploymentApi.runPostDeployVerificationItem(
			{ workspaceId: "ws-1", workspacePath: "/tmp/ws-1" },
			{ deploymentId, taskId, itemId },
		);

		expect(response.ok).toBe(true);
		const item = response.task?.checklist.find((entry) => entry.id === itemId);
		expect(item?.run?.status).toBe("failed");
		expect(item?.checked).toBe(false);
	});

	// workspace 归属校验回归（RVF CI5）：跨 workspace 的 deploymentId 必须在置 running 前被拒绝，脚本绝不 spawn。
	it("跨 workspace 的 deploymentId → ok=false 拒绝且不执行脚本", async () => {
		const markerPath = join(sandbox.path, "cross-workspace-run-marker");
		const { deploymentId, taskId, itemId } = await seedAutomatedItem(`touch "${markerPath}"\nexit 0\n`);

		const response = await deploymentApi.runPostDeployVerificationItem(
			{ workspaceId: "ws-other", workspacePath: "/tmp/ws-other" },
			{ deploymentId, taskId, itemId },
		);

		expect(response.ok).toBe(false);
		expect(response.task).toBeNull();
		expect(response.error).toContain("部署组未找到");
		// 脚本从未执行：marker 文件不存在。
		expect(existsSync(markerPath)).toBe(false);
	});
});
