import type { BoardColumnId } from "@/types";

// 提交 SHA 紧凑展示：截 7 位（与 git 短 hash 习惯一致）。
export function shortenCommitSha(sha: string): string {
	return sha.slice(0, 7);
}

// deploy 时间紧凑展示：本地时区「月-日 时:分」，跨进程 ISO 字符串解析失败时回退原文。
export function formatDeployTimestamp(iso: string): string {
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) {
		return iso;
	}
	return new Date(parsed).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// old→new SHA 区间的可读串；old 为 null（首次 deploy / 无前序）时仅显示 new。
export function formatDeployShaRange(previousSha: string | null, deployedSha: string): string {
	const deployed = shortenCommitSha(deployedSha);
	if (!previousSha) {
		return deployed;
	}
	return `${shortenCommitSha(previousSha)} → ${deployed}`;
}

// 看板列 id → 用户可见文案（trash 对用户即 Done，见 plan 术语表）。
const BOARD_COLUMN_DISPLAY_LABEL: Record<BoardColumnId, string> = {
	backlog: "Backlog",
	in_progress: "In Progress",
	review: "Review",
	validation: "Validation",
	trash: "Done",
};

export function formatBoardColumnLabel(columnId: BoardColumnId): string {
	return BOARD_COLUMN_DISPLAY_LABEL[columnId];
}

// 列 badge 的语义色（design token）。
const BOARD_COLUMN_BADGE_CLASSNAME: Record<BoardColumnId, string> = {
	backlog: "border-border bg-surface-3 text-text-tertiary",
	in_progress: "border-status-blue/30 bg-status-blue/10 text-status-blue",
	review: "border-status-purple/30 bg-status-purple/10 text-status-purple",
	validation: "border-status-orange/30 bg-status-orange/10 text-status-orange",
	trash: "border-status-green/30 bg-status-green/10 text-status-green",
};

export function boardColumnBadgeClassName(columnId: BoardColumnId): string {
	return BOARD_COLUMN_BADGE_CLASSNAME[columnId];
}
