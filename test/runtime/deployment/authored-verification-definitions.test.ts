import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeAuthoredVerificationDefinition } from "../../../src/core/api-contract";
import {
	getAuthoredVerificationDefinitionsPath,
	listAuthoredVerificationDefinitions,
	materializeAuthoredVerificationItemsForTask,
	removeAuthoredVerificationDefinition,
	upsertAuthoredVerificationDefinition,
} from "../../../src/deployment/authored-verification-definitions";
import { cleanupVerificationAssets, ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import { createTempDir } from "../../utilities/temp-dir";

// 与 post-deploy-verification-state 同手法：临时 HOME 把 pending 存储重定向到隔离沙箱。
describe.sequential("authored-verification-definitions", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-authored-verification-");
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
		overrides: Partial<RuntimeAuthoredVerificationDefinition> & { verificationId: string; taskId: string },
	): RuntimeAuthoredVerificationDefinition {
		return {
			verificationId: overrides.verificationId,
			workspaceId: overrides.workspaceId ?? "ws-1",
			taskId: overrides.taskId,
			kind: overrides.kind ?? "guided_manual",
			label: overrides.label ?? "验证断言",
			guidance: overrides.guidance ?? null,
			script: overrides.script ?? null,
			cleanup: overrides.cleanup ?? { mode: "manual", assetsDir: null, manualSteps: [] },
			createdAtIso: overrides.createdAtIso ?? NOW_ISO,
		};
	}

	it("upsert 后 materialize 得到 authored 型 checklist item（id/source/字段正确）", async () => {
		const verificationId = randomUUID();
		// 自动脚本项需资产目录在场（真实流程由 register 的 ensureVerificationAssetsDir 保证）。
		await ensureVerificationAssetsDir(verificationId);
		await upsertAuthoredVerificationDefinition(
			buildDefinition({
				verificationId,
				taskId: "task-a",
				kind: "automated_script",
				label: "服务端 /health 返回 200",
				script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 30000 },
				cleanup: { mode: "automatic", assetsDir: "/tmp/x", manualSteps: [] },
			}),
			NOW_ISO,
		);

		const items = await materializeAuthoredVerificationItemsForTask("ws-1", "task-a", NOW_ISO);
		expect(items).toHaveLength(1);
		const item = items[0];
		expect(item?.id).toBe(`authored:${verificationId}`);
		expect(item?.source).toBe("authored");
		expect(item?.kind).toBe("automated_script");
		expect(item?.label).toBe("服务端 /health 返回 200");
		expect(item?.script?.entrypoint).toBe("run.sh");
		expect(item?.run).toBeNull(); // 未运行
		expect(item?.checked).toBe(false);
		expect(item?.cleanup?.mode).toBe("automatic");
	});

	it("同 verificationId upsert 幂等替换（多轮重注册不重复）", async () => {
		const verificationId = randomUUID();
		await upsertAuthoredVerificationDefinition(
			buildDefinition({ verificationId, taskId: "task-b", label: "旧标签" }),
			NOW_ISO,
		);
		await upsertAuthoredVerificationDefinition(
			buildDefinition({ verificationId, taskId: "task-b", label: "新标签" }),
			NOW_ISO,
		);

		const items = await materializeAuthoredVerificationItemsForTask("ws-1", "task-b", NOW_ISO);
		expect(items).toHaveLength(1);
		expect(items[0]?.label).toBe("新标签");
	});

	it("materialize 按 workspaceId + taskId 过滤", async () => {
		const vidTaskCWs1 = randomUUID();
		await upsertAuthoredVerificationDefinition(
			buildDefinition({ verificationId: vidTaskCWs1, taskId: "task-c", workspaceId: "ws-1" }),
			NOW_ISO,
		);
		await upsertAuthoredVerificationDefinition(
			buildDefinition({ verificationId: randomUUID(), taskId: "task-c", workspaceId: "ws-2" }),
			NOW_ISO,
		);
		await upsertAuthoredVerificationDefinition(
			buildDefinition({ verificationId: randomUUID(), taskId: "task-d", workspaceId: "ws-1" }),
			NOW_ISO,
		);

		const forTaskC = await materializeAuthoredVerificationItemsForTask("ws-1", "task-c", NOW_ISO);
		expect(forTaskC).toHaveLength(1);
		expect(forTaskC[0]?.id).toBe(`authored:${vidTaskCWs1}`);

		const noneForWrongWorkspace = await materializeAuthoredVerificationItemsForTask("ws-3", "task-c", NOW_ISO);
		expect(noneForWrongWorkspace).toHaveLength(0);
	});

	it("list 按 taskId 过滤；remove 后消失", async () => {
		const verificationId = randomUUID();
		await upsertAuthoredVerificationDefinition(buildDefinition({ verificationId, taskId: "task-e" }), NOW_ISO);

		const listedBefore = await listAuthoredVerificationDefinitions({ taskId: "task-e" }, NOW_ISO);
		expect(listedBefore).toHaveLength(1);

		const removed = await removeAuthoredVerificationDefinition(verificationId, NOW_ISO);
		expect(removed).toBe(true);

		const listedAfter = await listAuthoredVerificationDefinitions({ taskId: "task-e" }, NOW_ISO);
		expect(listedAfter).toHaveLength(0);

		// remove 不存在的 id 返回 false。
		expect(await removeAuthoredVerificationDefinition(randomUUID(), NOW_ISO)).toBe(false);
	});

	it("空存储 materialize 返回空数组，不创建文件误报", async () => {
		expect(existsSync(getAuthoredVerificationDefinitionsPath())).toBe(false);
		const items = await materializeAuthoredVerificationItemsForTask("ws-1", "task-none", NOW_ISO);
		expect(items).toHaveLength(0);
		// list 是纯只读路径（CI1(c) 回归）：不得因一次 list/materialize 就加锁重写出 {definitions: []} 文件。
		expect(existsSync(getAuthoredVerificationDefinitionsPath())).toBe(false);
	});

	it("assetsDir 已不存在的自动脚本定义在 materialize 时被 skip（record/cleanup 竞态缓解，issue CI4b）；guided_manual 不受影响", async () => {
		const automatedVerificationId = randomUUID();
		const guidedVerificationId = randomUUID();
		await ensureVerificationAssetsDir(automatedVerificationId);
		await upsertAuthoredVerificationDefinition(
			buildDefinition({
				verificationId: automatedVerificationId,
				taskId: "task-race",
				kind: "automated_script",
				script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 30000 },
				cleanup: { mode: "automatic", assetsDir: null, manualSteps: [] },
			}),
			NOW_ISO,
		);
		await upsertAuthoredVerificationDefinition(
			buildDefinition({ verificationId: guidedVerificationId, taskId: "task-race" }),
			NOW_ISO,
		);

		// 资产在场时两项都 materialize。
		const itemsBeforeCleanup = await materializeAuthoredVerificationItemsForTask("ws-1", "task-race", NOW_ISO);
		expect(itemsBeforeCleanup).toHaveLength(2);

		// 模拟并发 automatic 清理已删掉资产目录（但定义读取先于删除发生）：自动项被 skip，guided_manual 保留。
		const cleanupResult = await cleanupVerificationAssets(automatedVerificationId);
		expect(cleanupResult.removed).toBe(true);
		const itemsAfterCleanup = await materializeAuthoredVerificationItemsForTask("ws-1", "task-race", NOW_ISO);
		expect(itemsAfterCleanup).toHaveLength(1);
		expect(itemsAfterCleanup[0]?.id).toBe(`authored:${guidedVerificationId}`);
		expect(itemsAfterCleanup[0]?.kind).toBe("guided_manual");
	});
});
