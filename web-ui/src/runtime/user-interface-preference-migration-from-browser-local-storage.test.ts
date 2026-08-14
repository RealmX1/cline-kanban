import { describe, expect, it } from "vitest";
import type { RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins } from "@/runtime/types";
import {
	decideUserInterfacePreferenceMigrationFromBrowserLocalStorage,
	type UserInterfacePreferenceValuesReadFromBrowserLocalStorage,
} from "@/runtime/user-interface-preference-migration-from-browser-local-storage";

const SERVER_WITH_NOTHING_SET: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins = {
	newTaskAutoReviewEnabled: null,
	newTaskAutoReviewMode: null,
	taskCreateDialogPrimaryStartAction: null,
	taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
	workspaceOpenTargetPreferredApplicationId: null,
	projectNumericSlotGroupAssignmentsBySlotNumber: {},
};

const BROWSER_WITH_NOTHING_SET: UserInterfacePreferenceValuesReadFromBrowserLocalStorage = {
	newTaskAutoReviewEnabled: null,
	newTaskAutoReviewMode: null,
	taskCreateDialogPrimaryStartAction: null,
	workspaceOpenTargetPreferredApplicationId: null,
	taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
	projectNumericSlotGroupAssignmentsBySlotNumber: {},
};

describe("界面偏好从浏览器 localStorage 合并进服务端", () => {
	it("两边都空时无事可做", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(
			SERVER_WITH_NOTHING_SET,
			BROWSER_WITH_NOTHING_SET,
		);

		expect(decision.hasNothingToMigrate).toBe(true);
		expect(decision.preferencesToUploadToServer).toEqual({});
	});

	it("服务端尚未设定时采纳本地值——第一个 origin 的播种路径", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(SERVER_WITH_NOTHING_SET, {
			...BROWSER_WITH_NOTHING_SET,
			newTaskAutoReviewEnabled: true,
			workspaceOpenTargetPreferredApplicationId: "zed",
		});

		expect(decision.preferencesToUploadToServer).toEqual({
			newTaskAutoReviewEnabled: true,
			workspaceOpenTargetPreferredApplicationId: "zed",
		});
		expect(decision.fieldsWhereServerAndBrowserDisagree).toEqual([]);
	});

	it("本地是 false 也算「有值」——false 与「尚未设定」不是一回事", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(SERVER_WITH_NOTHING_SET, {
			...BROWSER_WITH_NOTHING_SET,
			newTaskAutoReviewEnabled: false,
		});

		expect(decision.preferencesToUploadToServer).toEqual({ newTaskAutoReviewEnabled: false });
	});

	it("服务端已有值时不覆盖，而是把落选的那份记成冲突", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(
			{ ...SERVER_WITH_NOTHING_SET, workspaceOpenTargetPreferredApplicationId: "cursor" },
			{ ...BROWSER_WITH_NOTHING_SET, workspaceOpenTargetPreferredApplicationId: "zed" },
		);

		expect(decision.preferencesToUploadToServer).toEqual({});
		expect(decision.fieldsWhereServerAndBrowserDisagree).toEqual(["workspaceOpenTargetPreferredApplicationId"]);
	});

	it("两边值相同时既不上传也不报冲突", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(
			{ ...SERVER_WITH_NOTHING_SET, workspaceOpenTargetPreferredApplicationId: "zed" },
			{ ...BROWSER_WITH_NOTHING_SET, workspaceOpenTargetPreferredApplicationId: "zed" },
		);

		expect(decision.hasNothingToMigrate).toBe(true);
	});

	it("字典只交出「服务端快照里没有的键」，并集留给服务端在锁内算", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(
			{
				...SERVER_WITH_NOTHING_SET,
				projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "2": "server-beta" },
			},
			{
				...BROWSER_WITH_NOTHING_SET,
				projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "browser-beta", "5": "epsilon" },
			},
		);

		// 字典**绝不能**出现在整份替换那条路径的载荷里：那样会把服务端此刻已有的条目覆盖掉。
		expect(decision.preferencesToUploadToServer).toEqual({});
		expect(decision.dictionaryEntriesMigratedFromBrowserLocalStorage).toEqual({
			projectNumericSlotGroupAssignmentsBySlotNumber: { "5": "epsilon" },
		});
		expect(decision.fieldsWhereServerAndBrowserDisagree).toEqual(["projectNumericSlotGroupAssignmentsBySlotNumber"]);
	});

	it("两个 origin 各基于同一份空快照迁移：各自只交出自己那半份，服务端并起来才是全集", () => {
		const originA = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(SERVER_WITH_NOTHING_SET, {
			...BROWSER_WITH_NOTHING_SET,
			projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
		});
		const originB = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(SERVER_WITH_NOTHING_SET, {
			...BROWSER_WITH_NOTHING_SET,
			projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "beta" },
		});

		expect(originA.dictionaryEntriesMigratedFromBrowserLocalStorage).toEqual({
			projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" },
		});
		expect(originB.dictionaryEntriesMigratedFromBrowserLocalStorage).toEqual({
			projectNumericSlotGroupAssignmentsBySlotNumber: { "2": "beta" },
		});
	});

	it("字典无本地独有键时不上传，只在有分歧时报冲突", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(
			{ ...SERVER_WITH_NOTHING_SET, projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha" } },
			{ ...BROWSER_WITH_NOTHING_SET, projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "beta" } },
		);

		expect(decision.preferencesToUploadToServer).toEqual({});
		expect(decision.dictionaryEntriesMigratedFromBrowserLocalStorage).toEqual({});
		expect(decision.fieldsWhereServerAndBrowserDisagree).toEqual(["projectNumericSlotGroupAssignmentsBySlotNumber"]);
	});

	it("只有字典要采纳时也不算「无事可做」", () => {
		const decision = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(SERVER_WITH_NOTHING_SET, {
			...BROWSER_WITH_NOTHING_SET,
			taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: { '["global","claude"]': "opus" },
		});

		expect(decision.hasNothingToMigrate).toBe(false);
		expect(decision.dictionaryEntriesMigratedFromBrowserLocalStorage).toEqual({
			taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: { '["global","claude"]': "opus" },
		});
	});

	it("幂等：播种成功后同一份本地数据不再产生上传", () => {
		const browser = { ...BROWSER_WITH_NOTHING_SET, newTaskAutoReviewMode: "pr" as const };
		const first = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(SERVER_WITH_NOTHING_SET, browser);
		expect(first.preferencesToUploadToServer).toEqual({ newTaskAutoReviewMode: "pr" });

		const serverAfterFirstMigration = { ...SERVER_WITH_NOTHING_SET, ...first.preferencesToUploadToServer };
		const second = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(serverAfterFirstMigration, browser);

		expect(second.hasNothingToMigrate).toBe(true);
	});

	it("与打开顺序无关：两个 origin 各播种一半，谁先谁后结果一致", () => {
		const originA = { ...BROWSER_WITH_NOTHING_SET, newTaskAutoReviewEnabled: true };
		const originB = { ...BROWSER_WITH_NOTHING_SET, workspaceOpenTargetPreferredApplicationId: "zed" };

		const applyInOrder = (
			first: UserInterfacePreferenceValuesReadFromBrowserLocalStorage,
			second: UserInterfacePreferenceValuesReadFromBrowserLocalStorage,
		): RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins => {
			const afterFirst = {
				...SERVER_WITH_NOTHING_SET,
				...decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(SERVER_WITH_NOTHING_SET, first)
					.preferencesToUploadToServer,
			};
			return {
				...afterFirst,
				...decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(afterFirst, second)
					.preferencesToUploadToServer,
			};
		};

		expect(applyInOrder(originA, originB)).toEqual(applyInOrder(originB, originA));
	});
});
