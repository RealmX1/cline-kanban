import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RuntimeBoardData, RuntimeProjectSummary, RuntimeStateStreamMessage } from "../../src/core/api-contract";
import { runtimeStateStreamMessageSchema } from "../../src/core/api-contract";
import { assignCrossProjectTaskSwitcherSections } from "../../src/core/cross-project-recently-active-task-switcher-section-assignment";
import { collectCrossProjectTaskSwitcherEntriesFromBoard } from "../../src/server/cross-project-task-switcher-entry-projection";
import { extractTaskSessionFactsByTaskIdForCrossProjectTaskViews } from "../../src/server/in-progress-task-detail-projection";
import { createRuntimeStateHub } from "../../src/server/runtime-state-hub";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

// 只替换 agent 命令准备；使用真实 PTY、输出检测、状态机、WebSocket 和前后端共用的分组规则。
vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));

const TASK_ID = "codex-model-capacity-stream";
const WORKSPACE_ID = "isolated-capacity-stream";
const EVENTUAL_MESSAGE_WAIT = { timeout: 10_000 };
const CAPACITY_ERROR_PROCESS = `
process.stdin.setRawMode(true);
process.stdin.on("data", (bytes) => {
  if (bytes.includes(101)) {
    process.stdout.write("\\r\\n\\x1b[31m■ Selected model is at ");
    setTimeout(() => process.stdout.write("capacity.\\r\\n  Please try a different model.\\x1b[0m\\r\\n› "), 100);
  } else process.stdout.write("\\r\\n› ");
});
process.stdout.write("READY\\r\\n");
`;

describe("Codex 容量错误的隔离 PTY 与状态推送", { timeout: 45_000 }, () => {
	it.each([true, false])(
		"自动重试为 %s 时全项目 Running 随推送移除，接受新输入后恢复",
		async (autoContinueOnConnectionDropEnabled) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("CODEX_HOME", codexHome);
			vi.stubEnv("CODEX_SQLITE_HOME", codexHome);
			const manager = new TerminalSessionManager();
			const board: RuntimeBoardData = {
				columns: [
					{
						id: "in_progress",
						title: "进行中",
						cards: [
							{
								id: TASK_ID,
								title: "容量错误隔离验证",
								prompt: "执行隔离验证",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							},
						],
					},
				],
			};
			const buildProjectsPayload = async () => {
				const taskCounts = { backlog: 0, in_progress: 1, review: 0, validation: 0, trash: 0 };
				const project: RuntimeProjectSummary = {
					id: WORKSPACE_ID,
					path: fixture.ownedIntegrationProjectsDirectoryPath,
					name: "容量错误隔离项目",
					availability: { status: "available" },
					taskCounts,
					rawColumnTaskCounts: taskCounts,
					inProgressTaskDetails: [],
					gitRemoteOriginUrl: null,
					crossProjectTaskSwitcherEntries: collectCrossProjectTaskSwitcherEntriesFromBoard({
						board,
						sessionFactsByTaskId: extractTaskSessionFactsByTaskIdForCrossProjectTaskViews(
							manager.listSummaries(),
						),
						lastOpenedByUserAtByTaskId: new Map(),
						nowMs: Date.now(),
						activityHorizonMs: 7 * 24 * 60 * 60_000,
					}),
				};
				return { currentProjectId: null, projects: [project] };
			};
			const hub = createRuntimeStateHub({
				workspaceRegistry: {
					// 全项目首页没有当前 workspace；projects_updated 仍须随该项目的 summary 变化推送。
					resolveWorkspaceForStream: async () => ({
						status: "no_registered_project",
						projectId: null,
						workspacePath: null,
					}),
					buildProjectsPayloadUsingCachedRuntimeProjectAvailability: buildProjectsPayload,
					buildWorkspaceStateSnapshot: async () => {
						throw new Error("全项目首页不应读取当前工作区快照");
					},
				},
			});
			hub.trackTerminalManager(WORKSPACE_ID, manager);
			const server = createServer();
			server.on("upgrade", (request, socket, head) => {
				hub.handleUpgrade(request, socket, head, {
					requestedWorkspaceId: null,
					initialWorkspaceMetadataProbeScope: null,
				});
			});
			let client: WebSocket | undefined;
			const messages: RuntimeStateStreamMessage[] = [];
			let terminalOutput = "";
			manager.attach(TASK_ID, {
				onOutput: (bytes) => {
					terminalOutput += bytes.toString("utf8");
				},
			});
			try {
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
				client.on("message", (raw) =>
					messages.push(runtimeStateStreamMessageSchema.parse(JSON.parse(String(raw)))),
				);
				await once(client, "open");
				const started = await manager.startTaskSession({
					taskId: TASK_ID,
					agentId: "codex",
					binary: process.execPath,
					args: ["-e", CAPACITY_ERROR_PROCESS],
					cwd: fixture.ownedIntegrationProjectsDirectoryPath,
					prompt: "执行隔离验证",
					autoContinueOnConnectionDropEnabled,
					codexModelCapacityErrorAutoContinuationEnabled: false,
					env: fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: codexHome,
						CODEX_SQLITE_HOME: codexHome,
					}),
				});
				await vi.waitFor(() => expect(terminalOutput).toContain("READY"), EVENTUAL_MESSAGE_WAIT);
				const latestProjects = () => {
					const message = messages
						.filter((entry) => entry.type === "snapshot" || entry.type === "projects_updated")
						.at(-1);
					return message?.projects ?? [];
				};
				const runningTaskIds = () =>
					assignCrossProjectTaskSwitcherSections({
						entriesInProjects: latestProjects().flatMap((project) =>
							project.crossProjectTaskSwitcherEntries.map((entry) => ({
								workspaceId: project.id,
								projectName: project.name,
								entry,
							})),
						),
						nowMs: Date.now(),
						remainingSectionOrderingMode: "most_recent_conversation_progress_only",
						remainingSectionActivityHorizonMs: 7 * 24 * 60 * 60_000,
					}).runningEntries.map(({ entry }) => entry.taskId);
				await vi.waitFor(() => expect(runningTaskIds()).toEqual([TASK_ID]), EVENTUAL_MESSAGE_WAIT);
				messages.length = 0;
				manager.writeInput(TASK_ID, Buffer.from("e"));
				await vi.waitFor(
					() =>
						expect(manager.getSummary(TASK_ID)).toMatchObject({
							turnOwner: "user",
							liveness: "live",
							userTurnKind: "error",
							reviewReason: "error",
							pid: started.pid,
						}),
					EVENTUAL_MESSAGE_WAIT,
				);
				await vi.waitFor(
					() =>
						expect(latestProjects()[0]?.crossProjectTaskSwitcherEntries[0]).toMatchObject({
							turnOwner: "user",
							liveness: "live",
							userTurnKind: "error",
						}),
					EVENTUAL_MESSAGE_WAIT,
				);
				expect(runningTaskIds()).toEqual([]);
				expect(messages.some((message) => message.type === "projects_updated")).toBe(true);
				if (started.pid === null) throw new Error("错误交棒后丢失了原进程");
				process.kill(started.pid, 0);
				manager.writeInput(TASK_ID, Buffer.from("\r"));
				await vi.waitFor(() => expect(terminalOutput).toContain("› "), EVENTUAL_MESSAGE_WAIT);
				expect(manager.getSummary(TASK_ID)?.turnOwner).toBe("user");
				manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
					sourceAgentId: "codex",
					nativeSessionId: "isolated-native",
					transcriptPath: null,
					observedAt: Date.now(),
				});
				manager.confirmAcceptedAgentConversationInput(TASK_ID, {
					observedAtMs: Date.now(),
					eventId: "codex:isolated-native:next-turn:user",
					nativeSessionId: "isolated-native",
					runtimeSessionIncarnationId: started.runtimeSessionIncarnationId ?? "",
					acceptedNativeAgentTurnIsInProgress: true,
				});
				await vi.waitFor(() => expect(runningTaskIds()).toEqual([TASK_ID]), EVENTUAL_MESSAGE_WAIT);
				expect(manager.getSummary(TASK_ID)?.pid).toBe(started.pid);
			} finally {
				await manager.forceStopTaskSession(TASK_ID);
				manager.dispose();
				client?.terminate();
				await hub.close();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
				vi.unstubAllEnvs();
			}
		},
	);
});
