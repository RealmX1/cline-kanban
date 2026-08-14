import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeConfigResponse,
	RuntimeConfigSaveRequest,
	RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
} from "@/runtime/types";

const fetchRuntimeConfigMock = vi.fn();
const saveRuntimeConfigMock = vi.fn();

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchRuntimeConfig: (...args: unknown[]) => fetchRuntimeConfigMock(...args),
	saveRuntimeConfig: (...args: unknown[]) => saveRuntimeConfigMock(...args),
}));

const {
	readAllUserInterfacePreferenceValuesFromBrowserLocalStorage,
	readEffectiveUserInterfacePreferenceValue,
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests,
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins,
	startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins,
	USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
} = await import("@/runtime/user-interface-preferences-shared-across-browser-origins-store");

function buildConfigResponseWithPreferences(
	preferences: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
): RuntimeConfigResponse {
	return { userInterfacePreferencesSharedAcrossBrowserOrigins: preferences } as RuntimeConfigResponse;
}

describe("跨浏览器 origin 共享的界面偏好 store", () => {
	// 假服务端保有状态：save 必须把这次更新**合并**进现有偏好再回给调用方，与真实 updateRuntimeConfig 一致。
	// 若让 save 一律回「一条都没有」，播种成功后紧接着的那次回写就会把服务端刚读到的值抹平——那是 mock
	// 在撒谎，不是被测代码有问题。
	let preferencesHeldByFakeServer: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins;

	beforeEach(() => {
		localStorage.clear();
		fetchRuntimeConfigMock.mockReset();
		saveRuntimeConfigMock.mockReset();
		preferencesHeldByFakeServer = { ...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET };
		fetchRuntimeConfigMock.mockImplementation(async () =>
			buildConfigResponseWithPreferences(preferencesHeldByFakeServer),
		);
		saveRuntimeConfigMock.mockImplementation(async (_workspaceId: unknown, nextConfig: RuntimeConfigSaveRequest) => {
			const afterWholesaleReplace: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins = {
				...preferencesHeldByFakeServer,
				...nextConfig.userInterfacePreferencesSharedAcrossBrowserOrigins,
			};
			// 迁移采纳意图在服务端是**逐键并入**（服务端已有的键胜出），假服务端必须照做，
			// 否则用例会掩盖掉「整份覆盖丢条目」这件事本身。
			const entriesToAdopt = nextConfig.userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage;
			preferencesHeldByFakeServer = {
				...afterWholesaleReplace,
				taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {
					...entriesToAdopt?.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
					...afterWholesaleReplace.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
				},
				projectNumericSlotGroupAssignmentsBySlotNumber: {
					...entriesToAdopt?.projectNumericSlotGroupAssignmentsBySlotNumber,
					...afterWholesaleReplace.projectNumericSlotGroupAssignmentsBySlotNumber,
				},
			};
			return buildConfigResponseWithPreferences(preferencesHeldByFakeServer);
		});
		resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
	});

	afterEach(() => {
		resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
	});

	describe("本地镜像沿用升级前的编码——否则读不出用户已经攒下的那份", () => {
		it("布尔按 String(value) 存，与 useBooleanLocalStorageValue 一致", () => {
			localStorage.setItem("kanban.task-auto-review-enabled", "true");
			expect(readEffectiveUserInterfacePreferenceValue("newTaskAutoReviewEnabled")).toBe(true);

			localStorage.setItem("kanban.task-auto-review-enabled", "false");
			expect(readEffectiveUserInterfacePreferenceValue("newTaskAutoReviewEnabled")).toBe(false);
		});

		it("枚举存裸串，与 useRawLocalStorageValue 一致", () => {
			localStorage.setItem("kanban.task-auto-review-mode", "pr");
			expect(readEffectiveUserInterfacePreferenceValue("newTaskAutoReviewMode")).toBe("pr");
		});

		it("终端 agent 模型记忆存的是 { selections: {...} } 包装，不是裸字典", () => {
			localStorage.setItem(
				"kanban.task-create-terminal-agent-model-selections.v1",
				JSON.stringify({ selections: { '["global","claude"]': "opus" } }),
			);

			expect(
				readEffectiveUserInterfacePreferenceValue("taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey"),
			).toEqual({ '["global","claude"]': "opus" });
		});

		it("数字槽位编组存的是裸字典", () => {
			localStorage.setItem("kanban.project-numeric-slot-group-assignments.v1", JSON.stringify({ "3": "alpha" }));

			expect(readEffectiveUserInterfacePreferenceValue("projectNumericSlotGroupAssignmentsBySlotNumber")).toEqual({
				"3": "alpha",
			});
		});

		it("坏值读成 null 而不是抛，界面照常起来", () => {
			localStorage.setItem("kanban.task-auto-review-mode", "not-a-mode");
			expect(readEffectiveUserInterfacePreferenceValue("newTaskAutoReviewMode")).toBeNull();
		});
	});

	describe("取值优先级", () => {
		it("服务端还没读到时用本地镜像", () => {
			localStorage.setItem("kanban.preferred-open-target", "zed");
			expect(readEffectiveUserInterfacePreferenceValue("workspaceOpenTargetPreferredApplicationId")).toBe("zed");
		});

		it("服务端有值时服务端赢", async () => {
			localStorage.setItem("kanban.preferred-open-target", "zed");
			preferencesHeldByFakeServer.workspaceOpenTargetPreferredApplicationId = "cursor";

			startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
			await vi.waitFor(() =>
				expect(readEffectiveUserInterfacePreferenceValue("workspaceOpenTargetPreferredApplicationId")).toBe(
					"cursor",
				),
			);
		});

		it("服务端该字段为 null 时仍回落本地镜像", async () => {
			localStorage.setItem("kanban.preferred-open-target", "zed");
			preferencesHeldByFakeServer.newTaskAutoReviewEnabled = true;

			startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
			await vi.waitFor(() =>
				expect(readEffectiveUserInterfacePreferenceValue("newTaskAutoReviewEnabled")).toBe(true),
			);
			expect(readEffectiveUserInterfacePreferenceValue("workspaceOpenTargetPreferredApplicationId")).toBe("zed");
		});
	});

	describe("写入", () => {
		it("先写本地镜像再发服务端：镜像在请求解决之前就已可读", () => {
			let resolveSave: ((value: RuntimeConfigResponse) => void) | null = null;
			saveRuntimeConfigMock.mockReturnValue(
				new Promise<RuntimeConfigResponse>((resolve) => {
					resolveSave = resolve;
				}),
			);

			saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ workspaceOpenTargetPreferredApplicationId: "zed" });

			expect(localStorage.getItem("kanban.preferred-open-target")).toBe("zed");
			expect(readEffectiveUserInterfacePreferenceValue("workspaceOpenTargetPreferredApplicationId")).toBe("zed");
			expect(resolveSave).not.toBeNull();
		});

		it("服务端写失败也不丢用户这次的选择——镜像还在，下次加载会重新播种", async () => {
			saveRuntimeConfigMock.mockRejectedValue(new Error("offline"));

			saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ newTaskAutoReviewMode: "pr" });
			await vi.waitFor(() => expect(saveRuntimeConfigMock).toHaveBeenCalled());

			expect(localStorage.getItem("kanban.task-auto-review-mode")).toBe("pr");
			expect(readEffectiveUserInterfacePreferenceValue("newTaskAutoReviewMode")).toBe("pr");
		});

		it("走全局作用域（workspaceId = null）——这些偏好落在全局 config.json 里，与当前项目无关", () => {
			saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ newTaskAutoReviewEnabled: true });

			expect(saveRuntimeConfigMock).toHaveBeenCalledWith(null, {
				userInterfacePreferencesSharedAcrossBrowserOrigins: { newTaskAutoReviewEnabled: true },
			});
		});
	});

	describe("加载时的合并迁移", () => {
		it("服务端一条都没有时把本地那份播种上去", async () => {
			localStorage.setItem("kanban.preferred-open-target", "zed");
			localStorage.setItem("kanban.task-auto-review-enabled", "true");

			startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();

			await vi.waitFor(() => expect(saveRuntimeConfigMock).toHaveBeenCalled());
			expect(saveRuntimeConfigMock).toHaveBeenCalledWith(null, {
				userInterfacePreferencesSharedAcrossBrowserOrigins: {
					newTaskAutoReviewEnabled: true,
					workspaceOpenTargetPreferredApplicationId: "zed",
				},
			});
		});

		it("字典走迁移采纳意图上传，不走整份替换那条路径", async () => {
			localStorage.setItem("kanban.project-numeric-slot-group-assignments.v1", JSON.stringify({ "1": "alpha" }));
			preferencesHeldByFakeServer.projectNumericSlotGroupAssignmentsBySlotNumber = { "2": "beta" };

			startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();

			await vi.waitFor(() => expect(saveRuntimeConfigMock).toHaveBeenCalled());
			expect(saveRuntimeConfigMock).toHaveBeenCalledWith(null, {
				userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage: {
					projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
				},
			});
			// 服务端并入后两侧条目都在，store 采纳的是响应那份而不是自己的乐观值。
			await vi.waitFor(() =>
				expect(readEffectiveUserInterfacePreferenceValue("projectNumericSlotGroupAssignmentsBySlotNumber")).toEqual(
					{ "1": "alpha", "2": "beta" },
				),
			);
		});

		it("用户主动写回一份少了某个键的整份字典时，删除必须真的生效", async () => {
			preferencesHeldByFakeServer.projectNumericSlotGroupAssignmentsBySlotNumber = { "1": "alpha", "2": "beta" };
			startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
			await vi.waitFor(() =>
				expect(readEffectiveUserInterfacePreferenceValue("projectNumericSlotGroupAssignmentsBySlotNumber")).toEqual(
					{ "1": "alpha", "2": "beta" },
				),
			);

			saveUserInterfacePreferencesSharedAcrossBrowserOrigins({
				projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
			});

			await vi.waitFor(() =>
				expect(readEffectiveUserInterfacePreferenceValue("projectNumericSlotGroupAssignmentsBySlotNumber")).toEqual(
					{ "1": "alpha" },
				),
			);
		});

		it("服务端已有同样的值时什么都不上传", async () => {
			localStorage.setItem("kanban.preferred-open-target", "zed");
			preferencesHeldByFakeServer.workspaceOpenTargetPreferredApplicationId = "zed";

			startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();

			await vi.waitFor(() => expect(fetchRuntimeConfigMock).toHaveBeenCalled());
			expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
		});

		it("读配置失败时保持用本地镜像，且允许下次重试", async () => {
			localStorage.setItem("kanban.preferred-open-target", "zed");
			fetchRuntimeConfigMock.mockRejectedValueOnce(new Error("offline"));

			startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
			await vi.waitFor(() => expect(fetchRuntimeConfigMock).toHaveBeenCalledTimes(1));
			expect(readEffectiveUserInterfacePreferenceValue("workspaceOpenTargetPreferredApplicationId")).toBe("zed");

			// 「允许重试」这个标志是在 catch 里复位的，而 catch 何时跑相对本用例是异步的。所以把发起动作
			// 也放进 waitFor 里反复尝试，而不是赌一次就能赶上——赌中与否取决于调度，那样的用例会偶发红。
			await vi.waitFor(() => {
				startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
				expect(fetchRuntimeConfigMock).toHaveBeenCalledTimes(2);
			});
		});
	});

	it("整份读取给出迁移决策要的六个字段，字典缺省为空对象", () => {
		expect(readAllUserInterfacePreferenceValuesFromBrowserLocalStorage()).toEqual({
			newTaskAutoReviewEnabled: null,
			newTaskAutoReviewMode: null,
			taskCreateDialogPrimaryStartAction: null,
			workspaceOpenTargetPreferredApplicationId: null,
			taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
			projectNumericSlotGroupAssignmentsBySlotNumber: {},
		});
	});
});
