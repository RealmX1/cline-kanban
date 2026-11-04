import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runLocalDeploymentCommandPreservingOriginalOutput } from "../../../src/deployment/local-deployment-execution-process";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { createTempDir } from "../../utilities/temp-dir";

function commandContext() {
	const directory = createTempDir("local-deployment-process-originals-");
	onTestFinished(() => {
		vi.restoreAllMocks();
		directory.cleanup();
	});
	return {
		cwd: directory.path,
		commandOutputDirectory: join(directory.path, "command-originals"),
		executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
		stage: "build_publication" as const,
		attemptNumber: 1,
		assertCommandMayStart: () => undefined,
	};
}

describe("部署 runner 的原生启动事实", () => {
	it("输出文件已经打开后的最后资格复核拒绝启动，真实子进程不产生副作用", async () => {
		const context = commandContext();
		await mkdir(context.commandOutputDirectory);
		context.assertCommandMayStart = () => {
			expect(existsSync(join(context.commandOutputDirectory, "stdout.txt"))).toBe(true);
			expect(existsSync(join(context.commandOutputDirectory, "stderr.txt"))).toBe(true);
			throw new Error("Stop 或锁失效已撤销本次启动资格");
		};
		const forbiddenPublicationFile = join(context.cwd, "forbidden-publication-side-effect.txt");
		const result = await runLocalDeploymentCommandPreservingOriginalOutput(
			[
				process.execPath,
				"-e",
				`require('node:fs').writeFileSync(${JSON.stringify(forbiddenPublicationFile)},'已发布')`,
			],
			context,
		);
		expect(result.processWasStarted).toBe(false);
		expect(result.stderr).toContain("撤销本次启动资格");
		expect(existsSync(forbiddenPublicationFile)).toBe(false);
		expect(
			JSON.parse(await readFile(join(context.commandOutputDirectory, "command-result.json"), "utf8")),
		).toMatchObject({ processWasStarted: false, processId: null });
	});

	it("stdout 打开失败明确未启动，不能执行候选命令", async () => {
		const context = commandContext();
		await mkdir(context.commandOutputDirectory);
		await writeFile(join(context.commandOutputDirectory, "stdout.txt"), "已有原件");
		const result = await runLocalDeploymentCommandPreservingOriginalOutput(
			[process.execPath, "-e", "process.exit(91)"],
			context,
		);
		expect(result.processWasStarted).toBe(false);
		expect(result.exitCode).toBeNull();
		expect(await readFile(join(context.commandOutputDirectory, "stdout.txt"), "utf8")).toBe("已有原件");
	});

	it.each(["missing", "synchronous_argument_error"])("%s 保留未启动事实与归属原件", async (failure) => {
		const context = commandContext();
		await mkdir(context.commandOutputDirectory);
		const command = [failure === "missing" ? join(context.cwd, "unavailable-executable") : ""];
		const result = await runLocalDeploymentCommandPreservingOriginalOutput(command, context);
		expect(result.processWasStarted).toBe(false);
		expect(
			JSON.parse(await readFile(join(context.commandOutputDirectory, "command-result.json"), "utf8")),
		).toMatchObject({
			command,
			cwd: context.cwd,
			processWasStarted: false,
			processId: null,
			attemptIdentity: {
				executionId: context.executionId,
				stage: context.stage,
				attemptNumber: 1,
				commandOutputDirectory: context.commandOutputDirectory,
			},
		});
	});

	it.each([false, true])("结果原件同步失败仍保留 processWasStarted=%s", async (started) => {
		const context = commandContext();
		await mkdir(context.commandOutputDirectory);
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockRejectedValueOnce(new Error("隔离模拟 ENOSPC"));
		const result = await runLocalDeploymentCommandPreservingOriginalOutput(
			started
				? [process.execPath, "-e", "process.stdout.write('已执行')"]
				: [join(context.cwd, "missing-executable")],
			context,
		);
		expect(result.processWasStarted).toBe(started);
		if (started) expect(result.stdout).toBe("已执行");
	});
});
