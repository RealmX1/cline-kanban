import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { projectUniqueNativeInProgressWorkPhaseGoal } from "../core/agent-current-work-phase-goal";

const nativeTaskSchema = z.object({
	subject: z.string(),
	activeForm: z.string().optional(),
	status: z.enum(["pending", "in_progress", "completed", "deleted"]),
});

// 仅精确匹配当前原生会话的默认清单；共享清单不猜归属。只在 Task 工具的完成事件读取，不轮询。
export async function readClaudeNativeTaskListCurrentWorkPhaseGoal(input: {
	nativeConversationSessionId: string;
	reportedTaskListId: string | null;
	userPromptDeliveredAt?: number;
	claudeTasksDirectory?: string;
}): Promise<{ goalText: string; updatedAt: number } | null> {
	if (
		input.reportedTaskListId !== input.nativeConversationSessionId ||
		!/^[A-Za-z0-9_-]{1,200}$/u.test(input.nativeConversationSessionId)
	)
		return null;
	try {
		const directory = join(
			input.claudeTasksDirectory ?? join(homedir(), ".claude", "tasks"),
			input.nativeConversationSessionId,
		);
		const names = (await readdir(directory)).filter((name) => /^\d+\.json$/u.test(name));
		if (names.length > 1000) return null;
		const tasks = await Promise.all(
			names.map(async (name) => {
				const path = join(directory, name);
				const information = await stat(path);
				if (information.size > 128_000) throw new Error("原生 Task 记录过大");
				return {
					...nativeTaskSchema.parse(JSON.parse(await readFile(path, "utf8"))),
					updatedAt: information.mtimeMs,
				};
			}),
		);
		const goalText = projectUniqueNativeInProgressWorkPhaseGoal(tasks);
		const updatedAt = tasks.find((task) => task.status === "in_progress")?.updatedAt ?? 0;
		return goalText && updatedAt > (input.userPromptDeliveredAt ?? -1) ? { goalText, updatedAt } : null;
	} catch {
		return null;
	}
}
