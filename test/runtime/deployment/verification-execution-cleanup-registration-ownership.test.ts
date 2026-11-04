import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as taskCommand from "../../../src/commands/task";
import { registerVerificationCommand } from "../../../src/commands/verification";
import type { RuntimeAuthoredVerificationDefinition } from "../../../src/core/api-contract";
import * as definitions from "../../../src/deployment/authored-verification-definitions";
import * as closure from "../../../src/deployment/post-deploy-verification-closure-application";
import {
	getPostDeployVerificationStatePath,
	markTaskVerified,
	setVerificationRunState,
} from "../../../src/deployment/post-deploy-verification-state";
import { ensureVerificationAssetsDir, getVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import { createTempDir } from "../../utilities/temp-dir";
import { seedIsolatedVerificationExecutionTask } from "./verification-execution-isolated-runtime-fixture";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof filesystem>();
	return { ...actual, rm: vi.fn(actual.rm) };
});
const originalRemoveDirectory = vi.mocked(filesystem.rm).getMockImplementation();
if (!originalRemoveDirectory) throw new Error("缺少真实目录删除函数");
const NOW_ISO = "2026-10-31T22:00:00.000Z";
let sandbox: ReturnType<typeof createTempDir>;
beforeEach(() => {
	sandbox = createTempDir("pdv-cleanup-registration-ownership-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
	vi.mocked(filesystem.rm).mockImplementation(originalRemoveDirectory);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(filesystem.rm).mockImplementation(originalRemoveDirectory);
	vi.unstubAllEnvs();
	sandbox.cleanup();
});

async function seedRegisteredTask() {
	const fixture = await seedIsolatedVerificationExecutionTask({ scriptBody: "process.exit(0)" });
	const definition: RuntimeAuthoredVerificationDefinition = {
		verificationId: fixture.verificationId,
		workspaceId: fixture.workspaceId,
		taskId: fixture.taskId,
		kind: "automated_script",
		label: "旧注册",
		guidance: null,
		script: { entrypoint: "run.js", interpreter: "node", timeoutMs: 60_000 },
		cleanup: { mode: "automatic", assetsDir: getVerificationAssetsDir(fixture.verificationId), manualSteps: [] },
		createdAtIso: NOW_ISO,
	};
	await definitions.upsertAuthoredVerificationDefinition(definition, NOW_ISO);
	const item = (
		await definitions.materializeAuthoredVerificationItemsForTask(fixture.workspaceId, fixture.taskId, NOW_ISO)
	)[0];
	const task = fixture.state.deploymentGroups[0]?.tasks[0];
	if (!item || !task) throw new Error("缺少隔离核对条目");
	task.checklist = [{ ...item, checked: true }];
	await filesystem.writeFile(getPostDeployVerificationStatePath(), JSON.stringify(fixture.state));
	return { ...fixture, definition, task };
}

async function explicitlyReregister(fixture: Awaited<ReturnType<typeof seedRegisteredTask>>) {
	// 故意保留相同时间戳，注册归属不能依赖时钟粒度。
	await definitions.upsertAuthoredVerificationDefinition({ ...fixture.definition, label: "新注册" }, NOW_ISO);
	await filesystem.writeFile(
		join(await ensureVerificationAssetsDir(fixture.verificationId), "new-registration.txt"),
		"保留新资产",
	);
}

async function runCleanupCommand(verificationId: string) {
	const printed = vi.spyOn(taskCommand, "printJson").mockImplementation(() => undefined);
	const program = new Command();
	registerVerificationCommand(program);
	await program.parseAsync(["node", "kanban", "verification", "cleanup", "--verification-id", verificationId]);
	return printed.mock.calls.at(-1)?.[0];
}

it.each(["cli", "automatic-closure"] as const)(
	"%s 清理持锁期间重注册等待，旧清理不能再注销新定义",
	async (entrypoint) => {
		const fixture = await seedRegisteredTask();
		const physicalAssetsDirectory = await filesystem.realpath(getVerificationAssetsDir(fixture.verificationId));
		let registration: Promise<void> | undefined;
		vi.mocked(filesystem.rm).mockImplementation(async (...args) => {
			await originalRemoveDirectory(...args);
			if (String(args[0]) === physicalAssetsDirectory && !registration) {
				registration = explicitlyReregister(fixture);
			}
		});
		const originalRemoveDefinition = definitions.removeAuthoredVerificationDefinition;
		vi.spyOn(definitions, "removeAuthoredVerificationDefinition").mockImplementation(async (...args) => {
			await registration;
			return originalRemoveDefinition(...args);
		});
		if (entrypoint === "cli") await runCleanupCommand(fixture.verificationId);
		else expect((await markTaskVerified(fixture.deploymentId, fixture.taskId, NOW_ISO)).ok).toBe(true);
		expect(registration).toBeDefined();
		await registration;
		expect(
			(await definitions.listAuthoredVerificationDefinitions({ taskId: fixture.taskId }, NOW_ISO))[0]?.label,
		).toBe("新注册");
		expect(
			await filesystem.readFile(
				join(getVerificationAssetsDir(fixture.verificationId), "new-registration.txt"),
				"utf8",
			),
		).toBe("保留新资产");
	},
);

it("旧结案已保存但尚未清理时，新注册先完成，旧结案不能删除新定义或资产", async () => {
	const fixture = await seedRegisteredTask();
	const originalSideEffects = closure.runPostDeployVerificationClosureSideEffectsOutsideStateLock;
	vi.spyOn(closure, "runPostDeployVerificationClosureSideEffectsOutsideStateLock").mockImplementation(
		async (...args) => {
			await explicitlyReregister(fixture);
			return originalSideEffects(...args);
		},
	);
	expect((await markTaskVerified(fixture.deploymentId, fixture.taskId, NOW_ISO)).ok).toBe(true);
	expect((await definitions.listAuthoredVerificationDefinitions({ taskId: fixture.taskId }, NOW_ISO))[0]?.label).toBe(
		"新注册",
	);
	expect(
		await filesystem.readFile(join(getVerificationAssetsDir(fixture.verificationId), "new-registration.txt"), "utf8"),
	).toBe("保留新资产");
});

it("CLI 清理仍在核验退出时保留定义，返回未注销的回执", async () => {
	const fixture = await seedRegisteredTask();
	expect(
		(
			await setVerificationRunState(
				{
					...fixture.request,
					workspaceId: fixture.workspaceId,
					taskIncarnationCreatedAtEpochMs: 123,
					startedAtIso: NOW_ISO,
				},
				NOW_ISO,
			)
		).ok,
	).toBe(true);
	expect(await runCleanupCommand(fixture.verificationId)).toMatchObject({
		assetsRemoved: false,
		assetsSkippedReason: "awaiting-execution-exit-confirmation",
		definitionRemoved: false,
	});
	expect(await definitions.listAuthoredVerificationDefinitions({ taskId: fixture.taskId }, NOW_ISO)).toHaveLength(1);
});

it("旧核对条目缺少注册归属时不自动删除当前定义和资产", async () => {
	const fixture = await seedRegisteredTask();
	await filesystem.writeFile(
		getPostDeployVerificationStatePath(),
		JSON.stringify(fixture.state, (key, value) =>
			key === "authoredVerificationDefinitionRegistrationId" ? undefined : value,
		),
	);
	expect((await markTaskVerified(fixture.deploymentId, fixture.taskId, NOW_ISO)).ok).toBe(true);
	expect(await definitions.listAuthoredVerificationDefinitions({ taskId: fixture.taskId }, NOW_ISO)).toHaveLength(1);
	expect(
		await filesystem.readFile(join(getVerificationAssetsDir(fixture.verificationId), "run.js"), "utf8"),
	).toContain("process.exit");
});

it("每次显式重注册生成唯一归属，调用者不能沿用旧注册标识", async () => {
	const fixture = await seedRegisteredTask();
	const first = (await definitions.listAuthoredVerificationDefinitions({ taskId: fixture.taskId }, NOW_ISO))[0];
	if (!first) throw new Error("缺少原定义");
	await definitions.upsertAuthoredVerificationDefinition(first, NOW_ISO);
	const second = (await definitions.listAuthoredVerificationDefinitions({ taskId: fixture.taskId }, NOW_ISO))[0];
	expect(first.authoredVerificationDefinitionRegistrationId).toMatch(/^[a-f0-9-]{36}$/u);
	expect(second?.authoredVerificationDefinitionRegistrationId).not.toBe(
		first.authoredVerificationDefinitionRegistrationId,
	);
});

it("旧定义首次 materialize 建立持久归属，后续 materialize 沿用同一标识", async () => {
	const fixture = await seedRegisteredTask();
	const path = definitions.getAuthoredVerificationDefinitionsPath();
	await filesystem.writeFile(
		path,
		JSON.stringify(JSON.parse(await filesystem.readFile(path, "utf8")), (key, value) =>
			key === "authoredVerificationDefinitionRegistrationId" ? undefined : value,
		),
	);
	const first = await definitions.materializeAuthoredVerificationItemsForTask(
		fixture.workspaceId,
		fixture.taskId,
		NOW_ISO,
	);
	const second = await definitions.materializeAuthoredVerificationItemsForTask(
		fixture.workspaceId,
		fixture.taskId,
		NOW_ISO,
	);
	expect(first[0]?.authoredVerificationDefinitionRegistrationId).toMatch(/^[a-f0-9-]{36}$/u);
	expect(second[0]?.authoredVerificationDefinitionRegistrationId).toBe(
		first[0]?.authoredVerificationDefinitionRegistrationId,
	);
	expect(
		(await definitions.listAuthoredVerificationDefinitions({ taskId: fixture.taskId }, NOW_ISO))[0]
			?.authoredVerificationDefinitionRegistrationId,
	).toBe(first[0]?.authoredVerificationDefinitionRegistrationId);
});
