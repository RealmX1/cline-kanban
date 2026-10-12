import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationState,
} from "../../../src/core/api-contract";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import { summarizeWorkspacesHavingPostDeployVerificationDeploymentGroupsFromStateSnapshot } from "../../../src/deployment/post-deploy-verification-workspaces-having-deployment-groups-summarization";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";
import { createTempDir } from "../../utilities/temp-dir";

// All projects 视图的 PDV 面板不跟随当前项目：先经这个无 scope 的只读 query 知道哪些 workspace 有部署组，再挑一个绑定。

function buildDeploymentGroup(input: {
	workspaceId: string;
	deployedAtIso: string;
	foldedAtIso: string | null;
}): RuntimePostDeployVerificationDeploymentGroup {
	return {
		deploymentId: randomUUID(),
		workspaceId: input.workspaceId,
		deployedSourceCommit: "a".repeat(40),
		previousDeployedSourceCommit: null,
		deployedAtIso: input.deployedAtIso,
		foldedAtIso: input.foldedAtIso,
		tasks: [],
	};
}

describe("summarizeWorkspacesHavingPostDeployVerificationDeploymentGroupsFromStateSnapshot", () => {
	it("按 workspace 分组、取最新一次部署时间，并按它新→旧排序（已折叠进历史的组也算）", () => {
		const summaries = summarizeWorkspacesHavingPostDeployVerificationDeploymentGroupsFromStateSnapshot({
			deploymentGroups: [
				buildDeploymentGroup({
					workspaceId: "cline-kanban",
					deployedAtIso: "2026-10-01T00:00:00.000Z",
					foldedAtIso: "2026-10-03T00:00:00.000Z",
				}),
				buildDeploymentGroup({
					workspaceId: "other-project",
					deployedAtIso: "2026-10-02T00:00:00.000Z",
					foldedAtIso: null,
				}),
				buildDeploymentGroup({
					workspaceId: "cline-kanban",
					deployedAtIso: "2026-10-03T00:00:00.000Z",
					foldedAtIso: null,
				}),
				buildDeploymentGroup({
					workspaceId: "only-history-project",
					deployedAtIso: "2026-09-01T00:00:00.000Z",
					foldedAtIso: "2026-09-02T00:00:00.000Z",
				}),
			],
		});
		expect(summaries).toEqual([
			{ workspaceId: "cline-kanban", latestDeploymentGroupDeployedAtIso: "2026-10-03T00:00:00.000Z" },
			{ workspaceId: "other-project", latestDeploymentGroupDeployedAtIso: "2026-10-02T00:00:00.000Z" },
			{ workspaceId: "only-history-project", latestDeploymentGroupDeployedAtIso: "2026-09-01T00:00:00.000Z" },
		]);
	});

	it("没有部署组时返回空数组", () => {
		expect(
			summarizeWorkspacesHavingPostDeployVerificationDeploymentGroupsFromStateSnapshot({ deploymentGroups: [] }),
		).toEqual([]);
	});
});

describe.sequential("deploymentApi.listWorkspacesHavingPostDeployVerificationDeploymentGroups", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-post-deploy-verification-workspaces-having-deployment-groups-");
		previousHome = process.env.HOME;
		process.env.HOME = sandbox.path;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		sandbox.cleanup();
	});

	function createDeploymentApiWithoutBoardAccess() {
		return createDeploymentApi({
			loadBoardTasksForWorkspace: async () => {
				throw new Error("列表 query 不应读任何 workspace 的看板");
			},
			loadTaskAgentResponsePreview: async () => null,
		});
	}

	function writeStateFileContent(content: string): void {
		mkdirSync(dirname(getPostDeployVerificationStatePath()), { recursive: true });
		writeFileSync(getPostDeployVerificationStatePath(), content, "utf8");
	}

	it("从全局 state 文件列出两个 workspace，且调用后文件内容不变（纯读、不 reconcile）", async () => {
		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				buildDeploymentGroup({
					workspaceId: "cline-kanban",
					deployedAtIso: "2026-10-03T00:00:00.000Z",
					foldedAtIso: null,
				}),
				buildDeploymentGroup({
					workspaceId: "other-project",
					deployedAtIso: "2026-10-04T00:00:00.000Z",
					foldedAtIso: null,
				}),
			],
		};
		const stateFileContentBeforeQuery = JSON.stringify(state, null, 2);
		writeStateFileContent(stateFileContentBeforeQuery);

		const response =
			await createDeploymentApiWithoutBoardAccess().listWorkspacesHavingPostDeployVerificationDeploymentGroups();

		expect(response).toEqual({
			workspacesHavingPostDeployVerificationDeploymentGroups: [
				{ workspaceId: "other-project", latestDeploymentGroupDeployedAtIso: "2026-10-04T00:00:00.000Z" },
				{ workspaceId: "cline-kanban", latestDeploymentGroupDeployedAtIso: "2026-10-03T00:00:00.000Z" },
			],
		});
		expect(readFileSync(getPostDeployVerificationStatePath(), "utf8")).toBe(stateFileContentBeforeQuery);
	});

	it("state 文件不存在时返回空列表", async () => {
		const response =
			await createDeploymentApiWithoutBoardAccess().listWorkspacesHavingPostDeployVerificationDeploymentGroups();
		expect(response).toEqual({ workspacesHavingPostDeployVerificationDeploymentGroups: [] });
	});

	it("state 文件损坏时降级为空列表，且不改动损坏文件（隔离由写路径负责）", async () => {
		writeStateFileContent("{ not json");
		const response =
			await createDeploymentApiWithoutBoardAccess().listWorkspacesHavingPostDeployVerificationDeploymentGroups();
		expect(response).toEqual({ workspacesHavingPostDeployVerificationDeploymentGroups: [] });
		expect(readFileSync(getPostDeployVerificationStatePath(), "utf8")).toBe("{ not json");
	});
});
