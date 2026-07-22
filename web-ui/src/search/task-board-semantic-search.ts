import {
	orderMatchSources,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMatchSource,
	type TaskBoardSearchMode,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";
import { create, embeddingsType, insertMultiple, pluginEmbeddings, search } from "@/search/task-board-semantic-vendor";

interface TaskBoardSemanticSearchRecord {
	// 以 documents 数组下标为记录键：taskId 跨项目会碰撞，用下标可零歧义映射回 document 引用。
	documentIndex: number;
	searchField: TaskBoardSearchMatchSource;
	text: string;
}

export interface TaskBoardSemanticSearchIndex {
	findResults: (
		query: string,
		mode: Extract<TaskBoardSearchMode, "hybrid" | "semantic">,
	) => Promise<TaskBoardSearchResult[]>;
}

const SEMANTIC_SEARCH_MINIMUM_SIMILARITY = 0.42;
// semantic 结果无字符级命中位置，只标 matchSources、不高亮。
const NO_MATCH_POSITIONS: ReadonlySet<number> = new Set<number>();

function buildSemanticSearchRecords(documents: readonly TaskBoardSearchDocument[]): TaskBoardSemanticSearchRecord[] {
	const records: TaskBoardSemanticSearchRecord[] = [];
	documents.forEach((document, documentIndex) => {
		if (document.title.length > 0) {
			records.push({
				documentIndex,
				searchField: "title",
				text: document.title,
			});
		}
		if (document.prompt.length > 0) {
			records.push({
				documentIndex,
				searchField: "prompt",
				text: document.prompt,
			});
		}
	});
	return records;
}

function normalizeSearchFieldSource(value: string | number): TaskBoardSearchMatchSource | null {
	if (value === "title" || value === "prompt") {
		return value;
	}
	return null;
}

export async function createTaskBoardSemanticSearchIndex(
	documents: readonly TaskBoardSearchDocument[],
): Promise<TaskBoardSemanticSearchIndex> {
	const records = buildSemanticSearchRecords(documents);
	if (records.length === 0) {
		return {
			findResults: async () => [],
		};
	}
	const plugin = await pluginEmbeddings({
		embeddings: {
			defaultProperty: "embeddings",
			onInsert: {
				generate: true,
				properties: ["text"],
			},
		},
	});
	const database = await create({
		schema: {
			documentIndex: "number",
			searchField: "enum",
			text: "string",
			embeddings: embeddingsType,
		} as const,
		plugins: [plugin],
	});
	await insertMultiple(database, records);
	const limit = Math.max(records.length, 1);
	return {
		findResults: async (query, mode) => {
			const results =
				mode === "semantic"
					? await search(database, {
							term: query,
							mode: "vector",
							limit,
							similarity: SEMANTIC_SEARCH_MINIMUM_SIMILARITY,
						})
					: await search(database, {
							term: query,
							mode: "hybrid",
							properties: ["text"],
							limit,
							threshold: 0,
							similarity: SEMANTIC_SEARCH_MINIMUM_SIMILARITY,
							hybridWeights: {
								text: 0.45,
								vector: 0.55,
							},
						});
			const groupedResults = new Map<number, { score: number; sources: Set<TaskBoardSearchMatchSource> }>();
			for (const hit of results.hits) {
				const searchField = normalizeSearchFieldSource(hit.document.searchField);
				if (!searchField) {
					continue;
				}
				const documentIndex = typeof hit.document.documentIndex === "number" ? hit.document.documentIndex : null;
				if (documentIndex == null) {
					continue;
				}
				const current = groupedResults.get(documentIndex);
				if (!current) {
					groupedResults.set(documentIndex, {
						score: hit.score,
						sources: new Set([searchField]),
					});
					continue;
				}
				current.score = Math.max(current.score, hit.score);
				current.sources.add(searchField);
			}
			return [...groupedResults.entries()].flatMap(([documentIndex, result]) => {
				const document = documents[documentIndex];
				if (!document) {
					return [];
				}
				return [
					{
						document,
						score: result.score,
						matchSources: orderMatchSources(result.sources),
						titleMatchCharacterPositions: NO_MATCH_POSITIONS,
						promptMatchCharacterPositions: NO_MATCH_POSITIONS,
					},
				];
			});
		},
	};
}
