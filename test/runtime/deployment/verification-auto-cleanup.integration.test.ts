import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	RuntimeAuthoredVerificationDefinition,
	RuntimePostDeployVerificationState,
} from "../../../src/core/api-contract";
import {
	listAuthoredVerificationDefinitions,
	upsertAuthoredVerificationDefinition,
} from "../../../src/deployment/authored-verification-definitions";
import {
	getPostDeployVerificationStatePath,
	markTaskVerified,
} from "../../../src/deployment/post-deploy-verification-state";
import { ensureVerificationAssetsDir, getVerificationAssetsRoot } from "../../../src/deployment/verification-assets";
import { createTempDir } from "../../utilities/temp-dir";

// 核对完成 → 对 cleanup.mode==="automatic" 的 authored 项自动清理（删资产 + 注销定义）；manual 项保留。
describe.sequential("verification 自动清理触发（markTaskVerified）", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-auto-cleanup-integ-");
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

	function buildDefinition(
		fields: Partial<RuntimeAuthoredVerificationDefinition> & { verificationId: string; taskId: string },
	): RuntimeAuthoredVerificationDefinition {
		return {
			verificationId: fields.verificationId,
			workspaceId: fields.workspaceId ?? "ws-1",
			taskId: fields.taskId,
			kind: fields.kind ?? "guided_manual",
			label: fields.label ?? "验证",
			guidance: fields.guidance ?? null,
			script: fields.script ?? null,
			cleanup: fields.cleanup ?? { mode: "manual", assetsDir: null, manualSteps: [] },
			createdAtIso: NOW_ISO,
		};
	}

	it("automatic 项资产被删 + 定义被注销；manual 项资产与定义均保留", async () => {
		const deploymentId = randomUUID();
		const autoId = randomUUID();
		const manualId = randomUUID();
		const taskId = "task-cleanup";

		// 注册两条定义并各建资产目录。
		const autoDir = await ensureVerificationAssetsDir(autoId);
		const manualDir = await ensureVerificationAssetsDir(manualId);
		writeFileSync(join(autoDir, "run.sh"), "exit 0\n", "utf8");
		writeFileSync(join(manualDir, "run.sh"), "exit 0\n", "utf8");
		await upsertAuthoredVerificationDefinition(
			buildDefinition({
				verificationId: autoId,
				taskId,
				cleanup: { mode: "automatic", assetsDir: autoDir, manualSteps: [] },
			}),
			NOW_ISO,
		);
		await upsertAuthoredVerificationDefinition(
			buildDefinition({
				verificationId: manualId,
				taskId,
				cleanup: { mode: "manual", assetsDir: manualDir, manualSteps: ["grep -rn TAG src | xargs ..."] },
			}),
			NOW_ISO,
		);

		// seed 一个组，task 的 checklist 含这两个 authored 项（全勾，可完成核对）。
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
							columnIdAtMatch: "review",
							matchedCommits: [],
							inclusionReason: "commit_correlation",
							checklist: [
								{
									id: `authored:${autoId}`,
									label: "自动清理项",
									checked: true,
									source: "authored",
									kind: "guided_manual",
									guidance: null,
									script: null,
									run: null,
									cleanup: { mode: "automatic", assetsDir: autoDir, manualSteps: [] },
								},
								{
									id: `authored:${manualId}`,
									label: "手动清理项",
									checked: true,
									source: "authored",
									kind: "guided_manual",
									guidance: null,
									script: null,
									run: null,
									cleanup: { mode: "manual", assetsDir: manualDir, manualSteps: ["grep ..."] },
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

		const result = await markTaskVerified(deploymentId, taskId, NOW_ISO);
		expect(result.ok).toBe(true);

		// automatic：资产删除 + 定义注销。
		expect(existsSync(autoDir)).toBe(false);
		const autoDefs = await listAuthoredVerificationDefinitions({ taskId }, NOW_ISO);
		expect(autoDefs.some((entry) => entry.verificationId === autoId)).toBe(false);

		// manual：资产保留 + 定义保留。
		expect(existsSync(manualDir)).toBe(true);
		expect(autoDefs.some((entry) => entry.verificationId === manualId)).toBe(true);
	});

	it("越界护栏拒删（symlink 逃逸）时不注销定义（CI1(d) 回归）", async () => {
		const deploymentId = randomUUID();
		const escapeId = randomUUID();
		const taskId = "task-out-of-bounds";

		// 资产目录是指向 verifications 根之外的 symlink：cleanup 的 realpath 护栏应拒删。
		const outsideDir = join(sandbox.path, "outside-assets");
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "keep-me.txt"), "留存证明\n", "utf8");
		const assetsRoot = getVerificationAssetsRoot();
		mkdirSync(assetsRoot, { recursive: true });
		symlinkSync(outsideDir, join(assetsRoot, escapeId), "dir");

		await upsertAuthoredVerificationDefinition(
			buildDefinition({
				verificationId: escapeId,
				taskId,
				cleanup: { mode: "automatic", assetsDir: join(assetsRoot, escapeId), manualSteps: [] },
			}),
			NOW_ISO,
		);

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
							columnIdAtMatch: "review",
							matchedCommits: [],
							inclusionReason: "commit_correlation",
							checklist: [
								{
									id: `authored:${escapeId}`,
									label: "越界自动清理项",
									checked: true,
									source: "authored",
									kind: "guided_manual",
									guidance: null,
									script: null,
									run: null,
									cleanup: { mode: "automatic", assetsDir: join(assetsRoot, escapeId), manualSteps: [] },
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

		// 核对完成本身成功（清理失败/拒删绝不回滚核对）。
		const result = await markTaskVerified(deploymentId, taskId, NOW_ISO);
		expect(result.ok).toBe(true);

		// 护栏拒删：越界目标目录原样保留。
		expect(existsSync(join(outsideDir, "keep-me.txt"))).toBe(true);
		// 关键：资产仍在场时 pending 定义不得被注销，避免「资产残留却已注销、前端假报已自动清理」。
		const defs = await listAuthoredVerificationDefinitions({ taskId }, NOW_ISO);
		expect(defs.some((entry) => entry.verificationId === escapeId)).toBe(true);
	});
});
