import { expect, type Page, test } from "@playwright/test";

import { createPostDeployVerificationTaskReadModelTestFixture } from "../src/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";
import type { RuntimePostDeployVerificationDeploymentGroup } from "../src/runtime/types";

async function openIsolatedReview(page: Page, column = "validation", width = 1280, scriptPasses = true) {
	await page.setViewportSize({ width, height: 900 });
	const task = createPostDeployVerificationTaskReadModelTestFixture({
		checklist: [
			{
				id: "guided-item",
				label: "已观察到实际界面交互",
				checked: false,
				source: "authored",
				kind: "guided_manual",
				script: null,
				run: null,
				cleanup: null,
				guidance: {
					steps: ["点击实际界面操作并观察次数变化"],
					expectedObservation: "实际交互次数增加",
					failureSignature: "操作无响应",
					anchor: { view: "board", anchorKey: "board-column:validation" },
				},
			},
			{
				id: "script-item",
				label: "自动脚本验证真实结果",
				checked: false,
				source: "authored",
				kind: "automated_script",
				script: { entrypoint: "isolated-script.js", interpreter: "node", timeoutMs: 1000 },
				guidance: null,
				run: null,
				cleanup: null,
			},
		],
	});
	const group: RuntimePostDeployVerificationDeploymentGroup = {
		deploymentId: "11111111-1111-4111-8111-111111111111",
		workspaceId: "isolated-pdv-workspace",
		deployedSourceCommit: "abc",
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-10-23T10:00:00Z",
		foldedAtIso: null,
		tasks: [task],
	};
	const requests: string[] = [];
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs =
			route.request().method() === "POST"
				? route.request().postDataJSON()
				: JSON.parse(url.searchParams.get("input") ?? "{}");
		const responses = [];
		for (const [index, procedure] of procedures.entries()) {
			requests.push(procedure);
			if (procedure === "deployment.getPostDeployVerificationState") {
				responses.push({
					result: { data: { activeDeploymentId: group.deploymentId, deploymentGroups: [structuredClone(group)] } },
				});
			} else if (procedure === "deployment.updateVerificationChecklist") {
				await new Promise((resolve) => setTimeout(resolve, 120));
				const input = inputs[index];
				const item = task.checklist.find((entry) => entry.id === input.itemId)!;
				item.checked = input.checked;
				responses.push({ result: { data: { ok: true, task: structuredClone(task) } } });
			} else if (procedure === "deployment.runPostDeployVerificationItem") {
				await new Promise((resolve) => setTimeout(resolve, 180));
				const item = task.checklist.find((entry) => entry.id === inputs[index].itemId)!;
				item.checked = scriptPasses;
				item.run = {
					status: scriptPasses ? "passed" : "failed",
					exitCode: scriptPasses ? 0 : 1,
					startedAtIso: "2026-10-23T10:00:00Z",
					finishedAtIso: "2026-10-23T10:00:01Z",
					outputExcerpt: scriptPasses ? "脚本断言通过" : "脚本断言失败",
				};
				responses.push({ result: { data: { ok: true, task: structuredClone(task) } } });
			} else {
				responses.push({
					error: {
						message: "隔离浏览器不连接真实运行时",
						code: -32603,
						data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
					},
				});
			}
		}
		await route.fulfill({ contentType: "application/json", body: JSON.stringify(responses) });
	});
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-pdv-review?*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-pdv-review?column=${column}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({
		type: "module",
		url: "/tests/post-deploy-verification-review-before-done-browser-harness.tsx",
	});
	await page.locator(".kb-board-card-shell").hover();
	await page.getByRole("button", { name: "Move task to done", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "移入 Done 前核对", exact: true })).toBeVisible();
	await expect(page.getByRole("dialog").getByText("已观察到实际界面交互", { exact: true })).toBeVisible();
	return requests;
}

for (const column of ["review", "validation", "in_progress"]) {
	test(`${column} 卡片先核对，未完成才填原因，返回核对可继续操作`, async ({ page }) => {
		await openIsolatedReview(page, column);
		await expect(page.locator("select")).toHaveCount(0);
		await page.getByRole("button", { name: "继续填写未完成原因", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "带原因移入 Done", exact: true })).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await page.getByRole("button", { name: "返回核对", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "移入 Done 前核对", exact: true })).toBeVisible();
		if (column === "in_progress") {
			await page.getByRole("button", { name: "继续填写未完成原因", exact: true }).click();
		} else {
			await page.getByRole("dialog").locator(".kb-board-card-shell").hover();
			await page.getByRole("dialog").getByRole("button", { name: "Move task to done", exact: true }).click();
		}
		await expect(page.getByRole("dialog", { name: "带原因移入 Done", exact: true })).toBeVisible();
		await expect(page.getByLabel("结案结果")).toBeEmpty();
	});
}

for (const width of [390, 1280]) {
	test(`${width}px 引导可操作真实界面，脚本通过后直接结案`, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		const requests = await openIsolatedReview(page, "validation", width);
		await page.getByRole("button", { name: "定位并核对", exact: true }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.getByRole("button", { name: "实际界面操作", exact: true }).click();
		await expect(page.getByLabel("实际交互次数")).toHaveText("1");
		await page.getByRole("button", { name: "看到预期 ✓", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "移入 Done 前核对", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "运行验证脚本", exact: true }).click();
		await expect(page.getByRole("button", { name: "继续填写未完成原因", exact: true })).toBeDisabled();
		await expect(page.getByRole("button", { name: "完成核对并移入 Done", exact: true })).toBeEnabled();
		await page.screenshot({ path: test.info().outputPath(`pdv-review-${width}.png`) });
		const dialog = page.getByRole("dialog");
		const box = await dialog.boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		await page.getByRole("button", { name: "完成核对并移入 Done", exact: true }).click();
		await expect(page.getByLabel("结案结果")).toHaveText('{"task-1":{}}');
		expect(requests).toContain("deployment.updateVerificationChecklist");
		expect(requests).toContain("deployment.runPostDeployVerificationItem");
		expect(pageErrors).toEqual([]);
	});
}

test("脚本失败保留未完成状态，填写原因后才能结案", async ({ page }) => {
	await openIsolatedReview(page, "validation", 390, false);
	await page.getByRole("button", { name: "运行验证脚本", exact: true }).click();
	await expect(page.getByRole("dialog").getByText("失败", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "继续填写未完成原因", exact: true }).click();
	await expect(page.getByRole("button", { name: "确认移入 Done", exact: true })).toBeDisabled();
	await page
		.getByRole("combobox", { name: "应用到全部未勾项：原因", exact: true })
		.selectOption("custom_reason_described_in_reason_text");
	await page.getByRole("textbox", { name: "应用到全部未勾项：原因文本", exact: true }).fill("保留失败结果，另行处理");
	await page.getByRole("button", { name: "应用到全部未勾项", exact: true }).click();
	await page.getByRole("button", { name: "返回核对", exact: true }).click();
	await page.getByRole("button", { name: "继续填写未完成原因", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "应用到全部未勾项：原因文本", exact: true })).toHaveValue(
		"保留失败结果，另行处理",
	);
	await page.getByRole("button", { name: "确认移入 Done", exact: true }).click();
	await expect(page.getByLabel("结案结果")).toContainText("uncheckedChecklistItemClosureReasons");
	await expect(page.getByLabel("结案结果")).toContainText("保留失败结果，另行处理");
});
