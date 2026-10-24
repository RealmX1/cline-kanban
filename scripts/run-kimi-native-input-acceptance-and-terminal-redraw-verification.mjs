// 按生产运行时的打包方式构造探针，再在隔离 HOME 中运行；不继承真实任务身份或凭据。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const [requestedOutputDirectory, requestedKimiBinary, requestedScenario, requestedPackagedCli] = process.argv.slice(2);
assert(
	requestedOutputDirectory && requestedKimiBinary,
	"用法：node scripts/run-kimi-native-input-acceptance-and-terminal-redraw-verification.mjs <持久证据目录> <Kimi 二进制绝对路径>",
);
assert(!requestedScenario || requestedScenario === "--terminal-workflow", "未知的原生核验场景");
assert(!requestedScenario || requestedPackagedCli, "终端工作流核验需要打包后的 CLI 绝对路径");
const outputDirectory = resolve(requestedOutputDirectory);
const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(outputDirectory, { recursive: true });
const dependenciesDirectory = await realpath(join(repositoryDirectory, "node_modules"));
try {
	await symlink(dependenciesDirectory, join(outputDirectory, "node_modules"), "dir");
} catch (error) {
	if (error.code !== "EEXIST") throw error;
}
assert.equal(await realpath(join(outputDirectory, "node_modules")), await realpath(dependenciesDirectory));
const entrypoint = join(outputDirectory, "native-kimi-probe.mjs");
await build({
	entryPoints: [
		join(
			repositoryDirectory,
			requestedScenario
				? "scripts/verify-kimi-native-terminal-startup-and-hook-workflow.ts"
				: "scripts/verify-kimi-native-input-acceptance-and-terminal-redraw.ts",
		),
	],
	outfile: entrypoint,
	bundle: true,
	format: "esm",
	platform: "node",
	packages: "bundle",
	external: ["node-pty", "better-sqlite3", "@napi-rs/keyring", "sharp"],
	banner: {
		js: 'import {createRequire as __probeCreateRequire} from "node:module"; const require=__probeCreateRequire(import.meta.url);',
	},
});
const child = spawn(process.execPath, [entrypoint], {
	cwd: repositoryDirectory,
	stdio: "inherit",
	env: {
		HOME: join(outputDirectory, "isolated-home"),
		PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
		SHELL: process.env.SHELL || "/bin/sh",
		TERM: "xterm-256color",
		KANBAN_KIMI_NATIVE_E2E_OUTPUT_DIRECTORY: outputDirectory,
		KANBAN_KIMI_NATIVE_E2E_BINARY: resolve(requestedKimiBinary),
		...(requestedPackagedCli ? { KANBAN_KIMI_NATIVE_E2E_PACKAGED_CLI: resolve(requestedPackagedCli) } : {}),
	},
});
const code = await new Promise((resolveExit, reject) => {
	child.once("error", reject);
	child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
});
process.exitCode = code;
