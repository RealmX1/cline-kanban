// 跨浏览器 origin 共享的界面偏好：浏览器侧的单例外部 store。
//
// ## 为什么是外部 store 而不是 React context
//
// 这些偏好的消费方里既有 hook（`useTaskEditor`、`useOpenWorkspace`、数字槽位编组），也有
// **模块级命令式函数**（`use-task-editor.ts` 里记忆终端 agent 模型选择的那对读写函数）。而且 `App()`
// 自己就在调用其中几个 hook——context provider 没法服务渲染自己的那个组件。外部 store 两边都能服务，
// 且用 `useSyncExternalStore` 订阅是 React 18 的正规做法，不必为此把 App 拆开。
//
// ## 三层取值：服务端 → 本地镜像 → 调用方默认值
//
// 服务端是**真相源**；localStorage 里那几个老键降级成**镜像**，只剩两个职责：
//   1. 首屏（配置还没到）时同步回显，避免「刚打开时偏好像是被重置了、一秒后又跳回来」；
//   2. 服务端写失败时不丢用户这次的选择——它仍在镜像里，下一次加载会由迁移决策重新播种上去。
//
// 镜像沿用**升级前的原编码**（布尔存 "true"/"false"、枚举存裸串、字典存 JSON），因为升级前留在这些键
// 下的那份数据正是迁移要采纳的种子；换编码等于把用户攒下的偏好读不出来。

import { fetchRuntimeConfig, saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type {
	RuntimeConfigSaveRequest,
	RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins,
} from "@/runtime/types";
import {
	decideUserInterfacePreferenceMigrationFromBrowserLocalStorage,
	type UserInterfacePreferenceMigrationDecision,
	type UserInterfacePreferenceValuesReadFromBrowserLocalStorage,
} from "@/runtime/user-interface-preference-migration-from-browser-local-storage";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

export type UserInterfacePreferenceFieldName = keyof RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins;

/**
 * 全 null / 全空字典：服务端一条偏好都没有。
 *
 * null **不是**默认值，而是「尚未设定」——迁移正是靠这个区分决定该不该把本地那份播种上去。
 */
export const USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins =
	{
		newTaskAutoReviewEnabled: null,
		newTaskAutoReviewMode: null,
		taskCreateDialogPrimaryStartAction: null,
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
		workspaceOpenTargetPreferredApplicationId: null,
		projectNumericSlotGroupAssignmentsBySlotNumber: {},
	};

// 表里每一项各自持有自己字段的类型，但按 key 遍历时 TypeScript 无法把 codec 与 value 关联起来（联合
// 会把参数收敛成 never）。所以对外擦除成 unknown，由 defineMirrorCodec 在**定义处**保住类型安全——
// 类型检查落在每条 codec 写出来的那一刻，而不是遍历那一刻。
interface BrowserLocalStorageMirrorCodecWithErasedValueType {
	localStorageMirrorKey: LocalStorageKey;
	readFromMirrorText: (mirrorText: string) => unknown;
	writeToMirrorText: (value: unknown) => string | null;
}

function defineMirrorCodec<TFieldName extends UserInterfacePreferenceFieldName>(codec: {
	localStorageMirrorKey: LocalStorageKey;
	readFromMirrorText: (
		mirrorText: string,
	) => RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName] | null;
	writeToMirrorText: (value: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]) => string | null;
}): BrowserLocalStorageMirrorCodecWithErasedValueType {
	return {
		localStorageMirrorKey: codec.localStorageMirrorKey,
		readFromMirrorText: codec.readFromMirrorText,
		writeToMirrorText: (value) =>
			codec.writeToMirrorText(value as RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]),
	};
}

function parseJsonOrNull(mirrorText: string): unknown {
	try {
		return JSON.parse(mirrorText);
	} catch {
		return null;
	}
}

function readStringKeyedStringRecord(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string" && entry.length > 0) {
			record[key] = entry;
		}
	}
	return record;
}

// 每条镜像的编解码必须与升级前那个 hook 用的编码逐字节一致，否则读不出旧数据。
const BROWSER_LOCAL_STORAGE_MIRROR_CODECS: Record<
	UserInterfacePreferenceFieldName,
	BrowserLocalStorageMirrorCodecWithErasedValueType
> = {
	newTaskAutoReviewEnabled: defineMirrorCodec<"newTaskAutoReviewEnabled">({
		localStorageMirrorKey: LocalStorageKey.TaskAutoReviewEnabled,
		// 升级前是 useBooleanLocalStorageValue：serializer 为 String(value)、deserializer 为 value === "true"。
		readFromMirrorText: (mirrorText) => (mirrorText === "true" ? true : mirrorText === "false" ? false : null),
		writeToMirrorText: (value) => (value === null ? null : String(value)),
	}),
	newTaskAutoReviewMode: defineMirrorCodec<"newTaskAutoReviewMode">({
		localStorageMirrorKey: LocalStorageKey.TaskAutoReviewMode,
		readFromMirrorText: (mirrorText) => (mirrorText === "commit" || mirrorText === "pr" ? mirrorText : null),
		writeToMirrorText: (value) => value,
	}),
	taskCreateDialogPrimaryStartAction: defineMirrorCodec<"taskCreateDialogPrimaryStartAction">({
		localStorageMirrorKey: LocalStorageKey.TaskCreatePrimaryStartAction,
		readFromMirrorText: (mirrorText) =>
			mirrorText === "start" || mirrorText === "start_and_open" ? mirrorText : null,
		writeToMirrorText: (value) => value,
	}),
	workspaceOpenTargetPreferredApplicationId: defineMirrorCodec<"workspaceOpenTargetPreferredApplicationId">({
		localStorageMirrorKey: LocalStorageKey.PreferredOpenTarget,
		readFromMirrorText: (mirrorText) => (mirrorText.length > 0 ? mirrorText : null),
		writeToMirrorText: (value) => value,
	}),
	taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey:
		defineMirrorCodec<"taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey">({
			localStorageMirrorKey: LocalStorageKey.TaskCreateTerminalAgentModelSelections,
			// 升级前这份存的是 `{ "selections": { ... } }` 包装，不是裸字典。
			readFromMirrorText: (mirrorText) => {
				const parsed = parseJsonOrNull(mirrorText);
				if (typeof parsed !== "object" || parsed === null) {
					return null;
				}
				return readStringKeyedStringRecord((parsed as { selections?: unknown }).selections);
			},
			writeToMirrorText: (value) => JSON.stringify({ selections: value }),
		}),
	projectNumericSlotGroupAssignmentsBySlotNumber: defineMirrorCodec<"projectNumericSlotGroupAssignmentsBySlotNumber">({
		localStorageMirrorKey: LocalStorageKey.ProjectNumericSlotGroupAssignments,
		readFromMirrorText: (mirrorText) => readStringKeyedStringRecord(parseJsonOrNull(mirrorText)),
		writeToMirrorText: (value) => JSON.stringify(value),
	}),
};

function readFieldFromBrowserLocalStorageMirror<TFieldName extends UserInterfacePreferenceFieldName>(
	fieldName: TFieldName,
): RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName] | null {
	const codec = BROWSER_LOCAL_STORAGE_MIRROR_CODECS[fieldName];
	const mirrorText = readLocalStorageItem(codec.localStorageMirrorKey);
	if (mirrorText === null) {
		return null;
	}
	return codec.readFromMirrorText(mirrorText) as
		| RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName]
		| null;
}

export function readAllUserInterfacePreferenceValuesFromBrowserLocalStorage(): UserInterfacePreferenceValuesReadFromBrowserLocalStorage {
	return {
		newTaskAutoReviewEnabled: readFieldFromBrowserLocalStorageMirror("newTaskAutoReviewEnabled"),
		newTaskAutoReviewMode: readFieldFromBrowserLocalStorageMirror("newTaskAutoReviewMode"),
		taskCreateDialogPrimaryStartAction: readFieldFromBrowserLocalStorageMirror("taskCreateDialogPrimaryStartAction"),
		workspaceOpenTargetPreferredApplicationId: readFieldFromBrowserLocalStorageMirror(
			"workspaceOpenTargetPreferredApplicationId",
		),
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey:
			readFieldFromBrowserLocalStorageMirror("taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey") ?? {},
		projectNumericSlotGroupAssignmentsBySlotNumber:
			readFieldFromBrowserLocalStorageMirror("projectNumericSlotGroupAssignmentsBySlotNumber") ?? {},
	};
}

export interface UserInterfacePreferencesSharedAcrossBrowserOriginsStoreState {
	/** 服务端那份；null 表示还没读到（首屏），此时读取一律回落本地镜像。 */
	preferencesLoadedFromServer: RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins | null;
	/** 迁移时两边都有值且不一致的字段（服务端胜出）。供一次性提示用户复核。 */
	fieldsWhereServerAndBrowserDisagree: readonly string[];
}

const STORE_STATE_BEFORE_FIRST_LOAD: UserInterfacePreferencesSharedAcrossBrowserOriginsStoreState = {
	preferencesLoadedFromServer: null,
	fieldsWhereServerAndBrowserDisagree: [],
};

// useSyncExternalStore 要求快照在「没变化」时保持引用相等，所以整个对象只在真的变了时才替换。
let storeState: UserInterfacePreferencesSharedAcrossBrowserOriginsStoreState = STORE_STATE_BEFORE_FIRST_LOAD;
const storeListeners = new Set<() => void>();
let hasStartedLoadingFromServer = false;

function publishStoreState(nextStoreState: UserInterfacePreferencesSharedAcrossBrowserOriginsStoreState): void {
	storeState = nextStoreState;
	for (const listener of storeListeners) {
		listener();
	}
}

export function subscribeToUserInterfacePreferencesSharedAcrossBrowserOrigins(listener: () => void): () => void {
	storeListeners.add(listener);
	return () => {
		storeListeners.delete(listener);
	};
}

export function getUserInterfacePreferencesSharedAcrossBrowserOriginsStoreState(): UserInterfacePreferencesSharedAcrossBrowserOriginsStoreState {
	return storeState;
}

/**
 * 读一个字段的**生效值**：服务端有值就用服务端的，否则回落本地镜像，都没有则返回 null（由调用方套默认值）。
 *
 * 命令式消费方（模块级函数）直接调它；hook 消费方经
 * `use-user-interface-preferences-shared-across-browser-origins.ts` 调它并订阅变更。
 */
export function readEffectiveUserInterfacePreferenceValue<TFieldName extends UserInterfacePreferenceFieldName>(
	fieldName: TFieldName,
): RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins[TFieldName] | null {
	const serverValue = storeState.preferencesLoadedFromServer?.[fieldName] ?? null;
	if (serverValue !== null) {
		return serverValue;
	}
	return readFieldFromBrowserLocalStorageMirror(fieldName);
}

function writeUpdateToBrowserLocalStorageMirrors(
	update: Partial<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins>,
): void {
	for (const fieldName of Object.keys(update) as UserInterfacePreferenceFieldName[]) {
		const value = update[fieldName];
		if (value === undefined) {
			continue;
		}
		const codec = BROWSER_LOCAL_STORAGE_MIRROR_CODECS[fieldName];
		const mirrorText = codec.writeToMirrorText(value);
		if (mirrorText !== null) {
			writeLocalStorageItem(codec.localStorageMirrorKey, mirrorText);
		}
	}
}

function publishOptimisticPreferenceUpdate(
	update: Partial<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins>,
): void {
	if (storeState.preferencesLoadedFromServer !== null) {
		publishStoreState({
			...storeState,
			preferencesLoadedFromServer: { ...storeState.preferencesLoadedFromServer, ...update },
		});
		return;
	}
	// 服务端那份还没到就先通知一次：镜像已经变了，订阅方要重新读。
	publishStoreState({ ...storeState });
}

/**
 * 发一次保存请求，并把服务端**回给我们的那份**当作新的真相。
 *
 * 采纳响应而不是就地保留乐观值是刻意的：服务端可能在锁内并入了别的 origin 刚写进去的条目
 * （迁移采纳意图正是这样），只有响应里那份才是合并后的事实。
 */
function sendPreferenceSaveRequestAndAdoptServerResponse(saveRequest: RuntimeConfigSaveRequest): void {
	// 全局作用域（workspaceId = null）——这些偏好本就落在全局 config.json 里，与当前项目无关。
	void saveRuntimeConfig(null, saveRequest)
		.then((savedConfig) => {
			publishStoreState({
				...storeState,
				preferencesLoadedFromServer: savedConfig.userInterfacePreferencesSharedAcrossBrowserOrigins,
			});
		})
		.catch(() => {
			// 静默：值已在镜像里，界面已经反映了这次修改，弹一个 toast 只会在离线时刷屏。
		});
}

/**
 * 写一条（或几条）偏好——**用户当下的显式操作**走这里，字典按整份替换（删除靠它表达）。
 *
 * 顺序是刻意的：**先写本地镜像，再发服务端**。服务端写失败时用户这次的选择仍留在镜像里，下一次加载
 * 由迁移决策重新播种上去——反过来（先发服务端、成功才写镜像）会让一次网络抖动直接吞掉用户的点击。
 *
 * 已知窗口（明知并接受）：若服务端**已有**该字段的值而这次写入失败，下次加载时服务端那份会赢，本次
 * 修改落选并被记进冲突提示。没有静默丢失，但用户需要再点一次。
 */
export function saveUserInterfacePreferencesSharedAcrossBrowserOrigins(
	update: Partial<RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins>,
): void {
	writeUpdateToBrowserLocalStorageMirrors(update);
	publishOptimisticPreferenceUpdate(update);
	sendPreferenceSaveRequestAndAdoptServerResponse({ userInterfacePreferencesSharedAcrossBrowserOrigins: update });
}

/**
 * 把一次迁移决策上传给服务端：标量走普通部分更新，字典条目走**迁移采纳**意图。
 *
 * 两者分开发而不是拼成一份整份字典，是因为整份字典会覆盖服务端此刻已有的条目——两个 origin 首次几乎
 * 同时迁移时后到的那次会把前一次的编组抹掉。走采纳意图则由服务端在锁内只补它真的缺的键。
 *
 * 也不回写字典镜像：镜像本来就是这些条目的**来源**，回写只是把读到的东西原样写回去。
 */
function uploadUserInterfacePreferenceMigrationDecisionToServer(
	migrationDecision: UserInterfacePreferenceMigrationDecision,
): void {
	const hasScalarsToUpload = Object.keys(migrationDecision.preferencesToUploadToServer).length > 0;
	const hasDictionaryEntriesToAdopt =
		Object.keys(migrationDecision.dictionaryEntriesMigratedFromBrowserLocalStorage).length > 0;
	if (!hasScalarsToUpload && !hasDictionaryEntriesToAdopt) {
		return;
	}
	if (hasScalarsToUpload) {
		writeUpdateToBrowserLocalStorageMirrors(migrationDecision.preferencesToUploadToServer);
		publishOptimisticPreferenceUpdate(migrationDecision.preferencesToUploadToServer);
	}
	sendPreferenceSaveRequestAndAdoptServerResponse({
		...(hasScalarsToUpload
			? { userInterfacePreferencesSharedAcrossBrowserOrigins: migrationDecision.preferencesToUploadToServer }
			: {}),
		...(hasDictionaryEntriesToAdopt
			? {
					userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage:
						migrationDecision.dictionaryEntriesMigratedFromBrowserLocalStorage,
				}
			: {}),
	});
}

/**
 * 从服务端读取偏好，并把本地 localStorage 里那份合并上去。幂等，重复调用只会做一次。
 *
 * 迁移不删本地数据：本地那份既是回退备份，也是首屏镜像；而且决策只看「服务端此刻是不是 null」，
 * 播种成功后自然不会重复上传（见迁移模块的幂等说明）。
 */
export function startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins(): void {
	if (hasStartedLoadingFromServer) {
		return;
	}
	hasStartedLoadingFromServer = true;
	void fetchRuntimeConfig(null)
		.then((config) => {
			const serverPreferences = config.userInterfacePreferencesSharedAcrossBrowserOrigins;
			const migration = decideUserInterfacePreferenceMigrationFromBrowserLocalStorage(
				serverPreferences,
				readAllUserInterfacePreferenceValuesFromBrowserLocalStorage(),
			);
			publishStoreState({
				preferencesLoadedFromServer: serverPreferences,
				fieldsWhereServerAndBrowserDisagree: migration.fieldsWhereServerAndBrowserDisagree,
			});
			uploadUserInterfacePreferenceMigrationDecisionToServer(migration);
		})
		.catch(() => {
			// 读不到就一直用本地镜像跑（`preferencesLoadedFromServer` 保持 null）。允许下次再试。
			hasStartedLoadingFromServer = false;
		});
}

/** 仅供测试：把单例 store 复位，避免用例之间互相串味。 */
export function resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests(): void {
	storeState = STORE_STATE_BEFORE_FIRST_LOAD;
	hasStartedLoadingFromServer = false;
	storeListeners.clear();
}
