import { describe, expect, it } from "vitest";

import {
	classifyGitCommandProcessLevelFailure,
	decideGitCommandFailureStderrEmission,
} from "../../../src/diagnostics/git-command-failure-reporter";

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
