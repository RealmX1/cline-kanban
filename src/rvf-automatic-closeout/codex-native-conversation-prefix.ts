import { resolve } from "node:path";
import { z } from "zod";

// 只描述本功能消费的稳定协议字段；其它原生 item 保留在 Codex 内，不复制或改写 transcript。
const nativeItemSchema = z.looseObject({
	id: z.string(),
	type: z.string(),
	content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
});
const nativeTurnSchema = z.object({ id: z.string(), status: z.string(), items: z.array(nativeItemSchema) });
const turnPageSchema = z.object({ data: z.array(nativeTurnSchema), nextCursor: z.string().nullable() });
const forkResponseSchema = z.object({ thread: z.object({ id: z.string(), path: z.string(), cwd: z.string() }) });
export type CodexNativeConversationTurn = z.infer<typeof nativeTurnSchema>;
export interface CodexAppServerRequestPort {
	request: (method: string, parameters: Record<string, unknown>) => Promise<unknown>;
}
export interface RestoredCodexConversationIdentity {
	nativeSessionId: string;
	transcriptPath: string;
}

export async function readCodexConversationTurns(port: CodexAppServerRequestPort, threadId: string) {
	const turns: CodexNativeConversationTurn[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	do {
		const page = turnPageSchema.parse(
			await port.request("thread/turns/list", {
				threadId,
				cursor,
				limit: 100,
				sortDirection: "asc",
				itemsView: "full",
			}),
		);
		turns.push(...page.data);
		cursor = page.nextCursor;
		if (cursor !== null) {
			if (seenCursors.has(cursor)) throw new Error("Codex 回合分页出现循环，无法证明完整历史。");
			seenCursors.add(cursor);
		}
	} while (cursor !== null);
	if (new Set(turns.map((turn) => turn.id)).size !== turns.length) throw new Error("Codex 分页重复返回回合。");
	return turns;
}

export async function forkCodexConversationBeforeReviewTurn(
	port: CodexAppServerRequestPort,
	input: { sourceThreadId: string; boundaryTurnId: string; lastPreReviewTurnId: string; workingDirectory: string },
	onForkCreated?: (identity: RestoredCodexConversationIdentity) => Promise<void> | void,
): Promise<RestoredCodexConversationIdentity> {
	const original = await readCodexConversationTurns(port, input.sourceThreadId);
	const boundaryIndex = original.findIndex((turn) => turn.id === input.boundaryTurnId);
	const prefix = original.slice(0, boundaryIndex);
	if (boundaryIndex <= 0 || prefix.at(-1)?.id !== input.lastPreReviewTurnId || prefix.at(-1)?.status !== "completed") {
		throw new Error("开审分界与此前完整回合不一致，未创建恢复分支。");
	}
	const forked = forkResponseSchema.parse(
		await port.request("thread/fork", {
			threadId: input.sourceThreadId,
			lastTurnId: input.lastPreReviewTurnId,
			cwd: input.workingDirectory,
		}),
	).thread;
	if (forked.id === input.sourceThreadId || resolve(forked.cwd) !== resolve(input.workingDirectory)) {
		throw new Error("Codex 返回的恢复分支身份或工作目录错误。");
	}
	const identity = { nativeSessionId: forked.id, transcriptPath: forked.path };
	// 副作用先持久化：崩溃重入复验这个分支，不能重新 fork。
	await onForkCreated?.(identity);
	await verifyRestoredCodexConversationPrefix(
		port,
		identity.nativeSessionId,
		prefix.map((turn) => turn.id),
	);
	return identity;
}

export async function verifyRestoredCodexConversationPrefix(
	port: CodexAppServerRequestPort,
	restoredThreadId: string,
	expectedTurnIds: readonly string[],
) {
	const restored = await readCodexConversationTurns(port, restoredThreadId);
	if (
		restored.length !== expectedTurnIds.length ||
		restored.some((turn, index) => turn.id !== expectedTurnIds[index])
	) {
		throw new Error("恢复后的历史没有准确截止于 RVF 之前，未切换主会话。");
	}
}
