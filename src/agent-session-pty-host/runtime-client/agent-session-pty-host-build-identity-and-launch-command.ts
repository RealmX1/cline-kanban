// 当前 build 的 agent session PTY host：build identity 与启动命令。
//
// build identity = sha256(host 代码 ‖ node-pty 版本 ‖ Node 版本 ‖ CPU 架构)。它决定 generation：identity 变了，
// 新会话进新 host，旧 host 继续服务存量会话直到排空。所以 identity 只应在「host 实际行为可能变了」时才变——
// host bundle 的依赖闭包被 import 守卫限制在 node:*、node-pty、wire-protocol 与终止信号策略之内，
// runtime 其余代码改动不会让它变化。
//
// 两种运行形态：
// - 打包态（dist/cli.js）：host 是 dist/agent-session-pty-host.js，identity 取其文件内容。
// - 源码态（tsx src/cli.ts，隔离实例与端到端测试用）：host 是 TS 入口，经同一组 tsx loader 参数启动，
//   identity 取 host 依赖闭包内全部源文件。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentSessionPtyHostLaunchCommand {
	executablePath: string;
	// 放在 host 自身参数之前：Node 参数（源码态的 tsx loader）+ host 脚本路径。
	leadingArguments: string[];
}

export interface CurrentBuildAgentSessionPtyHostDescriptor {
	hostBuildIdentity: string;
	launchCommand: AgentSessionPtyHostLaunchCommand;
}

function isRunningFromTypeScriptSource(): boolean {
	return import.meta.url.endsWith(".ts");
}

function readNodePtyPackageVersion(): string {
	try {
		const requireFromThisModule = createRequire(import.meta.url);
		const nodePtyPackageJsonPath = requireFromThisModule.resolve("node-pty/package.json");
		const parsedPackageJson = JSON.parse(readFileSync(nodePtyPackageJsonPath, "utf8")) as { version?: unknown };
		return typeof parsedPackageJson.version === "string" ? parsedPackageJson.version : "unknown";
	} catch {
		return "unknown";
	}
}

// 调试参数不能继承：host 会去抢同一个 inspector 端口。
function readNodeExecutionArgumentsInheritableByHostProcess(): string[] {
	return process.execArgv.filter((argument) => !/^--(inspect|debug)/.test(argument));
}

function listTypeScriptSourceFilesInDirectory(directoryPath: string): string[] {
	return readdirSync(directoryPath)
		.filter((entryName) => entryName.endsWith(".ts"))
		.sort()
		.map((entryName) => join(directoryPath, entryName));
}

function computeHostBuildIdentityFromHostCodeBytes(hostCodeChunks: readonly Buffer[]): string {
	const hash = createHash("sha256");
	for (const hostCodeChunk of hostCodeChunks) {
		hash.update(hostCodeChunk);
	}
	hash.update(`\0node-pty@${readNodePtyPackageVersion()}\0node@${process.version}\0arch@${process.arch}`);
	return hash.digest("hex");
}

export function resolveCurrentBuildAgentSessionPtyHostDescriptor(): CurrentBuildAgentSessionPtyHostDescriptor {
	if (isRunningFromTypeScriptSource()) {
		const hostProcessDirectoryPath = fileURLToPath(new URL("../host-process/", import.meta.url));
		const wireProtocolDirectoryPath = fileURLToPath(new URL("../wire-protocol/", import.meta.url));
		const terminationSignalPolicyPath = fileURLToPath(
			new URL("../../terminal/pty-process-group-termination-signal-policy.ts", import.meta.url),
		);
		const hostClosureSourceFilePaths = [
			...listTypeScriptSourceFilesInDirectory(hostProcessDirectoryPath),
			...listTypeScriptSourceFilesInDirectory(wireProtocolDirectoryPath),
			terminationSignalPolicyPath,
		];
		return {
			hostBuildIdentity: computeHostBuildIdentityFromHostCodeBytes(
				hostClosureSourceFilePaths.map((sourceFilePath) => readFileSync(sourceFilePath)),
			),
			launchCommand: {
				executablePath: process.execPath,
				leadingArguments: [
					...readNodeExecutionArgumentsInheritableByHostProcess(),
					join(hostProcessDirectoryPath, "agent-session-pty-host-process-entry.ts"),
				],
			},
		};
	}
	// 打包态：本模块被打进 dist/cli.js（与 dist/index.js），host bundle 就在同目录。
	const hostBundlePath = fileURLToPath(new URL("./agent-session-pty-host.js", import.meta.url));
	return {
		hostBuildIdentity: computeHostBuildIdentityFromHostCodeBytes([readFileSync(hostBundlePath)]),
		launchCommand: {
			executablePath: process.execPath,
			leadingArguments: [...readNodeExecutionArgumentsInheritableByHostProcess(), hostBundlePath],
		},
	};
}
