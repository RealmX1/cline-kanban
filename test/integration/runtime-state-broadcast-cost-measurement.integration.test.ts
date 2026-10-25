import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../src/config/runtime-config";
import {
	appendDiagnosticEventToRotatingJsonlJournal,
	DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR,
	waitForPendingDiagnosticEventJournalWrites,
} from "../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import {
	createRuntimeStateBroadcastCostRecorder,
	type RuntimeStateBroadcastCostWindowSample,
} from "../../src/diagnostics/runtime-state-broadcast-cost-recorder";
import type * as NotificationLifecycleArchive from "../../src/notifications/notification-lifecycle-archive";
import { createRuntimeStateHub } from "../../src/server/runtime-state-hub";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
import {
	getPersistedWorkspaceBoardFilePathById,
	loadWorkspaceContext,
	loadWorkspaceState,
} from "../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

// 本对照测 registry 的真实热缓存构建及真实 WS 帧，隔离不属于 T4 的 git 元数据后台探测。
vi.mock("../../src/server/workspace-metadata-monitor", () => ({
	createWorkspaceMetadataMonitor: () => ({
		readCachedWorkspaceMetadataSnapshot: () => null,
		connectWorkspace: async () => {},
		updateWorkspaceState: async () => {},
		updateSubscriberProbeScope: async () => {},
		disconnectWorkspace: () => {},
		disposeWorkspace: () => {},
		close: () => {},
	}),
}));
vi.mock("../../src/notifications/notification-lifecycle-archive", async (importOriginal) => ({
	...(await importOriginal<typeof NotificationLifecycleArchive>()),
	getNotificationLifecycleArchive: () => ({ recentReady: async () => [] }),
}));

async function openMeasurementClient(url: string) {
	const socket = new WebSocket(url);
	let receivedMessageCount = 0;
	const listeners = new Set<() => void>();
	socket.on("message", () => {
		receivedMessageCount += 1;
		for (const listener of listeners) listener();
	});
	const waitForMessageCount = async (expected: number): Promise<void> => {
		if (receivedMessageCount >= expected) return;
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				if (receivedMessageCount < expected) return;
				clearTimeout(timer);
				listeners.delete(finish);
				resolve();
			};
			const timer = setTimeout(() => {
				listeners.delete(finish);
				reject(new Error(`隔离 WS 未收到预期帧：${receivedMessageCount}/${expected}`));
			}, 15_000);
			listeners.add(finish);
			finish();
		});
	};
	socket.on("error", () => {});
	try {
		await waitForMessageCount(1);
	} catch (error) {
		socket.terminate();
		throw error;
	}
	return { socket, waitForMessageCount, count: () => receivedMessageCount };
}

describe("隔离广播成本对照", { timeout: 300_000 }, () => {
	it.runIf(Boolean(process.env.KANBAN_BROADCAST_COST_MEASUREMENT_EVIDENCE_DIRECTORY))(
		"固定语料对照记录器开关、项目规模、快照大小及客户端数，并核对成本计数",
		async () => {
			const evidenceDirectory = process.env.KANBAN_BROADCAST_COST_MEASUREMENT_EVIDENCE_DIRECTORY;
			if (!evidenceDirectory) throw new Error("缺少持久测量目录");
			await mkdir(evidenceDirectory, { recursive: true });
			const measurementRunId = randomUUID();
			const fixture = createIsolatedGitTestWorkspaceFixture();
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
			vi.stubEnv(
				DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR,
				join(evidenceDirectory, "isolated-diagnostic-event-journals", measurementRunId),
			);
			let registeredProjectCount = 0;
			let firstProjectPath = "";
			try {
				for (const projectCount of [1, 10, 30]) {
					while (registeredProjectCount < projectCount) {
						const projectPath = fixture.createNonBareRepository({
							repositoryDirectoryName: `broadcast-project-${registeredProjectCount}`,
						}).repositoryPath;
						firstProjectPath ||= projectPath;
						const state = await loadWorkspaceState(projectPath);
						const context = await loadWorkspaceContext(projectPath);
						const backlog = state.board.columns.find((column) => column.id === "backlog");
						if (!backlog) throw new Error("隔离看板缺少 Backlog");
						for (let card = 0; card < 20; card += 1)
							backlog.cards.push({
								id: `card-${card}`,
								title: `固定卡片${card}`,
								prompt: "固定合成语料",
								baseRef: "main",
								startInPlanMode: true,
								createdAt: 1,
								updatedAt: 1,
							});
						await mkdir(dirname(getPersistedWorkspaceBoardFilePathById(context.workspaceId)), {
							recursive: true,
						});
						await writeFile(
							getPersistedWorkspaceBoardFilePathById(context.workspaceId),
							JSON.stringify(state.board),
						);
						registeredProjectCount += 1;
					}
					const context = await loadWorkspaceContext(firstProjectPath);
					const firstState = await loadWorkspaceState(firstProjectPath);
					const promptTargetBytes =
						projectCount === 1 ? 64 * 1024 : projectCount === 10 ? 1024 * 1024 : 4 * 1024 * 1024;
					firstState.board.columns[0].cards[0].prompt = "固".repeat(Math.floor(promptTargetBytes / 3));
					await writeFile(
						getPersistedWorkspaceBoardFilePathById(context.workspaceId),
						JSON.stringify(firstState.board),
					);
					const registry = await createWorkspaceRegistry({
						cwd: fixture.isolatedHomeDirectoryPath,
						loadGlobalRuntimeConfig,
						loadRuntimeConfig,
						hasGitRepository: () => false,
						inspectRuntimeProjectAvailability: async () => ({ status: "available" }),
					});
					try {
						for (const clientCount of [0, 1, 4]) {
							for (const scenario of clientCount === 0
								? (["no_clients"] as const)
								: (["unchanged_projects", "changing_projects", "workspace_snapshot"] as const)) {
								for (let pair = 0; pair < 5; pair += 1) {
									// 交替 AB / BA，避免一直把冷／热顺序交给同一档。
									for (const enabled of pair % 2 === 0 ? [false, true] : [true, false]) {
										const windows: RuntimeStateBroadcastCostWindowSample[] = [];
										const recorder = enabled
											? createRuntimeStateBroadcastCostRecorder({
													writeWindowSample: (sample) => {
														windows.push(sample);
														appendDiagnosticEventToRotatingJsonlJournal(
															"runtime-state-broadcast-cost-window-sample",
															{ ...sample },
														);
													},
												})
											: null;
										let revision = 0;
										const hub = createRuntimeStateHub({
											runtimeStateBroadcastCostRecorder: recorder,
											workspaceRegistry: {
												resolveWorkspaceForStream: async () => ({
													status: "available",
													projectId: context.workspaceId,
													workspacePath: firstProjectPath,
												}),
												buildWorkspaceStateSnapshot: registry.buildWorkspaceStateSnapshot,
												buildProjectsPayloadUsingCachedRuntimeProjectAvailability: async (preferred) => {
													const payload =
														await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(
															preferred,
														);
													if (scenario === "changing_projects")
														payload.projects[0].name = `固定变化${revision++}`;
													return payload;
												},
											},
										});
										const server = createServer();
										const clients: Awaited<ReturnType<typeof openMeasurementClient>>[] = [];
										try {
											server.on("upgrade", (request, socket, head) =>
												hub.handleUpgrade(request, socket, head, {
													requestedWorkspaceId: context.workspaceId,
													initialWorkspaceMetadataProbeScope: null,
												}),
											);
											server.listen(0, "127.0.0.1");
											await once(server, "listening");
											const port = (server.address() as AddressInfo).port;
											for (let index = 0; index < clientCount; index += 1)
												clients.push(await openMeasurementClient(`ws://127.0.0.1:${port}/api/runtime/ws`));
											const broadcast = () =>
												scenario === "workspace_snapshot"
													? hub.broadcastRuntimeWorkspaceStateUpdated(
															context.workspaceId,
															firstProjectPath,
														)
													: hub.broadcastRuntimeProjectsUpdated(context.workspaceId);
											for (let warmup = 0; warmup < 3; warmup += 1) await broadcast();
											await Promise.all(
												clients.map((client) =>
													client.waitForMessageCount(
														1 +
															(scenario === "changing_projects" || scenario === "workspace_snapshot"
																? 3
																: 1),
													),
												),
											);
											const initialReceivedCounts = clients.map((client) => client.count());
											recorder?.flushWindow();
											windows.length = 0;
											await waitForPendingDiagnosticEventJournalWrites();
											const iterations = clientCount === 0 ? 200 : 12;
											const cpuStarted = process.cpuUsage();
											const wallStarted = performance.now();
											for (let index = 0; index < iterations; index += 1) await broadcast();
											const broadcastLoopWallDurationMs = performance.now() - wallStarted;
											const broadcastLoopCpuUsage = process.cpuUsage(cpuStarted);
											const flushStarted = performance.now();
											recorder?.flushWindow();
											await waitForPendingDiagnosticEventJournalWrites();
											const journalFlushWallDurationMs = performance.now() - flushStarted;
											if (scenario === "changing_projects" || scenario === "workspace_snapshot") {
												await Promise.all(
													clients.map((client, index) =>
														client.waitForMessageCount(initialReceivedCounts[index] + iterations),
													),
												);
											}
											const operationCosts =
												windows[0]?.operations[
													scenario === "workspace_snapshot"
														? "workspace_state_updated"
														: "projects_updated"
												];
											if (operationCosts) {
												expect(operationCosts.completedOperationCount).toBe(iterations);
												expect(operationCosts.outcomeCounts.failed).toBe(0);
												expect(operationCosts.webSocketAcceptedSendCount).toBe(
													scenario === "changing_projects" || scenario === "workspace_snapshot"
														? iterations * clientCount
														: 0,
												);
											}
											await appendFile(
												join(evidenceDirectory, "raw-measurements.jsonl"),
												`${JSON.stringify({ measurementRunId, projectCount, promptTargetBytes, clientCount, scenario, pair, enabled, iterations, broadcastLoopWallDurationMs, broadcastLoopCpuUsage, journalFlushWallDurationMs, windowSerializedBytes: enabled ? Buffer.byteLength(JSON.stringify(windows[0])) : 0, operationCosts })}\n`,
											);
										} finally {
											for (const client of clients) client.socket.terminate();
											await hub.close();
											await new Promise<void>((resolve) => server.close(() => resolve()));
										}
									}
								}
							}
						}
					} finally {
						for (const workspace of registry.listManagedWorkspaces()) workspace.terminalManager.dispose();
					}
				}
			} finally {
				await waitForPendingDiagnosticEventJournalWrites();
				vi.unstubAllEnvs();
			}
		},
	);
});
