import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
describe("存储锁协议切换 CLI 的恢复回执", { timeout: 45_000 }, () => {
	it("缺少完整旧写入者清单时不放行，并持久保存可重验绑定", async (context) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const inventoryPath = join(fixture.isolatedHomeDirectoryPath, "retiring-writer-inventory.json");
		const evidencePath = join(fixture.isolatedHomeDirectoryPath, "protocol-transition-preflight-evidence.json");
		await writeFile(inventoryPath, JSON.stringify({ writerLaunchAdmissionClosed: false }));
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"scripts/verify-filesystem-lock-protocol-transition-preflight.ts",
				"--retiring-writer-inventory",
				inventoryPath,
				"--evidence-file",
				evidencePath,
				"--candidate-source-commit",
				"a".repeat(40),
				"--runtime-home",
				fixture.isolatedHomeDirectoryPath,
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				env: fixture.createIsolatedChildProcessEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		childProcesses.register(child);
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, child, {
			waitedForDescription: "协议切换前置 CLI 退出",
			softDeadlineMsExpectedOnUncontendedHost: 5_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
		});
		expect(child.exitCode).toBe(2);
		const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
		expect(evidence.status).toBe("evidence_unavailable");
		expect(evidence.recoveryRunBinding).toMatchObject({
			retiringWriterInventoryFilePath: inventoryPath,
			expectedCandidateSourceCommit: "a".repeat(40),
			writerLaunchAdmissionMustRemainClosed: true,
			requiredWriterDisposition: "absent_or_replaced_or_system_boot_changed",
			retryIntervalMs: 15_000,
		});
		expect(evidence.recoveryRunBinding.retiringWriterInventorySha256).toMatch(/^[a-f0-9]{64}$/u);
	});
});
