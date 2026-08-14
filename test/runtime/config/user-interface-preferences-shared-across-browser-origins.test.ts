import { describe, expect, it } from "vitest";
import {
	areUserInterfacePreferencesSharedAcrossBrowserOriginsEqual,
	hasNoUserInterfacePreferenceSharedAcrossBrowserOriginsSet,
	mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate,
	normalizeUserInterfacePreferencesSharedAcrossBrowserOrigins,
	USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
} from "../../../src/config/user-interface-preferences-shared-across-browser-origins";
import type { RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins } from "../../../src/core/api-contract";

describe("跨浏览器 origin 共享的界面偏好", () => {
	describe("规范化", () => {
		it("非对象输入降级成「一条都没有」", () => {
			for (const input of [undefined, null, 42, "x", []]) {
				expect(normalizeUserInterfacePreferencesSharedAcrossBrowserOrigins(input)).toEqual(
					USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				);
			}
		});

		it("单个坏字段只把它自己降级成 null，其余字段照常读出", () => {
			const normalized = normalizeUserInterfacePreferencesSharedAcrossBrowserOrigins({
				newTaskAutoReviewEnabled: "not-a-boolean",
				newTaskAutoReviewMode: "pr",
				taskCreateDialogPrimaryStartAction: "start_and_open",
				workspaceOpenTargetPreferredApplicationId: "zed",
			});

			expect(normalized.newTaskAutoReviewEnabled).toBeNull();
			expect(normalized.newTaskAutoReviewMode).toBe("pr");
			expect(normalized.taskCreateDialogPrimaryStartAction).toBe("start_and_open");
			expect(normalized.workspaceOpenTargetPreferredApplicationId).toBe("zed");
		});

		it("沿用契约的 autoReviewMode 兼容映射：历史值 move_to_trash 读成 commit", () => {
			expect(
				normalizeUserInterfacePreferencesSharedAcrossBrowserOrigins({ newTaskAutoReviewMode: "move_to_trash" })
					.newTaskAutoReviewMode,
			).toBe("commit");
		});

		it("字典逐条丢弃坏值而不是整份作废", () => {
			const normalized = normalizeUserInterfacePreferencesSharedAcrossBrowserOrigins({
				projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "2": 7, "3": "", "4": "delta" },
			});

			expect(normalized.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({ "1": "alpha", "4": "delta" });
		});

		it("false 不是坏值——布尔偏好可以被显式设成 false", () => {
			expect(
				normalizeUserInterfacePreferencesSharedAcrossBrowserOrigins({ newTaskAutoReviewEnabled: false })
					.newTaskAutoReviewEnabled,
			).toBe(false);
		});
	});

	describe("是否一条都没有", () => {
		it("全 null + 全空字典为真", () => {
			expect(
				hasNoUserInterfacePreferenceSharedAcrossBrowserOriginsSet(
					USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				),
			).toBe(true);
		});

		it("显式的 false 也算「有偏好」——它与 null 不是一回事", () => {
			expect(
				hasNoUserInterfacePreferenceSharedAcrossBrowserOriginsSet({
					...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
					newTaskAutoReviewEnabled: false,
				}),
			).toBe(false);
		});

		it("只有字典里有一条也算「有偏好」", () => {
			expect(
				hasNoUserInterfacePreferenceSharedAcrossBrowserOriginsSet({
					...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
					projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
				}),
			).toBe(false);
		});
	});

	describe("部分更新合并", () => {
		const current = {
			...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
			newTaskAutoReviewEnabled: true,
			newTaskAutoReviewMode: "pr" as const,
			workspaceOpenTargetPreferredApplicationId: "zed",
			projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
		};

		it("字段缺席时保留当前值——漏传绝不能顺手清掉偏好", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(current, {
				newTaskAutoReviewEnabled: false,
			});

			expect(merged.newTaskAutoReviewEnabled).toBe(false);
			expect(merged.newTaskAutoReviewMode).toBe("pr");
			expect(merged.workspaceOpenTargetPreferredApplicationId).toBe("zed");
			expect(merged.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({ "1": "alpha" });
		});

		it("显式 null 把字段清回「服务端无值」", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(current, {
				workspaceOpenTargetPreferredApplicationId: null,
			});

			expect(merged.workspaceOpenTargetPreferredApplicationId).toBeNull();
		});

		it("字典按整份替换，不与旧字典求并", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(current, {
				projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "beta" },
			});

			expect(merged.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({ "2": "beta" });
		});

		it("用户解除绑定：写回一份少了某个键的整份字典，那个键必须真的消失", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(
				{
					...current,
					projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "2": "beta" },
				},
				{ projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "beta" } },
			);

			expect(merged.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({ "2": "beta" });
		});

		it("updates 为 undefined 时原样返回", () => {
			expect(mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(current, undefined)).toBe(current);
		});

		it("updates 与迁移采纳都缺席时原样返回", () => {
			expect(mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(current, undefined, undefined)).toBe(
				current,
			);
		});
	});

	describe("迁移采纳（与整份替换是两种意图）", () => {
		const serverWithOneSlot = {
			...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
			projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
		};

		it("只补服务端没有的键，同名键服务端胜出", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(serverWithOneSlot, undefined, {
				projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "browser-alpha", "5": "epsilon" },
			});

			expect(merged.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({ "1": "alpha", "5": "epsilon" });
		});

		it("两个 origin 各基于同一份空快照迁移，两侧条目都保留——本条正是「后到者整份覆盖」的回归", () => {
			const afterFirstOrigin = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(
				USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				undefined,
				{ projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" } },
			);
			// 第二个 origin 的载荷同样算自那份**空**快照——它并不知道第一个 origin 刚写过。
			const afterSecondOrigin = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(
				afterFirstOrigin,
				undefined,
				{ projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "beta" } },
			);

			expect(afterSecondOrigin.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({
				"1": "alpha",
				"2": "beta",
			});
		});

		it("到达顺序不影响结果", () => {
			const mergeFromNothing = (
				entries: Record<string, string>,
				previous: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins = { ...serverWithOneSlot },
			) =>
				mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(previous, undefined, {
					taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: entries,
				});
			const originA = { '["global","claude"]': "opus" };
			const originB = { '["global","codex"]': "gpt" };

			const aThenB = mergeFromNothing(originB, mergeFromNothing(originA));
			const bThenA = mergeFromNothing(originA, mergeFromNothing(originB));

			expect(aThenB.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey).toEqual(
				bThenA.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
			);
		});

		it("采纳项里的坏值逐条丢弃，不连累其余条目", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(
				USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				undefined,
				{
					projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "2": "" } as Record<string, string>,
				},
			);

			expect(merged.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({ "1": "alpha" });
		});

		it("同一次请求里整份替换先生效、迁移采纳后补——删除不会被自己这次的采纳撤销", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(
				{
					...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
					projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "2": "beta" },
				},
				{ projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "beta" } },
				{ projectNumericSlotGroupAssignmentsBySlotNumber: { "5": "epsilon" } },
			);

			expect(merged.projectNumericSlotGroupAssignmentsBySlotNumber).toEqual({ "2": "beta", "5": "epsilon" });
		});

		it("只带其中一个字典字段时，另一个字典原样不动", () => {
			const merged = mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(
				{
					...serverWithOneSlot,
					taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: { '["global","claude"]': "opus" },
				},
				undefined,
				{ projectNumericSlotGroupAssignmentsBySlotNumber: { "5": "epsilon" } },
			);

			expect(merged.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey).toEqual({
				'["global","claude"]': "opus",
			});
		});
	});

	describe("相等比较", () => {
		it("字典键序不同但内容相同视为相等", () => {
			const left = {
				...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "2": "beta" },
			};
			const right = {
				...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "beta", "1": "alpha" },
			};

			expect(areUserInterfacePreferencesSharedAcrossBrowserOriginsEqual(left, right)).toBe(true);
		});

		it("null 与 false 不相等——否则「尚未设定」会被当成「设成了关」", () => {
			expect(
				areUserInterfacePreferencesSharedAcrossBrowserOriginsEqual(
					USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
					{
						...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
						newTaskAutoReviewEnabled: false,
					},
				),
			).toBe(false);
		});

		it("字典少一条即不相等", () => {
			expect(
				areUserInterfacePreferencesSharedAcrossBrowserOriginsEqual(
					{
						...USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
						projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
					},
					USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
				),
			).toBe(false);
		});
	});
});
