import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import ora, { type Ora } from "ora";
import packageJson from "../package.json" with { type: "json" };
import { registerCodexConversationStorageCommand } from "./commands/codex-conversation-storage";
import { registerDeploymentCommand } from "./commands/deployment";
import { registerDiagnosticsCommand } from "./commands/diagnostics";
import { registerExploratoryCommand } from "./commands/exploratory";
import { registerHooksCommand } from "./commands/hooks";
import { registerRuntimeCommand } from "./commands/runtime";
import { registerSupportCommand } from "./commands/support";
import { registerTaskCommand } from "./commands/task";
import { registerVerificationCommand } from "./commands/verification";
import { registerWorkUnitCommand } from "./commands/work-unit";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config";
import type { RuntimeAgentSessionCountsAffectedByRuntimeExit, RuntimeCommandRunResponse } from "./core/api-contract";
import {
	DEFAULT_CLI_TELEMETRY_FLUSH_MS,
	installCliFatalErrorHandlers,
	installCliHardTimeoutIfNeeded,
	installCliTaskGroupWatchInterruptionGuard,
	registerCliFatalErrorReporter,
	registerCliProcessExit,
	safeErrorMessage,
} from "./core/cli-process-guards";
import { createGitProcessEnv } from "./core/git-process-env";
import {
	installGracefulShutdownHandlers,
	shouldSuppressImmediateDuplicateShutdownSignals,
} from "./core/graceful-shutdown";
import { resolveKanbanRuntimeHandoverRestartInProgressMarkerPath } from "./core/kanban-runtime-handover-restart-in-progress-marker";
import {
	buildKanbanRuntimeUrl,
	clearKanbanRuntimeTls,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getRuntimeFetch,
	isKanbanRemoteHost,
	parseKanbanAdditionalTrustedBrowserOrigin,
	parseRuntimePort,
	setKanbanAdditionalTrustedBrowserOrigins,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
	setKanbanRuntimeTls,
} from "./core/runtime-endpoint";
import {
	canAcceptPlannedHandoverRestartSignalWithoutInterruptingAgentSessions,
	KANBAN_RUNTIME_SHUTDOWN_SIGNAL_DISPOSITION_FOR_HOSTED_AGENT_SESSIONS_ENVIRONMENT_VARIABLE_NAME,
	type RuntimeShutdownTrigger,
	resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger,
	resolveRuntimeShutdownDeadlineMilliseconds,
} from "./core/runtime-shutdown-trigger";
import { resolveSessionFacets } from "./core/session-activity";
import { disablePasscode, generateInternalToken, generatePasscode } from "./security/passcode-manager";
import { terminateProcessForTimeout } from "./server/process-termination";
import type { RuntimeExitRequestHandler } from "./server/runtime-server";
import type { RuntimeStateHub } from "./server/runtime-state-hub";
import { getRuntimeHomePath } from "./state/runtime-home-path";
import { captureNodeException, flushNodeTelemetry } from "./telemetry/sentry-node.js";
import type { TerminalSessionManager } from "./terminal/session-manager";
import { runOnDemandUpdate } from "./update/update";

registerCliProcessExit((code) => process.exit(code));
registerCliFatalErrorReporter((error) => {
	captureNodeException(error, { area: "fatal" });
});
installCliFatalErrorHandlers();

interface CliOptions {
	noOpen: boolean;
	host: string | null;
	port: { mode: "fixed"; value: number } | { mode: "auto" } | null;
	https: boolean;
	cert: string | null;
	key: string | null;
	noPasscode: boolean;
	additionalTrustedBrowserOrigins: string[];
}

const KANBAN_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

function parseCliPortValue(rawValue: string): { mode: "fixed"; value: number } | { mode: "auto" } {
	const normalized = rawValue.trim().toLowerCase();
	if (!normalized) {
		throw new Error("Missing value for --port.");
	}
	if (normalized === "auto") {
		return { mode: "auto" };
	}
	try {
		return { mode: "fixed", value: parseRuntimePort(normalized) };
	} catch {
		throw new Error(`Invalid port value: ${rawValue}. Expected an integer from 1-65535 or "auto".`);
	}
}

interface RootCommandOptions {
	host?: string;
	port?: { mode: "fixed"; value: number } | { mode: "auto" };
	open?: boolean;
	update?: boolean;
	https?: boolean;
	cert?: string;
	key?: string;
	noPasscode?: boolean;
	additionalTrustedBrowserOrigin?: string[];
}

type ShutdownIndicatorResult = "done" | "interrupted" | "failed";

interface ShutdownIndicator {
	start: () => void;
	stop: (result?: ShutdownIndicatorResult) => void;
}

/**
 * Decide whether this CLI invocation should auto-open a browser tab.
 *
 * This uses a positive allowlist for app-launch shapes like `kanban`,
 * `kanban --agent codex`, and `kanban --port 3484`. Any subcommand or
 * unexpected argument is treated as a command-style invocation instead.
 */
function shouldAutoOpenBrowserTabForInvocation(argv: string[]): boolean {
	const launchFlags = new Set(["--open", "--no-open", "--skip-shutdown-cleanup", "--https", "--no-passcode"]);
	const launchOptionsWithValues = new Set([
		"--host",
		"--port",
		"--agent",
		"--cert",
		"--key",
		"--additional-trusted-browser-origin",
	]);

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (!arg.startsWith("-")) {
			return false;
		}
		if (launchFlags.has(arg)) {
			continue;
		}
		const optionName = arg.split("=", 1)[0] ?? arg;
		if (!launchOptionsWithValues.has(optionName)) {
			return false;
		}
		if (arg.includes("=")) {
			continue;
		}
		const optionValue = argv[index + 1];
		if (!optionValue) {
			return false;
		}
		index += 1;
	}

	return true;
}

function createShutdownIndicator(stream: NodeJS.WriteStream = process.stderr): ShutdownIndicator {
	let spinner: Ora | null = null;
	let running = false;

	return {
		start() {
			if (running) {
				return;
			}
			running = true;
			if (!stream.isTTY) {
				stream.write("Cleaning up...\n");
				return;
			}
			spinner = ora({
				text: "Cleaning up...",
				stream,
			}).start();
		},
		stop(result = "done") {
			if (!running) {
				return;
			}
			running = false;
			if (spinner) {
				if (result === "done") {
					spinner.succeed("Cleaning up... done");
				} else if (result === "failed") {
					spinner.fail("Cleaning up... failed");
				} else {
					spinner.warn("Cleaning up... interrupted");
				}
				spinner = null;
				return;
			}

			const suffix = result === "done" ? "done" : result === "interrupted" ? "interrupted" : "failed";
			stream.write(`Cleanup ${suffix}.\n`);
		},
	};
}

async function isPortAvailable(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => {
			resolve(false);
		});
		probe.listen(port, getKanbanRuntimeHost(), () => {
			probe.close(() => {
				resolve(true);
			});
		});
	});
}

async function findAvailableRuntimePort(startPort: number): Promise<number> {
	for (let candidate = startPort; candidate <= 65535; candidate += 1) {
		if (await isPortAvailable(candidate)) {
			return candidate;
		}
	}
	throw new Error("No available runtime port found.");
}

async function applyRuntimePortOption(portOption: CliOptions["port"]): Promise<number | null> {
	if (!portOption) {
		return null;
	}
	if (portOption.mode === "fixed") {
		setKanbanRuntimePort(portOption.value);
		return portOption.value;
	}
	const autoPort = await findAvailableRuntimePort(DEFAULT_KANBAN_RUNTIME_PORT);
	setKanbanRuntimePort(autoPort);
	return autoPort;
}

type TlsResult = { enabled: false } | { enabled: true };

async function resolveRuntimeTls(options: CliOptions): Promise<TlsResult> {
	const wantsHttps = options.https || options.cert !== null || options.key !== null;
	if (!wantsHttps) {
		clearKanbanRuntimeTls();
		return { enabled: false };
	}
	if (!options.cert || !options.key) {
		throw new Error("HTTPS requires both --cert and --key. Use plain HTTP if you do not have a TLS certificate.");
	}
	const cert = readFileSync(resolve(options.cert), "utf8");
	const key = readFileSync(resolve(options.key), "utf8");
	// Trust the exact configured cert for Kanban's own subcommands without
	// disabling certificate validation for unrelated HTTPS endpoints.
	setKanbanRuntimeTls({ cert, key, ca: cert });
	return { enabled: true };
}

async function assertPathIsDirectory(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isDirectory()) {
		throw new Error(`Project path is not a directory: ${path}`);
	}
}

function hasGitRepository(path: string): boolean {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: path,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	return result.status === 0 && result.stdout.trim() === "true";
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "EADDRINUSE"
	);
}

async function canReachKanbanServer(workspaceId: string | null): Promise<boolean> {
	try {
		const headers: Record<string, string> = {};
		if (workspaceId) {
			headers["x-kanban-workspace-id"] = workspaceId;
		}
		const runtimeFetch = await getRuntimeFetch();
		const response = await runtimeFetch(buildKanbanRuntimeUrl("/api/trpc/projects.list"), {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(1_500),
		});
		if (response.status === 404) {
			return false;
		}
		const payload = (await response.json().catch(() => null)) as {
			result?: { data?: unknown };
			error?: unknown;
		} | null;
		return Boolean(payload && (payload.result || payload.error));
	} catch {
		return false;
	}
}

async function tryOpenExistingServer(options: { noOpen: boolean; shouldAutoOpenBrowser: boolean }): Promise<boolean> {
	// 先识别服务，再读取或登记 cwd；重复启动不进入运行时初始化。
	if (!(await canReachKanbanServer(null))) return false;
	let workspaceId: string | null = null;
	if (hasGitRepository(process.cwd())) {
		const { loadWorkspaceContext } = await import("./state/workspace-state.js");
		const context = await loadWorkspaceContext(process.cwd());
		workspaceId = context.workspaceId;
	}
	const projectUrl = workspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(workspaceId)}`)
		: getKanbanRuntimeOrigin();
	console.log(`Kanban already running at ${getKanbanRuntimeOrigin()}`);
	if (!options.noOpen && options.shouldAutoOpenBrowser) {
		try {
			const { openInBrowser } = await import("./server/browser.js");
			openInBrowser(projectUrl, {
				warn: (message) => {
					console.warn(message);
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Could not open browser automatically: ${message}`);
		}
	}
	console.log(`Project URL: ${projectUrl}`);
	return true;
}

async function runScopedCommand(command: string, cwd: string): Promise<RuntimeCommandRunResponse> {
	const startedAt = Date.now();
	const outputLimitBytes = 64 * 1024;

	return await new Promise<RuntimeCommandRunResponse>((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (!child.stdout || !child.stderr) {
			reject(new Error("Shortcut process did not expose stdout/stderr."));
			return;
		}

		let stdout = "";
		let stderr = "";

		const appendOutput = (current: string, chunk: string): string => {
			const next = current + chunk;
			if (next.length <= outputLimitBytes) {
				return next;
			}
			return next.slice(0, outputLimitBytes);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout = appendOutput(stdout, String(chunk));
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr = appendOutput(stderr, String(chunk));
		});

		child.on("error", (error) => {
			reject(error);
		});

		const timeout = setTimeout(() => {
			terminateProcessForTimeout(child);
		}, 60_000);

		child.on("close", (code) => {
			clearTimeout(timeout);
			const exitCode = typeof code === "number" ? code : 1;
			const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			resolve({
				exitCode,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				combinedOutput,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

async function startServer(startServerOptions: { runtimePortWasAutoSelected: boolean }): Promise<{
	url: string;
	close: () => Promise<void>;
	shutdown: (trigger: RuntimeShutdownTrigger) => Promise<{ detachedHostedAgentSessionCount: number }>;
	agentSessionPtyHostModeEnabled: boolean;
	countAgentSessionsAffectedByRuntimeExit: () => RuntimeAgentSessionCountsAffectedByRuntimeExit;
	bindRuntimeExitRequestHandler: (handler: RuntimeExitRequestHandler) => void;
}> {
	/*
		Server-only modules are loaded lazily because task-oriented subcommands like
		`kanban task create` and `kanban hooks ingest` do not need the runtime server.

		A regression in 25ba59f showed that eagerly importing the runtime stack here
		could leave the source CLI process alive after the command had already printed
		its JSON result. The issue first appeared after the native Cline SDK runtime
		was added to the server import graph. We have not yet isolated the deepest
		handle creator inside that graph, so we keep command-style subcommands on the
		lightweight path and only load the server stack when we actually start Kanban.
	*/
	const [
		{ resolveProjectInputPath },
		{ pickDirectoryPathFromSystemDialog },
		{ createRuntimeServer },
		{ createRuntimeStateHub },
		{ resolveInteractiveShellCommand },
		{ runKanbanRuntimeExitSequence, removeKanbanRuntimeHandoverRestartInProgressMarkerAfterRuntimeListens },
		{ recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent },
		{ createWorkspaceRegistry },
		{ clearPendingUpdateNotification, getPendingUpdateNotification },
		{
			startAgentSessionPtyHostRuntimeFacadeWhenEnabled,
			setRuntimePtySessionOwnershipProvider,
			setNonPtyAgentSessionsPreventingContinuityProvider,
			notifyAgentSessionPtyHostDiagnosticsChanged,
		},
	] = await Promise.all([
		import("./projects/project-path.js"),
		import("./server/directory-picker.js"),
		import("./server/runtime-server.js"),
		import("./server/runtime-state-hub.js"),
		import("./server/shell.js"),
		import("./server/runtime-handover-restart-preserving-hosted-agent-sessions.js"),
		import("./server/agent-session-pty-host-orphan-reclamation-bookkeeping-after-runtime-restart.js"),
		import("./server/workspace-registry.js"),
		import("./update/update.js"),
		import("./agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-startup.js"),
	]);
	// 必须先于 workspace registry：registry 建 TerminalSessionManager 时就要拿到 hosted spawner。
	const agentSessionPtyHostRuntimeFacade = await startAgentSessionPtyHostRuntimeFacadeWhenEnabled({
		runtimePortWasAutoSelected: startServerOptions.runtimePortWasAutoSelected,
		warn: (message) => {
			console.warn(`[kanban] ${message}`);
		},
	});
	let runtimeStateHub: RuntimeStateHub | undefined;
	const workspaceRegistry = await createWorkspaceRegistry({
		createHostedTerminalPtyProcessSpawnerForWorkspace: agentSessionPtyHostRuntimeFacade
			? (workspaceId, workspaceRepositoryPath) =>
					agentSessionPtyHostRuntimeFacade.createHostedTerminalPtyProcessSpawnerForWorkspace(
						workspaceId,
						workspaceRepositoryPath,
					)
			: undefined,
		takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace: agentSessionPtyHostRuntimeFacade
			? (workspaceId) =>
					agentSessionPtyHostRuntimeFacade.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace(workspaceId)
			: undefined,
		cwd: process.cwd(),
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository,
		onProjectAvailabilityUpdated: () => {
			void runtimeStateHub?.broadcastRuntimeProjectsUpdated(null);
		},
		onTerminalManagerReady: (workspaceId, manager) => {
			runtimeStateHub?.trackTerminalManager(workspaceId, manager);
			const processIdentityBySessionId = new Map<string, string>();
			manager.onSummary((summary) => {
				const identity = `${summary.pid}:${summary.startedAt}:${summary.runtimeSessionIncarnationId}`;
				if (processIdentityBySessionId.get(summary.taskId) === identity) return;
				processIdentityBySessionId.set(summary.taskId, identity);
				notifyAgentSessionPtyHostDiagnosticsChanged();
			});
		},
		listConversationTaskSessionSummariesForWorkspace: (workspaceId) =>
			runtimeStateHub?.listTrackedConversationTaskSessionSummaries(workspaceId) ?? [],
	});
	setRuntimePtySessionOwnershipProvider(() =>
		workspaceRegistry
			.listManagedWorkspaces()
			.flatMap(({ workspaceId, terminalManager }) =>
				terminalManager.listLivePtySessionProcessOwnership().map((session) => ({ ...session, workspaceId })),
			),
	);
	setNonPtyAgentSessionsPreventingContinuityProvider(() =>
		workspaceRegistry.listManagedWorkspaces().flatMap(({ workspaceId }) =>
			(runtimeStateHub?.listTrackedConversationTaskSessionSummaries(workspaceId) ?? []).flatMap((summary) => {
				if (!["starting", "live", "retrying"].includes(resolveSessionFacets(summary).liveness)) return [];
				const transport = summary.sessionTransport;
				if (transport !== "acp_stdio_subprocess" && transport !== "in_process_cline_sdk") return [];
				return [
					{
						workspaceId,
						conversationSessionId: summary.taskId,
						processId: summary.pid,
						sessionTransport: transport,
					},
				];
			}),
		),
	);
	runtimeStateHub = createRuntimeStateHub({
		workspaceRegistry,
	});
	const runtimeHub = runtimeStateHub;
	// 热重启接管必须在 listen（createRuntimeServer 内部）之前完成：浏览器若先连上，会看到「无活进程」的卡片并
	// 触发前端自动续跑，起出第二个 agent。逐个加载有会话等待接管的 workspace，加载即接管。
	if (agentSessionPtyHostRuntimeFacade) {
		for (const candidatesOfWorkspace of agentSessionPtyHostRuntimeFacade.listHostedTerminalPtySessionAdoptionCandidatesByWorkspace()) {
			if (
				candidatesOfWorkspace.adoptionCandidates.length === 0 ||
				candidatesOfWorkspace.workspaceRepositoryPath === null
			) {
				continue;
			}
			try {
				await workspaceRegistry.ensureTerminalManagerForWorkspace(
					candidatesOfWorkspace.workspaceId,
					candidatesOfWorkspace.workspaceRepositoryPath,
				);
			} catch (error) {
				console.warn(
					`[kanban] could not load workspace ${candidatesOfWorkspace.workspaceId} to adopt its running agent sessions: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		agentSessionPtyHostRuntimeFacade.warnAboutHostedSessionsNotAdoptedDuringStartup();
		// 必须先于回收调度器的第一次扫描（createRuntimeServer 里 listen 之后启动），见该函数注释。
		await recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent({
			reclaimedHostedSessions:
				agentSessionPtyHostRuntimeFacade.listHostedSessionsReclaimedByHostWhileRuntimeWasAbsentThatWereAdopted(),
			applyAgentSessionReclamationOutcomeToTerminalSessionSummary: (workspaceId, taskId, outcome) =>
				workspaceRegistry
					.getTerminalManagerForWorkspace(workspaceId)
					?.applyAgentSessionReclamationOutcome(taskId, outcome) ?? null,
			warn: (message) => {
				console.warn(`[kanban] ${message}`);
			},
		});
	}
	for (const { workspaceId, terminalManager } of workspaceRegistry.listManagedWorkspaces()) {
		runtimeHub.trackTerminalManager(workspaceId, terminalManager);
	}
	// runtime 退出类 tRPC 请求的执行方：runMainCommand 装好 graceful shutdown 之后才绑定。
	let runtimeExitRequestHandler: RuntimeExitRequestHandler | null = null;

	const disposeTrackedWorkspace = (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const disposed = workspaceRegistry.disposeWorkspace(workspaceId, {
			stopTerminalSessions: options?.stopTerminalSessions,
		});
		runtimeHub.disposeWorkspace(workspaceId);
		return disposed;
	};

	const runtimeServer = await createRuntimeServer({
		workspaceRegistry,
		runtimeStateHub: runtimeHub,
		readRuntimeExitRequestHandler: () => runtimeExitRequestHandler,
		agentSessionPtyHostHookSpool: agentSessionPtyHostRuntimeFacade
			? {
					bindSpooledHookIngestRequestApplier: (spooledHookIngestRequestApplier) =>
						agentSessionPtyHostRuntimeFacade.bindSpooledHookIngestRequestApplier(spooledHookIngestRequestApplier),
					drainPendingHookSpoolEntriesBeforeDirectHookIngest: (workspaceId, taskId) =>
						agentSessionPtyHostRuntimeFacade.drainPendingHookSpoolEntriesBeforeDirectHookIngest(
							workspaceId,
							taskId,
						),
					retryRetainedLifecycleEventsAfterAdmissionEvidenceChanges: (workspaceId, evidenceFingerprint) =>
						agentSessionPtyHostRuntimeFacade.retryRetainedLifecycleEventsAfterAdmissionEvidenceChanges(
							workspaceId,
							evidenceFingerprint,
						),
				}
			: undefined,
		warn: (message) => {
			console.warn(`[kanban] ${message}`);
		},
		ensureTerminalManagerForWorkspace: workspaceRegistry.ensureTerminalManagerForWorkspace,
		resolveInteractiveShellCommand,
		runCommand: runScopedCommand,
		resolveProjectInputPath,
		assertPathIsDirectory,
		hasGitRepository,
		disposeWorkspace: disposeTrackedWorkspace,
		pickDirectoryPathFromSystemDialog,
		getUpdateStatus: () => {
			const notification = getPendingUpdateNotification();
			if (!notification) {
				return {
					currentVersion: KANBAN_VERSION,
					latestVersion: null,
					updateAvailable: false,
					updateTiming: null,
					installCommand: null,
				};
			}
			return {
				currentVersion: notification.currentVersion,
				latestVersion: notification.latestVersion,
				updateAvailable: true,
				updateTiming: notification.updateTiming,
				installCommand: notification.installCommand,
			};
		},
		runUpdateNow: async () => {
			const result = await runOnDemandUpdate({
				currentVersion: KANBAN_VERSION,
			});
			if (
				result.status === "updated" ||
				result.status === "already_up_to_date" ||
				result.status === "cache_refreshed"
			) {
				// The pending notification is a one-shot signal recorded at startup.
				// Clearing it here prevents the modal from reappearing on page reload
				// after the user has already applied the update.
				clearPendingUpdateNotification();
			}
			return {
				status: result.status,
				currentVersion: result.currentVersion,
				latestVersion: result.latestVersion,
				message: result.message,
			};
		},
	});

	const handoverRestartInProgressMarkerPath = resolveKanbanRuntimeHandoverRestartInProgressMarkerPath({
		runtimeHomeDirectoryPath: getRuntimeHomePath(),
		runtimePort: getKanbanRuntimePort(),
	});
	// 已在监听：上一个 runtime 的 handover 窗口到此结束，CLI 写动词不必再等。
	removeKanbanRuntimeHandoverRestartInProgressMarkerAfterRuntimeListens(
		handoverRestartInProgressMarkerPath,
		(message) => {
			console.warn(`[kanban] ${message}`);
		},
	);

	const close = async () => {
		await runtimeServer.close();
	};

	const shutdown = async (trigger: RuntimeShutdownTrigger) =>
		await runKanbanRuntimeExitSequence({
			trigger,
			hostedAgentSessionDisposition: resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger(
				trigger,
				process.env[KANBAN_RUNTIME_SHUTDOWN_SIGNAL_DISPOSITION_FOR_HOSTED_AGENT_SESSIONS_ENVIRONMENT_VARIABLE_NAME],
			),
			agentSessionPtyHostRuntimeFacade,
			runtimeServer,
			listTerminalSessionManagers: () =>
				workspaceRegistry.listManagedWorkspaces().map(({ terminalManager }) => terminalManager),
			handoverRestartInProgressMarker: {
				markerPath: handoverRestartInProgressMarkerPath,
				marker: {
					handoverRestartStartedAtEpochMs: Date.now(),
					previousRuntimeProcessId: process.pid,
					runtimePort: getKanbanRuntimePort(),
				},
			},
			log: (message) => {
				console.log(`[kanban] ${message}`);
			},
			warn: (message) => {
				console.warn(`[kanban] ${message}`);
			},
		});

	return {
		url: runtimeServer.url,
		close,
		shutdown,
		agentSessionPtyHostModeEnabled: agentSessionPtyHostRuntimeFacade !== null,
		countAgentSessionsAffectedByRuntimeExit: runtimeServer.countAgentSessionsAffectedByRuntimeExit,
		bindRuntimeExitRequestHandler: (handler: RuntimeExitRequestHandler) => {
			runtimeExitRequestHandler = handler;
		},
	};
}

async function startServerWithAutoPortRetry(options: CliOptions): Promise<Awaited<ReturnType<typeof startServer>>> {
	const runtimePortWasAutoSelected = options.port?.mode === "auto";
	if (!runtimePortWasAutoSelected) {
		return await startServer({ runtimePortWasAutoSelected });
	}

	while (true) {
		try {
			return await startServer({ runtimePortWasAutoSelected });
		} catch (error) {
			if (!isAddressInUseError(error)) {
				throw error;
			}
			const currentPort = getKanbanRuntimePort();
			const retryPort = await findAvailableRuntimePort(currentPort + 1);
			setKanbanRuntimePort(retryPort);
			console.warn(`Runtime port ${currentPort} became busy during startup, retrying on ${retryPort}.`);
		}
	}
}

let runtimeServerStartedByThisInvocation = false;

async function runMainCommand(options: CliOptions, shouldAutoOpenBrowser: boolean): Promise<void> {
	if (options.host) {
		setKanbanRuntimeHost(options.host);
		console.log(`Binding to host ${options.host}.`);
	}
	if (options.additionalTrustedBrowserOrigins.length > 0) {
		setKanbanAdditionalTrustedBrowserOrigins(options.additionalTrustedBrowserOrigins);
		console.log(`Also trusting browser origins: ${options.additionalTrustedBrowserOrigins.join(", ")}.`);
	}

	const [{ openInBrowser }, { autoUpdateOnStartup, runPendingAutoUpdateOnShutdown }] = await Promise.all([
		import("./server/browser.js"),
		import("./update/update.js"),
	]);

	const selectedPort = await applyRuntimePortOption(options.port);
	if (selectedPort !== null) {
		console.log(`Using runtime port ${selectedPort}.`);
	}

	const tlsResult = await resolveRuntimeTls(options);
	if (tlsResult.enabled) {
		console.log(`HTTPS enabled on ${getKanbanRuntimeOrigin()}`);
	}

	if (
		options.port?.mode !== "auto" &&
		(await tryOpenExistingServer({ noOpen: options.noOpen, shouldAutoOpenBrowser }))
	) {
		return;
	}

	// Handle passcode generation for remote mode — deferred until after TLS
	// validation so that an invalid --cert/--key fails before a passcode is
	// printed (a passcode for a server that never starts is confusing).
	if (isKanbanRemoteHost()) {
		if (options.noPasscode) {
			disablePasscode();
			console.log("Passcode authentication disabled (--no-passcode). Ensure you have your own auth layer.");
		} else {
			const passcode = generatePasscode();
			generateInternalToken();
			// NOTE: passcode is printed ONLY here and never stored in logs or env.
			console.log(`\n🔐 Remote access passcode: ${passcode}\n\nShare this with users who need access.\n`);
		}
	}

	autoUpdateOnStartup({
		currentVersion: KANBAN_VERSION,
	});

	let runtime: Awaited<ReturnType<typeof startServer>>;
	try {
		runtime = await startServerWithAutoPortRetry(options);
	} catch (error) {
		if (
			options.port?.mode !== "auto" &&
			isAddressInUseError(error) &&
			(await tryOpenExistingServer({ noOpen: options.noOpen, shouldAutoOpenBrowser }))
		) {
			return;
		}
		throw error;
	}
	runtimeServerStartedByThisInvocation = true;
	console.log(`Cline Kanban running at ${runtime.url}`);
	if (!options.noOpen && shouldAutoOpenBrowser) {
		try {
			openInBrowser(runtime.url, {
				warn: (message) => {
					console.warn(message);
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Could not open browser automatically: ${message}`);
		}
	}
	console.log("Press Ctrl+C to stop.");

	let isShuttingDown = false;
	// tRPC 请求的退出已受理、但还没真正开始（先让响应发出去）：此时再来的请求按「已在退出中」答复。
	let runtimeShutdownRequestedOverApi = false;
	const shutdownIndicator = createShutdownIndicator();
	const shutdown = async (trigger: RuntimeShutdownTrigger) => {
		if (isShuttingDown) {
			return;
		}
		isShuttingDown = true;
		runPendingAutoUpdateOnShutdown();
		const exitOutcome = await runtime.shutdown(trigger);
		printHostedAgentSessionsLeftRunningAfterRuntimeExit(trigger, exitOutcome.detachedHostedAgentSessionCount);
	};

	const gracefulShutdown = installGracefulShutdownHandlers({
		process,
		delayMs: 10000,
		resolveShutdownDeadlineMs: resolveRuntimeShutdownDeadlineMilliseconds,
		exit: (code) => {
			process.exit(code);
		},
		reraiseSignal: (signal) => {
			process.kill(process.pid, signal);
		},
		// 每次信号都重读活体计数：host 模式开启仍可能存在降级 PTY / ACP 等随 runtime 结束的会话。
		acceptPlannedHandoverRestartSignal: () =>
			canAcceptPlannedHandoverRestartSignalWithoutInterruptingAgentSessions({
				agentSessionPtyHostModeEnabled: runtime.agentSessionPtyHostModeEnabled,
				agentSessionCountsAffectedByRuntimeExit: runtime.countAgentSessionsAffectedByRuntimeExit(),
			}),
		onPlannedHandoverRestartSignalIgnored: () => {
			const counts = runtime.countAgentSessionsAffectedByRuntimeExit();
			console.warn(
				`[kanban] 已忽略 SIGUSR2 热重启：PTY host 模式${runtime.agentSessionPtyHostModeEnabled ? "已启用" : "未启用"}；仍有 ${counts.agentSessionsWithPtyOwnedByRuntimeProcess} 条 runtime-owned PTY 会话和 ${counts.conversationAgentSessionsRunningInsideRuntimeProcess} 条进程内对话会话，无法保证全部保活。如需明确允许打断这些会话，请通过 tRPC 命令 kanban runtime handover-restart --allow-interrupting-agent-sessions-not-preserved-by-agent-session-pty-host 请求重启。`,
			);
		},
		onShutdown: async (trigger) => {
			shutdownIndicator.start();
			try {
				await shutdown(trigger);
				shutdownIndicator.stop("done");
			} catch (error) {
				shutdownIndicator.stop("failed");
				throw error;
			}
		},
		onShutdownError: (error) => {
			shutdownIndicator.stop("failed");
			captureNodeException(error, { area: "shutdown" });
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Shutdown failed: ${message}`);
		},
		onTimeout: (delayMs) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit after shutdown timeout (${delayMs}ms).`);
		},
		onSecondSignal: (signal) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit on second signal: ${signal}`);
		},
		suppressImmediateDuplicateSignals: shouldSuppressImmediateDuplicateShutdownSignals(),
	});
	runtime.bindRuntimeExitRequestHandler({
		agentSessionPtyHostModeEnabled: runtime.agentSessionPtyHostModeEnabled,
		isRuntimeShutdownInProgress: () => isShuttingDown || runtimeShutdownRequestedOverApi,
		startRuntimeShutdownAfterResponseIsSent: (trigger) => {
			runtimeShutdownRequestedOverApi = true;
			setImmediate(() => {
				gracefulShutdown.requestShutdown(trigger);
			});
		},
	});
}

// 护栏：runtime 停了、agent 还在跑——说清楚还有几个、谁会接管、怎么全停。
function printHostedAgentSessionsLeftRunningAfterRuntimeExit(
	trigger: RuntimeShutdownTrigger,
	detachedHostedAgentSessionCount: number,
): void {
	if (detachedHostedAgentSessionCount === 0) {
		return;
	}
	if (trigger.kind === "planned_handover_restart_preserving_hosted_agent_sessions") {
		console.log(
			`Handed ${detachedHostedAgentSessionCount} agent session(s) over to the next Kanban runtime; they keep running in the agent session pty host.`,
		);
		return;
	}
	console.log(
		`${detachedHostedAgentSessionCount} agent session(s) keep running in the agent session pty host and will be adopted when Kanban starts again on port ${getKanbanRuntimePort()}. To end them as well, run: KANBAN_RUNTIME_PORT=${getKanbanRuntimePort()} kanban runtime stop --terminate-hosted-agent-sessions`,
	);
}

async function runUpdateCommand(): Promise<void> {
	const result = await runOnDemandUpdate({
		currentVersion: KANBAN_VERSION,
	});

	if (result.status === "updated" || result.status === "already_up_to_date" || result.status === "cache_refreshed") {
		console.log(result.message);
		return;
	}

	throw new Error(result.message);
}

function createProgram(invocationArgs: string[]): Command {
	const shouldAutoOpenBrowser = shouldAutoOpenBrowserTabForInvocation(invocationArgs);
	const program = new Command();
	program
		.name("kanban")
		.description("Local orchestration board for coding agents.")
		.version(KANBAN_VERSION, "-v, --version", "Output the version number")
		.option("--host <ip>", "Host IP to bind the server to (default: 127.0.0.1).")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortValue)
		.option("--no-open", "Do not open browser automatically.")
		.option("--https", "Enable HTTPS. Requires both --cert and --key.")
		.option("--cert <path>", "Path to a TLS certificate PEM file (implies HTTPS).")
		.option("--key <path>", "Path to a TLS private key PEM file (implies HTTPS).")
		.option("--update", "Update Kanban to the latest published version and exit.")
		.option(
			"--no-passcode",
			"Disable auto-generated passcode for remote access (for advanced users behind a reverse proxy).",
		)
		.option(
			"--additional-trusted-browser-origin <origin>",
			"Also accept browser requests from this origin, e.g. https://my-machine.tailnet-name.ts.net:3485 " +
				"when a reverse proxy such as `tailscale serve` forwards to this runtime. Repeatable.",
			(value: string, previous: string[] = []) => {
				parseKanbanAdditionalTrustedBrowserOrigin(value);
				return [...previous, value];
			},
		)
		.showHelpAfterError()
		.addHelpText("after", `\nRuntime URL: ${getKanbanRuntimeOrigin()}`);

	program.addOption(new Option("--agent <id>", "Deprecated compatibility flag. Ignored.").hideHelp());
	program.addOption(
		new Option(
			"--skip-shutdown-cleanup",
			"Deprecated compatibility flag. Ignored because shutdown is non-destructive by default.",
		).hideHelp(),
	);

	registerTaskCommand(program);
	registerSupportCommand(program);
	registerWorkUnitCommand(program);
	registerHooksCommand(program);
	registerExploratoryCommand(program);
	registerDeploymentCommand(program);
	registerVerificationCommand(program);
	registerDiagnosticsCommand(program);
	registerCodexConversationStorageCommand(program);
	registerRuntimeCommand(program);

	program
		.command("mcp")
		.description("Deprecated compatibility command.")
		.action(() => {
			console.warn("Deprecated. Please uninstall Kanban MCP.");
		});

	program
		.command("update")
		.description("Update Kanban to the latest published version.")
		.action(async () => {
			await runUpdateCommand();
		});

	program.action(async (options: RootCommandOptions) => {
		if (options.update === true) {
			await runUpdateCommand();
			return;
		}
		await runMainCommand(
			{
				host: options.host ?? null,
				port: options.port ?? null,
				noOpen: options.open === false,
				https: options.https === true,
				cert: options.cert ?? null,
				key: options.key ?? null,
				noPasscode: options.noPasscode === true,
				additionalTrustedBrowserOrigins: options.additionalTrustedBrowserOrigin ?? [],
			},
			shouldAutoOpenBrowser,
		);
	});

	return program;
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	const isServerStyleInvocation = shouldAutoOpenBrowserTabForInvocation(argv);
	const cancelCliHardTimeout = installCliHardTimeoutIfNeeded(argv, isServerStyleInvocation);
	const watchInterruptionGuard = installCliTaskGroupWatchInterruptionGuard(argv);
	let invocationFailed = false;
	try {
		const program = createProgram(argv);
		await program.parseAsync(argv, { from: "user" });
	} catch (error) {
		invocationFailed = true;
		process.exitCode = 1;
		console.error(`Kanban 执行失败：${safeErrorMessage(error)}`);
		captureNodeException(error, { area: "startup" });
	} finally {
		if (!isServerStyleInvocation || invocationFailed || !runtimeServerStartedByThisInvocation) {
			await flushNodeTelemetry(DEFAULT_CLI_TELEMETRY_FLUSH_MS);
			// 空写回调在此前已排队的 JSON / 错误正文之后执行，避免 process.exit 截断 pipe 输出。
			await Promise.allSettled(
				[process.stdout, process.stderr].map(
					(stream) =>
						new Promise<void>((resolveFlush, rejectFlush) => {
							stream.write("", (error) => {
								if (error) rejectFlush(error);
								else resolveFlush();
							});
						}),
				),
			);
			const exitCode = watchInterruptionGuard?.signal.aborted
				? watchInterruptionGuard.signal.reason === "SIGTERM"
					? 143
					: 130
				: (process.exitCode ?? 0);
			watchInterruptionGuard?.dispose();
			cancelCliHardTimeout();
			process.exit(exitCode);
		}
	}
}

void run();
