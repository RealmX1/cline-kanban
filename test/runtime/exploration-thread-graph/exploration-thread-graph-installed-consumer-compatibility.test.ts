import type { ExplorationThreadGraphProjectionView } from "agent-conversation-exploration-thread-graph/core";
import {
	buildExplorationThreadGraphProjectionView,
	createEmptyExplorationThreadGraphCollection,
	createEmptyExplorationTopicRegistry,
	runExplorationThreadGraphMaintenanceJob,
} from "agent-conversation-exploration-thread-graph/core";
import {
	ClaudeCodeForkedSessionWorkBranchExecutor,
	compareNativeProcessStartIdentities,
	confirmOwnedProcessCancellation,
	observeExecutionOwnedProcesses,
	readNativeProcessOwnershipSnapshot,
	readNativeSystemBootIdentity,
	signalMatchingOwnedProcesses,
} from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { describe, expect, expectTypeOf, it } from "vitest";
import { runtimeExplorationThreadGraphProjectionViewSchema } from "../../../src/core/api-contract";
import type { IsExplorationThreadGraphProjectionAcceptedByConsumer } from "../../../src/exploration-thread-graph/exploration-thread-graph-consumer-contract-compatibility";

// 本文件不 mock 核心包或 harness：真实 npm 安装缺导出或声明时，必须在这里失败。
describe("graph 实际安装产物的消费兼容", () => {
	it("宿主使用的维护和进程归属 API 均由安装产物提供", () => {
		for (const requiredExport of [
			runExplorationThreadGraphMaintenanceJob,
			ClaudeCodeForkedSessionWorkBranchExecutor,
			compareNativeProcessStartIdentities,
			observeExecutionOwnedProcesses,
			readNativeProcessOwnershipSnapshot,
			readNativeSystemBootIdentity,
			signalMatchingOwnedProcesses,
			confirmOwnedProcessCancellation,
		]) {
			expect(requiredExport).toBeTypeOf("function");
		}
		expect(compareNativeProcessStartIdentities("42 Thu Oct 29 00:00:00 2026", "42 9 Thu Oct 29 00:00:00 2026")).toBe(
			"same",
		);
	});

	it("核心新增宿主未消费的字段可解析，当前核心投影可直接交给宿主", () => {
		const view = buildExplorationThreadGraphProjectionView(
			createEmptyExplorationThreadGraphCollection("consumer-compatibility", 1),
			new Map(),
			createEmptyExplorationTopicRegistry(),
		);
		expect(
			runtimeExplorationThreadGraphProjectionViewSchema.parse({ ...view, futureOptionalField: "兼容扩展" }),
		).toEqual(view);
		expectTypeOf<
			IsExplorationThreadGraphProjectionAcceptedByConsumer<
				ExplorationThreadGraphProjectionView & { futureRequiredField: string; futureOptionalField?: string }
			>
		>().toEqualTypeOf<true>();
	});

	it("宿主必需字段缺失、字段类型变化、未知枚举及不兼容联合继续阻断升级", () => {
		type MissingRequiredField = Omit<ExplorationThreadGraphProjectionView, "turnRows">;
		type ChangedFieldType = Omit<ExplorationThreadGraphProjectionView, "laneCount"> & { laneCount: string };
		type ExpandedEnum = Omit<ExplorationThreadGraphProjectionView, "staleReason"> & {
			staleReason: ExplorationThreadGraphProjectionView["staleReason"] | "future_reason";
		};
		expectTypeOf<IsExplorationThreadGraphProjectionAcceptedByConsumer<MissingRequiredField>>().toEqualTypeOf<false>();
		expectTypeOf<IsExplorationThreadGraphProjectionAcceptedByConsumer<ChangedFieldType>>().toEqualTypeOf<false>();
		expectTypeOf<IsExplorationThreadGraphProjectionAcceptedByConsumer<ExpandedEnum>>().toEqualTypeOf<false>();
		expectTypeOf<
			IsExplorationThreadGraphProjectionAcceptedByConsumer<
				ExplorationThreadGraphProjectionView | MissingRequiredField
			>
		>().toEqualTypeOf<false>();
	});
});
