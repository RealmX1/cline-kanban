import type { Command } from "commander";
import {
	ALL_PROJECTS_TASK_QUERY_GROUPS,
	type AllProjectsTaskQueryGroup,
	buildAllProjectsTaskGroupQueryResult,
} from "../core/all-projects-task-group-query";
import {
	type RuntimeAllProjectsTaskGroupQueryRequest,
	type RuntimeAllProjectsTaskGroupQuerySnapshot,
	type RuntimeBoardColumnId,
	runtimeAllProjectsTaskGroupQuerySnapshotSchema,
} from "../core/api-contract";
import { resolveCliTrpcTimeoutMs, safeErrorMessage, safeStringify } from "../core/cli-process-guards";
import {
	AllProjectsTaskGroupQueryRuntimeCompatibilityError,
	runAllProjectsTaskGroupMonitor,
} from "./all-projects-task-group-monitor";

interface TaskGroupQueryCommandOptions {
	allProjects?: boolean;
	projectPath?: string;
	column?: RuntimeBoardColumnId;
	group?: AllProjectsTaskQueryGroup;
	query?: string;
	recentDays?: 7 | 30;
	intervalMs?: number;
	exitWhenEmpty?: boolean;
}

interface TaskGroupQueryCommandDependencies {
	querySnapshot: (
		request: RuntimeAllProjectsTaskGroupQueryRequest,
		signal: AbortSignal,
	) => Promise<RuntimeAllProjectsTaskGroupQuerySnapshot>;
	listSingleProjectTasks: (input: {
		projectPath?: string;
		column?: RuntimeBoardColumnId;
	}) => Promise<Record<string, unknown>>;
	runTaskCommand: (handler: () => Promise<Record<string, unknown>>) => Promise<void>;
}

function parseQueryGroup(value: string): AllProjectsTaskQueryGroup {
	const group = ALL_PROJECTS_TASK_QUERY_GROUPS.find((candidate) => candidate === value);
	if (!group) throw new Error(`--group 必须为 ${ALL_PROJECTS_TASK_QUERY_GROUPS.join(" | ")}`);
	return group;
}

function parseQueryColumn(value: string): RuntimeBoardColumnId {
	const normalizedColumn = value === "done" ? "trash" : value;
	if (
		normalizedColumn === "backlog" ||
		normalizedColumn === "in_progress" ||
		normalizedColumn === "review" ||
		normalizedColumn === "validation" ||
		normalizedColumn === "trash"
	)
		return normalizedColumn;
	throw new Error("--column 必须为 backlog | in_progress | review | validation | done | trash");
}

function parseRecentDays(value: string): 7 | 30 {
	if (value === "7") return 7;
	if (value === "30") return 30;
	throw new Error("--recent-days 必须为 7 或 30");
}

function parseMonitorIntervalMs(value: string): number {
	const intervalMs = Number(value);
	if (!/^\d+$/u.test(value) || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 2_147_483_647)
		throw new Error("--interval-ms 必须为 1000 至 2147483647 的整数");
	return intervalMs;
}

function addTaskGroupQueryOptions(command: Command): Command {
	return command
		.option("--all-projects", "查询全部已注册项目，使用 All Projects 分组。")
		.option("--group <group>", `只查询 ${ALL_PROJECTS_TASK_QUERY_GROUPS.join(" | ")} 分组。`, parseQueryGroup)
		.option("--query <text>", "按任务 ID 或标题做不区分大小写的字面子串筛选。")
		.option("--recent-days <days>", "Recent 时间窗：7 | 30；默认 7 天。", parseRecentDays)
		.option(
			"--column <column>",
			"筛选看板列：backlog | in_progress | review | validation | done | trash。",
			parseQueryColumn,
		);
}

function validateQueryOptions(options: TaskGroupQueryCommandOptions, watch: boolean): void {
	if (options.allProjects && options.projectPath !== undefined)
		throw new Error("--all-projects 与 --project-path 互斥");
	if (
		!options.allProjects &&
		(watch || options.group !== undefined || options.query !== undefined || options.recentDays !== undefined)
	)
		throw new Error("全项目分组参数要求显式指定 --all-projects");
	if (options.query !== undefined && !options.query.trim()) throw new Error("--query 不能为空");
	if (options.exitWhenEmpty && !options.group)
		throw new Error("--exit-when-empty 要求指定 --group；空结果不代表任务全部 Done");
}

function isMissingRuntimeProcedure(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("data" in error)) return false;
	return (
		typeof error.data === "object" && error.data !== null && "code" in error.data && error.data.code === "NOT_FOUND"
	);
}

async function readCompatibleSnapshot(
	dependencies: TaskGroupQueryCommandDependencies,
	recentDays: 7 | 30,
	signal: AbortSignal,
) {
	let snapshot: RuntimeAllProjectsTaskGroupQuerySnapshot;
	try {
		snapshot = await dependencies.querySnapshot({ recentDays }, signal);
	} catch (error) {
		if (isMissingRuntimeProcedure(error))
			throw new AllProjectsTaskGroupQueryRuntimeCompatibilityError(
				"运行实例不支持全项目任务组查询接口；需要包含此功能的 runtime 版本",
			);
		throw error;
	}
	const parsedSnapshot = runtimeAllProjectsTaskGroupQuerySnapshotSchema.safeParse(snapshot);
	if (!parsedSnapshot.success || parsedSnapshot.data.recentDays !== recentDays)
		throw new AllProjectsTaskGroupQueryRuntimeCompatibilityError(
			"运行实例返回的任务组快照缺少完整性信息或时间窗不匹配",
		);
	return parsedSnapshot.data;
}

async function writeMonitorJsonLine(event: unknown, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	let onAbort = () => {};
	try {
		await new Promise<void>((resolve, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			process.stdout.write(`${safeStringify(event)}\n`, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function registerAllProjectsTaskGroupQueryCommands(
	task: Command,
	dependencies: TaskGroupQueryCommandDependencies,
): void {
	addTaskGroupQueryOptions(task.command("list").description("列出当前项目任务，或按 All Projects 分组查询全项目。"))
		.option("--project-path <path>", "项目主仓库路径；默认使用当前目录所属项目。")
		.action(async (options: TaskGroupQueryCommandOptions) =>
			dependencies.runTaskCommand(async () => {
				validateQueryOptions(options, false);
				if (!options.allProjects)
					return await dependencies.listSingleProjectTasks({
						projectPath: options.projectPath,
						column: options.column,
					});
				const snapshot = await readCompatibleSnapshot(
					dependencies,
					options.recentDays ?? 7,
					AbortSignal.timeout(resolveCliTrpcTimeoutMs()),
				);
				const result = buildAllProjectsTaskGroupQueryResult(snapshot, options);
				if (!result.ok) process.exitCode = 1;
				return result;
			}),
		);

	addTaskGroupQueryOptions(task.command("watch").description("持续观察全项目分组，以 NDJSON 输出；不启动或修改任务。"))
		.option("--interval-ms <milliseconds>", "正常查询间隔，最小 1000，默认 5000。", parseMonitorIntervalMs, 5_000)
		.option("--exit-when-empty", "所选分组筛选结果连续两次完整为空后退出；不代表任务完成。")
		.action(async (options: TaskGroupQueryCommandOptions) => {
			const controller = new AbortController();
			const onSigint = () => controller.abort("SIGINT");
			const onSigterm = () => controller.abort("SIGTERM");
			process.on("SIGINT", onSigint);
			process.on("SIGTERM", onSigterm);
			try {
				validateQueryOptions(options, true);
				process.exitCode = await runAllProjectsTaskGroupMonitor({
					querySnapshot: (signal) => readCompatibleSnapshot(dependencies, options.recentDays ?? 7, signal),
					filters: options,
					intervalMs: options.intervalMs ?? 5_000,
					exitWhenEmpty: options.exitWhenEmpty ?? false,
					requestTimeoutMs: resolveCliTrpcTimeoutMs(),
					signal: controller.signal,
					emit: writeMonitorJsonLine,
				});
			} catch (error) {
				process.exitCode = 1;
				if (!controller.signal.aborted) {
					try {
						await writeMonitorJsonLine(
							{
								eventType: "all_projects_task_group_query_unavailable",
								ok: false,
								error: safeErrorMessage(error),
							},
							controller.signal,
						);
					} catch (outputError) {
						if (!controller.signal.aborted) throw outputError;
					}
				}
			} finally {
				if (controller.signal.aborted) process.exitCode = controller.signal.reason === "SIGTERM" ? 143 : 130;
				process.removeListener("SIGINT", onSigint);
				process.removeListener("SIGTERM", onSigterm);
			}
		});
}
