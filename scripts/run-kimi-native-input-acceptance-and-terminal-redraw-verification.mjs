// 按生产运行时的打包方式构造探针，再在隔离 HOME 中运行；不继承真实任务身份或凭据。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const [requestedOutputDirectory, requestedKimiBinary, requestedProbeKind = "acceptance-and-redraw"] = process.argv.slice(2);
assert(
	requestedOutputDirectory && requestedKimiBinary,
	"用法：node scripts/run-kimi-native-input-acceptance-and-terminal-redraw-verification.mjs <持久证据目录> <Kimi 二进制绝对路径> [initial-prompt]",
);
assert(["acceptance-and-redraw", "initial-prompt"].includes(requestedProbeKind), "未知的 Kimi 原生验证种类");
const outputRootDirectory = resolve(requestedOutputDirectory);
const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(outputRootDirectory, { recursive: true });
const verifiesInitialPrompt = requestedProbeKind === "initial-prompt";
// 每轮保留独立 HOME、工作目录和证据，避免重跑时沿用已批准的工作区信任。
const outputDirectory = verifiesInitialPrompt
	? await mkdtemp(join(outputRootDirectory, "initial-prompt-execution-"))
	: outputRootDirectory;
if (verifiesInitialPrompt) {
	await writeFile(
		join(outputRootDirectory, "result.json"),
		JSON.stringify({ status: "running", executionDirectory: outputDirectory }, null, 2),
	);
}
const dependenciesDirectory = await realpath(join(repositoryDirectory, "node_modules"));
try {
	await symlink(dependenciesDirectory, join(outputDirectory, "node_modules"), "dir");
} catch (error) {
	if (error.code !== "EEXIST") throw error;
}
assert.equal(await realpath(join(outputDirectory, "node_modules")), await realpath(dependenciesDirectory));
const entrypoint = join(outputDirectory, verifiesInitialPrompt ? "native-kimi-initial-prompt-probe.mjs" : "native-kimi-probe.mjs");
await build({
	entryPoints: [
		join(
			repositoryDirectory,
			verifiesInitialPrompt
				? "scripts/verify-kimi-native-initial-prompt-delivery.ts"
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
	},
});
const code = await new Promise((resolveExit, reject) => {
	child.once("error", reject);
	child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
});
if (verifiesInitialPrompt) {
	const probeResult =
		code === 0 ? JSON.parse(await readFile(join(outputDirectory, "result.json"), "utf8")) : { status: "failed" };
	await writeFile(
		join(outputRootDirectory, "result.json"),
		JSON.stringify({ ...probeResult, executionDirectory: outputDirectory, exitCode: code }, null, 2),
	);
}
process.exitCode = code;
