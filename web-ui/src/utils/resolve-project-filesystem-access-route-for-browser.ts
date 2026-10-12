import type { RuntimeHostRemoteEditorAccessIdentity } from "@/runtime/types";
import { isLocalhostAccess, stripSquareBracketsFromIpv6LiteralHostname } from "@/utils/localhost-detection";
import type { RemoteSshDestinationForEditorDeepLink } from "@/utils/open-targets";

/**
 * 浏览器与 agent 所在的 runtime 主机是不是同一台机器。
 *
 * 「在 runtime 主机上启动编辑器」「让 agent 读宿主剪贴板里的图片」这类功能，只有浏览器就坐在那台机器
 * 前面时才对用户有意义。这类判断都经过这里，不在各处散写 `isLocalhostAccess()`：将来多机联邦时，问题会
 * 变成「项目所属的机器是不是浏览器所在的机器」，只需要给这里加一个输入，调用点不用改
 * （见 `.plan/docs/multi-machine-kanban-runtime-federation-evaluation-deferred-until-route-decision.md`）。
 */
export function isBrowserOnTheSameMachineAsAgentRuntimeHost(): boolean {
	return isLocalhostAccess();
}

export type ProjectFilesystemAccessRouteForBrowser =
	// 在 runtime 主机上启动编辑器 / 文件管理器，窗口出现在用户正看着的屏幕上。
	| "spawn-on-runtime-host-because-browser-shares-the-machine"
	// 在浏览器所在的设备上打开编辑器的 Remote-SSH 深链，经 SSH 查看 runtime 主机上的文件。
	| "remote-ssh-editor-deep-link";

export function resolveProjectFilesystemAccessRouteForBrowser(): ProjectFilesystemAccessRouteForBrowser {
	return isBrowserOnTheSameMachineAsAgentRuntimeHost()
		? "spawn-on-runtime-host-because-browser-shares-the-machine"
		: "remote-ssh-editor-deep-link";
}

/**
 * Remote-SSH 深链里的 SSH 目标（结构化；怎么编码进深链由 `buildRemoteSshEditorDeepLinkUrl` 决定）。
 *
 * 主机名取页面的主机名：浏览器能连上这个名字，SSH 也就能连上（同一个 tailnet / 局域网地址）。
 * 页面经 IPv6 字面量访问时 `location.hostname` 带方括号（`[fd7a:115c:a1e0::1]`），方括号只是 URL 语法，
 * SSH 要的是里面的地址，这里去掉。
 * 将来多机联邦时，改成「项目所属机器的可达主机名」，用户名取那台机器广播的身份。
 */
export function resolveRemoteSshDestinationForAgentRuntimeHost(
	runtimeHostRemoteEditorAccessIdentity: RuntimeHostRemoteEditorAccessIdentity,
): RemoteSshDestinationForEditorDeepLink {
	return {
		sshLoginUsername: runtimeHostRemoteEditorAccessIdentity.operatingSystemAccountUsername,
		sshHostnameWithoutIpv6Brackets: stripSquareBracketsFromIpv6LiteralHostname(window.location.hostname),
	};
}
