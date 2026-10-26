import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexConfigurationSyncNotice, CodexConfigurationSyncSettings } from "@/components/codex-configuration-sync";
import { notifyCodexConfigurationSyncUpdated } from "@/runtime/codex-configuration-sync-query";
import type { CodexConfigurationSyncState } from "@/runtime/types";

const queries = vi.hoisted(() => ({
	fetch: vi.fn(),
	synchronize: vi.fn(),
	acknowledge: vi.fn(),
	resolve: vi.fn(),
	resolveTarget: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getCodexConfigurationSyncState: { query: queries.fetch },
			synchronizeCodexConfigurationChange: { mutate: queries.synchronize },
			acknowledgeCodexConfigurationChange: { mutate: queries.acknowledge },
			resolveCodexConfigurationConflict: { mutate: queries.resolve },
			resolveCodexConfigurationTargetConflict: { mutate: queries.resolveTarget },
		},
	}),
}));

let container: HTMLDivElement, root: Root, state: CodexConfigurationSyncState;
const flush = async () => {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
};
const button = (label: string) =>
	[...container.querySelectorAll("button")].find((element) => element.textContent === label) as HTMLButtonElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	state = {
		revision: 1,
		observationProblem: null,
		changes: [
			{
				changeId: "change-first",
				version: 1,
				sourceWriterId: "writer-first",
				sourceConversationSessionId: "来源会话",
				sourceWorkspaceId: "workspace",
				fieldLabel: "config.toml · hook stop:0:0",
				previousValueSummary: "已启用",
				valueSummary: "已禁用",
				observedAt: 1,
				mergeStatus: "shared_default_updated",
				acknowledgedAt: null,
				eligibleTargetCount: 2,
				targets: [],
			},
		],
	};
	queries.fetch.mockReset().mockImplementation(async () => state);
	queries.synchronize.mockReset().mockImplementation(async () => {
		state = { ...state, changes: state.changes.map((change) => ({ ...change, acknowledgedAt: 2 })) };
		return state;
	});
	queries.acknowledge.mockReset().mockImplementation(async () => {
		state = { ...state, changes: state.changes.map((change) => ({ ...change, acknowledgedAt: 2 })) };
		return state;
	});
	queries.resolve.mockReset().mockImplementation(async () => state);
	queries.resolveTarget.mockReset().mockImplementation(async () => state);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("Codex 配置同步提示和设置", () => {
	it("非模态提示展示范围，toggle 默认关闭，只提交本次变更", async () => {
		await act(async () =>
			root.render(<CodexConfigurationSyncNotice workspaceId="workspace" onOpenSettings={() => {}} />),
		);
		await flush();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(container.textContent).toContain("来源会话");
		expect(container.textContent).toContain("未来会话");
		expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
		await act(async () => button("同步设置").click());
		expect(queries.synchronize).toHaveBeenCalledWith(
			expect.objectContaining({
				changeId: "change-first",
				expectedVersion: 1,
				synchronizeExistingSessions: false,
				idempotencyKey: expect.any(String),
			}),
		);
		expect(container.querySelector('[aria-label="Codex 配置变更提示"]')).toBeNull();
	});
	it("显式开启后才同步，重复点击保护，新变更重新关闭 toggle", async () => {
		let finish: ((value: CodexConfigurationSyncState) => void) | undefined;
		queries.synchronize.mockImplementation(
			() =>
				new Promise<CodexConfigurationSyncState>((resolve) => {
					finish = resolve;
				}),
		);
		await act(async () =>
			root.render(<CodexConfigurationSyncNotice workspaceId="workspace" onOpenSettings={() => {}} />),
		);
		await flush();
		await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
		await act(async () => {
			button("同步设置").click();
			button("同步设置")?.click();
		});
		expect(queries.synchronize).toHaveBeenCalledTimes(1);
		expect(queries.synchronize).toHaveBeenCalledWith(expect.objectContaining({ synchronizeExistingSessions: true }));
		await act(async () => {
			finish?.(state);
		});
		state = { ...state, revision: 2, changes: [{ ...state.changes[0]!, changeId: "change-next", version: 2 }] };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await flush();
		expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	});
	it("稍后处理保留设置页条目，重连不会再弹同一提醒", async () => {
		await act(async () =>
			root.render(<CodexConfigurationSyncNotice workspaceId="workspace" onOpenSettings={() => {}} />),
		);
		await flush();
		await act(async () => button("稍后处理").click());
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await flush();
		expect(container.textContent).toBe("");
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		expect(container.textContent).toContain("已禁用");
		expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
	});
	it("逐项显示目标进度和冲突选择，携带目标值摘要防止覆盖后来的决定", async () => {
		state.changes[0]!.targets = ["applied", "pending_reload", "pending_next_start", "conflict", "not_applicable"].map(
			(status, index) => ({
				writerId: `writer-${index}`,
				conversationSessionId: `目标-${index}`,
				workspaceId: "workspace",
				status: status as "applied",
				reason: "原决定已保留",
				attemptCount: 1,
				acceptedAt: 1,
				diskSavedAt: null,
				ownerReloadedAt: null,
				recoveryCondition: null,
				...(status === "conflict" ? { conflictingTargetValueDigest: "expected-target-digest" } : {}),
			}),
		);
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		for (const label of ["已应用", "待重载", "待下次启动", "冲突", "不适用"])
			expect(container.textContent).toContain(label);
		await act(async () => button("保留 目标-3 的决定").click());
		expect(queries.resolveTarget).toHaveBeenCalledWith(
			expect.objectContaining({
				targetWriterId: "writer-3",
				expectedTargetValueDigest: "expected-target-digest",
				resolution: "keep_target_value",
			}),
		);
	});
	it.each([
		{
			resolution: "use_source_change",
			selectedMergeStatus: "target_conflict_source_change_selected",
			selectedTargetStatus: "pending_reload",
			buttonLabel: "向 目标会话 应用来源决定",
			expectedDecisionLabel: "已选择来源决定",
			expectedTargetLabel: "待重载",
		},
		{
			resolution: "keep_target_value",
			selectedMergeStatus: "target_conflict_target_value_kept",
			selectedTargetStatus: "not_applicable",
			buttonLabel: "保留 目标会话 的决定",
			expectedDecisionLabel: "已明确保留本会话自己的决定",
			expectedTargetLabel: "不适用",
		},
	] as const)("$resolution 后与重连后都分别展示明确选择与实际同步进度", async (scenario) => {
		state.changes[0]!.targets = [
			{
				writerId: "target-writer",
				conversationSessionId: "目标会话",
				workspaceId: "workspace",
				status: "conflict",
				reason: "双方决定均已保留",
				attemptCount: 0,
				acceptedAt: 1,
				diskSavedAt: null,
				ownerReloadedAt: null,
				recoveryCondition: null,
				conflictingTargetValueDigest: "target-value-digest",
			},
		];
		state.changes.push({
			...state.changes[0]!,
			changeId: "target-local-conflict",
			sourceWriterId: "target-writer",
			sourceConversationSessionId: "目标会话",
			mergeStatus: "conflict",
			targets: [],
		});
		queries.resolveTarget.mockImplementation(async () => {
			state = {
				...state,
				revision: state.revision + 1,
				changes: state.changes.map((change) =>
					change.changeId === "target-local-conflict"
						? { ...change, mergeStatus: scenario.selectedMergeStatus, acknowledgedAt: 2 }
						: {
								...change,
								targets: change.targets.map((target) => ({ ...target, status: scenario.selectedTargetStatus })),
							},
				),
			};
			return state;
		});
		await act(async () => root.render(<CodexConfigurationSyncSettings key="initial" workspaceId="workspace" />));
		await flush();
		await act(async () => button(scenario.buttonLabel).click());
		await flush();
		expect(queries.resolveTarget).toHaveBeenCalledWith(expect.objectContaining({ resolution: scenario.resolution }));
		const localArticle = () => container.querySelector('[aria-label="来自 目标会话 的配置变更"]');
		expect(localArticle()?.textContent).toContain(scenario.expectedDecisionLabel);
		expect(localArticle()?.textContent).not.toContain("已用于本会话及未来会话");
		expect(container.querySelector('[aria-label="会话同步进度"]')?.textContent).toContain(
			scenario.expectedTargetLabel,
		);
		if (scenario.resolution === "use_source_change") {
			expect(localArticle()?.textContent).toContain("保存与加载状态");
			expect(localArticle()?.textContent).not.toContain("保留本会话自己的决定");
		}
		const fetchCountBeforeReconnect = queries.fetch.mock.calls.length;
		await act(async () => root.render(<CodexConfigurationSyncSettings key="reconnected" workspaceId="workspace" />));
		await flush();
		expect(queries.fetch.mock.calls.length).toBeGreaterThan(fetchCountBeforeReconnect);
		expect(localArticle()?.textContent).toContain(scenario.expectedDecisionLabel);
		expect(container.querySelector('[aria-label="会话同步进度"]')?.textContent).toContain(
			scenario.expectedTargetLabel,
		);
	});
	it("历史 kept_shared_value 只陈述保留共享默认，不猜测目标会话是否保留原值", async () => {
		state.changes[0]!.mergeStatus = "kept_shared_value";
		state.changes[0]!.acknowledgedAt = 2;
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		expect(container.textContent).toContain("已保留共享默认");
		expect(container.textContent).not.toContain("本会话保留自己的决定");
	});
});
