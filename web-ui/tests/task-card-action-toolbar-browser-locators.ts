import { expect, type Locator } from "@playwright/test";

/** 每次形态切换后按实际来源重新取动作组，不混淆同任务的分身。 */
export async function taskCardActionToolbar(source: Locator): Promise<Locator> {
	const inFlowToolbar = source.locator("[data-task-card-primary-actions]:not(.kb-task-card-floating-actions)");
	if (await inFlowToolbar.count()) return inFlowToolbar.first();
	const findToolbarId = () =>
		source
			.locator("[data-task-card-action-toolbar-placeholder]")
			.evaluateAll((elements) =>
				elements.find((element) => !element.closest("[hidden], [inert]"))?.getAttribute("aria-owns"),
			);
	await expect.poll(findToolbarId).toBeTruthy();
	return source.page().locator(`[id="${await findToolbarId()}"]`);
}
