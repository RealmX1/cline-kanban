import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
	CommittedInterWorkUnitRelationLedgerEvent,
	InterWorkUnitRelationLedgerEventDraft,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import {
	getPermanentlyDeletedTaskPromptVersions,
	listPermanentlyDeletedTaskCards,
} from "../../../src/inter-work-unit-relation-ledger/permanently-deleted-task-history";
import {
	applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection,
	createEmptyRecordedInterWorkUnitRelationProjectionState,
} from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";
import {
	RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger,
	type RecordedInterWorkUnitRelationProjectionReader,
} from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";

function historyFixture() {
	const projectionState = createEmptyRecordedInterWorkUnitRelationProjectionState();
	const values = new Map<string, unknown>();
	const readFieldValueHashes: string[] = [];
	const events: InterWorkUnitRelationLedgerEventDraft[] = [];
	let sequence = 0;
	const append = (
		card: KanbanBoardCardWorkUnitQualifiedReference,
		eventKind: string,
		eventPayload: Record<string, unknown>,
	) => {
		const draft: InterWorkUnitRelationLedgerEventDraft = {
			eventFamily: "task_mutation_event",
			eventKind,
			occurredAt: (sequence + 1) * 100,
			actor: { kanbanActorKind: "kanban_runtime_system_component", kanbanRuntimeSystemComponentName: "test" },
			actorNativeConversationSessionIdentity: null,
			actorKanbanTaskConversationSessionId: null,
			actorRepositoryIdentityAtEventTime: null,
			causedBySystemExecutedCause: null,
			capturingKanbanRuntimeInstance: {
				kanbanRuntimeInstanceId: "history-test",
				kanbanRuntimeProcessId: 1,
				kanbanRuntimeCodeVersion: "test",
			},
			invokingKanbanCliCodeVersion: null,
			occurredAtConversationTurnReference: null,
			idempotencyKey: null,
			recordCaptureChannel: "live_runtime_capture",
			subjectWorkspaceId: card.workspaceId,
			subjectTaskId: card.taskId,
			onBehalfOfInitiatingWorkUnit: null,
			eventPayload: { subjectKanbanBoardCard: card, ...eventPayload },
		};
		events.push(draft);
		const event: CommittedInterWorkUnitRelationLedgerEvent = {
			...draft,
			eventId: `event-${++sequence}`,
			globalCommittedEventSequence: sequence,
			recordedInSourceOfTruthEventLogAt: sequence,
		};
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(projectionState, [event], () => null);
	};
	const add = (
		workspaceId: string,
		taskId: string,
		initialPrompt: unknown,
		finalPrompt: unknown,
		incarnation = 1,
		remove = true,
	) => {
		const card: KanbanBoardCardWorkUnitQualifiedReference = {
			workUnitType: "kanban_board_card",
			workspaceId,
			taskId,
			taskIncarnationCreatedAtEpochMs: incarnation,
		};
		const prefix = `${workspaceId}:${taskId}:${incarnation}`;
		values.set(`${prefix}:initial`, initialPrompt);
		values.set(`${prefix}:final`, finalPrompt);
		values.set(`${prefix}:title`, "历史任务标题");
		append(card, "task_card_created_on_board", {
			fieldValueSha256ByFieldNameAtCreation: { prompt: `${prefix}:initial` },
		});
		if (remove)
			append(card, "task_card_permanently_removed_from_board", {
				lastFieldValueSha256ByFieldNameBeforeRemoval: { title: `${prefix}:title`, prompt: `${prefix}:final` },
			});
		return card;
	};
	const reader: RecordedInterWorkUnitRelationProjectionReader = {
		projectionState,
		findRetainedTaskCardFieldKeywordMatchesBySha256: async (hashes, tokens) =>
			new Map(
				hashes.flatMap((hash) => {
					const value = values.get(hash);
					if (typeof value !== "string") return [];
					const matches = tokens.flatMap((token, index) =>
						value.toLocaleLowerCase().includes(token) ? [index] : [],
					);
					return matches.length ? [[hash, matches] as const] : [];
				}),
			),
		readRetainedTaskCardFieldValuesBySha256: async (hashes) => {
			readFieldValueHashes.push(...hashes);
			return new Map(hashes.filter((hash) => values.has(hash)).map((hash) => [hash, values.get(hash)]));
		},
	};
	return { add, append, reader, values, readFieldValueHashes, events };
}

describe("永久删除 Task 的只读历史", () => {
	it.each(["3C487", "3c4"])("ID token %s 可与标题及两版 Prompt 逐 token AND", async (idToken) => {
		const f = historyFixture();
		const target = f.add("project-a", "3c487", "创建时需求 ÉCOLE", "删除前需求 最新");
		f.add("project-b", "3c487", "创建时需求 ÉCOLE", "删除前需求 最新", 2);
		f.add("project-a", "3c487", "另一世", "另一世", 3);
		const page = await listPermanentlyDeletedTaskCards(
			f.reader,
			{ workspaceId: "project-a", query: `${idToken}\u00a0历史任务标题\tÉcole 最新`, cursor: null },
			() => null,
		);
		expect(page.entries.map((entry) => entry.kanbanBoardCard)).toEqual([target]);
		expect(page.entries[0]?.matchedPromptVersions).toEqual(["before_permanent_removal", "at_creation"]);
		expect(f.readFieldValueHashes).toHaveLength(2);
		await expect(
			listPermanentlyDeletedTaskCards(f.reader, { query: `${idToken} 不存在`, cursor: null }, () => null),
		).resolves.toMatchObject({ entries: [] });
		await expect(
			listPermanentlyDeletedTaskCards(f.reader, { query: "3c 最新", cursor: null }, () => null),
		).resolves.toMatchObject({ entries: [] });
	});
	it("组合查询中的完整 ID token 优先，并在关键词结果间继续分页", async () => {
		const f = historyFixture();
		const exact = f.add("project-a", "3c487", "创建时需求", "最新需求");
		for (let index = 0; index < 25; index++)
			f.add("project-a", `a${String(index).padStart(4, "0")}`, "引用 3c487", "最新需求");
		const first = await listPermanentlyDeletedTaskCards(f.reader, { query: "3c487 需求", cursor: null }, () => null);
		expect(first.entries[0]?.kanbanBoardCard).toEqual(exact);
		expect(first.entries).toHaveLength(20);
		const second = await listPermanentlyDeletedTaskCards(
			f.reader,
			{ query: "3c487 需求", cursor: first.nextCursor },
			() => null,
		);
		expect(second.entries).toHaveLength(6);
		expect(second.nextCursor).toBeNull();
		expect(new Set([...first.entries, ...second.entries].map((entry) => entry.kanbanBoardCard.taskId)).size).toBe(26);
	});
	it("组合查询保持缺失历史含义，400 条长正文只读取命中页字段", async () => {
		const f = historyFixture();
		const target = f.add("project-a", "3c487", "", "需求");
		f.values.delete("project-a:3c487:1:initial");
		for (let index = 0; index < 400; index++)
			f.add("project-a", `a${String(index).padStart(4, "0")}`, "创建时需求".repeat(1000), "删除前需求".repeat(1000));
		const page = await listPermanentlyDeletedTaskCards(f.reader, { query: "3c487 需求", cursor: null }, () => null);
		expect(page.entries.map((entry) => entry.kanbanBoardCard)).toEqual([target]);
		expect(page.entries[0]?.matchedPromptVersions).toEqual(["before_permanent_removal"]);
		expect(f.readFieldValueHashes).toHaveLength(2);
		expect(
			(await getPermanentlyDeletedTaskPromptVersions(f.reader, { kanbanBoardCard: target })).atCreation.availability,
		).toBe("content_missing_or_invalid");
		f.values.delete("project-a:3c487:1:final");
		await expect(
			listPermanentlyDeletedTaskCards(f.reader, { query: "3c487 需求", cursor: null }, () => null),
		).resolves.toMatchObject({ entries: [] });
		const titleOnly = await listPermanentlyDeletedTaskCards(
			f.reader,
			{ query: "3c487 历史任务标题", cursor: null },
			() => null,
		);
		expect(titleOnly.entries.map((entry) => entry.kanbanBoardCard)).toEqual([target]);
		expect(titleOnly.entries[0]?.promptPreview).toBeNull();
	});
	it("空查询先分页，400 条长正文只读取当前页标题与删除前预览", async () => {
		const f = historyFixture();
		for (let index = 0; index < 400; index++)
			f.add("project-a", `a${String(index).padStart(4, "0")}`, "创建时需求".repeat(1000), "删除前需求".repeat(1000));
		const page = await listPermanentlyDeletedTaskCards(f.reader, { query: "", cursor: null }, () => null);
		expect(page.entries).toHaveLength(20);
		expect(page.entries[0]?.kanbanBoardCard.taskId).toBe("a0399");
		expect(page.nextCursor).not.toBeNull();
		expect(f.readFieldValueHashes).toHaveLength(40);
		expect(f.readFieldValueHashes.some((hash) => hash.endsWith(":initial"))).toBe(false);
	});
	it("精确 ID 仍保留正文中包含该 ID 的结果，只水合命中页的正文", async () => {
		const f = historyFixture();
		const exact = f.add("project-a", "a0000", "创建时需求".repeat(1000), "删除前需求".repeat(1000));
		for (let index = 1; index < 400; index++)
			f.add("project-a", `a${String(index).padStart(4, "0")}`, "创建时需求".repeat(1000), "删除前需求".repeat(1000));
		const keyword = f.add("project-b", "other", "正文引用 A0000", "没有匹配");
		const page = await listPermanentlyDeletedTaskCards(f.reader, { query: "a0000", cursor: null }, () => null);
		expect(page.entries.map((entry) => entry.kanbanBoardCard)).toEqual([exact, keyword]);
		expect(page.entries[1]?.matchedPromptVersions).toEqual(["at_creation"]);
		expect(page.nextCursor).toBeNull();
		expect(f.readFieldValueHashes).toHaveLength(4);
	});
	it("真实 caught-up reader 的关键词扫描不水合未命中正文，保持 Unicode 与跨版本 AND", async () => {
		const f = historyFixture();
		const exact = f.add("project-a", "a0000", "创建时需求".repeat(1000), "删除前需求".repeat(1000));
		for (let index = 1; index < 400; index++)
			f.add("project-a", `a${String(index).padStart(4, "0")}`, "创建时需求".repeat(1000), "删除前需求".repeat(1000));
		const keyword = f.add("project-b", "other", "正文引用 A0000", "没有匹配");
		const unicode = f.add("project-a", "unico", "Σ 创建", "😀 删除前");
		f.values.set("project-a:unico:1:title", "École 标题");
		const storageRoot = await mkdtemp(join(tmpdir(), "deleted-task-history-keyword-worker-"));
		const ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(storageRoot);
		onTestFinished(async () => {
			await ledgerClient.close();
			await rm(storageRoot, { recursive: true, force: true });
		});
		await ledgerClient.appendCommittedEvents({
			eventDrafts: f.events,
			retainedFieldContents: [...f.values].map(([fieldValueSha256, value]) => ({
				fieldValueSha256,
				fieldValueCanonicalJson: JSON.stringify(value),
			})),
		});
		const retainedContentReads = vi.spyOn(ledgerClient, "readRetainedFieldContents");
		const keywordScans = vi.spyOn(ledgerClient, "findRetainedTaskCardFieldKeywordMatches");
		const projection = new RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger(ledgerClient);
		const exactPage = await projection.readCaughtUpProjection((reader) =>
			listPermanentlyDeletedTaskCards(reader, { query: "a0000", cursor: null }, () => null),
		);
		expect(exactPage.entries.map((entry) => entry.kanbanBoardCard)).toEqual([exact, keyword]);
		expect(retainedContentReads.mock.calls.flatMap(([hashes]) => hashes)).toHaveLength(4);
		expect(keywordScans.mock.calls.every(([input]) => input.fieldValueSha256s.length <= 96)).toBe(true);
		const unicodePage = await projection.readCaughtUpProjection((reader) =>
			listPermanentlyDeletedTaskCards(reader, { query: "  unico éCOLE\u00a0σ\t😀  ", cursor: null }, () => null),
		);
		expect(unicodePage.entries.map((entry) => entry.kanbanBoardCard)).toEqual([unicode]);
		expect(unicodePage.entries[0]?.matchedPromptVersions).toEqual(["before_permanent_removal", "at_creation"]);
		// 关键词扫描未缓存其余正文：空查询的 40 个页内字段中，仍有 36 个需要实际读取。
		retainedContentReads.mockClear();
		keywordScans.mockClear();
		await projection.readCaughtUpProjection((reader) =>
			listPermanentlyDeletedTaskCards(reader, { query: "", cursor: null }, () => null),
		);
		expect(retainedContentReads.mock.calls.flatMap(([hashes]) => hashes)).toHaveLength(36);
		expect(keywordScans).not.toHaveBeenCalled();
		await ledgerClient.appendCommittedEvents({
			eventDrafts: [],
			retainedFieldContents: [
				{ fieldValueSha256: "invalid-json", fieldValueCanonicalJson: "损坏的 JSON" },
				{ fieldValueSha256: "non-string", fieldValueCanonicalJson: "42" },
			],
		});
		expect(
			await ledgerClient.findRetainedTaskCardFieldKeywordMatches({
				fieldValueSha256s: ["invalid-json", "non-string", "missing"],
				normalizedQueryTokens: ["损坏", "42"],
			}),
		).toEqual([]);
	});
	it("跨多个关键词扫描批次继续分页，仍拒绝不匹配当前查询的游标", async () => {
		const f = historyFixture();
		for (let index = 0; index < 90; index++)
			f.add("project-a", `a${String(index).padStart(4, "0")}`, index % 2 ? "共同关键词" : "不匹配", "其他正文");
		const all = [];
		let cursor: string | null = null;
		do {
			const page = await listPermanentlyDeletedTaskCards(f.reader, { query: "共同关键词", cursor }, () => null);
			all.push(...page.entries.map((entry) => entry.kanbanBoardCard.taskId));
			cursor = page.nextCursor;
		} while (cursor);
		expect(all).toEqual(Array.from({ length: 45 }, (_, index) => `a${String(89 - index * 2).padStart(4, "0")}`));
		const first = await listPermanentlyDeletedTaskCards(f.reader, { query: "", cursor: null }, () => null);
		await expect(
			listPermanentlyDeletedTaskCards(f.reader, { query: "共同关键词", cursor: first.nextCursor }, () => null),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("按完整身份隔离跨项目与 incarnation，排除活卡，搜索两个版本的关键词", async () => {
		const f = historyFixture();
		const target = f.add("project-a", "3c487", "最初需求 Backlog", "删除前需求 最新");
		f.add("project-b", "3c487", "其他项目", "其他项目", 2);
		f.add("project-a", "3c487", "另一世", "另一世", 3);
		f.add("project-a", "alive", "活卡", "活卡", 4, false);
		const before = JSON.stringify([
			...f.reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey,
		]);
		const page = await listPermanentlyDeletedTaskCards(
			f.reader,
			{ workspaceId: "project-a", query: "backlog", cursor: null },
			() => null,
		);
		expect(page.entries.map((entry) => entry.kanbanBoardCard)).toEqual([target]);
		expect(page.entries[0]?.matchedPromptVersions).toEqual(["at_creation"]);
		const versions = await getPermanentlyDeletedTaskPromptVersions(f.reader, { kanbanBoardCard: target });
		expect(versions.beforePermanentRemoval).toEqual({ availability: "available", text: "删除前需求 最新" });
		expect(versions.atCreation.text).toBe("最初需求 Backlog");
		expect(versions.comparison).toBe("different");
		expect(
			JSON.stringify([
				...f.reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey,
			]),
		).toBe(before);
	});
	it("完整正文不截断，空字符串有效，缺失/损坏与未记录分别说明", async () => {
		const f = historyFixture();
		const text = `  原始\r\n${"很长的正文😀\n".repeat(200)}  `;
		const target = f.add("project-a", "long1", text, text);
		expect(
			(await getPermanentlyDeletedTaskPromptVersions(f.reader, { kanbanBoardCard: target })).beforePermanentRemoval
				.text,
		).toBe(text);
		const empty = f.add("project-a", "empty", "", "");
		expect(
			(await getPermanentlyDeletedTaskPromptVersions(f.reader, { kanbanBoardCard: empty })).beforePermanentRemoval,
		).toEqual({ availability: "available", text: "" });
		f.values.delete("project-a:empty:1:final");
		expect(
			(await getPermanentlyDeletedTaskPromptVersions(f.reader, { kanbanBoardCard: empty })).beforePermanentRemoval
				.availability,
		).toBe("content_missing_or_invalid");
		const incomplete = { ...target, taskId: "old00" };
		f.append(incomplete, "task_card_permanently_removed_from_board", {});
		const missing = await getPermanentlyDeletedTaskPromptVersions(f.reader, { kanbanBoardCard: incomplete });
		expect(missing.atCreation.availability).toBe("not_recorded");
		expect(missing.beforePermanentRemoval.availability).toBe("not_recorded");
		expect(missing.comparison).toBe("unknown");
	});
	it("精确 ID 优先，分页无重复，项目取消注册后仍能返回历史身份", async () => {
		const f = historyFixture();
		for (let i = 0; i < 24; i++)
			f.add("removed-project", `a${String(i).padStart(4, "0")}`, "共同关键词", "共同关键词");
		const first = await listPermanentlyDeletedTaskCards(f.reader, { query: "共同关键词", cursor: null }, () => null);
		expect(first.entries).toHaveLength(20);
		const second = await listPermanentlyDeletedTaskCards(
			f.reader,
			{ query: "共同关键词", cursor: first.nextCursor },
			() => null,
		);
		expect(second.entries).toHaveLength(4);
		expect(new Set([...first.entries, ...second.entries].map((entry) => entry.kanbanBoardCard.taskId)).size).toBe(24);
		expect(
			(await listPermanentlyDeletedTaskCards(f.reader, { query: "a0001", cursor: null }, () => null)).entries[0]
				?.kanbanBoardCard.taskId,
		).toBe("a0001");
	});
	it("删除前快照不受同一身份的后续字段事件影响", async () => {
		const f = historyFixture();
		const card = f.add("project-a", "late1", "创建时需求", "删除前需求");
		f.values.set("later-prompt", "晚到的字段事件");
		f.append(card, "task_card_field_value_changed", {
			changedTaskCardFieldName: "prompt",
			fieldValueAfterSha256: "later-prompt",
		});
		expect(
			(await getPermanentlyDeletedTaskPromptVersions(f.reader, { kanbanBoardCard: card })).beforePermanentRemoval
				.text,
		).toBe("删除前需求");
	});
});
