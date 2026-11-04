import { RotateCcw, Search } from "lucide-react";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { TerminalScrollToLatestButton } from "@/components/detail-panels/terminal-scroll-to-latest-button";
import { TerminalScrollbackTranscriptStyledLine } from "@/components/detail-panels/terminal-scrollback-transcript-styled-line";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSharedMobileFocusViewCollapsibleControls } from "@/hooks/use-mobile-focus-view-collapsible-controls";
import { getTerminalController, readTerminalScrollbackTranscript } from "@/terminal/terminal-controller-registry";
import type { TerminalScrollbackTranscriptLogicalLine } from "@/terminal/terminal-scrollback-transcript-extraction";
import { useTerminalThemeColors } from "@/terminal/theme-colors";

interface TerminalScrollbackTranscriptReaderPanelProps {
	scrollContainerRef?: MutableRefObject<HTMLElement | null>;
	taskId: string;
	/** 阅读视图是否可见（作为终端面板内的叠加层展开时为 true）。由不可见转为可见时自动重取，避免读到过期快照。 */
	isVisible?: boolean;
}

/**
 * 普通 shell 的终端缓冲区阅读，保留字符样式并通过手动刷新更新快照。
 * Agent 持久转录由 TaskConversationTranscriptDocumentReaderPanel 读取；两者均叠加在实时终端上。
 */
export function TerminalScrollbackTranscriptReaderPanel({
	taskId,
	isVisible = true,
	scrollContainerRef,
}: TerminalScrollbackTranscriptReaderPanelProps) {
	const isMobile = useIsMobile();
	const controls = useSharedMobileFocusViewCollapsibleControls();
	const upperToolsExpanded = !controls?.isEnabled || controls.upperNavigationAndToolsExpanded;
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
			<div
				className={cn(
					"shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5",
					upperToolsExpanded ? "flex" : "hidden",
				)}
			>
				<div className="relative flex min-w-0 flex-1 items-center">
					<Search size={12} className="pointer-events-none absolute left-2 text-text-tertiary" />
					<input
						type="text"
						value={filterQuery}
						onChange={(event) => setFilterQuery(event.target.value)}
						placeholder="筛选终端输出"
						aria-label="筛选终端输出"
						data-mobile-focus-view-idle-collapse-suspension=""
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
					aria-label="刷新终端输出"
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
					scrollerRef={(element) => {
						if (scrollContainerRef) scrollContainerRef.current = element instanceof HTMLElement ? element : null;
					}}
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
		return `${totalLineCount} 行`;
	}
	return `${visibleLineCount}/${totalLineCount}`;
}

/** 普通 shell 只提供终端缓冲区输出；agent 的持久转录由独立文档组件读取。 */
function describeEmptyTranscriptReason(input: { isTerminalAttached: boolean; hasAnyLine: boolean }): string {
	if (input.hasAnyLine) {
		return "没有符合筛选条件的终端输出。";
	}
	if (!input.isTerminalAttached) {
		return "终端尚未连接，暂时没有可读取的输出。连接并产生输出后可刷新。";
	}
	return "终端缓冲区尚无可读取的输出。可通过面板头部按钮返回实时终端。";
}
