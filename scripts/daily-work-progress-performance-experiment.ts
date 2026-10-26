// 固定语料与单次隔离实验。用 node --import tsx 运行；证据目录必须是持久目录。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { runtimeTaskSessionSummarySchema } from "../src/core/api-contract";
import {
	createPendingTaskMessageInjectionRecord,
	TASK_MESSAGE_INJECTION_LEDGER_FILENAME,
} from "../src/core/task-message-injection-ledger";
import { createDailyWorkProgressStatisticsCollector } from "../src/daily-work-progress-statistics/daily-work-progress-statistics-collector";
import { createDailyWorkProgressStatisticsService } from "../src/daily-work-progress-statistics/daily-work-progress-statistics-service";
import { readDailyWorkProgressStatisticsStore } from "../src/daily-work-progress-statistics/daily-work-progress-statistics-store";
import {
	createDailyWorkProgressCollectionCostRecorder,
	type DailyWorkProgressCollectionCostWindow,
} from "../src/diagnostics/daily-work-progress-collection-cost-recorder";
import { waitForPendingDiagnosticEventJournalWrites } from "../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";

const { values } = parseArgs({
	options: {
		command: { type: "string", default: "run" },
		"corpus-directory": { type: "string" },
		"run-directory": { type: "string" },
		"project-count": { type: "string", default: "1" },
		"record-count": { type: "string", default: "10000" },
		"receipt-count": { type: "string", default: "10000" },
		"steady-duration-ms": { type: "string", default: "60000" },
		"history-timeout-ms": { type: "string", default: "180000" },
		"historical-pause-ms": { type: "string", default: "200" },
		"cost-recording": { type: "string", default: "enabled" },
		"probe-url": { type: "string" },
		"probe-report-file": { type: "string" },
	},
});
if (!values["corpus-directory"] && values.command !== "probe") throw new Error("必须指定持久的 --corpus-directory");
const corpusDirectory = resolve(values["corpus-directory"] ?? ".");
const epoch = Date.parse("2026-10-20T00:00:00Z");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const jsonLines = (records: object[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

interface ReadOnlyHttpProbeSample {
	startedAtMonotonicNanoseconds: string;
	elapsedMs: number;
	responseBytes: number;
	status: number;
}
interface ReadOnlyHttpProbeReport {
	samples: ReadOnlyHttpProbeSample[];
	cpuMicroseconds: NodeJS.CpuUsage;
	processId: number;
	error?: string;
}
async function runReadOnlyHttpProbeProcess() {
	if (!values["probe-url"] || !values["probe-report-file"] || !process.send)
		throw new Error("探针缺少本机 URL、持久报告或 IPC 宿主");
	let running = false;
	let completed = false;
	let begin: () => void = () => {};
	const startSignal = new Promise<void>((resolve) => {
		begin = resolve;
	});
	process.on("message", (message) => {
		if (typeof message !== "object" || message === null || !("kind" in message)) return;
		if (message.kind === "start") {
			running = true;
			begin();
		}
		if (message.kind === "stop") {
			running = false;
			begin();
		}
	});
	process.on("disconnect", () => {
		if (!completed) process.exit(1);
	});
	process.send({ kind: "ready" });
	await startSignal;
	const cpuAtStart = process.cpuUsage();
	const samples: ReadOnlyHttpProbeSample[] = [];
	let error: string | undefined;
	try {
		while (running) {
			const started = process.hrtime.bigint();
			const response = await fetch(values["probe-url"], { signal: AbortSignal.timeout(10_000) });
			const bytes = await response.arrayBuffer();
			samples.push({
				startedAtMonotonicNanoseconds: String(started),
				elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
				responseBytes: bytes.byteLength,
				status: response.status,
			});
			if (!response.ok) throw new Error(`只读请求失败: ${response.status}`);
			await delay(100);
		}
	} catch (failure) {
		error = String(failure);
		process.exitCode = 1;
	}
	await writeFile(
		values["probe-report-file"],
		JSON.stringify(
			{ samples, cpuMicroseconds: process.cpuUsage(cpuAtStart), processId: process.pid, error },
			null,
			2,
		),
	);
	completed = true;
	if (process.connected) process.disconnect();
}
function startReadOnlyHttpProbeProcess(url: string, reportFile: string, isolatedHome: string) {
	const child = spawn(
		process.execPath,
		[
			...process.execArgv,
			resolve(process.argv[1]),
			"--command",
			"probe",
			"--probe-url",
			url,
			"--probe-report-file",
			reportFile,
		],
		{
			env: { PATH: process.env.PATH, HOME: isolatedHome, USERPROFILE: isolatedHome, NO_COLOR: "1" },
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		},
	);
	const exited = new Promise<number | null>((resolve) => {
		child.once("error", () => resolve(null));
		child.once("exit", (code) => resolve(code));
	});
	const ready = new Promise<void>((resolve, reject) => {
		const deadline = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("只读探针启动超过 30 秒"));
		}, 30_000);
		child.on("message", (message) => {
			if (typeof message === "object" && message !== null && "kind" in message && message.kind === "ready") {
				clearTimeout(deadline);
				resolve();
			}
		});
		child.once("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		child.once("exit", () => {
			clearTimeout(deadline);
			reject(new Error("只读探针在就绪前退出"));
		});
	});
	return { child, exited, ready };
}
async function stopReadOnlyHttpProbeProcess(probe: ReturnType<typeof startReadOnlyHttpProbeProcess>) {
	if (probe.child.connected) probe.child.send({ kind: "stop" });
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const code = await Promise.race([
		probe.exited,
		new Promise<never>((_resolve, reject) => {
			deadline = setTimeout(() => {
				probe.child.kill("SIGKILL");
				reject(new Error("只读探针停止超过 15 秒"));
			}, 15_000);
		}),
	]).finally(() => {
		if (deadline) clearTimeout(deadline);
	});
	if (code !== 0) throw new Error(`只读探针退出码 ${code}`);
}

async function generateCorpus() {
	const projectCount = Number(values["project-count"]);
	const recordCount = Number(values["record-count"]);
	const receiptCount = Number(values["receipt-count"]);
	if (![1, 10].includes(projectCount) || ![1000, 10000].includes(recordCount) || ![1000, 10000].includes(receiptCount))
		throw new Error("语料只允许计划中的 1/10 项目和 1000/10000 条记录/回执");
	// 独占新语料目录，保留旧清单、转录和失败现场的原始证据。
	await mkdir(dirname(corpusDirectory), { recursive: true });
	await mkdir(corpusDirectory, { recursive: false });
	const manifest: { path: string; bytes: number; sha256: string }[] = [];
	let expectedPromptFacts = 0;
	async function persist(relativePath: string, text: string) {
		const path = join(corpusDirectory, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
		manifest.push({ path: relativePath, bytes: Buffer.byteLength(text), sha256: hash(text) });
	}
	const entries: Record<string, { workspaceId: string; repoPath: string }> = {};
	const recordsPerSource = Math.floor(recordCount / projectCount);
	const targetBytesPerSource = Math.floor((32 * 1024 * 1024) / projectCount);
	const padding = "x".repeat(Math.max(16, Math.floor(targetBytesPerSource / (recordsPerSource * 0.9)) - 250));
	for (let project = 0; project < projectCount; project++) {
		const workspaceId = `measured-project-${project}`;
		const repoPath = join(corpusDirectory, "repositories", workspaceId);
		await mkdir(repoPath, { recursive: true });
		const gitResult = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "init", "--quiet", repoPath], {
			env: {
				PATH: process.env.PATH,
				HOME: join(corpusDirectory, "git-home"),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		});
		if (gitResult.status !== 0) throw new Error(`隔离语料仓库初始化失败: ${gitResult.stderr}`);
		entries[workspaceId] = { workspaceId, repoPath };
		const cards: object[] = [];
		const sessions: Record<string, object> = {};
		const receipts = [];
		for (const sourceAgentId of ["codex", "claude"]) {
			const taskId = `${sourceAgentId}-owning-task`;
			const sessionId = `${sourceAgentId}-independent-main`;
			const nativeSessionId = `01a10000-0000-7000-8000-${String(project * 2 + (sourceAgentId === "codex" ? 0 : 1)).padStart(12, "0")}`;
			const records = Array.from({ length: recordsPerSource }, (_, index) => {
				const timestamp = new Date(epoch + index * 1_000).toISOString();
				const text = `固定人工输入 ${index % 100}`;
				if (index % 10 === 0 && !(index < receiptCount && index % 3 === 0 && index % 7 !== 0))
					expectedPromptFacts++;
				if (index % 10 !== 0)
					return sourceAgentId === "codex"
						? { type: "response_item", timestamp, payload: { type: "function_call_output", output: padding } }
						: {
								type: "user",
								timestamp,
								uuid: `${workspaceId}:claude-tool:${index}`,
								sessionId: nativeSessionId,
								message: {
									role: "user",
									content: [{ type: "tool_result", tool_use_id: `tool-${index}`, content: padding }],
								},
							};
				return sourceAgentId === "codex"
					? {
							type: "event_msg",
							timestamp,
							id: `${workspaceId}:codex:${index}`,
							payload: { type: "user_message", message: text },
						}
					: {
							type: "user",
							promptSource: "typed",
							timestamp,
							uuid: `${workspaceId}:claude:${index}`,
							sessionId: nativeSessionId,
							message: { role: "user", content: text },
						};
			});
			let transcriptPath = "";
			if (sourceAgentId === "codex") {
				let historyBase = null;
				let ordinal = 0;
				for (let segment = 0; segment < 8; segment++) {
					const threadId =
						segment === 0
							? nativeSessionId
							: `01a20000-0000-7000-8000-${String(project * 8 + segment).padStart(12, "0")}`;
					const relativePath = join(
						"transcripts",
						"codex",
						"sessions",
						"2026",
						"10",
						String(20 + segment),
						`rollout-${segment}-${nativeSessionId}${segment === 0 ? "" : `_${threadId}`}.jsonl`,
					);
					const segmentRecords = [
						{
							type: "session_meta",
							payload: {
								id: nativeSessionId,
								thread_source: "user",
								history_mode: "paginated",
								history_base: historyBase,
							},
						},
						...records.slice(
							Math.floor((segment * records.length) / 8),
							Math.floor(((segment + 1) * records.length) / 8),
						),
					];
					const text = jsonLines(segmentRecords);
					await persist(relativePath, text);
					ordinal += segmentRecords.length;
					historyBase = {
						thread_id: threadId,
						end_byte_offset: Buffer.byteLength(text),
						end_ordinal_exclusive: ordinal,
					};
					transcriptPath = join(corpusDirectory, relativePath);
				}
			} else {
				const relativePath = join("transcripts", workspaceId, "claude.jsonl");
				await persist(relativePath, jsonLines(records));
				transcriptPath = join(corpusDirectory, relativePath);
			}
			cards.push({
				id: taskId,
				title: "固定语料主会话交接后的任务",
				prompt: "固定输入",
				createdAt: epoch - 1,
				updatedAt: epoch,
				mainTaskConversationSessionId: sessionId,
				baseRef: "main",
				startInPlanMode: false,
			});
			sessions[sessionId] = runtimeTaskSessionSummarySchema.parse({
				taskId: sessionId,
				workspacePath: repoPath,
				state: "idle",
				turnOwner: null,
				liveness: "none",
				userTurnKind: null,
				agentId: sourceAgentId,
				pid: null,
				startedAt: epoch,
				updatedAt: epoch,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				taskConversationSessionMetadata: {
					workspaceTaskId: taskId,
					taskConversationSessionRole: "main",
					taskConversationSessionRoleAtCreation: "task_collaborator",
					taskConversationSessionHasHeldMainResponsibility: true,
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: taskId,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
				},
				agentNativeConversationSessionIdentity: {
					sourceAgentId,
					nativeSessionId,
					transcriptPath,
					observedAt: epoch,
				},
			});
			for (let index = 0; index < receiptCount; index++)
				receipts.push({
					...createPendingTaskMessageInjectionRecord({
						taskId,
						attemptId: index % 3 === 0 ? sessionId : "other-peer-session",
						source: "performance-fixture",
						idempotencyKey: `${sourceAgentId}:${index}`,
						promptSha256: hash(`固定人工输入 ${index % 100}`),
						nowIso: new Date(epoch + index * 1_000).toISOString(),
					}),
					terminal_delivery_status: index % 7 === 0 ? "delivery_failed" : "delivered_and_submit_confirmed",
				});
		}
		await persist(
			join("workspaces", workspaceId, "board.json"),
			JSON.stringify({ columns: [{ id: "in_progress", title: "进行中", cards }] }),
		);
		await persist(join("workspaces", workspaceId, "sessions.json"), JSON.stringify(sessions));
		await persist(join("workspaces", workspaceId, TASK_MESSAGE_INJECTION_LEDGER_FILENAME), JSON.stringify(receipts));
	}
	for (let index = 0; index < 1_000; index++) {
		const unrelatedSessionId = `01afffff-0000-7000-8000-${String(index).padStart(12, "0")}`;
		await persist(
			join(
				"transcripts",
				"codex",
				"sessions",
				"2026",
				"10",
				String(20 + (index % 8)),
				`rollout-unrelated-${unrelatedSessionId}.jsonl`,
			),
			jsonLines([{ type: "session_meta", payload: { id: unrelatedSessionId, thread_source: "user" } }]),
		);
	}

	await persist(
		"workspaces/index.json",
		JSON.stringify({
			version: 1,
			entries,
			repoPathToId: Object.fromEntries(Object.values(entries).map((entry) => [entry.repoPath, entry.workspaceId])),
		}),
	);
	await writeFile(
		join(corpusDirectory, "manifest.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				epoch,
				projectCount,
				recordCount,
				receiptCount,
				expectedPromptFacts,
				recordCountPerHarness: recordCount,
				unrelatedCodexSessionFileCount: 1_000,
				targetBytesPerSource,
				files: manifest,
			},
			null,
			2,
		),
	);
}

async function runExperiment() {
	if (!values["run-directory"]) throw new Error("必须指定新的持久 --run-directory");
	const runDirectory = resolve(values["run-directory"]);
	// 拒绝复用已有实验，失败和旧结果不能被覆盖。
	await mkdir(runDirectory, { recursive: false });
	const manifest = JSON.parse(await readFile(join(corpusDirectory, "manifest.json"), "utf8"));
	for (const file of manifest.files) {
		if (hash(await readFile(join(corpusDirectory, file.path))) !== file.sha256)
			throw new Error(`语料哈希不匹配: ${file.path}`);
	}
	const isolatedHome = join(runDirectory, "isolated-home");
	await cp(join(corpusDirectory, "workspaces"), join(isolatedHome, ".cline/kanban/workspaces"), { recursive: true });
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	process.env.KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR = join(runDirectory, "diagnostic-event-journals");
	const windows: DailyWorkProgressCollectionCostWindow[] = [];
	let costWriteTail = Promise.resolve();
	const recorder = createDailyWorkProgressCollectionCostRecorder({
		enabled: values["cost-recording"] !== "disabled",
		writeWindow: (window) => {
			windows.push(window);
			costWriteTail = costWriteTail.then(() =>
				appendFile(join(runDirectory, "cost-windows.jsonl"), `${JSON.stringify(window)}\n`),
			);
		},
	});
	const capture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
	await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
	await capture.sharedTaskCommitLandingCriterionActivationBackfillSweepCompletion;
	try {
		await capture.ledgerClient.listCommittedEvents({ afterGlobalCommittedEventSequence: 0, limit: 1 });
	} catch (error) {
		await writeFile(
			join(runDirectory, "failure.json"),
			JSON.stringify({ status: "invalid_ledger_preflight", error: String(error), argv: process.argv }, null, 2),
		);
		await capture.deactivate();
		recorder.close();
		throw error;
	}
	const storageFilePath = join(isolatedHome, "statistics.json");
	let pending = true;
	let rounds = 0;
	const collector = createDailyWorkProgressStatisticsCollector();
	const service = createDailyWorkProgressStatisticsService({
		storageFilePath,
		costRecorder: recorder,
		collect: async (state: Parameters<typeof collector>[0]) => {
			const result = await collector(state);
			pending = result.hasPendingHistoricalReads;
			rounds++;
			return result;
		},
		warn: (message) => {
			void appendFile(join(runDirectory, "warnings.jsonl"), `${JSON.stringify({ at: Date.now(), message })}\n`);
		},
	});
	const request = { workspaceId: null, dateKey: "2026-10-20", timeZone: "UTC" };
	const server = createServer((_req, res) => {
		void service
			.getSummary(request)
			.then((summary) => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(summary));
			})
			.catch(() => {
				res.statusCode = 500;
				res.end();
			});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("隔离服务端口不可用");
	const eventLoop = monitorEventLoopDelay({ resolution: 10 });
	let probe: ReturnType<typeof startReadOnlyHttpProbeProcess> | null = null;
	let start = performance.now();
	let caughtUpAt = start;
	try {
		const probeReportFile = join(runDirectory, "read-only-http-probe.json");
		probe = startReadOnlyHttpProbeProcess(`http://127.0.0.1:${address.port}/`, probeReportFile, isolatedHome);
		await probe.ready;
		eventLoop.enable();
		start = performance.now();
		const historyStartNanoseconds = process.hrtime.bigint();
		const cpuAtStart = process.cpuUsage();
		probe.child.send({ kind: "start" });
		do {
			await service.refresh();
			if (performance.now() - start > Number(values["history-timeout-ms"])) throw new Error("历史回填超时");
			if (pending) await delay(Number(values["historical-pause-ms"]));
		} while (pending);
		caughtUpAt = performance.now();
		const historyRounds = rounds;
		recorder.flush();
		const historyCpu = process.cpuUsage(cpuAtStart);
		const historyWindowCount = windows.length;
		const historyEndNanoseconds = process.hrtime.bigint();
		const historyEventLoopP95Ms = eventLoop.percentile(95) / 1e6;
		const historyEventLoopP99Ms = eventLoop.percentile(99) / 1e6;
		const steadyStartCpu = process.cpuUsage();
		eventLoop.reset();
		const steadyStartNanoseconds = process.hrtime.bigint();
		service.start();
		await delay(Number(values["steady-duration-ms"]));
		await service.close();
		const steadyEndNanoseconds = process.hrtime.bigint();
		const steadyEventLoopP95Ms = eventLoop.percentile(95) / 1e6;
		const steadyEventLoopP99Ms = eventLoop.percentile(99) / 1e6;
		eventLoop.disable();
		const steadyCpu = process.cpuUsage(steadyStartCpu);
		const steadyDurationMs = performance.now() - caughtUpAt;
		await stopReadOnlyHttpProbeProcess(probe);
		const probeReport = JSON.parse(await readFile(probeReportFile, "utf8")) as ReadOnlyHttpProbeReport;
		const phaseLatencies = (from: bigint, until: bigint) =>
			probeReport.samples
				.filter((sample) => {
					const started = BigInt(sample.startedAtMonotonicNanoseconds);
					return started >= from && started < until;
				})
				.map((sample) => sample.elapsedMs)
				.sort((a, b) => a - b);
		const historyReadOnlyRequestSamples = phaseLatencies(historyStartNanoseconds, historyEndNanoseconds);
		const sorted = phaseLatencies(steadyStartNanoseconds, steadyEndNanoseconds);
		if (
			(Number(values["steady-duration-ms"]) >= 60_000 && sorted.length < 100) ||
			historyReadOnlyRequestSamples.length === 0
		)
			throw new Error("只读探针有效样本不足，不能解释为低尾延迟");
		await costWriteTail;
		const state = await readDailyWorkProgressStatisticsStore(storageFilePath);
		if (
			manifest.expectedPromptFacts !== undefined &&
			Object.keys(state.factsByEventId).length !== manifest.expectedPromptFacts
		)
			throw new Error(`事实数量不符: ${Object.keys(state.factsByEventId).length} / ${manifest.expectedPromptFacts}`);
		const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
		const apiSummary = await service.getSummary(request);
		const semanticState = {
			projectedMetrics: apiSummary.metrics,
			projectedAchievements: apiSummary.achievements,
			projectedCoverageStatus: apiSummary.coverage.status,
			projectedCoverageWarnings: apiSummary.coverage.warnings,
			celebrationEligibleAchievementIds: apiSummary.celebrationEligibleAchievementIds,
			facts: state.factsByEventId,
			cursors: state.transcriptCursorsByIdentityKey,
			warnings: state.workspaceWarnings,
			inventory: state.workspacePromptSourceInventoryDiscoveryCompleted,
			ledgerCaughtUp: state.ledgerCaughtUp,
		};
		// 文件 inode / mtime 是运行环境字段，单独保留在原始统计文件，不参与事实对照。
		const factsHash = hash(
			JSON.stringify(Object.entries(state.factsByEventId).sort(([a], [b]) => a.localeCompare(b))),
		);
		await writeFile(join(runDirectory, "semantic-state.json"), JSON.stringify(semanticState, null, 2));
		await writeFile(
			join(runDirectory, "result.json"),
			JSON.stringify(
				{
					status: "completed",
					argv: process.argv,
					cwd: process.cwd(),
					executable: process.execPath,
					nodeVersion: process.version,
					options: values,
					measurementScope: {
						runtimeCpuIncludes: "collector_http_host_and_ledger_worker",
						probeClientIsSeparateProcess: true,
						probeClientCpuMicroseconds: probeReport.cpuMicroseconds,
						probeClientProcessId: probeReport.processId,
						probeRequestIntervalAfterCompletionMs: 100,
					},
					corpusManifestSha256: hash(await readFile(join(corpusDirectory, "manifest.json"))),
					history: {
						wallTimeMs: caughtUpAt - start,
						cpuMicroseconds: historyCpu,
						eventLoopP95Ms: historyEventLoopP95Ms,
						eventLoopP99Ms: historyEventLoopP99Ms,
						readOnlyRequestSamples: historyReadOnlyRequestSamples,
						readOnlyRequestP99Ms:
							historyReadOnlyRequestSamples[
								Math.min(
									historyReadOnlyRequestSamples.length - 1,
									Math.floor(historyReadOnlyRequestSamples.length * 0.99),
								)
							] ?? null,
						rounds: historyRounds,
						facts: Object.keys(state.factsByEventId).length,
						factsPerSecond: Object.keys(state.factsByEventId).length / ((caughtUpAt - start) / 1000),
					},
					steady: {
						durationMs: steadyDurationMs,
						cpuMicroseconds: steadyCpu,
						eventLoopP95Ms: steadyEventLoopP95Ms,
						eventLoopP99Ms: steadyEventLoopP99Ms,
						readOnlyRequestP95Ms: percentile(0.95),
						readOnlyRequestP99Ms: percentile(0.99),
						readOnlyRequestSamples: sorted,
					},
					factsHash,
					historyWindowCount,
					windows,
				},
				null,
				2,
			),
		);
	} catch (error) {
		await writeFile(
			join(runDirectory, "failure.json"),
			JSON.stringify(
				{
					error: String(error),
					argv: process.argv,
					elapsedMs: performance.now() - start,
					rounds,
					pending,
					windows,
				},
				null,
				2,
			),
		);
		throw error;
	} finally {
		await service.close();
		if (probe && probe.child.exitCode === null && probe.child.signalCode === null) {
			probe.child.kill("SIGKILL");
			await probe.exited;
		}
		eventLoop.disable();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await capture.deactivate();
		await costWriteTail;
		await waitForPendingDiagnosticEventJournalWrites();
	}
}
if (values.command === "probe") await runReadOnlyHttpProbeProcess();
else if (values.command === "generate") await generateCorpus();
else if (values.command === "run") await runExperiment();
else throw new Error("command 只允许 generate 或 run");
