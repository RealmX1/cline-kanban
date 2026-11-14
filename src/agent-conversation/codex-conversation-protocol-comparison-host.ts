import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as waitForNativeForkEvidence } from "node:timers/promises";
import { z } from "zod";
import { AcpClientConnectionRuntime } from "../acp-client-session/acp-client-connection-runtime";
import { AcpTaskSessionService } from "../acp-client-session/acp-task-session-service";
import { withRunningCodexAppServerControlSocketConnection } from "../codex-native-session-protocol/codex-app-server-control-socket-request-connection";
import {
	assertCodexNativeConversationLoadedByCurrentHost,
	type CodexAppServerRequestPort,
	computeCodexNativeConversationPrefixContentSha256,
	forkCodexConversationBeforeBoundaryTurn,
	type RestoredCodexConversationIdentity,
	readCodexConversationTurns,
	verifyRestoredCodexConversationPrefix,
} from "../codex-native-session-protocol/codex-native-conversation-history";
import { type RuntimeTaskSessionSummary, runtimeTaskImageSchema } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	beginManagedTaskPromptDelivery,
	settleManagedTaskPromptDeliveryWithoutBlocking,
} from "../state/managed-task-prompt-delivery-coordinator";
import { CodexNativeConversationConnectionRuntime } from "./codex-native-conversation-connection-runtime";

const backendSchema = z.enum(["codex_native", "codex_acp"]);
export type CodexComparisonBackendId = z.infer<typeof backendSchema>;
const requestSchema = z.object({
	operation: z.enum(["start", "send", "interrupt", "stop", "rewind", "history", "decision"]),
	backend: backendSchema,
	text: z.string().max(2_000_000).optional(),
	idempotencyKey: z.string().min(1).max(200).optional(),
	images: z.array(runtimeTaskImageSchema).max(8).optional(),
	startInPlanMode: z.boolean().optional(),
	boundaryTurnId: z.string().optional(),
	lastPreBoundaryTurnId: z.string().optional(),
	decisionId: z.string().optional(),
	optionId: z.string().nullable().optional(),
	runtimeSessionIncarnationId: z.string().optional(),
});
const durableSessionSchema = z.object({
	nativeSessionId: z.string().optional(),
	stoppedByUser: z.boolean().default(false),
	pendingRewindNativeSessionId: z.string().optional(),
	pendingRewindExpectedPrefixTurnIds: z.array(z.string()).optional(),
	pendingRewindExpectedPrefixContentSha256: z.string().optional(),
	pendingRewindPrefixVerified: z.boolean().optional(),
	pendingRewindSubmission: z
		.object({
			sourceNativeSessionId: z.string(),
			expectedSourceContentSha256: z.string(),
			nativeSessionIdsBeforeSubmission: z.array(z.string()),
			observedNativeForkCandidateIds: z.array(z.string()).default([]),
		})
		.optional(),
	lastSummary: z.unknown().optional(),
	hadSubmittedPrompt: z.boolean().optional(),
});
const durableSnapshotSchema = z.object({ sessions: z.record(backendSchema, durableSessionSchema).optional() });
type DurableSession = z.infer<typeof durableSessionSchema>;
export interface CodexComparisonHostOptions {
	comparisonDirectory: string;
	workingDirectory: string;
	codexBinary: string;
	acpBinary: string;
	codexBridgeBinary: string;
	modelId: string;
	port?: number;
	frontendMiddleware?: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
}
// 比较入口不注册到生产任务路由；浏览器关闭后进程与投递观察继续由此宿主持有。
export async function startCodexConversationProtocolComparisonHost(options: CodexComparisonHostOptions) {
	const directory = resolve(options.comparisonDirectory);
	if (
		resolve(process.env.HOME ?? "") !== join(directory, "isolated-home") ||
		resolve(process.env.CODEX_HOME ?? "") !== join(directory, "isolated-codex-home") ||
		resolve(process.env.CODEX_SQLITE_HOME ?? "") !== join(directory, "isolated-codex-home")
	)
		throw new Error("比较入口要求专用 HOME、CODEX_HOME 与 CODEX_SQLITE_HOME，拒绝继承真实存储目录。");
	await mkdir(options.workingDirectory, { recursive: true });
	const canonicalWorkingDirectory = realpathSync(options.workingDirectory);
	const matchesWorkingDirectory = (cwd: string) => {
		try {
			return realpathSync(cwd) === canonicalWorkingDirectory;
		} catch {
			return false;
		}
	};
	const controlTokenPath = join(directory, "comparison-control-capability-token");
	const controlToken = existsSync(controlTokenPath) ? readFileSync(controlTokenPath, "utf8") : randomUUID();
	if (!/^[0-9a-f-]{36}$/u.test(controlToken)) throw new Error("隔离比较入口的访问标识已损坏，未覆盖原文件。");
	if (!existsSync(controlTokenPath)) writeFileSync(controlTokenPath, controlToken, { mode: 0o600, flag: "wx" });
	const snapshotPath = join(directory, "comparison-session-snapshot.json");
	const journalPath = join(directory, "comparison-protocol-events.jsonl");
	const previous = existsSync(snapshotPath)
		? durableSnapshotSchema.parse(JSON.parse(readFileSync(snapshotPath, "utf8"))).sessions
		: undefined;
	const durable: Record<CodexComparisonBackendId, DurableSession> = {
		codex_native: previous?.codex_native ?? { stoppedByUser: false, hadSubmittedPrompt: false },
		codex_acp: previous?.codex_acp ?? { stoppedByUser: false, hadSubmittedPrompt: false },
	};
	const persist = () => {
		const pendingPath = `${snapshotPath}.pending-write`;
		writeFileSync(pendingPath, JSON.stringify({ sessions: durable }, null, 2), { mode: 0o600 });
		renameSync(pendingPath, snapshotPath);
	};
	const journal = (backend: CodexComparisonBackendId, kind: string, event: unknown) =>
		appendFileSync(journalPath, `${JSON.stringify({ observedAtMs: Date.now(), backend, kind, event })}\n`, {
			mode: 0o600,
		});
	let nativeRuntime!: CodexNativeConversationConnectionRuntime;
	const nativeService = new AcpTaskSessionService(null, {
		sessionTransport: "codex_app_server_subprocess",
		capabilities: {
			runningTurnInput: "interrupt_then_send_only",
			exactRewind: "owned_native_app_server_required",
			runtimeRestartRecovery: "resume_history_after_confirmed_exit",
			freeTextQuestionForms: false,
		},
		createConnectionRuntime: (handlers) => {
			nativeRuntime = new CodexNativeConversationConnectionRuntime(handlers, {
				binary: options.codexBinary,
				environment: process.env,
				onProtocolEvent: (event) => {
					journal("codex_native", "native_protocol", event);
					if (event.direction === "notification")
						recordNativeForkObservation("codex_native", event.method, event.parameters);
				},
			});
			return nativeRuntime;
		},
	});
	let acpSocketDirectory: string | null = null;
	let acpSocketPath: string | null = null;
	let acpRuntime!: AcpClientConnectionRuntime;
	const acpService = new AcpTaskSessionService(null, {
		sessionTransport: "acp_stdio_subprocess",
		capabilities: {
			runningTurnInput: "interrupt_then_send_only",
			exactRewind: "owned_native_app_server_required",
			runtimeRestartRecovery: "resume_history_after_confirmed_exit",
			freeTextQuestionForms: false,
		},
		createConnectionRuntime: (handlers) => {
			acpRuntime = new AcpClientConnectionRuntime(
				{
					...handlers,
					onSessionUpdate: (taskId, event) => {
						journal("codex_acp", "acp_update", event);
						handlers.onSessionUpdate(taskId, event);
					},
					onPermissionRequest: (taskId, event) => {
						journal("codex_acp", "acp_permission", event);
						return handlers.onPermissionRequest(taskId, event);
					},
					onElicitationRequest: (taskId, event) => {
						journal("codex_acp", "acp_question", event);
						return handlers.onElicitationRequest(taskId, event);
					},
				},
				(agentId) => {
					if (agentId !== "codex" || !acpSocketPath) throw new Error("Codex ACP 比较连接未取得本代端点。");
					const ownedSocketPath = acpSocketPath;
					return {
						agentId,
						planModeSessionModeId: "plan",
						buildSpawnCommand: ({ permissionMode }) => ({
							binary: options.acpBinary,
							args: [],
							env: {
								CODEX_PATH: options.codexBridgeBinary,
								APP_SERVER_LOGS: join(directory, "codex-acp-diagnostics"),
								CODEX_CONFIG: JSON.stringify({
									model: options.modelId,
									approval_policy: permissionMode === "bypass_all_permission_prompts" ? "never" : "on-request",
									sandbox_mode:
										permissionMode === "bypass_all_permission_prompts" ? "danger-full-access" : "read-only",
								}),
								KANBAN_COMPARISON_CODEX_BINARY: options.codexBinary,
								KANBAN_COMPARISON_CODEX_SOCKET_PATH: ownedSocketPath,
							},
						}),
					};
				},
			);
			return acpRuntime;
		},
	});
	const services = { codex_native: nativeService, codex_acp: acpService };
	const clients = new Set<ServerResponse>();
	const snapshot = () => ({
		modelId: options.modelId,
		workingDirectory: options.workingDirectory,
		sessions: Object.fromEntries(
			Object.entries(services).map(([backend, service]) => [
				backend,
				{
					summary: service.getSummary(backend),
					capabilities: service.getExecutionBackendCapabilities(),
					messages: service.listMessages(backend),
					recovery: durable[backend as CodexComparisonBackendId],
				},
			]),
		),
	});
	const publish = () => {
		const event = `data: ${JSON.stringify(snapshot())}\n\n`;
		for (const client of clients) client.write(event);
	};
	for (const [backend, service] of Object.entries(services) as [CodexComparisonBackendId, AcpTaskSessionService][]) {
		service.onSummary((summary) => {
			if (summary.agentNativeConversationSessionIdentity?.nativeSessionId)
				durable[backend].nativeSessionId = summary.agentNativeConversationSessionIdentity.nativeSessionId;
			durable[backend].lastSummary = summary;
			persist();
			journal(backend, "summary", summary);
			publish();
		});
		service.onMessage((_taskId, message) => {
			journal(backend, "message", message);
			publish();
		});
	}
	const mutationInProgress = new Set<CodexComparisonBackendId>();
	async function start(backend: CodexComparisonBackendId, startInPlanMode = false) {
		const service = services[backend];
		if (service.hasLiveTaskSession(backend)) return;
		// shortcut: 比较入口只恢复已退出的实例；正式接入前复用独立宿主的跨进程所有权协议。
		const previousPid = z
			.object({ pid: z.number().int().positive().nullish() })
			.safeParse(durable[backend].lastSummary);
		if (previousPid.success && previousPid.data.pid) {
			try {
				process.kill(previousPid.data.pid, 0);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
				previousPid.data.pid = null;
			}
			if (previousPid.data.pid) throw new Error("旧执行实例仍存活，未接管所有权或并发恢复同一原生会话。");
		}
		// 本地消息是当前原生分支的投影；重新绑定前丢弃旧投影，原始转录保持不变。
		service.discardTaskSessionLedgerEntry(backend);
		if (backend === "codex_acp") {
			acpSocketDirectory = await mkdtemp("/tmp/kanban-codex-acp-comparison-");
			acpSocketPath = join(acpSocketDirectory, "s");
		}
		let pendingRewind = durable[backend].pendingRewindNativeSessionId;
		const nativeSessionId =
			pendingRewind && durable[backend].pendingRewindPrefixVerified
				? pendingRewind
				: durable[backend].hadSubmittedPrompt === false
					? undefined
					: durable[backend].nativeSessionId;
		const summary = await service.startTaskSession({
			taskId: backend,
			agentId: "codex",
			cwd: options.workingDirectory,
			prompt: "",
			modelId: options.modelId,
			permissionMode: "ask_for_every_tool_use",
			startInPlanMode,
			resumePriorAgentConversationWithoutResendingPrompt: Boolean(nativeSessionId),
			observedAgentNativeConversationSessionIdentity: nativeSessionId
				? { sourceAgentId: "codex", nativeSessionId, transcriptPath: null, observedAt: Date.now() }
				: null,
		});
		if (!service.hasLiveTaskSession(backend)) throw new Error(summary.warningMessage ?? "比较会话启动失败。");
		if (durable[backend].pendingRewindSubmission && !pendingRewind) {
			await withOwnedNativePort(backend, (port) => reconcileUnconfirmedRewindFork(backend, port));
			pendingRewind = durable[backend].pendingRewindNativeSessionId;
		}
		if (pendingRewind && !durable[backend].pendingRewindPrefixVerified) {
			const expectedPrefix = durable[backend].pendingRewindExpectedPrefixTurnIds;
			const expectedContentSha256 = durable[backend].pendingRewindExpectedPrefixContentSha256;
			if (!expectedPrefix || !expectedContentSha256)
				throw new Error("恢复分支缺少完整前缀证据，保留原会话，未采用候选或重复 fork。");
			await withOwnedNativePort(backend, (port) =>
				verifyRestoredCodexConversationPrefix(port, pendingRewind, expectedPrefix, expectedContentSha256),
			);
			const submission = durable[backend].pendingRewindSubmission;
			if (submission)
				await withOwnedNativePort(backend, async (port) => {
					const source = await readCodexConversationTurns(port, submission.sourceNativeSessionId);
					if (computeCodexNativeConversationPrefixContentSha256(source) !== submission.expectedSourceContentSha256)
						throw new Error("源会话历史已变化，保留候选，未切换恢复分支。");
				});
			durable[backend].pendingRewindPrefixVerified = true;
			persist();
			await stop(backend, false);
			return await start(backend);
		}
		durable[backend].stoppedByUser = false;
		durable[backend].pendingRewindNativeSessionId = undefined;
		durable[backend].pendingRewindExpectedPrefixTurnIds = undefined;
		durable[backend].pendingRewindExpectedPrefixContentSha256 = undefined;
		durable[backend].pendingRewindPrefixVerified = undefined;
		durable[backend].pendingRewindSubmission = undefined;
		persist();
		if (backend === "codex_acp") {
			const connection = acpRuntime.getConnection(backend);
			if (connection) {
				journal(backend, "initialize", connection.initializeResponse);
				const prompt = connection.prompt.bind(connection);
				connection.prompt = async (blocks) => {
					journal(backend, "prompt_request", { blocks });
					return await prompt(blocks);
				};
			}
		}
	}
	async function withOwnedNativePort<T>(
		backend: CodexComparisonBackendId,
		operation: (port: CodexAppServerRequestPort) => Promise<T>,
	) {
		if (backend === "codex_native") {
			const port = nativeRuntime.getNativeRequestPort(backend);
			if (!port) throw new Error("原生执行实例未连接。");
			return await operation(port);
		}
		if (!acpSocketPath || !acpService.hasLiveTaskSession(backend)) throw new Error("ACP 本代 App Server 未连接。");
		return await withRunningCodexAppServerControlSocketConnection(operation, {
			socketPath: acpSocketPath,
			clientName: "kanban_comparison_acp_native_evidence",
			requestTimeoutMs: 15_000,
			onNotification: (method, parameters) => {
				journal(backend, "native_evidence_notification", { method, parameters });
				recordNativeForkObservation(backend, method, parameters);
			},
		});
	}
	function recordNativeForkObservation(
		backend: CodexComparisonBackendId,
		method: string,
		parameters: Record<string, unknown>,
	) {
		const submission = durable[backend].pendingRewindSubmission;
		if (method !== "thread/started" || !submission) return;
		const parsed = z
			.object({ thread: z.object({ id: z.string(), forkedFromId: z.string().nullable(), cwd: z.string() }) })
			.safeParse(parameters);
		if (!parsed.success) return;
		const thread = parsed.data.thread;
		if (
			thread.forkedFromId === submission.sourceNativeSessionId &&
			!submission.nativeSessionIdsBeforeSubmission.includes(thread.id) &&
			matchesWorkingDirectory(thread.cwd) &&
			!submission.observedNativeForkCandidateIds.includes(thread.id)
		) {
			submission.observedNativeForkCandidateIds.push(thread.id);
			persist();
		}
	}
	async function listNativeThreadMetadata(port: CodexAppServerRequestPort) {
		const threads: { id: string; forkedFromId?: string | null; cwd: string; path?: string | null }[] = [];
		let cursor: string | null = null;
		const seenCursors = new Set<string>();
		do {
			const page = z
				.object({ data: z.array(z.string()), nextCursor: z.string().nullable() })
				.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
			for (const id of page.data) {
				const thread = z
					.object({
						thread: z.object({
							id: z.string(),
							forkedFromId: z.string().nullish(),
							cwd: z.string(),
							path: z.string().nullish(),
						}),
					})
					.parse(await port.request("thread/read", { threadId: id, includeTurns: false })).thread;
				if (thread.id !== id) throw new Error("原生分支身份不匹配。");
				threads.push(thread);
			}
			cursor = page.nextCursor;
			if (cursor && seenCursors.has(cursor)) throw new Error("原生分支列表分页循环，未选择恢复分支。");
			if (cursor) seenCursors.add(cursor);
		} while (cursor);
		return threads;
	}
	async function reconcileUnconfirmedRewindFork(backend: CodexComparisonBackendId, port: CodexAppServerRequestPort) {
		const submission = durable[backend].pendingRewindSubmission;
		if (!submission) throw new Error("缺少 fork 提交前证据，未猜测恢复分支。");
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const loadedCandidates = (await listNativeThreadMetadata(port)).filter(
				(thread) =>
					thread.forkedFromId === submission.sourceNativeSessionId &&
					!submission.nativeSessionIdsBeforeSubmission.includes(thread.id) &&
					matchesWorkingDirectory(thread.cwd),
			);
			const candidateIds = [
				...new Set([...loadedCandidates.map((thread) => thread.id), ...submission.observedNativeForkCandidateIds]),
			];
			journal(backend, "rewind_unknown_result_evidence_query", {
				attempt,
				candidateIds,
			});
			if (candidateIds.length === 1) {
				durable[backend].pendingRewindNativeSessionId = candidateIds[0];
				durable[backend].pendingRewindPrefixVerified = false;
				persist();
				return;
			}
			if (candidateIds.length > 1) break;
			if (attempt === 0) await waitForNativeForkEvidence(250);
		}
		throw new Error("fork 结果仍未知；已保留提交证据与恢复条件，未重复创建分支。");
	}
	async function stop(backend: CodexComparisonBackendId, stoppedByUser: boolean) {
		durable[backend].stoppedByUser = stoppedByUser;
		persist();
		const previousSummary = services[backend].getSummary(backend);
		const exit = await services[backend].stopTaskSessionForReclamation(backend);
		if (!exit.rootProcessExitConfirmed) {
			durable[backend].lastSummary = previousSummary;
			persist();
			throw new Error("未确认旧执行实例退出，未移除端点或启动后继实例。");
		}
		if (backend === "codex_acp" && acpSocketDirectory) {
			await rm(acpSocketDirectory, { recursive: true, force: true });
			acpSocketDirectory = null;
			acpSocketPath = null;
		}
	}
	async function execute(request: z.infer<typeof requestSchema>) {
		const backend = request.backend,
			service = services[backend];
		if (request.operation === "start") {
			await start(backend, request.startInPlanMode);
			return snapshot();
		}
		if (request.operation === "stop") {
			await stop(backend, true);
			return snapshot();
		}
		if (request.operation === "interrupt") {
			await service.cancelTaskTurn(backend);
			return snapshot();
		}
		if (request.operation === "decision") {
			if (request.runtimeSessionIncarnationId !== service.getSummary(backend)?.runtimeSessionIncarnationId)
				throw new Error("决策所属的执行代际已改变。");
			if (
				!request.decisionId ||
				!service.resolveUserDecision(backend, request.decisionId, {
					outcome: request.optionId ? "selected" : "cancelled",
					optionId: request.optionId ?? null,
				})
			)
				throw new Error("该决策已失效或不属于当前会话。");
			return snapshot();
		}
		if (!service.hasLiveTaskSession(backend)) throw new Error("请先启动或恢复对应后端。");
		const nativeSessionId = service.getSummary(backend)?.agentNativeConversationSessionIdentity?.nativeSessionId;
		if (!nativeSessionId) throw new Error("未取得可信原生会话身份。");
		if (request.operation === "history")
			return await withOwnedNativePort(backend, (port) => readCodexConversationTurns(port, nativeSessionId));
		if (request.operation === "rewind") {
			if (durable[backend].pendingRewindSubmission) {
				await stop(backend, false);
				await start(backend);
				return { reconciledExistingSubmission: true, state: snapshot() };
			}
			if (durable[backend].pendingRewindNativeSessionId) throw new Error("已有恢复分支待核验，未重复 fork。");
			if (!request.boundaryTurnId || !request.lastPreBoundaryTurnId)
				throw new Error("Rewind 必须指定两个原生回合边界。");
			if (
				service.getTaskSessionInputSubmissionReadiness(backend).isBusy ||
				resolveSessionFacets(service.getSummary(backend) as RuntimeTaskSessionSummary).turnOwner === "agent"
			)
				throw new Error("当前回合尚未完成，未 fork 或切换写入所有者。");
			const identity = await withOwnedNativePort(backend, async (port) => {
				await assertCodexNativeConversationLoadedByCurrentHost(port, nativeSessionId);
				const originalTurns = await readCodexConversationTurns(port, nativeSessionId);
				const expectedPrefix = originalTurns
					.slice(
						0,
						originalTurns.findIndex((turn) => turn.id === request.boundaryTurnId),
					)
					.map((turn) => turn.id);
				const expectedPrefixContentSha256 = computeCodexNativeConversationPrefixContentSha256(
					originalTurns.slice(0, expectedPrefix.length),
				);
				const beforeSubmission = await listNativeThreadMetadata(port);
				let forked: RestoredCodexConversationIdentity;
				try {
					forked = await forkCodexConversationBeforeBoundaryTurn(
						port,
						{
							sourceThreadId: nativeSessionId,
							boundaryTurnId: request.boundaryTurnId as string,
							lastPreBoundaryTurnId: request.lastPreBoundaryTurnId as string,
							workingDirectory: options.workingDirectory,
						},
						(created) => {
							durable[backend].pendingRewindNativeSessionId = created.nativeSessionId;
							durable[backend].pendingRewindExpectedPrefixTurnIds = expectedPrefix;
							durable[backend].pendingRewindExpectedPrefixContentSha256 = expectedPrefixContentSha256;
							durable[backend].pendingRewindPrefixVerified = false;
							persist();
							journal(backend, "rewind_fork_created", created);
						},
						async () => {
							durable[backend].pendingRewindExpectedPrefixTurnIds = expectedPrefix;
							durable[backend].pendingRewindExpectedPrefixContentSha256 = expectedPrefixContentSha256;
							durable[backend].pendingRewindSubmission = {
								sourceNativeSessionId: nativeSessionId,
								expectedSourceContentSha256: computeCodexNativeConversationPrefixContentSha256(originalTurns),
								nativeSessionIdsBeforeSubmission: beforeSubmission.map((thread) => thread.id),
								observedNativeForkCandidateIds: [],
							};
							persist();
						},
					);
				} catch (error) {
					if (!durable[backend].pendingRewindSubmission) throw error;
					journal(backend, "rewind_request_failed_before_reconciliation", String(error));
					if (!durable[backend].pendingRewindNativeSessionId) await reconcileUnconfirmedRewindFork(backend, port);
					const candidate = durable[backend].pendingRewindNativeSessionId as string;
					await verifyRestoredCodexConversationPrefix(
						port,
						candidate,
						expectedPrefix,
						expectedPrefixContentSha256,
					);
					const metadata = z
						.object({ thread: z.object({ id: z.string(), path: z.string(), cwd: z.string() }) })
						.parse(await port.request("thread/read", { threadId: candidate, includeTurns: false })).thread;
					if (metadata.id !== candidate || !matchesWorkingDirectory(metadata.cwd))
						throw new Error("补证分支身份或目录不匹配，未采用候选。");
					forked = { nativeSessionId: candidate, transcriptPath: metadata.path };
				}
				if (
					JSON.stringify(await readCodexConversationTurns(port, nativeSessionId)) !== JSON.stringify(originalTurns)
				)
					throw new Error("原会话历史变化，未切换恢复分支。");
				durable[backend].pendingRewindPrefixVerified = true;
				persist();
				journal(backend, "rewind_verified", {
					sourceNativeSessionId: nativeSessionId,
					expectedPrefixTurnIds: expectedPrefix,
					expectedPrefixContentSha256,
					restoredNativeSessionId: forked.nativeSessionId,
					sourceHistoryUnchanged: true,
				});
				return forked;
			});
			await stop(backend, false);
			durable[backend].nativeSessionId = identity.nativeSessionId;
			persist();
			await start(backend);
			return { identity, state: snapshot() };
		}
		if (durable[backend].pendingRewindSubmission)
			throw new Error("Rewind 提交结果待补证，未向归属尚未确定的分支发送新输入。");
		const text = request.text ?? "";
		if (!text.trim() && !request.images?.length) throw new Error("输入不能为空。");
		const key = request.idempotencyKey ?? randomUUID();
		if (service.getTaskSessionInputSubmissionReadiness(backend).isBusy)
			throw new Error("对应后端正在处理输入，未重复登记或发送。");
		const registration = await beginManagedTaskPromptDelivery({
			workspaceId: "codex-protocol-comparison",
			taskId: backend,
			text,
			idempotencyKey: key,
			origin: { messageType: "task_action", sourceLabel: "隔离比较请求（不证明真人授权）" },
			summary: service.getSummary(backend),
			imageAttachments: request.images,
		});
		if (!registration.newlyRegistered) return { duplicate: true, delivery: registration.entry };
		durable[backend].hadSubmittedPrompt = true;
		persist();
		await service.sendTaskSessionInput(
			backend,
			text,
			request.images,
			(accepted) =>
				settleManagedTaskPromptDeliveryWithoutBlocking(
					registration.handle,
					accepted
						? { status: "delivered_and_submit_confirmed", reason: null }
						: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
				),
			key,
		);
		return { idempotencyKey: key, state: snapshot() };
	}
	const server = createServer(async (request, response) => {
		try {
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			if (
				requestUrl.pathname.startsWith("/codex-comparison-api/") &&
				(!/^127\.0\.0\.1:\d+$/u.test(request.headers.host ?? "") ||
					(request.headers["x-kanban-codex-comparison"] ?? requestUrl.searchParams.get("controlToken")) !==
						controlToken)
			)
				throw new Error("比较 API 要求本机地址与当前隔离实例的访问标识。");
			if (requestUrl.pathname === "/codex-comparison-api/events" && request.method === "GET") {
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				clients.add(response);
				response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
				request.once("close", () => clients.delete(response));
				return;
			}
			if (requestUrl.pathname === "/codex-comparison-api/state" && request.method === "GET") {
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify(snapshot()));
				return;
			}
			if (requestUrl.pathname === "/codex-comparison-api/command" && request.method === "POST") {
				// 浏览器跨源和 DNS rebinding 不能借本地原型执行命令；API 调用也须有专用请求头。
				const origin = request.headers.origin;
				if (
					request.headers["x-kanban-codex-comparison"] !== controlToken ||
					(origin && origin !== `http://${request.headers.host}`)
				)
					throw new Error("比较请求来源无效。");
				let body = "";
				let bodyByteCount = 0;
				const bodyDecoder = new TextDecoder("utf-8", { fatal: true });
				for await (const bytes of request) {
					if (!Buffer.isBuffer(bytes)) throw new Error("比较请求必须使用 UTF-8 字节正文。");
					bodyByteCount += bytes.byteLength;
					if (bodyByteCount > 12_000_000) throw new Error("请求超过比较入口大小限制。");
					body += bodyDecoder.decode(bytes, { stream: true });
				}
				body += bodyDecoder.decode();
				const command = requestSchema.parse(JSON.parse(body));
				if (mutationInProgress.has(command.backend)) throw new Error("对应后端的控制动作尚未完成。");
				mutationInProgress.add(command.backend);
				try {
					const result = await execute(command);
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ ok: true, result }));
				} finally {
					mutationInProgress.delete(command.backend);
				}
				return;
			}
			if (options.frontendMiddleware)
				options.frontendMiddleware(request, response, () => {
					response.statusCode = 404;
					response.end();
				});
			else {
				response.statusCode = 404;
				response.end();
			}
		} catch (error) {
			if (!response.headersSent) {
				response.statusCode = 400;
				response.setHeader("Content-Type", "application/json");
			}
			response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		}
	});
	await new Promise<void>((accept, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", accept);
	});
	for (const backend of ["codex_native", "codex_acp"] as const) {
		if (durable[backend].nativeSessionId && !durable[backend].stoppedByUser)
			await start(backend).catch((error: unknown) =>
				journal(backend, "resume_failed_no_prompt_replayed", String(error)),
			);
	}
	return {
		server,
		controlToken,
		snapshot,
		execute,
		close: async () => {
			for (const client of clients) client.end();
			await Promise.all([
				stop("codex_native", durable.codex_native.stoppedByUser),
				stop("codex_acp", durable.codex_acp.stoppedByUser),
			]);
			await new Promise<void>((accept) => server.close(() => accept()));
		},
	};
}
