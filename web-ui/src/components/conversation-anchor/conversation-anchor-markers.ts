// Session Map 聊天内导航锚的 marker 提取（纯函数）。
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md §C.1/§C.2。
//
// marker 是 agent 在助手消息正文里埋的行内 HTML 注释，独占一行：
//   <!-- kanban:map-anchor <anchorId> -->
// 选 HTML 注释的理由（蓝图 §C.1）：未被识别时在 markdown 渲染里天然不可见——转录被复制、
// 被旧版本 UI 渲染都不会出现垃圾文本，安全降级。
//
// 反注入铁律的落实侧（蓝图 §C.1）：marker 载荷只有一个 id，不携带任何自由文本；非法/残缺
// marker（无 id、多余 token、未闭合、不独占一行、不处于独立块级位置）一律按普通文本处理，
// 绝不解析出结构。chip 的显示内容恒来自服务端 map store（按 id 查节点标题），永不渲染
// marker 内嵌内容。

// 每条消息最多渲染的锚 chip 数（蓝图风险 9 的视觉噪声兜底）：恶意/故障 agent 可埋大量
// 有效 id 的 marker，超出上限的 marker 不再出 chip，按纯文本段处理（注释经 markdown
// 渲染天然不可见），但仍从 cleanContent 摘除——它本来就不是正文。
export const CONVERSATION_ANCHOR_CHIP_LIMIT_PER_MESSAGE = 8;

export type ConversationAnchorSegment = { kind: "text"; text: string } | { kind: "marker"; anchorId: string };

export interface ConversationAnchorExtraction {
	// 原位渲染序列：text 段照常 markdown 渲染，marker 段渲 chip（蓝图 §C.2）。
	segments: ConversationAnchorSegment[];
	// 摘除全部合法 marker（含超上限的）后的正文；无 marker 时与原文恒等。
	cleanContent: string;
}

// 独占一行的合法 marker：整行（忽略首尾空白）恰好是一个注释，载荷恰好一个非空白 token。
// id 字符集排除 `>` 是为了绝不吞掉注释收尾的 `-->`；多余 token / 无 id / 未闭合 / 行内
// 夹杂其他内容都因整行锚定而失配，回落普通文本。
const CONVERSATION_ANCHOR_MARKER_LINE_PATTERN = /^<!--\s*kanban:map-anchor\s+([^\s>]+)\s*-->$/;

// markdown 代码块 fence 行（``` 或 ~~~），捕获组是完整的 fence 字符游程。
// fence 内的行绝不按 marker 解析：marker 是「正文里的导航锚」，而逐行切段若切开代码块会
// 产生两个未闭合 fence、把后续正文全吞进代码块——那恰恰违背了 HTML 注释「安全降级」的初衷。
const FENCED_CODE_BLOCK_FENCE_LINE_PATTERN = /^\s*(`{3,}|~{3,})/;

// 当前打开的 fence 的 opener 特征。closing 判定遵循 CommonMark：同字符且游程长度 ≥ opener——
// 否则「四反引号 fence 内示例里的三反引号行」会被误判为闭合，随后代码示例里的 marker 状行
// 就被当成正文 marker 解析并摘除（既腐化正文又可能生成错误 chip）。不匹配 closing 条件的
// fence 状行只是代码块内容，原样保留。
interface OpenFence {
	char: string;
	length: number;
}

// marker 只在「独立块级位置」合法：前/后相邻行（若存在）必须是空行或另一条 marker 状行。
// 落在跨行 block（表格表头/分隔行/数据行、列表、引用）内部的 marker 若被摘除，两侧 text 段
// 会被分别交给独立的 markdown renderer，切断 Markdown AST（表格数据行退化为普通段落）——
// 这违反「摘 marker 后正文照常渲染」的契约。此类 marker 按普通文本处理：不解析、不摘除，
// HTML 注释在 markdown 渲染里天然不可见，是安全降级。相邻行判定是局部的（只看是否空行/
// marker 状），不做传递性求值——连续相邻 marker 行仍可用。
function isBlankOrMarkerShapedLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length === 0 || CONVERSATION_ANCHOR_MARKER_LINE_PATTERN.test(trimmed);
}

function isStandaloneBlockPosition(lines: string[], index: number): boolean {
	const prevOk = index === 0 || isBlankOrMarkerShapedLine(lines[index - 1]!);
	const nextOk = index === lines.length - 1 || isBlankOrMarkerShapedLine(lines[index + 1]!);
	return prevOk && nextOk;
}

export function extractConversationAnchorMarkers(content: string): ConversationAnchorExtraction {
	// 快路径：不含 marker 前缀的消息（绝大多数）不逐行扫描，且保持 cleanContent 与原文恒等。
	if (!content.includes("kanban:map-anchor")) {
		return {
			segments: content.length > 0 ? [{ kind: "text", text: content }] : [],
			cleanContent: content,
		};
	}

	const segments: ConversationAnchorSegment[] = [];
	const cleanLines: string[] = [];
	let pendingTextLines: string[] = [];
	let markerSegmentCount = 0;

	const flushPendingText = (): void => {
		if (pendingTextLines.length === 0) {
			return;
		}
		const text = pendingTextLines.join("\n");
		pendingTextLines = [];
		// marker 行被摘除后可能留下空行段——空段不产生渲染输出，跳过。
		if (text.trim().length === 0) {
			return;
		}
		segments.push({ kind: "text", text });
	};

	let openFence: OpenFence | null = null;
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const fenceRunMatch = FENCED_CODE_BLOCK_FENCE_LINE_PATTERN.exec(line);
		if (fenceRunMatch) {
			// 捕获组是完整游程，匹配成功必有值（noUncheckedIndexedAccess 下需断言）。
			const fenceRun = fenceRunMatch[1]!;
			const fenceChar = fenceRun.charAt(0);
			if (openFence === null) {
				openFence = { char: fenceChar, length: fenceRun.length };
			} else if (fenceChar === openFence.char && fenceRun.length >= openFence.length) {
				openFence = null;
			}
			pendingTextLines.push(line);
			cleanLines.push(line);
			continue;
		}
		const markerMatch =
			openFence === null && isStandaloneBlockPosition(lines, index)
				? CONVERSATION_ANCHOR_MARKER_LINE_PATTERN.exec(line.trim())
				: null;
		if (markerMatch && markerSegmentCount < CONVERSATION_ANCHOR_CHIP_LIMIT_PER_MESSAGE) {
			markerSegmentCount += 1;
			flushPendingText();
			// 捕获组在正则里是必填项，匹配成功必有值（noUncheckedIndexedAccess 下需断言）。
			segments.push({ kind: "marker", anchorId: markerMatch[1]! });
			continue;
		}
		// 超上限的合法 marker 落入这里：按纯文本段处理（不出 chip），但不进 cleanLines——
		// 合法 marker 一律从 cleanContent 摘除。非法/残缺/非块级位置的 marker 则两边都按
		// 普通文本保留。
		if (!markerMatch) {
			cleanLines.push(line);
		}
		pendingTextLines.push(line);
	}
	flushPendingText();

	return { segments, cleanContent: cleanLines.join("\n") };
}
