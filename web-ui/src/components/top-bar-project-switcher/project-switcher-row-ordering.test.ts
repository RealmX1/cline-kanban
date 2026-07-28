import { describe, expect, it } from "vitest";

import {
	buildProjectSwitcherRows,
	filterProjectSwitcherRowsByQuery,
	normalizeProjectSwitcherTableSortOrder,
	resolveInitialActiveProjectSwitcherRowIndex,
} from "@/components/top-bar-project-switcher/project-switcher-row-ordering";
import type { RuntimeProjectSummary } from "@/runtime/types";

function createProject(id: string, name: string, path: string): RuntimeProjectSummary {
	return {
		id,
		name,
		path,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		availability: { status: "available" },
		inProgressTaskDetails: [],
	};
}

const PROJECT_ALPHA = createProject("project-alpha", "alpha", "/repos/alpha");
const PROJECT_BRAVO = createProject("project-bravo", "bravo", "/repos/bravo");
const PROJECT_CHARLIE = createProject("project-charlie", "charlie", "/work/charlie");

describe("normalizeProjectSwitcherTableSortOrder", () => {
	it("accepts the known sort orders and rejects everything else", () => {
		expect(normalizeProjectSwitcherTableSortOrder("name_asc")).toBe("name_asc");
		expect(normalizeProjectSwitcherTableSortOrder("last_visited_desc")).toBe("last_visited_desc");
		expect(normalizeProjectSwitcherTableSortOrder("recency")).toBeNull();
		expect(normalizeProjectSwitcherTableSortOrder("")).toBeNull();
	});
});

describe("buildProjectSwitcherRows", () => {
	it("orders by recency and pushes never-visited projects to the end alphabetically", () => {
		const rows = buildProjectSwitcherRows({
			projects: [PROJECT_ALPHA, PROJECT_BRAVO, PROJECT_CHARLIE],
			lastVisitedEpochMsByProjectId: { "project-bravo": 2_000, "project-charlie": 5_000 },
			numericSlotGroupNumberByProjectId: new Map(),
			sortOrder: "last_visited_desc",
		});
		expect(rows.map((row) => row.project.id)).toEqual(["project-charlie", "project-bravo", "project-alpha"]);
		expect(rows[2]?.lastVisitedEpochMs).toBeNull();
	});

	it("orders alphabetically when asked, regardless of recency", () => {
		const rows = buildProjectSwitcherRows({
			projects: [PROJECT_CHARLIE, PROJECT_ALPHA, PROJECT_BRAVO],
			lastVisitedEpochMsByProjectId: { "project-charlie": 5_000 },
			numericSlotGroupNumberByProjectId: new Map(),
			sortOrder: "name_asc",
		});
		expect(rows.map((row) => row.project.id)).toEqual(["project-alpha", "project-bravo", "project-charlie"]);
	});

	it("carries the numeric slot group binding onto the row", () => {
		const rows = buildProjectSwitcherRows({
			projects: [PROJECT_ALPHA],
			lastVisitedEpochMsByProjectId: {},
			numericSlotGroupNumberByProjectId: new Map([["project-alpha", 4 as const]]),
			sortOrder: "name_asc",
		});
		expect(rows[0]?.numericSlotGroupNumber).toBe(4);
	});

	it("skips ghost history entries whose project no longer exists", () => {
		const rows = buildProjectSwitcherRows({
			projects: [PROJECT_ALPHA],
			lastVisitedEpochMsByProjectId: { "project-deleted": 9_000, "project-alpha": 1_000 },
			numericSlotGroupNumberByProjectId: new Map(),
			sortOrder: "last_visited_desc",
		});
		expect(rows.map((row) => row.project.id)).toEqual(["project-alpha"]);
	});
});

describe("filterProjectSwitcherRowsByQuery", () => {
	const rows = buildProjectSwitcherRows({
		projects: [PROJECT_ALPHA, PROJECT_BRAVO, PROJECT_CHARLIE],
		lastVisitedEpochMsByProjectId: {},
		numericSlotGroupNumberByProjectId: new Map(),
		sortOrder: "name_asc",
	});

	it("returns every row for a blank query", () => {
		expect(filterProjectSwitcherRowsByQuery(rows, "   ")).toHaveLength(3);
	});

	it("fuzzy matches the project name and reports highlight positions", () => {
		const filtered = filterProjectSwitcherRowsByQuery(rows, "brv");
		expect(filtered.map((row) => row.project.id)).toEqual(["project-bravo"]);
		expect(filtered[0]?.projectNameMatchPositions?.size).toBe(3);
	});

	it("falls back to a path substring match when the name does not match", () => {
		const filtered = filterProjectSwitcherRowsByQuery(rows, "/work/");
		expect(filtered.map((row) => row.project.id)).toEqual(["project-charlie"]);
		expect(filtered[0]?.projectNameMatchPositions).toBeNull();
	});

	it("returns nothing when neither the name nor the path matches", () => {
		expect(filterProjectSwitcherRowsByQuery(rows, "zzzz")).toHaveLength(0);
	});
});

describe("resolveInitialActiveProjectSwitcherRowIndex", () => {
	const rows = buildProjectSwitcherRows({
		projects: [PROJECT_ALPHA, PROJECT_BRAVO],
		lastVisitedEpochMsByProjectId: {},
		numericSlotGroupNumberByProjectId: new Map(),
		sortOrder: "name_asc",
	});

	it("highlights the first row that is not the current project (alt-tab semantics)", () => {
		expect(resolveInitialActiveProjectSwitcherRowIndex(rows, "project-alpha")).toBe(1);
		expect(resolveInitialActiveProjectSwitcherRowIndex(rows, "project-bravo")).toBe(0);
	});

	it("falls back to the first row when there is nothing else to switch to", () => {
		const singleRow = rows.slice(0, 1);
		expect(resolveInitialActiveProjectSwitcherRowIndex(singleRow, "project-alpha")).toBe(0);
	});
});
