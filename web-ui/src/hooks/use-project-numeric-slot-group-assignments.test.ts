import { describe, expect, it } from "vitest";

import {
	assignProjectToNumericSlotGroup,
	clearProjectNumericSlotGroup,
	EMPTY_PROJECT_NUMERIC_SLOT_GROUP_ASSIGNMENTS,
	normalizeProjectNumericSlotGroupAssignments,
	type ProjectNumericSlotGroupAssignments,
	prunePermanentlyRemovedProjectsFromNumericSlotGroupAssignments,
	selectNumericSlotGroupNumberByProjectId,
} from "@/hooks/use-project-numeric-slot-group-assignments";

describe("normalizeProjectNumericSlotGroupAssignments", () => {
	it("rejects shapes that are valid JSON but not a slot → projectId record", () => {
		expect(normalizeProjectNumericSlotGroupAssignments(["project-a"])).toEqual({});
		expect(normalizeProjectNumericSlotGroupAssignments(null)).toEqual({});
		expect(normalizeProjectNumericSlotGroupAssignments("1")).toEqual({});
	});

	it("drops out-of-range slots and non-string project ids", () => {
		expect(
			normalizeProjectNumericSlotGroupAssignments({
				"1": "project-a",
				"0": "project-b",
				"10": "project-c",
				"1.5": "project-d",
				two: "project-e",
				"3": 42,
				"4": "",
			}),
		).toEqual({ "1": "project-a" });
	});
});

describe("assignProjectToNumericSlotGroup", () => {
	it("binds a project to an empty slot", () => {
		expect(assignProjectToNumericSlotGroup(EMPTY_PROJECT_NUMERIC_SLOT_GROUP_ASSIGNMENTS, 3, "project-a")).toEqual({
			"3": "project-a",
		});
	});

	it("moves a project off its previous slot so it only ever occupies one", () => {
		const assignments: ProjectNumericSlotGroupAssignments = { "1": "project-a", "2": "project-b" };
		expect(assignProjectToNumericSlotGroup(assignments, 5, "project-a")).toEqual({
			"2": "project-b",
			"5": "project-a",
		});
	});

	it("replaces whatever occupied the target slot", () => {
		const assignments: ProjectNumericSlotGroupAssignments = { "1": "project-a" };
		expect(assignProjectToNumericSlotGroup(assignments, 1, "project-b")).toEqual({ "1": "project-b" });
	});

	it("returns the same reference when the binding already holds", () => {
		const assignments: ProjectNumericSlotGroupAssignments = { "1": "project-a" };
		expect(assignProjectToNumericSlotGroup(assignments, 1, "project-a")).toBe(assignments);
	});
});

describe("clearProjectNumericSlotGroup", () => {
	it("clears a bound slot", () => {
		expect(clearProjectNumericSlotGroup({ "1": "project-a", "2": "project-b" }, 1)).toEqual({
			"2": "project-b",
		});
	});

	it("returns the same reference when the slot is already empty", () => {
		const assignments: ProjectNumericSlotGroupAssignments = { "1": "project-a" };
		expect(clearProjectNumericSlotGroup(assignments, 2)).toBe(assignments);
	});
});

describe("prunePermanentlyRemovedProjectsFromNumericSlotGroupAssignments", () => {
	it("returns the same reference when every bound project still exists", () => {
		const assignments: ProjectNumericSlotGroupAssignments = { "1": "project-a" };
		expect(prunePermanentlyRemovedProjectsFromNumericSlotGroupAssignments(assignments, new Set(["project-a"]))).toBe(
			assignments,
		);
	});

	it("clears slots whose project was permanently deleted", () => {
		expect(
			prunePermanentlyRemovedProjectsFromNumericSlotGroupAssignments(
				{ "1": "project-a", "2": "project-b" },
				new Set(["project-b"]),
			),
		).toEqual({ "2": "project-b" });
	});
});

describe("selectNumericSlotGroupNumberByProjectId", () => {
	it("inverts the slot map", () => {
		const byProjectId = selectNumericSlotGroupNumberByProjectId({ "1": "project-a", "7": "project-b" });
		expect(byProjectId.get("project-a")).toBe(1);
		expect(byProjectId.get("project-b")).toBe(7);
		expect(byProjectId.get("project-c")).toBeUndefined();
	});
});
