import { readFile, realpath, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fingerprint } from "./experiment-contract";
import { createMacosExperimentSandboxProfile } from "./macos-experiment-process-isolation";
import {
	assertOwnedExperimentRoot,
	createPrivateDirectory,
	isWithin,
	withExperimentOperationLease,
	writeDurableJson,
} from "./persistent-experiment-storage";

function assertDedicatedRuntimePort(runtimePort: number, protectedRuntimePort: number) {
	if (!Number.isInteger(runtimePort) || runtimePort < 1024 || runtimePort > 65535)
		throw new Error("隔离 runtime 必须使用有效的非特权端口");
	if (!Number.isInteger(protectedRuntimePort) || protectedRuntimePort < 1 || protectedRuntimePort > 65535)
		throw new Error("必须明确日常 runtime 的受保护端口");
	if (runtimePort === protectedRuntimePort) throw new Error("隔离 runtime 不能复用日常 runtime 端口");
}

export function createIsolatedKanbanRuntimeEnvironment(
	instanceDirectory: string,
	runtimePort: number,
	protectedRuntimePort: number,
): NodeJS.ProcessEnv {
	assertDedicatedRuntimePort(runtimePort, protectedRuntimePort);
	if (!isAbsolute(instanceDirectory)) throw new Error("隔离实例必须使用绝对持久路径");
	const home = join(instanceDirectory, "runtime-home");
	const temporaryDirectory = join(instanceDirectory, "runtime-temporary-files");
	// 原分析器会禁用 Git hooks；正常 Task 使用独立 Git 配置，保留其普通提交检查。
	return {
		PATH: [join(instanceDirectory, "runtime-executables"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
		LANG: "en_US.UTF-8",
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, "xdg-config"),
		XDG_CACHE_HOME: join(home, "xdg-cache"),
		XDG_DATA_HOME: join(home, "xdg-user-storage"),
		XDG_STATE_HOME: join(home, "xdg-persistent-state"),
		TMPDIR: temporaryDirectory,
		TMP: temporaryDirectory,
		TEMP: temporaryDirectory,
		CODEX_HOME: join(home, ".codex"),
		CODEX_SQLITE_HOME: join(home, ".codex"),
		KANBAN_RUNTIME_HOST: "127.0.0.1",
		KANBAN_RUNTIME_PORT: String(runtimePort),
		KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT: join(home, ".cline", "kanban", "relation-ledger"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "file",
		NO_PROXY: "*",
		no_proxy: "*",
	};
}

export function createIsolatedKanbanRuntimeSandboxProfile(input: {
	instanceDirectory: string;
	runtimePort: number;
	protectedRuntimePort: number;
	executablePaths: string[];
	privateNativeControlRendezvousPaths?: string[];
}) {
	assertDedicatedRuntimePort(input.runtimePort, input.protectedRuntimePort);
	if (!isAbsolute(input.instanceDirectory)) throw new Error("隔离实例必须使用绝对持久路径");
	const profile = createMacosExperimentSandboxProfile(input.instanceDirectory, input.executablePaths);
	const nativeDaemonDirectory = join("/private/tmp", `codex-daemon-${userInfo().uid}`);
	const nativeControlRules = (input.privateNativeControlRendezvousPaths ?? []).map((path) => {
		if (!isAbsolute(path) || !isWithin(input.instanceDirectory, path))
			throw new Error("原生控制 rendezvous 必须属于本实例的真实目录");
		// Codex 0.166.0 按真实 rendezvous 路径计算物理 socket；只授权本实例的精确文件。
		const socket = join(nativeDaemonDirectory, fingerprint(path));
		return (
			`(allow file-read* file-write* (literal ${JSON.stringify(socket)}) (literal ${JSON.stringify(`${socket}.lock`)}))\n` +
			`(allow network-bind network-inbound network-outbound (literal ${JSON.stringify(socket)}))\n`
		);
	});
	return (
		profile.replace(
			"(allow process* sysctl-read mach-lookup ipc-posix* system-socket)",
			"(allow process-exec process-fork sysctl-read mach-lookup ipc-posix* system-socket)\n" +
				"(allow signal (target same-sandbox))",
		) +
		// 原生 TUI 需要分配 PTY 并打开从设备；普通文件写入范围仍由实例目录约束。
		`(allow pseudo-tty)\n` +
		`(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))\n` +
		`(allow network-bind network-inbound (local tcp "localhost:${input.runtimePort}"))\n` +
		`(allow network-outbound (remote tcp "localhost:${input.runtimePort}"))\n` +
		`(allow network-bind network-inbound network-outbound (subpath ${JSON.stringify(resolve(input.instanceDirectory))}))\n` +
		(nativeControlRules.length
			? `(allow file-write-create (literal ${JSON.stringify(nativeDaemonDirectory)}))\n${nativeControlRules.join("")}`
			: "")
	);
}

export async function prepareIsolatedKanbanRuntimeBoundary(input: {
	ownedRootDirectory: string;
	instanceDirectory: string;
	runtimePort: number;
	protectedRuntimePort: number;
	executablePaths: string[];
	privateHomeDirectoryPathAlias?: string;
	plannedNativeCodexConversationSessions?: { workspaceId: string; conversationSessionId: string }[];
}) {
	if (process.platform !== "darwin") throw new Error("隔离 runtime 尚仅支持经过实际验证的 macOS 进程边界");
	const instanceDirectory = resolve(input.instanceDirectory);
	const ownership = await assertOwnedExperimentRoot(input.ownedRootDirectory, instanceDirectory);
	const environment = createIsolatedKanbanRuntimeEnvironment(
		instanceDirectory,
		input.runtimePort,
		input.protectedRuntimePort,
	);
	for (const directory of [
		instanceDirectory,
		join(instanceDirectory, "runtime-home"),
		join(instanceDirectory, "runtime-temporary-files"),
		join(instanceDirectory, "runtime-executables"),
	])
		await createPrivateDirectory(directory);
	if (input.privateHomeDirectoryPathAlias) {
		if (
			!isAbsolute(input.privateHomeDirectoryPathAlias) ||
			(await realpath(input.privateHomeDirectoryPathAlias)) !==
				(await realpath(join(instanceDirectory, "runtime-home")))
		)
			throw new Error("私有 HOME 别名必须准确指向本实例的 runtime-home");
		environment.HOME = input.privateHomeDirectoryPathAlias;
		environment.USERPROFILE = input.privateHomeDirectoryPathAlias;
	}
	const privateNativeControlRendezvousPaths: string[] = [];
	if (input.plannedNativeCodexConversationSessions?.length) {
		const mappings: Record<string, string> = {};
		for (const session of input.plannedNativeCodexConversationSessions) {
			if (!session.workspaceId.trim() || !session.conversationSessionId.trim())
				throw new Error("原生会话身份不能为空");
			const scopedKey = JSON.stringify([session.workspaceId, session.conversationSessionId]);
			if (Object.hasOwn(mappings, scopedKey)) throw new Error("原生会话身份不能重复登记");
			const socketPath = join(
				environment.HOME ?? "",
				".cline/kanban/native-control",
				fingerprint(scopedKey).slice(0, 16),
				"rpc.sock",
			);
			if (Buffer.byteLength(socketPath) > 103) throw new Error("原生控制路径过长，需先准备本实例的短 HOME 别名");
			const physicalPath = join(
				instanceDirectory,
				"runtime-home/.cline/kanban/native-control",
				fingerprint(scopedKey).slice(0, 16),
				"rpc.sock",
			);
			await assertOwnedExperimentRoot(input.ownedRootDirectory, physicalPath);
			await createPrivateDirectory(dirname(physicalPath));
			mappings[scopedKey] = socketPath;
			privateNativeControlRendezvousPaths.push(join(await realpath(dirname(physicalPath)), "rpc.sock"));
		}
		if (new Set(privateNativeControlRendezvousPaths).size !== privateNativeControlRendezvousPaths.length)
			throw new Error("不同原生会话不能共享控制路径");
		environment.KANBAN_CODEX_SESSION_CONTROL_SOCKET_PATHS_BY_SCOPED_SESSION_KEY = JSON.stringify(mappings);
	}
	return withExperimentOperationLease(input.ownedRootDirectory, instanceDirectory, async () => {
		const profilePath = join(instanceDirectory, "runtime-process-boundary.sb");
		const profile = createIsolatedKanbanRuntimeSandboxProfile({
			...input,
			instanceDirectory,
			privateNativeControlRendezvousPaths,
		});
		try {
			await writeFile(profilePath, profile, { mode: 0o600, flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if ((await readFile(profilePath, "utf8")) !== profile) throw new Error("既有 runtime 进程边界发生漂移");
		}
		// Cookie 不按端口区分；每份实例的 hostname 唯一，端口复用也不会继承上一轮浏览器状态。
		const browserIdentity = fingerprint(`${ownership.experimentId}\n${instanceDirectory}`).slice(0, 24);
		const browserOrigin = `http://workspace-${browserIdentity}.localhost:${input.runtimePort}`;
		const receipt = {
			schemaVersion: 1,
			status: "isolated-runtime-boundary-prepared-not-yet-validated",
			instanceDirectory,
			runtimePort: input.runtimePort,
			protectedRuntimePort: input.protectedRuntimePort,
			browserOrigin,
			profilePath,
			environment,
			privateHomeDirectoryPathAlias: input.privateHomeDirectoryPathAlias ?? null,
			...(privateNativeControlRendezvousPaths.length ? { privateNativeControlRendezvousPaths } : {}),
			additionalRuntimeArguments: ["--additional-trusted-browser-origin", browserOrigin],
		};
		const receiptPath = join(instanceDirectory, "runtime-process-boundary-preparation.json");
		try {
			if (!isDeepStrictEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt))
				throw new Error("不能以不同参数覆盖既有 runtime 边界登记");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await writeDurableJson(receiptPath, receipt);
		}
		return receipt;
	});
}
