import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readUnconfirmedCodexConfigurationSettingActions,
	recordUnconfirmedCodexConfigurationSettingActionAutomaticResend,
	rememberUnconfirmedCodexConfigurationSettingAction,
} from "@/hooks/codex-configuration-unconfirmed-setting-actions";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import { notifyCodexConfigurationSyncUpdated } from "@/runtime/codex-configuration-sync-query";
import type {
	CodexConfigurationChange,
	CodexConfigurationProfileMutationRequest,
	CodexConfigurationSyncState,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const queries = vi.hoisted(() => ({ fetch: vi.fn(), profile: vi.fn(), batch: vi.fn(), receipt: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getCodexConfigurationSyncOverview: { query: queries.fetch },
			getCodexConfigurationMutationReceipt: { query: queries.receipt },
			mutateCodexConfigurationProfile: { mutate: queries.profile },
			batchCodexConfigurationAction: { mutate: queries.batch },
		},
	}),
}));
let container: HTMLDivElement;
let root: Root;
let state: CodexConfigurationSyncState;
let currentSync: ReturnType<typeof useCodexConfigurationSync>;
function createDeferredResponse<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
function HookHarness({ workspaceId = "fixture-workspace" }: { workspaceId?: string } = {}) {
	currentSync = useCodexConfigurationSync(workspaceId);
	return null;
}
beforeEach(async () => {
	localStorage.clear();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	state = { revision: 1, observationProblem: null, sourceObservations: [], changes: [] };
	queries.fetch.mockReset().mockImplementation(async () => state);
	queries.profile.mockReset();
	queries.batch.mockReset();
	queries.receipt.mockReset().mockResolvedValue(null);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(<HookHarness />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

function displayedCandidate(changeId: string, digest = "same-complete-value"): CodexConfigurationChange {
	return {
		changeId,
		version: 7,
		sourceWriterId: changeId,
		sourceConversationSessionId: changeId,
		sourceWorkspaceId: "workspace",
		fieldLabel: "model",
		previousValueSummary: "A",
		valueSummary: "B",
		observedAt: 1,
		recordKind: "settings_proposal",
		approvalStatus: "pending",
		decidedAt: null,
		settingDifferences: [],
		mergeStatus: "pending_approval",
		acknowledgedAt: null,
		eligibleTargetCount: 0,
		targets: [],
		candidateFieldGroupKey: "profile-a:model",
		codexConfigurationProfileId: "profile-a",
		completeCandidateValueDigest: digest,
	};
}

describe("候选采用只重试已展示的等价来源", () => {
	it.each([2, 4])("展示 %s 个等价来源时，来源暂不可用最多尝试三个原始版本", async (count) => {
		const displayed = Array.from({ length: count }, (_, index) => displayedCandidate(`source-${index}`));
		queries.batch.mockImplementation(async (request) => ({
			state,
			results: [
				{
					changeId: request.items[0].changeId,
					status: count === 2 && request.items[0].changeId === "source-1" ? "applied" : "source_unverifiable",
					message: "来源状态",
				},
			],
		}));
		await act(async () => {
			await currentSync.adoptCandidate([...displayed, displayedCandidate("other-value", "different-value")]);
		});
		expect(queries.batch.mock.calls.map(([request]) => request.items[0].changeId)).toEqual(
			displayed.slice(0, 3).map((change) => change.changeId),
		);
		expect(queries.batch.mock.calls.every(([request]) => request.items[0].expectedVersion === 7)).toBe(true);
	});
	it.each(["stale_version", "conflict"])("收到 %s 时补读并保留真实状态，不自动切换其他来源或值", async (status) => {
		queries.batch.mockImplementation(async (request) => ({
			state,
			results: [{ changeId: request.items[0].changeId, status, message: "版本变化" }],
		}));
		const readsBefore = queries.fetch.mock.calls.length;
		await act(async () => {
			await currentSync.adoptCandidate([displayedCandidate("first"), displayedCandidate("second")]);
		});
		expect(queries.batch).toHaveBeenCalledTimes(1);
		expect(queries.fetch.mock.calls.length).toBeGreaterThan(readsBefore);
	});
	it("回执未知时保留原幂等身份，不用其他来源再次发送", async () => {
		queries.batch.mockRejectedValue(new Error("回执丢失"));
		const displayed = [displayedCandidate("first"), displayedCandidate("second")];
		await act(async () => {
			await currentSync.adoptCandidate(displayed);
		});
		const identity = queries.batch.mock.calls[0]![0].items[0].idempotencyKey;
		await act(async () => {
			await currentSync.adoptCandidate(displayed);
		});
		expect(
			queries.batch.mock.calls.every(
				([request]) => request.items[0].changeId === "first" && request.items[0].idempotencyKey === identity,
			),
		).toBe(true);
	});
});

describe("profile 操作的幂等身份生命周期", () => {
	it("恢复记录按原操作类型校验，保留预算并排除损坏条目", () => {
		const profileInput = { action: "set_default", profileId: "profile", idempotencyKey: "profile-receipt" };
		const feedbackInput = {
			action: "reject",
			items: [
				{
					entryKind: "settings_proposal",
					changeId: "change",
					expectedVersion: 1,
					idempotencyKey: "feedback-receipt",
				},
			],
		};
		const metadata = { workspaceId: "workspace", storageIdentity: "storage", automaticResendCount: 1 };
		localStorage.setItem(
			LocalStorageKey.CodexConfigurationUnconfirmedSettingActions,
			JSON.stringify([
				{ ...metadata, identity: "profile", kind: "profile", input: profileInput },
				{ ...metadata, identity: "feedback", kind: "feedback", input: feedbackInput },
				{ ...metadata, identity: "wrong-kind", kind: "profile", input: feedbackInput },
				{ ...metadata, identity: "missing-input", kind: "feedback" },
				null,
			]),
		);
		expect(readUnconfirmedCodexConfigurationSettingActions()).toEqual([
			{ ...metadata, identity: "profile", kind: "profile", input: profileInput },
			{ ...metadata, identity: "feedback", kind: "feedback", input: feedbackInput },
		]);
	});
	it("自动重送预算跨重启保留，回执缺失不换身份或无限重送", async () => {
		vi.useFakeTimers();
		try {
			state = { ...state, storageIdentity: "persisted-resend-budget" };
			await act(async () => notifyCodexConfigurationSyncUpdated());
			queries.profile.mockRejectedValue(new Error("接口断线"));
			await act(async () => {
				await currentSync.profileAction({
					action: "set_default",
					profileId: "profile",
					idempotencyKey: "bounded-original-operation",
				});
			});
			for (let restart = 0; restart < 2; restart++) {
				await act(async () => root.render(null));
				await act(async () => root.render(<HookHarness />));
				await act(async () => vi.advanceTimersByTimeAsync(60_000));
			}
			expect(queries.profile).toHaveBeenCalledTimes(2);
			expect(
				queries.profile.mock.calls.every(([input]) => input.idempotencyKey === "bounded-original-operation"),
			).toBe(true);
			expect(
				JSON.parse(localStorage.getItem(LocalStorageKey.CodexConfigurationUnconfirmedSettingActions) ?? "[]")[0]
					?.automaticResendCount,
			).toBe(1);
		} finally {
			await act(async () => root.render(null));
			vi.useRealTimers();
		}
	});
	it("同页请求失败后核验原操作回执，不换身份重发", async () => {
		state = { ...state, storageIdentity: "persistent-settings-storage" };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		queries.profile.mockRejectedValueOnce(new Error("提交后连接中断"));
		queries.receipt.mockResolvedValue({ requestDigest: "verified-by-server", changeId: "profile" });
		await act(async () => {
			expect(
				await currentSync.profileAction({
					action: "set_default",
					profileId: "profile",
					idempotencyKey: "persisted-profile-operation",
				}),
			).toBe(false);
		});
		expect(queries.receipt).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "persisted-profile-operation" }),
			expect.anything(),
		);
		expect(queries.profile).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(localStorage.getItem(LocalStorageKey.CodexConfigurationUnconfirmedSettingActions) ?? "[]"),
		).toEqual([]);
	});
	it("存储不可写时不发送未持久化的配置操作", async () => {
		state = { ...state, storageIdentity: "storage-failure" };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		try {
			await act(async () => {
				expect(
					await currentSync.profileAction({
						action: "set_default",
						profileId: "profile",
						idempotencyKey: "not-persisted",
					}),
				).toBe(false);
			});
			expect(queries.profile).not.toHaveBeenCalled();
			expect(currentSync.error).toContain("未能持久保存");
		} finally {
			setItem.mockRestore();
		}
	});
	it("自动重送预算写入失败时不增加已持久化次数", () => {
		const remembered = rememberUnconfirmedCodexConfigurationSettingAction("workspace", "storage", {
			kind: "profile",
			input: { action: "set_default", profileId: "profile", idempotencyKey: "budget" },
		});
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		try {
			expect(() =>
				recordUnconfirmedCodexConfigurationSettingActionAutomaticResend(remembered.action.identity),
			).toThrow(/未能持久保存/);
		} finally {
			setItem.mockRestore();
		}
		expect(
			JSON.parse(localStorage.getItem(LocalStorageKey.CodexConfigurationUnconfirmedSettingActions) ?? "[]")[0]
				?.automaticResendCount,
		).toBe(0);
	});
	it.each(["set_default", "bind_session"] as const)("成功的 %s 意图结束后，相同参数的新意图仍执行", async (action) => {
		const receipts = new Set<string>();
		let selectedProfileId: string | undefined;
		queries.profile.mockImplementation(async (input: CodexConfigurationProfileMutationRequest) => {
			if (!receipts.has(input.idempotencyKey)) {
				receipts.add(input.idempotencyKey);
				if (input.action === "set_default" || input.action === "bind_session") selectedProfileId = input.profileId;
			}
			return state;
		});
		for (const profileId of ["profile-b", "profile-a", "profile-b"]) {
			const input: CodexConfigurationProfileMutationRequest =
				action === "set_default"
					? { action, profileId, idempotencyKey: crypto.randomUUID() }
					: {
							action,
							profileId,
							idempotencyKey: crypto.randomUUID(),
							workspaceId: "fixture-workspace",
							conversationSessionId: "fixture-session",
							expectedRuntimeSessionIncarnationId: "same-incarnation",
						};
			await act(async () => {
				await currentSync.profileAction(input);
			});
			expect(selectedProfileId).toBe(profileId);
		}
		expect(new Set(queries.profile.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(3);
	});
	it.each(["set_default", "bind_session"] as const)(
		"%s 首次已受理但回执丢失，经过另一项成功操作后，相同参数的新意图必须执行",
		async (action) => {
			const receipts = new Set<string>();
			let selectedProfileId: string | undefined;
			queries.profile.mockImplementation(async (input: CodexConfigurationProfileMutationRequest) => {
				if (!receipts.has(input.idempotencyKey)) {
					receipts.add(input.idempotencyKey);
					if (input.action === "set_default" || input.action === "bind_session")
						selectedProfileId = input.profileId;
				}
				if (queries.profile.mock.calls.length === 1) throw new Error("隔离模拟服务端受理后回执丢失");
				return state;
			});
			for (const [index, profileId] of ["profile-a", "profile-b", "profile-a"].entries()) {
				const input: CodexConfigurationProfileMutationRequest =
					action === "set_default"
						? { action, profileId, idempotencyKey: crypto.randomUUID() }
						: {
								action,
								profileId,
								idempotencyKey: crypto.randomUUID(),
								workspaceId: "fixture-workspace",
								conversationSessionId: "fixture-session",
								expectedRuntimeSessionIncarnationId: "same-incarnation",
							};
				await act(async () => {
					expect(await currentSync.profileAction(input)).toBe(index !== 0);
				});
				expect(selectedProfileId).toBe(profileId);
			}
			expect(new Set(queries.profile.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(3);
		},
	);
	it("连续回执丢失后以原身份重试，收到成功回执后才结束该身份", async () => {
		const receipts = new Set<string>();
		queries.profile.mockImplementation(async (input: CodexConfigurationProfileMutationRequest) => {
			receipts.add(input.idempotencyKey);
			if (queries.profile.mock.calls.length <= 2) throw new Error("隔离模拟服务端受理后回执丢失");
			return state;
		});
		const request = (): CodexConfigurationProfileMutationRequest => ({
			action: "set_default",
			profileId: "profile-b",
			idempotencyKey: crypto.randomUUID(),
		});
		await act(async () => {
			expect(await currentSync.profileAction(request())).toBe(false);
		});
		await act(async () => {
			expect(await currentSync.profileAction(request())).toBe(false);
		});
		await act(async () => {
			expect(await currentSync.profileAction(request())).toBe(true);
		});
		expect(receipts.size).toBe(1);
		await act(async () => {
			await currentSync.profileAction(request());
		});
		expect(receipts.size).toBe(2);
	});
});

describe("配置状态只读查询的界面补读", () => {
	it("较旧 mutation 快照晚于新查询返回时不回退 revision", async () => {
		const mutation = createDeferredResponse<CodexConfigurationSyncState>();
		queries.profile.mockImplementationOnce(() => mutation.promise);
		let operation: Promise<boolean | undefined>;
		await act(async () => {
			operation = currentSync.profileAction({
				action: "set_default",
				profileId: "profile",
				idempotencyKey: "isolated-profile",
			});
		});
		state = { ...state, revision: 5 };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await act(async () => {
			mutation.resolve({ ...state, revision: 2 });
			await operation;
		});
		expect(currentSync.state?.revision).toBe(5);
	});
	it("新查询返回较低 revision 时不覆盖已接受的 mutation", async () => {
		queries.profile.mockResolvedValue({ ...state, revision: 7 });
		await act(async () => {
			await currentSync.profileAction({
				action: "set_default",
				profileId: "profile",
				idempotencyKey: "isolated-newer-profile",
			});
		});
		expect(currentSync.state?.revision).toBe(7);
	});
	it("workspace 切换后旧 mutation 不污染新状态，也不解除新操作等待", async () => {
		const oldMutation = createDeferredResponse<CodexConfigurationSyncState>();
		const newMutation = createDeferredResponse<CodexConfigurationSyncState>();
		queries.profile
			.mockImplementationOnce(() => oldMutation.promise)
			.mockImplementationOnce(() => newMutation.promise);
		let oldOperation: Promise<boolean | undefined>;
		await act(async () => {
			oldOperation = currentSync.profileAction({
				action: "set_default",
				profileId: "old",
				idempotencyKey: "old-workspace",
			});
		});
		state = { ...state, revision: 3 };
		await act(async () => root.render(<HookHarness workspaceId="another-workspace" />));
		let newOperation: Promise<boolean | undefined>;
		await act(async () => {
			newOperation = currentSync.profileAction({
				action: "set_default",
				profileId: "new",
				idempotencyKey: "new-workspace",
			});
		});
		await act(async () => {
			oldMutation.resolve({ ...state, revision: 99 });
			await oldOperation;
		});
		expect(currentSync.state?.revision).toBe(3);
		expect(currentSync.pendingChangeId).toBe("profile");
		await act(async () => {
			newMutation.resolve({ ...state, revision: 4 });
			await newOperation;
		});
		expect(currentSync.state?.revision).toBe(4);
		expect(currentSync.pendingChangeId).toBeNull();
	});
	it("workspace 切换后挂起的旧查询不能污染新状态", async () => {
		const earlier = createDeferredResponse<CodexConfigurationSyncState>();
		queries.fetch.mockImplementationOnce(() => earlier.promise);
		await act(async () => notifyCodexConfigurationSyncUpdated());
		state = { ...state, revision: 2 };
		await act(async () => root.render(<HookHarness workspaceId="another-workspace" />));
		await act(async () => earlier.resolve({ ...state, revision: 99 }));
		expect(currentSync.state?.revision).toBe(2);
	});
	it("一个来源请求挂起时其他来源仍可处理，同来源连点不重复提交", async () => {
		state = {
			...state,
			revision: 2,
			sourceObservations: ["first", "second"].map((observationId) => ({
				observationId,
				version: 1,
				sourceLabel: observationId,
				firstObservedAt: 1,
				observedAt: 1,
				observationCount: 1,
				detectedLocationCount: 1,
				acknowledgedAt: null,
				reminderDisposition: "unread",
			})),
		};
		await act(async () => notifyCodexConfigurationSyncUpdated());
		queries.batch.mockImplementation(() => new Promise(() => {}));
		const entry = (changeId: string) => ({ entryKind: "source_observation" as const, changeId, expectedVersion: 1 });
		await act(async () => {
			void currentSync.batch("confirm_source", [entry("first")]);
			void currentSync.batch("confirm_source", [entry("first")]);
			void currentSync.batch("defer", [entry("second")]);
		});
		expect(queries.batch).toHaveBeenCalledTimes(2);
		expect(currentSync.pendingChangeId).toBeNull();
	});
	it.each([false, true])(
		"保留的 Hook 最初 enabled=%s，跨零订阅再启用后仍共享来源单飞和冻结身份",
		async (initiallyEnabled) => {
			state = {
				...state,
				sourceObservations: [
					{
						observationId: "source",
						version: 1,
						sourceLabel: "隔离来源",
						firstObservedAt: 1,
						observedAt: 1,
						observationCount: 1,
						detectedLocationCount: 1,
						acknowledgedAt: null,
						reminderDisposition: "unread",
					},
				],
			};
			const consumers: Record<string, typeof currentSync> = {};
			function Consumer({ name, enabled = true }: { name: string; enabled?: boolean }) {
				consumers[name] = useCodexConfigurationSync(`retained-source-${initiallyEnabled}`, enabled);
				return null;
			}
			const renderConsumers = async (enabled: boolean, other: "transient" | "newcomer" | null) => {
				await act(async () =>
					root.render(
						<>
							<Consumer key="retained" name="retained" enabled={enabled} />
							{other && <Consumer key={other} name={other} />}
						</>,
					),
				);
			};
			await renderConsumers(initiallyEnabled, "transient");
			await renderConsumers(false, "transient");
			await renderConsumers(false, null);
			await renderConsumers(false, "newcomer");
			await renderConsumers(true, "newcomer");
			queries.batch.mockReturnValue(createDeferredResponse<unknown>().promise);
			const item = { entryKind: "source_observation" as const, changeId: "source", expectedVersion: 1 };
			await act(async () => {
				void consumers.newcomer!.batch("confirm_source", [item]);
			});
			const persistedKey = LocalStorageKey.CodexConfigurationUnconfirmedSourceObservationActions;
			const frozen = localStorage.getItem(persistedKey);
			const original = consumers.newcomer!.sourceOperations.source;
			await act(async () => {
				void consumers.retained!.batch("defer", [item]);
			});
			expect(queries.batch).toHaveBeenCalledTimes(1);
			expect(consumers.retained!.sourceOperations.source).toEqual(original);
			expect(localStorage.getItem(persistedKey)).toBe(frozen);
			expect(JSON.parse(frozen!)[0].item).toEqual(original!.item);
		},
	);
	it("首次加载读取持久状态，断线后的失效通知自动补读并清除读取错误", async () => {
		expect(queries.fetch).toHaveBeenCalledTimes(1);
		expect(currentSync.state?.revision).toBe(1);
		queries.fetch.mockRejectedValueOnce(new Error("隔离模拟断线"));
		await act(async () => notifyCodexConfigurationSyncUpdated());
		expect(currentSync.error).toContain("暂时无法读取");
		state = { ...state, revision: 2 };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		expect(currentSync.state?.revision).toBe(2);
		expect(currentSync.error).toBeNull();
		expect(queries.profile).not.toHaveBeenCalled();
	});
	it("较早的查询迟到时不覆盖重连补读的新状态", async () => {
		let resolveEarlierQuery: (value: CodexConfigurationSyncState) => void = () => {};
		queries.fetch.mockImplementationOnce(
			() =>
				new Promise<CodexConfigurationSyncState>((resolve) => {
					resolveEarlierQuery = resolve;
				}),
		);
		await act(async () => notifyCodexConfigurationSyncUpdated());
		state = { ...state, revision: 3 };
		await act(async () => notifyCodexConfigurationSyncUpdated());
		await act(async () => resolveEarlierQuery({ ...state, revision: 2 }));
		expect(currentSync.state?.revision).toBe(3);
	});
});
