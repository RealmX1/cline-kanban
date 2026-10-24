import { measureTerminalDisplayColumnWidth, type TerminalScreenSnapshot } from "./terminal-input-box-reader";

export function readCodexTerminalComposerOccupancy(
	snapshot: TerminalScreenSnapshot,
): "empty" | "nonempty" | "unreadable" {
	const { cursorRow, cursorColumn } = snapshot;
	if (cursorRow === undefined || cursorColumn === undefined) return "unreadable";
	const row = snapshot.lines[cursorRow];
	// 只看光标所在的活动 composer；历史消息中的 › 不构成空框证据。
	if (!row || !/^›(?: |$)/u.test(row.text)) return "unreadable";
	const content = row.text.slice(2);
	if (cursorColumn !== 2) return "nonempty";
	if (!content.trim()) return "unreadable";
	let column = 2;
	for (const character of content) {
		if (character.trim() && !row.dimmedTextColumnRanges?.some(([start, end]) => column >= start && column < end))
			return "nonempty";
		column += measureTerminalDisplayColumnWidth(character);
	}
	return "empty";
}
