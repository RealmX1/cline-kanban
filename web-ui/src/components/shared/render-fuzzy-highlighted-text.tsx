import type { CSSProperties, ReactNode } from "react";

/** 模糊搜索命中字符的统一强调样式，供所有带 fzf 高亮的列表/表格共用。 */
export const FUZZY_MATCHED_TEXT_STYLE: CSSProperties = {
	color: "var(--color-text-primary)",
	fontWeight: 600,
};

export function renderFuzzyHighlightedText(
	value: string,
	positions: ReadonlySet<number> | undefined,
	matchedTextStyle: CSSProperties,
): ReactNode {
	if (!positions || positions.size === 0) {
		return value;
	}

	const fragments: ReactNode[] = [];
	let currentText = "";
	let currentIsMatch: boolean | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character == null) {
			continue;
		}
		const isMatch = positions.has(index);
		if (currentIsMatch === null) {
			currentText = character;
			currentIsMatch = isMatch;
			continue;
		}
		if (isMatch === currentIsMatch) {
			currentText += character;
			continue;
		}
		fragments.push(
			<span
				key={`${index}:${currentIsMatch ? "match" : "plain"}`}
				style={currentIsMatch ? matchedTextStyle : undefined}
			>
				{currentText}
			</span>,
		);
		currentText = character;
		currentIsMatch = isMatch;
	}

	if (currentIsMatch === null) {
		return value;
	}

	fragments.push(
		<span key="end" style={currentIsMatch ? matchedTextStyle : undefined}>
			{currentText}
		</span>,
	);

	return fragments;
}
