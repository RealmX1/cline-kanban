import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeTaskChatMessage } from "../core/api-contract";

const explicitReportSchema = z
	.object({
		targetTaskConversationSessionId: z.string().min(1).optional(),
		text: z.string().trim().min(1).max(1_000_000),
	})
	.strict();

// 只解析 assistant 正文的末尾声明；代码块和 Markdown 引用不能借示例触发发送。
export function parseExplicitTaskConversationSessionReport(text: string): z.infer<typeof explicitReportSchema> | null {
	const match = /(?:^|\n\n)<kanban-session-report>\s*\n([\s\S]+?)\n<\/kanban-session-report>\s*$/.exec(text);
	if (!match) return null;
	const prefix = text.slice(0, match.index);
	if ((prefix.match(/^\s*```/gm)?.length ?? 0) % 2 || (prefix.match(/^\s*~~~/gm)?.length ?? 0) % 2) return null;
	try {
		const parsed = explicitReportSchema.safeParse(JSON.parse(match[1] ?? ""));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

// 原生分支复制可能重写消息 ID；保留正文与原生时间的等价证据，避免把复制品当成新的回报。
export function computeAssistantMessageProvenanceSha256(
	message: Pick<RuntimeTaskChatMessage, "content" | "createdAt">,
): string {
	return createHash("sha256")
		.update(JSON.stringify([message.createdAt, message.content]))
		.digest("hex");
}
