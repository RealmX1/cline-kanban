import { chmod, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	cleanupLocalRedeploymentFailedAttemptArtifacts,
	registerLocalRedeploymentRebuildableArtifact,
	setLocalRedeploymentAutomaticFailedAttemptCleanup,
} from "../../../src/deployment/local-redeployment-failed-attempt-artifact-cleanup";
import {
	localRedeploymentRequestSchema,
	localRedeploymentSha256,
} from "../../../src/deployment/local-redeployment-preparation";
import { createTempDir } from "../../utilities/temp-dir";

async function cleanupFixture() {
	const temporary = createTempDir("local-redeployment-failed-attempt-cleanup-");
	const directory = await realpath(temporary.path);
	onTestFinished(temporary.cleanup);
	const executor = "// 隔离清理归属\n";
	const request = localRedeploymentRequestSchema.parse({
		executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
		runtimeIdentity: {
			runtimeHomeDirectoryPath: join(directory, "runtime-home"),
			runtimeHost: "127.0.0.1",
			runtimePort: 39884,
		},
		distributionDirectoryPath: join(directory, "distribution"),
		deploymentNodeBinaryPath: process.execPath,
		schemaVersion: 1,
		workspaceId: "isolated-cleanup",
		taskId: "isolated-cleanup",
		originatingTaskWorktreePath: directory,
		sourceCheckoutPath: directory,
		candidateSourceCommit: "a".repeat(40),
		serviceLaunch: { command: [process.execPath] },
		authorization: { sourceReference: "test:cleanup", userRequestQuote: "仅隔离验证" },
	});
	await writeFile(join(directory, "frozen-local-redeployment-executor.mjs"), executor);
	await writeFile(
		join(directory, "frozen-redeployment-request.json"),
		JSON.stringify({
			request,
			requestSha256: localRedeploymentSha256(JSON.stringify(request)),
			executorSha256: localRedeploymentSha256(executor),
			npmCliEntrypointPath: process.execPath,
			serviceExecutableSha256: "b".repeat(64),
			owner: null,
		}),
	);
	await mkdir(request.distributionDirectoryPath);
	const captureRoot = join(directory, "runtime-state-backup-capture-attempts");
	await registerLocalRedeploymentRebuildableArtifact(directory, {
		kind: "runtime_state_backup_capture_collection",
		stage: "state_preservation",
		attemptNumber: 1,
		path: captureRoot,
	});
	const failed = join(captureRoot, "failed-copy");
	await mkdir(failed);
	await writeFile(join(failed, "copied-content"), "可重建副本");
	const evidencePath = join(directory, "immutable-command-exit-evidence.json");
	await writeFile(evidencePath, "隔离退出原件");
	const deps = { readProcessExitEvidence: async () => ({ status: "exited" as const, reference: evidencePath }) };
	return { directory, captureRoot, failed, deps };
}

describe("失败部署尝试的安全自动清理", () => {
	it("清理记录归属错误时拒绝删除并保留现场", async () => {
		const fixture = await cleanupFixture();
		const path = join(fixture.directory, "failed-attempt-artifact-cleanup.json");
		const record = JSON.parse(await readFile(path, "utf8"));
		record.executionId = "042609d8-7508-4bdc-b202-1d7bd7da8a14";
		await writeFile(path, JSON.stringify(record));
		await expect(cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, fixture.deps)).rejects.toThrow(
			"归属不一致",
		);
		expect(await readFile(join(fixture.failed, "copied-content"), "utf8")).toBe("可重建副本");
	});

	it("必要证据尚未可靠落盘时不删除；恢复引用继续保护已核验副本", async () => {
		const fixture = await cleanupFixture();
		const deleteArtifact = vi.fn(async () => undefined);
		await writeFile(join(fixture.directory, "failed-attempt-cleanup-evidence"), "阻止证据落盘的隔离文件");
		expect(
			(await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, { ...fixture.deps, deleteArtifact }))
				.status,
		).toBe("pending");
		expect(deleteArtifact).not.toHaveBeenCalled();
		await rm(join(fixture.directory, "failed-attempt-cleanup-evidence"));
		await mkdir(join(fixture.directory, "runtime-backup-checkpoints"));
		await writeFile(
			join(fixture.directory, "runtime-backup-checkpoints/retained.json"),
			JSON.stringify({ destination: fixture.failed }),
		);
		expect(
			(await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, { ...fixture.deps, deleteArtifact }))
				.status,
		).toBe("completed");
		expect(deleteArtifact).not.toHaveBeenCalled();
		expect(await readFile(join(fixture.failed, "copied-content"), "utf8")).toBe("可重建副本");
	});

	it("删除已发生而结果写入中断时，根据同一路径实体的消失幂等补齐记录", async () => {
		const fixture = await cleanupFixture();
		const deleteArtifact = vi.fn(async (path: string) => {
			await rm(path, { recursive: true });
			throw new Error("模拟删除之后中断");
		});
		expect(
			(await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, { ...fixture.deps, deleteArtifact }))
				.status,
		).toBe("pending");
		const recovered = await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, {
			...fixture.deps,
			deleteArtifact,
		});
		expect(recovered.status).toBe("completed");
		expect(Object.values(recovered.artifacts[0].deletions)[0].status).toBe("deleted");
		expect(deleteArtifact).toHaveBeenCalledTimes(1);
	});

	it("默认清理失败副本，保留日志、已核验检查点、必要备份及候选", async () => {
		const fixture = await cleanupFixture();
		const checkpoint = join(fixture.captureRoot, "verified-copy");
		await mkdir(checkpoint);
		await writeFile(join(checkpoint, "verified-entry-backup.json"), "{}");
		for (const path of ["stdout.txt", "stderr.txt"]) await writeFile(join(fixture.directory, path), "必须保留");
		await writeFile(join(fixture.directory, "candidate-build-receipt.json"), "{}");
		await mkdir(join(fixture.directory, "preserved-runtime-state"));
		await mkdir(join(fixture.directory, "candidate-source-checkout"));
		const result = await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, fixture.deps);
		expect(result.status).toBe("completed");
		await expect(readFile(join(fixture.failed, "copied-content"))).rejects.toThrow();
		expect(await readFile(join(checkpoint, "verified-entry-backup.json"), "utf8")).toBe("{}");
		expect(await readFile(join(fixture.directory, "stdout.txt"), "utf8")).toBe("必须保留");
		expect((await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, fixture.deps)).status).toBe(
			"completed",
		);
	});

	it("关闭清理须记录原因，设置跨重启保留，重新开启后幂等回收", async () => {
		const fixture = await cleanupFixture();
		await expect(setLocalRedeploymentAutomaticFailedAttemptCleanup(fixture.directory, false, "")).rejects.toThrow();
		await setLocalRedeploymentAutomaticFailedAttemptCleanup(fixture.directory, false, "检查复制不一致现场");
		expect((await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, fixture.deps)).status).toBe(
			"disabled",
		);
		expect(await readFile(join(fixture.failed, "copied-content"), "utf8")).toBe("可重建副本");
		await setLocalRedeploymentAutomaticFailedAttemptCleanup(fixture.directory, true);
		expect((await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, fixture.deps)).status).toBe(
			"completed",
		);
	});

	it.each(["running", "unknown"] as const)("进程状态为%s时保留产物", async (status) => {
		const fixture = await cleanupFixture();
		expect(
			(
				await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, {
					readProcessExitEvidence: async () => ({ status, reference: "isolated-process-observation" }),
				})
			).status,
		).toBe("pending");
		expect(await readFile(join(fixture.failed, "copied-content"), "utf8")).toBe("可重建副本");
	});

	it("目录被软链接替换时拒绝删除，也不跟随到原件或外部目录", async () => {
		const fixture = await cleanupFixture();
		await rename(fixture.captureRoot, `${fixture.captureRoot}-retained-original`);
		const unrelated = join(fixture.directory, "unrelated-assets");
		await mkdir(unrelated);
		await writeFile(join(unrelated, "sentinel"), "不可删除");
		await symlink(unrelated, fixture.captureRoot);
		expect((await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, fixture.deps)).status).toBe(
			"pending",
		);
		expect(await readFile(join(unrelated, "sentinel"), "utf8")).toBe("不可删除");
	});

	it("删除失败保留独立pending，原始失败加两次重试后等待相关条件变化", async () => {
		const fixture = await cleanupFixture();
		const deleteArtifact = vi.fn(async () => {
			throw Object.assign(new Error("隔离删除失败"), { code: "EACCES" });
		});
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				(
					await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, {
						...fixture.deps,
						deleteArtifact,
					})
				).status,
			).toBe("pending");
		expect(deleteArtifact).toHaveBeenCalledTimes(3);
		expect(await readFile(join(fixture.failed, "copied-content"), "utf8")).toBe("可重建副本");
	});

	it("嵌套目录权限恢复后重新获得有界删除资格", async () => {
		const fixture = await cleanupFixture();
		const nested = join(fixture.failed, "nested-directory");
		await mkdir(nested);
		await writeFile(join(nested, "retained-content"), "可重建副本");
		let deletionAttempts = 0;
		const deleteArtifact = async (path: string) => {
			deletionAttempts += 1;
			await rm(path, { recursive: true });
		};
		await chmod(nested, 0o500);
		for (let attempt = 0; attempt < 3; attempt++)
			expect(
				(
					await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, {
						...fixture.deps,
						deleteArtifact,
					})
				).status,
			).toBe("pending");
		expect(deletionAttempts).toBe(3);
		await chmod(nested, 0o700);
		expect(
			(
				await cleanupLocalRedeploymentFailedAttemptArtifacts(fixture.directory, {
					...fixture.deps,
					deleteArtifact,
				})
			).status,
		).toBe("completed");
		expect(deletionAttempts).toBe(4);
		await expect(readFile(join(nested, "retained-content"))).rejects.toThrow();
	});
});
