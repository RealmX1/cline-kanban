import { getTaskCardDomRootsIncludingPortalledActionToolbars } from "../src/components/task-card-action-toolbar";

/** 业务测试按来源卡片查询动作，避免混入同任务的其他副本或隐藏预加载卡。 */
export function queryTaskCardElementIncludingPortalledActionToolbars<T extends Element = Element>(
	source: ParentNode | null | undefined,
	selector: string,
): T | null {
	if (!(source instanceof HTMLElement)) return source?.querySelector<T>(selector) ?? null;
	for (const root of getTaskCardDomRootsIncludingPortalledActionToolbars(source)) {
		if (root !== source) {
			const owner = [...source.querySelectorAll<HTMLElement>("[data-task-card-action-toolbar-placeholder]")].find(
				(element) => element.getAttribute("aria-owns") === root.id,
			);
			if (owner?.closest("[hidden], [inert]")) continue;
		}
		const entry = root.querySelector<T>(selector);
		if (entry) return entry;
	}
	return null;
}
