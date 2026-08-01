import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TerminalScrollbackTranscriptStyledLine } from "@/components/detail-panels/terminal-scrollback-transcript-styled-line";
import type {
	TerminalScrollbackTranscriptLogicalLine,
	TerminalScrollbackTranscriptStyledSegment,
} from "@/terminal/terminal-scrollback-transcript-extraction";

/**
 * 为什么这条渲染路径要在这里单独测，而不是在 `agent-terminal-panel.test.tsx` 里顺带覆盖：
 * 阅读视图的行列表走 react-virtuoso，jsdom 里没有真实布局高度、算不出可视区，`itemContent`
 * 一次都不会被调用 —— 那条测试因此只能断言行数标签，够不到本组件。而全仓刻意不 mock
 * `react-virtuoso`（见 `task-spotlight-search-dialog.test.tsx` 的注释），所以行渲染由这份
 * 组件级测试直接覆盖：本组件把提取层的 run 翻成 DOM，是阅读视图「保留终端配色」的落点。
 */

const DEFAULT_FOREGROUND_COLOR = "#E6EDF3";
const DEFAULT_BACKGROUND_COLOR = "#1F2428";

function createStyledSegment(
	overrides: Partial<TerminalScrollbackTranscriptStyledSegment> & { text: string },
): TerminalScrollbackTranscriptStyledSegment {
	return {
		foregroundColor: null,
		backgroundColor: null,
		isBold: false,
		isDim: false,
		isItalic: false,
		isUnderline: false,
		isStrikethrough: false,
		isInverse: false,
		isInvisible: false,
		...overrides,
	};
}

function createLogicalLine(
	segments: TerminalScrollbackTranscriptStyledSegment[],
): TerminalScrollbackTranscriptLogicalLine {
	return {
		text: segments.map((segment) => segment.text).join(""),
		segments,
		sourceBufferRowIndex: 0,
	};
}

/**
 * jsdom 会把 `#RRGGBB` 序列化成 `rgb(r, g, b)`。用同一条 CSS 通道换算期望值，
 * 免得把某个引擎的序列化格式写死进断言。
 */
function normalizeCssColorValue(cssColorValue: string): string {
	const probeElement = document.createElement("span");
	probeElement.style.color = cssColorValue;
	return probeElement.style.color;
}

describe("TerminalScrollbackTranscriptStyledLine", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function renderLogicalLine(logicalLine: TerminalScrollbackTranscriptLogicalLine): HTMLSpanElement[] {
		act(() => {
			root.render(
				<TerminalScrollbackTranscriptStyledLine
					logicalLine={logicalLine}
					defaultForegroundColor={DEFAULT_FOREGROUND_COLOR}
					defaultBackgroundColor={DEFAULT_BACKGROUND_COLOR}
				/>,
			);
		});
		return [...container.querySelectorAll("span")];
	}

	it("逐 run 渲染成独立 span，拼接后恒等于逻辑行纯文本", () => {
		const spans = renderLogicalLine(
			createLogicalLine([
				createStyledSegment({ text: "npm " }),
				createStyledSegment({ text: "ERR!", foregroundColor: "#CD3131", isBold: true }),
				createStyledSegment({ text: " missing script" }),
			]),
		);

		expect(spans.map((span) => span.textContent)).toEqual(["npm ", "ERR!", " missing script"]);
		expect(container.textContent).toBe("npm ERR! missing script");
	});

	it("前景色/背景色/字形属性逐项落到内联样式", () => {
		const spans = renderLogicalLine(
			createLogicalLine([
				createStyledSegment({ text: "bold", isBold: true }),
				createStyledSegment({ text: "italic", isItalic: true }),
				createStyledSegment({ text: "marked", isUnderline: true, isStrikethrough: true }),
				createStyledSegment({ text: "colored", foregroundColor: "#23D18B", backgroundColor: "#2472C8" }),
			]),
		);

		expect(spans[0]?.style.fontWeight).toBe("600");
		expect(spans[1]?.style.fontStyle).toBe("italic");
		expect(spans[2]?.style.textDecorationLine).toBe("underline line-through");
		expect(spans[3]?.style.color).toBe(normalizeCssColorValue("#23D18B"));
		expect(spans[3]?.style.background).toBe(normalizeCssColorValue("#2472C8"));
	});

	it("未指定颜色的 run 取视图默认前景色，且默认背景不落成实际 background（透出面板底色）", () => {
		const spans = renderLogicalLine(createLogicalLine([createStyledSegment({ text: "plain" })]));

		expect(spans[0]?.style.color).toBe(normalizeCssColorValue(DEFAULT_FOREGROUND_COLOR));
		expect(spans[0]?.style.background).toBe("");
	});

	it("inverse（SGR 7）在渲染方折算：默认色下前景与背景互换", () => {
		const spans = renderLogicalLine(createLogicalLine([createStyledSegment({ text: "selected", isInverse: true })]));

		expect(spans[0]?.style.color).toBe(normalizeCssColorValue(DEFAULT_BACKGROUND_COLOR));
		expect(spans[0]?.style.background).toBe(normalizeCssColorValue(DEFAULT_FOREGROUND_COLOR));
	});

	it("dim（SGR 2）降不透明度，invisible（SGR 8）转成透明但保留占位文本", () => {
		const spans = renderLogicalLine(
			createLogicalLine([
				createStyledSegment({ text: "dimmed", isDim: true }),
				createStyledSegment({ text: "hidden", isInvisible: true }),
			]),
		);

		expect(Number(spans[0]?.style.opacity)).toBeLessThan(1);
		expect(spans[1]?.style.color).toBe("transparent");
		expect(spans[1]?.textContent).toBe("hidden");
	});

	it("空行（segments 为空）渲染 nbsp 占位撑起行高，而不是塌成零高度", () => {
		const spans = renderLogicalLine(createLogicalLine([]));

		expect(spans).toHaveLength(0);
		// 占位符必须是 nbsp（U+00A0）而非普通空格：whitespace-pre-wrap 下普通空格撑不起行高。
		expect(container.textContent).toBe("\u00A0");
	});
});
