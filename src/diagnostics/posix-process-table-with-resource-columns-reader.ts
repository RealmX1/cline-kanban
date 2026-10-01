// 资源占用采样的「读 OS」层：进程表资源列、按需补读 argv / env / cwd。本模块只负责读与解析，
// 归因与分类在 task-attributed-process-classification-rules.ts，时序与落盘在采样器里。
//
// 刻意的读取分层（每一层都是实测踩出来的）：
//   - 每个 tick 只读**不含 argv** 的资源列：一个 Claude 根进程的 argv 就有 ~144 KB（整段
//     `--append-system-prompt`），全表带 argv 会越过 execFile 默认 1 MiB 的 maxBuffer，采样器随即静默失效；
//   - argv 只对**新出现**的进程读一次，调用方读到即截断脱敏并缓存；
//   - env 只对归因不到的孤儿定向读，只保留 KANBAN_* 键；
//   - cwd 只对 Kanban 的直接子进程读（Cline SDK run_commands、验证脚本等只能靠 cwd 归因）。
//
// 进程身份键用 `lstart`（绝对启动时刻）而不是 etime 反推：后者每个 tick 有 1 秒量级抖动，键不稳定；
// 而只用 pid 会在 pid 被复用时把两个进程的样本拼成一条生命周期。

import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROCESS_RESOURCE_TABLE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROCESS_COMMAND_LINE_READ_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PER_INVOCATION_PROCESS_ID_BATCH_SIZE = 200;
const OS_PROCESS_INSPECTION_COMMAND_TIMEOUT_MS = 5_000;

// lstart 的月份名受 locale 影响，统一以 C locale 读取。
const PS_ENVIRONMENT_WITH_C_LOCALE = { ...process.env, LC_ALL: "C", LANG: "C" };

export interface PosixProcessResourceTableRow {
	processId: number;
	parentProcessId: number;
	processGroupId: number;
	residentSetSizeKibibytes: number;
	cumulativeCpuTimeSeconds: number;
	// ps `lstart` 原文（如 "Wed Sep 30 00:40:58 2026"），秒级绝对时刻；与 pid 组合成进程身份键。
	processStartTimeText: string;
	processStartedAtEpochMs: number | null;
	processStateCode: string;
}

export function buildProcessLifetimeIdentityKey(processId: number, processStartTimeText: string): string {
	return `${processId}@${processStartTimeText}`;
}

// macOS：「分:秒.百分秒」，分钟可越过 60；Linux procps：「[DD-]HH:MM:SS」。
export function parsePsCumulativeCpuTimeTextToSeconds(cpuTimeText: string): number | null {
	const dayAndClockMatch = /^(?:(\d+)-)?([\d:.]+)$/.exec(cpuTimeText.trim());
	if (!dayAndClockMatch) {
		return null;
	}
	const dayCount = dayAndClockMatch[1] === undefined ? 0 : Number.parseInt(dayAndClockMatch[1], 10);
	const clockParts = (dayAndClockMatch[2] ?? "").split(":").map((part) => Number.parseFloat(part));
	if (clockParts.length < 2 || clockParts.length > 3 || clockParts.some((part) => !Number.isFinite(part))) {
		return null;
	}
	const [hours, minutes, seconds] = clockParts.length === 3 ? clockParts : [0, ...clockParts];
	return dayCount * 86_400 + (hours ?? 0) * 3_600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}

const LSTART_MONTH_INDEX_BY_ABBREVIATION: Readonly<Record<string, number>> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};

function parsePsLstartTokensToEpochMs(lstartTokens: readonly string[]): number | null {
	const [, monthAbbreviation, dayText, clockText, yearText] = lstartTokens;
	const monthIndex =
		monthAbbreviation === undefined ? undefined : LSTART_MONTH_INDEX_BY_ABBREVIATION[monthAbbreviation];
	const clockParts = (clockText ?? "").split(":").map((part) => Number.parseInt(part, 10));
	const day = Number.parseInt(dayText ?? "", 10);
	const year = Number.parseInt(yearText ?? "", 10);
	if (monthIndex === undefined || clockParts.length !== 3 || !Number.isInteger(day) || !Number.isInteger(year)) {
		return null;
	}
	const [hours, minutes, seconds] = clockParts;
	const epochMs = new Date(year, monthIndex, day, hours, minutes, seconds).getTime();
	return Number.isFinite(epochMs) ? epochMs : null;
}

// 列序：pid ppid pgid rss time lstart(5 个 token) stat。畸形行直接跳过，不让一行坏数据拖垮整次采样。
export function parsePosixProcessResourceTableText(processTableText: string): PosixProcessResourceTableRow[] {
	const rows: PosixProcessResourceTableRow[] = [];
	for (const line of processTableText.split("\n")) {
		const tokens = line.trim().split(/\s+/);
		if (tokens.length < 11) {
			continue;
		}
		const [pidText, parentPidText, processGroupIdText, rssText, cpuTimeText] = tokens;
		const lstartTokens = tokens.slice(5, 10);
		const processId = Number.parseInt(pidText ?? "", 10);
		const parentProcessId = Number.parseInt(parentPidText ?? "", 10);
		const processGroupId = Number.parseInt(processGroupIdText ?? "", 10);
		const residentSetSizeKibibytes = Number.parseInt(rssText ?? "", 10);
		const cumulativeCpuTimeSeconds = parsePsCumulativeCpuTimeTextToSeconds(cpuTimeText ?? "");
		if (
			!Number.isInteger(processId) ||
			!Number.isInteger(parentProcessId) ||
			!Number.isInteger(processGroupId) ||
			!Number.isInteger(residentSetSizeKibibytes) ||
			cumulativeCpuTimeSeconds === null
		) {
			continue;
		}
		rows.push({
			processId,
			parentProcessId,
			processGroupId,
			residentSetSizeKibibytes,
			cumulativeCpuTimeSeconds,
			processStartTimeText: lstartTokens.join(" "),
			processStartedAtEpochMs: parsePsLstartTokensToEpochMs(lstartTokens),
			processStateCode: tokens.slice(10).join(" "),
		});
	}
	return rows;
}

export async function readPosixProcessResourceTable(): Promise<PosixProcessResourceTableRow[]> {
	const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,pgid=,rss=,time=,lstart=,stat="], {
		env: PS_ENVIRONMENT_WITH_C_LOCALE,
		maxBuffer: PROCESS_RESOURCE_TABLE_MAX_OUTPUT_BYTES,
		timeout: OS_PROCESS_INSPECTION_COMMAND_TIMEOUT_MS,
	});
	return parsePosixProcessResourceTableText(stdout);
}

export function parsePsProcessIdAndCommandLineText(processCommandLineText: string): Map<number, string> {
	const commandLinesByProcessId = new Map<number, string>();
	for (const line of processCommandLineText.split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		commandLinesByProcessId.set(Number.parseInt(match[1] ?? "", 10), (match[2] ?? "").trimEnd());
	}
	return commandLinesByProcessId;
}

function splitIntoBatches<T>(items: readonly T[], batchSize: number): T[][] {
	const batches: T[][] = [];
	for (let index = 0; index < items.length; index += batchSize) {
		batches.push(items.slice(index, index + batchSize));
	}
	return batches;
}

// ps / lsof 在列表里有 pid 已经退出时以退出码 1 结束，但 stdout 里其余 pid 的结果仍然完整有效。
async function readStdoutToleratingPartialFailure(
	command: string,
	args: readonly string[],
	maxBuffer: number,
): Promise<string> {
	try {
		const { stdout } = await execFileAsync(command, args, {
			env: PS_ENVIRONMENT_WITH_C_LOCALE,
			maxBuffer,
			timeout: OS_PROCESS_INSPECTION_COMMAND_TIMEOUT_MS,
		});
		return stdout;
	} catch (error) {
		const partialStdout = (error as { stdout?: unknown }).stdout;
		return typeof partialStdout === "string" ? partialStdout : "";
	}
}

export async function readProcessCommandLinesForProcessIds(
	processIds: readonly number[],
): Promise<Map<number, string>> {
	const commandLinesByProcessId = new Map<number, string>();
	for (const batch of splitIntoBatches(processIds, PER_INVOCATION_PROCESS_ID_BATCH_SIZE)) {
		const stdout = await readStdoutToleratingPartialFailure(
			"ps",
			["-ww", "-o", "pid=,command=", "-p", batch.join(",")],
			PROCESS_COMMAND_LINE_READ_MAX_OUTPUT_BYTES,
		);
		for (const [processId, commandLine] of parsePsProcessIdAndCommandLineText(stdout)) {
			commandLinesByProcessId.set(processId, commandLine);
		}
	}
	return commandLinesByProcessId;
}

const KANBAN_ATTRIBUTION_ENVIRONMENT_VARIABLE_PATTERN = /(?:^|\s)((?:CLINE_)?KANBAN_[A-Z0-9_]+)=(\S*)/g;

// macOS `ps -E` 把环境变量接在 argv 后面输出；这里只保留归因用的 KANBAN_* 键，其余一概丢弃。
export function extractKanbanEnvironmentVariablesFromPsEnvironmentCommandLine(
	commandLineWithEnvironment: string,
): Record<string, string> {
	const kanbanEnvironmentVariables: Record<string, string> = {};
	for (const match of commandLineWithEnvironment.matchAll(KANBAN_ATTRIBUTION_ENVIRONMENT_VARIABLE_PATTERN)) {
		const [, name, value] = match;
		if (name !== undefined && value !== undefined) {
			kanbanEnvironmentVariables[name] = value;
		}
	}
	return kanbanEnvironmentVariables;
}

export async function readKanbanEnvironmentVariablesForProcessIds(
	processIds: readonly number[],
): Promise<Map<number, Record<string, string>>> {
	const environmentByProcessId = new Map<number, Record<string, string>>();
	if (process.platform === "linux") {
		for (const processId of processIds) {
			try {
				const environText = await readFile(`/proc/${processId}/environ`, "utf8");
				environmentByProcessId.set(
					processId,
					extractKanbanEnvironmentVariablesFromPsEnvironmentCommandLine(environText.replaceAll("\0", " ")),
				);
			} catch {
				// 进程已退出或无权读取：当作没有锚点。
			}
		}
		return environmentByProcessId;
	}
	for (const batch of splitIntoBatches(processIds, PER_INVOCATION_PROCESS_ID_BATCH_SIZE)) {
		const stdout = await readStdoutToleratingPartialFailure(
			"ps",
			["-E", "-ww", "-o", "pid=,command=", "-p", batch.join(",")],
			PROCESS_COMMAND_LINE_READ_MAX_OUTPUT_BYTES,
		);
		for (const [processId, commandLineWithEnvironment] of parsePsProcessIdAndCommandLineText(stdout)) {
			environmentByProcessId.set(
				processId,
				extractKanbanEnvironmentVariablesFromPsEnvironmentCommandLine(commandLineWithEnvironment),
			);
		}
	}
	return environmentByProcessId;
}

// `lsof -Fn` 字段格式：`p<pid>` 开启一条进程记录，随后的 `n<path>` 是该 fd（这里只取 cwd）的路径。
export function parseLsofCurrentWorkingDirectoryFieldOutput(lsofFieldOutput: string): Map<number, string> {
	const currentWorkingDirectoriesByProcessId = new Map<number, string>();
	let currentProcessId: number | null = null;
	for (const line of lsofFieldOutput.split("\n")) {
		if (line.startsWith("p")) {
			const processId = Number.parseInt(line.slice(1), 10);
			currentProcessId = Number.isInteger(processId) ? processId : null;
		} else if (line.startsWith("n") && currentProcessId !== null) {
			currentWorkingDirectoriesByProcessId.set(currentProcessId, line.slice(1));
		}
	}
	return currentWorkingDirectoriesByProcessId;
}

export async function readCurrentWorkingDirectoriesForProcessIds(
	processIds: readonly number[],
): Promise<Map<number, string>> {
	if (processIds.length === 0) {
		return new Map();
	}
	if (process.platform === "linux") {
		const currentWorkingDirectoriesByProcessId = new Map<number, string>();
		for (const processId of processIds) {
			try {
				currentWorkingDirectoriesByProcessId.set(processId, await readlink(`/proc/${processId}/cwd`));
			} catch {
				// 进程已退出或无权读取。
			}
		}
		return currentWorkingDirectoriesByProcessId;
	}
	const currentWorkingDirectoriesByProcessId = new Map<number, string>();
	for (const batch of splitIntoBatches(processIds, PER_INVOCATION_PROCESS_ID_BATCH_SIZE)) {
		const stdout = await readStdoutToleratingPartialFailure(
			"lsof",
			["-a", "-n", "-P", "-Fn", "-d", "cwd", "-p", batch.join(",")],
			PROCESS_COMMAND_LINE_READ_MAX_OUTPUT_BYTES,
		);
		for (const [processId, currentWorkingDirectory] of parseLsofCurrentWorkingDirectoryFieldOutput(stdout)) {
			currentWorkingDirectoriesByProcessId.set(processId, currentWorkingDirectory);
		}
	}
	return currentWorkingDirectoriesByProcessId;
}
