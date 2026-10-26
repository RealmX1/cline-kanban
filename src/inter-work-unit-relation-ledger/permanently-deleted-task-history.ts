import { TRPCError } from "@trpc/server";
import type {
	ListPermanentlyDeletedTaskCardsRequest,
	ListPermanentlyDeletedTaskCardsResponse,
	PermanentlyDeletedTaskPromptVersionsRequest,
	PermanentlyDeletedTaskPromptVersionsResponse,
	RetainedTaskPromptVersion,
} from "../core/permanently-deleted-task-history-contract";
import { runtimeTaskStickerEntrySchema } from "../core/task-sticker-entry-contract";
import {
	buildInterWorkUnitRelationWorkUnitKey,
	type KanbanBoardCardIdentityProjection,
} from "./kanban-board-card-identity-projection-from-ledger-events";
import type { RecordedInterWorkUnitRelationProjectionReader } from "./recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";

const retainedTaskStickerEntriesSchema = runtimeTaskStickerEntrySchema.array();

function resolveRetainedTaskPromptVersionAvailability(
	values: Map<string, unknown>,
	hash: string | undefined,
): RetainedTaskPromptVersion {
	if (!hash) return { availability: "not_recorded", text: null };
	const text = values.get(hash);
	return typeof text === "string"
		? { availability: "available", text }
		: { availability: "content_missing_or_invalid", text: null };
}

async function readPermanentlyDeletedTaskPromptVersionsFromIdentityProjection(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	projection: KanbanBoardCardIdentityProjection,
): Promise<PermanentlyDeletedTaskPromptVersionsResponse> {
	const beforeHash = projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.prompt;
	const creationHash = projection.fieldValueSha256ByFieldNameAtCreation?.prompt;
	const values = await reader.readRetainedTaskCardFieldValuesBySha256(
		[beforeHash, creationHash].filter((hash): hash is string => !!hash),
	);
	const beforePermanentRemoval = resolveRetainedTaskPromptVersionAvailability(values, beforeHash);
	const atCreation = resolveRetainedTaskPromptVersionAvailability(values, creationHash);
	return {
		beforePermanentRemoval,
		atCreation,
		comparison:
			beforePermanentRemoval.availability === "available" && atCreation.availability === "available"
				? beforePermanentRemoval.text === atCreation.text
					? "same"
					: "different"
				: "unknown",
	};
}

export async function getPermanentlyDeletedTaskPromptVersions(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	input: PermanentlyDeletedTaskPromptVersionsRequest,
): Promise<PermanentlyDeletedTaskPromptVersionsResponse> {
	const projection =
		reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.get(
			buildInterWorkUnitRelationWorkUnitKey(input.kanbanBoardCard),
		);
	if (!projection || projection.permanentlyRemovedFromBoardAt === null)
		throw new TRPCError({ code: "NOT_FOUND", message: "账本中没有该身份的永久删除记录。" });
	return readPermanentlyDeletedTaskPromptVersionsFromIdentityProjection(reader, projection);
}

export async function listPermanentlyDeletedTaskCards(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	input: ListPermanentlyDeletedTaskCardsRequest,
	getWorkspacePathById: (workspaceId: string) => string | null,
): Promise<ListPermanentlyDeletedTaskCardsResponse> {
	const identityState = reader.projectionState.kanbanBoardCardIdentityProjectionState;
	const deleted = [...identityState.projectionsByKanbanBoardCardWorkUnitKey.values()].filter(
		(entry) => entry.permanentlyRemovedFromBoardAt !== null,
	);
	const workspacePath = (id: string) =>
		getWorkspacePathById(id) ?? identityState.workspaceRepositoryPathByWorkspaceIdObservedAtBaseline.get(id) ?? null;
	const knownWorkspaces = [...new Set(deleted.map((entry) => entry.kanbanBoardCard.workspaceId))]
		.sort()
		.map((workspaceId) => ({ workspaceId, workspaceRepositoryPath: workspacePath(workspaceId) }));
	const query = (input.query ?? "").trim().toLocaleLowerCase();
	const tokens = query.split(/\s+/u).filter(Boolean);
	const scoped = deleted.filter(
		(entry) => !input.workspaceId || entry.kanbanBoardCard.workspaceId === input.workspaceId,
	);
	// 先按身份排序并定位游标；正文匹配按固定批次在 worker 执行，主线程只水合最终一页。
	scoped.sort(
		(a, b) =>
			Number(tokens.includes(b.kanbanBoardCard.taskId.toLocaleLowerCase())) -
				Number(tokens.includes(a.kanbanBoardCard.taskId.toLocaleLowerCase())) ||
			(b.permanentlyRemovedFromBoardAt as number) - (a.permanentlyRemovedFromBoardAt as number) ||
			buildInterWorkUnitRelationWorkUnitKey(a.kanbanBoardCard).localeCompare(
				buildInterWorkUnitRelationWorkUnitKey(b.kanbanBoardCard),
			),
	);
	const cursorIndex = input.cursor
		? scoped.findIndex((entry) => buildInterWorkUnitRelationWorkUnitKey(entry.kanbanBoardCard) === input.cursor)
		: -1;
	const staleCursorError = () => new TRPCError({ code: "BAD_REQUEST", message: "历史列表已变化，请刷新后继续。" });
	if (input.cursor && cursorIndex < 0) throw staleCursorError();
	const matchingPage: {
		projection: KanbanBoardCardIdentityProjection;
		matchedPromptVersions: ("before_permanent_removal" | "at_creation")[];
	}[] = [];
	if (!tokens.length) {
		matchingPage.push(
			...scoped
				.slice(cursorIndex + 1, cursorIndex + 22)
				.map((projection) => ({ projection, matchedPromptVersions: [] })),
		);
	} else {
		const keywordSearchIdentityBatchSize = 32;
		for (
			let start = Math.max(cursorIndex, 0);
			start < scoped.length && matchingPage.length < 21;
			start += keywordSearchIdentityBatchSize
		) {
			const batch = scoped.slice(start, start + keywordSearchIdentityBatchSize);
			const fieldHashes = (entry: KanbanBoardCardIdentityProjection) => [
				entry.lastFieldValueSha256ByFieldNameBeforeRemoval?.title,
				entry.lastFieldValueSha256ByFieldNameBeforeRemoval?.prompt,
				entry.fieldValueSha256ByFieldNameAtCreation?.prompt,
			];
			const hashes = [...new Set(batch.flatMap(fieldHashes).filter((hash): hash is string => !!hash))];
			const keywordMatches = await reader.findRetainedTaskCardFieldKeywordMatchesBySha256(hashes, tokens);
			for (const [batchIndex, projection] of batch.entries()) {
				const id = projection.kanbanBoardCard.taskId.toLocaleLowerCase();
				const matchesEveryQueryToken = tokens.every(
					(token, tokenIndex) =>
						id === token ||
						(token.length >= 3 && id.includes(token)) ||
						fieldHashes(projection).some((hash) => hash && keywordMatches.get(hash)?.includes(tokenIndex)),
				);
				if (start + batchIndex === cursorIndex) {
					if (!matchesEveryQueryToken) throw staleCursorError();
					continue;
				}
				if (!matchesEveryQueryToken) continue;
				const matchedPromptVersions: ("before_permanent_removal" | "at_creation")[] = [];
				const beforeHash = projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.prompt;
				const creationHash = projection.fieldValueSha256ByFieldNameAtCreation?.prompt;
				if (beforeHash && keywordMatches.has(beforeHash)) matchedPromptVersions.push("before_permanent_removal");
				if (creationHash && keywordMatches.has(creationHash)) matchedPromptVersions.push("at_creation");
				matchingPage.push({ projection, matchedPromptVersions });
				if (matchingPage.length === 21) break;
			}
		}
	}
	const page = matchingPage.slice(0, 20);
	const pageHashes = page.flatMap(({ projection }) => [
		projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.title,
		projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.prompt,
		projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.taskStickerEntries,
	]);
	const values = await reader.readRetainedTaskCardFieldValuesBySha256([
		...new Set(pageHashes.filter((hash): hash is string => !!hash)),
	]);
	const readText = (hash: string | undefined) => {
		const value = hash ? values.get(hash) : null;
		return typeof value === "string" ? value : null;
	};
	const readStickerEntries = (hash: string | undefined) => {
		const parsed = retainedTaskStickerEntriesSchema.safeParse(hash ? values.get(hash) : undefined);
		return parsed.success ? parsed.data : [];
	};
	const entries = page.map(({ projection, matchedPromptVersions }) => ({
		kanbanBoardCard: projection.kanbanBoardCard,
		workspaceRepositoryPath: workspacePath(projection.kanbanBoardCard.workspaceId),
		titleBeforePermanentRemoval: readText(projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.title),
		permanentlyRemovedFromBoardAt: projection.permanentlyRemovedFromBoardAt as number,
		promptPreview: readText(projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.prompt)?.slice(0, 240) ?? null,
		taskStickerEntries: readStickerEntries(
			projection.lastFieldValueSha256ByFieldNameBeforeRemoval?.taskStickerEntries,
		),
		matchedPromptVersions,
	}));
	const last = entries.at(-1);
	return {
		entries,
		nextCursor: last && matchingPage.length > 20 ? buildInterWorkUnitRelationWorkUnitKey(last.kanbanBoardCard) : null,
		knownWorkspaces,
	};
}
