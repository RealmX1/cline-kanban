import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	classifyGitCommandProcessLevelFailure,
	decideGitCommandFailureStderrEmission,
	deriveGitCommandSpawnEnoentAttribution,
	probeGitCommandWorkingDirectoryPresence,
	reportGitCommandProcessLevelFailure,
	resolveGitExecutableOnSearchPath,
} from "../../../src/diagnostics/git-command-failure-reporter";
import {
	getDiagnosticEventJournalActiveFilePath,
	waitForPendingDiagnosticEventJournalWrites,
} from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { createTempDir } from "../../utilities/temp-dir";

const THROTTLE_INTERVAL_MS = 60_000;
const BASE_EPOCH_MS = 1_786_868_000_000;

describe("git command process-level failure classification", () => {
	it("treats a spawn errno as a process-level failure so the errno stops being invisible", () => {
		expect(classifyGitCommandProcessLevelFailure({ code: "EBADF" })).toEqual({
			kind: "spawn_error",
			errorCode: "EBADF",
			signal: null,
		});
	});

	it("treats Node's own ERR_* child-process codes as process-level failures", () => {
		expect(classifyGitCommandProcessLevelFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })?.kind).toBe(
			"spawn_error",
		);
	});

	it("treats a killed child as a process-level failure even without an errno", () => {
		expect(classifyGitCommandProcessLevelFailure({ code: null, killed: true, signal: "SIGTERM" })).toEqual({
			kind: "killed",
			errorCode: null,
			signal: "SIGTERM",
		});
	});

	it("does not classify git's own verdict as a process-level failure", () => {
		// 128 是 rev-parse「这不是仓库」等常规控制流，全量记录会把真正的信号淹掉。
		expect(classifyGitCommandProcessLevelFailure({ code: 128 })).toBeNull();
		expect(classifyGitCommandProcessLevelFailure({ code: "1" })).toBeNull();
	});
});

describe("git command failure stderr throttling", () => {
	it("emits the first occurrence, suppresses the storm, then reports how many were suppressed", () => {
		const throttleKey = `spawn_error:EBADF:${BASE_EPOCH_MS}`;

		const firstDecision = decideGitCommandFailureStderrEmission(throttleKey, BASE_EPOCH_MS);
		expect(firstDecision).toEqual({ shouldEmit: true, suppressedSinceLastEmitCount: 0 });

		// fd 耗尽时每一条 git 都失败——逐条打印会重演「探针自己刷爆日志」的旧错。
		for (let repeatIndex = 0; repeatIndex < 500; repeatIndex++) {
			expect(decideGitCommandFailureStderrEmission(throttleKey, BASE_EPOCH_MS + 1_000).shouldEmit).toBe(false);
		}

		const afterIntervalDecision = decideGitCommandFailureStderrEmission(
			throttleKey,
			BASE_EPOCH_MS + THROTTLE_INTERVAL_MS,
		);
		expect(afterIntervalDecision).toEqual({ shouldEmit: true, suppressedSinceLastEmitCount: 500 });
	});

	it("throttles each failure code independently so a new failure mode is never masked", () => {
		const busyKey = `spawn_error:EBADF:${BASE_EPOCH_MS + 1}`;
		const distinctKey = `spawn_error:ENOENT:${BASE_EPOCH_MS + 1}`;

		expect(decideGitCommandFailureStderrEmission(busyKey, BASE_EPOCH_MS).shouldEmit).toBe(true);
		expect(decideGitCommandFailureStderrEmission(busyKey, BASE_EPOCH_MS + 1_000).shouldEmit).toBe(false);
		expect(decideGitCommandFailureStderrEmission(distinctKey, BASE_EPOCH_MS + 1_000).shouldEmit).toBe(true);
	});
});

describe("ENOENT working directory disambiguation", () => {
	let tempDir: { path: string; cleanup: () => void };

	beforeEach(() => {
		tempDir = createTempDir("kanban-git-command-failure-cwd-");
	});

	afterEach(() => {
		tempDir.cleanup();
	});

	it("reports an existing working directory as present", () => {
		expect(probeGitCommandWorkingDirectoryPresence(tempDir.path)).toBe("present");
	});

	it("reports a working directory that does not exist as missing", () => {
		// 实测到的 ENOENT 全发生在 task worktree 目录创建的同一秒，成因是目录还没落地就查 HEAD，
		// 而 Node 把它报成与「找不到 git」一模一样的 `spawn git ENOENT`。
		expect(probeGitCommandWorkingDirectoryPresence(join(tempDir.path, "never-created-worktree"))).toBe("missing");
	});

	it("reports a path that exists but is not a directory as missing", () => {
		const regularFilePath = join(tempDir.path, "not-a-directory");
		writeFileSync(regularFilePath, "", "utf8");

		expect(probeGitCommandWorkingDirectoryPresence(regularFilePath)).toBe("missing");
	});

	it("reports a path nested under a regular file as missing rather than undetermined", () => {
		// ENOTDIR 与 ENOENT 一样是「这个路径不可能是工作目录」的确定结论。
		const regularFilePath = join(tempDir.path, "not-a-directory");
		writeFileSync(regularFilePath, "", "utf8");

		expect(probeGitCommandWorkingDirectoryPresence(join(regularFilePath, "child"))).toBe("missing");
	});

	it("never claims a directory is missing when the probe itself could not reach a verdict", () => {
		// 「不谎报 missing」正是三态设计的核心安全性质：把兜底出口改回 "missing" 会让 EACCES 之类的
		// 场景把排障引向「目录被删了」而非「查不动」。含 NUL 字节的路径连系统调用都发不出去，是这条
		// 出口最确定的触发方式；顺带证明非法输入不会抛出未捕获异常。
		expect(probeGitCommandWorkingDirectoryPresence(`${tempDir.path}\0suffix`)).toBe("undetermined");
	});

	it("attributes ENOENT by the non-racy side: a resolvable git executable means the working directory is at fault", () => {
		// 定性绝不能靠事后看目录在不在——那个目录由另一个进程创建，可能在 spawn 失败与本次探测之间
		// 才落地。可执行文件能否解析才是稳定量。
		expect(deriveGitCommandSpawnEnoentAttribution("resolved")).toBe("working_directory_missing_at_spawn_time");
		expect(deriveGitCommandSpawnEnoentAttribution("unresolved")).toBe("git_executable_not_on_search_path");
		expect(deriveGitCommandSpawnEnoentAttribution("undetermined")).toBe("undetermined");
	});

	it("resolves git on the search path without spawning a subprocess", () => {
		// fd 快耗尽时恰恰开不出子进程，所以这条判决必须是纯 stat 的（stat 不占用 fd）。
		expect(resolveGitExecutableOnSearchPath()).toBe("resolved");
	});
});

describe("git command failure reporting", () => {
	let tempDir: { path: string; cleanup: () => void };

	beforeEach(() => {
		tempDir = createTempDir("kanban-git-command-failure-report-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.cleanup();
	});

	async function readLastGitCommandFailureJournalRecord(): Promise<Record<string, unknown>> {
		await waitForPendingDiagnosticEventJournalWrites();
		const journalLines = readFileSync(getDiagnosticEventJournalActiveFilePath("git-command-failure"), "utf8")
			.trimEnd()
			.split("\n");
		return JSON.parse(journalLines[journalLines.length - 1]) as Record<string, unknown>;
	}

	it("attributes a spawn ENOENT instead of leaving it looking like a missing git binary", async () => {
		const stderrWrites: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			stderrWrites.push(String(chunk));
			return true;
		});

		reportGitCommandProcessLevelFailure(
			{ kind: "spawn_error", errorCode: "ENOENT", signal: null },
			{
				cwd: join(tempDir.path, "worktree-not-created-yet"),
				args: ["rev-parse", "HEAD"],
				message: "spawn git ENOENT",
			},
		);

		const record = await readLastGitCommandFailureJournalRecord();
		expect(record.errorCode).toBe("ENOENT");
		expect(record.gitExecutableSearchPathResolution).toBe("resolved");
		expect(record.spawnEnoentAttribution).toBe("working_directory_missing_at_spawn_time");
		expect(record.workingDirectoryPresenceObservedAfterFailure).toBe("missing");
		expect(stderrWrites.join("")).toContain("spawnEnoentAttribution=working_directory_missing_at_spawn_time");
	});

	it("does not pay for ENOENT disambiguation on failure codes that are not ambiguous", async () => {
		// fd 耗尽时每一条 git 都以 EBADF 失败；若门控被误删，每条失败都要多跑一遍 PATH 扫描。
		const resolveSpy = vi.spyOn(process.stderr, "write").mockImplementation((): boolean => true);

		reportGitCommandProcessLevelFailure(
			{ kind: "spawn_error", errorCode: "EBADF", signal: null },
			{ cwd: tempDir.path, args: ["rev-parse", "HEAD"], message: "spawn git EBADF" },
		);

		const record = await readLastGitCommandFailureJournalRecord();
		expect(record.errorCode).toBe("EBADF");
		expect(record.spawnEnoentAttribution).toBeNull();
		expect(record.gitExecutableSearchPathResolution).toBeNull();
		expect(record.workingDirectoryPresenceObservedAfterFailure).toBeNull();
		expect(String(resolveSpy.mock.calls[0]?.[0] ?? "")).not.toContain("spawnEnoentAttribution");
	});
});
