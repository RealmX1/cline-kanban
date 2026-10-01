import { describe, expect, it } from "vitest";

import {
	buildProcessLifetimeIdentityKey,
	type PosixProcessResourceTableRow,
} from "../../../src/diagnostics/posix-process-table-with-resource-columns-reader";
import {
	attributeProcessTableSampleToTasks,
	type TaskAttributedProcessAttribution,
	type TaskAttributedProcessTreeSampleAttributionInput,
} from "../../../src/diagnostics/task-attributed-process-tree-sample-attribution";
import type { TaskResourceUsageAttributionRoot } from "../../../src/server/task-resource-usage-attribution-root-enumeration";

// 夹具仿照 2026-09-30 现场进程树：Kanban 9104 → claude 68861 → MCP / Bash 外壳 / hook CLI。
const KANBAN_RUNTIME_PROCESS_ID = 9104;
const SESSION_START_TIME_TEXT = "Wed Sep 30 00:40:58 2026";
const SESSION_STARTED_AT_EPOCH_MS = new Date(2026, 8, 30, 0, 40, 58).getTime();

function row(
	processId: number,
	parentProcessId: number,
	processGroupId: number,
	overrides: Partial<PosixProcessResourceTableRow> = {},
): PosixProcessResourceTableRow {
	return {
		processId,
		parentProcessId,
		processGroupId,
		residentSetSizeKibibytes: 10_000,
		cumulativeCpuTimeSeconds: 1,
		processStartTimeText: SESSION_START_TIME_TEXT,
		processStartedAtEpochMs: SESSION_STARTED_AT_EPOCH_MS,
		processStateCode: "S",
		...overrides,
	};
}

const COMMAND_LINES_BY_PROCESS_ID = new Map<number, string>([
	[68861, "claude --allow-dangerously-skip-permissions --model default"],
	[73551, "npm exec @upstash/context7-mcp"],
	[76600, "node /Users/u/.npm/_npx/eea2bd/node_modules/.bin/context7-mcp"],
	[73552, "/Users/u/.local/bin/uv tool uvx --from git+https://github.com/oraios/serena serena start-mcp-server"],
	[78049, "/Users/u/.cache/uv/archive-v0/x/bin/python /Users/u/.cache/uv/archive-v0/x/bin/serena start-mcp-server"],
	[83931, "node /Users/u/.serena/language_servers/ts-lsp/node_modules/.bin/typescript-language-server --stdio"],
	[42821, "caffeinate -i -t 300"],
	[
		4120,
		"/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'npm run build' < /dev/null && pwd -P >| /tmp/claude-1-cwd",
	],
	[4132, "node /Users/u/.cline/worktrees/ab12c/repo/node_modules/.bin/vite build"],
	[
		3052,
		"/Users/u/.nvm/versions/node/v24.12.0/bin/node /Users/u/.nvm/versions/node/v24.12.0/bin/kanban hooks ingest --event activity",
	],
	[70000, "/bin/zsh -c npm test"],
	[70001, "node /Users/u/.cline/worktrees/cc111/repo/node_modules/.bin/vitest run"],
	[50000, "node /Users/u/.cline/worktrees/zz999/repo/node_modules/.bin/vite --port 5173"],
	[50001, "/Applications/Some.app/Contents/MacOS/Some"],
]);

const FIXTURE_ROWS: PosixProcessResourceTableRow[] = [
	row(KANBAN_RUNTIME_PROCESS_ID, 9103, 9103),
	row(68861, KANBAN_RUNTIME_PROCESS_ID, 68861, { residentSetSizeKibibytes: 295_000 }),
	row(73551, 68861, 68861),
	row(76600, 73551, 68861),
	row(73552, 68861, 68861),
	row(78049, 73552, 68861),
	row(83931, 78049, 83931),
	row(42821, 68861, 68861),
	row(4120, 68861, 4120),
	row(4132, 4120, 4120, { residentSetSizeKibibytes: 900_000 }),
	row(3052, 68861, 3052),
	row(70000, KANBAN_RUNTIME_PROCESS_ID, 70000),
	row(70001, 70000, 70000),
	row(50000, 1, 50000),
	row(50001, 1, 50001),
];

const CLAUDE_TASK_ROOT: TaskResourceUsageAttributionRoot = {
	workspaceId: "repo",
	workspacePath: "/Users/u/repo",
	sessionTaskId: "ab12c",
	attributedTaskCardId: "ab12c",
	sessionCategory: "task_card_main_agent_session",
	sessionTransport: "pty_terminal",
	agentId: "claude",
	rootProcessId: 68861,
	rootProcessRole: "agent_harness_root",
	runtimeSessionIncarnationId: "inc-1",
	rootSessionStartedAtEpochMs: SESSION_STARTED_AT_EPOCH_MS + 800,
};

function keyedByLifetimeIdentity<T>(
	valuesByProcessId: Map<number, T>,
	rows: PosixProcessResourceTableRow[],
): Map<string, T> {
	const keyed = new Map<string, T>();
	for (const fixtureRow of rows) {
		const value = valuesByProcessId.get(fixtureRow.processId);
		if (value !== undefined) {
			keyed.set(buildProcessLifetimeIdentityKey(fixtureRow.processId, fixtureRow.processStartTimeText), value);
		}
	}
	return keyed;
}

function fullyResolvedInput(
	overrides: Partial<TaskAttributedProcessTreeSampleAttributionInput> = {},
): TaskAttributedProcessTreeSampleAttributionInput {
	const rows = overrides.processTableRows ? [...overrides.processTableRows] : FIXTURE_ROWS;
	return {
		processTableRows: rows,
		attributionRoots: [CLAUDE_TASK_ROOT],
		taskWorkingDirectoryAttributions: [
			{
				workspaceId: "repo",
				workingDirectoryPath: "/Users/u/.cline/worktrees/cc111/repo",
				latestSessionUpdatedAtEpochMs: SESSION_STARTED_AT_EPOCH_MS,
				attributedTaskCardId: "cc111",
			},
		],
		kanbanRuntimeProcessId: KANBAN_RUNTIME_PROCESS_ID,
		commandLineByProcessLifetimeIdentityKey: keyedByLifetimeIdentity(COMMAND_LINES_BY_PROCESS_ID, rows),
		currentWorkingDirectoryByProcessLifetimeIdentityKey: keyedByLifetimeIdentity(
			new Map([[70000, "/Users/u/.cline/worktrees/cc111/repo/packages/x"]]),
			rows,
		),
		kanbanEnvironmentByProcessLifetimeIdentityKey: keyedByLifetimeIdentity(
			new Map<number, Record<string, string>>([
				[50000, { KANBAN_TASK_ID: "zz999", KANBAN_PROJECT_PATH: "/Users/u/repo" }],
				[50001, {}],
			]),
			rows,
		),
		rememberedAttributionByProcessLifetimeIdentityKey: new Map(),
		workspaceIdByWorkspacePath: new Map([["/Users/u/repo", "repo"]]),
		...overrides,
	};
}

function classificationsByProcessId(input: TaskAttributedProcessTreeSampleAttributionInput): Map<number, string> {
	return new Map(
		attributeProcessTableSampleToTasks(input).observations.map((observation) => [
			observation.processTableRow.processId,
			observation.attribution.processClassification,
		]),
	);
}

describe("attributeProcessTableSampleToTasks", () => {
	it("reports what still has to be read on the first pass instead of guessing", () => {
		const result = attributeProcessTableSampleToTasks(
			fullyResolvedInput({
				commandLineByProcessLifetimeIdentityKey: new Map(),
				currentWorkingDirectoryByProcessLifetimeIdentityKey: new Map(),
				kanbanEnvironmentByProcessLifetimeIdentityKey: new Map(),
			}),
		);

		expect(new Set(result.processIdsMissingCommandLine)).toEqual(
			new Set([68861, 73551, 76600, 73552, 78049, 83931, 42821, 4120, 4132, 3052]),
		);
		expect(result.kanbanRuntimeChildProcessIdsMissingWorkingDirectory).toEqual([70000]);
		expect(new Set(result.orphanCandidateProcessIdsMissingKanbanEnvironment)).toEqual(new Set([50000, 50001]));
	});

	it("classifies every process of a Claude session tree once its command lines are known", () => {
		const classifications = classificationsByProcessId(fullyResolvedInput());

		expect(Object.fromEntries(classifications)).toMatchObject({
			68861: "agent_harness_root_process",
			73551: "mcp_server_launcher_wrapper_process",
			76600: "mcp_server_process",
			73552: "mcp_server_launcher_wrapper_process",
			78049: "mcp_server_process",
			83931: "mcp_server_process",
			42821: "agent_harness_helper_process",
			4120: "agent_shell_tool_command_process",
			4132: "agent_shell_tool_command_process",
			3052: "kanban_hook_cli_process",
		});
	});

	it("labels MCP processes with the instance they belong to so wrapper and server add up to one MCP", () => {
		const labels = new Map(
			attributeProcessTableSampleToTasks(fullyResolvedInput()).observations.map((observation) => [
				observation.processTableRow.processId,
				observation.attribution.mcpServerInstanceLabel,
			]),
		);

		expect(labels.get(73551)).toBe("@upstash/context7-mcp");
		expect(labels.get(76600)).toBe("@upstash/context7-mcp");
		expect(labels.get(83931)).toBe("serena");
		expect(labels.get(4120)).toBeNull();
	});

	it("attributes a Kanban-spawned command tree to the task whose worktree holds its cwd", () => {
		const observations = attributeProcessTableSampleToTasks(fullyResolvedInput()).observations.filter(
			(observation) => observation.attributionAnchor === "kanban_runtime_child_working_directory",
		);

		expect(
			observations.map((observation) => [
				observation.processTableRow.processId,
				observation.attribution.attributedTaskCardId,
			]),
		).toEqual([
			[70000, "cc111"],
			[70001, "cc111"],
		]);
		expect(observations[0]?.attribution.processClassification).toBe("kanban_runtime_spawned_task_process");
	});

	it("recovers a pre-restart orphan through its Kanban env and ignores unrelated launchd children", () => {
		const observations = attributeProcessTableSampleToTasks(fullyResolvedInput()).observations;
		const recovered = observations.find((observation) => observation.processTableRow.processId === 50000);

		expect(recovered).toMatchObject({
			attributionAnchor: "kanban_environment_variables",
			attributionRootProcessIsAlive: false,
			attribution: {
				workspaceId: "repo",
				attributedTaskCardId: "zz999",
				processClassification: "orphaned_process_recovered_by_kanban_environment_variables",
			},
		});
		expect(observations.some((observation) => observation.processTableRow.processId === 50001)).toBe(false);
	});

	// env 取值仿照 src/terminal/session-manager.ts 的 taskContextEnv + hook-runtime-context.ts 的实际注入：
	// KANBAN_TASK_ID = workspaceTaskId ?? taskId（宿主卡片），会话自身 id 在 KANBAN_TASK_CONVERSATION_SESSION_ID 等键里。
	it.each<{
		scenario: string;
		kanbanEnvironment: Record<string, string>;
		expectedSessionTaskId: string;
		expectedAttributedTaskCardId: string | null;
	}>([
		{
			scenario: "by-the-way side session keeps its own session id and is charged to its host card",
			kanbanEnvironment: {
				KANBAN_TASK_ID: "host1",
				CLINE_KANBAN_TASK_ID: "host1",
				KANBAN_ATTEMPT_ID: "btw-session-9",
				CLINE_KANBAN_ATTEMPT_ID: "btw-session-9",
				KANBAN_TASK_CONVERSATION_SESSION_ID: "btw-session-9",
				KANBAN_HOOK_TASK_ID: "btw-session-9",
				KANBAN_HOOK_WORKSPACE_ID: "repo",
				KANBAN_PROJECT_PATH: "/Users/u/.cline/worktrees/host1/repo",
			},
			expectedSessionTaskId: "btw-session-9",
			expectedAttributedTaskCardId: "host1",
		},
		{
			scenario: "home user shell terminal is a workspace-level resource, not a card",
			kanbanEnvironment: { KANBAN_TASK_ID: "__home_terminal__", KANBAN_PROJECT_PATH: "/Users/u/repo" },
			expectedSessionTaskId: "__home_terminal__",
			expectedAttributedTaskCardId: null,
		},
		{
			scenario: "card detail user shell terminal resolves back to its card id",
			kanbanEnvironment: {
				KANBAN_TASK_ID: "__detail_terminal__:cc111",
				KANBAN_PROJECT_PATH: "/Users/u/repo",
			},
			expectedSessionTaskId: "__detail_terminal__:cc111",
			expectedAttributedTaskCardId: "cc111",
		},
		{
			scenario: "home sidebar agent session is a workspace-level resource, not a card",
			kanbanEnvironment: {
				KANBAN_TASK_ID: "__home_agent__:repo:claude",
				KANBAN_ATTEMPT_ID: "__home_agent__:repo:claude",
				KANBAN_TASK_CONVERSATION_SESSION_ID: "__home_agent__:repo:claude",
				KANBAN_PROJECT_PATH: "/Users/u/repo",
			},
			expectedSessionTaskId: "__home_agent__:repo:claude",
			expectedAttributedTaskCardId: null,
		},
		{
			scenario: "an empty conversation session id value falls back instead of becoming the identity",
			kanbanEnvironment: {
				KANBAN_TASK_ID: "zz999",
				KANBAN_TASK_CONVERSATION_SESSION_ID: "",
				KANBAN_ATTEMPT_ID: "zz999",
				KANBAN_PROJECT_PATH: "/Users/u/repo",
			},
			expectedSessionTaskId: "zz999",
			expectedAttributedTaskCardId: "zz999",
		},
	])(
		"recovers env-only orphans with the same session/card identity as the live path: $scenario",
		({ kanbanEnvironment, expectedSessionTaskId, expectedAttributedTaskCardId }) => {
			// 孤儿头 60000（ppid=1）带一个后代 60001：两者都应拿到同一组身份。
			const rows = [...FIXTURE_ROWS, row(60000, 1, 60000), row(60001, 60000, 60000)];
			const observations = attributeProcessTableSampleToTasks(
				fullyResolvedInput({
					processTableRows: rows,
					kanbanEnvironmentByProcessLifetimeIdentityKey: keyedByLifetimeIdentity(
						new Map<number, Record<string, string>>([[60000, kanbanEnvironment]]),
						rows,
					),
				}),
			).observations;

			for (const processId of [60000, 60001]) {
				expect(
					observations.find((observation) => observation.processTableRow.processId === processId),
				).toMatchObject({
					attributionAnchor: "kanban_environment_variables",
					attribution: {
						workspaceId: "repo",
						sessionTaskId: expectedSessionTaskId,
						attributedTaskCardId: expectedAttributedTaskCardId,
						sessionCategory: "recovered_by_kanban_environment_variables",
					},
				});
			}
		},
	);

	it("keeps attributing a command that outlived its session root through the attribution remembered earlier", () => {
		const firstPass = attributeProcessTableSampleToTasks(fullyResolvedInput());
		const remembered = new Map<string, TaskAttributedProcessAttribution>(
			firstPass.observations.map((observation) => [observation.processLifetimeIdentityKey, observation.attribution]),
		);
		// claude 根退出；已 setsid 的 Bash 外壳被 launchd 收养。
		const rowsAfterSessionExit = FIXTURE_ROWS.filter((fixtureRow) => fixtureRow.processId !== 68861).map(
			(fixtureRow) => (fixtureRow.processId === 4120 ? { ...fixtureRow, parentProcessId: 1 } : fixtureRow),
		);

		const observations = attributeProcessTableSampleToTasks(
			fullyResolvedInput({
				processTableRows: rowsAfterSessionExit,
				attributionRoots: [],
				rememberedAttributionByProcessLifetimeIdentityKey: remembered,
			}),
		).observations;
		const orphanedShell = observations.find((observation) => observation.processTableRow.processId === 4120);
		const orphanedVite = observations.find((observation) => observation.processTableRow.processId === 4132);

		expect(orphanedShell).toMatchObject({
			attributionAnchor: "remembered_from_earlier_sample",
			attributionRootProcessIsAlive: false,
			attribution: { attributedTaskCardId: "ab12c", processClassification: "agent_shell_tool_command_process" },
		});
		expect(orphanedVite?.attribution.attributedTaskCardId).toBe("ab12c");
	});

	it("refuses a session root whose pid now belongs to a process started long after the session", () => {
		const reusedPidRows = FIXTURE_ROWS.map((fixtureRow) =>
			fixtureRow.processId === 68861
				? {
						...fixtureRow,
						processStartTimeText: "Wed Sep 30 09:00:00 2026",
						processStartedAtEpochMs: SESSION_STARTED_AT_EPOCH_MS + 8 * 3_600_000,
					}
				: fixtureRow,
		);

		const observations = attributeProcessTableSampleToTasks(
			fullyResolvedInput({ processTableRows: reusedPidRows }),
		).observations;

		expect(observations.some((observation) => observation.attribution.sessionTaskId === "ab12c")).toBe(false);
	});
});
