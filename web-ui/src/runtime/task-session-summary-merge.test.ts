import { isNeverStartedPlaceholderTaskSessionSummary } from "@runtime-session-activity";
import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { mergeTaskSessionSummariesForTest } from "@/runtime/use-runtime-state-stream";

// 「重启后 TUI 全白且重启按钮不可用」的前端半边回归护栏。
//
// 链路：硬中断 → 盘上没有该 task 的 session 条目 → 前端聚焦卡片触发 attach → 服务端 `ensureEntry`
// 就地造出一条全 null 的默认 summary → 它带着**最新的 updatedAt** 广播出来。合并规则原本只看
// updatedAt 单调，于是这条空壳把手上记着 agentId 的记录整条盖掉；随后一次 saveState 又把它写进
// sessions.json，损坏由此变成永久性的。

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	} as RuntimeTaskSessionSummary;
}

function makeStartedSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		...makeSummary(),
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 4242,
		startedAt: 1_000,
		updatedAt: 1_000,
		...overrides,
	} as RuntimeTaskSessionSummary;
}

describe("mergeTaskSessionSummaries", () => {
	it("空壳占位不因 updatedAt 更新就覆盖已有的真实记录", () => {
		const merged = mergeTaskSessionSummariesForTest({ "task-1": makeStartedSummary() }, [
			makeSummary({ updatedAt: 9_000 }),
		]);
		expect(merged["task-1"]?.agentId).toBe("claude");
		expect(merged["task-1"]?.startedAt).toBe(1_000);
	});

	it("手上本来就是空壳时放行 incoming（留谁都一样，不该把陈旧 updatedAt 钉住）", () => {
		const merged = mergeTaskSessionSummariesForTest({ "task-1": makeSummary({ updatedAt: 1_000 }) }, [
			makeSummary({ updatedAt: 9_000 }),
		]);
		expect(merged["task-1"]?.updatedAt).toBe(9_000);
	});

	it("真实记录之间仍按 updatedAt 单调合并", () => {
		const merged = mergeTaskSessionSummariesForTest({ "task-1": makeStartedSummary() }, [
			makeStartedSummary({ agentId: "codex", updatedAt: 9_000 }),
		]);
		expect(merged["task-1"]?.agentId).toBe("codex");
	});

	it("更旧的真实记录不覆盖更新的真实记录", () => {
		const merged = mergeTaskSessionSummariesForTest({ "task-1": makeStartedSummary({ updatedAt: 9_000 }) }, [
			makeStartedSummary({ agentId: "codex", updatedAt: 1_000 }),
		]);
		expect(merged["task-1"]?.agentId).toBe("claude");
	});

	it("首次见到的 task 即便是空壳也照收（没有更富的记录可保护）", () => {
		const merged = mergeTaskSessionSummariesForTest({}, [makeSummary()]);
		expect(merged["task-1"]).toBeDefined();
	});

	it("守卫依赖的谓词与服务端 createDefaultSummary 同形", () => {
		expect(isNeverStartedPlaceholderTaskSessionSummary(makeSummary())).toBe(true);
		expect(isNeverStartedPlaceholderTaskSessionSummary(makeStartedSummary())).toBe(false);
	});
});
