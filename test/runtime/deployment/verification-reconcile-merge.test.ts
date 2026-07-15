import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	RuntimeAuthoredVerificationDefinition,
	RuntimePostDeployVerificationState,
} from "../../../src/core/api-contract";
import {
	getAuthoredVerificationDefinitionsPath,
	upsertAuthoredVerificationDefinition,
} from "../../../src/deployment/authored-verification-definitions";
import {
	getPostDeployVerificationStatePath,
	reconcileGroup,
} from "../../../src/deployment/post-deploy-verification-state";
import { createTempDir } from "../../utilities/temp-dir";

// reconcileGroup 给「新进 validation 列的任务」动态加入组时，应把该任务已注册的 authored 定义 materialize 并合入其 checklist。
describe.sequential("reconcileGroup authored 合并", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-reconcile-merge-");
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

	const NOW_ISO = "2026-06-01T00:00:00.000Z";

	function buildDefinition(verificationId: string, taskId: string): RuntimeAuthoredVerificationDefinition {
		return {
			verificationId,
			workspaceId: "ws-1",
			taskId,
			kind: "guided_manual",
			label: "新进 validation 任务的 authored 验证",
			guidance: null,
			script: null,
			cleanup: { mode: "manual", assetsDir: null, manualSteps: [] },
			createdAtIso: NOW_ISO,
		};
	}

	it("新进 validation 任务的 checklist 含其 authored 项", async () => {
		const deploymentId = randomUUID();
		const verificationId = randomUUID();
		const newValidationTaskId = "task-new-validation";

		await upsertAuthoredVerificationDefinition(buildDefinition(verificationId, newValidationTaskId), NOW_ISO);

		// seed 一个不含该任务的组。
		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				{
					deploymentId,
					workspaceId: "ws-1",
					deployedSourceCommit: "a".repeat(40),
					previousDeployedSourceCommit: null,
					deployedAtIso: NOW_ISO,
					foldedAtIso: null,
					tasks: [],
				},
			],
		};
		const statePath = getPostDeployVerificationStatePath();
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

		const group = await reconcileGroup({
			deploymentId,
			workspaceId: "ws-1",
			currentBoardTasks: [{ taskId: newValidationTaskId, columnId: "validation" }],
			nowIso: NOW_ISO,
		});

		const newTask = group?.tasks.find((task) => task.taskId === newValidationTaskId);
		expect(newTask).toBeDefined();
		const authoredItem = newTask?.checklist.find((item) => item.id === `authored:${verificationId}`);
		expect(authoredItem).toBeDefined();
		expect(authoredItem?.source).toBe("authored");
		expect(authoredItem?.label).toBe("新进 validation 任务的 authored 验证");
	});

	it("组内已有的 validation 任务不触发 authored 存储访问（CI1(c) 回归：30s 轮询不产生 N+1 读）", async () => {
		const deploymentId = randomUUID();
		const alreadyInGroupTaskId = "task-already-in-group";

		// seed 一个「已含该 validation 任务」的组。
		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				{
					deploymentId,
					workspaceId: "ws-1",
					deployedSourceCommit: "a".repeat(40),
					previousDeployedSourceCommit: null,
					deployedAtIso: NOW_ISO,
					foldedAtIso: null,
					tasks: [
						{
							taskId: alreadyInGroupTaskId,
							columnIdAtMatch: "validation",
							matchedCommits: [],
							inclusionReason: "validation_column",
							checklist: [
								{
									id: "manual-smoke-test-on-deployed-build",
									label: "在已部署 build 上手工验证",
									checked: false,
									source: "commit",
									kind: "guided_manual",
									guidance: null,
									script: null,
									run: null,
									cleanup: null,
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

		// 观察代理：故意写一份损坏的 authored 定义文件。若 reconcile 为组内已有任务读了 authored 存储，
		// 损坏文件会被隔离改名（内容消失）；不读则原样保留。
		const authoredPath = getAuthoredVerificationDefinitionsPath();
		const corruptContent = "{ this is not valid json";
		writeFileSync(authoredPath, corruptContent, "utf8");

		const group = await reconcileGroup({
			deploymentId,
			workspaceId: "ws-1",
			currentBoardTasks: [{ taskId: alreadyInGroupTaskId, columnId: "validation" }],
			nowIso: NOW_ISO,
		});
		expect(group?.tasks).toHaveLength(1);

		// 组内已有任务不应触发 authored 存储的任何读写：损坏文件原样在场、未被隔离/重写。
		expect(readFileSync(authoredPath, "utf8")).toBe(corruptContent);
	});
});
