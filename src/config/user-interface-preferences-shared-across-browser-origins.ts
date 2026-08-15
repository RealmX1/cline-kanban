// 跨浏览器 origin 共享的界面偏好：规范化、比较与部分更新合并。
//
// 从 runtime-config.ts 分出来的理由：那个文件已经有近千行、且每加一个字段都要在 7 处样板里各改一遍；
// 这一组偏好的语义（null ≠ 默认值、字典逐键覆盖）与那些「标量 + 默认值」的老字段不一样，混在一起写
// 会让两套语义互相污染。分开后这套语义能被单独测。
//
// 契约与语义说明见 api-contract.ts 的 runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema。

import {
	type RuntimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage,
	type RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
	runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema,
} from "../core/api-contract";

/** 全 null / 全空字典：表示「服务端一条偏好都没有」，也是首次读取时的形态。 */
export const USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins =
	{
		newTaskAutoReviewEnabled: null,
		newTaskAutoReviewMode: null,
		taskCreateDialogPrimaryStartAction: null,
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
		workspaceOpenTargetPreferredApplicationId: null,
		projectNumericSlotGroupAssignmentsBySlotNumber: {},
		mostRecentlyUsedTaskCreateBaseRefByProjectId: {},
	};

function normalizeStringKeyedStringRecord(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const normalized: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		// 逐条丢弃坏值而不是整份作废：一条被手工编辑坏的映射不该连累其余全部条目。
		if (typeof entry === "string" && entry.length > 0) {
			normalized[key] = entry;
		}
	}
	return normalized;
}

/**
 * 把磁盘上的任意 JSON 规范化成完整的偏好对象。
 *
 * 逐字段宽容：某个标量在磁盘上是坏值时只把**它**降级成 null（= 尚未设定），其余字段照常读出。
 * 整份 safeParse 一次性失败会让一个坏字段抹掉用户全部偏好，那是拿正确性换简洁。
 */
export function normalizeUserInterfacePreferencesSharedAcrossBrowserOrigins(
	value: unknown,
): RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET;
	}
	const record = value as Record<string, unknown>;
	const shape = runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema.shape;
	const parseNullableField = <TField extends keyof RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins>(
		field: TField,
	): RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TField] | null => {
		const parsed = shape[field].safeParse(record[field]);
		return parsed.success ? (parsed.data as RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TField]) : null;
	};
	return {
		newTaskAutoReviewEnabled: parseNullableField("newTaskAutoReviewEnabled"),
		newTaskAutoReviewMode: parseNullableField("newTaskAutoReviewMode"),
		taskCreateDialogPrimaryStartAction: parseNullableField("taskCreateDialogPrimaryStartAction"),
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: normalizeStringKeyedStringRecord(
			record.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
		),
		workspaceOpenTargetPreferredApplicationId: parseNullableField("workspaceOpenTargetPreferredApplicationId"),
		projectNumericSlotGroupAssignmentsBySlotNumber: normalizeStringKeyedStringRecord(
			record.projectNumericSlotGroupAssignmentsBySlotNumber,
		),
		mostRecentlyUsedTaskCreateBaseRefByProjectId: normalizeStringKeyedStringRecord(
			record.mostRecentlyUsedTaskCreateBaseRefByProjectId,
		),
	};
}

/** 一条偏好都没有——写盘时据此决定「整个键都不落」，避免 config.json 里堆一坨全 null 的噪声。 */
export function hasNoUserInterfacePreferenceSharedAcrossBrowserOriginsSet(
	preferences: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
): boolean {
	return (
		preferences.newTaskAutoReviewEnabled === null &&
		preferences.newTaskAutoReviewMode === null &&
		preferences.taskCreateDialogPrimaryStartAction === null &&
		Object.keys(preferences.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey).length === 0 &&
		preferences.workspaceOpenTargetPreferredApplicationId === null &&
		Object.keys(preferences.projectNumericSlotGroupAssignmentsBySlotNumber).length === 0 &&
		Object.keys(preferences.mostRecentlyUsedTaskCreateBaseRefByProjectId).length === 0
	);
}

function areStringKeyedStringRecordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) {
		return false;
	}
	return leftKeys.every((key) => left[key] === right[key]);
}

export function areUserInterfacePreferencesSharedAcrossBrowserOriginsEqual(
	left: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
	right: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
): boolean {
	return (
		left.newTaskAutoReviewEnabled === right.newTaskAutoReviewEnabled &&
		left.newTaskAutoReviewMode === right.newTaskAutoReviewMode &&
		left.taskCreateDialogPrimaryStartAction === right.taskCreateDialogPrimaryStartAction &&
		left.workspaceOpenTargetPreferredApplicationId === right.workspaceOpenTargetPreferredApplicationId &&
		areStringKeyedStringRecordsEqual(
			left.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
			right.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
		) &&
		areStringKeyedStringRecordsEqual(
			left.projectNumericSlotGroupAssignmentsBySlotNumber,
			right.projectNumericSlotGroupAssignmentsBySlotNumber,
		) &&
		areStringKeyedStringRecordsEqual(
			left.mostRecentlyUsedTaskCreateBaseRefByProjectId,
			right.mostRecentlyUsedTaskCreateBaseRefByProjectId,
		)
	);
}

/**
 * 把「服务端没有的键」并进一份字典；服务端已有的键原样保留。
 *
 * 服务端胜出的理由与标量那条规则同源：服务端有值意味着已经有某个 origin 迁移过、或用户在新界面里改过，
 * 那是更晚的意图；迁移载荷里那份是升级前的旧快照。
 */
function adoptDictionaryEntriesAbsentFromCurrentRecord(
	current: Record<string, string>,
	entriesToAdopt: Record<string, string> | undefined,
): Record<string, string> {
	if (entriesToAdopt === undefined) {
		return current;
	}
	// 先铺采纳项、再让当前值覆盖同名键，一次表达完「缺的补上、冲突的服务端赢」。
	return { ...normalizeStringKeyedStringRecord(entriesToAdopt), ...current };
}

/**
 * 把一份部分更新叠加到当前偏好上。
 *
 * 每个字段三种状态各有语义，别把它们折叠成两种：
 *   - `undefined`（字段缺席）→ 保留当前值。少发一个字段绝不该顺手清掉它；
 *   - `null` → 显式清回「服务端无值」，于是下一次合并迁移会重新采纳本地值；
 *   - 有值 → 设定。字典按**整份**替换（调用方读-改-写整份），与既有的 `shortcuts` 一致。
 *
 * 字典之所以在这条路径上必须整份替换：前端表达「解除某个槽位绑定 / 忘掉某条模型记忆」的唯一手段就是
 * 写回一份少了那个键的整份字典，这里逐键求并等于让删除永远不生效。
 *
 * `dictionaryEntriesMigratedFromBrowserLocalStorage` 是**另一种意图**，在整份替换之后再逐键并入：
 * 它是某个 origin 从自己 localStorage 里搬上来的历史条目，只补服务端没有的键。两个 origin 首次几乎
 * 同时迁移时，各自的采纳都在锁内叠加到彼时的磁盘那份上，因此谁先谁后结果一致、一条都不会被覆盖掉——
 * 这正是把并集放在服务端算（而不是让客户端拿它读到的快照算好整份再上传）的意义。
 */
export function mergeUserInterfacePreferencesSharedAcrossBrowserOriginsUpdate(
	current: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
	updates: Partial<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins> | undefined,
	dictionaryEntriesMigratedFromBrowserLocalStorage?:
		| RuntimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage
		| undefined,
): RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins {
	if (!updates && !dictionaryEntriesMigratedFromBrowserLocalStorage) {
		return current;
	}
	const replaced: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins = {
		newTaskAutoReviewEnabled:
			updates?.newTaskAutoReviewEnabled === undefined
				? current.newTaskAutoReviewEnabled
				: updates.newTaskAutoReviewEnabled,
		newTaskAutoReviewMode:
			updates?.newTaskAutoReviewMode === undefined ? current.newTaskAutoReviewMode : updates.newTaskAutoReviewMode,
		taskCreateDialogPrimaryStartAction:
			updates?.taskCreateDialogPrimaryStartAction === undefined
				? current.taskCreateDialogPrimaryStartAction
				: updates.taskCreateDialogPrimaryStartAction,
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey:
			updates?.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey === undefined
				? current.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey
				: normalizeStringKeyedStringRecord(updates.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey),
		workspaceOpenTargetPreferredApplicationId:
			updates?.workspaceOpenTargetPreferredApplicationId === undefined
				? current.workspaceOpenTargetPreferredApplicationId
				: updates.workspaceOpenTargetPreferredApplicationId,
		projectNumericSlotGroupAssignmentsBySlotNumber:
			updates?.projectNumericSlotGroupAssignmentsBySlotNumber === undefined
				? current.projectNumericSlotGroupAssignmentsBySlotNumber
				: normalizeStringKeyedStringRecord(updates.projectNumericSlotGroupAssignmentsBySlotNumber),
		mostRecentlyUsedTaskCreateBaseRefByProjectId:
			updates?.mostRecentlyUsedTaskCreateBaseRefByProjectId === undefined
				? current.mostRecentlyUsedTaskCreateBaseRefByProjectId
				: normalizeStringKeyedStringRecord(updates.mostRecentlyUsedTaskCreateBaseRefByProjectId),
	};
	if (!dictionaryEntriesMigratedFromBrowserLocalStorage) {
		return replaced;
	}
	return {
		...replaced,
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: adoptDictionaryEntriesAbsentFromCurrentRecord(
			replaced.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
			dictionaryEntriesMigratedFromBrowserLocalStorage.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
		),
		projectNumericSlotGroupAssignmentsBySlotNumber: adoptDictionaryEntriesAbsentFromCurrentRecord(
			replaced.projectNumericSlotGroupAssignmentsBySlotNumber,
			dictionaryEntriesMigratedFromBrowserLocalStorage.projectNumericSlotGroupAssignmentsBySlotNumber,
		),
		mostRecentlyUsedTaskCreateBaseRefByProjectId: adoptDictionaryEntriesAbsentFromCurrentRecord(
			replaced.mostRecentlyUsedTaskCreateBaseRefByProjectId,
			dictionaryEntriesMigratedFromBrowserLocalStorage.mostRecentlyUsedTaskCreateBaseRefByProjectId,
		),
	};
}
