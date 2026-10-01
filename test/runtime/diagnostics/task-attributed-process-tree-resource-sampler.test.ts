import { describe, expect, it, vi } from "vitest";

import type { PosixProcessResourceTableRow } from "../../../src/diagnostics/posix-process-table-with-resource-columns-reader";
import type { DiagnosticEventJournalChannel } from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { createTaskAttributedProcessTreeResourceSampler } from "../../../src/diagnostics/task-attributed-process-tree-resource-sampler";
import type { TaskResourceUsageAttributionRootEnumeration } from "../../../src/server/task-resource-usage-attribution-root-enumeration";

const T0 = new Date(2026, 8, 30, 1, 0, 0).getTime();
const START_TEXT = "Wed Sep 30 01:00:00 2026";

function row(
	processId: number,
	parentProcessId: number,
	processGroupId: number,
	rss: number,
	cpu = 0,
): PosixProcessResourceTableRow {
	return {
		processId,
		parentProcessId,
		processGroupId,
		residentSetSizeKibibytes: rss,
		cumulativeCpuTimeSeconds: cpu,
		processStartTimeText: START_TEXT,
		processStartedAtEpochMs: T0,
		processStateCode: "S",
	};
}

const ENUMERATION: TaskResourceUsageAttributionRootEnumeration = {
	roots: [
		{
			workspaceId: "repo",
			workspacePath: "/Users/u/repo",
			sessionTaskId: "ab12c",
			attributedTaskCardId: "ab12c",
			sessionCategory: "task_card_main_agent_session",
			sessionTransport: "pty_terminal",
			agentId: "claude",
			rootProcessId: 100,
			rootProcessRole: "agent_harness_root",
			runtimeSessionIncarnationId: "inc-1",
			rootSessionStartedAtEpochMs: T0,
		},
	],
	taskWorkingDirectoryAttributions: [],
	workspaceIdByWorkspacePath: new Map([["/Users/u/repo", "repo"]]),
};

const COMMAND_LINES = new Map<number, string>([
	[100, "claude --model default"],
	[
		200,
		"/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'GITHUB_TOKEN=abc123 npm run test:guarded' < /dev/null && pwd -P >| /tmp/claude-1-cwd",
	],
]);

function createHarness(tables: PosixProcessResourceTableRow[][]) {
	let tickIndex = 0;
	let currentTimeMs = T0;
	const journalEvents: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
	const onLiveTaskResourceUsageSnapshotsUpdated = vi.fn();
	const readProcessCommandLines = vi.fn(async (processIds: readonly number[]) => {
		return new Map(
			processIds.flatMap((processId) => {
				const commandLine = COMMAND_LINES.get(processId);
				return commandLine === undefined ? [] : [[processId, commandLine] as const];
			}),
		);
	});
	const sampler = createTaskAttributedProcessTreeResourceSampler({
		enumerateAttributionRoots: () => ENUMERATION,
		onLiveTaskResourceUsageSnapshotsUpdated,
		kanbanRuntimeProcessId: 9,
		now: () => currentTimeMs,
		readProcessResourceTable: async () => tables[Math.min(tickIndex++, tables.length - 1)] ?? [],
		readProcessCommandLines,
		readCurrentWorkingDirectories: async () => new Map(),
		readKanbanEnvironment: async () => new Map(),
		readPhysicalFootprints: async () => new Map([[100, 400_000_000]]),
		appendJournalEvent: (channel, payload) => {
			journalEvents.push({ channel, payload });
		},
	});
	return {
		sampler,
		journalEvents,
		onLiveTaskResourceUsageSnapshotsUpdated,
		readProcessCommandLines,
		advanceTimeMs: (deltaMs: number) => {
			currentTimeMs += deltaMs;
		},
	};
}

describe("createTaskAttributedProcessTreeResourceSampler", () => {
	it("writes one lifetime episode when an agent command exits, with the inner command redacted and its peak memory", async () => {
		const harness = createHarness([
			[row(9, 1, 9, 700_000), row(100, 9, 100, 300_000), row(200, 100, 200, 400_000, 1)],
			[row(9, 1, 9, 700_000), row(100, 9, 100, 300_000), row(200, 100, 200, 900_000, 20)],
			[row(9, 1, 9, 700_000), row(100, 9, 100, 300_000)],
		]);

		await harness.sampler.runSampleTick();
		harness.advanceTimeMs(15_000);
		await harness.sampler.runSampleTick();
		harness.advanceTimeMs(15_000);
		await harness.sampler.runSampleTick();

		const episodes = harness.journalEvents.filter(
			(event) => event.channel === "task-attributed-process-lifetime-episode",
		);
		expect(episodes).toHaveLength(1);
		expect(episodes[0]?.payload).toMatchObject({
			attributedTaskCardId: "ab12c",
			processClassification: "agent_shell_tool_command_process",
			commandLineTextForJournal: "GITHUB_TOKEN=[REDACTED] npm run test:guarded",
			peakObservedResidentSetSizeKibibytes: 900_000,
			observedSampleCount: 2,
			processLifetimeEndedBy: "process_exited_between_samples",
		});
	});

	it("reads each process's argv only once rather than on every tick", async () => {
		const table = [row(9, 1, 9, 700_000), row(100, 9, 100, 300_000), row(200, 100, 200, 400_000)];
		const harness = createHarness([table, table, table]);

		await harness.sampler.runSampleTick();
		await harness.sampler.runSampleTick();
		await harness.sampler.runSampleTick();

		expect(harness.readProcessCommandLines).toHaveBeenCalledTimes(1);
	});

	it("publishes a live per-card snapshot with the harness footprint every tick", async () => {
		const harness = createHarness([[row(9, 1, 9, 700_000), row(100, 9, 100, 300_000)]]);

		await harness.sampler.runSampleTick();

		expect(harness.onLiveTaskResourceUsageSnapshotsUpdated).toHaveBeenCalledTimes(1);
		expect(harness.sampler.getLatestLiveTaskResourceUsageSnapshots()[0]).toMatchObject({
			workspaceId: "repo",
			attributedTaskCardId: "ab12c",
			residentSetSizeKibibytesSumUpperBound: 300_000,
			agentHarnessRootPhysicalFootprintBytes: 400_000_000,
		});
	});

	it("writes a periodic snapshot once five minutes have passed since start", async () => {
		const harness = createHarness([[row(9, 1, 9, 700_000), row(100, 9, 100, 300_000)]]);
		// start() 固定首个快照的到期时刻并立即跑一个 tick；此后直接驱动 tick，不依赖真实计时器。
		harness.sampler.start();
		await vi.waitFor(() => expect(harness.onLiveTaskResourceUsageSnapshotsUpdated).toHaveBeenCalled());
		const periodicSnapshotCount = () =>
			harness.journalEvents.filter(
				(event) => event.channel === "task-attributed-process-tree-periodic-resource-snapshot",
			).length;
		expect(periodicSnapshotCount()).toBe(0);

		harness.advanceTimeMs(5 * 60_000);
		await harness.sampler.runSampleTick();
		harness.sampler.stop();

		expect(periodicSnapshotCount()).toBe(1);
	});

	it("flushes still-running processes as episodes when the sampler stops so long-lived processes are not lost", async () => {
		const harness = createHarness([[row(9, 1, 9, 700_000), row(100, 9, 100, 300_000)]]);

		await harness.sampler.runSampleTick();
		harness.sampler.stop();

		expect(
			harness.journalEvents.map((event) => [event.channel, event.payload.processLifetimeEndedBy]),
		).toContainEqual(["task-attributed-process-lifetime-episode", "sampler_stopped"]);
	});

	it("reads the command line of an orphan it only recognized after reading its Kanban env", async () => {
		const journalEvents: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
		const sampler = createTaskAttributedProcessTreeResourceSampler({
			enumerateAttributionRoots: () => ({ ...ENUMERATION, roots: [] }),
			kanbanRuntimeProcessId: 9,
			readProcessResourceTable: async () => [row(9, 1, 9, 700_000), row(500, 1, 500, 40_000)],
			readProcessCommandLines: async (processIds) =>
				new Map(processIds.includes(500) ? [[500, "node /repo/node_modules/.bin/vite --port 5173"]] : []),
			readCurrentWorkingDirectories: async () => new Map(),
			readKanbanEnvironment: async () =>
				new Map([[500, { KANBAN_TASK_ID: "zz999", KANBAN_PROJECT_PATH: "/Users/u/repo" }]]),
			readPhysicalFootprints: async () => new Map(),
			appendJournalEvent: (channel, payload) => {
				journalEvents.push({ channel, payload });
			},
		});

		await sampler.runSampleTick();
		sampler.stop();

		expect(journalEvents[0]?.payload).toMatchObject({
			attributedTaskCardId: "zz999",
			workspaceId: "repo",
			commandLineTextForJournal: "node /repo/node_modules/.bin/vite --port 5173",
		});
	});

	it("never journals a harness's prompt-bearing arguments, neither for its root nor for the real harness a node wrapper re-executed", async () => {
		const taskPromptText = "请修复登录页 TASK-PROMPT-BODY-MUST-NOT-BE-JOURNALED";
		const developerInstructionsArgument =
			'-c developer_instructions="# Kanban Task Workspace\\n\\nPrefer Linear MCP tools. SYSTEM-PROMPT-BODY-MUST-NOT-BE-JOURNALED"';
		const commandLinesByProcessId = new Map<number, string>([
			// npm 装的 codex：根是 node 包装脚本，真正的 codex 是同组子进程，argv 原样带着根的参数。
			[
				100,
				`node /opt/homebrew/bin/codex -c features.worktrees=false ${developerInstructionsArgument} ${taskPromptText}`,
			],
			[
				101,
				`/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex -c features.worktrees=false ${developerInstructionsArgument} ${taskPromptText}`,
			],
			[200, "/bin/zsh -lc GITHUB_TOKEN=abc123 npm run test:guarded"],
		]);
		const journalEvents: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
		const sampler = createTaskAttributedProcessTreeResourceSampler({
			enumerateAttributionRoots: () => ({
				...ENUMERATION,
				roots: ENUMERATION.roots.map((root) => ({ ...root, agentId: "codex" as const })),
			}),
			kanbanRuntimeProcessId: 9,
			readProcessResourceTable: async () => [
				row(9, 1, 9, 700_000),
				row(100, 9, 100, 60_000),
				row(101, 100, 100, 300_000),
				row(200, 100, 200, 40_000),
			],
			readProcessCommandLines: async (processIds) =>
				new Map(
					processIds.flatMap((processId) => {
						const commandLine = commandLinesByProcessId.get(processId);
						return commandLine === undefined ? [] : [[processId, commandLine] as const];
					}),
				),
			readCurrentWorkingDirectories: async () => new Map(),
			readKanbanEnvironment: async () => new Map(),
			readPhysicalFootprints: async () => new Map(),
			appendJournalEvent: (channel, payload) => {
				journalEvents.push({ channel, payload });
			},
		});

		await sampler.runSampleTick();
		sampler.stop();

		const commandLineTextByProcessId = new Map(
			journalEvents.map((event) => [event.payload.processId, event.payload.commandLineTextForJournal]),
		);
		expect(commandLineTextByProcessId.get(100)).toMatch(/^node \[harness 参数已省略 \d+ 字符\]$/);
		expect(commandLineTextByProcessId.get(101)).toMatch(/^codex \[harness 参数已省略 \d+ 字符\]$/);
		expect(commandLineTextByProcessId.get(200)).toBe("GITHUB_TOKEN=[REDACTED] npm run test:guarded");
		expect(JSON.stringify(journalEvents)).not.toContain("MUST-NOT-BE-JOURNALED");
	});

	describe("after a Kanban restart left pre-restart processes recoverable only through their Kanban env", () => {
		const taskPromptText = "请修复登录页 TASK-PROMPT-BODY-MUST-NOT-BE-JOURNALED";
		const codexArgumentTail = `-c check_for_update_on_startup=false -c developer_instructions="# Kanban Task Workspace\\n\\nPrefer Linear MCP tools. SYSTEM-PROMPT-BODY-MUST-NOT-BE-JOURNALED" ${taskPromptText}`;
		const commandLinesByProcessId = new Map<number, string>([
			// 重启前起的 codex 会话：PTY 已断，npm 装的 node 包装脚本被 launchd 收养（ppid=1）。
			[700, `node /opt/homebrew/bin/codex ${codexArgumentTail}`],
			// 包装脚本 re-exec 出的真正 codex（旧版 npm 包的 vendor 二进制按平台命名），argv 原样带着根的参数尾。
			[701, `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex-aarch64-apple-darwin ${codexArgumentTail}`],
			// 同一棵孤儿树里 agent 用 Bash 工具跑的普通命令：照旧取内层命令、截断 + 脱敏。
			[702, "/bin/zsh -lc GITHUB_TOKEN=abc123 npm run test:guarded"],
			// 另一棵孤儿树：agent 以后台方式起的 dev server，自己被 launchd 收养。
			[800, "node /Users/u/repo/node_modules/.bin/vite --port 5173 --api-key abcdef123456"],
		]);
		const kanbanEnvironment = { KANBAN_TASK_ID: "zz999", KANBAN_PROJECT_PATH: "/Users/u/repo" };

		function createOrphanRecoverySampler(tables: PosixProcessResourceTableRow[][]) {
			let tickIndex = 0;
			const journalEvents: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
			const sampler = createTaskAttributedProcessTreeResourceSampler({
				enumerateAttributionRoots: () => ({ ...ENUMERATION, roots: [] }),
				kanbanRuntimeProcessId: 9,
				readProcessResourceTable: async () => tables[Math.min(tickIndex++, tables.length - 1)] ?? [],
				readProcessCommandLines: async (processIds) =>
					new Map(
						processIds.flatMap((processId) => {
							const commandLine = commandLinesByProcessId.get(processId);
							return commandLine === undefined ? [] : [[processId, commandLine] as const];
						}),
					),
				readCurrentWorkingDirectories: async () => new Map(),
				// 只有 ppid=1 的孤儿头会被定向读 env；同树后代沿用孤儿头的归因。
				readKanbanEnvironment: async (processIds) =>
					new Map(
						processIds
							.filter((processId) => processId === 700 || processId === 800)
							.map((processId) => [processId, kanbanEnvironment] as const),
					),
				readPhysicalFootprints: async () => new Map(),
				appendJournalEvent: (channel, payload) => {
					journalEvents.push({ channel, payload });
				},
			});
			const journaledCommandLineTextByProcessId = () =>
				new Map(journalEvents.map((event) => [event.payload.processId, event.payload.commandLineTextForJournal]));
			return { sampler, journalEvents, journaledCommandLineTextByProcessId };
		}

		it("elides the recovered codex root and its re-executed child, while ordinary orphaned commands keep truncation + redaction", async () => {
			const { sampler, journalEvents, journaledCommandLineTextByProcessId } = createOrphanRecoverySampler([
				[
					row(9, 1, 9, 700_000),
					row(700, 1, 700, 60_000),
					row(701, 700, 700, 300_000),
					row(702, 701, 702, 40_000),
					row(800, 1, 800, 40_000),
				],
			]);

			await sampler.runSampleTick();
			sampler.stop();

			const commandLineTextByProcessId = journaledCommandLineTextByProcessId();
			expect(commandLineTextByProcessId.get(700)).toBe(
				`node [harness 参数已省略 ${`/opt/homebrew/bin/codex ${codexArgumentTail}`.length} 字符]`,
			);
			expect(commandLineTextByProcessId.get(701)).toMatch(
				/^codex-aarch64-apple-darwin \[harness 参数已省略 \d+ 字符\]$/,
			);
			expect(commandLineTextByProcessId.get(702)).toBe("GITHUB_TOKEN=[REDACTED] npm run test:guarded");
			expect(commandLineTextByProcessId.get(800)).toBe(
				"node /Users/u/repo/node_modules/.bin/vite --port 5173 --api-key [REDACTED]",
			);
			// 分类如实保持「env 找回的残留进程」：省略只改落盘的命令文本，不冒充正常会话树里的类别。
			expect(
				journalEvents
					.filter((event) => event.payload.processId === 700 || event.payload.processId === 701)
					.map((event) => event.payload.processClassification),
			).toEqual([
				"orphaned_process_recovered_by_kanban_environment_variables",
				"orphaned_process_recovered_by_kanban_environment_variables",
			]);
			expect(JSON.stringify(journalEvents)).not.toContain("MUST-NOT-BE-JOURNALED");
		});

		it("still elides a re-executed child that only shows up after the recovered root is already remembered", async () => {
			const { sampler, journalEvents, journaledCommandLineTextByProcessId } = createOrphanRecoverySampler([
				[row(9, 1, 9, 700_000), row(700, 1, 700, 60_000)],
				[row(9, 1, 9, 700_000), row(700, 1, 700, 60_000), row(701, 700, 700, 300_000)],
			]);

			await sampler.runSampleTick();
			await sampler.runSampleTick();
			sampler.stop();

			expect(journaledCommandLineTextByProcessId().get(701)).toMatch(
				/^codex-aarch64-apple-darwin \[harness 参数已省略 \d+ 字符\]$/,
			);
			expect(JSON.stringify(journalEvents)).not.toContain("MUST-NOT-BE-JOURNALED");
		});
	});

	it("re-summarizes a process that only turned out to be a harness root after its argv was first summarized", async () => {
		const harnessCommandLine =
			"opencode --model anthropic/claude-sonnet-4-5 --prompt TASK-PROMPT-BODY-MUST-NOT-BE-JOURNALED";
		let sessionSummaryHasRecordedThePid = false;
		const journalEvents: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
		const sampler = createTaskAttributedProcessTreeResourceSampler({
			// 第一轮会话 summary 还没盖上 pid：这个进程只能按 cwd 归到「Kanban 拉起的进程」。
			enumerateAttributionRoots: () => ({
				...ENUMERATION,
				roots: sessionSummaryHasRecordedThePid
					? ENUMERATION.roots.map((root) => ({ ...root, agentId: "opencode" as const }))
					: [],
				taskWorkingDirectoryAttributions: [
					{
						workspaceId: "repo",
						attributedTaskCardId: "ab12c",
						workingDirectoryPath: "/Users/u/repo",
						latestSessionUpdatedAtEpochMs: T0,
					},
				],
			}),
			kanbanRuntimeProcessId: 9,
			readProcessResourceTable: async () => [row(9, 1, 9, 700_000), row(100, 9, 100, 300_000)],
			readProcessCommandLines: async (processIds) =>
				new Map(processIds.includes(100) ? [[100, harnessCommandLine]] : []),
			readCurrentWorkingDirectories: async (processIds) =>
				new Map(processIds.includes(100) ? [[100, "/Users/u/repo"]] : []),
			readKanbanEnvironment: async () => new Map(),
			readPhysicalFootprints: async () => new Map(),
			appendJournalEvent: (channel, payload) => {
				journalEvents.push({ channel, payload });
			},
		});

		await sampler.runSampleTick();
		sessionSummaryHasRecordedThePid = true;
		await sampler.runSampleTick();
		sampler.stop();

		expect(journalEvents).toHaveLength(1);
		expect(journalEvents[0]?.payload).toMatchObject({
			processClassification: "agent_harness_root_process",
			commandLineTextForJournal: `opencode [harness 参数已省略 ${harnessCommandLine.length - "opencode ".length} 字符]`,
		});
	});

	it("swallows a failing OS read instead of throwing into the runtime", async () => {
		const sampler = createTaskAttributedProcessTreeResourceSampler({
			enumerateAttributionRoots: () => ENUMERATION,
			readProcessResourceTable: async () => {
				throw new Error("ps: command not found");
			},
			appendJournalEvent: () => {},
		});
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await expect(sampler.runSampleTick()).resolves.toBeUndefined();
		await expect(sampler.runSampleTick()).resolves.toBeUndefined();

		expect(stderrWrite).toHaveBeenCalledTimes(1);
		stderrWrite.mockRestore();
	});
});
