import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import lockfile from "proper-lockfile";
import { z } from "zod";

export async function writeDurableJson(path: string, value: unknown) {
	const pendingPath = `${path}.writing-${randomUUID()}`;
	const descriptor = await open(pendingPath, "wx", 0o600);
	try {
		await descriptor.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await descriptor.sync();
	} finally {
		await descriptor.close();
	}
	await rename(pendingPath, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

export function isWithin(root: string, path: string) {
	const suffix = relative(resolve(root), resolve(path));
	return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

export async function assertNoSymlinkAncestors(path: string) {
	let current = resolve(path);
	while (true) {
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error(`目录祖先不能是符号链接：${current}`);
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
		if (dirname(current) === current) break;
		current = dirname(current);
	}
}

export async function createPrivateDirectory(path: string) {
	await assertNoSymlinkAncestors(path);
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

export async function safeEntryPath(root: string, path: string) {
	if (!path || isAbsolute(path) || path.split(/[\\/]/u).some((part) => ["..", ".git", ""].includes(part)))
		throw new Error(`快照包含不安全路径：${path}`);
	const target = resolve(root, path);
	if (!isWithin(root, target) || target === resolve(root)) throw new Error("快照路径越界");
	await assertNoSymlinkAncestors(dirname(target));
	return target;
}

export function isolatedProcessEnvironment(home: string, temporaryDirectory: string): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"])
		if (process.env[key]) result[key] = process.env[key];
	return {
		...result,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, "xdg-config"),
		TMPDIR: temporaryDirectory,
		TMP: temporaryDirectory,
		TEMP: temporaryDirectory,
		CODEX_HOME: join(home, "codex-home"),
		CODEX_SQLITE_HOME: join(home, "codex-sqlite-home"),
		// 原生 HTTP 客户端会自动发现 macOS 的本地系统代理；实验只允许直接 TLS 出站。
		NO_PROXY: "*",
		no_proxy: "*",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "file",
		GIT_CONFIG_COUNT: "3",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: "/dev/null",
		GIT_CONFIG_KEY_1: "core.fsmonitor",
		GIT_CONFIG_VALUE_1: "false",
		// Apple Git 的 diff 即使禁 optional locks 仍可能刷新 stat；读取实验输入不能改变原 index 字节。
		GIT_CONFIG_KEY_2: "diff.autoRefreshIndex",
		GIT_CONFIG_VALUE_2: "false",
		GIT_AUTHOR_NAME: "排序实验",
		GIT_COMMITTER_NAME: "排序实验",
		GIT_AUTHOR_EMAIL: "ordering-experiment@example.invalid",
		GIT_COMMITTER_EMAIL: "ordering-experiment@example.invalid",
	};
}

export async function executeGit(
	cwd: string,
	args: string[],
	options: {
		input?: string | Buffer;
		inputPath?: string;
		outputPath?: string;
		timeoutMs?: number;
		environment?: NodeJS.ProcessEnv;
	} = {},
): Promise<Buffer> {
	const environment = options.environment ?? isolatedProcessEnvironment("/nonexistent", "/nonexistent");
	const child = spawn(
		"git",
		[
			"--no-optional-locks",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"diff.autoRefreshIndex=false",
			...args,
		],
		{
			cwd,
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
			signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
		},
	);
	const output: Buffer[] = [];
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString()}`.slice(-4000);
	});
	const exited = new Promise<void>((resolveExit, reject) => {
		child.once("error", reject);
		child.stdin.on("error", reject);
		child.once("close", (code) => (code === 0 ? resolveExit() : reject(new Error(`Git ${args[0]} 失败：${stderr}`))));
	});
	try {
		const streams: Promise<unknown>[] = [exited];
		if (options.outputPath)
			streams.push(pipeline(child.stdout, createWriteStream(options.outputPath, { mode: 0o600 })));
		else child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
		if (options.inputPath) streams.push(pipeline(createReadStream(options.inputPath), child.stdin));
		else child.stdin.end(options.input);
		await Promise.all(streams);
		return Buffer.concat(output);
	} catch (error) {
		child.kill("SIGKILL");
		await exited.catch(() => {});
		throw error;
	}
}

const ownershipSchema = z.object({
	schemaVersion: z.literal(1),
	experimentId: z.string(),
	sourceCommonDirectory: z.string(),
});
export async function createOwnedExperimentRoot(path: string, sourceCommonDirectory: string) {
	await assertNoSymlinkAncestors(path);
	if (isWithin(sourceCommonDirectory, path)) throw new Error("实验根不能位于生产 Git 元数据内");
	await mkdir(path, { mode: 0o700 });
	const marker = { schemaVersion: 1 as const, experimentId: randomUUID(), sourceCommonDirectory };
	await writeDurableJson(join(path, "experiment-ownership.json"), marker);
	return marker;
}

export async function assertOwnedExperimentRoot(root: string, target: string) {
	await assertNoSymlinkAncestors(root);
	const marker = ownershipSchema.parse(await readJson(join(root, "experiment-ownership.json")));
	if (!isWithin(root, target) || resolve(root) === resolve(target) || isWithin(marker.sourceCommonDirectory, target))
		throw new Error("副作用目标不在独立实验所有权范围内");
	await assertNoSymlinkAncestors(target);
	return marker;
}

export async function assertIndependentGitRepository(root: string, repository: string) {
	const marker = await assertOwnedExperimentRoot(root, repository);
	const common = (await executeGit(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
		.toString()
		.trim();
	if (!isWithin(root, await realpath(common)) || common === marker.sourceCommonDirectory)
		throw new Error("实验仓库仍连接生产对象库");
	try {
		await stat(join(common, "objects/info/alternates"));
		throw new Error("实验仓库不能依赖 alternates");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if ((await executeGit(repository, ["remote"])).toString().trim()) throw new Error("实验仓库不能配置远端");
	return common;
}

/** 同一持久操作只允许一个执行者；退出后的下一次接续先读取原操作回执。 */
export async function withExperimentOperationLease<T>(
	root: string,
	operationDirectory: string,
	perform: () => Promise<T>,
): Promise<T> {
	await assertOwnedExperimentRoot(root, operationDirectory);
	await createPrivateDirectory(operationDirectory);
	const release = await lockfile.lock(operationDirectory, { stale: 120_000, update: 10_000, retries: 0 });
	try {
		return await perform();
	} finally {
		await release();
	}
}

export async function fingerprintFile(path: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
