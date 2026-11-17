import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodexConfigurationSyncNotice } from "@/hooks/use-codex-configuration-sync-notice";
import type { CodexConfigurationChange } from "@/runtime/types";

const fixture = vi.hoisted(() => ({
	state: { storageIdentity: "notice-fixture", changes: [] as unknown[], sourceObservations: [] as unknown[] },
	pendingChangeId: null as string | null,
	sourceOperations: {},
	markNoticePresented: vi.fn(),
}));
vi.mock("@/hooks/use-codex-configuration-sync", () => ({ useCodexConfigurationSync: () => fixture }));
let root: Root, container: HTMLDivElement, notice: ReturnType<typeof useCodexConfigurationSyncNotice>;
const candidate = (id: string, value: string): CodexConfigurationChange => ({
	changeId: id,
	version: 1,
	sourceWriterId: "writer",
	sourceWorkspaceId: "workspace",
	sourceConversationSessionId: "session",
	fieldLabel: "推理强度",
	previousValueSummary: "max",
	valueSummary: value,
	observedAt: Date.now(),
	feedbackExpiresAtMs: Date.now() + 600_000,
	recordKind: "settings_proposal",
	approvalStatus: "pending",
	decidedAt: null,
	mergeStatus: "pending_approval",
	acknowledgedAt: null,
	eligibleTargetCount: 2,
	targets: [],
	settingDifferences: [],
	candidateFieldGroupKey: "reasoning",
	completeCandidateValueDigest: value,
});
function Harness({ available = true, mountPanel = true }: { available?: boolean; mountPanel?: boolean }) {
	notice = useCodexConfigurationSyncNotice({ workspaceId: "workspace", isPresentationAvailable: available });
	const rendered = mountPanel && notice.isVisible ? notice.displayedChanges[0] : undefined;
	useLayoutEffect(() => {
		if (rendered) notice.acknowledgeRenderedChanges([rendered]);
	}, [rendered?.changeId, rendered?.observedAt, rendered?.valueSummary]);
	return (
		<>
			<button ref={notice.summaryButtonRef} type="button" onClick={() => notice.toggleExpanded(false)}>
				配置
			</button>
			{mountPanel && (
				<section ref={notice.bindPanelRef} hidden={!notice.isVisible}>
					<p>{notice.displayedChanges[0]?.valueSummary}</p>
				</section>
			)}
		</>
	);
}
const render = async (available = true) => act(async () => root.render(<Harness available={available} />));
const advance = async (ms: number) => act(async () => vi.advanceTimersByTime(ms));
beforeEach(() => {
	fixture.markNoticePresented.mockReset();
	localStorage.clear();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-11T20:00:00Z"));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	fixture.state = {
		storageIdentity: "notice-fixture",
		changes: [candidate("first", "xhigh")],
		sourceObservations: [],
	};
	fixture.pendingChangeId = null;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
it("浮层没有实际挂载时不写展示回执，挂载后才确认展示", async () => {
	await act(async () => root.render(<Harness mountPanel={false} />));
	await advance(10_000);
	expect(fixture.markNoticePresented).not.toHaveBeenCalled();
	await act(async () => root.render(<Harness mountPanel />));
	expect(fixture.markNoticePresented).toHaveBeenCalledTimes(1);
});
it("十秒归并真实变化，元数据刷新不重置，展示三十秒且刷新不重复提醒", async () => {
	localStorage.setItem("codex-configuration-change-notice-collapsed", "true");
	await render();
	expect(notice.isVisible).toBe(false);
	await advance(6000);
	fixture.state.changes = [candidate("second", "ultra")];
	await render();
	await advance(6000);
	expect(notice.isVisible).toBe(false);
	fixture.state = {
		...fixture.state,
		changes: [{ ...(fixture.state.changes[0] as CodexConfigurationChange), version: 99 }],
	};
	await render();
	await advance(4000);
	expect(notice.isVisible).toBe(true);
	await advance(29_999);
	expect(notice.isVisible).toBe(true);
	await advance(1);
	expect(notice.isVisible).toBe(false);
	await act(async () => root.render(null));
	await render();
	await advance(60_000);
	expect(notice.isVisible).toBe(false);
});
it("阅读和提交保护当前比较，新变化重新提醒，手动展开不超时", async () => {
	await render();
	await advance(10_000);
	await act(async () => notice.panelRef.current?.dispatchEvent(new Event("pointerenter")));
	fixture.state.changes = [candidate("second", "ultra")];
	await render();
	await advance(40_000);
	expect(notice.displayedChanges[0]?.valueSummary).toBe("xhigh");
	expect(notice.hasNewSuggestions).toBe(true);
	fixture.pendingChangeId = "first";
	await render();
	await act(async () => notice.panelRef.current?.dispatchEvent(new Event("pointerleave")));
	await advance(40_000);
	expect(notice.isVisible).toBe(true);
	fixture.pendingChangeId = null;
	await render();
	await advance(30_000);
	await advance(0);
	expect(notice.displayedChanges[0]?.valueSummary).toBe("ultra");
	await act(async () => notice.closeAndRestoreSummaryFocus());
	await act(async () => notice.toggleExpanded(true));
	await advance(60_000);
	expect(notice.isVisible).toBe(true);
});
it("自动展开后面板才挂载时，仍启动三十秒空闲收起", async () => {
	function DelayedPanel() {
		notice = useCodexConfigurationSyncNotice({ workspaceId: "workspace" });
		return (
			<button ref={notice.summaryButtonRef} type="button">
				配置
			</button>
		);
	}
	await act(async () => root.render(<DelayedPanel />));
	await advance(10_000);
	expect(notice.isVisible).toBe(true);
	const panel = document.createElement("div");
	document.body.append(panel);
	await act(async () => notice.bindPanelRef(panel));
	await act(async () => notice.acknowledgeRenderedChanges(notice.displayedChanges));
	await advance(29_999);
	expect(notice.isVisible).toBe(true);
	await advance(1);
	expect(notice.isVisible).toBe(false);
	panel.remove();
});
it("手机导航和其他弹窗延后，过期不再自动弹出，来源更新仅供手动查看", async () => {
	await render(false);
	await advance(10_000);
	expect(notice.isVisible).toBe(false);
	const dialog = document.createElement("div");
	dialog.setAttribute("role", "dialog");
	document.body.append(dialog);
	await render();
	await advance(10_000);
	expect(notice.isVisible).toBe(false);
	await act(async () => dialog.remove());
	await advance(0);
	expect(notice.isVisible).toBe(true);
	await act(async () => notice.closeAndRestoreSummaryFocus());
	fixture.state.changes = [candidate("third", "future")];
	await render(false);
	await advance(600_001);
	await render();
	expect(notice.isVisible).toBe(false);
	fixture.state = {
		...fixture.state,
		changes: [],
		sourceObservations: [{ observationId: "source", acknowledgedAt: null }],
	};
	await render();
	await advance(20_000);
	expect(notice.isVisible).toBe(false);
});
