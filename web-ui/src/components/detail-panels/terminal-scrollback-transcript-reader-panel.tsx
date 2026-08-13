import { RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { TerminalScrollToLatestButton } from "@/components/detail-panels/terminal-scroll-to-latest-button";
import { TerminalScrollbackTranscriptStyledLine } from "@/components/detail-panels/terminal-scrollback-transcript-styled-line";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { getTerminalController, readTerminalScrollbackTranscript } from "@/terminal/terminal-controller-registry";
import type { TerminalScrollbackTranscriptLogicalLine } from "@/terminal/terminal-scrollback-transcript-extraction";
import { useTerminalThemeColors } from "@/terminal/theme-colors";

interface TerminalScrollbackTranscriptReaderPanelProps {
	taskId: string;
	/** 阅读视图是否可见（作为终端面板内的叠加层展开时为 true）。由不可见转为可见时自动重取，避免读到过期快照。 */
	isVisible?: boolean;
}

/**
 * 把终端 scrollback 当作文档来读的只读视图。
 *
 * 与 xterm 的分工：xterm 是定宽字符网格，为「操作」而生 —— 输入、TUI 原生交互面、实时重绘；
 * 本视图为「阅读」而生 —— 逻辑行按屏宽软换行、系统原生长按选中、原生 DOM 滚动。读长 transcript
 * （尤其 agent 提问时需要回看完整 context）走这里，操作仍回 xterm。
 *
 * **配色与终端一致，不是纯文本 dump。** 提取层保留了每个字符的前景/背景色与字形属性，本视图
 * 逐 run 还原 —— agent TUI 靠颜色区分工具输出、diff 增删、消息类型与强调，丢掉颜色这些区别
 * 在视觉上就没了。底色也直接取终端主题色（各主题的终端色恒为深色，见 `use-theme.ts`），
 * 让 ANSI 色落在它本来预期的底上；本视图是 DOM 而非画布，不经浅色主题那层反相滤镜。
 *
 * 呈现形态：它不是独立 tab，而是叠加在同一个 AgentTerminalPanel 之上的显示模式，由面板头部的
 * 阅读模式 toggle 在「实时终端」与「本视图」之间切换 —— 用户看到本视图时人就在终端面板里，
 * 所以任何面向用户的文案都必须以「用头部 toggle 切回实时终端」作为出路，不得指向别处。
 *
 * 刻意做成手动刷新的快照而非实时流：阅读态本就该稳定，边读边跳会让人丢失位置。
 */
export function TerminalScrollbackTranscriptReaderPanel({
	taskId,
	isVisible = true,
}: TerminalScrollbackTranscriptReaderPanelProps) {
	const isMobile = useIsMobile();
	const terminalThemeColors = useTerminalThemeColors();
	const virtuosoRef = useRef<VirtuosoHandle | null>(null);
	const [logicalLines, setLogicalLines] = useState<TerminalScrollbackTranscriptLogicalLine[]>([]);
	const [isTerminalAttached, setIsTerminalAttached] = useState(false);
	const [filterQuery, setFilterQuery] = useState("");
	const [isScrolledAwayFromLatest, setIsScrolledAwayFromLatest] = useState(false);

	const refreshTranscript = useCallback(() => {
		setIsTerminalAttached(getTerminalController(taskId) !== null);
		setLogicalLines(readTerminalScrollbackTranscript(taskId));
	}, [taskId]);

	useEffect(() => {
		if (!isVisible) {
			return;
		}
		refreshTranscript();
	}, [isVisible, refreshTranscript]);

	const visibleLogicalLines = useMemo(() => {
		const normalizedFilterQuery = filterQuery.trim().toLowerCase();
		if (!normalizedFilterQuery) {
			return logicalLines;
		}
		return logicalLines.filter((logicalLine) => logicalLine.text.toLowerCase().includes(normalizedFilterQuery));
	}, [filterQuery, logicalLines]);

	const scrollToLatest = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({ index: Math.max(0, visibleLogicalLines.length - 1), align: "end" });
		setIsScrolledAwayFromLatest(false);
	}, [visibleLogicalLines.length]);

	return (
		<div
			className="relative flex min-h-0 min-w-0 flex-1 flex-col"
			style={{ background: terminalThemeColors.surfacePrimary }}
		>
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
				<div className="relative flex min-w-0 flex-1 items-center">
					<Search size={12} className="pointer-events-none absolute left-2 text-text-tertiary" />
					<input
						type="text"
						value={filterQuery}
						onChange={(event) => setFilterQuery(event.target.value)}
						placeholder="Filter lines"
						aria-label="Filter transcript lines"
						className={cn(
							"w-full rounded-md border border-border bg-surface-2 py-1 pl-7 pr-2 text-xs text-text-primary",
							"placeholder:text-text-tertiary focus-visible:border-border-focus focus-visible:outline-none",
							isMobile && "min-h-[44px]",
						)}
					/>
				</div>
				<span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-text-tertiary">
					{formatTranscriptLineCountLabel(visibleLogicalLines.length, logicalLines.length)}
				</span>
				<Button
					variant="ghost"
					size={isMobile ? "md" : "sm"}
					icon={<RotateCcw size={isMobile ? 16 : 12} />}
					onClick={refreshTranscript}
					aria-label="Reload transcript from the terminal"
					className={cn(isMobile && MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
				/>
			</div>
			{visibleLogicalLines.length === 0 ? (
				<div className="flex flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-text-tertiary">
					{describeEmptyTranscriptReason({
						isTerminalAttached,
						hasAnyLine: logicalLines.length > 0,
					})}
				</div>
			) : (
				<Virtuoso
					ref={virtuosoRef}
					style={{ height: "100%" }}
					className="kb-terminal-transcript-reader-scroll-area"
					data={visibleLogicalLines}
					initialTopMostItemIndex={visibleLogicalLines.length - 1}
					atBottomStateChange={(isAtBottom) => setIsScrolledAwayFromLatest(!isAtBottom)}
					computeItemKey={(index, logicalLine) => `${logicalLine.sourceBufferRowIndex}-${index}`}
					itemContent={(_, logicalLine) => (
						<TerminalScrollbackTranscriptStyledLine
							logicalLine={logicalLine}
							defaultForegroundColor={terminalThemeColors.textPrimary}
							defaultBackgroundColor={terminalThemeColors.surfacePrimary}
						/>
					)}
				/>
			)}
			<TerminalScrollToLatestButton
				isScrolledAwayFromLatest={isScrolledAwayFromLatest}
				onScrollToLatest={scrollToLatest}
			/>
		</div>
	);
}

function formatTranscriptLineCountLabel(visibleLineCount: number, totalLineCount: number): string {
	if (visibleLineCount === totalLineCount) {
		return `${totalLineCount} lines`;
	}
	return `${visibleLineCount}/${totalLineCount}`;
}

/**
 * 空视图必须说清「为什么空」。尤其 alt-screen agent（Codex 等）在自己的备用屏缓冲区里原地
 * 重绘，历史由 TUI 自己持有、根本不进 scrollback —— 那是设计使然而非故障，不能只显示一句
 * 「没有内容」让人以为坏了。
 *
 * 出路一律是「用面板头部的 toggle 切回实时终端」：本视图是终端面板内的叠加层，用户此刻就在
 * 终端面板里，绝不能把他导向别的 tab 或别的位置。
 */
function describeEmptyTranscriptReason(input: { isTerminalAttached: boolean; hasAnyLine: boolean }): string {
	if (input.hasAnyLine) {
		return "No lines match the current filter.";
	}
	if (!input.isTerminalAttached) {
		return "The live terminal behind this reading view has not connected yet, so there is no scrollback to read. Use the reader toggle in the panel header to go back to the live terminal, then return here once the session has produced output.";
	}
	return "Nothing to read here yet. Agents that draw a full-screen interface (such as Claude Code or Codex) keep their history inside that interface rather than in terminal scrollback, so there is nothing for this reading view to show — use the reader toggle in the panel header to go back to the live terminal and scroll there instead.";
}
