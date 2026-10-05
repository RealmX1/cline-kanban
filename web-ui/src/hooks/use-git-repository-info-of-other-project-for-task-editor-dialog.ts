import { useEffect, useState } from "react";

import type { RuntimeGitRepositoryInfo } from "@/runtime/types";
import { fetchWorkspaceState } from "@/runtime/workspace-state-query";

/**
 * 任务编辑对话框作用于**其他项目**（All projects 面板里原地编辑 backlog 卡、Board Scope 往别的项目建卡）时，那个
 * 项目的分支列表与默认分支。当前项目的 git 信息随推流常驻浏览器，其他项目没有，打开时按 workspace scope 只读调一次
 * `workspace.getState`。workspaceId 为 null（作用于当前项目）时不读，返回 null。读失败也返回 null：调用方据此只保留
 * 卡上 / 记住的 base ref，不阻断编辑。
 */
export function useGitRepositoryInfoOfOtherProjectForTaskEditorDialog(otherProjectWorkspaceId: string | null): {
	gitRepositoryInfoOfOtherProject: RuntimeGitRepositoryInfo | null;
} {
	const [loadedGitRepositoryInfo, setLoadedGitRepositoryInfo] = useState<{
		workspaceId: string;
		gitRepositoryInfo: RuntimeGitRepositoryInfo;
	} | null>(null);

	useEffect(() => {
		if (!otherProjectWorkspaceId) {
			return;
		}
		let isSuperseded = false;
		fetchWorkspaceState(otherProjectWorkspaceId).then(
			(workspaceState) => {
				if (!isSuperseded) {
					setLoadedGitRepositoryInfo({
						workspaceId: otherProjectWorkspaceId,
						gitRepositoryInfo: workspaceState.git,
					});
				}
			},
			() => {
				// 读失败：保持 null，对话框只用卡上 / 记住的 base ref。
			},
		);
		return () => {
			isSuperseded = true;
		};
	}, [otherProjectWorkspaceId]);

	return {
		gitRepositoryInfoOfOtherProject:
			otherProjectWorkspaceId && loadedGitRepositoryInfo?.workspaceId === otherProjectWorkspaceId
				? loadedGitRepositoryInfo.gitRepositoryInfo
				: null,
	};
}
