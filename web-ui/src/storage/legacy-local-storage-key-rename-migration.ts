// 被改名的 localStorage 键的一次性搬迁。
//
// 为什么需要它：localStorage 的键名就是数据的地址，改名等于换地址，用户已经存在旧地址下的偏好会
// 凭空消失（表现为「升级后侧栏宽度被重置了」）。所以每一次改名都必须配一条搬迁记录，而不是改完了事。
//
// 为什么不复用 local-storage-store.ts 的读写助手：那三个助手的参数类型是 `LocalStorageKey`，而旧键
// 改名后已经不再是该枚举的成员——正是「旧键不该再被任何常规代码路径使用」这件事让它们用不上。
// 这里因此自带一份最小的裸键访问，且只有本模块用得到。

import { LocalStorageKey } from "@/storage/local-storage-store";

interface RenamedLocalStorageKeyMigration {
	/** 改名前写在磁盘上的裸字符串键。改名后它不再出现在 LocalStorageKey 枚举里。 */
	legacyKey: string;
	/** 改名后的键。搬迁只在它**尚无值**时写入。 */
	currentKey: LocalStorageKey;
}

export const RENAMED_LOCAL_STORAGE_KEY_MIGRATIONS: readonly RenamedLocalStorageKeyMigration[] = [
	// 项目导航栏宽度：`kb-sidebar-width` 是全枚举里唯一没有 `kanban.` 前缀的键。
	{ legacyKey: "kb-sidebar-width", currentKey: LocalStorageKey.ProjectNavigationPanelWidth },
];

function getLocalStorageOrNull(): Storage | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		return window.localStorage;
	} catch {
		// Safari 隐私模式等环境下访问 localStorage 本身就会抛。
		return null;
	}
}

/**
 * 把改名前留在旧键下的值搬到新键，随后删掉旧键。
 *
 * 三条不变量：
 *   - **幂等**：旧键搬走后即被删除，重复调用是空操作；
 *   - **不覆盖**：新键已有值时（用户在这个 origin 升级后已经改过），保留新值、只清理旧键——
 *     新值是更晚的用户意图，旧值不该把它顶掉；
 *   - **不抛出**：搬迁失败只是丢一次偏好，绝不能让整个应用起不来。
 *
 * 必须在任何消费者读取这些键**之前**调用（即 React 渲染之前），否则首帧会读到空值并把默认值写回去，
 * 让搬迁变成无用功。
 */
export function migrateRenamedLocalStorageKeysIntoCurrentKeys(): void {
	const storage = getLocalStorageOrNull();
	if (!storage) {
		return;
	}
	for (const { legacyKey, currentKey } of RENAMED_LOCAL_STORAGE_KEY_MIGRATIONS) {
		try {
			const legacyValue = storage.getItem(legacyKey);
			if (legacyValue === null) {
				continue;
			}
			if (storage.getItem(currentKey) === null) {
				storage.setItem(currentKey, legacyValue);
			}
			storage.removeItem(legacyKey);
		} catch {
			// 单条搬迁失败不影响其余条目。
		}
	}
}
