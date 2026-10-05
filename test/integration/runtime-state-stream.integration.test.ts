import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type {
	RuntimeBoardData,
	RuntimeHookIngestResponse,
	RuntimeProjectAddResponse,
	RuntimeProjectPermanentDeletionPreviewResponse,
	RuntimeProjectPermanentDeletionResult,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartResponse,
	RuntimeStateStreamMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core/api-contract";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import type {
	LoadSensitiveDeadlineAnnotatingTestContext,
	LoadSensitiveWallClockTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromHere = createRequire(import.meta.url);

// 用例超时、断言失败、启动等待失败时 finally 里的 stop() 都可能来不及跑；afterEach 先于 fixture 的
// onTestFinished cleanup 执行，保证「先杀 runtime、再删隔离 HOME」。
const spawnedChildProcessRegistrySigkilledAfterEachTest = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

// 「终会到达」的单档等待（WS 连接、流消息）：原先 5s 在高负载下会被 runtime 冷启动后的首次快照构建吃掉；
// 这些断言判的是「最终收到了什么」，放宽不损失判别力。
const RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS = 15_000;

// 本文件用例最多冷启动两次 runtime，原用例预算最高 45s；另加两次优雅关停的硬档（各含 SIGKILL 确认 5s）。
// 统一挂在 describe 上：给 it(...) 第三参传标识符会让 biome 放弃 test-call 排版、重缩进整个用例体。
const RUNTIME_STATE_STREAM_TEST_TIMEOUT_MS = computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
	runtimeColdStartCount: 2,
	testBodyTimeoutBudgetMs: 45_000 + 2 * (30_000 + 5_000),
});

interface RuntimeStreamClient {
	socket: WebSocket;
	waitForMessage: (
		predicate: (message: RuntimeStateStreamMessage) => boolean,
		timeoutMs?: number,
	) => Promise<RuntimeStateStreamMessage>;
	collectFor: (durationMs: number) => Promise<RuntimeStateStreamMessage[]>;
	close: () => Promise<void>;
}

// 本文件的 runtime 共用同一个按文件隔离的关系账本，而 task id 对全局 task 身份登记簿唯一（dd2db Y-EVENT-12）：
// 不同用例的 workspace 不能复用同一个 id，每次建 board 取一个本文件内唯一的 id。
let createBoardTaskIdSequenceWithinThisTestFile = 0;

function createBoard(title: string): RuntimeBoardData {
	const now = Date.now();
	createBoardTaskIdSequenceWithinThisTestFile += 1;
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: `runtime-state-stream-board-task-${createBoardTaskIdSequenceWithinThisTestFile}`,
						title: title,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: now,
						updatedAt: now,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function createReviewBoard(taskId: string, title: string, existingTrashTaskId?: string): RuntimeBoardData {
	const now = Date.now();
	const trashCards = existingTrashTaskId
		? [
				{
					id: existingTrashTaskId,
					title: "Already trashed task",
					prompt: "Already trashed task",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: now,
					updatedAt: now,
				},
			]
		: [];
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: taskId,
						title: title,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: now,
						updatedAt: now,
					},
				],
			},
			{ id: "trash", title: "Done", cards: trashCards },
		],
	};
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

function commitAllRepositoryFiles(
	repository: IsolatedGitTestRepository,
	workingDirectoryPath: string,
	message: string,
): string {
	repository.runGit(["add", "."], { workingDirectoryPath });
	repository.runGit(["commit", "--quiet", "-m", message], { workingDirectoryPath });
	return repository.runGit(["rev-parse", "HEAD"], { workingDirectoryPath }).stdout.trim();
}

interface RuntimeStateStreamIntegrationFixture {
	gitFixture: IsolatedGitTestWorkspaceFixture;
	homeDirectoryPath: string;
	createRepository(repositoryDirectoryName: string): IsolatedGitTestRepository;
	createNonGitDirectory(directoryName: string): string;
	cleanup(): void;
}

function createRuntimeStateStreamIntegrationFixture(): RuntimeStateStreamIntegrationFixture {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	return {
		gitFixture,
		homeDirectoryPath: gitFixture.isolatedHomeDirectoryPath,
		createRepository: (repositoryDirectoryName) =>
			gitFixture.createNonBareRepository({ repositoryDirectoryName, initialBranchName: "main" }),
		createNonGitDirectory(directoryName) {
			const directoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, directoryName);
			mkdirSync(directoryPath);
			return directoryPath;
		},
		cleanup() {
			gitFixture.cleanup();
		},
	};
}

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function getShutdownSignal(): NodeJS.Signals {
	return process.platform === "win32" ? "SIGTERM" : "SIGINT";
}

async function requestGracefulShutdown(childProcess: ChildProcess): Promise<void> {
	if (typeof childProcess.send !== "function" || !childProcess.connected) {
		childProcess.kill(getShutdownSignal());
		return;
	}

	await new Promise<void>((resolveSend) => {
		childProcess.send({ type: "kanban.shutdown" }, (error) => {
			if (error) {
				childProcess.kill(getShutdownSignal());
			}
			resolveSend();
		});
	});
}

// runtime 收到 shutdown IPC 后的优雅关停：超过软档只告警；超过硬档时 SIGKILL 并确认退出。
const RUNTIME_GRACEFUL_SHUTDOWN_EXIT_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "runtime 收到 shutdown IPC 后优雅退出（超过硬档时退化为 SIGKILL）",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};

interface StopKanbanServerOptions {
	// 断言「优雅关停之后仍保留」的用例必须真的走完优雅关停：退化成 SIGKILL 时关停清理根本没跑，
	// 「保留」会平凡成立、用例空转通过，所以这类用例在退化时直接失败。
	// 产品侧强退（src/cli.ts 的 10s 关停兜底、onShutdown 抛错、第二个信号）同理：子进程照样在硬档内退出，
	// 只能凭关停期间的 stderr 文案识别，见 assertRuntimeShutdownCompletedGracefullyRatherThanProductForcedExit。
	requireGracefulShutdownExit?: boolean;
}

// src/cli.ts 的关停指示器在 stderr 是 pipe（非 TTY）时写纯文本：开始写「Cleaning up...」，结局只写 done /
// interrupted / failed 三者之一（互斥：先到的结局把指示器置为非运行态，后到的 stop 是 no-op）。
const RUNTIME_GRACEFUL_SHUTDOWN_COMPLETED_STDERR_MARKER = "Cleanup done.";
// 产品侧关停失败 / 强退路径写到 stderr 的文案。退出状态不能当判据：installGracefulShutdownHandlers 在
// 已记下关停信号时，兜底超时 / 关停抛错的 finalizeExit(1) 也是 reraise 该信号，与优雅完成同为被 SIGINT 结束。
const RUNTIME_SHUTDOWN_FAILED_OR_FORCED_EXIT_STDERR_MARKERS = [
	"Forced exit after shutdown timeout",
	"Shutdown failed:",
	"Forced exit on second signal",
	"Cleanup interrupted.",
	"Cleanup failed.",
] as const;
// 子进程 exit 之后 stdio 可能还没读完（Node 的 'exit' 先于 'close'），判定前等 'close'。正常是毫秒级；
// 上限借用 stop 预算里「SIGKILL 确认 5s」那一格——走到这里说明进程已在硬档内自行退出，没有用到 SIGKILL 确认。
const RUNTIME_CHILD_PROCESS_STDIO_CLOSE_AFTER_EXIT_WAIT_TIMEOUT_MS = 5_000;
const RUNTIME_SHUTDOWN_OUTPUT_TAIL_CHARACTER_LIMIT_FOR_FAILURE_MESSAGE = 4_000;

interface RuntimeChildProcessOutputCapturedDuringShutdown {
	readCapturedStderr(): string;
	describeCapturedOutputForFailureMessage(): string;
	waitForChildProcessStdioClosed(timeoutMs: number): Promise<boolean>;
	stopCapturing(): void;
}

function keepOutputTailForFailureMessage(output: string): string {
	return output.length <= RUNTIME_SHUTDOWN_OUTPUT_TAIL_CHARACTER_LIMIT_FOR_FAILURE_MESSAGE
		? output
		: `…(截断，只保留末尾 ${RUNTIME_SHUTDOWN_OUTPUT_TAIL_CHARACTER_LIMIT_FOR_FAILURE_MESSAGE} 字符)${output.slice(-RUNTIME_SHUTDOWN_OUTPUT_TAIL_CHARACTER_LIMIT_FOR_FAILURE_MESSAGE)}`;
}

// 必须在发出 shutdown 请求之前开始收集，否则会漏掉「Cleaning up...」之类的早期关停输出。
function startCapturingRuntimeChildProcessOutputDuringShutdown(
	child: ChildProcess,
): RuntimeChildProcessOutputCapturedDuringShutdown {
	let capturedStdout = "";
	let capturedStderr = "";
	let didChildProcessStdioClose = false;
	const handleStdoutData = (chunk: Buffer) => {
		capturedStdout += chunk.toString();
	};
	const handleStderrData = (chunk: Buffer) => {
		capturedStderr += chunk.toString();
	};
	const childProcessStdioClosed = new Promise<void>((resolveClosed) => {
		child.once("close", () => {
			didChildProcessStdioClose = true;
			resolveClosed();
		});
	});
	child.stdout?.on("data", handleStdoutData);
	child.stderr?.on("data", handleStderrData);
	return {
		readCapturedStderr: () => capturedStderr,
		describeCapturedOutputForFailureMessage: () =>
			`关停期间 runtime 子进程输出（exitCode=${String(child.exitCode)} signal=${String(child.signalCode)} stdio 已关闭=${String(didChildProcessStdioClose)}）：\nstdout:\n${keepOutputTailForFailureMessage(capturedStdout)}\nstderr:\n${keepOutputTailForFailureMessage(capturedStderr)}`,
		async waitForChildProcessStdioClosed(timeoutMs) {
			if (didChildProcessStdioClose) {
				return true;
			}
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const didCloseInTime = await Promise.race([
				childProcessStdioClosed.then(() => true),
				new Promise<boolean>((resolveTimeout) => {
					timeoutId = setTimeout(() => resolveTimeout(false), timeoutMs);
				}),
			]);
			clearTimeout(timeoutId);
			return didCloseInTime;
		},
		stopCapturing() {
			child.stdout?.removeListener("data", handleStdoutData);
			child.stderr?.removeListener("data", handleStderrData);
		},
	};
}

// 调用前子进程已在两档期限内自行退出。正向要求「Cleanup done.」：未知的异常结局同样缺这条文案；
// 反向拒绝已知的失败 / 强退文案，命中时失败消息能直接指出走了哪条产品路径。
async function assertRuntimeShutdownCompletedGracefullyRatherThanProductForcedExit(
	runtimeOutputCapturedDuringShutdown: RuntimeChildProcessOutputCapturedDuringShutdown,
): Promise<void> {
	await runtimeOutputCapturedDuringShutdown.waitForChildProcessStdioClosed(
		RUNTIME_CHILD_PROCESS_STDIO_CLOSE_AFTER_EXIT_WAIT_TIMEOUT_MS,
	);
	const capturedStderr = runtimeOutputCapturedDuringShutdown.readCapturedStderr();
	const matchedFailedOrForcedExitMarkers = RUNTIME_SHUTDOWN_FAILED_OR_FORCED_EXIT_STDERR_MARKERS.filter((marker) =>
		capturedStderr.includes(marker),
	);
	const didReportGracefulShutdownCompleted = capturedStderr.includes(
		RUNTIME_GRACEFUL_SHUTDOWN_COMPLETED_STDERR_MARKER,
	);
	if (didReportGracefulShutdownCompleted && matchedFailedOrForcedExitMarkers.length === 0) {
		return;
	}
	throw new Error(
		`runtime 进程虽已退出，但没有优雅完成关停（产品侧失败 / 强退路径）：命中失败或强退文案 [${matchedFailedOrForcedExitMarkers.join(", ")}]；stderr ${didReportGracefulShutdownCompleted ? "含" : "缺少"}「${RUNTIME_GRACEFUL_SHUTDOWN_COMPLETED_STDERR_MARKER}」。\n${runtimeOutputCapturedDuringShutdown.describeCapturedOutputForFailureMessage()}`,
	);
}

async function startKanbanServer(input: {
	testContext: LoadSensitiveDeadlineAnnotatingTestContext;
	cwd: string;
	gitFixture: IsolatedGitTestWorkspaceFixture;
	port: number;
	extraArgs?: string[];
}): Promise<{
	runtimeUrl: string;
	stop: (options?: StopKanbanServerOptions) => Promise<void>;
}> {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	const shutdownIpcHookPath = resolveShutdownIpcHookPath();
	const tsxLoaderImportSpecifier = resolveTsxLoaderImportSpecifier();
	const child = spawn(
		process.execPath,
		[
			"--require",
			shutdownIpcHookPath,
			"--import",
			tsxLoaderImportSpecifier,
			cliEntrypoint,
			"--no-open",
			...(input.extraArgs ?? []),
		],
		{
			cwd: input.cwd,
			env: input.gitFixture.createIsolatedChildProcessEnvironment({
				KANBAN_RUNTIME_PORT: String(input.port),
			}),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	spawnedChildProcessRegistrySigkilledAfterEachTest.register(child);
	const { runtimeUrl } = await waitForRuntimeServerStartupBannerOrSigkillChild(child);
	return {
		runtimeUrl,
		stop: async (options = {}) => {
			if (hasChildProcessExited(child)) {
				return;
			}
			const runtimeOutputCapturedDuringShutdown = startCapturingRuntimeChildProcessOutputDuringShutdown(child);
			try {
				await requestGracefulShutdown(child);
				try {
					await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
						input.testContext,
						child,
						RUNTIME_GRACEFUL_SHUTDOWN_EXIT_TWO_TIER_DEADLINE,
						{
							describeChildProcessOutputForFailureMessage:
								runtimeOutputCapturedDuringShutdown.describeCapturedOutputForFailureMessage,
						},
					);
				} catch (gracefulShutdownFailure) {
					// 子进程此时已被 SIGKILL 并确认退出，annotation 也已写下；只有依赖优雅关停的用例才判失败。
					if (options.requireGracefulShutdownExit) {
						throw gracefulShutdownFailure;
					}
					if (!hasChildProcessExited(child)) {
						throw new Error("Timed out stopping kanban test server process.");
					}
				}
				if (options.requireGracefulShutdownExit) {
					await assertRuntimeShutdownCompletedGracefullyRatherThanProductForcedExit(
						runtimeOutputCapturedDuringShutdown,
					);
				}
			} finally {
				runtimeOutputCapturedDuringShutdown.stopCapturing();
			}
		},
	};
}

async function connectRuntimeStream(url: string): Promise<RuntimeStreamClient> {
	const socket = new WebSocket(url);
	const emitter = new EventEmitter();
	const queue: RuntimeStateStreamMessage[] = [];

	socket.on("message", (raw) => {
		try {
			const parsed = JSON.parse(String(raw)) as RuntimeStateStreamMessage;
			queue.push(parsed);
			emitter.emit("message");
		} catch {
			// Ignore malformed messages in tests.
		}
	});

	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timeoutId = setTimeout(() => {
			rejectOpen(new Error(`Timed out connecting websocket: ${url}`));
		}, RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS);
		socket.once("open", () => {
			clearTimeout(timeoutId);
			resolveOpen();
		});
		socket.once("error", (error) => {
			clearTimeout(timeoutId);
			rejectOpen(error);
		});
	});

	const waitForMessage = async (
		predicate: (message: RuntimeStateStreamMessage) => boolean,
		timeoutMs = RUNTIME_STATE_STREAM_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
	): Promise<RuntimeStateStreamMessage> =>
		await new Promise((resolveMessage, rejectMessage) => {
			let settled = false;
			const tryResolve = () => {
				if (settled) {
					return;
				}
				const index = queue.findIndex(predicate);
				if (index < 0) {
					return;
				}
				const [message] = queue.splice(index, 1);
				if (!message) {
					return;
				}
				settled = true;
				clearTimeout(timeoutId);
				emitter.removeListener("message", tryResolve);
				resolveMessage(message);
			};
			const timeoutId = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				emitter.removeListener("message", tryResolve);
				rejectMessage(new Error("Timed out waiting for expected websocket message."));
			}, timeoutMs);
			emitter.on("message", tryResolve);
			tryResolve();
		});

	return {
		socket,
		waitForMessage,
		collectFor: async (durationMs: number) => {
			await new Promise((resolveDelay) => {
				setTimeout(resolveDelay, durationMs);
			});
			const messages = queue.slice();
			queue.length = 0;
			return messages;
		},
		close: async () => {
			if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
				return;
			}
			await new Promise<void>((resolveClose) => {
				socket.once("close", () => resolveClose());
				socket.close();
			});
		},
	};
}

async function requestJson<T>(input: {
	baseUrl: string;
	procedure: string;
	type: "query" | "mutation";
	workspaceId?: string | null;
	payload?: unknown;
}): Promise<{ status: number; payload: T }> {
	const unwrapTrpcPayload = (value: unknown): unknown => {
		const envelope = Array.isArray(value) ? value[0] : value;
		if (!envelope || typeof envelope !== "object") {
			return value;
		}
		if ("result" in envelope) {
			const result = (envelope as { result?: { data?: unknown } }).result;
			const data = result?.data;
			if (data && typeof data === "object" && "json" in data) {
				return (data as { json: unknown }).json;
			}
			return data;
		}
		if ("error" in envelope) {
			return (envelope as { error: unknown }).error;
		}
		return value;
	};
	const headers = new Headers();
	if (input.workspaceId) {
		headers.set("x-kanban-workspace-id", input.workspaceId);
	}
	let url = `${input.baseUrl}/api/trpc/${input.procedure}`;
	let method: "GET" | "POST";
	let body: string | undefined;
	if (input.type === "query") {
		method = "GET";
		if (input.payload !== undefined) {
			url += `?input=${encodeURIComponent(JSON.stringify(input.payload))}`;
		}
	} else {
		method = "POST";
		body = input.payload === undefined ? undefined : JSON.stringify(input.payload);
	}
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const response = await fetch(url, {
		method,
		headers,
		body,
	});
	const payload = unwrapTrpcPayload(await response.json().catch(() => null)) as T;
	return {
		status: response.status,
		payload,
	};
}

// 文件级 afterEach：覆盖本文件所有 describe（含之后新增的）。
afterEach(async () => {
	await spawnedChildProcessRegistrySigkilledAfterEachTest.sigkillEveryStillRunningChildProcessAndWaitForExit();
});

describe.sequential("runtime state stream integration", { timeout: RUNTIME_STATE_STREAM_TEST_TIMEOUT_MS }, () => {
	it("retains indexed project data and selection when the project path becomes unavailable", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const tempHome = integrationFixture.homeDirectoryPath;
		const repository = integrationFixture.createRepository("unavailable-project");
		const projectPath = repository.repositoryPath;
		const temporarilyMovedProjectPath = `${projectPath}-temporarily-moved`;

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});
		let initialStream: RuntimeStreamClient | null = null;
		let unavailableProjectStream: RuntimeStreamClient | null = null;
		let recoveredProjectStream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const workspaceId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			initialStream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			const initialSnapshot = (await initialStream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			if (!initialSnapshot.workspaceState) {
				throw new Error("Expected an initial workspace state.");
			}

			const savedStateResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board: createBoard("Retained while unavailable"),
					sessions: initialSnapshot.workspaceState.sessions,
					expectedRevision: initialSnapshot.workspaceState.revision,
				},
			});
			expect(savedStateResponse.status).toBe(200);

			const workspacesRootPath = join(tempHome, ".cline", "kanban", "workspaces");
			const indexPath = join(workspacesRootPath, "index.json");
			const workspaceStateDirectoryPath = join(workspacesRootPath, workspaceId);
			const retainedFilePaths = [
				indexPath,
				join(workspaceStateDirectoryPath, "board.json"),
				join(workspaceStateDirectoryPath, "sessions.json"),
				join(workspaceStateDirectoryPath, "meta.json"),
			];
			const retainedFileContentsBefore = new Map(
				retainedFilePaths.map((filePath) => [filePath, readFileSync(filePath)]),
			);

			renameSync(projectPath, temporarilyMovedProjectPath);
			expect(readFileSync(indexPath)).toEqual(retainedFileContentsBefore.get(indexPath));
			unavailableProjectStream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			const unavailableSnapshot = (await unavailableProjectStream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;

			expect(unavailableSnapshot.currentProjectId).toBe(workspaceId);
			expect(unavailableSnapshot.workspaceState).toBeNull();
			expect(unavailableSnapshot.workspaceMetadata).toBeNull();
			expect(unavailableSnapshot.projects).toEqual([
				expect.objectContaining({
					id: workspaceId,
					availability: { status: "unavailable", reason: "project_path_missing" },
					taskCounts: expect.objectContaining({ backlog: 1 }),
				}),
			]);
			for (const filePath of retainedFilePaths) {
				expect(readFileSync(filePath)).toEqual(retainedFileContentsBefore.get(filePath));
			}
			const unexpectedErrors = (await unavailableProjectStream.collectFor(150)).filter(
				(message) => message.type === "error",
			);
			expect(unexpectedErrors).toEqual([]);

			renameSync(temporarilyMovedProjectPath, projectPath);
			recoveredProjectStream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			const recoveredSnapshot = (await recoveredProjectStream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(recoveredSnapshot.currentProjectId).toBe(workspaceId);
			expect(recoveredSnapshot.workspaceState?.board.columns[0]?.cards[0]?.title).toBe("Retained while unavailable");
			expect(recoveredSnapshot.projects).toEqual([
				expect.objectContaining({ id: workspaceId, availability: { status: "available" } }),
			]);
		} finally {
			if (initialStream) {
				await initialStream.close();
			}
			if (unavailableProjectStream) {
				await unavailableProjectStream.close();
			}
			if (recoveredProjectStream) {
				await recoveredProjectStream.close();
			}
			if (existsSync(temporarilyMovedProjectPath) && !existsSync(projectPath)) {
				renameSync(temporarilyMovedProjectPath, projectPath);
			}
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("treats core.bare=true as a retained unavailable project without deleting persisted state", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const tempHome = integrationFixture.homeDirectoryPath;
		const repository = integrationFixture.createRepository("bare-project");
		const projectPath = repository.repositoryPath;
		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});
		let initialStream: RuntimeStreamClient | null = null;
		let unavailableProjectStream: RuntimeStreamClient | null = null;

		try {
			const workspaceId = decodeURIComponent(new URL(server.runtimeUrl).pathname.slice(1));
			initialStream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			const initialSnapshot = (await initialStream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			if (!initialSnapshot.workspaceState) {
				throw new Error("Expected an initial workspace state.");
			}
			await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board: createBoard("Retained while Git is bare"),
					sessions: {},
					expectedRevision: initialSnapshot.workspaceState.revision,
				},
			});

			const workspacesRootPath = join(tempHome, ".cline", "kanban", "workspaces");
			const retainedFilePaths = [
				join(workspacesRootPath, "index.json"),
				join(workspacesRootPath, workspaceId, "board.json"),
				join(workspacesRootPath, workspaceId, "sessions.json"),
				join(workspacesRootPath, workspaceId, "meta.json"),
			];
			const retainedFileContentsBefore = new Map(
				retainedFilePaths.map((filePath) => [filePath, readFileSync(filePath)]),
			);

			repository.runGit(["config", "core.bare", "true"]);
			unavailableProjectStream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			const unavailableSnapshot = (await unavailableProjectStream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;

			expect(unavailableSnapshot.currentProjectId).toBe(workspaceId);
			expect(unavailableSnapshot.workspaceState).toBeNull();
			expect(unavailableSnapshot.projects).toEqual([
				expect.objectContaining({
					id: workspaceId,
					availability: { status: "unavailable", reason: "git_work_tree_unavailable" },
					taskCounts: expect.objectContaining({ backlog: 1 }),
				}),
			]);
			for (const filePath of retainedFilePaths) {
				expect(readFileSync(filePath)).toEqual(retainedFileContentsBefore.get(filePath));
			}
		} finally {
			if (initialStream) {
				await initialStream.close();
			}
			if (unavailableProjectStream) {
				await unavailableProjectStream.close();
			}
			repository.runGit(["config", "core.bare", "false"]);
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("starts outside a git repository with no active workspace", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const nonGitPath = integrationFixture.createNonGitDirectory("no-git-directory");

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: nonGitPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			expect(runtimeUrl.pathname).toBe("/");

			const projectsResponse = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
			});
			expect(projectsResponse.status).toBe(200);
			expect(projectsResponse.payload.currentProjectId).toBeNull();
			expect(projectsResponse.payload.projects).toEqual([]);

			stream = await connectRuntimeStream(`ws://127.0.0.1:${port}/api/runtime/ws`);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.currentProjectId).toBeNull();
			expect(snapshot.workspaceState).toBeNull();
			expect(snapshot.projects).toEqual([]);
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("starts from the home directory with no active workspace", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const tempHome = integrationFixture.homeDirectoryPath;

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: tempHome,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			expect(runtimeUrl.pathname).toBe("/");

			const projectsResponse = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
			});
			expect(projectsResponse.status).toBe(200);
			expect(projectsResponse.payload.currentProjectId).toBeNull();
			expect(projectsResponse.payload.projects).toEqual([]);

			stream = await connectRuntimeStream(`ws://127.0.0.1:${port}/api/runtime/ws`);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.currentProjectId).toBeNull();
			expect(snapshot.workspaceState).toBeNull();
			expect(snapshot.projects).toEqual([]);
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("launches outside git using the first indexed project", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const projectAPath = integrationFixture.createRepository("project-a").repositoryPath;
		const projectBPath = integrationFixture.createRepository("project-b").repositoryPath;
		const nonGitPath = integrationFixture.createNonGitDirectory("non-git");

		const firstPort = await getAvailablePort();
		const firstServer = await startKanbanServer({
			testContext,
			cwd: projectAPath,
			gitFixture: integrationFixture.gitFixture,
			port: firstPort,
		});

		let workspaceAId: string | null = null;
		try {
			const firstRuntimeUrl = new URL(firstServer.runtimeUrl);
			workspaceAId = decodeURIComponent(firstRuntimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
		} finally {
			await firstServer.stop();
		}

		const secondPort = await getAvailablePort();
		const secondServer = await startKanbanServer({
			testContext,
			cwd: nonGitPath,
			gitFixture: integrationFixture.gitFixture,
			port: secondPort,
		});

		let secondStream: RuntimeStreamClient | null = null;
		try {
			const secondRuntimeUrl = new URL(secondServer.runtimeUrl);
			expect(workspaceAId).not.toBeNull();
			if (!workspaceAId) {
				throw new Error("Missing workspace id for project A.");
			}
			const secondWorkspaceId = decodeURIComponent(secondRuntimeUrl.pathname.slice(1));
			expect(secondWorkspaceId).toBe(workspaceAId);
			const expectedProjectAPath = await realpath(projectAPath).catch(() => resolve(projectAPath));

			const projectsResponse = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "projects.list",
				type: "query",
			});
			expect(projectsResponse.status).toBe(200);
			expect(projectsResponse.payload.currentProjectId).toBe(workspaceAId);

			secondStream = await connectRuntimeStream(`ws://127.0.0.1:${secondPort}/api/runtime/ws`);
			const snapshot = (await secondStream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.currentProjectId).toBe(workspaceAId);
			expect(snapshot.workspaceState?.repoPath).toBe(expectedProjectAPath);
		} finally {
			if (secondStream) {
				await secondStream.close();
			}
			await secondServer.stop();
			await integrationFixture.cleanup();
		}
	});

	it("requires explicit confirmation before initializing git for a non-git added project", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const projectAPath = integrationFixture.createRepository("project-a").repositoryPath;
		const nonGitPath = integrationFixture.createNonGitDirectory("non-git-project");

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectAPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		let workspaceAId: string | null = null;
		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			workspaceAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");

			const addWithoutInitResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: nonGitPath,
				},
			});
			expect(addWithoutInitResponse.status).toBe(200);
			expect(addWithoutInitResponse.payload.ok).toBe(false);
			expect(addWithoutInitResponse.payload.requiresGitInitialization).toBe(true);
			expect(existsSync(join(nonGitPath, ".git"))).toBe(false);

			const projectsAfterDeclinedInit = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				workspaceId: workspaceAId,
			});
			expect(projectsAfterDeclinedInit.status).toBe(200);
			expect(projectsAfterDeclinedInit.payload.projects).toHaveLength(1);

			const addWithInitResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: nonGitPath,
					initializeGit: true,
				},
			});
			expect(addWithInitResponse.status).toBe(200);
			expect(addWithInitResponse.payload.ok).toBe(true);
			expect(addWithInitResponse.payload.project).not.toBeNull();
			expect(existsSync(join(nonGitPath, ".git"))).toBe(true);
		} finally {
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("streams per-project snapshots and isolates workspace updates", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const projectAPath = integrationFixture.createRepository("project-a").repositoryPath;
		const projectBPath = integrationFixture.createRepository("project-b").repositoryPath;

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectAPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		let streamA: RuntimeStreamClient | null = null;
		let streamB: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const workspaceAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");
			const expectedProjectAPath = await realpath(projectAPath).catch(() => resolve(projectAPath));
			const expectedProjectBPath = await realpath(projectBPath).catch(() => resolve(projectBPath));

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
			const workspaceBId = addProjectResponse.payload.project?.id ?? null;
			expect(workspaceBId).not.toBeNull();
			if (!workspaceBId) {
				throw new Error("Missing project id for added workspace.");
			}

			streamA = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceAId)}`,
			);
			const snapshotA = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotA.currentProjectId).toBe(workspaceAId);
			expect(snapshotA.workspaceState?.repoPath).toBe(expectedProjectAPath);
			expect(snapshotA.projects.map((project) => project.id).sort()).toEqual([workspaceAId, workspaceBId].sort());

			streamB = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceBId)}`,
			);
			const snapshotB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshotB.currentProjectId).toBe(workspaceBId);
			expect(snapshotB.workspaceState?.repoPath).toBe(expectedProjectBPath);

			const currentWorkspaceBState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId: workspaceBId,
			});
			const previousRevision = currentWorkspaceBState.payload.revision;
			const saveWorkspaceBResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId: workspaceBId,
				payload: {
					board: createBoard("Realtime Task"),
					sessions: currentWorkspaceBState.payload.sessions,
					expectedRevision: previousRevision,
				},
			});
			expect(saveWorkspaceBResponse.status).toBe(200);
			expect(saveWorkspaceBResponse.payload.revision).toBe(previousRevision + 1);

			const workspaceUpdateB = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamWorkspaceStateMessage =>
					message.type === "workspace_state_updated" && message.workspaceId === workspaceBId,
			)) as RuntimeStateStreamWorkspaceStateMessage;
			expect(workspaceUpdateB.workspaceState.revision).toBe(previousRevision + 1);
			expect(workspaceUpdateB.workspaceState.board.columns[0]?.cards[0]?.prompt).toBe("Realtime Task");

			const streamAMessages = await streamA.collectFor(500);
			expect(
				streamAMessages.some(
					(message) => message.type === "workspace_state_updated" && message.workspaceId === workspaceBId,
				),
			).toBe(false);

			const projectsAfterUpdate = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				workspaceId: workspaceAId,
			});
			expect(projectsAfterUpdate.status).toBe(200);
			const projectB = projectsAfterUpdate.payload.projects.find((project) => project.id === workspaceBId) ?? null;
			expect(projectB?.taskCounts.backlog).toBe(1);
		} finally {
			if (streamA) {
				await streamA.close();
			}
			if (streamB) {
				await streamB.close();
			}
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("emits task_ready_for_review when hook review event is ingested", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const projectPath = integrationFixture.createRepository("project-hook-stream").repositoryPath;

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const workspaceId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			);

			const taskId = "hook-review-task";
			const startShellResponse = await requestJson<RuntimeShellSessionStartResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.startShellSession",
				type: "mutation",
				workspaceId,
				payload: {
					taskId,
					baseRef: "HEAD",
				},
			});
			expect(startShellResponse.status).toBe(200);
			expect(startShellResponse.payload.ok).toBe(true);

			const hookResponse = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: {
					taskId,
					workspaceId,
					event: "to_review",
				},
			});
			expect(hookResponse.status).toBe(200);
			expect(hookResponse.payload.ok).toBe(true);

			const readyMessage = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamTaskReadyForReviewMessage =>
					message.type === "task_ready_for_review" &&
					message.workspaceId === workspaceId &&
					message.taskId === taskId,
			)) as RuntimeStateStreamTaskReadyForReviewMessage;
			expect(readyMessage.type).toBe("task_ready_for_review");
			expect(readyMessage.triggeredAt).toBeGreaterThan(0);
			// ③(b)：人轴 userTurnKind 经事件 payload 内联端到端到达前端（hook 转审 reviewReason="hook"→review）。
			// 这正是「标题不回读延迟 summary 流」竞态修复的端到端铁证：ready 事件本身已自带正确的人轴种类。
			expect(readyMessage.userTurnKind).toBe("review");

			await requestJson({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "runtime.stopTaskSession",
				type: "mutation",
				workspaceId,
				payload: { taskId },
			});
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("streams centralized workspace metadata updates for task worktrees", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const repository = integrationFixture.createRepository("project-metadata-stream");
		const projectPath = repository.repositoryPath;
		writeFileSync(join(projectPath, "README.md"), "seed\n", "utf8");
		commitAllRepositoryFiles(repository, projectPath, "seed project");

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		let stream: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const workspaceId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const stateResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(stateResponse.status).toBe(200);

			const taskId = "metadata-stream-task";
			const trashTaskId = "metadata-trash-task";
			const baseRef = repository.runGit(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
			const board = createReviewBoard(taskId, "Metadata stream task", trashTaskId);
			const reviewColumn = board.columns.find((column) => column.id === "review");
			const trashColumn = board.columns.find((column) => column.id === "trash");
			if (!reviewColumn || !reviewColumn.cards[0]) {
				throw new Error("Expected seeded review card.");
			}
			reviewColumn.cards[0].baseRef = baseRef;
			if (!trashColumn || !trashColumn.cards[0]) {
				throw new Error("Expected seeded trash card.");
			}
			trashColumn.cards[0].baseRef = baseRef;

			const saveResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board,
					sessions: stateResponse.payload.sessions,
					expectedRevision: stateResponse.payload.revision,
				},
			});
			expect(saveResponse.status).toBe(200);

			const ensureResponse = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(ensureResponse.status).toBe(200);
			expect(ensureResponse.payload.ok).toBe(true);
			if (!ensureResponse.payload.ok) {
				throw new Error(ensureResponse.payload.error ?? "ensureWorktree failed");
			}

			stream = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			const snapshot = (await stream.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(snapshot.workspaceMetadata).not.toBeNull();
			const initialTaskMetadata =
				snapshot.workspaceMetadata?.taskWorkspaces.find((task) => task.taskId === taskId) ?? null;
			expect(initialTaskMetadata).not.toBeNull();
			expect(initialTaskMetadata?.changedFiles ?? 0).toBe(0);
			// Done 卡仍保留元数据投影（f51f9786），缺失 worktree 不等于缺失记录。
			expect(snapshot.workspaceMetadata?.taskWorkspaces.find((task) => task.taskId === trashTaskId)).toMatchObject({
				taskId: trashTaskId,
				exists: false,
				baseRef,
				changedFiles: null,
			});
			const messagesAfterInitialSnapshot = await stream.collectFor(250);
			expect(messagesAfterInitialSnapshot.some((message) => message.type === "workspace_metadata_updated")).toBe(
				false,
			);

			writeFileSync(join(ensureResponse.payload.path, "task-change.txt"), "updated\n", "utf8");

			const metadataMessage = await stream.waitForMessage(
				(message) =>
					message.type === "workspace_metadata_updated" &&
					message.workspaceId === workspaceId &&
					message.workspaceMetadata.taskWorkspaces.some(
						(task) => task.taskId === taskId && (task.changedFiles ?? 0) > 0,
					),
				10_000,
			);
			expect(metadataMessage.type).toBe("workspace_metadata_updated");
			if (metadataMessage.type !== "workspace_metadata_updated") {
				throw new Error("Expected workspace metadata update message.");
			}
			const updatedTaskMetadata = metadataMessage.workspaceMetadata.taskWorkspaces.find(
				(task) => task.taskId === taskId,
			);
			expect(updatedTaskMetadata?.changedFiles).toBeGreaterThan(0);
			expect(updatedTaskMetadata?.stateVersion).toBeGreaterThan(initialTaskMetadata?.stateVersion ?? 0);
		} finally {
			if (stream) {
				await stream.close();
			}
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	it("preserves existing task worktree when base ref advances", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const repository = integrationFixture.createRepository("project-preserve-worktree");
		const projectPath = repository.repositoryPath;
		writeFileSync(join(projectPath, "initial.txt"), "one\n", "utf8");
		const firstBaseCommit = commitAllRepositoryFiles(repository, projectPath, "initial commit");
		const baseRef = repository.runGit(["symbolic-ref", "--short", "HEAD"]).stdout.trim();

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const workspaceId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const stateResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(stateResponse.status).toBe(200);

			const taskId = "preserve-worktree-task";
			const board = createBoard("Preserve existing worktree");
			const backlogColumn = board.columns.find((column) => column.id === "backlog");
			if (!backlogColumn || !backlogColumn.cards[0]) {
				throw new Error("Expected a backlog card for seed board.");
			}
			backlogColumn.cards[0].id = taskId;
			backlogColumn.cards[0].baseRef = baseRef;

			const saveResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board,
					sessions: stateResponse.payload.sessions,
					expectedRevision: stateResponse.payload.revision,
				},
			});
			expect(saveResponse.status).toBe(200);

			const firstEnsure = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(firstEnsure.status).toBe(200);
			expect(firstEnsure.payload.ok).toBe(true);
			if (!firstEnsure.payload.ok) {
				throw new Error(firstEnsure.payload.error ?? "ensureWorktree failed");
			}
			expect(firstEnsure.payload.baseCommit).toBe(firstBaseCommit);

			writeFileSync(join(firstEnsure.payload.path, "task-local.txt"), "task commit\n", "utf8");
			const taskWorktreeCommit = commitAllRepositoryFiles(repository, firstEnsure.payload.path, "task-local commit");

			writeFileSync(join(projectPath, "advance-base.txt"), "two\n", "utf8");
			const advancedBaseCommit = commitAllRepositoryFiles(repository, projectPath, "advance base");
			expect(advancedBaseCommit).not.toBe(firstBaseCommit);

			const secondEnsure = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(secondEnsure.status).toBe(200);
			expect(secondEnsure.payload.ok).toBe(true);
			if (!secondEnsure.payload.ok) {
				throw new Error(secondEnsure.payload.error ?? "ensureWorktree failed");
			}
			expect(secondEnsure.payload.path).toBe(firstEnsure.payload.path);
			expect(secondEnsure.payload.baseCommit).toBe(taskWorktreeCommit);

			const taskContext = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: {
					taskId,
					baseRef,
				},
			});
			expect(taskContext.status).toBe(200);
			expect(taskContext.payload.headCommit).toBe(taskWorktreeCommit);
		} finally {
			await server.stop();
			await integrationFixture.cleanup();
		}
	});

	// it.for 而非 it.each：要拿到 testContext，stop() 才能写软档告警、并在退化成 SIGKILL 时判失败。
	it.for([
		{
			label: "default shutdown",
			extraArgs: [] as string[],
		},
		{
			label: "the hidden --skip-shutdown-cleanup compatibility flag",
			extraArgs: ["--skip-shutdown-cleanup"],
		},
	])("preserves completed review cards and task worktrees with $label", async ({ extraArgs }, testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const projectPath = integrationFixture.createRepository("project-safe-shutdown").repositoryPath;

		// 两个参数化用例共用按文件隔离的关系账本：id 对全局登记簿唯一，复用同一个 id 会被当成删卡后复用而拒写。
		const taskId = `safe-shutdown-review-task-with-${extraArgs.length}-extra-args`;
		const now = Date.now();
		const firstPort = await getAvailablePort();
		const firstServer = await startKanbanServer({
			testContext,
			cwd: projectPath,
			gitFixture: integrationFixture.gitFixture,
			port: firstPort,
			extraArgs,
		});

		try {
			const firstRuntimeUrl = new URL(firstServer.runtimeUrl);
			const workspaceId = decodeURIComponent(firstRuntimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const currentState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(currentState.status).toBe(200);

			const seedResponse = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board: createReviewBoard(taskId, "Safe Shutdown Review Task"),
					sessions: {
						[taskId]: {
							taskId,
							state: "awaiting_review",
							agentId: "codex",
							workspacePath: projectPath,
							pid: null,
							startedAt: now - 2_000,
							updatedAt: now,
							lastOutputAt: now,
							reviewReason: "hook",
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
						},
					},
					expectedRevision: currentState.payload.revision,
				},
			});
			expect(seedResponse.status).toBe(200);

			const taskWorkspaceInfo = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${firstPort}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: { taskId, baseRef: "HEAD" },
			});
			expect(taskWorkspaceInfo.status).toBe(200);
			mkdirSync(taskWorkspaceInfo.payload.path, { recursive: true });
		} finally {
			// 本用例断言的正是「优雅关停之后卡片与 worktree 仍在」：退化成 SIGKILL 就判失败，不能空转通过。
			await firstServer.stop({ requireGracefulShutdownExit: true });
		}

		const secondPort = await getAvailablePort();
		const secondServer = await startKanbanServer({
			testContext,
			cwd: projectPath,
			gitFixture: integrationFixture.gitFixture,
			port: secondPort,
		});

		try {
			const secondRuntimeUrl = new URL(secondServer.runtimeUrl);
			const workspaceId = decodeURIComponent(secondRuntimeUrl.pathname.slice(1));
			expect(workspaceId).not.toBe("");

			const finalState = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(finalState.status).toBe(200);

			const reviewCards = finalState.payload.board.columns.find((column) => column.id === "review")?.cards ?? [];
			const trashCards = finalState.payload.board.columns.find((column) => column.id === "trash")?.cards ?? [];
			expect(reviewCards.some((card) => card.id === taskId)).toBe(true);
			expect(trashCards.some((card) => card.id === taskId)).toBe(false);
			expect(finalState.payload.sessions[taskId]).toEqual(
				expect.objectContaining({
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					reviewReason: "hook",
					pid: null,
				}),
			);

			const workspaceInfo = await requestJson<RuntimeTaskWorkspaceInfoResponse>({
				baseUrl: `http://127.0.0.1:${secondPort}`,
				procedure: "workspace.getTaskContext",
				type: "query",
				workspaceId,
				payload: { taskId, baseRef: "HEAD" },
			});
			expect(workspaceInfo.status).toBe(200);
			expect(workspaceInfo.payload.exists).toBe(true);
		} finally {
			await secondServer.stop();
			await integrationFixture.cleanup();
		}
	});

	it("falls back to the remaining project after confirmed permanent deletion of the active project", async (testContext) => {
		const integrationFixture = createRuntimeStateStreamIntegrationFixture();
		const projectAPath = integrationFixture.createRepository("project-a").repositoryPath;
		const projectBPath = integrationFixture.createRepository("project-b").repositoryPath;

		const port = await getAvailablePort();
		const server = await startKanbanServer({
			testContext,
			cwd: projectAPath,
			gitFixture: integrationFixture.gitFixture,
			port,
		});

		let streamA: RuntimeStreamClient | null = null;
		let streamB: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const workspaceAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(workspaceAId).not.toBe("");
			const expectedProjectBPath = await realpath(projectBPath).catch(() => resolve(projectBPath));

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
			const workspaceBId = addProjectResponse.payload.project?.id ?? null;
			expect(workspaceBId).not.toBeNull();
			if (!workspaceBId) {
				throw new Error("Missing project id for added workspace.");
			}

			streamA = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceAId)}`,
			);
			const initialSnapshot = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(initialSnapshot.currentProjectId).toBe(workspaceAId);

			const deletionPreviewResponse = await requestJson<RuntimeProjectPermanentDeletionPreviewResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.getPermanentDeletionPreview",
				type: "query",
				workspaceId: workspaceAId,
				payload: {
					projectId: workspaceAId,
				},
			});
			expect(deletionPreviewResponse.status).toBe(200);
			expect(deletionPreviewResponse.payload.ok).toBe(true);
			if (!deletionPreviewResponse.payload.ok) {
				throw new Error(deletionPreviewResponse.payload.error);
			}
			const preview = deletionPreviewResponse.payload.preview;
			expect(preview.deletionAllowed).toBe(true);
			expect(preview.requiredConfirmationProjectName).toBe("project-a");
			expect(preview.workspaceStateRevision).not.toBeNull();
			if (preview.workspaceStateRevision === null) {
				throw new Error("Permanent deletion preview did not contain a workspace revision.");
			}

			const permanentDeletionResponse = await requestJson<RuntimeProjectPermanentDeletionResult>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.permanentlyDeleteProjectData",
				type: "mutation",
				workspaceId: workspaceAId,
				payload: {
					projectId: workspaceAId,
					expectedWorkspaceStateRevision: preview.workspaceStateRevision,
					confirmationProjectName: preview.requiredConfirmationProjectName,
				},
			});
			expect(permanentDeletionResponse.status).toBe(200);
			expect(permanentDeletionResponse.payload).toMatchObject({
				status: "completed",
				projectId: workspaceAId,
				projectIndexDeleted: true,
				workspaceStateDirectoryDeleted: true,
				newCurrentProjectId: workspaceBId,
			});

			const projectsUpdated = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamProjectsMessage =>
					message.type === "projects_updated" && message.currentProjectId === workspaceBId,
			)) as RuntimeStateStreamProjectsMessage;
			expect(projectsUpdated.currentProjectId).toBe(workspaceBId);
			expect(projectsUpdated.projects.map((project) => project.id)).toEqual([workspaceBId]);

			streamB = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=${encodeURIComponent(workspaceBId)}`,
			);
			const fallbackSnapshot = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(fallbackSnapshot.currentProjectId).toBe(workspaceBId);
			expect(fallbackSnapshot.workspaceState?.repoPath).toBe(expectedProjectBPath);

			const projectsAfterRemoval = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				workspaceId: workspaceBId,
			});
			expect(projectsAfterRemoval.status).toBe(200);
			expect(projectsAfterRemoval.payload.currentProjectId).toBe(workspaceBId);
			expect(projectsAfterRemoval.payload.projects.map((project) => project.id)).toEqual([workspaceBId]);
		} finally {
			if (streamA) {
				await streamA.close();
			}
			if (streamB) {
				await streamB.close();
			}
			await server.stop();
			await integrationFixture.cleanup();
		}
	});
});
