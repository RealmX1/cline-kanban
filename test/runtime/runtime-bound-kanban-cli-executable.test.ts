import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRuntimeBoundKanbanCliExecutable } from "../../src/core/runtime-bound-kanban-cli-executable";

const temporaryDirectoryPaths: string[] = [];
afterEach(() => {
	for (const directoryPath of temporaryDirectoryPaths.splice(0))
		rmSync(directoryPath, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("运行时绑定 CLI 入口", () => {
	it.each([
		{ flags: ["--import", "./preload.mjs"], marker: "runtime-import" },
		{ flags: ["--import=./preload.mjs"], marker: "runtime-import" },
		{ flags: ["--import", "runtime-startup-fixture"], marker: "runtime-import" },
		{
			flags: ["--conditions", "kanban-bound", "--import=runtime-startup-fixture"],
			marker: "runtime-condition",
		},
		{ flags: ["--require", "./preload.cjs"], marker: "runtime-require" },
		{ flags: ["--require=./preload.cjs"], marker: "runtime-require" },
		{ flags: ["-r", "runtime-startup-fixture"], marker: "runtime-require" },
		{ flags: ["--loader", "./loader.mjs"], marker: "runtime-loader" },
		{ flags: ["--experimental-loader=./loader.mjs"], marker: "runtime-loader" },
	])("绑定启动模块 $flags，跨目录仍使用运行时模块并保留调用者 cwd", ({ flags, marker }) => {
		const directoryPath = mkdtempSync(join(tmpdir(), "kanban module binding ' $ "));
		temporaryDirectoryPaths.push(directoryPath);
		const runtimeDirectoryPath = join(directoryPath, "runtime");
		const callerDirectoryPath = join(directoryPath, "unrelated-caller");
		const packageDirectoryPath = join(runtimeDirectoryPath, "node_modules", "runtime-startup-fixture");
		mkdirSync(packageDirectoryPath, { recursive: true });
		mkdirSync(callerDirectoryPath);
		for (const [name, value] of [
			["preload.mjs", "runtime-import"],
			["preload.cjs", "runtime-require"],
			["condition.mjs", "runtime-condition"],
		]) {
			const source = `globalThis.runtimeStartupMarker = ${JSON.stringify(value)};`;
			writeFileSync(join(runtimeDirectoryPath, name), source);
			writeFileSync(join(packageDirectoryPath, name), source);
		}
		writeFileSync(
			join(packageDirectoryPath, "package.json"),
			JSON.stringify({
				name: "runtime-startup-fixture",
				exports: {
					"kanban-bound": "./condition.mjs",
					import: "./preload.mjs",
					require: "./preload.cjs",
				},
			}),
		);
		writeFileSync(
			join(runtimeDirectoryPath, "loader.mjs"),
			`export function resolve(specifier, context, nextResolve) {
				if (specifier === "runtime-bound-cli-probe") return {
					url: "data:text/javascript,export default 'runtime-loader';", shortCircuit: true
				};
				return nextResolve(specifier, context);
			}`,
		);
		const cliEntrypointPath = join(runtimeDirectoryPath, "probe.mjs");
		writeFileSync(
			cliEntrypointPath,
			`${marker === "runtime-loader" ? 'import marker from "runtime-bound-cli-probe";' : "const marker = globalThis.runtimeStartupMarker;"}
			process.stdout.write(JSON.stringify({marker, cwd:process.cwd(), args:process.argv.slice(2)}));`,
		);
		const binding = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				"--input-type=module",
				"--eval",
				`import { ensureRuntimeBoundKanbanCliExecutable } from ${JSON.stringify(new URL("../../src/core/runtime-bound-kanban-cli-executable.ts", import.meta.url).href)};
				process.stdout.write(ensureRuntimeBoundKanbanCliExecutable(JSON.parse(process.argv[1])));`,
				JSON.stringify({
					commandParts: [process.execPath, ...flags, cliEntrypointPath],
					executableStorageDirectoryPath: join(directoryPath, "executables"),
				}),
			],
			{ cwd: runtimeDirectoryPath, env: { HOME: directoryPath, PATH: "/usr/bin:/bin" }, encoding: "utf8" },
		);
		expect(binding.status, binding.stderr).toBe(0);
		const result = spawnSync(binding.stdout, ["业务 ' $", ""], {
			cwd: callerDirectoryPath,
			env: { HOME: directoryPath, PATH: "/usr/bin:/bin" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			marker,
			cwd: realpathSync(callerDirectoryPath),
			args: ["业务 ' $", ""],
		});
	});
	it("绑定解析后的 CLI 路径，外部重新链接安装不会改变已有入口", () => {
		const directoryPath = mkdtempSync(join(tmpdir(), "kanban-cli-installation-binding-"));
		temporaryDirectoryPaths.push(directoryPath);
		const firstInstallationPath = join(directoryPath, "first-installation.mjs");
		const secondInstallationPath = join(directoryPath, "second-installation.mjs");
		const installationLinkPath = join(directoryPath, "kanban");
		writeFileSync(firstInstallationPath, "process.stdout.write('first');");
		writeFileSync(secondInstallationPath, "process.stdout.write('second');");
		symlinkSync(firstInstallationPath, installationLinkPath);
		const executablePath = ensureRuntimeBoundKanbanCliExecutable({
			commandParts: [process.execPath, installationLinkPath],
			executableStorageDirectoryPath: directoryPath,
		});
		unlinkSync(installationLinkPath);
		symlinkSync(secondInstallationPath, installationLinkPath);
		const result = spawnSync(executablePath, [], {
			env: { PATH: "/usr/bin:/bin", HOME: directoryPath },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("first");
	});
	it("不同 shell 使用绑定的 Node 和参数，逐字保留含空格及 shell 字符的路径与业务输入", () => {
		const directoryPath = mkdtempSync(join(tmpdir(), "kanban bound cli ' $ "));
		temporaryDirectoryPaths.push(directoryPath);
		const cliEntrypointPath = join(directoryPath, "cli ' $ argument probe.mjs");
		writeFileSync(
			cliEntrypointPath,
			"process.stdout.write(JSON.stringify({node:process.execPath,flags:process.execArgv,args:process.argv.slice(2),cwd:process.cwd()}));",
		);
		const input = {
			commandParts: [process.execPath, "--no-warnings", cliEntrypointPath],
			executableStorageDirectoryPath: directoryPath,
		};
		const executablePath = ensureRuntimeBoundKanbanCliExecutable(input);
		const expectedArguments = ["task", "get-current-task", "业务 ' \" $HOME $(false) `false`\n第二行", ""];
		for (const shellPath of ["/bin/sh", "/bin/bash", ...(process.platform === "darwin" ? ["/bin/zsh"] : [])]) {
			for (const shellArguments of [["-c"], ["-lc"]]) {
				const result = spawnSync(
					shellPath,
					[
						...shellArguments,
						'"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH" "$@"',
						"bound-cli-probe",
						...expectedArguments,
					],
					{
						cwd: directoryPath,
						env: {
							PATH: "/usr/bin:/bin",
							HOME: directoryPath,
							KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH: executablePath,
						},
						encoding: "utf8",
					},
				);
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(result.stdout)).toEqual({
					node: process.execPath,
					flags: ["--no-warnings"],
					args: expectedArguments,
					cwd: realpathSync(directoryPath),
				});
			}
		}
		const frozenContents = readFileSync(executablePath, "utf8");
		expect(ensureRuntimeBoundKanbanCliExecutable(input)).toBe(executablePath);
		expect(readFileSync(executablePath, "utf8")).toBe(frozenContents);
		expect(
			ensureRuntimeBoundKanbanCliExecutable({ ...input, commandParts: [process.execPath, cliEntrypointPath] }),
		).not.toBe(executablePath);
	});
});
