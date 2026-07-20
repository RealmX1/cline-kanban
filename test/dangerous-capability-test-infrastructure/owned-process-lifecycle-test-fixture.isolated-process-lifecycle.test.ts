import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createOwnedProcessLifecycleTestFixture } from "./owned-process-lifecycle-test-fixture";

describe("owned process lifecycle test fixture", () => {
	it("terminates an owned process tree without terminating an unrelated sentinel process", async () => {
		const fixture = createOwnedProcessLifecycleTestFixture();
		const unrelatedSentinelProcess = fixture.spawnUnrelatedSentinelProcess();
		const ownedProcessTreeRoot = fixture.spawnOwnedProcess({
			command: process.execPath,
			arguments: [
				"-e",
				[
					"const { spawn } = require('node:child_process');",
					"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
					"process.stdout.write(String(child.pid) + '\\n');",
					"setInterval(() => {}, 1000);",
				].join(" "),
			],
			stdio: ["ignore", "pipe", "pipe"],
		});
		const ownedChildProcessId = await fixture.readFirstStandardOutputLineAsProcessId(ownedProcessTreeRoot);

		await fixture.terminateOwnedProcessTree(ownedProcessTreeRoot);

		expect(fixture.isProcessAlive(ownedProcessTreeRoot.pid)).toBe(false);
		expect(fixture.isProcessAlive(ownedChildProcessId)).toBe(false);
		expect(fixture.isProcessAlive(unrelatedSentinelProcess.pid)).toBe(true);
		fixture.assertUnrelatedSentinelProcessesAlive();
	});

	it("默认环境不会把父进程任意大小写的 poisoned Git 变量注入目标进程", async () => {
		vi.stubEnv("GIT_DIR", "/developer-repository-that-must-not-be-inherited/.git");
		vi.stubEnv("gIt_WoRk_TrEe", "/developer-repository-that-must-not-be-inherited");
		vi.stubEnv("git_object_directory", "/developer-repository-that-must-not-be-inherited/objects");
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		const fixture = createOwnedProcessLifecycleTestFixture();
		const childProcess = fixture.spawnOwnedProcess({
			command: process.execPath,
			arguments: [
				"-e",
				'process.stdout.write(JSON.stringify(["GIT_DIR", "gIt_WoRk_TrEe", "git_object_directory"].map((name) => process.env[name] ?? "absent")))',
			],
			stdio: ["ignore", "pipe", "pipe"],
		});
		let standardOutput = "";
		childProcess.stdout?.setEncoding("utf8");
		childProcess.stdout?.on("data", (chunk: string) => {
			standardOutput += chunk;
		});
		await new Promise<void>((resolveExit, rejectExit) => {
			childProcess.once("error", rejectExit);
			childProcess.once("exit", () => resolveExit());
		});

		expect(JSON.parse(standardOutput)).toEqual(["absent", "absent", "absent"]);
	});

	it("清洗环境允许显式覆盖普通变量并拒绝重新加入任意大小写的 Git 变量", () => {
		vi.stubEnv("GIT_DIR", "/developer-repository-that-must-not-be-inherited/.git");
		vi.stubEnv("gIt_WoRk_TrEe", "/developer-repository-that-must-not-be-inherited");
		vi.stubEnv("git_object_directory", "/developer-repository-that-must-not-be-inherited/objects");
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		const fixture = createOwnedProcessLifecycleTestFixture();

		const sanitizedEnvironmentVariables = fixture.createSanitizedChildProcessEnvironment({
			HOME: "/owned-test-home",
		});

		expect(sanitizedEnvironmentVariables.GIT_DIR).toBeUndefined();
		expect(sanitizedEnvironmentVariables.gIt_WoRk_TrEe).toBeUndefined();
		expect(sanitizedEnvironmentVariables.git_object_directory).toBeUndefined();
		expect(sanitizedEnvironmentVariables.HOME).toBe("/owned-test-home");
		expect(() => fixture.createSanitizedChildProcessEnvironment({ GIT_DIR: "/unsafe-repository/.git" })).toThrow(
			/Cannot add Git environment variable GIT_DIR/,
		);
		expect(() => fixture.createSanitizedChildProcessEnvironment({ gIt_WoRk_TrEe: "/unsafe-repository" })).toThrow(
			/Cannot add Git environment variable gIt_WoRk_TrEe/,
		);
		expect(() =>
			fixture.createSanitizedChildProcessEnvironment({ git_object_directory: "/unsafe-repository/objects" }),
		).toThrow(/Cannot add Git environment variable git_object_directory/);
	});

	it("拒绝终止未登记为 target 的无关 sentinel", async () => {
		const fixture = createOwnedProcessLifecycleTestFixture();
		const unrelatedSentinelProcess = fixture.spawnUnrelatedSentinelProcess();

		await expect(fixture.terminateOwnedProcessTree(unrelatedSentinelProcess)).rejects.toThrow(
			/Refusing to terminate a process not owned/,
		);
		expect(fixture.isProcessAlive(unrelatedSentinelProcess.pid)).toBe(true);
	});

	it("root 已退出后仍按独立进程组清理其遗留后代", async () => {
		const fixture = createOwnedProcessLifecycleTestFixture();
		const shortLivedRootProcess = fixture.spawnOwnedProcess({
			command: process.execPath,
			arguments: [
				"-e",
				[
					"const { spawn } = require('node:child_process');",
					"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
					"process.stdout.write(String(child.pid) + '\\n');",
					"child.unref();",
				].join(" "),
			],
			stdio: ["ignore", "pipe", "pipe"],
		});
		const orphanCandidateProcessId = await fixture.readFirstStandardOutputLineAsProcessId(shortLivedRootProcess);
		await new Promise<void>((resolveExit, rejectExit) => {
			shortLivedRootProcess.once("error", rejectExit);
			shortLivedRootProcess.once("exit", () => resolveExit());
		});
		expect(fixture.isProcessAlive(orphanCandidateProcessId)).toBe(true);

		await fixture.cleanup();

		const descendantReapDeadline = Date.now() + 2_000;
		while (fixture.isProcessAlive(orphanCandidateProcessId) && Date.now() < descendantReapDeadline) {
			await new Promise<void>((resolveWait) => {
				setTimeout(resolveWait, 25);
			});
		}
		expect(fixture.isProcessAlive(orphanCandidateProcessId)).toBe(false);
	});
});
