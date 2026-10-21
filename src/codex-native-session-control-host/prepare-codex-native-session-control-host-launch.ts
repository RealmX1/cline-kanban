import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { codexNativeSessionControlEndpointSchema } from "../core/codex-native-session-control-endpoint-contract";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { CODEX_CLI_OPTIONS_WITH_VALUES } from "../terminal/codex-hook-config";
import {
	type CodexNativeSessionControlEndpoint,
	type CodexNativeSessionControlHostLaunchSpecification,
	codexNativeSessionControlHostLaunchSpecificationSchema,
	type OwnedCodexNativeSessionControlHostDirectory,
	removeOwnedCodexNativeSessionControlHostDirectories,
} from "./codex-native-session-control-host-launch-specification";
import { prepareCodexRemoteConversationLaunchPlan } from "./codex-remote-conversation-launch-plan";

const execFileAsync = promisify(execFile);
const FAILED_CODEX_CONTROL_HOST_CAPABILITY_PROBE_RETRY_DELAY_MS = 30_000;
interface CachedCodexControlHostCapabilityProbe {
	completion: Promise<boolean>;
	failedResultRetryAllowedAtMs?: number;
}
const capabilityProbes = new Map<string, CachedCodexControlHostCapabilityProbe>();

// 新建会话只复制配置层；恢复/fork 的权限由后续启动计划交给原生 RPC。
export function inspectCodexNativeSessionControlHostArguments(arguments_: readonly string[]) {
	const appServerRootArguments: string[] = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--") break;
		// app-server 不接受 profile；改写成 -c 还会改变 profile 与项目配置的优先级。
		// 此形态保留原生 TUI，不登记无法提供的本代控制端点。
		if (
			argument === "--remote" ||
			argument.startsWith("--remote=") ||
			argument === "--no-daemon" ||
			argument === "-p" ||
			argument === "--profile" ||
			argument.startsWith("--profile=") ||
			(argument.startsWith("-p") && argument.length > 2)
		)
			return { managesOwnHost: false, appServerRootArguments };
		if (["-c", "--config", "--enable", "--disable"].includes(argument)) {
			const value = arguments_[++index];
			if (value === undefined) throw new Error(`Codex ${argument} 缺少值。`);
			appServerRootArguments.push(argument, value);
		} else if (
			argument.startsWith("--config=") ||
			(argument.startsWith("-c") && argument.length > 2) ||
			argument.startsWith("--enable=") ||
			argument.startsWith("--disable=") ||
			argument === "--strict-config"
		) {
			appServerRootArguments.push(argument);
		} else if (CODEX_CLI_OPTIONS_WITH_VALUES.has(argument) || argument === "--remote-auth-token-env") {
			index += 1;
		}
	}
	return { managesOwnHost: true, appServerRootArguments };
}

async function supportsCodexUnixControlHost(binary: string, environment: NodeJS.ProcessEnv) {
	const key = JSON.stringify([binary, environment.PATH]);
	let probe = capabilityProbes.get(key);
	if (
		!probe ||
		(probe.failedResultRetryAllowedAtMs !== undefined && Date.now() >= probe.failedResultRetryAllowedAtMs)
	) {
		const completion = (async () => {
			try {
				const options = { env: environment, timeout: 5_000, maxBuffer: 128 * 1024 };
				const tui = await execFileAsync(binary, ["--help"], options);
				if (!tui.stdout.includes("--remote") || !tui.stdout.includes("unix://")) return false;
				const server = await execFileAsync(binary, ["app-server", "--help"], options);
				return server.stdout.includes("--listen") && server.stdout.includes("unix://");
			} catch {
				return false;
			}
		})();
		const cacheEntry: CachedCodexControlHostCapabilityProbe = { completion };
		// 失败仅冷却，不永久否定能力；到期后由下一次启动按需重试，在途探测仍共用一份。
		void completion.then((supported) => {
			if (!supported)
				cacheEntry.failedResultRetryAllowedAtMs =
					Date.now() + FAILED_CODEX_CONTROL_HOST_CAPABILITY_PROBE_RETRY_DELAY_MS;
		});
		probe = cacheEntry;
		capabilityProbes.set(key, probe);
	}
	return probe.completion;
}

export interface PreparedCodexNativeSessionControlHostLaunch {
	binary: string;
	args: string[];
	endpoint: CodexNativeSessionControlEndpoint;
	cleanup: () => Promise<void>;
}

export async function prepareCodexNativeSessionControlHostLaunch(input: {
	binary: string;
	arguments: readonly string[];
	workingDirectoryPath: string;
	environment: NodeJS.ProcessEnv;
	workspaceId: string;
	conversationSessionId: string;
	runtimeSessionIncarnationId: string;
}): Promise<PreparedCodexNativeSessionControlHostLaunch | null> {
	const inspected = inspectCodexNativeSessionControlHostArguments(input.arguments);
	if (
		process.platform === "win32" ||
		!inspected.managesOwnHost ||
		!(await supportsCodexUnixControlHost(input.binary, input.environment))
	)
		return null;
	const remoteConversationLaunchPlan = prepareCodexRemoteConversationLaunchPlan(
		input.arguments,
		input.workingDirectoryPath,
	);

	const endpointIdentity = codexNativeSessionControlEndpointSchema.omit({ socketPath: true }).parse({
		workspaceId: input.workspaceId,
		conversationSessionId: input.conversationSessionId,
		runtimeSessionIncarnationId: input.runtimeSessionIncarnationId,
	});
	const launchParentDirectory = join(getRuntimeHomePath(), "codex-native-session-control-host-launches");
	const launchDirectory = join(launchParentDirectory, endpointIdentity.runtimeSessionIncarnationId);
	const ownedDirectories: OwnedCodexNativeSessionControlHostDirectory[] = [];
	const cleanup = () => removeOwnedCodexNativeSessionControlHostDirectories([...ownedDirectories].reverse());
	const directoryIdentity = async (path: string) => {
		const metadata = await lstat(path, { bigint: true });
		return { path, device: `${metadata.dev}`, inode: `${metadata.ino}` };
	};
	try {
		await mkdir(launchParentDirectory, { recursive: true, mode: 0o700 });
		await mkdir(launchDirectory, { mode: 0o700 });
		const ownedLaunchDirectory = await directoryIdentity(launchDirectory);
		ownedDirectories.push(ownedLaunchDirectory);
		// socket 与进程同寿；长 TMPDIR 时改用短暂存路径，交接与配置仍在持久目录。
		const socketParent = Buffer.byteLength(join(tmpdir(), "kcc-XXXXXX", "s")) <= 103 ? tmpdir() : "/tmp";
		const socketDirectory = await mkdtemp(join(socketParent, "kcc-"));
		const ownedSocketDirectory = await directoryIdentity(socketDirectory);
		ownedDirectories.push(ownedSocketDirectory);
		const endpoint = { ...endpointIdentity, socketPath: join(socketDirectory, "s") };
		const specification: CodexNativeSessionControlHostLaunchSpecification = {
			schemaVersion: 1,
			endpoint,
			codexBinary: input.binary,
			codexTuiArguments: [...input.arguments],
			appServerRootArguments:
				remoteConversationLaunchPlan?.appServerRootArguments ?? inspected.appServerRootArguments,
			...(remoteConversationLaunchPlan ? { remoteConversationLaunchPlan } : {}),
			workingDirectoryPath: input.workingDirectoryPath,
			ownedLaunchDirectory,
			ownedSocketDirectory,
		};
		const specificationPath = join(launchDirectory, "launch-specification.json");
		await writeFile(specificationPath, JSON.stringify(specification), { mode: 0o600, flag: "wx" });
		const sourceMode = import.meta.url.endsWith(".ts");
		const runnerPath = fileURLToPath(
			new URL(
				sourceMode
					? "./codex-native-session-control-host-process-entry.ts"
					: "./codex-native-session-control-host.js",
				import.meta.url,
			),
		);
		return {
			binary: process.execPath,
			args: [
				...(sourceMode ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] : []),
				runnerPath,
				specificationPath,
			],
			endpoint,
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

// 闭包不能跨 runtime 存活；从本代持久描述重建目录所有权，供接管后的强杀路径兜底。
export async function restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart(
	endpoint: CodexNativeSessionControlEndpoint,
): Promise<(() => Promise<void>) | null> {
	const launchDirectory = join(
		getRuntimeHomePath(),
		"codex-native-session-control-host-launches",
		endpoint.runtimeSessionIncarnationId,
	);
	let specification: CodexNativeSessionControlHostLaunchSpecification;
	try {
		specification = codexNativeSessionControlHostLaunchSpecificationSchema.parse(
			JSON.parse(await readFile(join(launchDirectory, "launch-specification.json"), "utf8")),
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	if (
		specification.endpoint.socketPath !== endpoint.socketPath ||
		specification.endpoint.workspaceId !== endpoint.workspaceId ||
		specification.endpoint.conversationSessionId !== endpoint.conversationSessionId ||
		specification.endpoint.runtimeSessionIncarnationId !== endpoint.runtimeSessionIncarnationId ||
		specification.ownedLaunchDirectory.path !== launchDirectory ||
		specification.ownedSocketDirectory.path !== dirname(endpoint.socketPath)
	)
		throw new Error("接管端点与原生控制宿主目录所有权不匹配，保留现场等待核对。");
	return () =>
		removeOwnedCodexNativeSessionControlHostDirectories([
			specification.ownedSocketDirectory,
			specification.ownedLaunchDirectory,
		]);
}
