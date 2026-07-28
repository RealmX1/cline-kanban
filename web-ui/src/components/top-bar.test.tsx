import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "@/components/top-bar";
import { TooltipProvider } from "@/components/ui/tooltip";

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TopBar script shortcut onboarding", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("opens first-shortcut dialog from Run and saves when command is provided", async () => {
		const onCreateFirstShortcut = vi.fn(async () => ({ ok: true }));
		const onRunShortcut = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						shortcuts={[]}
						onRunShortcut={onRunShortcut}
						onCreateFirstShortcut={onCreateFirstShortcut}
					/>
				</TooltipProvider>,
			);
		});

		const runButton = findButtonByText(container, "Run");
		expect(runButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runButton?.click();
		});

		expect(document.body.textContent).toContain("Set up your first script shortcut");

		const commandInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "npm run dev",
		) as HTMLInputElement | undefined;
		expect(commandInput).toBeDefined();
		expect(commandInput?.value).toBe("");

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);

		await act(async () => {
			if (!commandInput) {
				return;
			}
			setInputValue(commandInput, "pnpm dev");
		});
		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onCreateFirstShortcut).toHaveBeenCalledWith({
			label: "Run",
			command: "pnpm dev",
			icon: "play",
		});
		expect(onRunShortcut).not.toHaveBeenCalled();
	});

	it("opens settings when the runtime hint is clicked", async () => {
		const onOpenSettings = vi.fn();

		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						runtimeHint="No agent configured"
						onOpenSettings={onOpenSettings}
					/>
				</TooltipProvider>,
			);
		});

		const runtimeHintButton = findButtonByText(container, "No agent configured");
		expect(runtimeHintButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runtimeHintButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runtimeHintButton?.click();
		});

		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("renders no project switcher unless one is supplied", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						workspacePath="/repos/alpha"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[data-testid="top-bar-project-switcher-trigger"]')).toBeNull();
	});

	it("places the project switcher before the workspace path breadcrumb", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						workspacePath="/repos/alpha"
						projectSwitcher={{
							projects: [
								{
									id: "alpha",
									name: "alpha",
									path: "/repos/alpha",
									taskCounts: {
										backlog: 0,
										in_progress: 0,
										review: 0,
										validation: 0,
										trash: 0,
									},
									availability: { status: "available" },
									inProgressTaskDetails: [],
								},
							],
							currentProjectId: "alpha",
							navigationCurrentProjectId: "alpha",
							lastVisitedEpochMsByProjectId: {},
							numericSlotGroupNumberByProjectId: new Map(),
							isProjectListLoading: false,
							isProjectSwitching: false,
							onSelectProject: () => {},
							onAddProject: () => {},
							onAssignProjectToNumericSlotGroupNumber: () => {},
							onClearNumericSlotGroupNumber: () => {},
						}}
					/>
				</TooltipProvider>,
			);
		});

		const switcherTrigger = container.querySelector('[data-testid="top-bar-project-switcher-trigger"]');
		const workspacePath = container.querySelector('[data-testid="workspace-path"]');
		if (!switcherTrigger || !workspacePath) {
			throw new Error("Expected both the project switcher trigger and the workspace path breadcrumb.");
		}
		// 把「切换器在面包屑左侧」这一位置决策钉成回归护栏——面包屑本身刻意一行未改。
		expect(switcherTrigger.compareDocumentPosition(workspacePath) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("toggles the focused task Changes sidebar from the top navigation", async () => {
		const onToggleTaskChangesSidebar = vi.fn();
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						isTaskChangesSidebarOpen={false}
						onToggleTaskChangesSidebar={onToggleTaskChangesSidebar}
					/>
				</TooltipProvider>,
			);
		});

		const changesButton = container.querySelector('button[aria-label="Show task changes"]');
		expect(changesButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => (changesButton as HTMLButtonElement).click());
		expect(onToggleTaskChangesSidebar).toHaveBeenCalledTimes(1);
	});
});
