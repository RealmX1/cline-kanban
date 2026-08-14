import { useCallback, useEffect, useMemo } from "react";

import { useProjectNumericSlotGroupAssignmentsPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";

/**
 * 《红警》式项目编组：把某个项目绑到 1-9 的数字槽位，之后一次按键跳过去。
 *
 * 槽位只到 9：`mod+0` 在 Electron 里是 `resetZoom`（见 packages/desktop/src/app-menu.ts），
 * 占用它会和窗口菜单打架。
 */
export const PROJECT_NUMERIC_SLOT_GROUP_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type ProjectNumericSlotGroupNumber = (typeof PROJECT_NUMERIC_SLOT_GROUP_NUMBERS)[number];

/** 槽位号（JSON 对象键只能是字符串）→ projectId。 */
export type ProjectNumericSlotGroupAssignments = Readonly<Record<string, string>>;

export const EMPTY_PROJECT_NUMERIC_SLOT_GROUP_ASSIGNMENTS: ProjectNumericSlotGroupAssignments = {};

export function isProjectNumericSlotGroupNumber(value: number): value is ProjectNumericSlotGroupNumber {
	return (PROJECT_NUMERIC_SLOT_GROUP_NUMBERS as readonly number[]).includes(value);
}

/** 同 recency 历史：合法 JSON 但形状错的存档必须在这里挡掉，react-use 不管这一层。 */
export function normalizeProjectNumericSlotGroupAssignments(rawValue: unknown): ProjectNumericSlotGroupAssignments {
	if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
		return EMPTY_PROJECT_NUMERIC_SLOT_GROUP_ASSIGNMENTS;
	}
	const normalized: Record<string, string> = {};
	for (const [slotKey, projectId] of Object.entries(rawValue)) {
		const slotNumber = Number(slotKey);
		if (!Number.isInteger(slotNumber) || !isProjectNumericSlotGroupNumber(slotNumber)) {
			continue;
		}
		if (typeof projectId !== "string" || projectId.length === 0) {
			continue;
		}
		normalized[String(slotNumber)] = projectId;
	}
	return normalized;
}

/**
 * 把项目绑到槽位。一个项目同时只能占一个槽位——绑新槽位时自动从旧槽位摘除，
 * 否则同一个项目会在多个槽位下重复出现、表格里也就没法只显示一个 `Kbd`。
 *
 * 无需改动时返回入参同一引用（同 recency 历史的写入循环护栏）。
 */
export function assignProjectToNumericSlotGroup(
	assignments: ProjectNumericSlotGroupAssignments,
	slotNumber: ProjectNumericSlotGroupNumber,
	projectId: string,
): ProjectNumericSlotGroupAssignments {
	if (!projectId) {
		return assignments;
	}
	const slotKey = String(slotNumber);
	const slotKeysHoldingProject = Object.keys(assignments).filter((key) => assignments[key] === projectId);
	if (assignments[slotKey] === projectId && slotKeysHoldingProject.length === 1) {
		return assignments;
	}
	const next: Record<string, string> = { ...assignments };
	for (const key of slotKeysHoldingProject) {
		delete next[key];
	}
	next[slotKey] = projectId;
	return next;
}

export function clearProjectNumericSlotGroup(
	assignments: ProjectNumericSlotGroupAssignments,
	slotNumber: ProjectNumericSlotGroupNumber,
): ProjectNumericSlotGroupAssignments {
	const slotKey = String(slotNumber);
	if (assignments[slotKey] === undefined) {
		return assignments;
	}
	const next: Record<string, string> = { ...assignments };
	delete next[slotKey];
	return next;
}

export function prunePermanentlyRemovedProjectsFromNumericSlotGroupAssignments(
	assignments: ProjectNumericSlotGroupAssignments,
	existingProjectIds: ReadonlySet<string>,
): ProjectNumericSlotGroupAssignments {
	const removableSlotKeys = Object.keys(assignments).filter((slotKey) => {
		const projectId = assignments[slotKey];
		return projectId === undefined || !existingProjectIds.has(projectId);
	});
	if (removableSlotKeys.length === 0) {
		return assignments;
	}
	const next: Record<string, string> = { ...assignments };
	for (const slotKey of removableSlotKeys) {
		delete next[slotKey];
	}
	return next;
}

export function selectNumericSlotGroupNumberByProjectId(
	assignments: ProjectNumericSlotGroupAssignments,
): ReadonlyMap<string, ProjectNumericSlotGroupNumber> {
	const byProjectId = new Map<string, ProjectNumericSlotGroupNumber>();
	for (const slotNumber of PROJECT_NUMERIC_SLOT_GROUP_NUMBERS) {
		const projectId = assignments[String(slotNumber)];
		if (projectId !== undefined) {
			byProjectId.set(projectId, slotNumber);
		}
	}
	return byProjectId;
}

export interface UseProjectNumericSlotGroupAssignmentsInput {
	knownProjectIds: readonly string[];
	/** 首帧与断连期 `projects` 为空，此时裁剪会清空全部编组。同 recency 历史的 gate。 */
	canPruneMissingProjects: boolean;
}

export interface UseProjectNumericSlotGroupAssignmentsResult {
	numericSlotGroupAssignments: ProjectNumericSlotGroupAssignments;
	numericSlotGroupNumberByProjectId: ReadonlyMap<string, ProjectNumericSlotGroupNumber>;
	assignProjectToNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber, projectId: string) => void;
	clearNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber) => void;
}

export function useProjectNumericSlotGroupAssignments({
	knownProjectIds,
	canPruneMissingProjects,
}: UseProjectNumericSlotGroupAssignmentsInput): UseProjectNumericSlotGroupAssignmentsResult {
	const [storedAssignments, setStoredAssignments] = useProjectNumericSlotGroupAssignmentsPreference();
	const normalizedAssignments = useMemo(
		() => normalizeProjectNumericSlotGroupAssignments(storedAssignments),
		[storedAssignments],
	);
	const knownProjectIdSet = useMemo(() => new Set(knownProjectIds), [knownProjectIds]);

	useEffect(() => {
		if (!canPruneMissingProjects) {
			return;
		}
		const prunedAssignments = prunePermanentlyRemovedProjectsFromNumericSlotGroupAssignments(
			normalizedAssignments,
			knownProjectIdSet,
		);
		if (prunedAssignments === normalizedAssignments) {
			return;
		}
		setStoredAssignments(prunedAssignments);
	}, [canPruneMissingProjects, knownProjectIdSet, normalizedAssignments, setStoredAssignments]);

	const assignProjectToNumericSlotGroupNumber = useCallback(
		(slotNumber: ProjectNumericSlotGroupNumber, projectId: string) => {
			const nextAssignments = assignProjectToNumericSlotGroup(normalizedAssignments, slotNumber, projectId);
			if (nextAssignments === normalizedAssignments) {
				return;
			}
			setStoredAssignments(nextAssignments);
		},
		[normalizedAssignments, setStoredAssignments],
	);

	const clearNumericSlotGroupNumber = useCallback(
		(slotNumber: ProjectNumericSlotGroupNumber) => {
			const nextAssignments = clearProjectNumericSlotGroup(normalizedAssignments, slotNumber);
			if (nextAssignments === normalizedAssignments) {
				return;
			}
			setStoredAssignments(nextAssignments);
		},
		[normalizedAssignments, setStoredAssignments],
	);

	const numericSlotGroupNumberByProjectId = useMemo(
		() => selectNumericSlotGroupNumberByProjectId(normalizedAssignments),
		[normalizedAssignments],
	);

	return {
		numericSlotGroupAssignments: normalizedAssignments,
		numericSlotGroupNumberByProjectId,
		assignProjectToNumericSlotGroupNumber,
		clearNumericSlotGroupNumber,
	};
}
