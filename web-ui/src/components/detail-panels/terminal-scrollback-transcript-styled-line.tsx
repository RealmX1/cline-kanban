import type { CSSProperties, ReactElement } from "react";

import type {
	TerminalScrollbackTranscriptLogicalLine,
	TerminalScrollbackTranscriptStyledSegment,
} from "@/terminal/terminal-scrollback-transcript-extraction";

/** xterm 对 dim（SGR 2）的处理是把前景色向背景混合，DOM 侧用等效的降不透明度表达。 */
const DIM_SEGMENT_OPACITY = 0.62;

interface TerminalScrollbackTranscriptStyledLineProps {
	logicalLine: TerminalScrollbackTranscriptLogicalLine;
	/** 该视图的默认前景色 —— 单元格未指定前景色（SGR 39）时用它，inverse 时它变成背景。 */
	defaultForegroundColor: string;
	/** 该视图的默认背景色 —— 单元格未指定背景色（SGR 49）时用它，inverse 时它变成前景。 */
	defaultBackgroundColor: string;
}

/**
 * 渲染一条 transcript 逻辑行，逐 run 还原终端配色。
 *
 * 这是阅读视图相对于「纯文本 dump」的全部价值所在：agent TUI 用颜色而非结构来区分工具输出、
 * diff 增删行、消息类型与强调，去掉颜色后这些区别在视觉上完全消失。提取层已把每格的
 * 前景/背景/字形属性合并成 run（见 `terminal-scrollback-transcript-extraction.ts`），
 * 这里只负责把 run 翻成 DOM。
 *
 * 颜色是运行期解析出来的动态值（调色板色号 / 24 位真彩），按项目样式约定必须走内联 style，
 * 不能也无法预生成成 Tailwind 类。
 */
export function TerminalScrollbackTranscriptStyledLine({
	logicalLine,
	defaultForegroundColor,
	defaultBackgroundColor,
}: TerminalScrollbackTranscriptStyledLineProps): ReactElement {
	return (
		<div className="whitespace-pre-wrap break-words px-3 font-mono text-xs leading-relaxed">
			{logicalLine.segments.length === 0
				? // 空行也要占一行高度，否则段落间距被吞、transcript 挤成一坨。
					// 占位符是 nbsp（U+00A0）而非普通空格：whitespace-pre-wrap 下普通空格撑不起行高。
					" "
				: logicalLine.segments.map((segment, segmentIndex) => (
						<span
							// run 在一条逻辑行内没有天然稳定 id，且整行随快照整体重建，用下标即可。
							key={segmentIndex}
							style={resolveSegmentInlineStyle(segment, defaultForegroundColor, defaultBackgroundColor)}
						>
							{segment.text}
						</span>
					))}
		</div>
	);
}

function resolveSegmentInlineStyle(
	segment: TerminalScrollbackTranscriptStyledSegment,
	defaultForegroundColor: string,
	defaultBackgroundColor: string,
): CSSProperties {
	// inverse（SGR 7）在提取层被刻意保留成原始标志而不折算，因为只有渲染方知道自己的默认色。
	const resolvedForegroundColor = segment.foregroundColor ?? defaultForegroundColor;
	const resolvedBackgroundColor = segment.backgroundColor ?? defaultBackgroundColor;
	const foregroundColor = segment.isInverse ? resolvedBackgroundColor : resolvedForegroundColor;
	const backgroundColor = segment.isInverse ? resolvedForegroundColor : resolvedBackgroundColor;

	return {
		color: segment.isInvisible ? "transparent" : foregroundColor,
		// 默认背景不落成实际 background，让整块面板的底色透上来，避免每行拼出细微色差的色带。
		background: backgroundColor === defaultBackgroundColor && !segment.isInverse ? undefined : backgroundColor,
		fontWeight: segment.isBold ? 600 : undefined,
		fontStyle: segment.isItalic ? "italic" : undefined,
		opacity: segment.isDim ? DIM_SEGMENT_OPACITY : undefined,
		textDecorationLine: resolveTextDecorationLine(segment),
	};
}

function resolveTextDecorationLine(segment: TerminalScrollbackTranscriptStyledSegment): string | undefined {
	const decorations: string[] = [];
	if (segment.isUnderline) {
		decorations.push("underline");
	}
	if (segment.isStrikethrough) {
		decorations.push("line-through");
	}
	return decorations.length > 0 ? decorations.join(" ") : undefined;
}
