import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function readRequiredSourceExpression(
	filename: string,
	selectExpression: (node: ts.Node) => ts.Expression | undefined,
): string {
	const sourceText = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), filename), "utf8");
	const sourceFile = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	let expression: ts.Expression | undefined;
	const visit = (node: ts.Node): void => {
		expression ??= selectExpression(node);
		if (!expression) ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	if (!expression) throw new Error(`未找到 ${filename} 的侧栏状态表达式`);
	return expression.getText(sourceFile);
}

// 直接联合执行 App 的真实回调和详情列表的 JSX 显隐条件，避免测试宿主复制状态逻辑后掩盖接线错误。
const toggleCurrentPageLeftSidebarSource = readRequiredSourceExpression("App.tsx", (node) =>
	ts.isVariableDeclaration(node) &&
	ts.isIdentifier(node.name) &&
	node.name.text === "handleToggleCurrentPageLeftSidebar"
		? node.initializer
		: undefined,
);
const taskListSidebarDisplaySource = readRequiredSourceExpression("components/card-detail-view.tsx", (node) => {
	if (!ts.isJsxOpeningElement(node)) return undefined;
	if (
		!node.attributes.properties.some(
			(attribute) =>
				ts.isJsxAttribute(attribute) && attribute.name.getText() === "data-focus-view-task-list-sidebar",
		)
	)
		return undefined;
	const styleAttribute = node.attributes.properties.find(
		(attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === "style",
	);
	const initializer = styleAttribute?.initializer;
	if (!initializer || !ts.isJsxExpression(initializer)) return undefined;
	const styleExpression = initializer.expression;
	if (!styleExpression || !ts.isObjectLiteralExpression(styleExpression)) return undefined;
	const displayProperty = styleExpression.properties.find(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) && property.name.getText() === "display",
	);
	return displayProperty?.initializer;
});

describe("真实 App 查卡切换与任务列表显隐契约", () => {
	for (const taskLookupIsOpen of [false, true]) {
		for (const diffIsExpanded of [false, true]) {
			for (const taskListHiddenPreference of [false, true]) {
				it(`查卡=${taskLookupIsOpen}，Diff 最大化=${diffIsExpanded}，隐藏偏好=${taskListHiddenPreference}：一次操作反转实际显隐`, () => {
					let nextHiddenPreference = taskListHiddenPreference;
					let nextDiffExpanded = diffIsExpanded;
					const readActualListHidden = () =>
						runInNewContext(taskListSidebarDisplaySource, {
							isFocusViewTaskListSidebarHidden: nextHiddenPreference,
							isDiffExpanded: nextDiffExpanded,
							taskLookupWorkbenchContent: taskLookupIsOpen ? {} : undefined,
						}) === "none";
					const wasActuallyHidden = readActualListHidden();
					const setTaskListHiddenPreference = vi.fn((hidden: boolean) => {
						nextHiddenPreference = hidden;
					});
					const setDiffExpanded = vi.fn((expanded: boolean) => {
						nextDiffExpanded = expanded;
					});
					runInNewContext(`(${toggleCurrentPageLeftSidebarSource})()`, {
						useCallback: (callback: () => void) => callback,
						isMobile: false,
						isFocusViewChromeShown: true,
						isFocusViewDiffExpanded: diffIsExpanded,
						taskLookupWorkbench: { isOpen: taskLookupIsOpen },
						handleToggleSidebar: vi.fn(),
						sidebarVisibility: {
							isFocusViewTaskListSidebarHidden: taskListHiddenPreference,
							setFocusViewTaskListSidebarHidden: setTaskListHiddenPreference,
						},
						setIsFocusViewDiffExpanded: setDiffExpanded,
					});
					expect(readActualListHidden()).toBe(!wasActuallyHidden);
					expect(setTaskListHiddenPreference).toHaveBeenCalledExactlyOnceWith(!wasActuallyHidden);
					expect(setDiffExpanded).toHaveBeenCalledExactlyOnceWith(false);
				});
			}
		}
	}
});
