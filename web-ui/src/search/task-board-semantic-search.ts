import type {
	TaskBoardSearchDocument,
	TaskBoardSearchMatchSource,
	TaskBoardSearchMode,
	TaskBoardSearchResult,
} from "@/search/task-board-search";
import { create, embeddingsType, insertMultiple, pluginEmbeddings, search } from "@/search/task-board-semantic-vendor";

interface TaskBoardSemanticSearchRecord {
	taskId: string;
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

function buildSemanticSearchRecords(documents: readonly TaskBoardSearchDocument[]): TaskBoardSemanticSearchRecord[] {
	const records: TaskBoardSemanticSearchRecord[] = [];
	for (const document of documents) {
		if (document.title.length > 0) {
			records.push({
				taskId: document.taskId,
				searchField: "title",
				text: document.title,
			});
		}
		if (document.prompt.length > 0) {
			records.push({
				taskId: document.taskId,
				searchField: "prompt",
				text: document.prompt,
			});
		}
	}
	return records;
}

function orderMatchSources(sources: ReadonlySet<TaskBoardSearchMatchSource>): TaskBoardSearchMatchSource[] {
	const orderedSources: TaskBoardSearchMatchSource[] = [];
	if (sources.has("title")) {
		orderedSources.push("title");
	}
	if (sources.has("prompt")) {
		orderedSources.push("prompt");
	}
	return orderedSources;
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
			taskId: "string",
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
			const groupedResults = new Map<string, { score: number; sources: Set<TaskBoardSearchMatchSource> }>();
			for (const hit of results.hits) {
				const searchField = normalizeSearchFieldSource(hit.document.searchField);
				if (!searchField) {
					continue;
				}
				const current = groupedResults.get(hit.document.taskId);
				if (!current) {
					groupedResults.set(hit.document.taskId, {
						score: hit.score,
						sources: new Set([searchField]),
					});
					continue;
				}
				current.score = Math.max(current.score, hit.score);
				current.sources.add(searchField);
			}
			return [...groupedResults.entries()].map(([taskId, result]) => ({
				taskId,
				score: result.score,
				matchSources: orderMatchSources(result.sources),
			}));
		},
	};
}
