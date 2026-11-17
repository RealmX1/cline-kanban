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
	details: vi.fn(),
	synchronize: vi.fn(),
	acknowledge: vi.fn(),
	resolve: vi.fn(),
	resolveTarget: vi.fn(),
	batch: vi.fn(),
	profile: vi.fn(),
	adoption: vi.fn(),
	sharingScope: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getCodexConfigurationSyncOverview: { query: queries.fetch },
			getCodexConfigurationChangeDetails: { query: queries.details },
			mutateCodexConfigurationProfile: { mutate: queries.profile },
			setCodexConfigurationChangeSharingScope: { mutate: queries.sharingScope },
			listCodexConfigurationSessionAdoptionProgress: { query: queries.adoption },
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
	return document.querySelector<HTMLElement>('[aria-label="Codex 配置变更提示"]')!;
}
const button = (label: string) =>
	label === "展开"
		? (container.querySelector(
				'[data-verification-anchor="codex-configuration-sync-summary"][aria-expanded="false"]',
			) as HTMLButtonElement)
		: ([...document.querySelectorAll("button")].find(
				(element) => element.textContent === label,
			) as HTMLButtonElement);
beforeEach(() => {
	queries.sharingScope.mockReset().mockImplementation(async () => state);
	queries.details.mockReset();
	localStorage.clear();
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	queries.batch.mockReset();
	queries.profile.mockReset().mockImplementation(async () => state);
	queries.adoption.mockReset().mockImplementation(async () => ({
		storageIdentity: "fixture",
		totalCount: 1,
		nextCursor: null,
		entries: (state.sessionProfileBindings ?? []).map((entry) => ({
			...entry,
			profileId: entry.codexConfigurationProfileId,
			status: "local_selection",
			writerId: "current-writer",
			recoveryCondition: null,
		})),
	}));
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

function setTargetComparisonFixture(targetWriterId: string, expectedTargetValueDigest: string) {
	state.changes[0]!.targetComparisons = {
		[targetWriterId]: {
			targetWriterId,
			expectedSharedValueDigest: "shared-default",
			expectedTargetValueDigest,
			rows: [
				{
					fieldKey: "hook",
					label: "hook",
					changeKind: "modified",
					previous: { state: "present", text: "旧默认" },
					detected: { state: "present", text: "来源值" },
					target: { state: "present", text: "目标值" },
				},
			],
		},
	};
}

describe("Codex 配置同步提示和设置", () => {
	it("普通自动共享即使已处理也会展示范围入口，键盘可选择仅本会话", async () => {
		Object.assign(state.changes[0]!, {
			codexConfigurationProfileId: "profile-a",
			recordKind: "historical_record",
			approvalStatus: "approved",
			acknowledgedAt: 2,
			changeSharingScope: {
				currentScope: "profile",
				requestedScope: "profile",
				withdrawalStatus: "not_requested",
				compensationChangeIds: [],
				conflicts: [],
			},
		});
		await renderConfigurationNotice();
		await act(async () => vi.advanceTimersByTimeAsync(10_000));
		const trigger = document.querySelector<HTMLButtonElement>('[aria-label*="本次修改的共享范围"]')!;
		expect(trigger.textContent).toContain("共享到配置方案");
		expect(trigger.className).toContain("border-accent");
		await act(async () => {
			trigger.focus();
			trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		await act(async () => vi.advanceTimersByTimeAsync(1));
		const local = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((entry) =>
			entry.textContent?.includes("仅本会话"),
		)!;
		expect(local).toBeDefined();
		await act(async () => local.click());
		await flush();
		expect(queries.sharingScope).toHaveBeenCalledWith(
			expect.objectContaining({
				changeId: "change-first",
				expectedVersion: 1,
				targetScope: "session_only",
				stateResponseScope: "overview",
			}),
			expect.anything(),
		);
	});
	it("过期的局部变更仍能在历史中通过同一下拉切换范围", async () => {
		Object.assign(state.changes[0]!, {
			codexConfigurationProfileId: "profile-a",
			approvalStatus: "expired",
			feedbackExpiresAtMs: 1,
			changeSharingScope: {
				currentScope: "session_only",
				requestedScope: "session_only",
				withdrawalStatus: "not_requested",
				compensationChangeIds: [],
				conflicts: [],
			},
		});
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await act(async () => button("历史").click());
		await flush();
		const trigger = container.querySelector<HTMLButtonElement>('[aria-label*="本次修改的共享范围"]')!;
		expect(trigger.disabled).toBe(false);
		expect(trigger.textContent).toContain("仅本会话");
		expect(trigger.className).toContain("border-text-secondary");
	});
	it("归档的旧外部记录只展示历史事实，不显示同步动作或正在广播的文案", async () => {
		state.changes[0] = {
			...state.changes[0]!,
			recordKind: "historical_record",
			codexConfigurationProfileId: "profile-a",
			profileName: "工作配置",
			settingsIsolationArchivedAtMs: 1,
			acknowledgedAt: 1,
		};
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await act(async () => button("历史").click());
		expect(container.textContent).toContain("此记录已退出设置同步");
		expect(container.textContent).not.toContain("正在自动广播");
		expect(button("同步设置")).toBeUndefined();
	});
	it("同 profile 同字段合成一项，同值合并来源，不同值各有贴值按钮，保留默认绑定全部展示成员", async () => {
		const original = state.changes[0]!;
		state.changes = ["B", "B", "C"].map((value, index) => ({
			...original,
			changeId: `choice-${index}`,
			version: index + 1,
			codexConfigurationProfileId: "profile-a",
			profileName: "工作配置",
			fieldKey: '["config.toml","model"]',
			fieldLabel: "config.toml · model",
			candidateFieldGroupKey: "profile-a:model",
			completeCandidateValueDigest: value,
			approvalStatus: "pending",
			mergeStatus: "pending_approval",
			feedbackExpiresAtMs: Date.now() + 600_000,
			sourceConversationSessionId: `会话 ${index}`,
			comparison: {
				expectedSharedValueDigest: "default-A",
				rows: [
					{
						fieldKey: "model",
						label: "model",
						changeKind: "modified",
						previous: { state: "present", text: '"A"' },
						detected: { state: "present", text: `"${value}"` },
						sharedCurrent: { state: "present", text: '"A"' },
						previousMatchesSharedCurrent: true,
					},
				],
			},
		}));
		queries.batch.mockImplementation(async (request) => ({
			state,
			results: request.items.map((item: { changeId: string }) => ({
				changeId: item.changeId,
				status: "applied",
				message: "已保存",
			})),
		}));
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		expect(container.textContent).toContain("可选反馈 · 1");
		expect(
			container.querySelectorAll('[data-verification-anchor="codex-configuration-proposal-group"]'),
		).toHaveLength(1);
		const candidates = container.querySelectorAll('[data-configuration-value-choice="candidate"]');
		expect(candidates).toHaveLength(2);
		expect(candidates[0]?.textContent).toContain('"B"');
		expect(candidates[0]?.textContent).toContain("更新默认并同步");
		expect(container.textContent).toContain("2 个来源");
		expect(container.querySelector('[data-configuration-value-choice="current"]')?.textContent).toContain('"A"');
		await act(async () => button("保持默认").click());
		expect(queries.batch).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "reject",
				items: state.changes.map((change) =>
					expect.objectContaining({ changeId: change.changeId, expectedVersion: change.version }),
				),
			}),
			expect.anything(),
		);
	});

	it("默认直显任务归属与冲突值，展开失败可重试，操作绑定展示的共享值", async () => {
		const change = state.changes[0]!;
		change.fieldLabel = "config.toml · ponytail@ponytail:hooks/hooks.json · Hook subagent_start:0:0";
		change.approvalStatus = "pending";
		change.mergeStatus = "conflict";
		change.sourceEvidence = {
			initiator: { status: "unknown", description: "缺少原生修改记录" },
			detectedOwner: {
				writerId: "writer-first",
				workspaceId: "workspace",
				conversationSessionId: "side-session",
				description: "持久 writer 绑定",
				task: {
					workspaceId: "workspace",
					projectPath: "/projects/kanban",
					taskId: "9c8d6",
					taskTitle: "配置来源回归",
					taskIncarnationCreatedAtEpochMs: 1,
					conversationSessionId: "side-session",
					runtimeSessionIncarnationId: "incarnation",
				},
			},
			recoveryCondition: "归属恢复后自动重验",
		};
		change.comparison = {
			expectedSharedValueDigest: "displayed-shared",
			rows: [
				{
					fieldKey: "hook-field",
					label: "trusted_content_hash",
					changeKind: "modified",
					previous: { state: "present", text: "旧内容信任" },
					detected: { state: "present", text: "新内容信任" },
					sharedAtConflict: { state: "present", text: "冲突时信任" },
					sharedCurrent: { state: "present", text: "共享方的当前信任" },
					sharedOrigin: { description: "共享字段版本 7", fieldVersion: 7 },
				},
			],
		};
		queries.details.mockRejectedValueOnce(new Error("暂不可读")).mockResolvedValue({
			...change.comparison,
			changeId: change.changeId,
			version: change.version,
			fieldLabel: change.fieldLabel,
			sourceEvidence: change.sourceEvidence,
			hookExplanation: "完整 Hook 指纹",
		});
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		expect(container.textContent).toContain("配置来源回归");
		expect(container.textContent).toContain("9c8d6");
		expect(container.textContent).toContain("共享方的当前信任");
		expect(container.textContent).toContain("缺少原生修改记录");
		expect(queries.details).not.toHaveBeenCalled();
		await act(async () => button("展开完整比较").click());
		expect(container.textContent).toContain("暂不可读");
		await act(async () => button("重试加载完整比较").click());
		expect(queries.details).toHaveBeenCalledTimes(2);
		queries.resolve.mockResolvedValue(state);
		await act(async () => button("采用检测到的新值，更新共享默认").click());
		expect(queries.resolve.mock.calls.at(-1)?.[0]).toMatchObject({ expectedSharedValueDigest: "displayed-shared" });
		state = {
			...state,
			changes: state.changes.map((entry) =>
				entry.changeId === change.changeId && entry.sourceEvidence
					? {
							...entry,
							sourceEvidence: {
								...entry.sourceEvidence,
								detectedOwner: {
									...entry.sourceEvidence.detectedOwner,
									currentTaskLink: undefined,
									unavailableReason: "原任务已删除",
								},
							},
						}
					: entry,
			),
		};
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await flush();
		expect(queries.details).toHaveBeenCalledTimes(3);
	});
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
			await act(async () => button("历史").click());
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
	it.each(["配置来源回归", "9c8d6", "ponytail", "sandbox_mode"])(
		"已处理来源更新仍按嵌套记录搜索 %s",
		async (search) => {
			state.changes[0] = {
				...state.changes[0]!,
				changeId: "nested-source-change",
				fieldLabel: "config.toml · ponytail@ponytail:hooks/hooks.json · Hook stop:0:0",
				fieldKey: '["config.toml","sandbox_mode"]',
				sourceEvidence: {
					initiator: { status: "unknown", description: "缺少原生修改记录" },
					detectedOwner: {
						writerId: "writer-first",
						workspaceId: "workspace",
						conversationSessionId: "side-session",
						description: "持久 writer 绑定",
						task: {
							workspaceId: "workspace",
							projectPath: "/projects/kanban",
							taskId: "9c8d6",
							taskTitle: "配置来源回归",
							taskIncarnationCreatedAtEpochMs: 1,
							conversationSessionId: "side-session",
							runtimeSessionIncarnationId: "incarnation",
						},
					},
					recoveryCondition: "归属恢复后自动重验",
				},
			};
			state.sourceObservations = [
				{
					...sourceObservationFixture(0),
					changeIds: ["nested-source-change"],
					acknowledgedAt: 42,
					reminderDisposition: "confirmed",
				},
			];
			await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
			await flush();
			await act(async () => button("历史").click());
			const input = container.querySelector<HTMLInputElement>('[aria-label="筛选配置记录"]')!;
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, search);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
			const history = container.querySelector('[role="group"][aria-label="历史记录"]')!;
			expect(history.textContent).toContain("隔离来源 0");
			expect(history.textContent).toContain("ponytail@ponytail");
		},
	);
	it("稍后条目只进入历史并保留标记已读入口，新观测重新成为未读", async () => {
		state.changes = [];
		state.sourceObservations = [
			{ ...sourceObservationFixture(0), acknowledgedAt: 42, reminderDisposition: "deferred" },
		];
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await flush();
		expect(container.querySelector('[role="group"][aria-label="来源更新"] h3')?.textContent).toBe("来源更新 · 0");
		await act(async () => button("历史").click());
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
		await act(async () => button("可选反馈").click());
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
		await act(async () => button("历史").click());
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
		expect(document.querySelector('[aria-label="Codex 配置变更提示"]')?.textContent).toContain("更新默认并同步");
		await act(async () => vi.advanceTimersByTime(300_000));
		await act(async () => root.render(<NoticeHarness key="reloaded" workspaceId="workspace" />));
		await flush();
		queries.fetch.mockRejectedValue(new Error("隔离的离线状态"));
		await act(async () => vi.advanceTimersByTime(300_001));
		expect(
			container
				.querySelector('[data-verification-anchor="codex-configuration-sync-summary"]')
				?.getAttribute("aria-label"),
		).toContain("可选反馈 0 项");
		expect(queries.batch).not.toHaveBeenCalled();
	});
	it("自动采用分区按会话代际切换配置绑定", async () => {
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
		await act(async () => button("自动采用").click());
		const select = container.querySelector<HTMLSelectElement>('[aria-label="会话 owned-session 所属配置"]');
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
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
		state.changes.push({ ...state.changes[0]!, changeId: "change-second", fieldLabel: "另一可选设置" });
		queries.batch.mockResolvedValue({
			state,
			results: [
				{ changeId: "change-first", status: "source_unverifiable", message: "来源暂不可核验" },
				{ changeId: "change-second", status: "applied", message: "已保存" },
			],
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
					expect.objectContaining({ changeId: "change-second", expectedVersion: 1 }),
				],
			}),
			expect.objectContaining({ context: { sendAsIndependentHttpRequest: false } }),
		);
		expect(container.textContent).toContain("来源暂不可核验");
	});

	it("折叠中的其他建议不登记展示回执，展开后才确认", async () => {
		const original = state.changes[0]!;
		state.changes = ["visible", "folded"].map((label, index) => ({
			...original,
			changeId: `scope-${label}`,
			fieldLabel: label,
			valueSummary: label,
			observedAt: 200 - index,
			approvalStatus: "approved" as const,
			acknowledgedAt: 1,
			noticePresentedAtMs: undefined,
			changeSharingScope: {
				currentScope: "profile" as const,
				requestedScope: "profile" as const,
				withdrawalStatus: "not_requested" as const,
				compensationChangeIds: [],
				conflicts: [],
			},
		}));
		const acknowledged: string[] = [];
		queries.acknowledge.mockImplementation(async (input: { changeId: string }) => {
			acknowledged.push(input.changeId);
			return state;
		});
		await renderConfigurationNotice();
		await act(async () => vi.advanceTimersByTimeAsync(10_000));
		await flush();
		expect(acknowledged).toEqual(["scope-visible"]);
		await act(async () => button("其他建议 · 1 项").click());
		await flush();
		expect(acknowledged).toEqual(["scope-visible", "scope-folded"]);
	});
	it("紧凑浮层不抢焦点，只处理展示的候选，Escape 返回顶栏", async () => {
		const original = state.changes[0]!;
		state.changes = ["max", "ultra"].map((value, index) => ({
			...original,
			changeId: `compact-${index}`,
			recordKind: "settings_proposal" as const,
			approvalStatus: "pending" as const,
			mergeStatus: "pending_approval" as const,
			candidateFieldGroupKey: "reasoning",
			completeCandidateValueDigest: value,
			exceptionGroup: "reasoning_effort" as const,
			observedAt: Date.now() - 20_000,
			feedbackExpiresAtMs: Date.now() + 600_000,
			comparison: {
				expectedSharedValueDigest: "current",
				rows: [
					{
						fieldKey: "effort",
						label: "推理强度",
						changeKind: "modified" as const,
						previous: { state: "present" as const, text: "xhigh" },
						detected: { state: "present" as const, text: value },
						sharedCurrent: { state: "present" as const, text: "xhigh" },
					},
				],
			},
		}));
		queries.batch.mockImplementation(async (input) => ({
			state,
			results: input.items.map((item: { changeId: string }) => ({
				changeId: item.changeId,
				status: "applied",
				message: "已处理",
			})),
		}));
		const input = document.createElement("input");
		document.body.append(input);
		input.focus();
		await renderConfigurationNotice();
		expect(document.activeElement).toBe(input);
		const panel = document.querySelector<HTMLElement>('[aria-label="Codex 配置变更提示"]')!;
		expect(panel.textContent).toContain("其他建议 · 1 项");
		await act(async () => button("保持默认").click());
		expect(queries.batch.mock.calls[0]?.[0].items).toHaveLength(1);
		await act(async () => panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.activeElement).toBe(
			container.querySelector('[data-verification-anchor="codex-configuration-sync-summary"]'),
		);
		input.remove();
	});
	it("浮层采用会继续尝试同一候选的其他已展示来源", async () => {
		const original = state.changes[0]!;
		state.changes = [0, 1].map((index) => ({
			...original,
			changeId: `equivalent-${index}`,
			recordKind: "settings_proposal" as const,
			approvalStatus: "pending" as const,
			mergeStatus: "pending_approval" as const,
			candidateFieldGroupKey: "reasoning",
			completeCandidateValueDigest: "same-value",
			exceptionGroup: "reasoning_effort" as const,
			observedAt: Date.now() - 20_000,
			feedbackExpiresAtMs: Date.now() + 600_000,
			comparison: {
				expectedSharedValueDigest: "current",
				rows: [
					{
						fieldKey: "effort",
						label: "推理强度",
						changeKind: "modified" as const,
						previous: { state: "present" as const, text: "xhigh" },
						detected: { state: "present" as const, text: "max" },
						sharedCurrent: { state: "present" as const, text: "xhigh" },
					},
				],
			},
		}));
		queries.batch.mockImplementation(async (input) => ({
			state,
			results: input.items.map((item: { changeId: string }) => ({
				changeId: item.changeId,
				status: item.changeId === "equivalent-1" ? "source_unverifiable" : "applied",
				message: "来源",
			})),
		}));
		await renderConfigurationNotice();
		await act(async () => button("更新默认并同步").click());
		expect(queries.batch.mock.calls.map((call) => call[0].items[0].changeId)).toEqual([
			"equivalent-1",
			"equivalent-0",
		]);
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
		setTargetComparisonFixture("writer-3", "expected-target-digest");
		await act(async () => root.render(<CodexConfigurationSyncSettings workspaceId="workspace" />));
		await act(async () => button("历史").click());
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
		setTargetComparisonFixture("target-writer", "target-value-digest");
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
		await act(async () => button("历史").click());
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
		await act(async () => button("历史").click());
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
		await act(async () => button("历史").click());
		await flush();
		expect(container.textContent).toContain("已保留共享默认");
		expect(container.textContent).not.toContain("本会话保留自己的决定");
	});
});
