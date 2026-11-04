import { useState } from "react";
import { Button } from "@/components/ui/button";
import { renameTaskConversationSession } from "@/runtime/task-conversation-session-creation-query";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";

export function ConversationSessionNameEditor({
	workspaceId,
	taskCard,
	summary,
}: {
	workspaceId: string;
	taskCard: BoardCard;
	summary: RuntimeTaskSessionSummary;
}) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = async () => {
		if (!name.trim() || pending) return;
		setPending(true);
		setError(null);
		try {
			const result = await renameTaskConversationSession(workspaceId, {
				taskId: taskCard.id,
				expectedTaskIncarnationCreatedAtEpochMs: taskCard.createdAt,
				taskConversationSessionId: summary.taskId,
				expectedNameVersion: summary.taskConversationSessionMetadata?.conversationSessionNameVersion ?? 0,
				conversationSessionName: name.trim(),
			});
			if (result.ok) setEditing(false);
			else setError(result.error ?? "改名失败，输入已保留。");
		} catch (cause) {
			setError(String(cause));
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="px-2 pb-2">
			{editing ? (
				<div className="flex flex-wrap gap-1">
					<input
						aria-label="会话主题名"
						maxLength={80}
						value={name}
						disabled={pending}
						className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 text-xs text-text-primary"
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void save();
							}
						}}
					/>
					<Button size="sm" disabled={pending || !name.trim()} onClick={() => void save()}>
						保存名称
					</Button>
					<Button size="sm" disabled={pending} onClick={() => setEditing(false)}>
						取消
					</Button>
				</div>
			) : (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						setName(summary.taskConversationSessionMetadata?.conversationSessionName ?? "");
						setEditing(true);
					}}
				>
					重命名会话
				</Button>
			)}
			{error && (
				<p role="alert" className="text-xs text-status-red">
					{error}
				</p>
			)}
		</div>
	);
}
