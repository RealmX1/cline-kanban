import { describe, expect, it } from "vitest";

import {
	buildProcessLifetimeIdentityKey,
	extractKanbanEnvironmentVariablesFromPsEnvironmentCommandLine,
	parseLsofCurrentWorkingDirectoryFieldOutput,
	parsePosixProcessResourceTableText,
	parsePsCumulativeCpuTimeTextToSeconds,
	parsePsProcessIdAndCommandLineText,
} from "../../../src/diagnostics/posix-process-table-with-resource-columns-reader";

describe("parsePsCumulativeCpuTimeTextToSeconds", () => {
	it.each([
		["0:29.85", 29.85],
		// macOS 的 `time=` 是「分:秒」，分钟会越过 60——长寿进程实测出现过 1354:58.78。
		["1354:58.78", 1354 * 60 + 58.78],
		// Linux procps 形态：[DD-]HH:MM:SS。
		["01:02:03", 3723],
		["2-01:00:00", 2 * 86_400 + 3600],
	])("parses %s", (cpuTimeText, expectedSeconds) => {
		expect(parsePsCumulativeCpuTimeTextToSeconds(cpuTimeText)).toBeCloseTo(expectedSeconds, 5);
	});

	it("returns null for text that is not a cpu time", () => {
		expect(parsePsCumulativeCpuTimeTextToSeconds("-")).toBeNull();
	});
});

describe("parsePosixProcessResourceTableText", () => {
	it("parses every column including the five-token lstart start time", () => {
		const rows = parsePosixProcessResourceTableText(
			[
				"  104     1   104  14576 236:10.86 Fri Sep 25 14:34:31 2026     Ss  ",
				"68861  9104 68861 295000   0:18.06 Wed Sep 30 00:40:58 2026     Ss+ ",
			].join("\n"),
		);

		expect(rows).toHaveLength(2);
		expect(rows[1]).toEqual({
			processId: 68861,
			parentProcessId: 9104,
			processGroupId: 68861,
			residentSetSizeKibibytes: 295_000,
			cumulativeCpuTimeSeconds: 18.06,
			processStartTimeText: "Wed Sep 30 00:40:58 2026",
			processStartedAtEpochMs: new Date(2026, 8, 30, 0, 40, 58).getTime(),
			processStateCode: "Ss+",
		});
	});

	it("skips malformed lines instead of failing the whole sample", () => {
		expect(
			parsePosixProcessResourceTableText("garbage\n\n  12 1 12 100 0:00.01 Wed Sep 30 00:40:58 2026 S"),
		).toHaveLength(1);
	});
});

describe("buildProcessLifetimeIdentityKey", () => {
	it("distinguishes two processes that happened to reuse the same pid", () => {
		expect(buildProcessLifetimeIdentityKey(4120, "Wed Sep 30 00:40:58 2026")).not.toBe(
			buildProcessLifetimeIdentityKey(4120, "Wed Sep 30 01:12:07 2026"),
		);
	});
});

describe("parsePsProcessIdAndCommandLineText", () => {
	it("keeps the full command line including embedded spaces", () => {
		const commandLinesByProcessId = parsePsProcessIdAndCommandLineText(
			"  4120 /bin/zsh -c source /x.sh && eval 'npm run build'\n77872 npm exec claude-historian-mcp\n",
		);

		expect(commandLinesByProcessId.get(4120)).toBe("/bin/zsh -c source /x.sh && eval 'npm run build'");
		expect(commandLinesByProcessId.get(77872)).toBe("npm exec claude-historian-mcp");
	});
});

describe("extractKanbanEnvironmentVariablesFromPsEnvironmentCommandLine", () => {
	it("keeps only the Kanban attribution variables out of the appended environment", () => {
		expect(
			extractKanbanEnvironmentVariablesFromPsEnvironmentCommandLine(
				"claude --model default PATH=/usr/bin KANBAN_TASK_ID=bd6ff SECRET_TOKEN=abc KANBAN_PROJECT_PATH=/Users/u/repo CLINE_KANBAN_TASK_ID=bd6ff",
			),
		).toEqual({
			KANBAN_TASK_ID: "bd6ff",
			KANBAN_PROJECT_PATH: "/Users/u/repo",
			CLINE_KANBAN_TASK_ID: "bd6ff",
		});
	});
});

describe("parseLsofCurrentWorkingDirectoryFieldOutput", () => {
	it("pairs each pid record with its cwd name field", () => {
		expect(
			parseLsofCurrentWorkingDirectoryFieldOutput(
				"p53837\nfcwd\nn/Users/u/.cline/worktrees/bd6ff/cline-kanban\np60001\nfcwd\nn/tmp\n",
			),
		).toEqual(
			new Map([
				[53837, "/Users/u/.cline/worktrees/bd6ff/cline-kanban"],
				[60001, "/tmp"],
			]),
		);
	});
});
