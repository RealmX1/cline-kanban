import { describe, expect, it } from "vitest";
import {
	buildFindingBodyExcerpt,
	buildFindingProvenanceLabel,
	buildSaveFindingBodyPrefill,
	buildSaveFindingProvenance,
	EXPLORATORY_FINDING_BODY_MAX_LENGTH,
	filterFindingsForBrowserView,
	filterFindingsForConversationSession,
	findSimilarExploratoryFindings,
	normalizeFindingTitleForDuplicateCheck,
	resolveSaveFindingTurnAnchor,
} from "@/components/findings/findings-model";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeConversationTurnProjectionEntry,
	RuntimeExploratoryFindingEntry,
	RuntimeExploratoryFindingProvenanceLink,
} from "@/runtime/types";

function createProvenanceLink(
	overrides: Partial<RuntimeExploratoryFindingProvenanceLink> = {},
): RuntimeExploratoryFindingProvenanceLink {
	return {
		linkKind: "turn_anchor",
		conversationSessionTaskId: "session-1",
		turnNumber: 2,
		turnCheckpointCommit: "commit-2",
		...overrides,
	};
}

function createFinding(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
	return {
		findingId: "finding-1",
		findingTitle: "存储方案定了用 SQLite",
		findingBodyMarkdown: "正文 **markdown** 内容",
		findingStatus: "active",
		supersededByFindingId: null,
		findingGenerationSource: "user_saved",
		provenanceLinks: [createProvenanceLink()],
		originConversationSessionTaskId: "session-1",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createTurnEntry(
	turnNumber: number,
	overrides: Partial<RuntimeConversationTurnProjectionEntry> = {},
): RuntimeConversationTurnProjectionEntry {
	return {
		turnNumber,
		turnStartedAt: turnNumber,
		turnUserMessageExcerpt: `T${turnNumber} 用户消息`,
		turnAssistantResponseExcerpt: null,
		turnMessageCount: 2,
		turnCheckpointCommit: `commit-${turnNumber}`,
		turnCheckpointAlignmentConfidence: "exact_ordinal_match",
		turnIsInProgress: false,
		turnHasConversationTreeForkAnchor: false,
		...overrides,
	};
}

function createProjection(
	entries: RuntimeConversationTurnProjectionEntry[],
): RuntimeConversationSessionTurnProjectionResponse {
	return {
		harnessSource: "exact_structured",
		turnProjectionEntries: entries,
		turnProjectionSignature: "2:last:10",
		turnProjectionIsIncomplete: false,
	};
}

describe("normalizeFindingTitleForDuplicateCheck", () => {
	it("小写化并去除空白与标点", () => {
		expect(normalizeFindingTitleForDuplicateCheck("  Hello, World!  ")).toBe("helloworld");
		expect(normalizeFindingTitleForDuplicateCheck("存储方案：SQLite（单文件）")).toBe("存储方案sqlite单文件");
	});

	it("全标点标题归一化为空串", () => {
		expect(normalizeFindingTitleForDuplicateCheck("… — !!!")).toBe("");
	});
});

describe("findSimilarExploratoryFindings", () => {
	it("规范化标题相等 → 命中", () => {
		const existing = createFinding({ findingTitle: "存储方案: SQLite" });
		expect(findSimilarExploratoryFindings([existing], "存储方案 SQLite")).toHaveLength(1);
	});

	it("前缀包含（双向）→ 命中", () => {
		const longer = createFinding({ findingTitle: "存储方案 SQLite 单文件" });
		expect(findSimilarExploratoryFindings([longer], "存储方案 SQLite")).toHaveLength(1);
		const shorter = createFinding({ findingId: "finding-2", findingTitle: "存储" });
		expect(findSimilarExploratoryFindings([shorter], "存储方案 SQLite")).toHaveLength(1);
	});

	it("不相关的标题不命中", () => {
		const existing = createFinding({ findingTitle: "部署流水线用 GitHub Actions" });
		expect(findSimilarExploratoryFindings([existing], "存储方案 SQLite")).toHaveLength(0);
	});

	it("archived / superseded 不参与查重", () => {
		const archived = createFinding({ findingStatus: "archived", findingTitle: "存储方案 SQLite" });
		const superseded = createFinding({
			findingId: "finding-2",
			findingStatus: "superseded",
			findingTitle: "存储方案 SQLite",
		});
		expect(findSimilarExploratoryFindings([archived, superseded], "存储方案 SQLite")).toHaveLength(0);
	});

	it("待确认建议参与查重（确认前撞标题也要提示）", () => {
		const pending = createFinding({
			findingStatus: "suggested_pending_confirmation",
			findingTitle: "存储方案 SQLite",
		});
		expect(findSimilarExploratoryFindings([pending], "存储方案 SQLite")).toHaveLength(1);
	});

	it("空标题 / 归一化后为空 → 不命中", () => {
		const existing = createFinding();
		expect(findSimilarExploratoryFindings([existing], "")).toHaveLength(0);
		expect(findSimilarExploratoryFindings([existing], "… !!!")).toHaveLength(0);
	});
});

describe("buildSaveFindingBodyPrefill", () => {
	it("有选区时优先用选中文本", () => {
		expect(buildSaveFindingBodyPrefill({ selectedText: "  选中的片段  ", messageContent: "整条消息正文" })).toBe(
			"选中的片段",
		);
	});

	it("无选区时回退消息正文", () => {
		expect(buildSaveFindingBodyPrefill({ selectedText: null, messageContent: "  整条消息正文  " })).toBe(
			"整条消息正文",
		);
		expect(buildSaveFindingBodyPrefill({ messageContent: "整条消息正文" })).toBe("整条消息正文");
	});

	it("消息正文里的 map 锚 marker 被摘除（marker 不是正文）", () => {
		const content = "第一段\n\n<!-- kanban:map-anchor node-1 -->\n\n第二段";
		const prefill = buildSaveFindingBodyPrefill({ messageContent: content });
		expect(prefill).not.toContain("kanban:map-anchor");
		expect(prefill).toContain("第一段");
		expect(prefill).toContain("第二段");
	});

	it("截断到契约上限 4000（含省略号）", () => {
		const longContent = "a".repeat(EXPLORATORY_FINDING_BODY_MAX_LENGTH + 500);
		const prefill = buildSaveFindingBodyPrefill({ messageContent: longContent });
		expect(prefill.length).toBeLessThanOrEqual(EXPLORATORY_FINDING_BODY_MAX_LENGTH);
		expect(prefill.endsWith("…")).toBe(true);
	});

	it("恰好不超长时原样保留（不加省略号）", () => {
		const content = "a".repeat(EXPLORATORY_FINDING_BODY_MAX_LENGTH);
		expect(buildSaveFindingBodyPrefill({ messageContent: content })).toBe(content);
	});
});

describe("resolveSaveFindingTurnAnchor", () => {
	const projection = createProjection([createTurnEntry(1), createTurnEntry(2)]);

	it("turn 号 + 投影齐全 → 解析出 commit", () => {
		expect(resolveSaveFindingTurnAnchor({ turnNumber: 2, projection })).toEqual({
			turnNumber: 2,
			turnCheckpointCommit: "commit-2",
		});
	});

	it("该 turn 无 checkpoint → commit null（仅时间锚，仍是合法锚）", () => {
		const unaligned = createProjection([createTurnEntry(1, { turnCheckpointCommit: null })]);
		expect(resolveSaveFindingTurnAnchor({ turnNumber: 1, projection: unaligned })).toEqual({
			turnNumber: 1,
			turnCheckpointCommit: null,
		});
	});

	it("消息映射不到 turn（undefined）→ null（降级 freeform）", () => {
		expect(resolveSaveFindingTurnAnchor({ turnNumber: undefined, projection })).toBeNull();
	});

	it("投影不可用 → null（绝不拿不可核验的 turn 号硬造锚）", () => {
		expect(resolveSaveFindingTurnAnchor({ turnNumber: 1, projection: null })).toBeNull();
	});

	it("投影里没有该 turn → null", () => {
		expect(resolveSaveFindingTurnAnchor({ turnNumber: 99, projection })).toBeNull();
	});
});

describe("buildSaveFindingProvenance", () => {
	it("可锚 → turn_anchor 三元（origin = 当前会话）", () => {
		const result = buildSaveFindingProvenance({
			conversationSessionTaskId: "session-9",
			anchor: { turnNumber: 3, turnCheckpointCommit: "commit-3" },
		});
		expect(result).toEqual({
			provenanceLinks: [
				{
					linkKind: "turn_anchor",
					conversationSessionTaskId: "session-9",
					turnNumber: 3,
					turnCheckpointCommit: "commit-3",
				},
			],
			originConversationSessionTaskId: "session-9",
		});
	});

	it("不可锚 → user_authored_freeform（turnNumber/commit 置 null，显式声明无锚）", () => {
		const result = buildSaveFindingProvenance({ conversationSessionTaskId: "session-9", anchor: null });
		expect(result.provenanceLinks).toEqual([
			{
				linkKind: "user_authored_freeform",
				conversationSessionTaskId: "session-9",
				turnNumber: null,
				turnCheckpointCommit: null,
			},
		]);
		expect(result.originConversationSessionTaskId).toBe("session-9");
	});
});

describe("filterFindingsForConversationSession", () => {
	it("provenanceLinks 含当前会话的条目入选（任一链接命中即算）", () => {
		const inSession = createFinding({ findingId: "f-1" });
		const otherSession = createFinding({
			findingId: "f-2",
			provenanceLinks: [createProvenanceLink({ conversationSessionTaskId: "session-2" })],
		});
		const multiLink = createFinding({
			findingId: "f-3",
			provenanceLinks: [
				createProvenanceLink({ conversationSessionTaskId: "session-2" }),
				createProvenanceLink({ conversationSessionTaskId: "session-1" }),
			],
		});
		const result = filterFindingsForConversationSession([inSession, otherSession, multiLink], "session-1");
		expect(result.map((finding) => finding.findingId)).toEqual(["f-1", "f-3"]);
	});

	it("archived 不进会话切片（软删 = 不进默认列表）", () => {
		const archived = createFinding({ findingStatus: "archived" });
		expect(filterFindingsForConversationSession([archived], "session-1")).toHaveLength(0);
	});
});

describe("filterFindingsForBrowserView", () => {
	const active = createFinding({
		findingId: "f-1",
		findingTitle: "存储方案 SQLite",
		findingBodyMarkdown: "单文件就够",
	});
	const pending = createFinding({
		findingId: "f-2",
		findingStatus: "suggested_pending_confirmation",
		findingTitle: "部署流水线",
		findingBodyMarkdown: "GitHub Actions",
	});
	const archived = createFinding({ findingId: "f-3", findingStatus: "archived", findingTitle: "旧结论" });

	it("archived 默认不进列表，开关放行", () => {
		const findings = [active, pending, archived];
		expect(
			filterFindingsForBrowserView(findings, { query: "", showArchived: false }).map((finding) => finding.findingId),
		).toEqual(["f-1", "f-2"]);
		expect(
			filterFindingsForBrowserView(findings, { query: "", showArchived: true }).map((finding) => finding.findingId),
		).toEqual(["f-1", "f-2", "f-3"]);
	});

	it("搜索 = 标题 + 正文 substring（大小写不敏感）", () => {
		const findings = [active, pending];
		expect(filterFindingsForBrowserView(findings, { query: "sqlite", showArchived: false })).toHaveLength(1);
		expect(filterFindingsForBrowserView(findings, { query: "单文件", showArchived: false })).toHaveLength(1);
		expect(filterFindingsForBrowserView(findings, { query: "actions", showArchived: false })).toHaveLength(1);
		expect(filterFindingsForBrowserView(findings, { query: "不存在的关键词", showArchived: false })).toHaveLength(0);
	});

	it("空白查询 = 不过滤", () => {
		expect(filterFindingsForBrowserView([active], { query: "   ", showArchived: false })).toHaveLength(1);
	});
});

describe("展示派生", () => {
	it("buildFindingBodyExcerpt 折叠空白并截断", () => {
		expect(buildFindingBodyExcerpt("第一行\n\n第二行   第三行")).toBe("第一行 第二行 第三行");
		const long = "a".repeat(300);
		const excerpt = buildFindingBodyExcerpt(long, 200);
		expect(excerpt.length).toBeLessThanOrEqual(200);
		expect(excerpt.endsWith("…")).toBe(true);
	});

	it("buildFindingProvenanceLabel 按链接类型标注来源", () => {
		expect(buildFindingProvenanceLabel(createFinding())).toBe("Session session-1 · T2");
		expect(
			buildFindingProvenanceLabel(
				createFinding({ provenanceLinks: [createProvenanceLink({ linkKind: "session_level", turnNumber: null })] }),
			),
		).toBe("Session session-1");
		expect(
			buildFindingProvenanceLabel(
				createFinding({
					provenanceLinks: [
						createProvenanceLink({
							linkKind: "user_authored_freeform",
							turnNumber: null,
							turnCheckpointCommit: null,
						}),
					],
				}),
			),
		).toBe("Freeform note · Session session-1");
	});
});
