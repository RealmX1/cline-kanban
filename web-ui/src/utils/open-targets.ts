import cursorIcon from "@/assets/open-targets/cursor.svg";
import finderIcon from "@/assets/open-targets/finder.svg";
import ghosttyIcon from "@/assets/open-targets/ghostty.svg";
import intellijIdeaIcon from "@/assets/open-targets/intellijidea.svg";
import iterm2Icon from "@/assets/open-targets/iterm2.svg";
import terminalIcon from "@/assets/open-targets/terminal.svg";
import vscodeIcon from "@/assets/open-targets/vscode.svg";
import warpIcon from "@/assets/open-targets/warp.svg";
import windsurfIcon from "@/assets/open-targets/windsurf.svg";
import xcodeIcon from "@/assets/open-targets/xcode.svg";
import zedIcon from "@/assets/open-targets/zed.svg";

export type OpenTargetPlatform = "mac" | "windows" | "linux" | "other";

export type OpenTargetId =
	| "vscode"
	| "vscode-insiders"
	| "cursor"
	| "windsurf"
	| "finder"
	| "terminal"
	| "iterm2"
	| "ghostty"
	| "warp"
	| "xcode"
	| "intellijidea"
	| "zed";

export interface OpenTargetOption {
	id: OpenTargetId;
	label: string;
	iconSrc: string;
}

const DEFAULT_OPEN_TARGET: OpenTargetOption = {
	id: "vscode",
	label: "VS Code",
	iconSrc: vscodeIcon,
};

const OPEN_TARGET_OPTIONS: readonly OpenTargetOption[] = [
	DEFAULT_OPEN_TARGET,
	{
		id: "vscode-insiders",
		label: "VS Code Insiders",
		iconSrc: vscodeIcon,
	},
	{
		id: "cursor",
		label: "Cursor",
		iconSrc: cursorIcon,
	},
	{
		id: "windsurf",
		label: "Windsurf",
		iconSrc: windsurfIcon,
	},
	{
		id: "finder",
		label: "Finder",
		iconSrc: finderIcon,
	},
	{
		id: "terminal",
		label: "Terminal",
		iconSrc: terminalIcon,
	},
	{
		id: "iterm2",
		label: "Iterm2",
		iconSrc: iterm2Icon,
	},
	{
		id: "ghostty",
		label: "Ghostty",
		iconSrc: ghosttyIcon,
	},
	{
		id: "warp",
		label: "Warp",
		iconSrc: warpIcon,
	},
	{
		id: "xcode",
		label: "Xcode",
		iconSrc: xcodeIcon,
	},
	{
		id: "intellijidea",
		label: "Intellij Idea",
		iconSrc: intellijIdeaIcon,
	},
	{
		id: "zed",
		label: "Zed",
		iconSrc: zedIcon,
	},
];

const OPEN_TARGET_IDS_BY_PLATFORM: Record<OpenTargetPlatform, readonly OpenTargetId[]> = {
	mac: [
		"vscode",
		"cursor",
		"windsurf",
		"finder",
		"terminal",
		"iterm2",
		"ghostty",
		"warp",
		"xcode",
		"intellijidea",
		"vscode-insiders",
		"zed",
	],
	windows: ["vscode", "cursor", "windsurf", "finder", "vscode-insiders", "zed"],
	linux: ["vscode", "cursor", "windsurf", "finder", "vscode-insiders", "zed"],
	other: ["vscode", "vscode-insiders", "finder"],
};

const openTargetById = new Map<OpenTargetId, OpenTargetOption>(
	OPEN_TARGET_OPTIONS.map((option) => [option.id, option]),
);

export function resolveOpenTargetPlatform(): OpenTargetPlatform {
	if (typeof navigator === "undefined") {
		return "other";
	}
	const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
	if (source.includes("mac") || source.includes("darwin")) {
		return "mac";
	}
	if (source.includes("win")) {
		return "windows";
	}
	if (source.includes("linux") || source.includes("x11")) {
		return "linux";
	}
	return "other";
}

function getDefaultOpenTargetId(platform: OpenTargetPlatform): OpenTargetId {
	const firstId = OPEN_TARGET_IDS_BY_PLATFORM[platform][0];
	return firstId ?? DEFAULT_OPEN_TARGET.id;
}

function getOpenTargetLabel(targetId: OpenTargetId, platform: OpenTargetPlatform): string {
	if (targetId === "finder") {
		if (platform === "windows") {
			return "File Explorer";
		}
		if (platform === "linux" || platform === "other") {
			return "File Manager";
		}
	}
	const option = openTargetById.get(targetId);
	return option?.label ?? DEFAULT_OPEN_TARGET.label;
}

function isOpenTargetSupported(targetId: OpenTargetId, platform: OpenTargetPlatform): boolean {
	return OPEN_TARGET_IDS_BY_PLATFORM[platform].includes(targetId);
}

function isOpenTargetId(value: string | null): value is OpenTargetId {
	if (!value) {
		return false;
	}
	return openTargetById.has(value as OpenTargetId);
}

export function normalizeOpenTargetId(value: string | null): OpenTargetId | null {
	if (!value) {
		return null;
	}
	if (value === "ghostie") {
		return "ghostty";
	}
	if (value === "intellij_idea") {
		return "intellijidea";
	}
	if (isOpenTargetId(value)) {
		return value;
	}
	return null;
}

function quoteShellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function quoteWindowsShellArgument(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function buildOpenAppCommand(path: string, ...appNames: string[]): string {
	const quotedPath = quoteShellArgument(path);
	if (appNames.length === 0) {
		return `open ${quotedPath}`;
	}
	const openAttempts = appNames.map((appName) => `open -a ${quoteShellArgument(appName)} ${quotedPath}`);
	if (openAttempts.length === 1) {
		const command = openAttempts[0];
		return command ?? `open ${quotedPath}`;
	}
	return `(${openAttempts.join(" || ")})`;
}

function buildOpenLinuxCommand(targetId: OpenTargetId, path: string): string {
	const quotedPath = quoteShellArgument(path);
	if (targetId === "finder") {
		return `xdg-open ${quotedPath}`;
	}
	if (targetId === "vscode") {
		return `code ${quotedPath}`;
	}
	if (targetId === "vscode-insiders") {
		return `code-insiders ${quotedPath}`;
	}
	if (targetId === "cursor") {
		return `cursor ${quotedPath}`;
	}
	if (targetId === "windsurf") {
		return `windsurf ${quotedPath}`;
	}
	if (targetId === "zed") {
		return `zed ${quotedPath}`;
	}
	return `xdg-open ${quotedPath}`;
}

function buildOpenWindowsCommand(targetId: OpenTargetId, path: string): string {
	const quotedPath = quoteWindowsShellArgument(path);
	if (targetId === "finder") {
		return `explorer ${quotedPath}`;
	}
	if (targetId === "vscode") {
		return `code ${quotedPath}`;
	}
	if (targetId === "vscode-insiders") {
		return `code-insiders ${quotedPath}`;
	}
	if (targetId === "cursor") {
		return `cursor ${quotedPath}`;
	}
	if (targetId === "windsurf") {
		return `windsurf ${quotedPath}`;
	}
	if (targetId === "zed") {
		return `zed ${quotedPath}`;
	}
	return `explorer ${quotedPath}`;
}

export function getOpenTargetOptions(platform: OpenTargetPlatform): readonly OpenTargetOption[] {
	return OPEN_TARGET_IDS_BY_PLATFORM[platform].map((targetId) => {
		const option = openTargetById.get(targetId) ?? DEFAULT_OPEN_TARGET;
		return {
			...option,
			label: getOpenTargetLabel(targetId, platform),
		};
	});
}

export function getOpenTargetOption(targetId: OpenTargetId, platform: OpenTargetPlatform): OpenTargetOption {
	const fallbackId = getDefaultOpenTargetId(platform);
	const resolvedTargetId = isOpenTargetSupported(targetId, platform) ? targetId : fallbackId;
	const option = openTargetById.get(resolvedTargetId) ?? DEFAULT_OPEN_TARGET;
	return {
		...option,
		label: getOpenTargetLabel(resolvedTargetId, platform),
	};
}

export function buildOpenCommand(targetId: OpenTargetId, path: string, platform: OpenTargetPlatform): string {
	if (!isOpenTargetSupported(targetId, platform)) {
		return buildOpenCommand(getDefaultOpenTargetId(platform), path, platform);
	}

	if (platform === "windows") {
		return buildOpenWindowsCommand(targetId, path);
	}

	if (platform === "linux" || platform === "other") {
		return buildOpenLinuxCommand(targetId, path);
	}

	if (targetId === "vscode") {
		return buildOpenAppCommand(path, "Visual Studio Code");
	}
	if (targetId === "vscode-insiders") {
		return buildOpenAppCommand(path, "Visual Studio Code - Insiders");
	}
	if (targetId === "cursor") {
		return buildOpenAppCommand(path, "Cursor");
	}
	if (targetId === "windsurf") {
		return buildOpenAppCommand(path, "Windsurf");
	}
	if (targetId === "finder") {
		return buildOpenAppCommand(path);
	}
	if (targetId === "terminal") {
		return buildOpenAppCommand(path, "Terminal");
	}
	if (targetId === "iterm2") {
		return buildOpenAppCommand(path, "iTerm", "iTerm2");
	}
	if (targetId === "ghostty") {
		return buildOpenAppCommand(path, "Ghostty", "Ghostie");
	}
	if (targetId === "warp") {
		return buildOpenAppCommand(path, "Warp");
	}
	if (targetId === "xcode") {
		return buildOpenAppCommand(path, "Xcode");
	}
	if (targetId === "intellijidea") {
		return buildOpenAppCommand(path, "IntelliJ IDEA", "IntelliJ IDEA CE");
	}
	return buildOpenAppCommand(path, "Zed");
}

// ── 从其他设备访问时：Remote-SSH 深链 ─────────────────────────────────────────
// 浏览器不在 runtime 主机上时，在 runtime 主机上启动编辑器毫无意义（窗口开在别人看不到的屏幕上）。
// 改为在浏览器所在的设备上打开编辑器的 `<scheme>://vscode-remote/ssh-remote+<destination><path>` 深链，
// 由编辑器经 SSH 连回 runtime 主机。只有 VS Code 系编辑器认这种 URL。

const REMOTE_SSH_EDITOR_URL_SCHEME_BY_OPEN_TARGET_ID: Partial<Record<OpenTargetId, string>> = {
	vscode: "vscode",
	"vscode-insiders": "vscode-insiders",
	cursor: "cursor",
	windsurf: "windsurf",
};

const REMOTE_SSH_OPEN_TARGET_IDS: readonly OpenTargetId[] = ["vscode", "cursor", "windsurf", "vscode-insiders"];

function toRemoteSshOpenTargetOption(targetId: OpenTargetId): OpenTargetOption {
	const option = openTargetById.get(targetId) ?? DEFAULT_OPEN_TARGET;
	return { ...option, label: `${option.label} (Remote-SSH)` };
}

export function getRemoteSshOpenTargetOptions(): readonly OpenTargetOption[] {
	return REMOTE_SSH_OPEN_TARGET_IDS.map(toRemoteSshOpenTargetOption);
}

// 偏好里存的可能是 Finder、终端之类不支持 Remote-SSH 的目标（偏好跨 origin 共享，本机访问时选的）。
// 这时按 VS Code 处理，但只在读取时回落，不写回偏好，免得改掉本机访问时的选择。
export function getRemoteSshOpenTargetOption(targetId: OpenTargetId): OpenTargetOption {
	return toRemoteSshOpenTargetOption(
		REMOTE_SSH_OPEN_TARGET_IDS.includes(targetId) ? targetId : DEFAULT_OPEN_TARGET.id,
	);
}

// Remote-SSH 深链要连的 SSH 目标，结构化保存，由 `buildRemoteSshAuthorityForEditorDeepLink` 统一编码。
export interface RemoteSshDestinationForEditorDeepLink {
	// 登录用的账号；未知时为 null，交给当前设备的 SSH 配置 / 默认账号决定。
	sshLoginUsername: string | null;
	// DNS 名、IPv4，或**不带方括号**的 IPv6 字面量（如 `fd7a:115c:a1e0::1`）——`ssh` 命令行与扩展都要这个原值。
	sshHostnameWithoutIpv6Brackets: string;
}

function encodeTextAsLowercaseHexOfUtf8Bytes(text: string): string {
	return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 深链里 `ssh-remote+` 之后的 authority。
 *
 * Remote-SSH 扩展先把 authority 当十六进制编码的 JSON 解析，失败再退回可读形式，按
 * `^(?:([^@]+)@)?([^:]+)(?::(\d+))?$` 拆用户 / 主机 / 端口——主机里的冒号会被当成端口分隔符，IPv6 字面量
 * 必然报 `Invalid authority format`。所以：
 * - DNS 名 / IPv4：保持可读的 `<user>@<host>` / `<host>`。
 * - IPv6 字面量（主机含冒号）：`JSON.stringify({ hostName, user? })` 的 UTF-8 小写十六进制。字段名与编码
 *   取自扩展自己的实现：Cursor Remote-SSH 1.1.16 的 `parseAuthorityNew` / `toEncodedString`，以及 VS Code
 *   Dev Containers 扩展为 Microsoft Remote-SSH 拼 `ssh-remote+` authority 的同一套 `{hostName, user, port}`。
 */
export function buildRemoteSshAuthorityForEditorDeepLink(destination: RemoteSshDestinationForEditorDeepLink): string {
	const hostname = destination.sshHostnameWithoutIpv6Brackets;
	const username = destination.sshLoginUsername;
	if (!hostname.includes(":")) {
		return username ? `${username}@${hostname}` : hostname;
	}
	const sshAuthorityJson = JSON.stringify(username ? { hostName: hostname, user: username } : { hostName: hostname });
	return encodeTextAsLowercaseHexOfUtf8Bytes(sshAuthorityJson);
}

export function buildRemoteSshEditorDeepLinkUrl(input: {
	openTargetId: OpenTargetId;
	remoteSshDestination: RemoteSshDestinationForEditorDeepLink;
	absolutePath: string;
	// 给了行号就按文件打开（VS Code 以路径末尾的 `:<line>` 区分文件与文件夹），不给就按文件夹打开。
	lineNumber?: number;
}): string {
	const scheme =
		REMOTE_SSH_EDITOR_URL_SCHEME_BY_OPEN_TARGET_ID[input.openTargetId] ??
		REMOTE_SSH_EDITOR_URL_SCHEME_BY_OPEN_TARGET_ID.vscode;
	const remoteSshAuthority = buildRemoteSshAuthorityForEditorDeepLink(input.remoteSshDestination);
	const normalizedPath = input.absolutePath.startsWith("/") ? input.absolutePath : `/${input.absolutePath}`;
	const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
	const lineSuffix = input.lineNumber === undefined ? "" : `:${input.lineNumber}`;
	return `${scheme}://vscode-remote/ssh-remote+${remoteSshAuthority}${encodedPath}${lineSuffix}`;
}
