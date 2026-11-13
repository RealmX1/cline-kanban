import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as waitForNextObservation } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { loadWorkspaceContext, loadWorkspaceState, mutateWorkspaceState } from "../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requestedObservationDurationMs = Number(process.env.KANBAN_RESOURCE_SOAK_DURATION_MS ?? 0);
const observationEvidenceDirectory = process.env.KANBAN_RESOURCE_SOAK_EVIDENCE_DIRECTORY;
const executeReadOnlyProcessObservation = promisify(execFile);
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe("打包运行时固定工作量资源观察", () => {
	it.skipIf(!requestedObservationDurationMs || !observationEvidenceDirectory)(
		"固定一百张卡、每三十秒一次变更和一／四客户端切换，记录内存与清理结果",
		async () => {
			if (
				!observationEvidenceDirectory ||
				!Number.isFinite(requestedObservationDurationMs) ||
				requestedObservationDurationMs < 30_000 ||
				requestedObservationDurationMs > 1_800_000
			)
				throw new Error("观察必须指定持久证据目录，时长介于三十秒和三十分钟");
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const clients: WebSocket[] = [];
			let boundedRuntimeOutput = "";
			try {
				await mkdir(observationEvidenceDirectory, { recursive: true });
				const repository = fixture.createNonBareRepository({
					repositoryDirectoryName: "fixed-workload-resource-observation",
				});
				vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
				vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"));
				vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"));
				await loadWorkspaceState(repository.repositoryPath);
				const context = await loadWorkspaceContext(repository.repositoryPath);
				await mutateWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards:
								column.id === "backlog"
									? Array.from({ length: 100 }, (_, index) => ({
											id: `resource-observation-${index}`,
											title: `固定卡片 ${index}`,
											prompt: "固定合成语料".repeat(100),
											baseRef: "main",
											startInPlanMode: false,
											createdAt: index + 1,
											updatedAt: index + 1,
										}))
									: [],
						})),
					},
					value: undefined,
				}));
				const environment = fixture.createIsolatedChildProcessEnvironment();
				for (const key of Object.keys(environment))
					if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key))
						delete environment[key];
				environment.CODEX_HOME = process.env.CODEX_HOME;
				environment.CODEX_SQLITE_HOME = process.env.CODEX_SQLITE_HOME;
				environment.KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR = join(
					observationEvidenceDirectory,
					"isolated-runtime-journals",
				);
				const child = children.register(
					spawn(process.execPath, [resolve("dist/cli.js"), "--port", "auto", "--no-open", "--no-passcode"], {
						cwd: repository.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe"],
					}),
				);
				const retainRuntimeOutput = (chunk: Buffer) => {
					boundedRuntimeOutput = `${boundedRuntimeOutput}${String(chunk)}`.slice(-64 * 1024);
				};
				child.stdout?.on("data", retainRuntimeOutput);
				child.stderr?.on("data", retainRuntimeOutput);
				const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(child);
				let receivedFrameCount = 0;
				let receivedApplicationPayloadBytes = 0;
				const connectClient = async () => {
					const streamUrl = new URL("/api/runtime/ws", runtimeUrl);
					streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
					streamUrl.hostname = "127.0.0.1";
					streamUrl.searchParams.set("workspaceId", context.workspaceId);
					streamUrl.searchParams.set("stateProtocolVersion", "2");
					const client = new WebSocket(streamUrl);
					clients.push(client);
					client.on("error", () => {});
					client.on("message", (payload) => {
						receivedFrameCount++;
						receivedApplicationPayloadBytes += Buffer.byteLength(String(payload));
					});
					await new Promise<void>((done, reject) => {
						const deadline = setTimeout(() => reject(new Error("隔离状态流连接超时")), 30_000);
						client.once("message", () => {
							clearTimeout(deadline);
							done();
						});
						client.once("error", (error) => {
							clearTimeout(deadline);
							reject(error);
						});
					});
				};
				const startedAtEpochMs = Date.now();
				let observationIndex = 0;
				while (Date.now() - startedAtEpochMs < requestedObservationDurationMs) {
					const desiredClientCount = Math.floor(observationIndex / 10) % 2 ? 4 : 1;
					while (clients.length > desiredClientCount) clients.pop()?.terminate();
					while (clients.length < desiredClientCount) await connectClient();
					await mutateWorkspaceState(
						repository.repositoryPath,
						TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
						(state) => ({
							board: {
								...state.board,
								columns: state.board.columns.map((column) => ({
									...column,
									cards: column.cards.map((card, index) =>
										index === 0 ? { ...card, title: `固定变化 ${observationIndex}` } : card,
									),
								})),
							},
							value: undefined,
						}),
					);
					expect(child.exitCode).toBeNull();
					expect(child.signalCode).toBeNull();
					const { stdout } = await executeReadOnlyProcessObservation("ps", [
						"-p",
						String(child.pid),
						"-o",
						"rss=,time=",
					]);
					await appendFile(
						join(observationEvidenceDirectory, "fixed-workload-resource-samples.jsonl"),
						`${JSON.stringify({
							observedAtEpochMs: Date.now(),
							elapsedMs: Date.now() - startedAtEpochMs,
							observationIndex,
							ownedRuntimePid: child.pid,
							clientCount: clients.length,
							receivedFrameCount,
							receivedApplicationPayloadBytes,
							rssKiBAndCumulativeCpuTime: stdout.trim(),
						})}\n`,
					);
					observationIndex++;
					await waitForNextObservation(
						Math.min(30_000, Math.max(0, requestedObservationDurationMs - (Date.now() - startedAtEpochMs))),
					);
				}
				expect(receivedFrameCount).toBeGreaterThan(0);
				await appendFile(
					join(observationEvidenceDirectory, "fixed-workload-resource-result.jsonl"),
					`${JSON.stringify({
						status: "completed",
						observedDurationMs: Date.now() - startedAtEpochMs,
						observationIndex,
						receivedFrameCount,
					})}\n`,
				);
			} finally {
				for (const client of clients) client.terminate();
				await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
				await writeFile(join(observationEvidenceDirectory, "bounded-runtime-output.log"), boundedRuntimeOutput);
				vi.unstubAllEnvs();
				fixture.cleanup();
			}
		},
		requestedObservationDurationMs + 120_000,
	);
});
