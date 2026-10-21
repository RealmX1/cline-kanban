import { describe, expect, it } from "vitest";
import { collectBoundedRelationModelingNeighborhood } from "../../../src/inter-work-unit-relation-ledger/relation-modeling-multi-hop-preview";

describe("关系建模的有界多跳预览", () => {
	const relations = [
		{ relationId: "ab", subjectKey: "a", anchorKey: "b" },
		{ relationId: "bc", subjectKey: "b", anchorKey: "c" },
		{ relationId: "cd", subjectKey: "c", anchorKey: "d" },
		{ relationId: "ca", subjectKey: "c", anchorKey: "a" },
	];
	it("双向遍历混合关系，循环不重复，深度按最短路径计算", () => {
		const result = collectBoundedRelationModelingNeighborhood("a", relations, 2);
		expect(result.workUnitKeys).toEqual(["a", "b", "c", "d"]);
		expect(result.relationIds).toEqual(["ab", "bc", "ca", "cd"]);
		expect(result.truncated).toBe(false);
	});
	it("两跳不包含第三跳，展开到三跳后出现", () => {
		const chain = relations.slice(0, 3);
		expect(collectBoundedRelationModelingNeighborhood("a", chain, 2).workUnitKeys).toEqual(["a", "b", "c"]);
		expect(collectBoundedRelationModelingNeighborhood("a", chain, 3).workUnitKeys).toEqual(["a", "b", "c", "d"]);
	});
	it("节点与关系上限可见，任何返回关系的两个端点均已返回", () => {
		const result = collectBoundedRelationModelingNeighborhood("a", relations, 3, {
			maximumNodes: 2,
			maximumRelations: 1,
		});
		expect(result.workUnitKeys).toEqual(["a", "b"]);
		expect(result.relationIds).toEqual(["ab"]);
		expect(result.truncated).toBe(true);
	});
});
