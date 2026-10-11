import { describe, expect, it } from "vitest";

import {
	RUNTIME_WORKSPACE_METADATA_PROBE_SCOPE_URL_SEARCH_PARAM,
	resolveWorkspaceMetadataProbeScopeDeclaredForWorkspace,
} from "../../../src/core/runtime-state-stream-workspace-metadata-probe-scope-declaration";
import { parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl } from "../../../src/server/runtime-state-stream-workspace-metadata-probe-scope-url-parameter";

function buildRuntimeStateStreamUrl(rawWorkspaceMetadataProbeScope: string | null): URL {
	const url = new URL("ws://127.0.0.1:3484/api/runtime/ws?workspaceId=project-a");
	if (rawWorkspaceMetadataProbeScope !== null) {
		url.searchParams.set(RUNTIME_WORKSPACE_METADATA_PROBE_SCOPE_URL_SEARCH_PARAM, rawWorkspaceMetadataProbeScope);
	}
	return url;
}

describe("resolveWorkspaceMetadataProbeScopeDeclaredForWorkspace", () => {
	it("单项目范围要整个项目；Board Scope 只声明连到的这个项目里的焦点任务", () => {
		const focusedTaskInProject = { workspaceId: "project-b", taskId: "4e79f" };
		expect(
			resolveWorkspaceMetadataProbeScopeDeclaredForWorkspace(
				{ isBoardScopeAllProjectsSelected: false, focusedTaskInProject },
				"project-b",
			),
		).toEqual({ workspaceMetadataProbeScopeKind: "all_tracked_task_worktrees_of_workspace" });
		expect(
			resolveWorkspaceMetadataProbeScopeDeclaredForWorkspace(
				{ isBoardScopeAllProjectsSelected: true, focusedTaskInProject },
				"project-b",
			),
		).toEqual({
			workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
			focusedTaskIds: ["4e79f"],
		});
		// 焦点任务在别的项目（例如跨项目打开前的旧连接）：这个项目里没有焦点任务。
		expect(
			resolveWorkspaceMetadataProbeScopeDeclaredForWorkspace(
				{ isBoardScopeAllProjectsSelected: true, focusedTaskInProject },
				"project-a",
			),
		).toEqual({
			workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
			focusedTaskIds: [],
		});
	});
});

describe("parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl", () => {
	it("Board Scope 声明的焦点任务原样解析", () => {
		expect(
			parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl(
				buildRuntimeStateStreamUrl(
					JSON.stringify({
						workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
						focusedTaskIds: ["4e79f"],
					}),
				),
			),
		).toEqual({
			workspaceMetadataProbeScopeKind: "focused_task_worktrees_plus_auto_review_tasks_in_review_column",
			focusedTaskIds: ["4e79f"],
		});
	});

	it("没带参数（旧客户端）、不是 JSON、或形状不对都返回 null，由 hub 按整个项目处理", () => {
		expect(parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl(buildRuntimeStateStreamUrl(null))).toBeNull();
		expect(
			parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl(buildRuntimeStateStreamUrl("{not json")),
		).toBeNull();
		expect(
			parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl(
				buildRuntimeStateStreamUrl(JSON.stringify({ workspaceMetadataProbeScopeKind: "only_some_tasks" })),
			),
		).toBeNull();
	});
});
