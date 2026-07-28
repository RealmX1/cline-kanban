import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	TopBarProjectSwitcher,
	type TopBarProjectSwitcherState,
} from "@/components/top-bar-project-switcher/top-bar-project-switcher";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProjectNumericSlotGroupNumber } from "@/hooks/use-project-numeric-slot-group-assignments";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

function createProject(overrides: Partial<RuntimeProjectSummary> & { id: string }): RuntimeProjectSummary {
	return {
		name: overrides.id,
		path: `/repos/${overrides.id}`,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		availability: { status: "available" },
		inProgressTaskDetails: [],
		...overrides,
	};
}

const PROJECT_ALPHA = createProject({ id: "alpha" });
const PROJECT_BRAVO = createProject({ id: "bravo" });
const PROJECT_CHARLIE = createProject({
	id: "charlie",
	availability: { status: "unavailable", reason: "project_path_missing" },
});

function createSwitcherState(overrides: Partial<TopBarProjectSwitcherState> = {}): TopBarProjectSwitcherState {
	return {
		projects: [PROJECT_ALPHA, PROJECT_BRAVO, PROJECT_CHARLIE],
		currentProjectId: "alpha",
		navigationCurrentProjectId: "alpha",
		// bravo 最近访问，其次 charlie，最后 alpha。
		lastVisitedEpochMsByProjectId: { alpha: 1_000, bravo: 3_000, charlie: 2_000 },
		numericSlotGroupNumberByProjectId: new Map<string, ProjectNumericSlotGroupNumber>(),
		isProjectListLoading: false,
		isProjectSwitching: false,
		onSelectProject: () => {},
		onAddProject: () => {},
		onAssignProjectToNumericSlotGroupNumber: () => {},
		onClearNumericSlotGroupNumber: () => {},
		...overrides,
	};
}

function queryTrigger(): HTMLButtonElement | null {
	return document.body.querySelector<HTMLButtonElement>('[data-testid="top-bar-project-switcher-trigger"]');
}

function queryRowProjectIds(): string[] {
	return Array.from(document.body.querySelectorAll('[data-testid="project-switcher-table-row"]')).map(
		(row) => row.getAttribute("data-project-id") ?? "",
	);
}

describe("TopBarProjectSwitcher", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		// Radix 的 modal 层（DropdownMenu）在 portal 里，卸载后偶有残留节点；不清干净会影响下一个用例。
		document.body.replaceChildren();
		localStorage.clear();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderSwitcher(state: TopBarProjectSwitcherState): Promise<void> {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBarProjectSwitcher {...state} />
				</TooltipProvider>,
			);
		});
	}

	async function openSwitcher(state?: TopBarProjectSwitcherState): Promise<void> {
		await renderSwitcher(state ?? createSwitcherState());
		const trigger = queryTrigger();
		await act(async () => {
			trigger?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			trigger?.click();
		});
	}

	it("renders nothing when the runtime knows about no projects", async () => {
		await renderSwitcher(createSwitcherState({ projects: [] }));
		expect(queryTrigger()).toBeNull();
	});

	it("disables the trigger while the project list is still loading", async () => {
		await renderSwitcher(createSwitcherState({ projects: [], isProjectListLoading: true }));
		expect(queryTrigger()?.disabled).toBe(true);
	});

	it("shows the live agent task count of the project being navigated to", async () => {
		await renderSwitcher(
			createSwitcherState({
				projects: [
					createProject({
						id: "alpha",
						inProgressTaskDetails: [
							{
								taskId: "task-1",
								title: "task-1",
								agentId: "claude",
								createdAt: 1,
								lastOutputAt: 2,
								lastSubstantiveOutputAt: 2,
								turnOwner: "agent",
								liveness: "live",
							},
							{
								taskId: "task-2",
								title: "task-2",
								agentId: "claude",
								createdAt: 1,
								lastOutputAt: 2,
								lastSubstantiveOutputAt: 2,
								turnOwner: "user",
								liveness: "live",
							},
						],
					}),
				],
			}),
		);
		expect(
			document.body.querySelector('[data-testid="top-bar-project-switcher-live-agent-task-count"]')?.textContent,
		).toBe("1");
	});

	it("orders rows by recency and can switch to alphabetical, persisting the preference", async () => {
		await openSwitcher();
		expect(queryRowProjectIds()).toEqual(["bravo", "charlie", "alpha"]);

		const alphabeticalSortButton = document.body.querySelector<HTMLButtonElement>(
			'[data-testid="project-switcher-sort-order-name_asc"]',
		);
		await act(async () => alphabeticalSortButton?.click());

		expect(queryRowProjectIds()).toEqual(["alpha", "bravo", "charlie"]);
		expect(localStorage.getItem(LocalStorageKey.ProjectSwitcherTableSortOrder)).toBe("name_asc");
	});

	it("marks the current project and flags unavailable projects", async () => {
		await openSwitcher();
		const currentRow = document.body
			.querySelector('[data-testid="project-switcher-current-project-marker"]')
			?.closest("[data-project-id]");
		expect(currentRow?.getAttribute("data-project-id")).toBe("alpha");

		const unavailableRow = document.body
			.querySelector('[aria-label="Project unavailable"]')
			?.closest("[data-project-id]");
		expect(unavailableRow?.getAttribute("data-project-id")).toBe("charlie");
	});

	it("switches to the clicked project and ignores a click on the current project", async () => {
		const onSelectProject = vi.fn();
		await openSwitcher(createSwitcherState({ onSelectProject }));

		const bravoRow = document.body.querySelector<HTMLElement>('[data-project-id="bravo"]');
		await act(async () => bravoRow?.click());
		expect(onSelectProject).toHaveBeenCalledWith("bravo");
		expect(document.body.querySelector('[data-testid="top-bar-project-switcher-panel"]')).toBeNull();

		onSelectProject.mockClear();
		await openSwitcher(createSwitcherState({ onSelectProject }));
		const alphaRow = document.body.querySelector<HTMLElement>('[data-project-id="alpha"]');
		await act(async () => alphaRow?.click());
		expect(onSelectProject).not.toHaveBeenCalled();
	});

	it("selects the first non-current project when Enter is pressed right after opening", async () => {
		const onSelectProject = vi.fn();
		await openSwitcher(createSwitcherState({ onSelectProject }));

		const panel = document.body.querySelector('[data-testid="top-bar-project-switcher-panel"]');
		await act(async () => {
			panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(onSelectProject).toHaveBeenCalledWith("bravo");
	});

	it("keeps the load-bearing columns out of the column menu and toggles the optional ones", async () => {
		await openSwitcher();
		expect(document.body.textContent).toContain("Awaiting you");
		expect(document.body.textContent).not.toContain("Task distribution");

		const columnMenuTrigger = document.body.querySelector<HTMLButtonElement>(
			'[data-testid="project-switcher-column-visibility-menu-trigger"]',
		);
		await act(async () => {
			// Radix DropdownMenu 的 trigger 只认 pointerdown（Popover 认 click），两者不能混用。
			columnMenuTrigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
		});

		const menuItemLabels = Array.from(document.body.querySelectorAll('[role="menuitemcheckbox"]')).map(
			(item) => item.textContent?.trim() ?? "",
		);
		expect(menuItemLabels).toEqual(["Slot", "Awaiting you", "Task distribution (B/IP/R/V)", "Last visited"]);

		const awaitingYouMenuItem = Array.from(document.body.querySelectorAll('[role="menuitemcheckbox"]')).find(
			(item) => item.textContent?.trim() === "Awaiting you",
		);
		await act(async () => (awaitingYouMenuItem as HTMLElement | undefined)?.click());

		const columnHeaderLabels = Array.from(document.body.querySelectorAll("th")).map(
			(header) => header.textContent?.trim() ?? "",
		);
		expect(columnHeaderLabels).not.toContain("Awaiting you");
		expect(localStorage.getItem(LocalStorageKey.ProjectSwitcherTableColumnVisibility)).toContain(
			'"awaiting_user_task_count":false',
		);
	});

	it("hides the numeric slot group column from both the header and the rows once it is toggled off", async () => {
		await openSwitcher();
		expect(
			Array.from(document.body.querySelectorAll("th")).map((header) => header.textContent?.trim() ?? ""),
		).toContain("Slot");

		const columnMenuTrigger = document.body.querySelector<HTMLButtonElement>(
			'[data-testid="project-switcher-column-visibility-menu-trigger"]',
		);
		await act(async () => {
			columnMenuTrigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
		});

		const slotMenuItem = Array.from(document.body.querySelectorAll('[role="menuitemcheckbox"]')).find(
			(item) => item.textContent?.trim() === "Slot",
		);
		await act(async () => (slotMenuItem as HTMLElement | undefined)?.click());

		const columnHeaderLabels = Array.from(document.body.querySelectorAll("th")).map(
			(header) => header.textContent?.trim() ?? "",
		);
		expect(columnHeaderLabels).not.toContain("Slot");
		expect(document.body.querySelector('[data-testid="project-switcher-numeric-slot-cell-trigger"]')).toBeNull();
		expect(localStorage.getItem(LocalStorageKey.ProjectSwitcherTableColumnVisibility)).toContain(
			'"numeric_slot_group":false',
		);
	});

	it("binds a numeric slot group from inside the table without switching projects", async () => {
		const onAssignProjectToNumericSlotGroupNumber = vi.fn();
		const onSelectProject = vi.fn();
		await openSwitcher(createSwitcherState({ onAssignProjectToNumericSlotGroupNumber, onSelectProject }));

		const bravoRow = document.body.querySelector<HTMLElement>('[data-project-id="bravo"]');
		const slotTrigger = bravoRow?.querySelector<HTMLButtonElement>(
			'[data-testid="project-switcher-numeric-slot-cell-trigger"]',
		);
		await act(async () => slotTrigger?.click());

		const slotButton = Array.from(document.body.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "2",
		);
		await act(async () => slotButton?.click());

		expect(onAssignProjectToNumericSlotGroupNumber).toHaveBeenCalledWith(2, "bravo");
		expect(onSelectProject).not.toHaveBeenCalled();
	});

	it("shows the bound slot number for a project that already has one", async () => {
		await openSwitcher(
			createSwitcherState({
				numericSlotGroupNumberByProjectId: new Map<string, ProjectNumericSlotGroupNumber>([["bravo", 7]]),
			}),
		);
		const bravoRow = document.body.querySelector<HTMLElement>('[data-project-id="bravo"]');
		expect(bravoRow?.querySelector("kbd")?.textContent).toBe("7");
	});

	it("forwards the Add project action and closes the panel", async () => {
		const onAddProject = vi.fn();
		await openSwitcher(createSwitcherState({ onAddProject }));

		const addProjectButton = document.body.querySelector<HTMLButtonElement>(
			'[data-testid="project-switcher-add-project"]',
		);
		await act(async () => addProjectButton?.click());

		expect(onAddProject).toHaveBeenCalledTimes(1);
		expect(document.body.querySelector('[data-testid="top-bar-project-switcher-panel"]')).toBeNull();
	});

	it("only offers the filter input once the project list is long enough to warrant it", async () => {
		await openSwitcher();
		expect(document.body.querySelector('[data-testid="project-switcher-filter-input"]')).toBeNull();

		await act(async () => {
			root.unmount();
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		const manyProjects = Array.from({ length: 8 }, (_unused, index) => createProject({ id: `project-${index}` }));
		await openSwitcher(
			createSwitcherState({
				projects: manyProjects,
				currentProjectId: "project-0",
				navigationCurrentProjectId: "project-0",
			}),
		);
		expect(document.body.querySelector('[data-testid="project-switcher-filter-input"]')).not.toBeNull();
	});
});
