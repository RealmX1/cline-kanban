import { describe, expect, it } from "vitest";

import { detectFreshSubstantiveAgentOutput } from "../../../src/terminal/agent-output-substance.js";
import {
	CLAUDE_STARTUP_BANNER_CHUNK,
	defaultRefreshChunkSequence,
	makePreRefreshSummary,
	PRE_REFRESH_SUBSTANTIVE_AT,
	REFRESH_AT,
	type RefreshFixId,
	resolveCardLastAgentResponseAt,
	runRefreshTimestampProbe,
	seedPreRefreshMemory,
} from "./last-agent-response-refresh-fix-prototypes.js";

/**
 * 隔离探针：验证 terminal refresh 后「Agent last responded」误推进问题，
 * 以及各修复原型在典型 Claude --continue / cache-past-due 序列下的行为。
 *
 * 不启动真实 PTY；仿真 session-manager handleTaskOutput + claudePromptDetector + 卡片展示层。
 */

const FIX_IDS: RefreshFixId[] = [
	"baseline",
	"preserve-substance-memory",
	"resume-ui-chrome-mask",
	"defer-prompt-ready-on-resume",
	"display-substantive-only",
	"freeze-until-user-continues",
	"combo-chrome-and-defer-prompt",
	"suppress-substantive-while-attention",
];

function runAllFixes() {
	return Object.fromEntries(
		FIX_IDS.map((fix) => [
			fix,
			runRefreshTimestampProbe({
				fix,
				chunks: defaultRefreshChunkSequence(),
				preRefreshMemory: fix === "preserve-substance-memory" ? seedPreRefreshMemory() : undefined,
			}),
		]),
	) as Record<RefreshFixId, ReturnType<typeof runRefreshTimestampProbe>>;
}

describe("last agent response · refresh 误推进 · 基线复现", () => {
	it("当前生产路径：refresh 后启动横幅即会把实质戳推到 refresh 时刻附近", () => {
		const baseline = runRefreshTimestampProbe({
			fix: "baseline",
			chunks: defaultRefreshChunkSequence(),
		});

		expect(baseline.substantiveAdvanced).toBe(true);
		expect(baseline.cardDisplayAt).toBeGreaterThan(PRE_REFRESH_SUBSTANTIVE_AT + 60_000);
		expect(baseline.turnOwnerAfterMenu).toBe("agent");
	});

	it("若 lastSubstantiveOutputAt 缺失，卡片回退 lastOutputAt 也会在 refresh 后跳变", () => {
		const pre = makePreRefreshSummary();
		pre.lastSubstantiveOutputAt = null;
		const postRefresh = {
			...pre,
			lastOutputAt: null,
			reviewReason: "attention" as const,
			turnOwner: "user" as const,
		};
		const afterAnyOutput = { ...postRefresh, lastOutputAt: REFRESH_AT + 2_000 };
		expect(resolveCardLastAgentResponseAt(afterAnyOutput)).toBe(REFRESH_AT + 2_000);
	});
});

describe("last agent response · refresh 修复原型探针矩阵", () => {
	const results = runAllFixes();

	it("矩阵：各修复在完整 refresh 序列后是否仍误推进实质戳", () => {
		// 启动横幅「How can I help you today?」在首个 chunk 就会触发 prompt-ready + 实质推进
		expect(results.baseline.substantiveAdvanced).toBe(true);
		expect(results["preserve-substance-memory"].substantiveAdvanced).toBe(true);
		expect(results["defer-prompt-ready-on-resume"].substantiveAdvanced).toBe(true);
		expect(results["display-substantive-only"].substantiveAdvanced).toBe(true);

		// 能挡住完整序列的修复
		expect(results["resume-ui-chrome-mask"].substantiveAdvanced).toBe(false);
		expect(results["freeze-until-user-continues"].substantiveAdvanced).toBe(false);
		expect(results["combo-chrome-and-defer-prompt"].substantiveAdvanced).toBe(false);
		expect(results["suppress-substantive-while-attention"].substantiveAdvanced).toBe(false);
	});

	it("矩阵：菜单 chunk 出现时 turnOwner 是否仍为 user（defer prompt-ready 有效区间）", () => {
		expect(results.baseline.turnOwnerAfterMenu).toBe("agent");
		expect(results["defer-prompt-ready-on-resume"].turnOwnerAfterMenu).toBe("agent");
		// 启动横幅已在菜单前翻回 agent；defer 仅拦住菜单帧自身的 prompt-ready
		expect(results["combo-chrome-and-defer-prompt"].turnOwnerAfterMenu).toBe("agent");
	});

	it("矩阵：真实 agent 响应后是否仍能推进实质戳（回归）", () => {
		for (const fix of FIX_IDS) {
			if (fix === "display-substantive-only") {
				continue;
			}
			expect(results[fix].substantiveAfterRealResponse, fix).toBe(true);
		}
	});

	it("矩阵：卡片展示时刻在 refresh 序列后是否仍锚定 refresh 前", () => {
		const anchoredFixes: RefreshFixId[] = [
			"resume-ui-chrome-mask",
			"freeze-until-user-continues",
			"combo-chrome-and-defer-prompt",
			"suppress-substantive-while-attention",
		];
		for (const fix of anchoredFixes) {
			expect(results[fix].cardDisplayAt, fix).toBe(PRE_REFRESH_SUBSTANTIVE_AT);
		}
	});
});

describe("last agent response · 边界场景", () => {
	it("仅启动横幅：prompt-ready 触发，但 user 回合内不推进实质戳", () => {
		const result = runRefreshTimestampProbe({
			fix: "baseline",
			chunks: [{ chunk: CLAUDE_STARTUP_BANNER_CHUNK, atMs: REFRESH_AT + 1_000 }],
		});
		// 实质戳推进发生在翻回 agent 回合之后的下一帧（此处仅单 chunk）
		expect(result.substantiveAdvanced).toBe(false);
	});

	it("combo chrome mask：启动横幅 + 菜单均被 mask，卡片时间不变", () => {
		const result = runRefreshTimestampProbe({
			fix: "combo-chrome-and-defer-prompt",
			chunks: defaultRefreshChunkSequence(),
		});
		expect(result.substantiveAdvanced).toBe(false);
		expect(result.cardDisplayAt).toBe(PRE_REFRESH_SUBSTANTIVE_AT);
	});

	it("preserve memory alone：对新出现的启动横幅文案无效", () => {
		const memoryWithMenuLine = seedPreRefreshMemory();
		detectFreshSubstantiveAgentOutput(memoryWithMenuLine, "Continue from summary");

		const withMemory = runRefreshTimestampProbe({
			fix: "preserve-substance-memory",
			chunks: defaultRefreshChunkSequence(),
			preRefreshMemory: memoryWithMenuLine,
		});
		expect(withMemory.substantiveAdvanced).toBe(true);
	});

	it("suppress while attention：用户仍在 attention 恢复态时，真实响应需等 reviewReason 清除后才推进", () => {
		const duringAttention = runRefreshTimestampProbe({
			fix: "suppress-substantive-while-attention",
			chunks: defaultRefreshChunkSequence(),
		});
		expect(duringAttention.substantiveAdvanced).toBe(false);
		expect(duringAttention.substantiveAfterRealResponse).toBe(true);
	});
});
