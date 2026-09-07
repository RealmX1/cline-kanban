import { CodeXml } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

import { SearchSelectDropdown, type SearchSelectOption } from "@/components/search-select-dropdown";
import { normalizePseudoHtmlBlockName } from "@/components/task-prompt-pseudo-html-block-insertion";
import { useTaskPromptPseudoHtmlBlockRecentlyUsedCustomNamesPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";

/**
 * 常驻在下拉顶部的内置块名。
 *
 * 这三个是与 agent 对话时最常手打的结构化片段（贴一段执行轨迹 / 提一个问题 / 给一个答案），
 * 挑它们做预设是为了让最高频的那几次插入一次点击就完成，而不是每次都去输入框里敲名字。
 */
const TASK_PROMPT_PSEUDO_HTML_BLOCK_PRESET_NAMES: readonly string[] = ["trajectory", "question", "answer"];

/** 自定义块名记忆的条数上限。超过就把最久没用的那条挤出去。 */
const TASK_PROMPT_PSEUDO_HTML_BLOCK_RECENTLY_USED_CUSTOM_NAME_LIMIT = 12;

/**
 * 把一个刚用过的自定义块名放到列表最前，并去掉它在旧位置上的那份。
 *
 * 返回**新数组**而不是就地改：这份列表最终整份写进跨 origin 偏好，就地改会让乐观发布拿到同一个引用、
 * 订阅方判不出变化。
 */
export function withPseudoHtmlBlockCustomNameMovedToFront(
	recentlyUsedCustomNames: readonly string[],
	usedCustomName: string,
): string[] {
	return [usedCustomName, ...recentlyUsedCustomNames.filter((name) => name !== usedCustomName)].slice(
		0,
		TASK_PROMPT_PSEUDO_HTML_BLOCK_RECENTLY_USED_CUSTOM_NAME_LIMIT,
	);
}

/**
 * 描述区工具栏上的「插入伪 HTML 块」下拉：预设 + 用过的自定义名 + 现场输入一个新名字。
 *
 * 自己持有那份 MRU 偏好而不是让调用方传进来——调用方（composer）只关心「用户要插哪个名字」，
 * 块名记忆是这个控件自己的实现细节。
 */
export function TaskPromptPseudoHtmlBlockInsertControl({
	onInsertPseudoHtmlBlock,
	onPopoverCloseAutoFocus,
	disabled = false,
}: {
	onInsertPseudoHtmlBlock: (blockName: string) => void;
	/** 见 SearchSelectDropdown 的 `onContentCloseAutoFocus`：调用方用它把光标接回编辑器。 */
	onPopoverCloseAutoFocus?: (event: Event) => void;
	disabled?: boolean;
}): ReactElement {
	const [recentlyUsedCustomNames, setRecentlyUsedCustomNames] =
		useTaskPromptPseudoHtmlBlockRecentlyUsedCustomNamesPreference();

	const options = useMemo<SearchSelectOption[]>(() => {
		const presetOptions = TASK_PROMPT_PSEUDO_HTML_BLOCK_PRESET_NAMES.map((name) => ({
			value: name,
			label: `<${name}>`,
		}));
		const customOptions = recentlyUsedCustomNames
			.filter((name) => !TASK_PROMPT_PSEUDO_HTML_BLOCK_PRESET_NAMES.includes(name))
			.map((name) => ({ value: name, label: `<${name}>` }));
		return [...presetOptions, ...customOptions];
	}, [recentlyUsedCustomNames]);

	const handleSelectBlockName = useCallback(
		(selectedBlockName: string) => {
			// 下拉在没有模糊命中时会把用户**原样输入的查询串**当作选项值交回来，所以归一必须发生在这里，
			// 而不是只在预设那条路径上。
			const blockName = normalizePseudoHtmlBlockName(selectedBlockName);
			if (!blockName) {
				return;
			}
			if (!TASK_PROMPT_PSEUDO_HTML_BLOCK_PRESET_NAMES.includes(blockName)) {
				setRecentlyUsedCustomNames((currentNames) =>
					withPseudoHtmlBlockCustomNameMovedToFront(currentNames, blockName),
				);
			}
			onInsertPseudoHtmlBlock(blockName);
		},
		[onInsertPseudoHtmlBlock, setRecentlyUsedCustomNames],
	);

	return (
		<SearchSelectDropdown
			options={options}
			selectedValue={null}
			onSelect={handleSelectBlockName}
			onContentCloseAutoFocus={onPopoverCloseAutoFocus}
			icon={<CodeXml size={14} />}
			size="sm"
			buttonVariant="ghost"
			buttonText="Insert block"
			disabled={disabled}
			placeholder="Block name..."
			pinSelectedToTop={false}
			recommendedOptionValues={TASK_PROMPT_PSEUDO_HTML_BLOCK_PRESET_NAMES}
			recommendedHeading="Presets"
			otherOptionsHeading="Recently used"
			matchTargetWidth={false}
			dropdownStyle={{ width: 240 }}
			allowCustomValue
			customValueLabel={(query) => {
				const blockName = normalizePseudoHtmlBlockName(query);
				return blockName ? `Insert <${blockName}> block` : "Enter a block name";
			}}
		/>
	);
}
