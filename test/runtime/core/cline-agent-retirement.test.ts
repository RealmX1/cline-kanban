import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pickBestInstalledAgentIdFromDetected } from "../../../src/config/runtime-config";
import {
	assertRuntimeAgentIsNotRetired,
	CLINE_AGENT_RETIRED_EXECUTION_ERROR,
	getRuntimeLaunchSupportedAgentCatalog,
	isRuntimeAgentLaunchSupported,
} from "../../../src/core/agent-catalog";
import {
	runtimeAgentIdSchema,
	runtimeBoardCardSchema,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import { routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted } from "../../../src/core/queued-task-prompt-delivery-outcome-routing";

describe("Cline agent 退役兼容", () => {
	it("安装锁文件不再引入 Cline SDK、Codex provider 或捆绑 Codex", () => {
		const dependencyLock = readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8");
		expect(dependencyLock).not.toMatch(/@clinebot\/|ai-sdk-provider-codex-cli|@openai\/codex|sdk-wip/);
	});
	it("执行门禁明确拒绝 Cline，自动投递将拒绝落为终态而非重试", () => {
		expect(() => assertRuntimeAgentIsNotRetired("cline")).toThrow(CLINE_AGENT_RETIRED_EXECUTION_ERROR);
		expect(() => assertRuntimeAgentIsNotRetired("codex")).not.toThrow();
		expect(routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted(CLINE_AGENT_RETIRED_EXECUTION_ERROR)).toEqual(
			{
				outcome: "terminal_failure",
				failureNote: CLINE_AGENT_RETIRED_EXECUTION_ERROR,
			},
		);
	});
	it("保留旧身份的读取能力，但不再列出或启动 Cline", () => {
		expect(runtimeAgentIdSchema.parse("cline")).toBe("cline");
		expect(isRuntimeAgentLaunchSupported("cline")).toBe(false);
		expect(getRuntimeLaunchSupportedAgentCatalog().some((agent) => agent.id === "cline")).toBe(false);
	});

	it("保留旧 Cline 摘要及通道标识", () => {
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "legacy-cline-card",
			agentId: "cline",
			sessionTransport: "in_process_cline_sdk",
			state: "idle",
			workspacePath: "/legacy/cline/workspace",
			pid: null,
			startedAt: 1,
			updatedAt: 2,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
		});
		expect(summary.agentId).toBe("cline");
	});
	it("旧卡的平铺 provider、model 与 reasoning 字段仍按原兼容规则读取", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "legacy",
			title: "旧 Cline 卡",
			prompt: "旧内容",
			agentId: "cline",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 1,
			updatedAt: 1,
			clineProviderId: "historical-provider",
			clineModelId: "historical-model",
			clineReasoningEffort: "high",
		});
		expect(card.clineSettings).toEqual({
			providerId: "historical-provider",
			modelId: "historical-model",
			reasoningEffort: "high",
		});
	});

	it("自动选择覆盖 Kimi 和 omp，且忽略已退役 Cline", () => {
		expect(pickBestInstalledAgentIdFromDetected(["cline", "kimi"])).toBe("kimi");
		expect(pickBestInstalledAgentIdFromDetected(["cline", "omp"])).toBe("omp");
		expect(pickBestInstalledAgentIdFromDetected(["cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["codex", "kimi", "omp"])).toBe("codex");
	});
});
