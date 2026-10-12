import type { RuntimeHostRemoteEditorAccessIdentity } from "@/runtime/types";
import { openExternalApplicationUrlThroughHiddenAnchorClick } from "@/utils/open-external-application-url-through-hidden-anchor-click";
import { buildRemoteSshEditorDeepLinkUrl, getRemoteSshOpenTargetOption, type OpenTargetId } from "@/utils/open-targets";
import { resolveRemoteSshDestinationForAgentRuntimeHost } from "@/utils/resolve-project-filesystem-access-route-for-browser";

/**
 * 从其他设备访问时，在**这台设备**的编辑器里经 Remote-SSH 打开 runtime 主机上的路径。
 * 必须在点击手势里同步调用，浏览器才会把自定义协议交给本机应用。
 */
export function openRuntimeHostPathInEditorOnThisDeviceThroughRemoteSsh(input: {
	// 用户在 Open 下拉里的偏好；不支持 Remote-SSH 的目标按 VS Code 处理。
	preferredOpenTargetId: OpenTargetId;
	runtimeHostRemoteEditorAccessIdentity: RuntimeHostRemoteEditorAccessIdentity;
	absolutePath: string;
	// 给了行号按文件打开，不给按文件夹打开。
	lineNumber?: number;
}): void {
	openExternalApplicationUrlThroughHiddenAnchorClick(
		buildRemoteSshEditorDeepLinkUrl({
			openTargetId: getRemoteSshOpenTargetOption(input.preferredOpenTargetId).id,
			remoteSshDestination: resolveRemoteSshDestinationForAgentRuntimeHost(
				input.runtimeHostRemoteEditorAccessIdentity,
			),
			absolutePath: input.absolutePath,
			lineNumber: input.lineNumber,
		}),
	);
}
