import type { CSSProperties, ReactElement } from "react";
import { cn } from "@/components/ui/cn";

// worktree 相对 HEAD 的未提交改动统计「(N files +A -D)」。This project 卡片目录行、顶栏分支按钮、跨项目切换面板
// 的行共用这一份，括号与文件数的颜色由宿主决定（各自所在行的排版不同），增删行数恒为绿 / 红。

export interface WorktreeUncommittedChangeCounts {
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
}

// 卡片与跨项目行的显隐规则：没探到（null）或文件数与增删行数全为 0 时整体隐藏，免得没改动的任务与真有改动的
// 任务抢注意力。顶栏是「当前分支」的常驻信息，不用这条规则。
export function shouldDisplayWorktreeUncommittedChangeSummary(counts: WorktreeUncommittedChangeCounts): boolean {
	return (
		counts.changedFiles != null &&
		(counts.changedFiles !== 0 || (counts.additions ?? 0) !== 0 || (counts.deletions ?? 0) !== 0)
	);
}

export function WorktreeUncommittedChangeSummaryIndicator({
	changedFiles,
	additions,
	deletions,
	parenthesesAndChangedFileCountClassName,
	parenthesesAndChangedFileCountStyle,
	showUncommittedChangeBackground = false,
	allowLineWrapping = false,
}: {
	changedFiles: number;
	additions: number;
	deletions: number;
	parenthesesAndChangedFileCountClassName?: string;
	parenthesesAndChangedFileCountStyle?: CSSProperties;
	showUncommittedChangeBackground?: boolean;
	allowLineWrapping?: boolean;
}): ReactElement {
	const mutedProps = showUncommittedChangeBackground
		? {}
		: {
				className: parenthesesAndChangedFileCountClassName,
				style: parenthesesAndChangedFileCountStyle,
			};
	const additionsTextColorClassName = showUncommittedChangeBackground
		? "text-[color-mix(in_oklab,var(--color-status-green)_30%,var(--color-text-primary))]"
		: "text-status-green";
	const deletionsTextColorClassName = showUncommittedChangeBackground
		? "text-[color-mix(in_oklab,var(--color-status-red)_30%,var(--color-text-primary))]"
		: "text-status-red";
	const changeSummary = (
		<>
			<span {...mutedProps}>(</span>
			<span {...mutedProps}>
				{changedFiles} {changedFiles === 1 ? "file" : "files"}
			</span>
			<span className={cn(additionsTextColorClassName, allowLineWrapping && "whitespace-nowrap")}>
				{" "}
				+{additions}
			</span>
			<span className={cn(deletionsTextColorClassName, allowLineWrapping && "whitespace-nowrap")}>
				{" "}
				-{deletions}
			</span>
			<span {...mutedProps}>)</span>
		</>
	);
	return showUncommittedChangeBackground ? (
		<span
			className={cn(
				"inline-block rounded-sm bg-status-orange/30 px-0.5 align-baseline text-text-primary ring-1 ring-inset ring-status-orange/70",
				allowLineWrapping ? "max-w-full whitespace-normal" : "whitespace-nowrap",
			)}
		>
			{changeSummary}
		</span>
	) : (
		changeSummary
	);
}
