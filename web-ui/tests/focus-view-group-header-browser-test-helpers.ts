import { expect, type Page } from "@playwright/test";

const scrollRootSelector = "[data-task-card-column-scroll-container]";

export async function openIsolatedFocusViewCompactGroupHeadersBrowserHarness(
	page: Page,
	scope: "current" | "all",
	options: { view?: "focus" | "board"; usesGroupBoundaryFixtures?: boolean; usesPinnedFixtures?: boolean } = {},
) {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", () => {});
	await page.addInitScript(() =>
		localStorage.setItem("kanban.cross-project-task-switcher-running-section-expanded.v1", "true"),
	);
	await page.route("**/isolated-compact-focus-headers?*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	const browserHarnessQueryParameters = new URLSearchParams({ scope, view: options.view ?? "focus" });
	if (options.usesGroupBoundaryFixtures) browserHarnessQueryParameters.set("group-boundary-fixtures", "true");
	if (options.usesPinnedFixtures) browserHarnessQueryParameters.set("pinned-fixtures", "true");
	await page.goto(`/isolated-compact-focus-headers?${browserHarnessQueryParameters}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/focus-view-compact-group-headers-browser-harness.tsx" });
	await expect(
		page.locator(options.view === "board" && scope === "current" ? ".kb-board" : ".kb-task-group").first(),
	).toBeVisible();
	await expect.poll(() => pageErrors).toEqual([]);
	return pageErrors;
}

export async function setFocusViewTaskListScrollFractionAndWaitForLayout(page: Page, fraction: number) {
	await page.locator(scrollRootSelector).evaluate(async (element, position) => {
		element.scrollTop = (element.scrollHeight - element.clientHeight) * position;
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	}, fraction);
}
