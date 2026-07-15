import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UnavailableProjectRuntimeState } from "@/components/unavailable-project-runtime-state";
import type { RuntimeProjectSummary } from "@/runtime/types";

const UNAVAILABLE_PROJECT: RuntimeProjectSummary = {
	id: "project-1",
	name: "Cline Kanban",
	path: "/projects/cline-kanban",
	taskCounts: {
		backlog: 7,
		in_progress: 4,
		review: 19,
		validation: 29,
		trash: 55,
	},
	availability: { status: "unavailable", reason: "git_work_tree_unavailable" },
	inProgressTaskDetails: [],
};

describe("UnavailableProjectRuntimeState", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("reports retained Kanban data, the availability reason, and every task count", () => {
		act(() => {
			root.render(<UnavailableProjectRuntimeState project={UNAVAILABLE_PROJECT} onRecheck={() => {}} />);
		});

		expect(container.textContent).toContain("Project unavailable");
		expect(container.textContent).toContain("/projects/cline-kanban");
		expect(container.textContent).toContain("Git work tree could not be verified");
		expect(container.textContent).toContain("Kanban data retained; no cleanup performed");
		for (const expectedCount of ["Backlog 7", "In Progress 4", "Review 19", "Validation 29", "Done 55"]) {
			expect(container.textContent).toContain(expectedCount);
		}
	});

	it("rechecks only when the user activates the explicit Recheck action", () => {
		const onRecheck = vi.fn();
		act(() => {
			root.render(<UnavailableProjectRuntimeState project={UNAVAILABLE_PROJECT} onRecheck={onRecheck} />);
		});
		const recheckButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Recheck",
		);
		expect(recheckButton).toBeDefined();
		act(() => recheckButton?.click());
		expect(onRecheck).toHaveBeenCalledTimes(1);
	});
});
