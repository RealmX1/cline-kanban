// 把浏览器 localStorage 里攒下的界面偏好合并进服务端——纯决策，不碰 storage 也不发请求。
//
// ## 为什么是「合并」而不是「上传覆盖」
//
// 同一个用户可能已经在多个 origin（`web:dev` 的 4173、`dev:full` 每次挑的空闲端口、不同浏览器）各攒了
// 一份偏好。谁先打开升级后的 UI 是随机的，若第一个打开的 origin 直接整份覆盖，后打开的那个就会把
// 前一个的选择顶掉——顺序一变结果就变。合并让结果与打开顺序无关。
//
// ## 三条规则
//
//   1. **服务端已有值就赢**。服务端有值意味着「已经有某个 origin 迁移过、或用户在新 UI 里改过」，
//      那是更晚的意图；本地那份是升级前的旧快照。
//   2. **服务端为 null（尚未设定）时采纳本地值**。这是第一个 origin 的播种路径。
//   3. **字典逐键合并**，不整份取舍：本地独有的键被采纳、两边都有的键服务端赢。整份取舍会让
//      「A origin 绑了槽位 1-3、B origin 绑了槽位 4-6」白丢一半。
//
// 规则 1 会让本地那份不同的值静默落选，所以两边都有值且不同的字段会被记进
// `fieldsWhereServerAndBrowserDisagree`，由调用方给用户一次性提示去复核——不能默默替用户决定。
//
// ## 字典的并集为什么由**服务端**算，这里只挑出「本地独有的键」
//
// 本模块看到的服务端那份是一个**快照**。若在这里算好整份并集再整份上传，两个 origin 首次几乎同时迁移
// 时（各自都基于空快照算出自己那半份），后到的那次请求会在服务端锁内把前一次的条目整份覆盖掉——结果
// 又回到「与打开顺序有关」，正是规则 3 要消灭的东西。所以这里只输出「服务端快照里没有的那些键」，
// 交给服务端在锁内逐键并入（契约字段
// `userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage`）；即便这份快照期间已经过时，
// 服务端也只会补它此刻真的缺的键，绝不覆盖别人刚写进去的条目。
//
// 标量不需要这套：撞车时两个 origin 各写自己本地那份，谁赢都不会**丢数据**，落选那份进冲突提示即可。
//
// ## 幂等
//
// 决策只看「服务端此刻是什么」。播种成功后服务端不再是 null，下一次跑同一个决策自然什么都不上传。
// 因此本地数据**不需要删除**：留着既是回退用的备份，也不会导致重复上传。

import type {
	RuntimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage,
	RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
} from "@/runtime/types";

/** 从各自的 localStorage 键里读出来的那一份（读取与解码由调用方负责，本模块只做决策）。 */
export interface UserInterfacePreferenceValuesReadFromBrowserLocalStorage {
	newTaskAutoReviewEnabled: boolean | null;
	newTaskAutoReviewMode: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins["newTaskAutoReviewMode"];
	taskCreateDialogPrimaryStartAction: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins["taskCreateDialogPrimaryStartAction"];
	workspaceOpenTargetPreferredApplicationId: string | null;
	taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: Record<string, string>;
	projectNumericSlotGroupAssignmentsBySlotNumber: Record<string, string>;
	mostRecentlyUsedTaskCreateBaseRefByProjectId: Record<string, string>;
}

export interface UserInterfacePreferenceMigrationDecision {
	/**
	 * 要发给服务端的**标量**部分更新。为空对象表示标量无事可做（已迁移过，或本地本就没有偏好）。
	 *
	 * 字典刻意不放这里：这个字段走的是「整份替换」语义的契约字段，字典塞进去就会覆盖服务端那份。
	 */
	preferencesToUploadToServer: Partial<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins>;
	/** 本地有、而服务端快照里没有的字典条目。交服务端在锁内逐键并入，不整份替换。 */
	dictionaryEntriesMigratedFromBrowserLocalStorage: RuntimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage;
	/** 两边都有值且不一致的字段（服务端胜出）。给用户一次性提示用，字段名即契约字段名。 */
	fieldsWhereServerAndBrowserDisagree: string[];
	/** 上面三项都为空时为真——调用方据此完全跳过这次迁移。 */
	hasNothingToMigrate: boolean;
}

type ScalarPreferenceFieldName =
	| "newTaskAutoReviewEnabled"
	| "newTaskAutoReviewMode"
	| "taskCreateDialogPrimaryStartAction"
	| "workspaceOpenTargetPreferredApplicationId";

type RecordPreferenceFieldName =
	| "taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey"
	| "projectNumericSlotGroupAssignmentsBySlotNumber"
	| "mostRecentlyUsedTaskCreateBaseRefByProjectId";

const SCALAR_PREFERENCE_FIELD_NAMES: readonly ScalarPreferenceFieldName[] = [
	"newTaskAutoReviewEnabled",
	"newTaskAutoReviewMode",
	"taskCreateDialogPrimaryStartAction",
	"workspaceOpenTargetPreferredApplicationId",
];

const RECORD_PREFERENCE_FIELD_NAMES: readonly RecordPreferenceFieldName[] = [
	"taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey",
	"projectNumericSlotGroupAssignmentsBySlotNumber",
	"mostRecentlyUsedTaskCreateBaseRefByProjectId",
];

export function decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(
	serverPreferences: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
	browserLocalStorageValues: UserInterfacePreferenceValuesReadFromBrowserLocalStorage,
): UserInterfacePreferenceMigrationDecision {
	const preferencesToUploadToServer: Partial<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins> = {};
	const dictionaryEntriesMigratedFromBrowserLocalStorage: RuntimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage =
		{};
	const fieldsWhereServerAndBrowserDisagree: string[] = [];

	for (const fieldName of SCALAR_PREFERENCE_FIELD_NAMES) {
		const browserValue = browserLocalStorageValues[fieldName];
		if (browserValue === null) {
			continue;
		}
		const serverValue = serverPreferences[fieldName];
		if (serverValue === null) {
			// 规则 2：服务端尚未设定，采纳本地值。
			Object.assign(preferencesToUploadToServer, { [fieldName]: browserValue });
			continue;
		}
		if (serverValue !== browserValue) {
			// 规则 1：服务端赢，但落选的那份必须被说出来。
			fieldsWhereServerAndBrowserDisagree.push(fieldName);
		}
	}

	for (const fieldName of RECORD_PREFERENCE_FIELD_NAMES) {
		const browserRecord = browserLocalStorageValues[fieldName];
		const serverRecord = serverPreferences[fieldName];
		const keysOnlyInBrowser = Object.keys(browserRecord).filter((key) => serverRecord[key] === undefined);
		const keysDisagreeing = Object.keys(browserRecord).filter(
			(key) => serverRecord[key] !== undefined && serverRecord[key] !== browserRecord[key],
		);
		if (keysDisagreeing.length > 0) {
			fieldsWhereServerAndBrowserDisagree.push(fieldName);
		}
		if (keysOnlyInBrowser.length === 0) {
			continue;
		}
		// 规则 3：只交出「服务端快照里没有的键」，并入由服务端在锁内完成（见文件头「字典的并集为什么由服务端算」）。
		const entriesToAdopt: Record<string, string> = {};
		for (const key of keysOnlyInBrowser) {
			const value = browserRecord[key];
			if (value !== undefined) {
				entriesToAdopt[key] = value;
			}
		}
		Object.assign(dictionaryEntriesMigratedFromBrowserLocalStorage, { [fieldName]: entriesToAdopt });
	}

	return {
		preferencesToUploadToServer,
		dictionaryEntriesMigratedFromBrowserLocalStorage,
		fieldsWhereServerAndBrowserDisagree,
		hasNothingToMigrate:
			Object.keys(preferencesToUploadToServer).length === 0 &&
			Object.keys(dictionaryEntriesMigratedFromBrowserLocalStorage).length === 0 &&
			fieldsWhereServerAndBrowserDisagree.length === 0,
	};
}
