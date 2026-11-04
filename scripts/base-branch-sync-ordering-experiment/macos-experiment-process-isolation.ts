import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	assertOwnedExperimentRoot,
	createPrivateDirectory,
	isolatedProcessEnvironment,
	isWithin,
	writeDurableJson,
} from "./persistent-experiment-storage";

export function createOwnedModelEndpointProxySandboxRule(port: number) {
	if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3484)
		throw new Error("模型代理未取得合法专用端口");
	return `(allow network-outbound (remote tcp "localhost:${port}"))\n`;
}

// deny default 同时限制读取与写入；基础配置不允许任何 TCP 或 UDP 出站。
export function createMacosExperimentSandboxProfile(
	groupDirectory: string,
	executablePaths: string[],
	readOnlyDirectoryPaths: string[] = [],
) {
	for (const directory of readOnlyDirectoryPaths)
		if (!isWithin(groupDirectory, directory) || resolve(groupDirectory) === resolve(directory))
			throw new Error("冻结只读目录必须位于当前实验组内，不能覆盖整个原生存储组");
	const quoted = (path: string) => JSON.stringify(resolve(path));
	const readableRoots = [
		"/System",
		"/Library",
		"/usr",
		"/bin",
		"/sbin",
		"/opt/homebrew",
		"/private/etc",
		"/private/var/db",
		"/dev",
	];
	return (
		`(version 1)\n(deny default)\n(allow process* sysctl-read mach-lookup ipc-posix* system-socket)\n` +
		`(allow system-mac-syscall (mac-policy-name "vnguard"))\n(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))\n` +
		`(allow file-test-existence)\n(allow file-read* (literal "/"))\n(allow file-write-data (subpath "/dev/fd"))\n` +
		`(allow file-read-metadata)\n(allow file-read* file-map-executable ${[...readableRoots, groupDirectory].map((path) => `(subpath ${quoted(path)})`).join(" ")} ${executablePaths.map((path) => `(literal ${quoted(path)})`).join(" ")})\n` +
		`(allow file-write* (subpath ${quoted(groupDirectory)}) (literal "/dev/null") (literal "/dev/tty"))\n` +
		readOnlyDirectoryPaths.map((directory) => `(deny file-write* (subpath ${quoted(directory)}))\n`).join("")
	);
}

export async function prepareProcessIsolation(
	root: string,
	groupDirectory: string,
	executablePaths: string[],
	readOnlyDirectoryPaths: string[] = [],
) {
	await assertOwnedExperimentRoot(root, groupDirectory);
	if (process.platform !== "darwin")
		throw new Error("当前执行器要求经过实测的 macOS sandbox-exec；其他平台尚未证明隔离");
	await createPrivateDirectory(groupDirectory);
	await createPrivateDirectory(join(groupDirectory, "isolated-home"));
	await createPrivateDirectory(join(groupDirectory, "isolated-temporary-files"));
	const environment = isolatedProcessEnvironment(
		join(groupDirectory, "isolated-home"),
		join(groupDirectory, "isolated-temporary-files"),
	);
	const profilePath = join(groupDirectory, "experiment-process-sandbox.sb");
	const actualReadOnlyDirectories = await Promise.all(readOnlyDirectoryPaths.map((directory) => realpath(directory)));
	await writeFile(
		profilePath,
		createMacosExperimentSandboxProfile(
			await realpath(groupDirectory),
			await Promise.all(executablePaths.map((path) => realpath(path))),
			actualReadOnlyDirectories,
		),
		{ mode: 0o600 },
	);
	return { environment, profilePath };
}

export async function runIsolatedCommand(input: {
	argv: string[];
	cwd: string;
	environment: NodeJS.ProcessEnv;
	profilePath: string;
	timeoutMs: number;
}) {
	if (!input.argv.length) throw new Error("执行参数不能为空");
	const startedAt = Date.now();
	const child = spawn("/usr/bin/sandbox-exec", ["-f", input.profilePath, ...input.argv], {
		cwd: input.cwd,
		env: input.environment,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.on("data", (chunk: Buffer) => {
		stdout = `${stdout}${chunk.toString()}`.slice(-2_000_000);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString()}`.slice(-2_000_000);
	});
	const kill = () => {
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, input.timeoutMs);
	try {
		const termination = await new Promise<{ exitCode: number | null; signal: string | null }>(
			(resolveExit, reject) => {
				child.once("error", reject);
				child.once("close", (exitCode, signal) => resolveExit({ exitCode, signal }));
			},
		);
		return { argv: input.argv, startedAt, finishedAt: Date.now(), ...termination, timedOut, stdout, stderr };
	} finally {
		clearTimeout(timer);
		kill();
	}
}

/** 自动化探针既证明允许的动作，也证明越界动作被拒；不把配置文本当作实测。 */
export async function probeProcessIsolation(root: string, groupDirectory: string, nodeBinary = process.execPath) {
	await assertOwnedExperimentRoot(root, groupDirectory);
	await mkdir(join(root, "protected-isolation-sentinels"), { recursive: true, mode: 0o700 });
	const sentinelPath = join(root, "protected-isolation-sentinels", "production-and-other-arm-sentinel.txt");
	const sentinel = "隔离外哨兵，禁止实验进程读取或修改\n";
	await writeFile(sentinelPath, sentinel, { mode: 0o600 });
	const isolation = await prepareProcessIsolation(root, groupDirectory, [nodeBinary]);
	const server = createServer((socket) => {
		socket.destroy();
	});
	await new Promise<void>((resolveListening, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListening);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("隔离探针未取得端口");
	const script = `const fs=require('node:fs'); const net=require('node:net'); const result={};
fs.writeFileSync(${JSON.stringify(join(groupDirectory, "permitted-write.txt"))},'允许'); result.permittedWrite=true;
for (const [key, action] of [['outsideRead',()=>fs.readFileSync(${JSON.stringify(sentinelPath)})],['outsideWrite',()=>fs.writeFileSync(${JSON.stringify(sentinelPath)},'污染')]]) {try {action();result[key]='allowed';}catch{result[key]='denied';}}
const socket=net.connect({host:'127.0.0.1',port:${address.port}}); const finish=(value)=>{result.loopbackConnection=value;process.stdout.write(JSON.stringify(result));socket.destroy();};
socket.on('connect',()=>finish('allowed')); socket.on('error',()=>finish('denied')); socket.setTimeout(2000,()=>finish('denied'));`;
	try {
		const result = await runIsolatedCommand({
			argv: [nodeBinary, "-e", script],
			cwd: groupDirectory,
			...isolation,
			timeoutMs: 10_000,
		});
		const observation = z
			.object({
				permittedWrite: z.literal(true),
				outsideRead: z.literal("denied"),
				outsideWrite: z.literal("denied"),
				loopbackConnection: z.literal("denied"),
			})
			.safeParse(JSON.parse(result.stdout || "null"));
		const passed =
			result.exitCode === 0 && observation.success && (await readFile(sentinelPath, "utf8")) === sentinel;
		await writeDurableJson(join(groupDirectory, "isolation-probe-result.json"), {
			passed,
			...result,
			observation: observation.success ? observation.data : null,
		});
		if (!passed) throw new Error("实际隔离探针未通过，禁止启动模型或实验命令");
		return isolation;
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}
