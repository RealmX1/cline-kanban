import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPostDeployVerificationTaskReadModelTestFixture } from "@/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";
import { usePostDeployVerification } from "@/hooks/use-post-deploy-verification";
import type { RuntimePostDeployVerificationDeploymentGroup, RuntimePostDeployVerificationTask } from "@/runtime/types";

// 这些结构与后端 zod schema 同形（api-contract.ts），此处只声明 hook 实际读到的字段形状，避免依赖被混淆的 response 别名。
interface GetVerificationStateResponse {
	deploymentGroups: RuntimePostDeployVerificationDeploymentGroup[];
	activeDeploymentId: string | null;
}
interface UpdateChecklistResponse {
	ok: boolean;
	task: RuntimePostDeployVerificationTask | null;
	error?: string;
}

interface Deferred<ValueType> {
	promise: Promise<ValueType>;
	resolve: (value: ValueType) => void;
	reject: (error: unknown) => void;
}

// 从「可手动 resolve 的 deferred 数组」按 index 安全取值。tsconfig 的 noUncheckedIndexedAccess 会把裸下标收窄为 `Deferred | undefined`，
// 直接 `.resolve()` 会命中 TS2532。此处集中做存在性断言：缺失即抛出带索引/长度的清晰错误——顺带把「测试编排的 query/mutate 调用顺序
// 与实际入队顺序不一致，导致期望的 deferred 尚未存在」这类失误暴露成可读诊断，而非晦涩的 `undefined.resolve` 崩溃。
function requireDeferredAtIndex<ValueType>(
	deferreds: ReadonlyArray<Deferred<ValueType>>,
	index: number,
): Deferred<ValueType> {
	const deferredAtIndex = deferreds[index];
	if (deferredAtIndex === undefined) {
		throw new Error(
			`预期在 deferred 数组索引 ${index} 处存在一个可手动 resolve 的 deferred，但该位置为空（当前数组长度 ${deferreds.length}）；` +
				`这通常意味着测试编排所假设的 query/mutate 调用顺序与实际入队顺序不一致。`,
		);
	}
	return deferredAtIndex;
}

// 每次 query / mutate 调用都推入一个可手动 resolve 的 deferred，测试据此精确编排「点击前快照」与「乐观写入」的到达顺序。
// deferred 的构造内联在各 mock 工厂里：vi.hoisted 会把这些工厂提升到 import 之上，内联可避免对局部辅助函数的提升顺序依赖。
const pendingVerificationStateQueryDeferreds = vi.hoisted(() => [] as Array<Deferred<GetVerificationStateResponse>>);
const pendingUpdateChecklistMutateDeferreds = vi.hoisted(() => [] as Array<Deferred<UpdateChecklistResponse>>);

const getVerificationStateQueryMock = vi.hoisted(() =>
	vi.fn(() => {
		let resolve!: (value: GetVerificationStateResponse) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<GetVerificationStateResponse>((resolveFn, rejectFn) => {
			resolve = resolveFn;
			reject = rejectFn;
		});
		pendingVerificationStateQueryDeferreds.push({ promise, resolve, reject });
		return promise;
	}),
);
const updateChecklistMutateMock = vi.hoisted(() =>
	vi.fn(() => {
		let resolve!: (value: UpdateChecklistResponse) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<UpdateChecklistResponse>((resolveFn, rejectFn) => {
			resolve = resolveFn;
			reject = rejectFn;
		});
		pendingUpdateChecklistMutateDeferreds.push({ promise, resolve, reject });
		return promise;
	}),
);

const failedDetailDeploymentIds = new Set<string>();
const requestedDetailDeploymentIds: string[] = [];
const detailFixtureByDeploymentId = new Map<string, RuntimePostDeployVerificationDeploymentGroup>();
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string) => ({
		deployment: {
			getPostDeployVerificationWorkspaceOverview: {
				query: async () => {
					const response = await getVerificationStateQueryMock();
					const deploymentGroups = response.deploymentGroups.map((original) => {
						const group = { ...original, workspaceId };
						detailFixtureByDeploymentId.set(group.deploymentId, group);
						const requiring = group.tasks.filter(
							(task) =>
								task.droppedReason === null &&
								!task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded,
						);
						return {
							...group,
							contentVersion: JSON.stringify(group),
							pendingVerificationTaskCount: requiring.filter(
								(task) =>
									task.verifiedAt === null &&
									!task.postDeployVerificationClosure &&
									!task.carriedForwardIntoDeploymentId,
							).length,
							closedTaskCount: requiring.filter(
								(task) => task.verifiedAt !== null || task.postDeployVerificationClosure,
							).length,
							taskCountRequiringVerification: requiring.length,
							carriedForwardTaskCount: requiring.filter((task) => task.carriedForwardIntoDeploymentId).length,
						};
					});
					return {
						activeDeploymentId: response.activeDeploymentId,
						deploymentGroups,
						pendingVerificationTaskCount:
							deploymentGroups.find((group) => group.deploymentId === response.activeDeploymentId)
								?.pendingVerificationTaskCount ?? 0,
					};
				},
			},
			getPostDeployVerificationDeploymentGroup: {
				query: async ({ deploymentId }: { deploymentId: string }) => {
					requestedDetailDeploymentIds.push(deploymentId);
					if (failedDetailDeploymentIds.has(deploymentId)) throw new Error("部署组详情暂不可用");
					const group = detailFixtureByDeploymentId.get(deploymentId);
					return group
						? { status: "changed", contentVersion: JSON.stringify(group), deploymentId, deploymentGroup: group }
						: { status: "not_found", deploymentId };
				},
			},
			updateVerificationChecklist: { mutate: updateChecklistMutateMock },
		},
	}),
}));

// 文档始终可见：稳定 30s 心跳的可见性判定，剔除 jsdom visibility 差异这一变量（心跳本身不在此测试推进）。
vi.mock("@/hooks/use-document-visibility", () => ({
	useDocumentVisibility: () => true,
}));

const showAppToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "task-1";
const CHECKLIST_ITEM_ID = "item-1";
const SECOND_CHECKLIST_ITEM_ID = "item-2";

function makeGuidedManualChecklistItem(checked: boolean): RuntimePostDeployVerificationTask["checklist"][number] {
	return {
		id: CHECKLIST_ITEM_ID,
		label: "人工核对：登录后跳转到看板",
		checked,
		source: "authored",
		kind: "guided_manual",
		guidance: null,
		script: null,
		run: null,
		cleanup: null,
	};
}

function makeTask(checked: boolean): RuntimePostDeployVerificationTask {
	return createPostDeployVerificationTaskReadModelTestFixture({
		taskId: TASK_ID,
		checklist: [makeGuidedManualChecklistItem(checked)],
	});
}

function makeTaskWithTwoChecklistItems(
	firstChecked: boolean,
	secondChecked: boolean,
): RuntimePostDeployVerificationTask {
	return {
		...makeTask(firstChecked),
		checklist: [
			makeGuidedManualChecklistItem(firstChecked),
			{ ...makeGuidedManualChecklistItem(secondChecked), id: SECOND_CHECKLIST_ITEM_ID, label: "人工核对：退出登录" },
		],
	};
}

function makeGroup(checked: boolean): RuntimePostDeployVerificationDeploymentGroup {
	return {
		deploymentId: DEPLOYMENT_ID,
		workspaceId: "workspace-1",
		deployedSourceCommit: "abcdef1",
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-07-18T10:00:00.000Z",
		foldedAtIso: null,
		tasks: [makeTask(checked)],
	};
}

function makeVerificationStateResponse(checked: boolean): GetVerificationStateResponse {
	return { deploymentGroups: [makeGroup(checked)], activeDeploymentId: DEPLOYMENT_ID };
}

// 第二个 workspace 的部署 id：用它构造 workspace-b 的快照，使「B 的首帧是否被应用」可通过 activeGroup.deploymentId 明确区分。
const WORKSPACE_B_DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";

function makeVerificationStateResponseForDeployment(
	deploymentId: string,
	checked: boolean,
): GetVerificationStateResponse {
	return { deploymentGroups: [{ ...makeGroup(checked), deploymentId }], activeDeploymentId: deploymentId };
}

interface HookSnapshot {
	setCollapsed: ReturnType<typeof usePostDeployVerification>["setCollapsed"];
	addCustomChecklistItem: ReturnType<typeof usePostDeployVerification>["addCustomChecklistItem"];
	setDeploymentGroupExpanded: ReturnType<typeof usePostDeployVerification>["setDeploymentGroupExpanded"];
	deploymentGroupDetailsErrors: ReturnType<typeof usePostDeployVerification>["deploymentGroupDetailsErrors"];
	refreshAndReadActiveGroup: ReturnType<typeof usePostDeployVerification>["refreshAndReadActiveGroup"];
	entryNavigationReadModelRequest: ReturnType<typeof usePostDeployVerification>["entryNavigationReadModelRequest"];
	loadError: string | null;
	pendingVerificationTaskCount: number | null;
	refresh: ReturnType<typeof usePostDeployVerification>["refresh"];
	toggleChecklistItem: ReturnType<typeof usePostDeployVerification>["toggleChecklistItem"];
	activeGroup: ReturnType<typeof usePostDeployVerification>["activeGroup"];
}

function HookHarness({
	workspaceId,
	onSnapshot,
}: {
	workspaceId: string;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const verification = usePostDeployVerification(workspaceId);
	useEffect(() => {
		onSnapshot({
			setCollapsed: verification.setCollapsed,
			addCustomChecklistItem: verification.addCustomChecklistItem,
			setDeploymentGroupExpanded: verification.setDeploymentGroupExpanded,
			deploymentGroupDetailsErrors: verification.deploymentGroupDetailsErrors,
			refreshAndReadActiveGroup: verification.refreshAndReadActiveGroup,
			entryNavigationReadModelRequest: verification.entryNavigationReadModelRequest,
			loadError: verification.loadError,
			pendingVerificationTaskCount: verification.pendingVerificationTaskCount,
			refresh: verification.refresh,
			toggleChecklistItem: verification.toggleChecklistItem,
			activeGroup: verification.activeGroup,
		});
	}, [
		onSnapshot,
		verification.setCollapsed,
		verification.addCustomChecklistItem,
		verification.setDeploymentGroupExpanded,
		verification.deploymentGroupDetailsErrors,
		verification.refreshAndReadActiveGroup,
		verification.entryNavigationReadModelRequest,
		verification.loadError,
		verification.refresh,
		verification.toggleChecklistItem,
		verification.activeGroup,
		verification.pendingVerificationTaskCount,
	]);
	return null;
}

// 在 act 边界内推进 microtask，让 resolve 后的 `await` 续体与其触发的 setState 完成提交。
async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
}

function currentCheckedState(snapshot: HookSnapshot | null): boolean | undefined {
	return snapshot?.activeGroup?.tasks[0]?.checklist[0]?.checked;
}

describe("usePostDeployVerification —— 过期轮询覆盖守卫", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.removeItem("kanban.post-deploy-verification-collapsed");
		requestedDetailDeploymentIds.length = 0;
		failedDetailDeploymentIds.clear();
		detailFixtureByDeploymentId.clear();
		pendingVerificationStateQueryDeferreds.length = 0;
		pendingUpdateChecklistMutateDeferreds.length = 0;
		getVerificationStateQueryMock.mockClear();
		updateChecklistMutateMock.mockClear();
		showAppToastMock.mockClear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function mountAndEstablishBaseline(
		initialWorkspaceId = "workspace-a",
		baselineTask = makeTask(false),
	): Promise<{
		getSnapshot: () => HookSnapshot | null;
		rerenderWithWorkspaceId: (nextWorkspaceId: string) => Promise<void>;
	}> {
		let latestSnapshot: HookSnapshot | null = null;
		// 稳定的 onSnapshot 引用:跨 rerender 复用同一函数,避免 harness 的 effect 因 onSnapshot 变化而多余重跑。
		const handleSnapshot = (snapshot: HookSnapshot): void => {
			latestSnapshot = snapshot;
		};
		await act(async () => {
			root.render(<HookHarness workspaceId={initialWorkspaceId} onSnapshot={handleSnapshot} />);
		});
		// 挂载时 workspace 切换 effect 已触发首次 refresh（query #0）；resolve 它建立 checked=false 基线。
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(1);
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 0).resolve({
				deploymentGroups: [{ ...makeGroup(false), tasks: [baselineTask] }],
				activeDeploymentId: DEPLOYMENT_ID,
			});
			await flushMicrotasks();
		});
		expect(currentCheckedState(latestSnapshot)).toBe(false);
		return {
			getSnapshot: () => latestSnapshot,
			// 同一 root 上以新 workspaceId 重渲染同一 harness（保持 hook 实例、模拟 App.tsx 单实例切项目）。
			rerenderWithWorkspaceId: async (nextWorkspaceId: string) => {
				await act(async () => {
					root.render(<HookHarness workspaceId={nextWorkspaceId} onSnapshot={handleSnapshot} />);
					await flushMicrotasks();
				});
			},
		};
	}

	it("历史详情失败仍应用概览与活跃组，定位失败不冒充已清理", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline();
		failedDetailDeploymentIds.add(WORKSPACE_B_DEPLOYMENT_ID);
		const response = {
			deploymentGroups: [
				makeGroup(false),
				{ ...makeGroup(false), deploymentId: WORKSPACE_B_DEPLOYMENT_ID, foldedAtIso: "2026-07-19T10:00:00Z" },
			],
			activeDeploymentId: DEPLOYMENT_ID,
		};
		await act(async () => {
			getSnapshot()?.setDeploymentGroupExpanded?.(WORKSPACE_B_DEPLOYMENT_ID, true);
		});
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve(response);
			await flushMicrotasks();
		});
		expect(getSnapshot()?.loadError).toBeNull();
		expect(getSnapshot()?.pendingVerificationTaskCount).toBe(1);
		expect(getSnapshot()?.deploymentGroupDetailsErrors?.[WORKSPACE_B_DEPLOYMENT_ID]).toContain("暂不可用");
		let navigationResult: Promise<unknown> | undefined;
		await act(async () => {
			navigationResult = getSnapshot()
				?.refreshAndReadActiveGroup({
					workspaceId: "workspace-a",
					requestId: 100,
					deploymentId: WORKSPACE_B_DEPLOYMENT_ID,
				})
				.catch((error) => error);
		});
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 2).resolve(response);
			await flushMicrotasks();
		});
		expect(await navigationResult).toBeInstanceOf(Error);
		expect(getSnapshot()?.entryNavigationReadModelRequest).toBeNull();
		expect(getSnapshot()?.loadError).toBeNull();
		let activeResult: Promise<unknown> | undefined;
		await act(async () => {
			activeResult = getSnapshot()?.refreshAndReadActiveGroup();
		});
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 3).resolve(response);
			await flushMicrotasks();
		});
		expect(await activeResult).toMatchObject({ deploymentId: DEPLOYMENT_ID });
		await act(async () => {
			getSnapshot()?.setCollapsed(true);
		});
		const previousDetailReadCount = requestedDetailDeploymentIds.length;
		await act(async () => {
			getSnapshot()?.refresh();
		});
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 4).resolve(response);
			await flushMicrotasks();
		});
		expect(requestedDetailDeploymentIds).toHaveLength(previousDetailReadCount);
	});

	it("离开项目再返回时，旧代自定义项写入不能覆盖新快照", async () => {
		const { getSnapshot, rerenderWithWorkspaceId } = await mountAndEstablishBaseline();
		let writing: Promise<void> | undefined;
		await act(async () => {
			writing = getSnapshot()?.addCustomChecklistItem(DEPLOYMENT_ID, TASK_ID, "旧代自定义项");
		});
		await rerenderWithWorkspaceId("workspace-b");
		await rerenderWithWorkspaceId("workspace-a");
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 2).resolve(
				makeVerificationStateResponse(false),
			);
			await flushMicrotasks();
		});
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).resolve({ ok: true, task: makeTask(true) });
			await writing;
		});
		expect(currentCheckedState(getSnapshot())).toBe(false);
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("定位前的在途读取不能为新请求补证，逆序返回也不能覆盖新快照", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline();
		const navigationRequest = { workspaceId: "workspace-a", requestId: 1 };
		act(() => getSnapshot()?.refresh());
		act(() => {
			void getSnapshot()
				?.refreshAndReadActiveGroup(navigationRequest)
				.catch(() => {});
		});
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve(
				makeVerificationStateResponse(false),
			);
			await flushMicrotasks();
		});
		expect(getSnapshot()?.entryNavigationReadModelRequest).toBeNull();
		act(() => getSnapshot()?.refresh());
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 3).resolve(makeVerificationStateResponse(true));
			await flushMicrotasks();
		});
		expect(getSnapshot()?.entryNavigationReadModelRequest).toEqual(navigationRequest);
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 2).resolve({
				deploymentGroups: [],
				activeDeploymentId: null,
			});
			await flushMicrotasks();
		});
		expect(currentCheckedState(getSnapshot())).toBe(true);
		expect(getSnapshot()?.entryNavigationReadModelRequest).toEqual(navigationRequest);
		expect(getSnapshot()?.loadError).toBeNull();
	});

	it("读取失败后保留定位归属，后续常规刷新成功可自动补证", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline();
		const navigationRequest = { workspaceId: "workspace-a", requestId: 2 };
		act(() => {
			void getSnapshot()
				?.refreshAndReadActiveGroup(navigationRequest)
				.catch(() => {});
		});
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).reject(new Error("网络中断"));
			await flushMicrotasks();
		});
		expect(getSnapshot()?.loadError).toBe("网络中断");
		expect(getSnapshot()?.entryNavigationReadModelRequest).toBeNull();
		act(() => getSnapshot()?.refresh());
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 2).resolve(makeVerificationStateResponse(true));
			await flushMicrotasks();
		});
		expect(getSnapshot()?.loadError).toBeNull();
		expect(getSnapshot()?.entryNavigationReadModelRequest).toEqual(navigationRequest);
	});

	it("被本地写入丢弃的定位快照不能补证，写入后的刷新能够恢复", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline();
		const navigationRequest = { workspaceId: "workspace-a", requestId: 3 };
		act(() => {
			void getSnapshot()
				?.refreshAndReadActiveGroup(navigationRequest)
				.catch(() => {});
		});
		act(() => {
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
		});
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).resolve({ ok: true, task: makeTask(true) });
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve({
				deploymentGroups: [],
				activeDeploymentId: null,
			});
			await flushMicrotasks();
		});
		expect(getSnapshot()?.entryNavigationReadModelRequest).toBeNull();
		expect(currentCheckedState(getSnapshot())).toBe(true);
		act(() => getSnapshot()?.refresh());
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 2).resolve(makeVerificationStateResponse(true));
			await flushMicrotasks();
		});
		expect(getSnapshot()?.entryNavigationReadModelRequest).toEqual(navigationRequest);
	});

	it("旧定位请求响应不能补证新请求，跨项目再返回也不能接受旧代际响应", async () => {
		const { getSnapshot, rerenderWithWorkspaceId } = await mountAndEstablishBaseline();
		act(() => {
			void getSnapshot()
				?.refreshAndReadActiveGroup({ workspaceId: "workspace-a", requestId: 4 })
				.catch(() => {});
		});
		act(() => {
			void getSnapshot()
				?.refreshAndReadActiveGroup({ workspaceId: "workspace-a", requestId: 5 })
				.catch(() => {});
		});
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve(
				makeVerificationStateResponse(false),
			);
			await flushMicrotasks();
		});
		expect(getSnapshot()?.entryNavigationReadModelRequest).toBeNull();
		await rerenderWithWorkspaceId("workspace-b");
		await rerenderWithWorkspaceId("workspace-a");
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 2).resolve(makeVerificationStateResponse(true));
			await flushMicrotasks();
		});
		expect(getSnapshot()?.activeGroup).toBeNull();
		expect(getSnapshot()?.entryNavigationReadModelRequest).toBeNull();
		expect(getSnapshot()?.loadError).toBeNull();
	});

	it("手动勾选后，先前发起、点击前快照的过期轮询响应不得把勾选弹回未勾选", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline();

		// 1. 发起一次轮询（query #1）：模拟「点击前快照」在飞——其服务端数据仍是 checked=false，稍后才返回。
		await act(async () => {
			getSnapshot()?.refresh();
			await flushMicrotasks();
		});
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(2);

		// 2. 用户点击勾选：乐观置 true，写入 mutation（mutate #0）在飞。
		let togglePromise: Promise<void> | undefined;
		await act(async () => {
			togglePromise = getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
			await Promise.resolve(); // 让同步的乐观 setState + 在飞计数自增提交
		});
		expect(currentCheckedState(getSnapshot())).toBe(true);
		expect(pendingUpdateChecklistMutateDeferreds).toHaveLength(1);

		// 3. 写入成功返回 checked=true 的 task：本地经 replaceTask 落定为 true，写入完成序号自增。
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).resolve({ ok: true, task: makeTask(true) });
			await flushMicrotasks();
		});
		await togglePromise;
		expect(currentCheckedState(getSnapshot())).toBe(true);

		// 4. 那个过期轮询此刻才到达，携带点击前的 checked=false 整表快照。
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve(
				makeVerificationStateResponse(false),
			);
			await flushMicrotasks();
		});

		// 断言：守卫丢弃了过期快照，勾选稳定留存为 true（修复前此处会被覆盖回 false）。
		expect(currentCheckedState(getSnapshot())).toBe(true);
	});

	it.each([0, 1])("不同核对项并发勾选，回包 %i 先到也不能覆盖另一项", async (firstResponseIndex) => {
		const { getSnapshot } = await mountAndEstablishBaseline(
			"workspace-a",
			makeTaskWithTwoChecklistItems(false, false),
		);
		await act(async () => {
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, SECOND_CHECKLIST_ITEM_ID, true);
			await flushMicrotasks();
		});
		const checkedStates = () => getSnapshot()?.activeGroup?.tasks[0]?.checklist.map((item) => item.checked);
		expect(checkedStates()).toEqual([true, true]);
		for (const responseIndex of [firstResponseIndex, 1 - firstResponseIndex]) {
			await act(async () => {
				requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, responseIndex).resolve({
					ok: true,
					task: makeTaskWithTwoChecklistItems(true, responseIndex === 1),
				});
				await flushMicrotasks();
			});
			expect(checkedStates()).toEqual([true, true]);
		}
	});

	it("同一核对项连续勾选和取消，旧成功回包不能覆盖较新成功回包", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline();
		await act(async () => {
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, false);
			await flushMicrotasks();
		});
		expect(currentCheckedState(getSnapshot())).toBe(false);
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 1).resolve({ ok: true, task: makeTask(false) });
			await flushMicrotasks();
		});
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).resolve({ ok: true, task: makeTask(true) });
			await flushMicrotasks();
		});
		expect(currentCheckedState(getSnapshot())).toBe(false);
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(1);
	});

	it("不同核对项一项失败时只回退失败项，等其他写入完成后再对账", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline(
			"workspace-a",
			makeTaskWithTwoChecklistItems(false, false),
		);
		await act(async () => {
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, SECOND_CHECKLIST_ITEM_ID, true);
			await flushMicrotasks();
		});
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).resolve({
				ok: false,
				task: makeTaskWithTwoChecklistItems(false, false),
				error: "第一项保存失败",
			});
			await flushMicrotasks();
		});
		expect(getSnapshot()?.activeGroup?.tasks[0]?.checklist.map((item) => item.checked)).toEqual([false, true]);
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(1);
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 1).resolve({
				ok: true,
				task: makeTaskWithTwoChecklistItems(false, true),
			});
			await flushMicrotasks();
		});
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(2);
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve({
				deploymentGroups: [{ ...makeGroup(false), tasks: [makeTaskWithTwoChecklistItems(false, true)] }],
				activeDeploymentId: DEPLOYMENT_ID,
			});
			await flushMicrotasks();
		});
		expect(getSnapshot()?.activeGroup?.tasks[0]?.checklist.map((item) => item.checked)).toEqual([false, true]);
		expect(showAppToastMock).toHaveBeenCalledWith({ intent: "danger", message: "第一项保存失败" });
	});

	it.each(["拒绝回包", "网络异常"])("同一项连续写入都失败时，%s 后自动读取实际状态", async (failureKind) => {
		const { getSnapshot } = await mountAndEstablishBaseline();
		await act(async () => {
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, false);
			await flushMicrotasks();
		});
		await act(async () => {
			const latestWrite = requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 1);
			if (failureKind === "拒绝回包") latestWrite.resolve({ ok: false, task: makeTask(false), error: "保存失败" });
			else latestWrite.reject(new Error("网络中断"));
			await flushMicrotasks();
		});
		if (failureKind === "拒绝回包") expect(currentCheckedState(getSnapshot())).toBe(false);
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(1);
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).reject(new Error("旧写入失败"));
			await flushMicrotasks();
		});
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(2);
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve(
				makeVerificationStateResponse(false),
			);
			await flushMicrotasks();
		});
		expect(currentCheckedState(getSnapshot())).toBe(false);
		expect(showAppToastMock).toHaveBeenCalledTimes(1);
	});

	it("离开项目后返回时，旧代勾选失败不能触发新代回滚或额外对账", async () => {
		const { getSnapshot, rerenderWithWorkspaceId } = await mountAndEstablishBaseline();
		await act(async () => {
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
			await flushMicrotasks();
		});
		await rerenderWithWorkspaceId("workspace-b");
		await rerenderWithWorkspaceId("workspace-a");
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 2).resolve(makeVerificationStateResponse(true));
			await flushMicrotasks();
		});
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).reject(new Error("旧项目写入失败"));
			await flushMicrotasks();
		});
		expect(currentCheckedState(getSnapshot())).toBe(true);
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(3);
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("无并发写入时，正常轮询快照应照常应用（守卫不误伤常规刷新）", async () => {
		const { getSnapshot } = await mountAndEstablishBaseline();

		// 无任何本地写入在飞：发起轮询并让其返回 checked=true 的服务端快照，应被正常应用。
		await act(async () => {
			getSnapshot()?.refresh();
			await flushMicrotasks();
		});
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(2);

		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve(makeVerificationStateResponse(true));
			await flushMicrotasks();
		});

		expect(currentCheckedState(getSnapshot())).toBe(true);
	});

	it("workspace 切换：旧 workspace 尚在飞的写入不得丢弃新 workspace 的首帧快照", async () => {
		// App.tsx 只持有唯一一份 usePostDeployVerification 实例,workspaceId 仅作参数变化、hook 不随 workspace remount,
		// 故写入追踪 ref 跨 workspace 切换存活。若不按 workspace 隔离,workspace A 的长时写入(如 runVerificationItem)在飞时切到 B,
		// B 的首帧 refresh 会被「A 的写入仍在飞」误命中过期守卫而丢弃 → B 面板空白。本用例覆盖该回归。
		const { getSnapshot, rerenderWithWorkspaceId } = await mountAndEstablishBaseline("workspace-a");

		// 1. 在 workspace-a 发起一个「长时」写入:其 mutate 挂起不 resolve,使 inFlightVerificationWriteCountRef 保持 >0。
		await act(async () => {
			void getSnapshot()?.toggleChecklistItem(DEPLOYMENT_ID, TASK_ID, CHECKLIST_ITEM_ID, true);
			await Promise.resolve(); // 让同步的乐观 setState + 在飞计数自增提交
		});
		expect(pendingUpdateChecklistMutateDeferreds).toHaveLength(1); // A 的写入在飞、未 resolve

		// 2. 切换到 workspace-b:切换 effect 自增写入代际并把在飞计数归零,随后 refresh() 拉取 B 的首帧(query #1)。
		await rerenderWithWorkspaceId("workspace-b");
		expect(pendingVerificationStateQueryDeferreds).toHaveLength(2);

		// 3. B 的首帧快照到达(带 B 自己的 deploymentId)。
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 1).resolve(
				makeVerificationStateResponseForDeployment(WORKSPACE_B_DEPLOYMENT_ID, true),
			);
			await flushMicrotasks();
		});

		// 断言:B 的合法首帧被应用,而非被过期守卫误当作「有写入在飞」丢弃。
		// 修复前:A 的写入仍在飞使 count>0(切换不归零),B 的首帧被丢弃 → activeGroup 保持 null。
		expect(getSnapshot()?.activeGroup?.deploymentId).toBe(WORKSPACE_B_DEPLOYMENT_ID);

		// 4. 旧 workspace(A)的在飞写入此刻才 settle:因写入代际已变,trackVerificationWrite 的 finally 跳过回收,
		//    既不把 B 的 count 减成负值、也不推进 seq,故不影响 B 已应用的快照。
		await act(async () => {
			requireDeferredAtIndex(pendingUpdateChecklistMutateDeferreds, 0).resolve({ ok: true, task: makeTask(true) });
			await flushMicrotasks();
		});
		expect(getSnapshot()?.activeGroup?.deploymentId).toBe(WORKSPACE_B_DEPLOYMENT_ID);
	});
	it.each([
		{ name: "无部署记录", response: { deploymentGroups: [], activeDeploymentId: null }, expected: null },
		{
			name: "仅历史记录",
			response: {
				deploymentGroups: [{ ...makeGroup(false), foldedAtIso: "2026-07-19T00:00:00.000Z" }],
				activeDeploymentId: null,
			},
			expected: 0,
		},
		{ name: "当前待核对任务", response: makeVerificationStateResponse(false), expected: 1 },
		{
			name: "已核对及已移除任务不计数",
			response: {
				deploymentGroups: [
					{
						...makeGroup(false),
						tasks: [
							{ ...makeTask(false), verifiedAt: "2026-07-19T00:00:00.000Z" },
							{ ...makeTask(false), taskId: "removed-task", droppedReason: "task_deleted" as const },
						],
					},
				],
				activeDeploymentId: DEPLOYMENT_ID,
			},
			expected: 0,
		},
	])("顶栏唯一入口的数量与可见性：$name", async ({ response, expected }) => {
		let observedPendingTaskCount: number | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					workspaceId="workspace-a"
					onSnapshot={(snapshot) => {
						observedPendingTaskCount = snapshot.pendingVerificationTaskCount;
					}}
				/>,
			);
		});
		expect(observedPendingTaskCount).toBeNull();
		await act(async () => {
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 0).resolve(response);
			await flushMicrotasks();
		});
		expect(observedPendingTaskCount).toBe(expected);
	});
});
