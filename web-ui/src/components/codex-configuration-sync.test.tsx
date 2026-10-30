import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexConfigurationProfileSelect } from "@/components/codex-configuration-profile-select";
import {
	CodexConfigurationSyncNotice,
	CodexConfigurationSyncSettings,
	CodexConfigurationSyncSummaryButton,
} from "@/components/codex-configuration-sync";
import { useCodexConfigurationSyncNotice } from "@/hooks/use-codex-configuration-sync-notice";
import { notifyCodexConfigurationSyncUpdated } from "@/runtime/codex-configuration-sync-query";
import type { CodexConfigurationSyncState } from "@/runtime/types";

const queries = vi.hoisted(() => ({
	fetch: vi.fn(),
	synchronize: vi.fn(),
	acknowledge: vi.fn(),
	resolve: vi.fn(),
	resolveTarget: vi.fn(),
	batch: vi.fn(),
	profile: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getCodexConfigurationSyncState: { query: queries.fetch },
			mutateCodexConfigurationProfile: { mutate: queries.profile },
			batchCodexConfigurationAction: { mutate: queries.batch },
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
function NoticeHarness(props: Parameters<typeof useCodexConfigurationSyncNotice>[0] & { onOpenSettings?: () => void }) {
	const notice = useCodexConfigurationSyncNotice(props);
	return (
		<>
			<CodexConfigurationSyncSummaryButton notice={notice} />
			<CodexConfigurationSyncNotice notice={notice} onOpenSettings={props.onOpenSettings ?? (() => {})} />
		</>
	);
}
async function renderConfigurationNotice(props: Partial<ComponentProps<typeof NoticeHarness>> = {}) {
	await act(async () => root.render(<NoticeHarness workspaceId="workspace" {...props} />));
	return container.querySelector<HTMLElement>('[aria-label="Codex 配置变更提示"]')!;
}
const button = (label: string) =>
	label === "展开"
		? (container.querySelector(
				'[data-verification-anchor="codex-configuration-sync-summary"][aria-expanded="false"]',
			) as HTMLButtonElement)
		: ([...container.querySelectorAll("button")].find(
				(element) => element.textContent === label,
			) as HTMLButtonElement);
beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	queries.batch.mockReset();
	queries.profile.mockReset().mockImplementation(async () => state);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	state = {
		revision: 1,
		observationProblem: null,
		sourceObservations: [],
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
				recordKind: "settings_proposal",
				approvalStatus: "approved",
				decidedAt: 1,
				settingDifferences: [{ label: "启用状态", previous: "开启", current: "关闭" }],
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
	document.getSelection()?.removeAllRanges();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Codex 配置同步提示和设置", () => {
	const sourceObservationFixture = (index: number) => ({
		observationId: `source-${index}`,
		version: 1,
		sourceLabel: `隔离来源 ${index}`,
		firstObservedAt: 1,
		observedAt: 1,
		observationCount: 1,
		detectedLocationCount: 1,
		acknowledgedAt: null,
		reminderDisposition: "unread" as const,
	});
	it.each([false, true])("两处计数均只含未读，初始已有已读=%s，确认后历史保留原时间且无按钮", async (alreadyRead) => {
		state.changes = [];
		state.sourceObservations = Array.from({ length: 6 }, (_, index) => sourceObservationFixture(index));
		if (alreadyRead)
			state.sourceObservations[0] = {
				...state.sourceObservations[0]!,
				acknowledgedAt: 42,
				reminderDisposition: "confirmed",
			};
		queries.batch.mockImplementation(async (input) => {
			const entry = input.items[0];
			state = {
				...state,
				revision: 2,
				sourceObservations: state.sourceObservations.map((observation) =>
					observation.observationId === entry.changeId
						? { ...observation, version: 2, acknowledgedAt: 84, reminderDisposition: "confirmed" as const }
						: observation,
				),
			};
			return { state, results: [{ changeId: entry.changeId, status: "applied", message: "已标记已读" }] };
		});
		await act(async () =>
			root.render(
				<>
					<NoticeHarness workspaceId="workspace" />
					<CodexConfigurationSyncSettings workspaceId="workspace" />
				</>,
			),
		);
		await flush();
		const unreadCount = alreadyRead ? 5 : 6;
		expect(
			container
				.querySelector('[data-verification-anchor="codex-configuration-sync-summary"]')
				?.getAttribute("aria-label"),
		).toContain(`来源更新 ${unreadCount} 条`);
		const sourceGroups = container.querySelectorAll('[role="group"][aria-label="来源更新"]');
		for (const group of sourceGroups)
			expect(group.querySelector("h3")?.textContent).toBe(`来源更新 · ${unreadCount}`);
		if (alreadyRead) {
			const historical = container.querySelector('[role="group"][aria-label="历史记录"] article')!;
			expect(historical.querySelector("button")).toBeNull();
			expect(historical.querySelector("time")?.dateTime).toBe(new Date(42).toISOString());
			return;
		}
		await act(async () => (sourceGroups[0]!.querySelector("button") as HTMLButtonElement).click());
		await flush();
		expect(
			container
				.querySelector('[data-verification-anchor="codex-configuration-sync-summary"]')
				?.getAttribute("aria-label"),
		).toContain("来源更新 5 条");
		for (const group of container.querySelectorAll('[role="group"][aria-label="来源更新"]'))
			expect(group.querySelector("h3")?.textContent).toBe("来源更新 · 5");
		expect(container.querySelector('[role="group"][aria-label="历史记录"] article button')).toBeNull();
	});
	it("稍后条目只进入历史并保留标记已读入口，新观测重新成为未读", async () => {
		state.changes = [];
		state.sourceObservations = [
			{ ...sourceObservationFixture(0), acknowledgedAt: 42, reminderDisposition: "deferred" },
		];
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		expect(container.querySelector('[role="group"][aria-label="来源更新"] h3')?.textContent).toBe("来源更新 · 0");
		const historical = container.querySelector('[role="group"][aria-label="历史记录"]')!;
		expect(historical.textContent).toContain("已稍后处理");
		expect(historical.querySelectorAll("button")).toHaveLength(1);
		expect(historical.querySelector("button")?.textContent).toBe("标记已读");
		state = {
			...state,
			revision: 3,
			sourceObservations: [{ ...sourceObservationFixture(0), version: 3, observationCount: 2 }],
		};
		await act(async () => notifyCodexConfigurationSyncUpdated());
		expect(container.querySelector('[role="group"][aria-label="来源更新"] h3')?.textContent).toBe("来源更新 · 1");
	});
	it("来源挂起只禁用自身，通知和设置共享等待，profile 操作锁不影响来源", async () => {
		state.changes = [];
		state.sourceObservations = [sourceObservationFixture(0), sourceObservationFixture(1)];
		queries.batch.mockImplementation(() => new Promise(() => {}));
		await act(async () =>
			root.render(
				<>
					<NoticeHarness workspaceId="workspace" />
					<CodexConfigurationSyncSettings workspaceId="workspace" />
				</>,
			),
		);
		await flush();
		const first = container.querySelectorAll('[aria-label="来源更新 隔离来源 0"]');
		await act(async () => (first[0]!.querySelector("button") as HTMLButtonElement).click());
		for (const entry of first) expect((entry.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
		for (const entry of container.querySelectorAll('[aria-label="来源更新 隔离来源 1"]'))
			expect((entry.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
		expect(queries.batch).toHaveBeenCalledTimes(1);
	});
	it("已反馈的建议到期后仍陈述广播事实，不误写成局部选择保留", async () => {
		state.changes[0] = {
			...state.changes[0]!,
			codexConfigurationProfileId: "profile",
			recordKind: "historical_record",
			approvalStatus: "approved",
			feedbackExpiresAtMs: Date.now() - 1,
		};
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		expect(container.textContent).toContain("已反馈到 profile；所属现有和未来会话自动采用");
		expect(container.textContent).not.toContain("反馈机会已结束，局部选择保留");
	});
	it.each(["编辑旧任务", "新任务已有局部权限"])(
		"%s 时加载 profile 列表不替换已有权限，显式另选仍采用 profile 权限",
		async (condition) => {
			state.profiles = [
				{
					profileId: "default-profile",
					name: "默认配置",
					sourceIdentity: "source",
					version: 1,
					fields: [
						{
							fieldKey: '["config.toml","approval_policy"]',
							fieldLabel: "approval_policy",
							value: "on-request",
							valueSummary: "on-request",
							version: 1,
							exceptionGroup: "permissions",
						},
						{
							fieldKey: '["config.toml","sandbox_mode"]',
							fieldLabel: "sandbox_mode",
							value: "workspace-write",
							valueSummary: "workspace-write",
							version: 1,
							exceptionGroup: "permissions",
						},
					],
				},
			];
			state.defaultCodexConfigurationProfileId = "default-profile";
			const onChange = vi.fn();
			const onPermissionModeChange = vi.fn();
			await act(async () =>
				root.render(
					<CodexConfigurationProfileSelect
						workspaceId="workspace"
						value={undefined}
						onChange={onChange}
						onPermissionModeChange={onPermissionModeChange}
						automaticallyChooseDefaultProfile={condition !== "编辑旧任务"}
						adoptDefaultProfilePermissions={false}
					/>,
				),
			);
			await flush();
			expect(onPermissionModeChange).not.toHaveBeenCalled();
			if (condition === "编辑旧任务") expect(onChange).not.toHaveBeenCalled();
			const select = container.querySelector("select");
			if (!select) throw new Error("缺少 profile 选择器");
			await act(async () => {
				select.value = "default-profile";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
			expect(onPermissionModeChange).toHaveBeenCalledWith("ask_for_every_tool_use");
		},
	);
	it("十分钟截止后即使服务端刷新失败也退出提醒，重新挂载不延长反馈期限", async () => {
		const deadline = Date.now() + 600_000;
		state.changes[0] = {
			...state.changes[0]!,
			codexConfigurationProfileId: "profile",
			exceptionGroup: "model",
			approvalStatus: "pending",
			mergeStatus: "pending_approval",
			feedbackExpiresAtMs: deadline,
		};
		await renderConfigurationNotice();
		expect(container.textContent).toContain("反馈到 profile 并广播");
		await act(async () => vi.advanceTimersByTime(300_000));
		await act(async () => root.render(<NoticeHarness key="reloaded" workspaceId="workspace" />));
		await flush();
		queries.fetch.mockRejectedValue(new Error("隔离的离线状态"));
		await act(async () => vi.advanceTimersByTime(300_001));
		expect(container.querySelector('[data-verification-anchor="codex-configuration-sync-summary"]')).toBeNull();
		expect(queries.batch).not.toHaveBeenCalled();
	});
	it("profile 管理按会话代际切换绑定，修改设置后一次更新并广播", async () => {
		state.profiles = ["first", "second"].map((profileId) => ({
			profileId,
			name: profileId === "first" ? "常用配置" : "独立配置",
			sourceIdentity: "same-source",
			version: 10,
			fields: [
				{
					fieldKey: '["config.toml","model"]',
					fieldLabel: "model",
					value: "initial-model",
					valueSummary: "initial-model",
					version: 10,
					exceptionGroup: "model",
				},
			],
		}));
		state.defaultCodexConfigurationProfileId = "first";
		state.sessionProfileBindings = [
			{
				workspaceId: "workspace",
				conversationSessionId: "owned-session",
				codexConfigurationProfileId: "first",
				localExceptionGroups: ["model"],
				runtimeSessionIncarnationId: "original-incarnation",
			},
		];
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		const select = container.querySelector<HTMLSelectElement>('[aria-label="会话 owned-session 所属 profile"]');
		if (!select) throw new Error("缺少会话 profile 选择");
		await act(async () => {
			select.value = "second";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(queries.profile).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "bind_session",
				profileId: "second",
				expectedRuntimeSessionIncarnationId: "original-incarnation",
			}),
		);
		const field = container.querySelector<HTMLInputElement>(
			'[data-verification-anchor="codex-configuration-profile-management"] details input',
		);
		if (!field) throw new Error("缺少 profile 设置编辑器");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(field, "updated-model");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => button("更新并广播").click());
		expect(queries.profile).toHaveBeenLastCalledWith(
			expect.objectContaining({
				action: "update",
				profileId: "first",
				expectedVersion: 10,
				fields: [{ fieldKey: '["config.toml","model"]', value: "updated-model" }],
			}),
		);
	});

	it("元数据刷新不续期，首次 8 秒后收起且不提交审批或移动焦点", async () => {
		const workspaceInput = document.createElement("input");
		document.body.append(workspaceInput);
		workspaceInput.focus();
		try {
			await renderConfigurationNotice();
			expect(document.activeElement).toBe(workspaceInput);
			await act(async () => vi.advanceTimersByTime(6_000));
			state = { ...state, revision: 2 };
			await act(async () => notifyCodexConfigurationSyncUpdated());
			await act(async () => vi.advanceTimersByTime(1_999));
			expect(button("收起")).toBeDefined();
			await act(async () => vi.advanceTimersByTime(1));
			expect(localStorage.getItem("codex-configuration-change-notice-collapsed")).toBe("true");
			expect(document.activeElement).toBe(workspaceInput);
			expect(queries.batch).not.toHaveBeenCalled();
			expect(queries.acknowledge).not.toHaveBeenCalled();
			expect(queries.synchronize).not.toHaveBeenCalled();
		} finally {
			workspaceInput.remove();
		}
	});
	it.each(["true", "false"])("旧值 %s 均可进入手动展开，失去内部焦点后仍保持", async (savedCollapsedState) => {
		localStorage.setItem("codex-configuration-change-notice-collapsed", savedCollapsedState);
		const panel = await renderConfigurationNotice();
		if (savedCollapsedState === "true") await act(async () => button("展开").click());
		await act(async () => container.querySelector<HTMLButtonElement>("button")!.focus());
		await act(async () => vi.advanceTimersByTime(80_000));
		expect(panel.hidden).toBe(false);
	});
	it.each(["pointer", "focus", "selection", "touch", "confirmation", "hidden-page", "delayed-visibility"])(
		"%s 保护期间暂停，解除后重新给予完整 8 秒",
		async (protection) => {
			const panel = await renderConfigurationNotice();
			const confirmation = document.createElement("div");
			confirmation.setAttribute("role", "alertdialog");
			const visibility = vi.spyOn(document, "visibilityState", "get");
			await act(async () => vi.advanceTimersByTime(6_000));
			await act(async () => {
				if (protection === "pointer") panel.dispatchEvent(new Event("pointerenter"));
				if (protection === "focus") container.querySelector<HTMLInputElement>('[type="search"]')!.focus();
				if (protection === "selection") {
					const range = document.createRange();
					range.selectNodeContents(panel.querySelector("p")!);
					document.getSelection()?.addRange(range);
					document.dispatchEvent(new Event("selectionchange"));
				}
				if (protection === "touch") panel.dispatchEvent(new Event("touchstart", { bubbles: true }));
				if (protection === "confirmation") document.body.append(confirmation);
				if (protection === "hidden-page" || protection === "delayed-visibility") {
					visibility.mockReturnValue("hidden");
					if (protection === "hidden-page") document.dispatchEvent(new Event("visibilitychange"));
				}
			});
			await act(async () => vi.advanceTimersByTime(80_000));
			expect(panel.hidden).toBe(false);
			await act(async () => {
				if (protection === "pointer") panel.dispatchEvent(new Event("pointerleave"));
				if (protection === "focus") container.querySelector<HTMLButtonElement>("button")!.focus();
				if (protection === "selection") {
					document.getSelection()?.removeAllRanges();
					document.dispatchEvent(new Event("selectionchange"));
				}
				if (protection === "touch") document.dispatchEvent(new Event("touchend"));
				if (protection === "confirmation") confirmation.remove();
				if (protection === "hidden-page" || protection === "delayed-visibility") {
					visibility.mockReturnValue("visible");
					document.dispatchEvent(new Event("visibilitychange"));
				}
			});
			await act(async () => vi.advanceTimersByTime(7_999));
			expect(panel.hidden).toBe(false);
			await act(async () => vi.advanceTimersByTime(1));
			expect(panel.hidden).toBe(true);
		},
	);
	it.each(["scroll", "wheel", "touchmove"])("%s 后完整重新计时", async (eventName) => {
		const panel = await renderConfigurationNotice();
		await act(async () => vi.advanceTimersByTime(6_000));
		await act(async () => panel.dispatchEvent(new Event(eventName)));
		await act(async () => vi.advanceTimersByTime(7_999));
		expect(panel.hidden).toBe(false);
		await act(async () => vi.advanceTimersByTime(1));
		expect(panel.hidden).toBe(true);
	});
	it("提交中的同步保护展示，回执后完整重新计时", async () => {
		let finish!: (value: CodexConfigurationSyncState) => void;
		queries.synchronize.mockImplementation(
			() =>
				new Promise<CodexConfigurationSyncState>((resolve) => {
					finish = resolve;
				}),
		);
		const panel = await renderConfigurationNotice();
		await act(async () => vi.advanceTimersByTime(6_000));
		await act(async () => button("同步设置").click());
		await act(async () => vi.advanceTimersByTime(80_000));
		expect(panel.hidden).toBe(false);
		await act(async () => finish(state));
		await act(async () => vi.advanceTimersByTime(7_999));
		expect(panel.hidden).toBe(false);
		await act(async () => vi.advanceTimersByTime(1));
		expect(panel.hidden).toBe(true);
		expect(queries.synchronize).toHaveBeenCalledTimes(1);
	});
	it("隐藏手机导航时暂停且保留展开意图，卸载清理倒计时与监听", async () => {
		const panel = await renderConfigurationNotice();
		await act(async () => vi.advanceTimersByTime(6_000));
		await renderConfigurationNotice({ isPresentationAvailable: false });
		expect(panel.hidden).toBe(true);
		expect(panel.dataset.state).toBe("closed");
		await act(async () => vi.advanceTimersByTime(80_000));
		expect(localStorage.getItem("codex-configuration-change-notice-collapsed")).toBeNull();
		await renderConfigurationNotice();
		expect(panel.hidden).toBe(false);
		expect(panel.dataset.state).toBe("open");
		await act(async () => vi.advanceTimersByTime(7_999));
		expect(panel.hidden).toBe(false);
		await act(async () => root.render(null));
		expect(vi.getTimerCount()).toBe(0);
		await act(async () => {
			panel.dispatchEvent(new Event("pointerleave"));
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(vi.getTimerCount()).toBe(0);
	});
	it("持续挂载保留筛选、选择、同步选项与阅读位置，配置设置关闭不恢复摘要焦点", async () => {
		state.changes.push({
			...state.changes[0]!,
			changeId: "pending",
			approvalStatus: "pending",
			mergeStatus: "pending_approval",
		});
		const onOpenSettings = vi.fn();
		await renderConfigurationNotice({ onOpenSettings });
		const selection = container.querySelector<HTMLInputElement>('[aria-label^="选择 "]')!;
		const synchronizationToggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
		const searchInput = container.querySelector<HTMLInputElement>('[aria-label="筛选配置记录"]')!;
		const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(searchInput, "hook");
			searchInput.dispatchEvent(new Event("input", { bubbles: true }));
			selection.click();
			synchronizationToggle.click();
			scroller.scrollTop = 120;
			scroller.dispatchEvent(new Event("scroll"));
		});
		await act(async () => button("收起").click());
		await act(async () => button("展开").click());
		expect(container.querySelector('[aria-label^="选择 "]')).toBe(selection);
		expect(selection.checked).toBe(true);
		expect(container.querySelector('[role="switch"]')).toBe(synchronizationToggle);
		expect(synchronizationToggle.getAttribute("aria-checked")).toBe("true");
		expect(searchInput.value).toBe("hook");
		expect(scroller.scrollTop).toBe(120);
		await act(async () => button("来源更新").click());
		await act(async () => button("收起").click());
		await act(async () => button("展开").click());
		expect(button("来源更新").getAttribute("aria-pressed")).toBe("true");
		await act(async () => button("配置同步设置").click());
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
		expect(container.querySelector<HTMLElement>('[aria-label="Codex 配置变更提示"]')!.hidden).toBe(true);
		expect(document.activeElement).not.toBe(
			container.querySelector('[data-verification-anchor="codex-configuration-sync-summary"]'),
		);
		expect(queries.batch).not.toHaveBeenCalled();
	});
	it("收起只改变显示，跨项目与刷新及新条目保持收起，并保留选择", async () => {
		state.changes[0]!.approvalStatus = "pending";
		state.changes[0]!.mergeStatus = "pending_approval";
		await renderConfigurationNotice();
		await act(async () => button("收起").click());
		expect(queries.acknowledge).not.toHaveBeenCalled();
		expect(queries.batch).not.toHaveBeenCalled();
		expect(button("展开").getAttribute("aria-expanded")).toBe("false");
		state = {
			...state,
			revision: 2,
			changes: [...state.changes, { ...state.changes[0]!, changeId: "new-change", version: 2 }],
		};
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await flush();
		expect(button("展开")).toBeDefined();
		await renderConfigurationNotice({ workspaceId: "another-project" });
		await flush();
		expect(button("展开")).toBeDefined();
		await act(async () => root.unmount());
		root = createRoot(container);
		await renderConfigurationNotice();
		expect(button("展开")).toBeDefined();
	});
	it("来源更新不显示审批或相同设置箭头，设置支持当前筛选全选与批量部分失败", async () => {
		state.sourceObservations = [
			{
				observationId: "source",
				version: 3,
				sourceLabel: "fixture@market",
				firstObservedAt: 1,
				observedAt: 3,
				observationCount: 60,
				detectedLocationCount: 10,
				acknowledgedAt: null,
				reminderDisposition: "unread",
			},
		];
		state.changes[0]!.approvalStatus = "pending";
		state.changes[0]!.mergeStatus = "pending_approval";
		queries.batch.mockResolvedValue({
			state,
			results: [{ changeId: "change-first", status: "source_unverifiable", message: "来源暂不可核验" }],
		});
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		const source = container.querySelector('[aria-label="来源更新 fixture@market"]');
		if (!source) throw new Error("缺少来源提示");
		expect(source.textContent).not.toContain("→");
		expect(source.textContent).not.toContain("通过");
		expect(source.textContent).toContain("标记已读");
		await act(async () =>
			(container.querySelector('[aria-label="全选当前筛选结果中的设置"]') as HTMLInputElement).click(),
		);
		await act(async () => button("批量通过").click());
		expect(queries.batch).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "approve",
				items: [
					expect.objectContaining({
						entryKind: "settings_proposal",
						changeId: "change-first",
						expectedVersion: 1,
					}),
				],
			}),
			expect.objectContaining({ context: { sendAsIndependentHttpRequest: false } }),
		);
		expect(container.textContent).toContain("来源暂不可核验");
	});

	it("非模态提示展示范围，toggle 默认关闭，只提交本次变更", async () => {
		await renderConfigurationNotice();
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
		await renderConfigurationNotice();
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
		await renderConfigurationNotice();
		await act(async () => button("稍后处理").click());
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await flush();
		expect(container.textContent).toBe("");
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		expect(container.textContent).toContain("开启 → 关闭");
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
