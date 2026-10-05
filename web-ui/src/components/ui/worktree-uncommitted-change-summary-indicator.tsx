import type { CSSProperties, ReactElement } from "react";

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
}: {
	changedFiles: number;
	additions: number;
	deletions: number;
	parenthesesAndChangedFileCountClassName?: string;
	parenthesesAndChangedFileCountStyle?: CSSProperties;
}): ReactElement {
	const mutedProps = {
		className: parenthesesAndChangedFileCountClassName,
		style: parenthesesAndChangedFileCountStyle,
	};
	return (
		<>
			<span {...mutedProps}>(</span>
			<span {...mutedProps}>
				{changedFiles} {changedFiles === 1 ? "file" : "files"}
			</span>
			<span className="text-status-green"> +{additions}</span>
			<span className="text-status-red"> -{deletions}</span>
			<span {...mutedProps}>)</span>
		</>
	);
}
