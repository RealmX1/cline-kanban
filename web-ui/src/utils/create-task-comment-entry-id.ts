// 局域网 HTTP 的触屏访问可能没有 crypto.randomUUID，沿用任务评论既有 ID 后备格式。
export function createTaskCommentEntryId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`task-comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
	);
}
