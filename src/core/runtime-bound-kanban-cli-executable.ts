import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildShellCommandLine } from "./shell";

export const RUNTIME_BOUND_KANBAN_CLI_SHELL_COMMAND_PREFIX = '"$KANBAN_RUNTIME_BOUND_CLI_EXECUTABLE_PATH"';

// 使用绑定的 Node 在运行时 cwd 解析，而非本模块目录；ESM 与 CJS 的 exports 条件不能混用。
const RESOLVE_NODE_MODULE_ARGUMENTS_SCRIPT = `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const args = JSON.parse(readFileSync(0, "utf8"));
const require = createRequire(pathToFileURL(process.cwd() + "/"));
for (let index = 0; index < args.length; index++) {
	const argument = args[index];
	const match = /^(--import|--loader|--experimental-loader|--require|-r)(?:=(.*))?$/s.exec(argument);
	if (!match) continue;
	const flag = match[1];
	const prefix = match[2] === undefined ? "" : flag + "=";
	const specifier = match[2] === undefined ? args[++index] : match[2];
	if (!specifier) throw new Error("Missing Node module argument: " + argument);
	const resolved = flag === "--require" || flag === "-r" ? require.resolve(specifier) : import.meta.resolve(specifier);
	args[index] = prefix + resolved;
}
process.stdout.write(JSON.stringify(args));
`;

function bindRuntimeNodeModuleArguments(nodeExecutablePath: string, nodeArguments: string[]): string[] {
	if (
		!nodeArguments.some((argument) =>
			/^(?:--(?:import|loader|experimental-loader|require)|-r)(?:=|$)/u.test(argument),
		)
	)
		return nodeArguments;
	const resolutionArguments: string[] = [];
	for (let index = 0; index < nodeArguments.length; index++) {
		const argument = nodeArguments[index];
		if (argument === "--conditions" || argument === "-C") {
			resolutionArguments.push(argument, nodeArguments[++index]);
		} else if (
			argument.startsWith("--conditions=") ||
			argument.startsWith("-C") ||
			argument === "--preserve-symlinks" ||
			argument === "--no-addons"
		) {
			resolutionArguments.push(argument);
		}
	}
	const resolution = spawnSync(
		nodeExecutablePath,
		[...resolutionArguments, "--input-type=module", "--eval", RESOLVE_NODE_MODULE_ARGUMENTS_SCRIPT],
		{ input: JSON.stringify(nodeArguments), encoding: "utf8" },
	);
	if (resolution.error) throw resolution.error;
	if (resolution.status !== 0) throw new Error(`无法绑定 Node 模块启动参数：${resolution.stderr}`);
	return JSON.parse(resolution.stdout) as string[];
}

// 内容寻址使不同安装互不覆盖；持久入口在登录 shell 重排 PATH 和运行时重启后仍绑定原 Node 与参数。
export function ensureRuntimeBoundKanbanCliExecutable(input: {
	commandParts: string[];
	executableStorageDirectoryPath: string;
}): string {
	const [runtimeNodeExecutablePath, ...runtimeCliArgumentsBeforeUserInput] = input.commandParts;
	if (!runtimeNodeExecutablePath || runtimeCliArgumentsBeforeUserInput.length === 0)
		throw new Error("缺少可绑定的 Kanban CLI 启动入口。");
	const cliEntrypointPath = runtimeCliArgumentsBeforeUserInput.at(-1);
	if (!cliEntrypointPath) throw new Error("缺少可绑定的 Kanban CLI 路径。");
	const canonicalNodeExecutablePath = realpathSync(runtimeNodeExecutablePath);
	const runtimeBoundCliArgumentsBeforeUserInput = [
		...bindRuntimeNodeModuleArguments(canonicalNodeExecutablePath, runtimeCliArgumentsBeforeUserInput.slice(0, -1)),
		realpathSync(cliEntrypointPath),
	];
	const runtimeBoundCliExecutableContents = `#!/bin/sh\nexec ${buildShellCommandLine(canonicalNodeExecutablePath, runtimeBoundCliArgumentsBeforeUserInput)} "$@"\n`;
	const runtimeBoundCliExecutableDirectoryPath = join(
		input.executableStorageDirectoryPath,
		createHash("sha256").update(runtimeBoundCliExecutableContents).digest("hex"),
	);
	mkdirSync(runtimeBoundCliExecutableDirectoryPath, { recursive: true, mode: 0o700 });
	const runtimeBoundCliExecutablePath = join(runtimeBoundCliExecutableDirectoryPath, "kanban");
	if (
		!existsSync(runtimeBoundCliExecutablePath) ||
		readFileSync(runtimeBoundCliExecutablePath, "utf8") !== runtimeBoundCliExecutableContents
	) {
		const pendingRuntimeBoundCliExecutablePublicationPath = join(
			runtimeBoundCliExecutableDirectoryPath,
			`kanban-${randomUUID()}.pending-publication`,
		);
		try {
			writeFileSync(pendingRuntimeBoundCliExecutablePublicationPath, runtimeBoundCliExecutableContents, {
				mode: 0o700,
				flag: "wx",
			});
			renameSync(pendingRuntimeBoundCliExecutablePublicationPath, runtimeBoundCliExecutablePath);
		} finally {
			rmSync(pendingRuntimeBoundCliExecutablePublicationPath, { force: true });
		}
	}
	chmodSync(runtimeBoundCliExecutablePath, 0o700);
	return runtimeBoundCliExecutablePath;
}
