// 连通图只用来预览；路径不代表新的直接关系，也不改变关系的陈述方向。
export function collectBoundedRelationModelingNeighborhood(
	rootKey: string,
	relations: readonly { relationId: string; subjectKey: string; anchorKey: string }[],
	depth: number,
	limits = { maximumNodes: 150, maximumRelations: 300 },
): { workUnitKeys: string[]; relationIds: string[]; truncated: boolean } {
	const adjacency = new Map<string, (typeof relations)[number][]>();
	for (const relation of [...relations].sort((a, b) => a.relationId.localeCompare(b.relationId))) {
		for (const key of new Set([relation.subjectKey, relation.anchorKey])) {
			const entries = adjacency.get(key) ?? [];
			entries.push(relation);
			adjacency.set(key, entries);
		}
	}
	const distances = new Map([[rootKey, 0]]);
	const selected = new Set<string>();
	let truncated = false;
	for (const [key, distance] of distances) {
		if (distance >= depth) continue;
		for (const relation of adjacency.get(key) ?? []) {
			if (selected.has(relation.relationId)) continue;
			const other = relation.subjectKey === key ? relation.anchorKey : relation.subjectKey;
			if (
				selected.size >= limits.maximumRelations ||
				(!distances.has(other) && distances.size >= limits.maximumNodes)
			) {
				truncated = true;
				continue;
			}
			selected.add(relation.relationId);
			if (!distances.has(other)) distances.set(other, distance + 1);
		}
	}
	return { workUnitKeys: [...distances.keys()], relationIds: [...selected].sort(), truncated };
}
