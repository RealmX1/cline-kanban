import { describe, expect, it } from "vitest";
import {
	extractSessionMapAnchorMarkers,
	SESSION_MAP_ANCHOR_CHIP_LIMIT_PER_MESSAGE,
} from "@/components/session-map/session-map-anchor-markers";

function buildMarkerLine(mapNodeId: string): string {
	return `<!-- kanban:map-anchor ${mapNodeId} -->`;
}

describe("extractSessionMapAnchorMarkers", () => {
	it("无 marker 时返回单个 text 段，cleanContent 与原文恒等", () => {
		const content = "第一行\n第二行\n\n第三行";
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it("空内容返回空段序列", () => {
		const extraction = extractSessionMapAnchorMarkers("");
		expect(extraction.segments).toEqual([]);
		expect(extraction.cleanContent).toBe("");
	});

	it("提取独立块级位置的单个合法 marker，正文被拆成相邻 text 段", () => {
		const extraction = extractSessionMapAnchorMarkers(`前文\n\n${buildMarkerLine("node-1")}\n\n后文`);
		expect(extraction.segments).toEqual([
			{ kind: "text", text: "前文\n" },
			{ kind: "marker", mapNodeId: "node-1" },
			{ kind: "text", text: "\n后文" },
		]);
		expect(extraction.cleanContent).toBe("前文\n\n\n后文");
	});

	it("marker 在开头与结尾时不产生空 text 段", () => {
		const extraction = extractSessionMapAnchorMarkers(
			`${buildMarkerLine("head")}\n\n正文\n\n${buildMarkerLine("tail")}`,
		);
		expect(extraction.segments).toEqual([
			{ kind: "marker", mapNodeId: "head" },
			{ kind: "text", text: "\n正文\n" },
			{ kind: "marker", mapNodeId: "tail" },
		]);
		expect(extraction.cleanContent).toBe("\n正文\n");
	});

	it("相邻 marker 之间不夹空 text 段", () => {
		const extraction = extractSessionMapAnchorMarkers(`${buildMarkerLine("a")}\n${buildMarkerLine("b")}`);
		expect(extraction.segments).toEqual([
			{ kind: "marker", mapNodeId: "a" },
			{ kind: "marker", mapNodeId: "b" },
		]);
		expect(extraction.cleanContent).toBe("");
	});

	it("容忍 marker 行的首尾空白（仍视为独占一行）", () => {
		const extraction = extractSessionMapAnchorMarkers(`前文\n\n  ${buildMarkerLine("spaced")}  \n\n后文`);
		expect(extraction.segments).toEqual([
			{ kind: "text", text: "前文\n" },
			{ kind: "marker", mapNodeId: "spaced" },
			{ kind: "text", text: "\n后文" },
		]);
	});

	it("接受规范化派生 id 中可能出现的冒号/点/下划线/短横", () => {
		const extraction = extractSessionMapAnchorMarkers(buildMarkerLine("session-1:T3:milestone_v2.x"));
		expect(extraction.segments).toEqual([{ kind: "marker", mapNodeId: "session-1:T3:milestone_v2.x" }]);
	});

	it.each([
		["无 id", "<!-- kanban:map-anchor -->"],
		["多余 token", "<!-- kanban:map-anchor node-1 extra -->"],
		["未闭合（缺 -->）", "<!-- kanban:map-anchor node-1"],
		["未闭合（缺 >）", "<!-- kanban:map-anchor node-1 --"],
		["行内夹杂其他文本", `前文 ${buildMarkerLine("node-1")}`],
		["marker 后 trailing 文本", `${buildMarkerLine("node-1")} 后文`],
		["未知指令前缀", "<!-- kanban:other-anchor node-1 -->"],
		["大小写不敏感（必须小写）", "<!-- KANBAN:MAP-ANCHOR node-1 -->"],
	])("非法/残缺 marker 按普通文本处理：%s", (_label, line) => {
		const content = `前文\n${line}\n后文`;
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it("每消息 chip 上限：超出的合法 marker 按纯文本段处理但仍从 cleanContent 摘除", () => {
		const markerLines = Array.from({ length: SESSION_MAP_ANCHOR_CHIP_LIMIT_PER_MESSAGE + 2 }, (_, index) =>
			buildMarkerLine(`node-${index + 1}`),
		);
		const content = `开头\n\n${markerLines.join("\n")}\n\n结尾`;
		const extraction = extractSessionMapAnchorMarkers(content);

		const markerSegments = extraction.segments.filter((segment) => segment.kind === "marker");
		expect(markerSegments).toHaveLength(SESSION_MAP_ANCHOR_CHIP_LIMIT_PER_MESSAGE);
		expect(markerSegments[0]).toEqual({ kind: "marker", mapNodeId: "node-1" });
		expect(markerSegments[SESSION_MAP_ANCHOR_CHIP_LIMIT_PER_MESSAGE - 1]).toEqual({
			kind: "marker",
			mapNodeId: `node-${SESSION_MAP_ANCHOR_CHIP_LIMIT_PER_MESSAGE}`,
		});

		// 超上限的两条 marker 留在 text 段原文里（经 markdown 的 HTML 注释不可见性兜底，不出 chip）。
		const textSegments = extraction.segments.filter((segment) => segment.kind === "text");
		const joinedText = textSegments.map((segment) => (segment.kind === "text" ? segment.text : "")).join("\n");
		expect(joinedText).toContain(buildMarkerLine(`node-${SESSION_MAP_ANCHOR_CHIP_LIMIT_PER_MESSAGE + 1}`));
		expect(joinedText).toContain(buildMarkerLine(`node-${SESSION_MAP_ANCHOR_CHIP_LIMIT_PER_MESSAGE + 2}`));

		// cleanContent 摘除全部合法 marker（含超上限的）。
		expect(extraction.cleanContent).toBe("开头\n\n\n结尾");
	});

	it("同一条消息里 marker 与普通注释混杂时只提取合法 marker", () => {
		const content = ["前文", "", buildMarkerLine("real"), "", "<!-- 普通注释 -->", "后文"].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([
			{ kind: "text", text: "前文\n" },
			{ kind: "marker", mapNodeId: "real" },
			{ kind: "text", text: "\n<!-- 普通注释 -->\n后文" },
		]);
		expect(extraction.cleanContent).toBe("前文\n\n\n<!-- 普通注释 -->\n后文");
	});

	it("代码块 fence 内的 marker 状行按普通文本处理（切段不得切开代码块）", () => {
		const content = ["前文", "```ts", "const a = 1;", buildMarkerLine("inside-fence"), "```", "后文"].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it("代码块闭合后的 marker 照常提取", () => {
		const content = ["```", "code", "```", "", buildMarkerLine("after-fence")].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([
			{ kind: "text", text: "```\ncode\n```\n" },
			{ kind: "marker", mapNodeId: "after-fence" },
		]);
		expect(extraction.cleanContent).toBe("```\ncode\n```\n");
	});

	it("四反引号 fence 内的三反引号行不闭合 fence，其后 marker 状行仍按代码块内容处理", () => {
		// CommonMark 规则：closing 必须与 opener 同字符且游程长度 ≥ opener。四反引号 fence 里
		// 的三反引号行只是内容；若误判为闭合，代码示例里的 marker 会被解析并从正文摘除。
		const content = [
			"前文",
			"````markdown",
			"示例：三反引号行只是代码块内容",
			"```",
			buildMarkerLine("inside-four-backtick-fence"),
			"````",
			"后文",
		].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it("波浪号 fence 不被反引号 fence 行闭合（closing 必须与 opener 同字符）", () => {
		const content = ["~~~", "```", buildMarkerLine("inside-tilde-fence"), "~~~", "", buildMarkerLine("after")].join(
			"\n",
		);
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([
			{
				kind: "text",
				text: ["~~~", "```", buildMarkerLine("inside-tilde-fence"), "~~~", ""].join("\n"),
			},
			{ kind: "marker", mapNodeId: "after" },
		]);
		expect(extraction.cleanContent).toBe(["~~~", "```", buildMarkerLine("inside-tilde-fence"), "~~~", ""].join("\n"));
	});

	it("更长的 closing fence 可闭合较短的 opener", () => {
		const content = ["```", "code", "````", "", buildMarkerLine("after-fence")].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([
			{ kind: "text", text: "```\ncode\n````\n" },
			{ kind: "marker", mapNodeId: "after-fence" },
		]);
		expect(extraction.cleanContent).toBe("```\ncode\n````\n");
	});

	it("表格表头/分隔行与数据行之间的 marker 不解析（不切断表格 AST）", () => {
		const content = ["| 列A | 列B |", "| --- | --- |", buildMarkerLine("inside-table"), "| 1 | 2 |"].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it("列表项之间的 marker 不解析", () => {
		const content = ["- 甲", buildMarkerLine("inside-list"), "- 乙"].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it("引用块内的 marker 不解析", () => {
		const content = ["> 引文", buildMarkerLine("inside-quote"), "> 续"].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it.each([
		["前后都紧贴文本行", `前文\n${buildMarkerLine("mid")}\n后文`],
		["文首但后随文本行", `${buildMarkerLine("head")}\n后文`],
		["文末但前贴文本行", `前文\n${buildMarkerLine("tail")}`],
	])("非独立块级位置的 marker 按普通文本处理（不解析、不摘除）：%s", (_label, content) => {
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([{ kind: "text", text: content }]);
		expect(extraction.cleanContent).toBe(content);
	});

	it("连续相邻 marker 行（无空行间隔）在块边界处仍照常解析", () => {
		const content = ["前文", "", buildMarkerLine("a"), buildMarkerLine("b"), "", "后文"].join("\n");
		const extraction = extractSessionMapAnchorMarkers(content);
		expect(extraction.segments).toEqual([
			{ kind: "text", text: "前文\n" },
			{ kind: "marker", mapNodeId: "a" },
			{ kind: "marker", mapNodeId: "b" },
			{ kind: "text", text: "\n后文" },
		]);
		expect(extraction.cleanContent).toBe("前文\n\n\n后文");
	});
});
