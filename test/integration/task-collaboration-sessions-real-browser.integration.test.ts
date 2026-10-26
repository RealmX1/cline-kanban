import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import {
	type RuntimeTaskSessionSummary,
	runtimeStateStreamTaskSessionsMessageSchema,
} from "../../src/core/api-contract";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Browser, BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_COLLABORATION_SESSION_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!packagedCliPath).each([
	["claude", "codex", "pty_terminal"],
	["codex", "claude", "pty_terminal"],
	["claude", "claude", "pty_terminal"],
	["codex", "codex", "pty_terminal"],
	["omp", "omp", "pty_terminal"],
	["omp", "omp", "acp_stdio_subprocess"],
] as const)(
	"打包态 %s → %s/%s：可写协作、上下文复刻和独立恢复",
	async (mainAgentId, collaborationAgentId, sessionTransport) => {
		if (!packagedCliPath) throw new Error("缺少隔离构建的 CLI 路径");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const writeCodexNativeConversationTranscriptFixture = (
			nativeSessionId: string,
			codexConversationStorageHomeDirectoryPath: string | undefined,
		): string => {
			if (!codexConversationStorageHomeDirectoryPath) throw new Error("假 Codex 未记录实际 CODEX_HOME");
			// 转录必须写入该进程实际使用的存储目录，才能覆盖跨 agent 新建后的真实续接预检。
			const codexSessionsDirectoryPath = join(codexConversationStorageHomeDirectoryPath, "sessions");
			mkdirSync(codexSessionsDirectoryPath, { recursive: true });
			const transcriptPath = join(codexSessionsDirectoryPath, `rollout-${nativeSessionId}.jsonl`);
			writeFileSync(
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
			);
			return transcriptPath;
		};
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "collaboration-browser" });
		writeFileSync(join(repository.repositoryPath, "initial.txt"), "隔离协作测试\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const sourcePath = resolve(import.meta.dirname, "../..");
		const evidenceDirectory = join(
			process.env.KANBAN_COLLABORATION_SESSION_BROWSER_EVIDENCE_DIRECTORY ??
				join(fixture.fixtureRootDirectoryPath, "browser-evidence"),
			`${mainAgentId}-to-${collaborationAgentId}-${sessionTransport}`,
		);
		mkdirSync(evidenceDirectory, { recursive: true });
		const fakeAgentBinaryDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-agent-binaries");
		mkdirSync(fakeAgentBinaryDirectory);
		const fakeAgentProgram = String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const agent = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write(agent + ' 2.1.200\n'); process.exit(0); }
const sessionId = process.env.KANBAN_TASK_CONVERSATION_SESSION_ID;
if (!sessionId) { process.stdout.write(agent + ' 2.1.200\n'); process.exit(0); }
const isCollaborator = sessionId.startsWith('task-conversation-session-');
const nativePath = id => path.join(process.cwd(), 'native-session-' + id + '.json');
const readNative = id => JSON.parse(fs.readFileSync(nativePath(id), 'utf8'));
const saveNative = record => fs.writeFileSync(nativePath(record.nativeSessionId), JSON.stringify(record));
const launchPath = path.join(process.cwd(), 'launch-' + sessionId + '.json');
const launch = { agent, args, pid: process.pid, cwd: process.cwd(), sessionId, workspaceTaskId: process.env.KANBAN_TASK_ID, codexConversationStorageHomeDirectoryPath: process.env.CODEX_HOME };
const saveLaunch = record => { Object.assign(launch, record); fs.writeFileSync(launchPath, JSON.stringify(launch)); };
const markPromptSent = () => { if (isCollaborator) fs.writeFileSync(path.join(process.cwd(), 'collaboration-write-proof.txt'), sessionId); };
const freshNative = () => ({ nativeSessionId: randomUUID(), model: 'source-model-after-switch', history: ['主会话已有上下文'], promptCount: 0 });
const forkNative = id => { const record = { ...readNative(id), nativeSessionId: randomUUID(), forkSourceNativeSessionId: id }; saveNative(record); return record; };
saveLaunch({});
if (args.includes('acp')) {
 let active;
 let pendingPrompt;
 let lastAppliedControlCommandSequence = 0;
 const controlCommandPath = path.join(process.cwd(), 'acp-session-control-' + sessionId + '-' + process.pid + '.json');
 const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
 const notifyUpdate = (sessionId, update) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }) + '\n');
 const notify = (sessionId, text) => notifyUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
 setInterval(() => {
  if (!fs.existsSync(controlCommandPath)) return;
  const command = JSON.parse(fs.readFileSync(controlCommandPath, 'utf8'));
  if (command.sequence <= lastAppliedControlCommandSequence) return;
  if (command.action === 'complete_pending_prompt') {
   if (!pendingPrompt || pendingPrompt.promptCount !== command.promptCount) return;
   notify(active.nativeSessionId, '协作答复 ' + active.promptCount);
   reply(pendingPrompt.id, { stopReason: 'end_turn' });
   pendingPrompt = undefined;
  } else if (command.action === 'publish_plan_metadata_update') {
   notifyUpdate(active.nativeSessionId, { sessionUpdate: 'plan', entries: [{ content: '测试用会话计划状态更新', status: 'completed', priority: 'medium' }] });
  } else throw new Error('未知 ACP 测试控制命令');
  lastAppliedControlCommandSequence = command.sequence;
  saveLaunch({ ...active, pendingAcpPromptCount: pendingPrompt?.promptCount ?? null, lastAppliedControlCommandSequence });
 }, 20);
 require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); const params = message.params || {};
  if (message.id === undefined) return;
  switch (message.method) {
   case 'initialize': reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, close: {} } } }); break;
   case 'session/new': active = freshNative(); saveNative(active); saveLaunch(active); reply(message.id, { sessionId: active.nativeSessionId }); break;
   case 'session/fork': active = forkNative(params.sessionId); saveLaunch(active); reply(message.id, { sessionId: active.nativeSessionId }); break;
   case 'session/load': active = readNative(params.sessionId); saveLaunch(active); notify(params.sessionId, active.history[0]); reply(message.id, {}); break;
   case 'session/set_mode': active.mode = params.modeId; saveNative(active); reply(message.id, {}); break;
   case 'session/close': saveNative(active); reply(message.id, {}); break;
   case 'session/prompt':
    active.promptCount++; saveNative(active);
    if (isCollaborator) pendingPrompt = { id: message.id, promptCount: active.promptCount };
    saveLaunch({ ...active, pendingAcpPromptCount: pendingPrompt?.promptCount ?? null });
    markPromptSent(); notify(active.nativeSessionId, '正在处理协作请求');
    if (!isCollaborator) reply(message.id, { stopReason: 'end_turn' });
    break;
   default: reply(message.id, {});
  }
 });
} else {
 const selector = args.includes('--fork') ? '--fork' : args.includes('fork') ? 'fork' : '--resume';
 const sourceId = args[args.indexOf(selector) + 1];
 const shouldFork = args.includes('--fork') || args.includes('fork') || args.includes('--fork-session');
 const record = shouldFork ? forkNative(sourceId) : (args.includes('--resume') || args.includes('resume')) ? readNative(args[args.indexOf(args.includes('resume') ? 'resume' : '--resume') + 1]) : freshNative();
 const modelIndex = args.indexOf('--model'); if (modelIndex >= 0) record.model = args[modelIndex + 1];
 saveNative(record); saveLaunch(record); markPromptSent();
 process.stdout.write('Claude Code · OpenAI Codex\n❯ ');
 process.stdin.resume(); process.stdin.on('data', chunk => process.stdout.write(chunk));
}
setInterval(() => {}, 1000);
`;

		for (const agent of ["claude", "codex", "omp"]) {
			const binaryPath = join(fakeAgentBinaryDirectory, agent);
			writeFileSync(binaryPath, fakeAgentProgram);
			chmodSync(binaryPath, 0o755);
		}
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		const portReservation = createServer();
		await new Promise<void>((done) => portReservation.listen(0, "127.0.0.1", done));
		const address = portReservation.address();
		if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
		const port = address.port;
		await new Promise<void>((done) => portReservation.close(() => done()));
		expect(port).not.toBe(3484);
		Object.assign(environment, {
			PATH: `${fakeAgentBinaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
		});
		const shutdownHook = join(sourcePath, "test/integration/shutdown-ipc-hook.cjs");
		const startRuntime = async () => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", shutdownHook, packagedCliPath, "--port", String(port), "--no-open", "--no-passcode"],
					{
						cwd: repository.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				),
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.on("exit", () => writeFileSync(join(evidenceDirectory, "isolated-runtime.log"), output));
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		let runtime = await startRuntime();
		let browser: Browser | undefined;
		let stopTestTaskSessions: (() => Promise<unknown>) | undefined;
		try {
			const createTaskProcess = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						shutdownHook,
						packagedCliPath,
						"task",
						"create",
						"--title",
						"协作会话隔离验收",
						"--prompt",
						"主会话工作",
						"--agent-id",
						mainAgentId,
						"--worktree-mode",
						"inplace",
						"--project-path",
						repository.repositoryPath,
					],
					{
						cwd: repository.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				),
			);
			let createdTaskOutput = "";
			createTaskProcess.stdout?.on("data", (chunk) => {
				createdTaskOutput += String(chunk);
			});
			expect(await waitForChildProcessExit(createTaskProcess, 45_000)).toBe(true);
			expect(createTaskProcess.exitCode).toBe(0);
			const taskId = (JSON.parse(createdTaskOutput) as { task: { id: string } }).task.id;
			const origin = `http://127.0.0.1:${port}`;
			const client = (workspaceId?: string) =>
				createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpLink({
							url: `${origin}/api/trpc`,
							headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
						}),
					],
				});
			const workspaceId = (await client().projects.list.query()).projects.find(
				(project) => project.path === repository.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("隔离项目未注册");
			const scoped = client(workspaceId);
			stopTestTaskSessions = () => scoped.runtime.stopTaskSession.mutate({ taskId });
			const state = await scoped.workspace.getState.query();
			const backlog = state.board.columns.find((column) => column.id === "backlog");
			const card = backlog?.cards.find((candidate) => candidate.id === taskId);
			if (!backlog || !card) throw new Error("隔离主卡片不存在");
			backlog.cards = backlog.cards.filter((candidate) => candidate.id !== taskId);
			card.startInPlanMode = false;
			card.taskAgentPermissionMode = "bypass_all_permission_prompts";
			state.board.columns.find((column) => column.id === "in_progress")?.cards.push(card);
			await scoped.workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const mainStarted = await scoped.runtime.startTaskSession.mutate({
				taskId,
				agentId: mainAgentId,
				prompt: "主会话工作",
				baseRef: card.baseRef,
				worktreeMode: "inplace",
				startInPlanMode: false,
				requestedAgentSessionTransport: sessionTransport,
			});
			expect(mainStarted.ok).toBe(true);
			await expect
				.poll(() => {
					const filename = join(repository.repositoryPath, `launch-${taskId}.json`);
					return (
						existsSync(filename) && typeof JSON.parse(readFileSync(filename, "utf8")).nativeSessionId === "string"
					);
				})
				.toBe(true);
			const mainLaunch = JSON.parse(
				readFileSync(join(repository.repositoryPath, `launch-${taskId}.json`), "utf8"),
			) as { nativeSessionId: string; codexConversationStorageHomeDirectoryPath?: string };
			// 模拟用户在主会话里切换模型：源记录已更新，但初次启动 argv 仍保留原来的 default。
			const mainNativeFile = join(repository.repositoryPath, `native-session-${mainLaunch.nativeSessionId}.json`);
			const switchedMainState = JSON.parse(readFileSync(mainNativeFile, "utf8"));
			switchedMainState.model = "source-model-after-switch";
			writeFileSync(mainNativeFile, JSON.stringify(switchedMainState));
			if (sessionTransport === "pty_terminal") {
				await scoped.hooks.ingest.mutate({
					taskId,
					workspaceId,
					event: "agent_conversation_session_identity_observed",
					agentNativeConversationSessionIdentity: {
						sourceAgentId: mainAgentId,
						nativeSessionId: mainLaunch.nativeSessionId,
						transcriptPath:
							mainAgentId === "codex"
								? writeCodexNativeConversationTranscriptFixture(
										mainLaunch.nativeSessionId,
										mainLaunch.codexConversationStorageHomeDirectoryPath,
									)
								: null,
						observedAt: Date.now(),
					},
				});
			}
			const requireFromWeb = createRequire(join(sourcePath, "web-ui/package.json"));
			const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
			page.setDefaultTimeout(15_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			const streamedSessionSummariesById = new Map<string, RuntimeTaskSessionSummary>();
			page.on("websocket", (socket) => {
				if (new URL(socket.url()).pathname !== "/api/runtime/ws") return;
				socket.on("framereceived", (frame) => {
					const parsed = runtimeStateStreamTaskSessionsMessageSchema.safeParse(JSON.parse(String(frame.payload)));
					if (!parsed.success || parsed.data.workspaceId !== workspaceId) return;
					for (const summary of parsed.data.summaries) streamedSessionSummariesById.set(summary.taskId, summary);
				});
			});
			const openSessionsModule = async () => {
				if ((page.viewportSize()?.width ?? 1600) >= 768) {
					const firstWorkbenchSlot = page.getByRole("combobox", { name: "工作台格位 1", exact: true });
					await firstWorkbenchSlot.waitFor({ state: "attached" });
					const hideTaskChangesButton = page.getByRole("button", { name: "Hide task changes", exact: true });
					if (await hideTaskChangesButton.isVisible()) await hideTaskChangesButton.click();
					await firstWorkbenchSlot.selectOption("task_sessions");
				} else {
					const mobileNavigationToggle = page.getByRole("button", { name: /^(展开|收起)上方导航与工具$/ });
					await mobileNavigationToggle.waitFor({ state: "visible" });
					if ((await mobileNavigationToggle.getAttribute("aria-expanded")) === "false")
						await mobileNavigationToggle.click();
					await page.getByRole("button", { name: "Sessions", exact: true }).click();
				}
			};
			const mainSessionButton = page.getByRole("button", { name: /^Main session/ });
			const collaborationSessionButton = page.getByRole("button", { name: /^协作会话/ });
			const unreadAnswerIndicator = collaborationSessionButton.getByRole("img", {
				name: "Unread answer",
				exact: true,
			});
			await page.goto(`${origin}/${workspaceId}?task=${taskId}`);
			const onboarding = page.getByRole("dialog").filter({ hasText: "Get started" });
			await onboarding.waitFor({ state: "visible" });
			await onboarding.getByRole("button", { name: "Close", exact: true }).click();
			await openSessionsModule();
			await page
				.getByRole("button", { name: "新建会话", exact: true })
				.click()
				.catch(async (error: unknown) => {
					await page.screenshot({ path: join(evidenceDirectory, "failed-session-form-navigation.png") });
					writeFileSync(join(evidenceDirectory, "failed-session-form-navigation.html"), await page.content());
					writeFileSync(
						join(evidenceDirectory, "failed-session-form-navigation-errors.json"),
						JSON.stringify(pageErrors),
					);
					throw error;
				});
			expect(await page.locator("#task-conversation-session-role").inputValue()).toBe("task_collaborator");
			await page.locator("#task-conversation-session-agent").selectOption(collaborationAgentId);
			expect(await page.locator("#task-conversation-context-source").inputValue()).toBe(
				mainAgentId === collaborationAgentId ? "forked_from_main_current_turn" : "started_from_scratch",
			);
			await page.locator("#task-conversation-initial-question").fill("实现协作部分");
			await page.screenshot({ path: join(evidenceDirectory, "collaboration-create-form.png") });
			await page.getByRole("button", { name: "Create session", exact: true }).click();
			await expect
				.poll(() => existsSync(join(repository.repositoryPath, "collaboration-write-proof.txt")), {
					timeout: 20_000,
				})
				.toBe(true);
			const sideSessionId = readFileSync(join(repository.repositoryPath, "collaboration-write-proof.txt"), "utf8");
			const sideLaunch = JSON.parse(
				readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8"),
			) as {
				agent: string;
				args: string[];
				workspaceTaskId: string;
				nativeSessionId: string;
				forkSourceNativeSessionId?: string;
				history: string[];
				model: string;
				pid: number;
				promptCount: number;
				codexConversationStorageHomeDirectoryPath?: string;
			};
			// ACP 断言读取浏览器实际收到的 task_sessions_updated；getState 只有 PTY 活体与旧持久快照。
			const readSideSessionSummary = async () =>
				sessionTransport === "acp_stdio_subprocess"
					? streamedSessionSummariesById.get(sideSessionId)
					: (await scoped.workspace.getState.query()).sessions[sideSessionId];
			let acpControlCommandSequence = 0;
			const sendControlledAcpSessionCommand = async (
				command:
					| { action: "complete_pending_prompt"; promptCount: number }
					| { action: "publish_plan_metadata_update" },
			) => {
				const sequence = ++acpControlCommandSequence;
				const commandPath = join(
					repository.repositoryPath,
					`acp-session-control-${sideSessionId}-${sideLaunch.pid}.json`,
				);
				writeFileSync(`${commandPath}.pending-write`, JSON.stringify({ ...command, sequence }));
				renameSync(`${commandPath}.pending-write`, commandPath);
				await expect
					.poll(
						() =>
							JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8"))
								.lastAppliedControlCommandSequence,
						{ timeout: 15_000 },
					)
					.toBe(sequence);
			};
			expect(sideLaunch).toMatchObject({ agent: collaborationAgentId, workspaceTaskId: taskId });
			expect(sideLaunch.args).not.toContain("read-only");
			if (mainAgentId === collaborationAgentId) {
				expect(sideLaunch.nativeSessionId).not.toBe(mainLaunch.nativeSessionId);
				expect(sideLaunch.forkSourceNativeSessionId).toBe(mainLaunch.nativeSessionId);
				expect(sideLaunch.history).toContain("主会话已有上下文");
				expect(sideLaunch.model).toBe("source-model-after-switch");
			}
			if (sessionTransport === "pty_terminal") {
				// 写入证明只说明假进程已启动；等运行时完成启动后再发 hook，跨 agent 时身份才会归属正确。
				// Codex 摘要的 pid 属于控制宿主，不能要求它与假 agent 子进程相同。
				await expect.poll(readSideSessionSummary, { timeout: 15_000 }).toMatchObject({
					agentId: collaborationAgentId,
					pid: expect.any(Number),
					startedAt: expect.any(Number),
					liveness: "live",
				});
			}
			const identity = {
				sourceAgentId: collaborationAgentId,
				nativeSessionId: sideLaunch.nativeSessionId,
				transcriptPath:
					collaborationAgentId === "codex"
						? writeCodexNativeConversationTranscriptFixture(
								sideLaunch.nativeSessionId,
								sideLaunch.codexConversationStorageHomeDirectoryPath,
							)
						: null,
				observedAt: Date.now(),
			};
			if (sessionTransport === "pty_terminal") {
				const capturedIdentity = await scoped.hooks.ingest.mutate({
					taskId: sideSessionId,
					workspaceId,
					event: "agent_conversation_session_identity_observed",
					agentNativeConversationSessionIdentity: identity,
				});
				expect(capturedIdentity.ok).toBe(true);
			}
			await mainSessionButton.click();
			if (sessionTransport === "acp_stdio_subprocess") {
				// 协作会话未选中时才结束原生请求，避免创建后的自动选中把首轮答复立即标为已读。
				await expect.poll(readSideSessionSummary, { timeout: 15_000 }).toMatchObject({
					turnOwner: "agent",
					liveness: "live",
					agentConversationPromptSubmissionAcceptance: {
						status: "accepted",
						nativeSessionId: sideLaunch.nativeSessionId,
					},
				});
				await sendControlledAcpSessionCommand({
					action: "complete_pending_prompt",
					promptCount: sideLaunch.promptCount,
				});
			} else {
				// PTY 假 agent 先明确产生已开始的工具活动，不能把刚启动的就绪态当作已完成一轮。
				await scoped.hooks.ingest.mutate({
					taskId: sideSessionId,
					workspaceId,
					event: "to_in_progress",
					metadata: { source: collaborationAgentId, hookEventName: "PostToolUse", toolName: "Bash" },
				});
				await scoped.hooks.ingest.mutate({
					taskId: sideSessionId,
					workspaceId,
					event: "to_review",
					metadata: { source: collaborationAgentId, hookEventName: "Stop" },
				});
			}
			await expect
				.poll(
					async () => (await readSideSessionSummary())?.lastAgentConversationUserHandoffObservation?.observedAtMs,
					{ timeout: 15_000 },
				)
				.toBeGreaterThan(0);
			const afterSideCompletion = await scoped.workspace.getState.query();
			expect(
				afterSideCompletion.board.columns.find((column) =>
					column.cards.some((candidate) => candidate.id === taskId),
				)?.id,
			).toBe("in_progress");
			const completedAnswerHandoff = (await readSideSessionSummary())?.lastAgentConversationUserHandoffObservation;
			expect(completedAnswerHandoff?.observedAtMs).toBeGreaterThan(0);
			await expect.poll(() => unreadAnswerIndicator.isVisible()).toBe(true);
			await collaborationSessionButton.click();
			await expect.poll(() => unreadAnswerIndicator.count()).toBe(0);
			await expect
				.poll(() =>
					page.evaluate(
						(sessionId) =>
							JSON.parse(localStorage.getItem("kanban.task-conversation-session-read-receipts.v1") ?? "{}")[
								sessionId
							],
						sideSessionId,
					),
				)
				.toBe(completedAnswerHandoff?.observedAtMs);
			await mainSessionButton.click();
			// 已读后的计划状态或 hook 元数据更新会推进摘要，但不会产生新的完成答复。
			if (sessionTransport === "acp_stdio_subprocess") {
				await sendControlledAcpSessionCommand({ action: "publish_plan_metadata_update" });
				await expect
					.poll(async () => (await readSideSessionSummary())?.updatedAt)
					.toBeGreaterThan(completedAnswerHandoff?.observedAtMs ?? 0);
			} else {
				await scoped.hooks.ingest.mutate({
					taskId: sideSessionId,
					workspaceId,
					event: "activity",
					metadata: {
						source: collaborationAgentId,
						hookEventName: "PostToolUse",
						activityText: "测试用会话元数据更新",
					},
				});
			}
			const afterMetadataUpdate = await readSideSessionSummary();
			expect(afterMetadataUpdate?.updatedAt).toBeGreaterThan(completedAnswerHandoff?.observedAtMs ?? 0);
			expect(afterMetadataUpdate?.lastAgentConversationUserHandoffObservation).toEqual(completedAnswerHandoff);
			await expect.poll(() => unreadAnswerIndicator.count()).toBe(0);
			const refocusTaskAndExpectNoUnreadAnswer = async () => {
				await page
					.getByRole("button", {
						name: (page.viewportSize()?.width ?? 1600) < 768 ? "返回看板" : "Back to board",
						exact: true,
					})
					.click();
				await page.locator(`[data-task-id="${taskId}"] [data-task-card-title]`).click();
				await openSessionsModule();
				await expect.poll(() => collaborationSessionButton.isVisible()).toBe(true);
				await expect.poll(() => unreadAnswerIndicator.count()).toBe(0);
			};
			await refocusTaskAndExpectNoUnreadAnswer();
			await refocusTaskAndExpectNoUnreadAnswer();
			// 新的一轮经各通道的正常入口开始并完成，确认真正的新回答仍会提示。
			if (sessionTransport === "acp_stdio_subprocess") {
				const nextPrompt = await scoped.runtime.sendTaskChatMessage.mutate({
					taskId: sideSessionId,
					text: "继续协作，生成第二轮答复",
				});
				expect(nextPrompt.ok).toBe(true);
				await expect
					.poll(
						() =>
							JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8"))
								.pendingAcpPromptCount,
						{ timeout: 15_000 },
					)
					.toBe(sideLaunch.promptCount + 1);
				await expect.poll(readSideSessionSummary, { timeout: 15_000 }).toMatchObject({
					turnOwner: "agent",
					liveness: "live",
					agentConversationPromptSubmissionAcceptance: { status: "accepted" },
				});
				await sendControlledAcpSessionCommand({
					action: "complete_pending_prompt",
					promptCount: sideLaunch.promptCount + 1,
				});
			} else {
				await scoped.hooks.ingest.mutate({
					taskId: sideSessionId,
					workspaceId,
					event: "to_in_progress",
					metadata: { source: collaborationAgentId, hookEventName: "PostToolUse", toolName: "Bash" },
				});
				await scoped.hooks.ingest.mutate({
					taskId: sideSessionId,
					workspaceId,
					event: "to_review",
					metadata: { source: collaborationAgentId, hookEventName: "Stop" },
				});
			}
			await expect
				.poll(
					async () => (await readSideSessionSummary())?.lastAgentConversationUserHandoffObservation?.observedAtMs,
					{ timeout: 15_000 },
				)
				.toBeGreaterThan(completedAnswerHandoff?.observedAtMs ?? 0);
			const nextAnswerHandoff = (await readSideSessionSummary())?.lastAgentConversationUserHandoffObservation;
			expect(nextAnswerHandoff?.turnSequence).toBeGreaterThan(completedAnswerHandoff?.turnSequence ?? 0);
			await expect.poll(() => unreadAnswerIndicator.isVisible()).toBe(true);
			await collaborationSessionButton.click();
			await expect.poll(() => unreadAnswerIndicator.count()).toBe(0);
			await expect
				.poll(() =>
					page.evaluate(
						(sessionId) =>
							JSON.parse(localStorage.getItem("kanban.task-conversation-session-read-receipts.v1") ?? "{}")[
								sessionId
							],
						sideSessionId,
					),
				)
				.toBe(nextAnswerHandoff?.observedAtMs);
			await mainSessionButton.click();
			const mainPid = mainStarted.summary?.pid;
			const restartSideSession = async () => {
				if (sessionTransport === "pty_terminal")
					return await scoped.runtime.refreshTaskTerminal.mutate({ taskId: sideSessionId, cols: 100, rows: 30 });
				await scoped.runtime.stopTaskSession.mutate({ taskId: sideSessionId });
				const summary = (await scoped.workspace.getState.query()).sessions[sideSessionId];
				return await scoped.runtime.startTaskSession.mutate({
					taskId: sideSessionId,
					workspaceTaskId: taskId,
					agentId: collaborationAgentId,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
					prompt: "",
					requestedAgentSessionTransport: sessionTransport,
					taskConversationSessionMetadata: summary?.taskConversationSessionMetadata,
					taskAgentPermissionMode: "bypass_all_permission_prompts",
					resumePriorAgentConversationWithoutResendingPrompt: true,
				});
			};
			const restarted = await restartSideSession();
			expect(restarted.ok, JSON.stringify(restarted)).toBe(true);
			expect(restarted.summary?.agentId).toBe(collaborationAgentId);
			await expect
				.poll(
					() =>
						JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8"))
							.nativeSessionId === identity.nativeSessionId,
					{ timeout: 15_000 },
				)
				.toBe(true);
			expect((await scoped.workspace.getState.query()).sessions[taskId]?.pid).toBe(mainPid);
			await page.reload();
			await openSessionsModule();
			await expect.poll(() => page.getByText("协作会话", { exact: true }).count(), { timeout: 15_000 }).toBe(1);
			await expect.poll(() => unreadAnswerIndicator.count()).toBe(0);
			await page.screenshot({ path: join(evidenceDirectory, "collaboration-desktop.png") });
			await page.setViewportSize({ width: 390, height: 844 });
			await openSessionsModule();
			await expect.poll(() => page.getByText("协作会话", { exact: true }).count()).toBe(1);
			await refocusTaskAndExpectNoUnreadAnswer();
			await refocusTaskAndExpectNoUnreadAnswer();
			await page.reload();
			await openSessionsModule();
			await expect.poll(() => collaborationSessionButton.isVisible()).toBe(true);
			await expect.poll(() => unreadAnswerIndicator.count()).toBe(0);
			await page.screenshot({ path: join(evidenceDirectory, "collaboration-mobile.png") });
			expect(pageErrors).toEqual([]);
			await scoped.runtime.stopTaskSession.mutate({ taskId: sideSessionId });
			expect((await scoped.workspace.getState.query()).sessions[taskId]?.pid).toBe(mainPid);
			// 关闭浏览器后重启整个运行时，验证恢复不依赖浏览器内存或仍存在的活体对象。
			await browser.close();
			browser = undefined;
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 15_000)).toBe(true);
			runtime = await startRuntime();
			const afterRuntimeRestart = await scoped.workspace.getState.query();
			expect(afterRuntimeRestart.sessions[sideSessionId]).toMatchObject({
				agentId: collaborationAgentId,
				agentNativeConversationSessionIdentity: { nativeSessionId: identity.nativeSessionId },
				taskConversationSessionMetadata: {
					workspaceTaskId: taskId,
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionLaunchSettings: {
						sessionTransport,
						taskAgentPermissionMode: "bypass_all_permission_prompts",
					},
				},
			});
			const coldRestarted = await restartSideSession();
			expect(coldRestarted.ok).toBe(true);
			await expect
				.poll(
					() =>
						JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8")).pid,
					{ timeout: 15_000 },
				)
				.toBe(coldRestarted.summary?.pid);
			expect(
				JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8"))
					.nativeSessionId,
			).toBe(identity.nativeSessionId);
			await scoped.runtime.stopTaskSession.mutate({ taskId });
			const stoppedState = await scoped.workspace.getState.query();
			expect(stoppedState.sessions[sideSessionId]?.pid).toBeNull();
			expect(stoppedState.sessions[taskId]?.pid).toBeNull();
			writeFileSync(
				join(evidenceDirectory, "browser-result.json"),
				JSON.stringify(
					{
						taskId,
						sideSessionId,
						pageErrors,
						sideLaunch,
						completedAnswerHandoff,
						metadataUpdatedAt: afterMetadataUpdate?.updatedAt,
						nextAnswerHandoff,
						unreadAnswerRefocusAndReloadVerified: true,
						runtimeRestartPersistenceVerified: true,
					},
					null,
					2,
				),
			);
		} catch (error) {
			const failurePage = browser?.contexts()[0]?.pages()[0];
			if (failurePage && !failurePage.isClosed()) {
				await failurePage
					.screenshot({ path: join(evidenceDirectory, "failed-browser-regression.png") })
					.catch(() => undefined);
				const failurePageHtml = await failurePage.content().catch(() => null);
				if (failurePageHtml)
					writeFileSync(join(evidenceDirectory, "failed-browser-regression.html"), failurePageHtml);
			}
			throw error;
		} finally {
			try {
				await stopTestTaskSessions?.();
			} finally {
				await browser?.close();
				runtime.kill("SIGINT");
				await waitForChildProcessExit(runtime, 15_000);
			}
		}
	},
	180_000,
);
