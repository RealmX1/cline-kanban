import { useCallback, useEffect, useRef } from "react";

import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponse,
	RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { useInterval } from "@/utils/react-use";

// 与 usePostDeployVerification 的心跳同频：新部署由 `kanban deployment record` 写盘，没有推流。
const WORKSPACES_HAVING_POST_DEPLOY_VERIFICATION_DEPLOYMENT_GROUPS_POLL_INTERVAL_MS = 30_000;

function isListOfWorkspacesHavingPostDeployVerificationDeploymentGroupsUnchanged(
	previous: RuntimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponse,
	next: RuntimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponse,
): boolean {
	return JSON.stringify(previous) === JSON.stringify(next);
}

/**
 * All projects 视图挑 PDV 面板绑定哪个 workspace 用的「哪些 workspace 有部署组」列表（无 scope 的只读 query）。
 * 只在 All projects 下拉取；离开后保留上次的结果，再进入时立即可用。加载过一次之后的失败沿用旧列表，
 * 免得一次网络抖动让面板在两个 workspace 之间来回跳。返回 null = 从未加载过。
 */
export function useWorkspacesHavingPostDeployVerificationDeploymentGroupsWhileBoardScopeAllProjectsSelected(
	isBoardScopeAllProjectsSelected: boolean,
): readonly RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary[] | null {
	const isDocumentVisible = useDocumentVisibility();
	const queryWorkspacesHavingPostDeployVerificationDeploymentGroups = useCallback(
		async () =>
			await getRuntimeTrpcClient(null).deployment.listWorkspacesHavingPostDeployVerificationDeploymentGroups.query(),
		[],
	);
	const { data, refetch } = useTrpcQuery({
		enabled: isBoardScopeAllProjectsSelected,
		queryFn: queryWorkspacesHavingPostDeployVerificationDeploymentGroups,
		retainDataOnError: true,
		isDataEqual: isListOfWorkspacesHavingPostDeployVerificationDeploymentGroupsUnchanged,
	});

	useInterval(
		() => {
			void refetch();
		},
		isBoardScopeAllProjectsSelected && isDocumentVisible
			? WORKSPACES_HAVING_POST_DEPLOY_VERIFICATION_DEPLOYMENT_GROUPS_POLL_INTERVAL_MS
			: null,
	);

	// 标签页由隐藏转可见的边沿立即重拉一次（与 usePostDeployVerification 同一约定）。
	const wasDocumentVisibleRef = useRef(isDocumentVisible);
	useEffect(() => {
		if (isDocumentVisible && !wasDocumentVisibleRef.current && isBoardScopeAllProjectsSelected) {
			void refetch();
		}
		wasDocumentVisibleRef.current = isDocumentVisible;
	}, [isBoardScopeAllProjectsSelected, isDocumentVisible, refetch]);

	return data?.workspacesHavingPostDeployVerificationDeploymentGroups ?? null;
}
