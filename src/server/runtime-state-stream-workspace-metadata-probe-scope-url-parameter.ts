import {
	type RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient,
	runtimeWorkspaceMetadataProbeScopeDeclaredByStreamClientSchema,
} from "../core/api-contract";
import { RUNTIME_WORKSPACE_METADATA_PROBE_SCOPE_URL_SEARCH_PARAM } from "../core/runtime-state-stream-workspace-metadata-probe-scope-declaration";

/**
 * 状态流 WS URL 里浏览器声明的 git 元数据探测范围（JSON）。缺失或解析不了都返回 null，由 hub 按整个项目处理——
 * 旧客户端不带这个参数，行为与改动前一致。
 */
export function parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl(
	requestUrl: URL,
): RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient | null {
	const rawWorkspaceMetadataProbeScope = requestUrl.searchParams.get(
		RUNTIME_WORKSPACE_METADATA_PROBE_SCOPE_URL_SEARCH_PARAM,
	);
	if (!rawWorkspaceMetadataProbeScope) {
		return null;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(rawWorkspaceMetadataProbeScope);
	} catch {
		return null;
	}
	const parsedWorkspaceMetadataProbeScope =
		runtimeWorkspaceMetadataProbeScopeDeclaredByStreamClientSchema.safeParse(parsedJson);
	return parsedWorkspaceMetadataProbeScope.success ? parsedWorkspaceMetadataProbeScope.data : null;
}
