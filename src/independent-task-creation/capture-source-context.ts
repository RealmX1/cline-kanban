import { createHash } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { readIndependentTaskCreationTranscript } from "./conversation-context";

async function copyStableTranscript(source: string, target: string) {
	const before = await stat(source);
	await copyFile(source, target);
	const after = await stat(source);
	if (
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		createHash("sha256")
			.update(await readFile(source))
			.digest("hex") !==
			createHash("sha256")
				.update(await readFile(target))
				.digest("hex")
	) {
		throw new Error("来源转录正在变化，请等当前回答结束后重试。");
	}
}

export async function independentTaskSourceTranscriptStillMatchesSnapshot(
	source: RuntimeTaskSessionSummary,
	artifactDirectory: string,
) {
	const path = source.agentNativeConversationSessionIdentity?.transcriptPath;
	if (!path) return false;
	try {
		const [live, snapshot] = await Promise.all([
			readFile(path),
			readFile(join(artifactDirectory, "source-transcript.jsonl")),
		]);
		return live.equals(snapshot);
	} catch {
		return false;
	}
}

export async function captureIndependentTaskSourceContext(input: {
	source: RuntimeTaskSessionSummary;
	parent: RuntimeTaskSessionSummary | null;
	artifactDirectory: string;
}) {
	const warnings: string[] = [];
	const sourceIdentity = input.source.agentNativeConversationSessionIdentity;
	if (sourceIdentity && sourceIdentity.sourceAgentId !== input.source.agentId)
		throw new Error(
			"来源原生身份与当前 Agent 不一致，未混入旧 Agent 的历史。可等身份采集完成后重新固定，或手动填写。",
		);
	if (!sourceIdentity?.transcriptPath)
		throw new Error("来源会话没有可读的原生转录，无法自动整理。仍可手动填写任务说明。");
	const sourceSnapshot = join(input.artifactDirectory, "source-transcript.jsonl");
	await copyStableTranscript(sourceIdentity.transcriptPath, sourceSnapshot);
	const allSourceMessages = await readIndependentTaskCreationTranscript(sourceSnapshot, sourceIdentity.sourceAgentId);
	const metadata = input.source.taskConversationSessionMetadata;
	const createdAt = metadata?.sideSessionCreatedAt ?? input.source.startedAt;
	if (!metadata?.sideSessionCreatedAt)
		warnings.push("存量侧会话未记录不可变创建边界，起点按现有启动记录定位；请核对引用。");
	const parentIdentity = input.parent?.agentNativeConversationSessionIdentity;
	const parentMatchesRecordedOriginIdentity =
		(!metadata?.sideSessionOriginMainNativeSessionId ||
			metadata.sideSessionOriginMainNativeSessionId === parentIdentity?.nativeSessionId) &&
		(!metadata?.sideSessionOriginMainAgentId ||
			metadata.sideSessionOriginMainAgentId === parentIdentity?.sourceAgentId);
	const parentPath =
		metadata?.sideSessionOriginMainTranscriptPath ??
		(parentMatchesRecordedOriginIdentity ? parentIdentity?.transcriptPath : undefined);
	if (!metadata?.sideSessionOriginMainTranscriptPath) {
		if (!parentMatchesRecordedOriginIdentity)
			warnings.push("当前主会话原生身份与侧会话创建时记录的来源不一致，未混入其他会话的历史。");
		else if (parentPath && !metadata?.sideSessionOriginMainNativeSessionId)
			warnings.push(
				"存量侧会话未记录来源主会话原生身份，已按当前主会话读取；无法确认与创建时来源一致，请核对引用。",
			);
	}
	const parentAgent =
		metadata?.sideSessionOriginMainAgentId ??
		input.parent?.agentNativeConversationSessionIdentity?.sourceAgentId ??
		sourceIdentity.sourceAgentId;
	let before: Awaited<ReturnType<typeof readIndependentTaskCreationTranscript>> = [];
	if (parentPath && parentPath !== sourceIdentity.transcriptPath && createdAt !== null) {
		try {
			const parentSnapshot = join(input.artifactDirectory, "origin-main-transcript.jsonl");
			await copyStableTranscript(parentPath, parentSnapshot);
			const parentMessages = await readIndependentTaskCreationTranscript(parentSnapshot, parentAgent);
			before = parentMessages.filter((message) => message.submittedAt !== null && message.submittedAt < createdAt);
			if (parentMessages.some((message) => message.submittedAt === null))
				warnings.push("部分来源主会话消息缺少时间，未冒充已证明的起点前历史。");
		} catch (error) {
			warnings.push(
				`起点前的来源主会话无法完整读取，已保留侧会话正文：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else warnings.push("无法定位侧会话起点之前的主会话原文；请核对缺失材料。");
	const after =
		metadata?.taskConversationSessionContextSource === "forked_from_main_current_turn" && createdAt !== null
			? allSourceMessages.filter((message) => message.submittedAt === null || message.submittedAt >= createdAt)
			: allSourceMessages;
	if (!after.some((message) => message.role === "user")) warnings.push("未找到可证明属于侧会话起点之后的用户正文。");
	return { before, after, warnings };
}
