import { Fzf } from "fzf";

import type { ProjectNumericSlotGroupNumber } from "@/hooks/use-project-numeric-slot-group-assignments";
import type { RecentlyUsedProjectSwitchHistory } from "@/hooks/use-recently-used-project-switch-history";
import type { RuntimeProjectSummary } from "@/runtime/types";

export const PROJECT_SWITCHER_TABLE_SORT_ORDERS = ["last_visited_desc", "name_asc"] as const;

export type ProjectSwitcherTableSortOrder = (typeof PROJECT_SWITCHER_TABLE_SORT_ORDERS)[number];

export const DEFAULT_PROJECT_SWITCHER_TABLE_SORT_ORDER: ProjectSwitcherTableSortOrder = "last_visited_desc";

export function normalizeProjectSwitcherTableSortOrder(rawValue: string): ProjectSwitcherTableSortOrder | null {
	return (PROJECT_SWITCHER_TABLE_SORT_ORDERS as readonly string[]).includes(rawValue)
		? (rawValue as ProjectSwitcherTableSortOrder)
		: null;
}

export interface ProjectSwitcherRow {
	project: RuntimeProjectSummary;
	/** null = 本设备从未访问过（例如刚从另一台机器同步过来的项目列表）。 */
	lastVisitedEpochMs: number | null;
	numericSlotGroupNumber: ProjectNumericSlotGroupNumber | null;
	/** 过滤命中时的项目名高亮位置；未过滤或仅命中路径时为 null。 */
	projectNameMatchPositions: ReadonlySet<number> | null;
}

export interface BuildProjectSwitcherRowsInput {
	projects: readonly RuntimeProjectSummary[];
	lastVisitedEpochMsByProjectId: RecentlyUsedProjectSwitchHistory;
	numericSlotGroupNumberByProjectId: ReadonlyMap<string, ProjectNumericSlotGroupNumber>;
	sortOrder: ProjectSwitcherTableSortOrder;
}

function compareByProjectNameAscending(a: RuntimeProjectSummary, b: RuntimeProjectSummary): number {
	const nameComparison = a.name.localeCompare(b.name);
	if (nameComparison !== 0) {
		return nameComparison;
	}
	// 同名项目（不同目录下的同名 repo）按路径定序，保证渲染顺序确定。
	return a.path.localeCompare(b.path);
}

/**
 * 把项目列表转成有序的表格行。
 *
 * recency 排序下：访问过的项目按最近使用在前；**从未访问过的项目排在最后并按名字字母序**——
 * 把它们混进 recency 段会让「没有时间戳」表现得像「很久以前访问过」，那是假信息。
 */
export function buildProjectSwitcherRows({
	projects,
	lastVisitedEpochMsByProjectId,
	numericSlotGroupNumberByProjectId,
	sortOrder,
}: BuildProjectSwitcherRowsInput): ProjectSwitcherRow[] {
	const rows: ProjectSwitcherRow[] = projects.map((project) => ({
		project,
		lastVisitedEpochMs: lastVisitedEpochMsByProjectId[project.id] ?? null,
		numericSlotGroupNumber: numericSlotGroupNumberByProjectId.get(project.id) ?? null,
		projectNameMatchPositions: null,
	}));

	if (sortOrder === "name_asc") {
		return rows.sort((a, b) => compareByProjectNameAscending(a.project, b.project));
	}

	return rows.sort((a, b) => {
		if (a.lastVisitedEpochMs === null && b.lastVisitedEpochMs === null) {
			return compareByProjectNameAscending(a.project, b.project);
		}
		if (a.lastVisitedEpochMs === null) {
			return 1;
		}
		if (b.lastVisitedEpochMs === null) {
			return -1;
		}
		const timestampDifference = b.lastVisitedEpochMs - a.lastVisitedEpochMs;
		if (timestampDifference !== 0) {
			return timestampDifference;
		}
		return compareByProjectNameAscending(a.project, b.project);
	});
}

/**
 * 模糊过滤。项目名走 fzf（与 search-select-dropdown 同一套，带高亮位置），
 * 路径只做大小写不敏感子串兜底——同名 repo 分布在不同目录时，路径是唯一的区分手段。
 *
 * 名字命中按 fzf 评分排序在前，仅路径命中的行保持传入顺序追加在后。
 */
export function filterProjectSwitcherRowsByQuery(
	rows: readonly ProjectSwitcherRow[],
	query: string,
): ProjectSwitcherRow[] {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return rows.slice();
	}

	const finder = new Fzf(rows.slice(), {
		selector: (row: ProjectSwitcherRow) => row.project.name,
	});
	const nameMatches = finder.find(trimmedQuery);
	const matchedProjectIds = new Set(nameMatches.map((match) => match.item.project.id));

	const nameMatchedRows: ProjectSwitcherRow[] = nameMatches.map((match) => ({
		...match.item,
		projectNameMatchPositions: match.positions,
	}));

	const lowercasedQuery = trimmedQuery.toLowerCase();
	const pathOnlyMatchedRows = rows.filter(
		(row) => !matchedProjectIds.has(row.project.id) && row.project.path.toLowerCase().includes(lowercasedQuery),
	);

	return [...nameMatchedRows, ...pathOnlyMatchedRows];
}

/**
 * 打开切换器时的默认高亮行 = 第一个**非当前项目**的行，让「打开 + Enter」等于跳回上一个项目
 * （alt-tab 语义）。全都是当前项目（只有一个项目）时回落到 0。
 */
export function resolveInitialActiveProjectSwitcherRowIndex(
	rows: readonly ProjectSwitcherRow[],
	currentProjectId: string | null,
): number {
	const firstOtherProjectIndex = rows.findIndex((row) => row.project.id !== currentProjectId);
	return firstOtherProjectIndex >= 0 ? firstOtherProjectIndex : 0;
}
