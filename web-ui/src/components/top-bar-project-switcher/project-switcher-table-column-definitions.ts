/**
 * 顶栏项目切换器表格的列定义。
 *
 * 两列必有、不可关：项目名（第一列）与 Live Task Count —— 它们就是这个切换器存在的理由。
 * 其余额外列（含编组槽位）都可在表头的列可见性菜单里逐个开关，偏好持久化在 localStorage。
 */
export const PROJECT_SWITCHER_TABLE_COLUMN_IDS = [
	"project_name",
	"numeric_slot_group",
	"live_agent_task_count",
	"awaiting_user_task_count",
	"task_distribution_badges",
	"last_visited",
] as const;

export type ProjectSwitcherTableColumnId = (typeof PROJECT_SWITCHER_TABLE_COLUMN_IDS)[number];

export interface ProjectSwitcherTableColumnDefinition {
	id: ProjectSwitcherTableColumnId;
	/** 表头文案。必有列在窄屏下用图标代替，故这里只作为 `title`/`aria-label` 的兜底。 */
	headerLabel: string;
	/** 列可见性菜单里的说明文案。 */
	menuLabel: string;
	/** false = 必有列，不出现在可见性菜单里。 */
	isToggleable: boolean;
	isVisibleByDefault: boolean;
}

export const PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS: readonly ProjectSwitcherTableColumnDefinition[] = [
	{
		id: "project_name",
		headerLabel: "Project",
		menuLabel: "Project",
		isToggleable: false,
		isVisibleByDefault: true,
	},
	{
		// 编组槽位是「额外列」而非必有列：默认开着（跳转热键要靠它可见地绑定），但用户可以在菜单里关掉。
		id: "numeric_slot_group",
		headerLabel: "Slot",
		menuLabel: "Slot",
		isToggleable: true,
		isVisibleByDefault: true,
	},
	{
		id: "live_agent_task_count",
		headerLabel: "Live",
		menuLabel: "Live",
		isToggleable: false,
		isVisibleByDefault: true,
	},
	{
		id: "awaiting_user_task_count",
		headerLabel: "Awaiting you",
		menuLabel: "Awaiting you",
		isToggleable: true,
		isVisibleByDefault: true,
	},
	{
		// 默认关：它里面的 `R` 与 Awaiting you 是同一个 `taskCounts.review`，同时开会重复展示。
		id: "task_distribution_badges",
		headerLabel: "Tasks",
		menuLabel: "Task distribution (B/IP/R/V)",
		isToggleable: true,
		isVisibleByDefault: false,
	},
	{
		id: "last_visited",
		headerLabel: "Last visited",
		menuLabel: "Last visited",
		isToggleable: true,
		isVisibleByDefault: true,
	},
];

export type ProjectSwitcherTableColumnVisibility = Readonly<Record<ProjectSwitcherTableColumnId, boolean>>;

export const DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY: ProjectSwitcherTableColumnVisibility =
	Object.fromEntries(
		PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS.map((definition) => [definition.id, definition.isVisibleByDefault]),
	) as ProjectSwitcherTableColumnVisibility;

/**
 * 存档只保留可 toggle 列的开关；必有列恒为 true，不受存档影响（否则一份坏存档能把项目名列关掉）。
 * 未知列 id、非布尔值一律回退到默认。
 */
export function normalizeProjectSwitcherTableColumnVisibility(rawValue: unknown): ProjectSwitcherTableColumnVisibility {
	const storedVisibility =
		typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)
			? (rawValue as Record<string, unknown>)
			: {};
	const normalized: Record<string, boolean> = {};
	for (const definition of PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS) {
		if (!definition.isToggleable) {
			normalized[definition.id] = true;
			continue;
		}
		const storedValue = storedVisibility[definition.id];
		normalized[definition.id] = typeof storedValue === "boolean" ? storedValue : definition.isVisibleByDefault;
	}
	return normalized as ProjectSwitcherTableColumnVisibility;
}

export const TOGGLEABLE_PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS = PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS.filter(
	(definition) => definition.isToggleable,
);
