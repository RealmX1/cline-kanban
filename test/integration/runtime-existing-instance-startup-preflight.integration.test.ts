import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe("已有监听实例时的 CLI 启动边界", { timeout: 65_000 }, () => {
	it.for([true, false])("已有 Kanban=%s 时不留下第二份运行时心跳", async (isKanban, context) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const packagedDirectory = join(fixture.fixtureRootDirectoryPath, "packaged-runtime");
		await mkdir(join(packagedDirectory, "web-ui/assets"), { recursive: true });
		await writeFile(join(packagedDirectory, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(packagedDirectory, "web-ui/index.html"), "<!doctype html><title>隔离启动边界</title>");
		await symlink(resolve("node_modules"), join(packagedDirectory, "node_modules"), "dir");
		for (const worker of [
			"notifications/notification-lifecycle-database-worker.mjs",
			"inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs",
		]) {
			await copyFile(resolve("src", worker), join(packagedDirectory, worker.split("/").at(-1) ?? ""));
		}
		const cli = join(packagedDirectory, "cli.js");
		await build({
			entryPoints: [resolve("src/cli.ts")],
			outfile: cli,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			external: ["node-pty", "better-sqlite3", "@napi-rs/keyring", "sharp"],
			define: { "process.env.NODE_ENV": '"production"' },
			banner: {
				js: 'import { createRequire as createStartupBoundaryRequire } from "node:module"; const require = createStartupBoundaryRequire(import.meta.url);',
			},
		});
		const server = createServer((_req, response) => {
			response.writeHead(isKanban ? 200 : 404, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify(
					isKanban ? { result: { data: { currentProjectId: null, projects: [] } } } : { error: "foreign service" },
				),
			);
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		onTestFinished(async () => {
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("隔离端口未分配");
		const child = children.register(
			spawn(process.execPath, [cli, "--host", "127.0.0.1", "--port", String(address.port), "--no-open"], {
				cwd: fixture.fixtureRootDirectoryPath,
				env: fixture.createIsolatedChildProcessEnvironment({ NODE_ENV: "test" }),
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (bytes: Buffer) => {
			stdout += bytes.toString();
		});
		child.stderr?.on("data", (bytes: Buffer) => {
			stderr += bytes.toString();
		});
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
			context,
			child,
			{
				waitedForDescription: "已有监听实例的重复启动完成",
				softDeadlineMsExpectedOnUncontendedHost: 8_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
			},
			{ describeChildProcessOutputForFailureMessage: () => stdout + stderr },
		);
		expect(child.exitCode, stderr).toBe(isKanban ? 0 : 1);
		if (isKanban) expect(stdout).toContain("Kanban already running");
		else expect(stderr).toContain("EADDRINUSE");
		const heartbeatDirectory = join(
			fixture.isolatedHomeDirectoryPath,
			".cline",
			"kanban",
			"runtime-process-instance-heartbeats",
		);
		expect(await readdir(heartbeatDirectory).catch(() => []), stdout + stderr).toEqual([]);
	});
});
