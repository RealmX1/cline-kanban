import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import {
	type AcpTaskSessionService,
	createAcpTaskSessionService,
} from "../acp-client-session/acp-task-session-service";
import { handleClineMcpOauthCallback } from "../cline-sdk/cline-mcp-runtime-service";
import {
	type ClineTaskSessionService,
	createInMemoryClineTaskSessionService,
} from "../cline-sdk/cline-task-session-service";
import { createClineWatcherRegistry } from "../cline-sdk/cline-watcher-registry";
import { isRuntimeAgentSessionDrivenByAcpProtocol } from "../core/agent-catalog";
import type {
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskSessionSummary,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimeTls,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";
import { startEventLoopDelayMonitor } from "../diagnostics/event-loop-delay-monitor";
import {
	checkRateLimit,
	clearRateLimit,
	extractBearerToken,
	extractSessionTokenFromCookie,
	isPasscodeEnabled,
	issueSession,
	recordFailedAttempt,
	validateInternalToken,
	validatePasscode,
	validateSession,
} from "../security/passcode-manager";
import { loadWorkspaceBoardById, loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createDeploymentApi } from "../trpc/deployment-api";
import { createHooksApi } from "../trpc/hooks-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createRuntimeApi } from "../trpc/runtime-api";
import { createWorkspaceApi } from "../trpc/workspace-api";
import {
	type ActiveRuntimeSessionShutdownResult,
	stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace,
} from "./active-runtime-session-shutdown";
import { createAgentSessionInactivityReclamationScheduler } from "./agent-session-inactivity-reclamation-scheduler";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import type { RuntimeStateHub } from "./runtime-state-hub";
import { createTransportAwareAgentSessionReclamationExecutor } from "./transport-aware-agent-session-reclamation";
import type { WorkspaceRegistry } from "./workspace-registry";

interface DisposeTrackedWorkspaceResult {
	terminalManager: TerminalSessionManager | null;
	workspacePath: string | null;
}

export interface CreateRuntimeServerDependencies {
	workspaceRegistry: WorkspaceRegistry;
	runtimeStateHub: RuntimeStateHub;
	warn: (message: string) => void;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeWorkspace: (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedWorkspaceResult;
	pickDirectoryPathFromSystemDialog: () => string | null;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
}

export interface RuntimeServer {
	url: string;
	stopAllActiveRuntimeSessionsForShutdown: () => Promise<
		Array<
			ActiveRuntimeSessionShutdownResult & {
				workspaceId: string;
				workspacePath: string | null;
			}
		>
	>;
	close: () => Promise<void>;
}

function readWorkspaceIdFromRequest(request: IncomingMessage, requestUrl: URL): string | null {
	const headerValue = request.headers["x-kanban-workspace-id"];
	const headerWorkspaceId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerWorkspaceId === "string") {
		const normalized = headerWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryWorkspaceId = requestUrl.searchParams.get("workspaceId");
	if (typeof queryWorkspaceId === "string") {
		const normalized = queryWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

export async function createRuntimeServer(deps: CreateRuntimeServerDependencies): Promise<RuntimeServer> {
	const webUiDir = getWebUiDir();

	try {
		await readFile(join(webUiDir, "index.html"));
	} catch {
		throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
	}

	const resolveWorkspaceScopeFromRequest = async (
		request: IncomingMessage,
		requestUrl: URL,
	): Promise<{
		requestedWorkspaceId: string | null;
		workspaceScope: RuntimeTrpcWorkspaceScope | null;
	}> => {
		const requestedWorkspaceId = readWorkspaceIdFromRequest(request, requestUrl);
		if (!requestedWorkspaceId) {
			return {
				requestedWorkspaceId: null,
				workspaceScope: null,
			};
		}
		const requestedWorkspaceContext = await loadWorkspaceContextById(requestedWorkspaceId);
		if (!requestedWorkspaceContext) {
			return {
				requestedWorkspaceId,
				workspaceScope: null,
			};
		}
		return {
			requestedWorkspaceId,
			workspaceScope: {
				workspaceId: requestedWorkspaceContext.workspaceId,
				workspacePath: requestedWorkspaceContext.repoPath,
			},
		};
	};

	const getScopedTerminalManager = async (scope: RuntimeTrpcWorkspaceScope): Promise<TerminalSessionManager> =>
		await deps.ensureTerminalManagerForWorkspace(scope.workspaceId, scope.workspacePath);
	// ACP（omp 等）会话按 workspace 作用域持有，与 Cline SDK 服务并列。
	const acpTaskSessionServiceByWorkspaceId = new Map<string, AcpTaskSessionService>();
	// 与 clineWorkspacePathByWorkspaceId 对位：关服 / 重置时要遍历「只跑过 ACP 会话」的 workspace，
	// 它们未必在 workspaceRegistry 或 Cline 的账本里出现过。
	const acpWorkspacePathByWorkspaceId = new Map<string, string>();
	const getScopedAcpTaskSessionService = async (scope: RuntimeTrpcWorkspaceScope): Promise<AcpTaskSessionService> => {
		let service = acpTaskSessionServiceByWorkspaceId.get(scope.workspaceId);
		if (!service) {
			service = createAcpTaskSessionService();
			acpTaskSessionServiceByWorkspaceId.set(scope.workspaceId, service);
			acpWorkspacePathByWorkspaceId.set(scope.workspaceId, scope.workspacePath);
			deps.runtimeStateHub.trackAcpTaskSessionService(scope.workspaceId, scope.workspacePath, service);
		}
		return service;
	};
	const disposeAcpTaskSessionService = (workspaceId: string): void => {
		const service = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		if (!service) {
			return;
		}
		acpTaskSessionServiceByWorkspaceId.delete(workspaceId);
		acpWorkspacePathByWorkspaceId.delete(workspaceId);
		service.disposeAllTaskSessions();
	};
	const clineTaskSessionServiceByWorkspaceId = new Map<string, ClineTaskSessionService>();
	const clineWorkspacePathByWorkspaceId = new Map<string, string>();
	const clineWatcherRegistry = createClineWatcherRegistry();
	const getScopedClineTaskSessionService = async (
		scope: RuntimeTrpcWorkspaceScope,
	): Promise<ClineTaskSessionService> => {
		let service = clineTaskSessionServiceByWorkspaceId.get(scope.workspaceId);
		if (!service) {
			service = createInMemoryClineTaskSessionService({
				watcherRegistry: clineWatcherRegistry,
			});
			clineTaskSessionServiceByWorkspaceId.set(scope.workspaceId, service);
			clineWorkspacePathByWorkspaceId.set(scope.workspaceId, scope.workspacePath);
			deps.runtimeStateHub.trackClineTaskSessionService(scope.workspaceId, scope.workspacePath, service);
		}
		return service;
	};
	const disposeClineTaskSessionServiceAsync = async (workspaceId: string): Promise<void> => {
		const service = clineTaskSessionServiceByWorkspaceId.get(workspaceId);
		if (!service) {
			return;
		}
		clineTaskSessionServiceByWorkspaceId.delete(workspaceId);
		clineWorkspacePathByWorkspaceId.delete(workspaceId);
		await service.dispose();
	};
	const listProjectRuntimeSessionSummaries = (workspaceId: string): RuntimeTaskSessionSummary[] => {
		const summariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
		for (const summary of terminalManager?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		const clineTaskSessionService = clineTaskSessionServiceByWorkspaceId.get(workspaceId);
		for (const summary of clineTaskSessionService?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		const acpTaskSessionService = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		for (const summary of acpTaskSessionService?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		return Array.from(summariesByTaskId.values());
	};
	// 「停止生成响应后固定宽限期」回收调度器。放在这里是因为三种 transport 的服务持有者都在本作用域：
	// listProjectRuntimeSessionSummaries 已经把三条 summary 流合并成一个查询面，正是陈旧定时器防护
	// 需要的「当前这个 task 的 summary 到底长什么样」。
	//
	// 回收是**真实生效**的：到期会真的终止进程 / 连接 / SDK 会话。安全性由三重防护保证——agent 回合
	// 永不计时、动手前双重比对（活体 id + 回合序号）、只回收 liveness==="live" 的会话；且回收只终止
	// 运行时，worktree / 未提交改动 / 提交 / 消息历史一律不动。
	const findRuntimeSessionSummary = (workspaceId: string, taskId: string): RuntimeTaskSessionSummary | null =>
		listProjectRuntimeSessionSummaries(workspaceId).find((summary) => summary.taskId === taskId) ?? null;
	const agentSessionInactivityReclamationScheduler = createAgentSessionInactivityReclamationScheduler({
		getTaskSessionSummary: findRuntimeSessionSummary,
		reclaimAgentSession: createTransportAwareAgentSessionReclamationExecutor({
			getTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
			getClineTaskSessionService: (workspaceId) => clineTaskSessionServiceByWorkspaceId.get(workspaceId) ?? null,
			getAcpTaskSessionService: (workspaceId) => acpTaskSessionServiceByWorkspaceId.get(workspaceId) ?? null,
		}),
		// 审计结果写回 summary sidecar，供卡片 / Focus View 显示「会话已被回收」。
		// 用户重进任务时必须看到明确说明（worktree、未提交改动、提交、消息历史均保留），
		// 而不是一个空终端让人误以为只是加载慢。
		onReclamationOutcome: ({ workspaceId, record, outcome }) => {
			switch (record.sessionTransport) {
				case "pty_terminal":
					deps.workspaceRegistry
						.getTerminalManagerForWorkspace(workspaceId)
						?.applyAgentSessionReclamationOutcome(record.taskId, outcome);
					return;
				case "in_process_cline_sdk":
					clineTaskSessionServiceByWorkspaceId
						.get(workspaceId)
						?.applyAgentSessionReclamationOutcome(record.taskId, outcome);
					return;
				case "acp_stdio_subprocess":
					acpTaskSessionServiceByWorkspaceId
						.get(workspaceId)
						?.applyAgentSessionReclamationOutcome(record.taskId, outcome);
					return;
			}
		},
	});

	const stopAndCollectProjectRuntimeSessionsForSafePersistence = async (
		workspaceId: string,
	): Promise<ActiveRuntimeSessionShutdownResult> => {
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
		const clineTaskSessionService = clineTaskSessionServiceByWorkspaceId.get(workspaceId);
		const acpTaskSessionService = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		return await stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace({
			terminalManager,
			clineTaskSessionService: clineTaskSessionService ?? null,
			acpTaskSessionService: acpTaskSessionService ?? null,
		});
	};
	const stopAllActiveRuntimeSessionsForShutdown = async () => {
		const workspacePathByWorkspaceId = new Map<string, string | null>();
		for (const { workspaceId, workspacePath } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspacePathByWorkspaceId.set(workspaceId, workspacePath);
		}
		for (const [workspaceId, workspacePath] of clineWorkspacePathByWorkspaceId) {
			workspacePathByWorkspaceId.set(workspaceId, workspacePath);
		}
		for (const [workspaceId, workspacePath] of acpWorkspacePathByWorkspaceId) {
			workspacePathByWorkspaceId.set(workspaceId, workspacePath);
		}

		const results: Array<ActiveRuntimeSessionShutdownResult & { workspaceId: string; workspacePath: string | null }> =
			[];
		for (const [workspaceId, workspacePath] of workspacePathByWorkspaceId) {
			try {
				results.push({
					workspaceId,
					workspacePath,
					...(await stopAndCollectProjectRuntimeSessionsForSafePersistence(workspaceId)),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn(`Could not safely stop runtime sessions for ${workspacePath ?? workspaceId}. ${message}`);
			}
		}
		return results;
	};
	const prepareForStateReset = async (): Promise<void> => {
		const workspaceIds = new Set<string>();
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspaceIds.add(workspaceId);
		}
		for (const workspaceId of clineTaskSessionServiceByWorkspaceId.keys()) {
			workspaceIds.add(workspaceId);
		}
		for (const workspaceId of acpTaskSessionServiceByWorkspaceId.keys()) {
			workspaceIds.add(workspaceId);
		}
		const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
		if (activeWorkspaceId) {
			workspaceIds.add(activeWorkspaceId);
		}
		for (const workspaceId of workspaceIds) {
			disposeAcpTaskSessionService(workspaceId);
			await disposeClineTaskSessionServiceAsync(workspaceId);
			deps.disposeWorkspace(workspaceId, {
				stopTerminalSessions: true,
			});
		}
		deps.workspaceRegistry.clearActiveWorkspace();
	};

	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
		return {
			requestedWorkspaceId: scope.requestedWorkspaceId,
			workspaceScope: scope.workspaceScope,
			runtimeApi: createRuntimeApi({
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
				loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
				setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
				getScopedTerminalManager,
				getScopedClineTaskSessionService,
				getScopedAcpTaskSessionService,
				resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
				runCommand: deps.runCommand,
				broadcastClineMcpAuthStatusesUpdated: deps.runtimeStateHub.broadcastClineMcpAuthStatusesUpdated,
				broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
				broadcastNotificationLogUpdated: deps.runtimeStateHub.broadcastNotificationLogUpdated,
				bumpClineSessionContextVersion: deps.runtimeStateHub.bumpClineSessionContextVersion,
				prepareForStateReset,
				getUpdateStatus: deps.getUpdateStatus,
				runUpdateNow: deps.runUpdateNow,
			}),
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				getScopedClineTaskSessionService,
				loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
				listProjectRuntimeSessionSummaries,
			}),
			projectsApi: createProjectsApi({
				getActiveWorkspacePath: deps.workspaceRegistry.getActiveWorkspacePath,
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				rememberWorkspace: deps.workspaceRegistry.rememberWorkspace,
				setActiveWorkspace: deps.workspaceRegistry.setActiveWorkspace,
				clearActiveWorkspace: deps.workspaceRegistry.clearActiveWorkspace,
				resolveProjectInputPath: deps.resolveProjectInputPath,
				assertPathIsDirectory: deps.assertPathIsDirectory,
				hasGitRepository: deps.hasGitRepository,
				summarizeProjectTaskCounts: deps.workspaceRegistry.summarizeProjectTaskCounts,
				createProjectSummary: deps.workspaceRegistry.createProjectSummary,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				listProjectRuntimeSessionSummaries,
				stopAndCollectProjectRuntimeSessionsForSafePersistence,
				disposeProjectRuntime: async (workspaceId) => {
					const disposalFailureMessages: string[] = [];
					try {
						disposeAcpTaskSessionService(workspaceId);
						await disposeClineTaskSessionServiceAsync(workspaceId);
					} catch (error) {
						disposalFailureMessages.push(error instanceof Error ? error.message : String(error));
					}
					try {
						deps.disposeWorkspace(workspaceId, { stopTerminalSessions: false });
					} catch (error) {
						disposalFailureMessages.push(error instanceof Error ? error.message : String(error));
					}
					if (disposalFailureMessages.length > 0) {
						throw new Error(disposalFailureMessages.join(" "));
					}
				},
				warn: deps.warn,
				buildProjectsPayload: deps.workspaceRegistry.buildProjectsPayload,
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
				serverCwd: process.cwd(),
			}),
			hooksApi: createHooksApi({
				getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
			}),
			deploymentApi: createDeploymentApi({
				// 看板当前列快照：直读该 workspace 的 board.json，摊平 columns×cards → (taskId, columnId)。
				loadBoardTasksForWorkspace: async (scope) => {
					const board = await loadWorkspaceBoardById(scope.workspaceId);
					return board.columns.flatMap((column) =>
						column.cards.map((card) => ({ taskId: card.id, columnId: column.id })),
					);
				},
				// 确认框 agent response 按 agent 类型分源（plan Grilling #5）。
				loadTaskAgentResponsePreview: async (scope, taskId) => {
					// agent 类型判定必须廉价：绝不为终端任务触发 loadTaskSessionMessages —— 后者会 boot Cline SDK
					// session host（AGENTS.md 记载的 CI 卡死诱因）。先用「in-memory Cline summary agentId」+「看板卡
					// 配置的 agentId」双廉价信号判定是否 Cline 任务，二者皆非 cline 才走终端 agent 路径。
					const clineTaskSessionService = await getScopedClineTaskSessionService(scope);
					const board = await loadWorkspaceBoardById(scope.workspaceId);
					const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
					const isClineTask =
						clineTaskSessionService.getSummary(taskId)?.agentId === "cline" || card?.agentId === "cline";
					if (isClineTask) {
						// Cline（in-process SDK）：取任务聊天记录最后一条 assistant message；拿不到时优雅降级为 null。
						const messages = await clineTaskSessionService.loadTaskSessionMessages(taskId);
						let lastAssistantMessageContent: string | null = null;
						for (const message of messages) {
							if (message.role === "assistant") {
								lastAssistantMessageContent = message.content;
							}
						}
						return lastAssistantMessageContent;
					}
					// ACP agent（omp 等）：既没有 hook finalMessage，也不在 Cline 账本里；只认 cline 会让
					// 预览对它恒为 null。ACP service 的消息全在内存，读它同样廉价，不会 boot 任何 SDK host。
					const acpTaskSessionService = await getScopedAcpTaskSessionService(scope);
					const isAcpTask =
						isRuntimeAgentSessionDrivenByAcpProtocol(acpTaskSessionService.getSummary(taskId)?.agentId ?? null) ||
						isRuntimeAgentSessionDrivenByAcpProtocol(card?.agentId ?? null);
					if (isAcpTask) {
						let lastAcpAssistantMessageContent: string | null = null;
						for (const message of acpTaskSessionService.listMessages(taskId)) {
							if (message.role === "assistant") {
								lastAcpAssistantMessageContent = message.content;
							}
						}
						return lastAcpAssistantMessageContent;
					}
					// 终端 agent（Claude 等）：取 hook 采集的最近 finalMessage；无则优雅降级为 null。
					const manager = await getScopedTerminalManager(scope);
					return manager.getSummary(taskId)?.latestHookActivity?.finalMessage ?? null;
				},
			}),
		};
	};

	const trpcHttpHandler = createHTTPHandler({
		basePath: "/api/trpc/",
		router: runtimeAppRouter,
		createContext: async ({ req }) => await createTrpcContext(req),
	});

	const isRemoteMode = isKanbanRemoteHost();

	const readRequestBody = (req: IncomingMessage, maxBytes = 4096): Promise<string> =>
		new Promise((resolve, reject) => {
			let body = "";
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					reject(new Error("Request body too large"));
					return;
				}
				body += chunk.toString("utf8");
			});
			req.on("end", () => resolve(body));
			req.on("error", reject);
		});

	const getRemoteIp = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

	const tlsConfig = getKanbanRuntimeTls();
	const requestHandler = async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
		try {
			if (handleHttpRequest(req, res).end) {
				return;
			}

			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);

			// ── Passcode gate (remote mode only) ──────────────────────────────
			const passcodeActive = isRemoteMode && isPasscodeEnabled();
			if (pathname === "/api/passcode/status") {
				if (passcodeActive) {
					const token = extractSessionTokenFromCookie(req.headers.cookie);
					const authenticated = token !== null && validateSession(token);
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: true, authenticated }));
				} else {
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: false, authenticated: true }));
				}
				return;
			}
			if (passcodeActive && req.method === "POST" && pathname === "/api/passcode/verify") {
				const ip = getRemoteIp(req);
				const rateLimit = checkRateLimit(ip);
				if (!rateLimit.allowed) {
					const retryAfterSec = rateLimit.lockedUntilMs
						? Math.ceil((rateLimit.lockedUntilMs - Date.now()) / 1000)
						: 30;
					res.writeHead(429, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
						"Retry-After": String(retryAfterSec),
					});
					res.end(JSON.stringify({ error: "Too many attempts. Please wait before trying again." }));
					return;
				}
				let body: string;
				try {
					body = await readRequestBody(req);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid request body." }));
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid JSON." }));
					return;
				}
				const submitted =
					parsed !== null &&
					typeof parsed === "object" &&
					"passcode" in parsed &&
					typeof (parsed as Record<string, unknown>).passcode === "string"
						? ((parsed as Record<string, unknown>).passcode as string)
						: "";
				if (!validatePasscode(submitted)) {
					recordFailedAttempt(ip);
					res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ error: "Invalid passcode." }));
					return;
				}
				clearRateLimit(ip);
				const token = issueSession();
				const cookieFlags = [
					`kanban_session=${token}`,
					"HttpOnly",
					"SameSite=Strict",
					"Path=/",
					`Max-Age=${24 * 60 * 60}`,
					...(tlsConfig !== null ? ["Secure"] : []),
				].join("; ");
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
					"Set-Cookie": cookieFlags,
				});
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (passcodeActive) {
				// Check session cookie (browser flow) first, then internal bearer token (CLI flow).
				const sessionToken = extractSessionTokenFromCookie(req.headers.cookie);
				const sessionAuth = sessionToken !== null && validateSession(sessionToken);
				const bearerToken = extractBearerToken(req.headers.authorization);
				const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
				const authenticated = sessionAuth || internalAuth;
				if (!authenticated) {
					// Static assets (JS, CSS, images, fonts, icons, manifest) are served
					// freely even when unauthenticated. They contain no user data and are
					// required for the React app to boot and render the passcode gate.
					// Only API routes are hard-blocked; index.html is served normally so
					// PasscodeGateProvider in React can intercept before any API calls.
					if (pathname.startsWith("/api/")) {
						res.writeHead(401, {
							"Content-Type": "application/json; charset=utf-8",
							"Cache-Control": "no-store",
						});
						res.end(JSON.stringify({ error: "Authentication required." }));
						return;
					}
					// Fall through — let the normal asset/index.html serving below handle it.
					// PasscodeGateProvider in main.tsx will render the gate before any
					// authenticated API calls are made.
				}
			}
			// ── End passcode gate ──────────────────────────────────────────────

			const oauthCallbackResponse = await handleClineMcpOauthCallback(requestUrl);
			if (oauthCallbackResponse) {
				res.writeHead(oauthCallbackResponse.statusCode, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(oauthCallbackResponse.body);
				return;
			}
			if (pathname.startsWith("/api/trpc")) {
				await trpcHttpHandler(req, res);
				return;
			}
			if (pathname.startsWith("/api/")) {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"error":"Not found"}');
				return;
			}

			const asset = await readAsset(webUiDir, pathname);
			res.writeHead(200, {
				"Content-Type": asset.contentType,
				"Cache-Control": "no-store",
			});
			res.end(asset.content);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
		}
	};
	const server = tlsConfig
		? createHttpsServer({ key: tlsConfig.key, cert: tlsConfig.cert }, requestHandler)
		: createServer(requestHandler);
	server.on("upgrade", (request, socket, head) => {
		if (handleSocketUpgrade(request, socket).end) {
			return;
		}

		let requestUrl: URL;
		try {
			requestUrl = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
		} catch {
			socket.destroy();
			return;
		}
		if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
			return;
		}
		// ── Passcode gate for WebSocket upgrades (remote mode only) ──────────
		const passcodeActive = isRemoteMode && isPasscodeEnabled();
		if (passcodeActive) {
			const sessionToken = extractSessionTokenFromCookie(request.headers.cookie);
			const sessionAuth = sessionToken !== null && validateSession(sessionToken);
			const bearerToken = extractBearerToken(request.headers.authorization);
			const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
			if (!sessionAuth && !internalAuth) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
		}
		// ── End passcode gate ─────────────────────────────────────────────────
		(request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled = true;
		const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId")?.trim() || null;
		deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedWorkspaceId });
	});
	// [tui-freeze] 诊断:终端回显链路与所有任务的输入处理共享这个 Node 事件循环,
	// 循环被同步重活占据时键盘输入会整体延迟——在 bridge 生命周期内持续采样延迟直方图。
	const stopEventLoopDelayMonitor = startEventLoopDelayMonitor();
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		server,
		resolveTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
		isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
		isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
		validateUpgradeSession:
			isRemoteMode && isPasscodeEnabled()
				? (cookieHeader) => {
						const token = extractSessionTokenFromCookie(cookieHeader);
						return token !== null && validateSession(token);
					}
				: undefined,
	});
	server.on("upgrade", (request, socket) => {
		const handled = (request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled;
		if (handled) {
			return;
		}
		socket.destroy();
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(getKanbanRuntimePort(), getKanbanRuntimeHost(), () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to start local server.");
	}
	const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
	const url = activeWorkspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimeOrigin();

	// 启动即扫一次：账本里存的是绝对到期时刻，故 Kanban 停机期间流逝的时间自然计入，
	// 重启后能直接把「停机时早就到期」的记录处理掉，不需要任何补偿逻辑。
	agentSessionInactivityReclamationScheduler.start();

	return {
		url,
		stopAllActiveRuntimeSessionsForShutdown,
		close: async () => {
			agentSessionInactivityReclamationScheduler.stop();
			// ACP agent 是持有 stdio 的真子进程：不在这里拆掉，关服后它还活着、还能改仓库，
			// 而且它占着的 stdio 管道会把 Kanban 进程本身的退出一起拖住。
			for (const service of acpTaskSessionServiceByWorkspaceId.values()) {
				service.disposeAllTaskSessions();
			}
			acpTaskSessionServiceByWorkspaceId.clear();
			acpWorkspacePathByWorkspaceId.clear();
			await Promise.all(
				Array.from(clineTaskSessionServiceByWorkspaceId.values()).map(async (service) => {
					await service.dispose();
				}),
			);
			clineTaskSessionServiceByWorkspaceId.clear();
			clineWorkspacePathByWorkspaceId.clear();
			await clineWatcherRegistry.close();
			await deps.runtimeStateHub.close();
			stopEventLoopDelayMonitor();
			await terminalWebSocketBridge.close();
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			});
		},
	};
}
