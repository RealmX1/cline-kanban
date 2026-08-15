import { describe, expect, it } from "vitest";

import type { RuntimeGitRepositoryInfo } from "../../../src/core/api-contract";
import { resolveTaskCreateBaseRef } from "../../../src/core/task-create-base-ref-resolution";

function createRepository(overrides: Partial<RuntimeGitRepositoryInfo> = {}): RuntimeGitRepositoryInfo {
	return {
		currentBranch: "feature/currently-checked-out",
		defaultBranch: "main",
		branches: [{ name: "main" }, { name: "feature/currently-checked-out" }, { name: "feature/remembered" }],
		...overrides,
	};
}

describe("建卡 base ref 解析", () => {
	it("显式指定优先于其余一切", () => {
		expect(
			resolveTaskCreateBaseRef({
				explicitlyRequestedBaseRef: "release/2026-05",
				rememberedBaseRefForProject: "feature/remembered",
				repository: createRepository(),
			}),
		).toEqual({
			baseRef: "release/2026-05",
			provenance: "explicitly_requested",
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
		});
	});

	// 显式值刻意不做「分支是否还在」的校验：把调用方明说的 ref 悄悄换成别的，比让下游 git 如实失败危险。
	it("显式指定即便不在分支列表里也原样采用", () => {
		expect(
			resolveTaskCreateBaseRef({
				explicitlyRequestedBaseRef: "origin/main",
				repository: createRepository(),
			}).baseRef,
		).toBe("origin/main");
	});

	it("空白的显式指定视同未指定", () => {
		expect(
			resolveTaskCreateBaseRef({
				explicitlyRequestedBaseRef: "   ",
				repository: createRepository(),
			}).provenance,
		).toBe("repository_default_branch");
	});

	it("记忆值仍存在时优先于仓库默认分支", () => {
		expect(
			resolveTaskCreateBaseRef({
				rememberedBaseRefForProject: "feature/remembered",
				repository: createRepository(),
			}),
		).toEqual({
			baseRef: "feature/remembered",
			provenance: "remembered_project_selection",
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
		});
	});

	it("记忆值指向的分支已被删除时丢弃它、回落默认分支，并把失效的名字说出来", () => {
		expect(
			resolveTaskCreateBaseRef({
				rememberedBaseRefForProject: "feature/deleted-last-week",
				repository: createRepository(),
			}),
		).toEqual({
			baseRef: "main",
			provenance: "repository_default_branch",
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: "feature/deleted-last-week",
		});
	});

	// 旧的 CLI / 快速添加规则是 currentBranch 优先，会让「用户在主仓库切了个分支看代码」污染新卡。
	it("默认分支排在当前分支之前", () => {
		expect(resolveTaskCreateBaseRef({ repository: createRepository() })).toEqual({
			baseRef: "main",
			provenance: "repository_default_branch",
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
		});
	});

	it("没有默认分支时才回落当前分支", () => {
		expect(
			resolveTaskCreateBaseRef({
				repository: createRepository({ defaultBranch: null }),
			}),
		).toMatchObject({
			baseRef: "feature/currently-checked-out",
			provenance: "repository_current_branch",
		});
	});

	it("默认分支与当前分支都没有时回落分支列表第一条", () => {
		expect(
			resolveTaskCreateBaseRef({
				repository: { currentBranch: null, defaultBranch: null, branches: [{ name: "only-branch" }] },
			}),
		).toMatchObject({
			baseRef: "only-branch",
			provenance: "first_known_branch",
		});
	});

	it("一条分支都识别不出时给出空串而不是抛错，由调用方决定怎么处理", () => {
		expect(
			resolveTaskCreateBaseRef({
				rememberedBaseRefForProject: "feature/deleted",
				repository: { currentBranch: null, defaultBranch: null, branches: [] },
			}),
		).toEqual({
			baseRef: "",
			provenance: null,
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: "feature/deleted",
		});
	});
});
