/**
 * Spotlight 结果行的字段可见性定义。
 *
 * 用户要的是「这些内容都默认常驻、可选关闭」：所有字段默认全开，逐个可关；只有两样不可关——
 * stage 色块（行首那一小块颜色，是扫视时唯一的分列线索）与主文本（关掉就只剩一行空行）。
 *
 * 结构与 project-switcher-table-column-definitions.ts 一致（同一套 isToggleable / isVisibleByDefault /
 * 坏存档归一），两处将来要一起演进时不必先适应两种写法。
 */
export const TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_IDS = [
	"stage_indicator",
	"primary_text",
	"agent_identity",
	"task_id_badge",
	"project_name_badge",
	"stage_label_badge",
	"relative_time_pill",
	"session_activity_line",
	"prompt_match_snippet_line",
] as const;

export type TaskSpotlightSearchResultRowFieldId = (typeof TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_IDS)[number];

export interface TaskSpotlightSearchResultRowFieldDefinition {
	id: TaskSpotlightSearchResultRowFieldId;
	/** 字段开关菜单里的说明文案。 */
	menuLabel: string;
	/** false = 不可关字段，不出现在菜单里。 */
	isToggleable: boolean;
	isVisibleByDefault: boolean;
}

export const TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_DEFINITIONS: readonly TaskSpotlightSearchResultRowFieldDefinition[] =
	[
		{ id: "stage_indicator", menuLabel: "Stage color", isToggleable: false, isVisibleByDefault: true },
		{ id: "primary_text", menuLabel: "Title", isToggleable: false, isVisibleByDefault: true },
		{ id: "agent_identity", menuLabel: "Agent", isToggleable: true, isVisibleByDefault: true },
		{ id: "task_id_badge", menuLabel: "Task ID", isToggleable: true, isVisibleByDefault: true },
		{ id: "project_name_badge", menuLabel: "Project", isToggleable: true, isVisibleByDefault: true },
		{ id: "stage_label_badge", menuLabel: "Stage name", isToggleable: true, isVisibleByDefault: true },
		{ id: "relative_time_pill", menuLabel: "Time", isToggleable: true, isVisibleByDefault: true },
		{ id: "session_activity_line", menuLabel: "Session state", isToggleable: true, isVisibleByDefault: true },
		{ id: "prompt_match_snippet_line", menuLabel: "Prompt match", isToggleable: true, isVisibleByDefault: true },
	];

export const TOGGLEABLE_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_DEFINITIONS =
	TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_DEFINITIONS.filter((definition) => definition.isToggleable);

export type TaskSpotlightSearchResultRowFieldVisibility = Readonly<
	Record<TaskSpotlightSearchResultRowFieldId, boolean>
>;

export const DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY: TaskSpotlightSearchResultRowFieldVisibility =
	Object.fromEntries(
		TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_DEFINITIONS.map((definition) => [
			definition.id,
			definition.isVisibleByDefault,
		]),
	) as TaskSpotlightSearchResultRowFieldVisibility;

/**
 * 存档只保留可 toggle 字段的开关；不可关字段恒为 true，不受存档影响（否则一份坏存档能把主文本关掉，
 * 得到一列没有内容的行）。未知字段 id、非布尔值一律回退到默认。
 */
export function normalizeTaskSpotlightSearchResultRowFieldVisibility(
	rawValue: unknown,
): TaskSpotlightSearchResultRowFieldVisibility {
	const storedVisibility =
		typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)
			? (rawValue as Record<string, unknown>)
			: {};
	const normalized: Record<string, boolean> = {};
	for (const definition of TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_DEFINITIONS) {
		if (!definition.isToggleable) {
			normalized[definition.id] = true;
			continue;
		}
		const storedValue = storedVisibility[definition.id];
		normalized[definition.id] = typeof storedValue === "boolean" ? storedValue : definition.isVisibleByDefault;
	}
	return normalized as TaskSpotlightSearchResultRowFieldVisibility;
}
