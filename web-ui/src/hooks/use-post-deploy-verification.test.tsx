import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		deployment: {
			getPostDeployVerificationState: { query: getVerificationStateQueryMock },
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
	return {
		taskId: TASK_ID,
		columnIdAtMatch: "review",
		matchedCommits: [],
		inclusionReason: "commit_correlation",
		checklist: [makeGuidedManualChecklistItem(checked)],
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation: null,
		droppedReason: null,
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
			refresh: verification.refresh,
			toggleChecklistItem: verification.toggleChecklistItem,
			activeGroup: verification.activeGroup,
		});
	}, [onSnapshot, verification.refresh, verification.toggleChecklistItem, verification.activeGroup]);
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

	async function mountAndEstablishBaseline(initialWorkspaceId = "workspace-a"): Promise<{
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
			requireDeferredAtIndex(pendingVerificationStateQueryDeferreds, 0).resolve(
				makeVerificationStateResponse(false),
			);
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
});
