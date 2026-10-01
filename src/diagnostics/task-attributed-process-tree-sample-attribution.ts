// 一次进程表采样 → 「哪些进程记在哪个 task 的账上」（纯函数）。
//
// 归因锚点，按优先级：
//   1. 会话根进程树：会话 summary 上的活体 pid 为根做 BFS，最可靠；
//   2. Kanban 运行时的直接子进程 + cwd 落在某个 task 的工作目录里（Cline SDK 的 run_commands、验证脚本、
//      exploration 维护作业都走这条，它们在进程树上只挂在 Kanban 下面）；
//   3. 上一轮已归因、这一轮已不在任何根树里的进程：沿用记忆里的归因。这是识别**孤儿**的关键——
//      Bash 工具命令已 setsid，会话根退出后它们被 launchd 收养，进程树上已经找不回原主；
//   4. Kanban 重启前就被收养的孤儿没有记忆可用，只能对 ppid=1 的未知进程定向读 env 里的 KANBAN_*
//      （会话 id 与宿主卡片 id 分别取自不同的注入键，卡片归属与第 1 条走同一个判定）。
//
// 调用方式是两段式：先调用一次拿到「缺 argv / 缺 cwd / 缺 env」的清单，补读后再调用一次得到最终归因。
// 两次调用都是纯计算（BFS 几百个进程，毫秒级）。

import type { RuntimeAgentId, RuntimeAgentSessionTransport } from "../core/api-contract";
import {
	resolveSessionCategoryAndAttributedTaskCardId,
	type TaskResourceUsageAttributionRoot,
	type TaskResourceUsageAttributionSessionCategory,
	type TaskWorkingDirectoryAttribution,
} from "../server/task-resource-usage-attribution-root-enumeration";
import {
	buildProcessLifetimeIdentityKey,
	type PosixProcessResourceTableRow,
} from "./posix-process-table-with-resource-columns-reader";
import {
	classifyTaskAttributedProcess,
	deriveMcpServerInstanceLabelFromBranchHeadCommandLine,
	isKanbanHookCliCommandLine,
	type TaskAttributedProcessClassification,
} from "./task-attributed-process-classification-rules";

// 会话 summary 的 startedAt 与该 pid 的 lstart 相差超过这个量，就认定 pid 已被系统复用给了无关进程。
const SESSION_ROOT_PROCESS_START_TIME_MATCH_TOLERANCE_MS = 120_000;

export type TaskAttributedProcessAttributionAnchor =
	| "session_root_process_tree"
	| "kanban_runtime_child_working_directory"
	| "remembered_from_earlier_sample"
	| "kanban_environment_variables";

export type TaskAttributedProcessSessionCategory =
	| TaskResourceUsageAttributionSessionCategory
	| "kanban_runtime_spawned_by_working_directory"
	| "recovered_by_kanban_environment_variables";

export interface TaskAttributedProcessAttribution {
	workspaceId: string | null;
	attributedTaskCardId: string | null;
	sessionTaskId: string | null;
	sessionCategory: TaskAttributedProcessSessionCategory;
	sessionTransport: RuntimeAgentSessionTransport | null;
	agentId: RuntimeAgentId | null;
	runtimeSessionIncarnationId: string | null;
	// 这一组归因的根（会话根 / Kanban 子进程头 / env 找回的孤儿头）。
	attributionRootProcessId: number;
	attributionRootProcessLifetimeIdentityKey: string;
	branchHeadProcessId: number;
	processClassification: TaskAttributedProcessClassification;
	mcpServerInstanceLabel: string | null;
}

export interface TaskAttributedProcessObservation {
	processLifetimeIdentityKey: string;
	processTableRow: PosixProcessResourceTableRow;
	attribution: TaskAttributedProcessAttribution;
	attributionAnchor: TaskAttributedProcessAttributionAnchor;
	// 归因根此刻是否还活着；会话根已退出而本进程仍在 = 残留（孤儿）。
	attributionRootProcessIsAlive: boolean;
}

export interface TaskAttributedProcessTreeSampleAttributionInput {
	processTableRows: readonly PosixProcessResourceTableRow[];
	attributionRoots: readonly TaskResourceUsageAttributionRoot[];
	taskWorkingDirectoryAttributions: readonly TaskWorkingDirectoryAttribution[];
	kanbanRuntimeProcessId: number;
	commandLineByProcessLifetimeIdentityKey: ReadonlyMap<string, string>;
	currentWorkingDirectoryByProcessLifetimeIdentityKey: ReadonlyMap<string, string>;
	kanbanEnvironmentByProcessLifetimeIdentityKey: ReadonlyMap<string, Readonly<Record<string, string>>>;
	rememberedAttributionByProcessLifetimeIdentityKey: ReadonlyMap<string, TaskAttributedProcessAttribution>;
	// 用 env 里的 KANBAN_PROJECT_PATH 找回 workspaceId。
	workspaceIdByWorkspacePath: ReadonlyMap<string, string>;
}

export interface TaskAttributedProcessTreeSampleAttributionResult {
	observations: TaskAttributedProcessObservation[];
	processIdsMissingCommandLine: number[];
	kanbanRuntimeChildProcessIdsMissingWorkingDirectory: number[];
	orphanCandidateProcessIdsMissingKanbanEnvironment: number[];
}

function keyOf(row: PosixProcessResourceTableRow): string {
	return buildProcessLifetimeIdentityKey(row.processId, row.processStartTimeText);
}

function isZombieProcess(row: PosixProcessResourceTableRow): boolean {
	return row.processStateCode.includes("Z");
}

function sessionRootMatchesProcessStart(
	root: TaskResourceUsageAttributionRoot,
	row: PosixProcessResourceTableRow,
): boolean {
	if (root.rootSessionStartedAtEpochMs === null || row.processStartedAtEpochMs === null) {
		return true;
	}
	return (
		Math.abs(row.processStartedAtEpochMs - root.rootSessionStartedAtEpochMs) <=
		SESSION_ROOT_PROCESS_START_TIME_MATCH_TOLERANCE_MS
	);
}

// cwd 落在某个 task 工作目录（或其子目录）里；取最长匹配，避免仓库根吞掉 worktree。
function findTaskWorkingDirectoryAttributionForCurrentWorkingDirectory(
	currentWorkingDirectory: string,
	taskWorkingDirectoryAttributions: readonly TaskWorkingDirectoryAttribution[],
): TaskWorkingDirectoryAttribution | null {
	let bestMatch: TaskWorkingDirectoryAttribution | null = null;
	for (const candidate of taskWorkingDirectoryAttributions) {
		const isInside =
			currentWorkingDirectory === candidate.workingDirectoryPath ||
			currentWorkingDirectory.startsWith(`${candidate.workingDirectoryPath}/`);
		if (
			isInside &&
			(bestMatch === null || candidate.workingDirectoryPath.length > bestMatch.workingDirectoryPath.length)
		) {
			bestMatch = candidate;
		}
	}
	return bestMatch;
}

export function attributeProcessTableSampleToTasks(
	input: TaskAttributedProcessTreeSampleAttributionInput,
): TaskAttributedProcessTreeSampleAttributionResult {
	const rowsByProcessId = new Map<number, PosixProcessResourceTableRow>();
	const childRowsByParentProcessId = new Map<number, PosixProcessResourceTableRow[]>();
	for (const row of input.processTableRows) {
		rowsByProcessId.set(row.processId, row);
		const siblings = childRowsByParentProcessId.get(row.parentProcessId);
		if (siblings) {
			siblings.push(row);
		} else {
			childRowsByParentProcessId.set(row.parentProcessId, [row]);
		}
	}
	const liveProcessLifetimeIdentityKeys = new Set(input.processTableRows.map(keyOf));

	const observations: TaskAttributedProcessObservation[] = [];
	const assignedProcessIds = new Set<number>();
	const processIdsMissingCommandLine = new Set<number>();
	const commandLineOf = (row: PosixProcessResourceTableRow): string | null => {
		const commandLine = input.commandLineByProcessLifetimeIdentityKey.get(keyOf(row));
		if (commandLine === undefined) {
			processIdsMissingCommandLine.add(row.processId);
			return null;
		}
		return commandLine;
	};

	// 从 headRow 起 BFS 整棵子树（含 head 本身），对每个进程按 buildAttribution 生成归因。
	const walkSubtree = (
		headRow: PosixProcessResourceTableRow,
		attributionAnchor: TaskAttributedProcessAttributionAnchor,
		attributionRootIsAlive: boolean,
		buildAttribution: (
			row: PosixProcessResourceTableRow,
			branchHeadRow: PosixProcessResourceTableRow,
		) => TaskAttributedProcessAttribution,
		headIsAttributionRoot: boolean,
	): void => {
		const queue: Array<{ row: PosixProcessResourceTableRow; branchHeadRow: PosixProcessResourceTableRow }> = [
			{ row: headRow, branchHeadRow: headRow },
		];
		while (queue.length > 0) {
			const next = queue.shift();
			if (!next || assignedProcessIds.has(next.row.processId)) {
				continue;
			}
			assignedProcessIds.add(next.row.processId);
			observations.push({
				processLifetimeIdentityKey: keyOf(next.row),
				processTableRow: next.row,
				attribution: buildAttribution(next.row, next.branchHeadRow),
				attributionAnchor,
				attributionRootProcessIsAlive: attributionRootIsAlive,
			});
			for (const childRow of childRowsByParentProcessId.get(next.row.processId) ?? []) {
				// 根的直接子进程各自成为分支头；更深的后代沿用所在分支的分支头。
				const branchHeadRow = headIsAttributionRoot && next.row === headRow ? childRow : next.branchHeadRow;
				queue.push({ row: childRow, branchHeadRow });
			}
		}
	};

	// 1. 会话根进程树。
	const verifiedSessionRootProcessIds = new Set<number>();
	for (const root of input.attributionRoots) {
		const rootRow = rowsByProcessId.get(root.rootProcessId);
		if (!rootRow || isZombieProcess(rootRow) || !sessionRootMatchesProcessStart(root, rootRow)) {
			continue;
		}
		verifiedSessionRootProcessIds.add(root.rootProcessId);
		const rootProcessLifetimeIdentityKey = keyOf(rootRow);
		walkSubtree(
			rootRow,
			"session_root_process_tree",
			true,
			(row, branchHeadRow) =>
				buildSessionRootTreeAttribution(
					root,
					rootRow,
					rootProcessLifetimeIdentityKey,
					row,
					branchHeadRow,
					commandLineOf,
				),
			true,
		);
	}

	// 2. Kanban 运行时的直接子进程，按 cwd 归因。
	const kanbanRuntimeChildProcessIdsMissingWorkingDirectory: number[] = [];
	for (const childRow of childRowsByParentProcessId.get(input.kanbanRuntimeProcessId) ?? []) {
		if (
			assignedProcessIds.has(childRow.processId) ||
			verifiedSessionRootProcessIds.has(childRow.processId) ||
			isZombieProcess(childRow)
		) {
			continue;
		}
		const currentWorkingDirectory = input.currentWorkingDirectoryByProcessLifetimeIdentityKey.get(keyOf(childRow));
		if (currentWorkingDirectory === undefined) {
			kanbanRuntimeChildProcessIdsMissingWorkingDirectory.push(childRow.processId);
			continue;
		}
		const workingDirectoryAttribution = findTaskWorkingDirectoryAttributionForCurrentWorkingDirectory(
			currentWorkingDirectory,
			input.taskWorkingDirectoryAttributions,
		);
		if (!workingDirectoryAttribution) {
			continue;
		}
		const headProcessLifetimeIdentityKey = keyOf(childRow);
		walkSubtree(
			childRow,
			"kanban_runtime_child_working_directory",
			true,
			(row, branchHeadRow) => ({
				workspaceId: workingDirectoryAttribution.workspaceId,
				attributedTaskCardId: workingDirectoryAttribution.attributedTaskCardId,
				sessionTaskId: null,
				sessionCategory: "kanban_runtime_spawned_by_working_directory",
				sessionTransport: null,
				agentId: null,
				runtimeSessionIncarnationId: null,
				attributionRootProcessId: childRow.processId,
				attributionRootProcessLifetimeIdentityKey: headProcessLifetimeIdentityKey,
				branchHeadProcessId: branchHeadRow.processId,
				processClassification: classifyTaskAttributedProcess({
					rootProcessRole: "kanban_runtime_spawned_task_process_root",
					rootProcessGroupId: childRow.processGroupId,
					processIsAttributionRoot: row === childRow,
					processCommandLine: commandLineOf(row),
					branchHeadProcessGroupId: branchHeadRow.processGroupId,
					branchHeadCommandLine: commandLineOf(branchHeadRow),
				}),
				mcpServerInstanceLabel: null,
			}),
			false,
		);
	}

	// 3. 上一轮已归因、这一轮游离在所有根树之外的进程：沿用记忆（孤儿 / 被收养的后台命令）。
	for (const row of input.processTableRows) {
		if (assignedProcessIds.has(row.processId)) {
			continue;
		}
		const rememberedAttribution = input.rememberedAttributionByProcessLifetimeIdentityKey.get(keyOf(row));
		if (!rememberedAttribution) {
			continue;
		}
		const attributionRootIsAlive = liveProcessLifetimeIdentityKeys.has(
			rememberedAttribution.attributionRootProcessLifetimeIdentityKey,
		);
		walkSubtree(
			row,
			"remembered_from_earlier_sample",
			attributionRootIsAlive,
			(descendantRow) =>
				descendantRow === row
					? rememberedAttribution
					: (input.rememberedAttributionByProcessLifetimeIdentityKey.get(keyOf(descendantRow)) ?? {
							...rememberedAttribution,
							processClassification: reclassifyDescendantOfRememberedProcess(
								rememberedAttribution.processClassification,
								commandLineOf(descendantRow),
							),
						}),
			false,
		);
	}

	// 4. Kanban 重启前就被收养的孤儿：ppid=1 的未知进程定向读 env。
	const orphanCandidateProcessIdsMissingKanbanEnvironment: number[] = [];
	for (const row of input.processTableRows) {
		if (assignedProcessIds.has(row.processId) || row.parentProcessId !== 1 || isZombieProcess(row)) {
			continue;
		}
		const kanbanEnvironment = input.kanbanEnvironmentByProcessLifetimeIdentityKey.get(keyOf(row));
		if (kanbanEnvironment === undefined) {
			orphanCandidateProcessIdsMissingKanbanEnvironment.push(row.processId);
			continue;
		}
		const recoveredAttribution = buildKanbanEnvironmentRecoveredAttribution(
			row,
			kanbanEnvironment,
			input,
			commandLineOf,
		);
		if (!recoveredAttribution) {
			continue;
		}
		walkSubtree(
			row,
			"kanban_environment_variables",
			false,
			(descendantRow) =>
				descendantRow === row
					? recoveredAttribution
					: {
							...recoveredAttribution,
							processClassification: reclassifyDescendantOfRememberedProcess(
								recoveredAttribution.processClassification,
								commandLineOf(descendantRow),
							),
						},
			false,
		);
	}

	return {
		observations,
		processIdsMissingCommandLine: Array.from(processIdsMissingCommandLine),
		kanbanRuntimeChildProcessIdsMissingWorkingDirectory,
		orphanCandidateProcessIdsMissingKanbanEnvironment,
	};
}

function buildSessionRootTreeAttribution(
	root: TaskResourceUsageAttributionRoot,
	rootRow: PosixProcessResourceTableRow,
	rootProcessLifetimeIdentityKey: string,
	row: PosixProcessResourceTableRow,
	branchHeadRow: PosixProcessResourceTableRow,
	commandLineOf: (row: PosixProcessResourceTableRow) => string | null,
): TaskAttributedProcessAttribution {
	const branchHeadCommandLine = row === rootRow ? null : commandLineOf(branchHeadRow);
	const processClassification = classifyTaskAttributedProcess({
		rootProcessRole: root.rootProcessRole,
		rootProcessGroupId: rootRow.processGroupId,
		processIsAttributionRoot: row === rootRow,
		processCommandLine: commandLineOf(row),
		branchHeadProcessGroupId: branchHeadRow.processGroupId,
		branchHeadCommandLine,
	});
	const isMcpClassification =
		processClassification === "mcp_server_process" || processClassification === "mcp_server_launcher_wrapper_process";
	return {
		workspaceId: root.workspaceId,
		attributedTaskCardId: root.attributedTaskCardId,
		sessionTaskId: root.sessionTaskId,
		sessionCategory: root.sessionCategory,
		sessionTransport: root.sessionTransport,
		agentId: root.agentId,
		runtimeSessionIncarnationId: root.runtimeSessionIncarnationId,
		attributionRootProcessId: root.rootProcessId,
		attributionRootProcessLifetimeIdentityKey: rootProcessLifetimeIdentityKey,
		branchHeadProcessId: branchHeadRow.processId,
		processClassification,
		mcpServerInstanceLabel:
			isMcpClassification && branchHeadCommandLine !== null
				? deriveMcpServerInstanceLabelFromBranchHeadCommandLine(branchHeadCommandLine)
				: null,
	};
}

// 孤儿子树里后来才出现的进程：继承所在分支的类别，hook CLI 仍单独识别。
function reclassifyDescendantOfRememberedProcess(
	headClassification: TaskAttributedProcessClassification,
	descendantCommandLine: string | null,
): TaskAttributedProcessClassification {
	if (descendantCommandLine !== null && isKanbanHookCliCommandLine(descendantCommandLine)) {
		return "kanban_hook_cli_process";
	}
	if (headClassification === "agent_harness_root_process") {
		return "agent_harness_helper_process";
	}
	if (headClassification === "user_shell_terminal_root_process") {
		return "user_shell_terminal_descendant_process";
	}
	if (headClassification === "mcp_server_launcher_wrapper_process") {
		return "mcp_server_process";
	}
	return headClassification;
}

// Kanban 给 PTY 会话注入的身份 env（真源：src/terminal/session-manager.ts 的 taskContextEnv、
// src/terminal/hook-runtime-context.ts 的 createHookRuntimeEnv），两类 id 不可混用：
//   - 会话自身 id（= summary.taskId；by-the-way 会话有独立 id）：KANBAN_TASK_CONVERSATION_SESSION_ID、
//     KANBAN_ATTEMPT_ID / CLINE_KANBAN_ATTEMPT_ID（同值，与 KANBAN_TASK_ID 同一次注入），
//     KANBAN_HOOK_TASK_ID（只在带 workspaceId 启动时由 adapter 另行注入）；
//   - 宿主卡片 id（workspaceTaskId ?? taskId）：KANBAN_TASK_ID / CLINE_KANBAN_TASK_ID。
// 会话 id 优先取与 KANBAN_TASK_ID 同一次注入的键，保证两者出自同一个会话；都缺时才退回 KANBAN_TASK_ID。
const KANBAN_ENVIRONMENT_SESSION_TASK_ID_VARIABLE_NAMES_IN_PREFERENCE_ORDER = [
	"KANBAN_TASK_CONVERSATION_SESSION_ID",
	"KANBAN_ATTEMPT_ID",
	"CLINE_KANBAN_ATTEMPT_ID",
	"KANBAN_HOOK_TASK_ID",
	"KANBAN_TASK_ID",
	"CLINE_KANBAN_TASK_ID",
] as const;

const KANBAN_ENVIRONMENT_HOST_TASK_CARD_ID_VARIABLE_NAMES_IN_PREFERENCE_ORDER = [
	"KANBAN_TASK_ID",
	"CLINE_KANBAN_TASK_ID",
] as const;

// env 里可能出现 `KEY=`（空串），不能拿空串当身份。
function readFirstNonEmptyKanbanEnvironmentValue(
	kanbanEnvironment: Readonly<Record<string, string>>,
	environmentVariableNamesInPreferenceOrder: readonly string[],
): string | null {
	for (const environmentVariableName of environmentVariableNamesInPreferenceOrder) {
		const environmentVariableValue = kanbanEnvironment[environmentVariableName];
		if (environmentVariableValue !== undefined && environmentVariableValue.length > 0) {
			return environmentVariableValue;
		}
	}
	return null;
}

function buildKanbanEnvironmentRecoveredAttribution(
	row: PosixProcessResourceTableRow,
	kanbanEnvironment: Readonly<Record<string, string>>,
	input: TaskAttributedProcessTreeSampleAttributionInput,
	commandLineOf: (row: PosixProcessResourceTableRow) => string | null,
): TaskAttributedProcessAttribution | null {
	const sessionTaskId = readFirstNonEmptyKanbanEnvironmentValue(
		kanbanEnvironment,
		KANBAN_ENVIRONMENT_SESSION_TASK_ID_VARIABLE_NAMES_IN_PREFERENCE_ORDER,
	);
	if (sessionTaskId === null) {
		return null;
	}
	const hostTaskCardId = readFirstNonEmptyKanbanEnvironmentValue(
		kanbanEnvironment,
		KANBAN_ENVIRONMENT_HOST_TASK_CARD_ID_VARIABLE_NAMES_IN_PREFERENCE_ORDER,
	);
	// 记到哪张卡上与正常路径共用同一个判定：首页终端 / home agent → null（workspace 级），
	// `__detail_terminal__:<cardId>` → 解析回 cardId。会话 id 与宿主卡片 id 不同 ⇔ by-the-way 会话
	// （runtime-api 启动时强校验 by-the-way 必须有不同于宿主卡片的 taskId），据此还原判定所需的最小元数据。
	// sessionCategory 仍记「env 找回」这一来源：env 里没有 role 等信息，不冒充正常路径的会话类别。
	const { attributedTaskCardId } = resolveSessionCategoryAndAttributedTaskCardId({
		taskId: sessionTaskId,
		taskConversationSessionMetadata:
			hostTaskCardId !== null && hostTaskCardId !== sessionTaskId
				? { workspaceTaskId: hostTaskCardId, taskConversationSessionRole: "by_the_way" }
				: undefined,
	});
	const projectPath = kanbanEnvironment.KANBAN_PROJECT_PATH ?? kanbanEnvironment.CLINE_KANBAN_PROJECT_PATH;
	const workspaceId =
		kanbanEnvironment.KANBAN_HOOK_WORKSPACE_ID ??
		(projectPath === undefined ? null : (input.workspaceIdByWorkspacePath.get(projectPath) ?? null));
	const commandLine = commandLineOf(row);
	return {
		workspaceId,
		attributedTaskCardId,
		sessionTaskId,
		sessionCategory: "recovered_by_kanban_environment_variables",
		sessionTransport: null,
		agentId: null,
		runtimeSessionIncarnationId: null,
		attributionRootProcessId: row.processId,
		attributionRootProcessLifetimeIdentityKey: keyOf(row),
		branchHeadProcessId: row.processId,
		processClassification:
			commandLine !== null && isKanbanHookCliCommandLine(commandLine)
				? "kanban_hook_cli_process"
				: "orphaned_process_recovered_by_kanban_environment_variables",
		mcpServerInstanceLabel: null,
	};
}
