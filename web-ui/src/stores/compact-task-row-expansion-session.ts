/**
 * 手机紧凑任务行的展开记忆。只活在当前浏览会话的模块 Map 里，不写 localStorage。
 *
 * 打开任务会卸载整棵看板。展开若只留在组件 state，返回时卡片全部收起，
 * 但滚动容器仍按展开时的绝对 scrollTop 还原，阅读位置就会落到更靠后的任务。
 * 这里按渲染角色、项目、任务与创建时间记住展开，重挂载时布局高度与滚动位置重新对齐。
 * 首次进入 Map 为空，因此默认收起；普通推流不改这些键，也不会把已展开的行收起。
 */

const expandedCompactTaskRowIdentities = new Set<string>();

export function isCompactTaskRowExpandedInSession(identity: string): boolean {
	return expandedCompactTaskRowIdentities.has(identity);
}

export function setCompactTaskRowExpandedInSession(identity: string, expanded: boolean): void {
	if (expanded) {
		expandedCompactTaskRowIdentities.add(identity);
		return;
	}
	expandedCompactTaskRowIdentities.delete(identity);
}

export function clearCompactTaskRowExpansionSessionForTests(): void {
	expandedCompactTaskRowIdentities.clear();
}
