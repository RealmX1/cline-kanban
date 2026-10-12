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
import { buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults } from "../../../src/deployment/post-deploy-verification-deployment-group-task-assembly";
import {
	getPostDeployVerificationStatePath,
	reconcileGroup,
} from "../../../src/deployment/post-deploy-verification-state";
import { ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
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

	// 2026-10-11 起行为变更：晚于建组注册的 authored 定义也要合并进组内已有任务（以前只在任务加入组那一刻 materialize，
	// 之后注册的定义永远进不了组）。N+1 约束保持：每轮对账只按 workspace 读一次定义文件（materializeAuthoredVerificationItemsForWorkspaceTasks），
	// 不随组内任务数线性重读。有 authored 项后，未勾的通用兜底项「在已部署 build 上手工验证」去掉。
	it("组内已有任务合并晚注册的 authored 定义，并去掉未勾的通用兜底项", async () => {
		const deploymentId = randomUUID();
		const verificationId = randomUUID();
		const alreadyInGroupTaskId = "task-already-in-group";

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
							...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
						},
					],
				},
			],
		};
		const statePath = getPostDeployVerificationStatePath();
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
		await upsertAuthoredVerificationDefinition(buildDefinition(verificationId, alreadyInGroupTaskId), NOW_ISO);

		const group = await reconcileGroup({
			deploymentId,
			workspaceId: "ws-1",
			currentBoardTasks: [{ taskId: alreadyInGroupTaskId, columnId: "validation" }],
			nowIso: NOW_ISO,
		});

		const task = group?.tasks.find((candidate) => candidate.taskId === alreadyInGroupTaskId);
		expect(task?.checklist.map((item) => item.id)).toEqual([`authored:${verificationId}`]);
		expect(JSON.parse(readFileSync(getAuthoredVerificationDefinitionsPath(), "utf8")).definitions).toHaveLength(1);
	});

	// RVF-003：authoring skill 的 reconcile 模式按同一 verificationId 重注册，把已人工勾选的 guided 项改成 automated_script。
	// 合并后不能是「从未运行却已勾选」的自动项（否则 every(checked) 会放行按 PDV 通过结案）。
	it("同 id 重注册把已勾的 guided 项改成 automated_script：对账后清回未运行、未勾选", async () => {
		const deploymentId = randomUUID();
		const verificationId = randomUUID();
		const taskId = "task-redefined-as-automated";

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
							taskId,
							columnIdAtMatch: "validation",
							matchedCommits: [],
							inclusionReason: "validation_column",
							checklist: [
								{
									id: `authored:${verificationId}`,
									label: "新进 validation 任务的 authored 验证",
									checked: true,
									source: "authored",
									kind: "guided_manual",
									guidance: null,
									script: null,
									run: null,
									cleanup: { mode: "manual", assetsDir: null, manualSteps: [] },
								},
							],
							verifiedAt: null,
							boardMovedToDoneAt: null,
							pendingConfirmation: null,
							droppedReason: null,
							...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
						},
					],
				},
			],
		};
		const statePath = getPostDeployVerificationStatePath();
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
		// automated_script 项 materialize 前要求资产目录在场。
		await ensureVerificationAssetsDir(verificationId);
		await upsertAuthoredVerificationDefinition(
			{
				...buildDefinition(verificationId, taskId),
				kind: "automated_script",
				script: { entrypoint: "verify.sh", interpreter: "bash", timeoutMs: 60000 },
			},
			NOW_ISO,
		);

		const group = await reconcileGroup({
			deploymentId,
			workspaceId: "ws-1",
			currentBoardTasks: [{ taskId, columnId: "validation" }],
			nowIso: NOW_ISO,
		});

		const task = group?.tasks.find((candidate) => candidate.taskId === taskId);
		expect(task?.checklist).toHaveLength(1);
		expect(task?.checklist[0]).toMatchObject({
			id: `authored:${verificationId}`,
			kind: "automated_script",
			checked: false,
			run: null,
		});
	});
});
