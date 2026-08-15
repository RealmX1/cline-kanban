import { describe, expect, it } from "vitest";

import {
	deriveTaskCreateWarnings,
	findExistingTasksSimilarToRequestedTaskPrompt,
	type TaskCreateWarning,
	type TaskCreateWarningCode,
	type TaskCreateWarningDerivationFacts,
} from "../../../src/core/task-create-warning-derivation";

function createFacts(overrides: Partial<TaskCreateWarningDerivationFacts> = {}): TaskCreateWarningDerivationFacts {
	return {
		workspaceRepoPath: "/repos/example",
		baseRefResolution: {
			baseRef: "main",
			provenance: "repository_default_branch",
			rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
		},
		repositoryDefaultBranch: "main",
		commitCountBaseRefIsBehindItsRemoteTrackingBranch: 0,
		baseRefCheckoutHasUncommittedChanges: false,
		effectiveAgentId: "claude",
		effectiveAgentBinary: "claude",
		isEffectiveAgentBinaryInstalledOnPath: true,
		startInPlanMode: false,
		resolvedPermissionMode: {
			effectivePermissionMode: "ask_for_every_tool_use",
			requestedPermissionMode: "ask_for_every_tool_use",
			degradedBecauseAgentCannotExpressRequestedMode: false,
		},
		worktreeMode: "branch",
		similarExistingTasks: [],
		isProjectRegisteredInKanban: true,
		...overrides,
	};
}

function warningCodes(warnings: readonly TaskCreateWarning[]): TaskCreateWarningCode[] {
	return warnings.map((warning) => warning.code);
}

describe("建卡告警派生", () => {
	it("一切都符合默认预期时不产生任何告警", () => {
		expect(deriveTaskCreateWarnings(createFacts())).toEqual([]);
	});

	it("base ref 偏离仓库默认分支时告警", () => {
		const warnings = deriveTaskCreateWarnings(
			createFacts({
				baseRefResolution: {
					baseRef: "release/2026-05",
					provenance: "explicitly_requested",
					rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
				},
			}),
		);

		expect(warningCodes(warnings)).toContain("base_ref_is_not_repository_default_branch");
	});

	it("base ref 来自项目记忆时同时给出「不记的话本该是哪条」", () => {
		const warnings = deriveTaskCreateWarnings(
			createFacts({
				baseRefResolution: {
					baseRef: "feature/remembered",
					provenance: "remembered_project_selection",
					rememberedBaseRefDiscardedBecauseBranchNoLongerExists: null,
				},
			}),
		);

		const rememberedWarning = warnings.find(
			(warning) => warning.code === "base_ref_came_from_remembered_project_selection",
		);
		expect(rememberedWarning).toMatchObject({
			resolvedBaseRef: "feature/remembered",
			baseRefThatWouldHaveBeenUsedWithoutTheRememberedSelection: "main",
		});
	});

	it("记忆的分支已消失时把失效的名字与回落结果都说出来", () => {
		const warnings = deriveTaskCreateWarnings(
			createFacts({
				baseRefResolution: {
					baseRef: "main",
					provenance: "repository_default_branch",
					rememberedBaseRefDiscardedBecauseBranchNoLongerExists: "feature/deleted",
				},
			}),
		);

		expect(warnings.find((warning) => warning.code === "remembered_base_ref_no_longer_exists")).toMatchObject({
			rememberedBaseRefThatNoLongerExists: "feature/deleted",
			resolvedBaseRef: "main",
		});
	});

	// null = 问不出来（没有 remote / git 失败），绝不能报成「确认没落后」。
	it("落后提交数未知时不告警，已知且大于 0 时才告警", () => {
		expect(
			warningCodes(
				deriveTaskCreateWarnings(createFacts({ commitCountBaseRefIsBehindItsRemoteTrackingBranch: null })),
			),
		).not.toContain("base_ref_is_behind_its_remote_tracking_branch");
		expect(
			warningCodes(deriveTaskCreateWarnings(createFacts({ commitCountBaseRefIsBehindItsRemoteTrackingBranch: 3 }))),
		).toContain("base_ref_is_behind_its_remote_tracking_branch");
	});

	it("持有 base ref 的 checkout 有未提交改动时告警", () => {
		expect(
			warningCodes(deriveTaskCreateWarnings(createFacts({ baseRefCheckoutHasUncommittedChanges: true }))),
		).toContain("base_ref_checkout_has_uncommitted_changes");
	});

	// 这条告警的含义随 worktree 模式**反转**：branch 模式下这些改动进不了 worktree，
	// inplace 模式下 agent 就在这个 checkout 里干活、会直接在它们之上开工。
	it("未提交改动告警按 worktree 模式给出相反的含义", () => {
		const branchModeWarning = deriveTaskCreateWarnings(
			createFacts({ baseRefCheckoutHasUncommittedChanges: true, worktreeMode: "branch" }),
		).find((warning) => warning.code === "base_ref_checkout_has_uncommitted_changes");
		expect(branchModeWarning).toMatchObject({ worktreeMode: "branch" });
		expect(branchModeWarning?.message).toContain("will not be part of the");

		const inplaceModeWarning = deriveTaskCreateWarnings(
			createFacts({ baseRefCheckoutHasUncommittedChanges: true, worktreeMode: "inplace" }),
		).find((warning) => warning.code === "base_ref_checkout_has_uncommitted_changes");
		expect(inplaceModeWarning).toMatchObject({ worktreeMode: "inplace" });
		expect(inplaceModeWarning?.message).toContain("start on top of them");
	});

	it("实际会跑的 agent 没装在 PATH 上时告警", () => {
		expect(
			warningCodes(deriveTaskCreateWarnings(createFacts({ isEffectiveAgentBinaryInstalledOnPath: false }))),
		).toContain("resolved_agent_binary_is_not_installed");
	});

	it("plan 起步会吃掉权限档的 agent 上告警", () => {
		expect(
			warningCodes(
				deriveTaskCreateWarnings(
					createFacts({ effectiveAgentId: "droid", effectiveAgentBinary: "droid", startInPlanMode: true }),
				),
			),
		).toContain("plan_mode_start_overrides_permission_mode_on_this_agent");
		expect(
			warningCodes(
				deriveTaskCreateWarnings(
					createFacts({ effectiveAgentId: "droid", effectiveAgentBinary: "droid", startInPlanMode: false }),
				),
			),
		).not.toContain("plan_mode_start_overrides_permission_mode_on_this_agent");
	});

	// 这类 harness 上 plan 起步会吃掉权限轴，于是「以权限档为前提」的两条告警都不再成立。
	// 默认配置就是 plan=true + bypass，若不 gate 会同时吐出两条互相矛盾、且更醒目那条是假的告警。
	it("plan 起步吃掉权限轴时，不再报以权限档为前提的那两条告警", () => {
		const codes = warningCodes(
			deriveTaskCreateWarnings(
				createFacts({
					effectiveAgentId: "droid",
					effectiveAgentBinary: "droid",
					startInPlanMode: true,
					resolvedPermissionMode: {
						effectivePermissionMode: "bypass_all_permission_prompts",
						requestedPermissionMode: "ask_for_every_tool_use",
						degradedBecauseAgentCannotExpressRequestedMode: true,
					},
				}),
			),
		);

		expect(codes).toContain("plan_mode_start_overrides_permission_mode_on_this_agent");
		expect(codes).not.toContain("task_will_run_with_all_permission_prompts_bypassed");
		expect(codes).not.toContain("resolved_permission_mode_widens_permissions_beyond_request");
	});

	it("同一个 agent 不以 plan 起步时，权限档告警照常报出", () => {
		const codes = warningCodes(
			deriveTaskCreateWarnings(
				createFacts({
					effectiveAgentId: "droid",
					effectiveAgentBinary: "droid",
					startInPlanMode: false,
					resolvedPermissionMode: {
						effectivePermissionMode: "bypass_all_permission_prompts",
						requestedPermissionMode: "bypass_all_permission_prompts",
						degradedBecauseAgentCannotExpressRequestedMode: false,
					},
				}),
			),
		);

		expect(codes).toContain("task_will_run_with_all_permission_prompts_bypassed");
	});

	it("实际档位比请求的更放权时告警", () => {
		expect(
			warningCodes(
				deriveTaskCreateWarnings(
					createFacts({
						effectiveAgentId: "cline",
						effectiveAgentBinary: "cline",
						resolvedPermissionMode: {
							effectivePermissionMode: "bypass_all_permission_prompts",
							requestedPermissionMode: "ask_for_every_tool_use",
							degradedBecauseAgentCannotExpressRequestedMode: true,
						},
					}),
				),
			),
		).toContain("resolved_permission_mode_widens_permissions_beyond_request");
	});

	// 这是当前的默认档位，也是最容易让调用方产生错误安全预期的一条，所以即便是显式请求也照报。
	it("生效档位是全放行时无条件告警", () => {
		expect(
			warningCodes(
				deriveTaskCreateWarnings(
					createFacts({
						resolvedPermissionMode: {
							effectivePermissionMode: "bypass_all_permission_prompts",
							requestedPermissionMode: "bypass_all_permission_prompts",
							degradedBecauseAgentCannotExpressRequestedMode: false,
						},
					}),
				),
			),
		).toContain("task_will_run_with_all_permission_prompts_bypassed");
	});

	it("inplace 模式会改主 checkout 时告警", () => {
		expect(warningCodes(deriveTaskCreateWarnings(createFacts({ worktreeMode: "inplace" })))).toContain(
			"worktree_mode_inplace_edits_the_main_checkout",
		);
	});

	it("项目尚未注册进 Kanban 时告警而不是失败", () => {
		expect(warningCodes(deriveTaskCreateWarnings(createFacts({ isProjectRegisteredInKanban: false })))).toContain(
			"project_is_not_registered_in_kanban",
		);
	});

	it("存在高度相似的既有任务时把它们列出来", () => {
		const warnings = deriveTaskCreateWarnings(
			createFacts({
				similarExistingTasks: [
					{ taskId: "abc12", title: "Add pagination", columnId: "backlog", similarityScore: 0.9 },
				],
			}),
		);

		expect(warnings.find((warning) => warning.code === "similar_task_already_exists")).toMatchObject({
			similarExistingTasks: [{ taskId: "abc12" }],
		});
	});
});

describe("疑似重复建卡的相似度扫描", () => {
	it("几乎相同的 prompt 会被判定为重复", () => {
		const similar = findExistingTasksSimilarToRequestedTaskPrompt({
			requestedTitle: "Implement API pagination",
			requestedPrompt: "Implement API pagination for the tasks endpoint with cursor based paging",
			existingTasks: [
				{
					taskId: "abc12",
					title: "Implement API pagination",
					prompt: "Implement API pagination for the tasks endpoint with cursor based paging",
					columnId: "backlog",
				},
			],
		});

		expect(similar).toHaveLength(1);
		expect(similar[0]?.similarityScore).toBeGreaterThan(0.9);
	});

	it("主题不同的任务不会被判定为重复", () => {
		expect(
			findExistingTasksSimilarToRequestedTaskPrompt({
				requestedTitle: "Implement API pagination",
				requestedPrompt: "Implement API pagination for the tasks endpoint",
				existingTasks: [
					{
						taskId: "abc12",
						title: "Fix flaky terminal reconnect test",
						prompt: "The websocket reconnect test times out on slow machines",
						columnId: "backlog",
					},
				],
			}),
		).toEqual([]);
	});

	it("按相似度从高到低排序", () => {
		const similar = findExistingTasksSimilarToRequestedTaskPrompt({
			requestedTitle: "alpha beta gamma delta",
			requestedPrompt: "alpha beta gamma delta",
			existingTasks: [
				{
					taskId: "partial",
					title: "alpha beta gamma epsilon",
					prompt: "alpha beta gamma epsilon",
					columnId: "backlog",
				},
				{ taskId: "exact", title: "alpha beta gamma delta", prompt: "alpha beta gamma delta", columnId: "review" },
			],
		});

		expect(similar.map((candidate) => candidate.taskId)).toEqual(["exact", "partial"]);
	});
});
