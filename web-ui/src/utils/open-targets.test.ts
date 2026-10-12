import { describe, expect, it } from "vitest";
import {
	buildOpenCommand,
	buildRemoteSshAuthorityForEditorDeepLink,
	buildRemoteSshEditorDeepLinkUrl,
	getOpenTargetOption,
	getOpenTargetOptions,
	getRemoteSshOpenTargetOption,
	getRemoteSshOpenTargetOptions,
} from "@/utils/open-targets";

describe("open-targets", () => {
	it("filters unsupported options on windows", () => {
		const windowsOptions = getOpenTargetOptions("windows");
		expect(windowsOptions.some((option) => option.id === "iterm2")).toBe(false);
		expect(windowsOptions.some((option) => option.id === "xcode")).toBe(false);
		expect(windowsOptions.some((option) => option.id === "vscode-insiders")).toBe(true);
		expect(windowsOptions.some((option) => option.id === "finder")).toBe(true);
	});

	it("places VS Code Insiders as second from bottom on macOS", () => {
		const macOptions = getOpenTargetOptions("mac");
		expect(macOptions.at(-2)?.id).toBe("vscode-insiders");
	});

	it("falls back to default option when selected target is unsupported on platform", () => {
		const selected = getOpenTargetOption("iterm2", "linux");
		expect(selected.id).toBe("vscode");
	});

	it("builds a macOS app-open command", () => {
		expect(buildOpenCommand("vscode", "/tmp/repo", "mac")).toBe("open -a 'Visual Studio Code' '/tmp/repo'");
	});

	it("builds a linux file manager command", () => {
		expect(buildOpenCommand("finder", "/tmp/my repo", "linux")).toBe("xdg-open '/tmp/my repo'");
	});

	it("builds a macOS VS Code Insiders command", () => {
		expect(buildOpenCommand("vscode-insiders", "/tmp/repo", "mac")).toBe(
			"open -a 'Visual Studio Code - Insiders' '/tmp/repo'",
		);
	});

	it("builds a windows file explorer command", () => {
		expect(buildOpenCommand("finder", "C:\\Users\\dev\\my repo", "windows")).toBe(
			'explorer "C:\\Users\\dev\\my repo"',
		);
	});

	it("builds a windows VS Code Insiders command", () => {
		expect(buildOpenCommand("vscode-insiders", "C:\\Users\\dev\\my repo", "windows")).toBe(
			'code-insiders "C:\\Users\\dev\\my repo"',
		);
	});

	it("falls back to default command when target is unsupported on windows", () => {
		expect(buildOpenCommand("iterm2", "C:\\Users\\dev\\my repo", "windows")).toBe('code "C:\\Users\\dev\\my repo"');
	});
});

describe("Remote-SSH deep links (browser on another device)", () => {
	it("lists only editors that understand vscode-remote URLs, labelled as Remote-SSH", () => {
		expect(getRemoteSshOpenTargetOptions().map((option) => [option.id, option.label])).toEqual([
			["vscode", "VS Code (Remote-SSH)"],
			["cursor", "Cursor (Remote-SSH)"],
			["windsurf", "Windsurf (Remote-SSH)"],
			["vscode-insiders", "VS Code Insiders (Remote-SSH)"],
		]);
	});

	it("treats a stored target without Remote-SSH support as VS Code", () => {
		expect(getRemoteSshOpenTargetOption("finder").id).toBe("vscode");
		expect(getRemoteSshOpenTargetOption("cursor").id).toBe("cursor");
	});

	it("builds a folder link without a line suffix and a file link with one", () => {
		expect(
			buildRemoteSshEditorDeepLinkUrl({
				openTargetId: "vscode",
				remoteSshDestination: {
					sshLoginUsername: "me",
					sshHostnameWithoutIpv6Brackets: "my-machine.example-tailnet.ts.net",
				},
				absolutePath: "/Users/me/repo",
			}),
		).toBe("vscode://vscode-remote/ssh-remote+me@my-machine.example-tailnet.ts.net/Users/me/repo");
		expect(
			buildRemoteSshEditorDeepLinkUrl({
				openTargetId: "cursor",
				remoteSshDestination: {
					sshLoginUsername: "me",
					sshHostnameWithoutIpv6Brackets: "my-machine.example-tailnet.ts.net",
				},
				absolutePath: "/Users/me/repo/.cline/kanban/config.json",
				lineNumber: 1,
			}),
		).toBe(
			"cursor://vscode-remote/ssh-remote+me@my-machine.example-tailnet.ts.net/Users/me/repo/.cline/kanban/config.json:1",
		);
	});

	it("percent-encodes each path segment but keeps the slashes", () => {
		expect(
			buildRemoteSshEditorDeepLinkUrl({
				openTargetId: "vscode-insiders",
				remoteSshDestination: { sshLoginUsername: null, sshHostnameWithoutIpv6Brackets: "host" },
				absolutePath: "/Users/me/My Projects/看板 #1",
			}),
		).toBe("vscode-insiders://vscode-remote/ssh-remote+host/Users/me/My%20Projects/%E7%9C%8B%E6%9D%BF%20%231");
	});

	it("falls back to the vscode scheme for a target without one", () => {
		expect(
			buildRemoteSshEditorDeepLinkUrl({
				openTargetId: "zed",
				remoteSshDestination: { sshLoginUsername: null, sshHostnameWithoutIpv6Brackets: "host" },
				absolutePath: "/tmp",
			}),
		).toBe("vscode://vscode-remote/ssh-remote+host/tmp");
	});

	it("keeps DNS names and IPv4 addresses in the readable user@host authority", () => {
		expect(
			buildRemoteSshAuthorityForEditorDeepLink({
				sshLoginUsername: "me",
				sshHostnameWithoutIpv6Brackets: "my-machine.example-tailnet.ts.net",
			}),
		).toBe("me@my-machine.example-tailnet.ts.net");
		expect(
			buildRemoteSshAuthorityForEditorDeepLink({
				sshLoginUsername: "me",
				sshHostnameWithoutIpv6Brackets: "100.64.0.7",
			}),
		).toBe("me@100.64.0.7");
		expect(
			buildRemoteSshAuthorityForEditorDeepLink({
				sshLoginUsername: null,
				sshHostnameWithoutIpv6Brackets: "100.64.0.7",
			}),
		).toBe("100.64.0.7");
	});

	// Remote-SSH 的可读 authority 把冒号当端口分隔符，IPv6 字面量必须走扩展认的十六进制 JSON authority。
	it("encodes an IPv6 literal as the hex JSON authority that decodes back to hostName and user", () => {
		const authorityWithUser = buildRemoteSshAuthorityForEditorDeepLink({
			sshLoginUsername: "me",
			sshHostnameWithoutIpv6Brackets: "fd7a:115c:a1e0::1",
		});
		expect(authorityWithUser).toMatch(/^[0-9a-f]+$/);
		expect(JSON.parse(decodeLowercaseHexOfUtf8Bytes(authorityWithUser))).toEqual({
			hostName: "fd7a:115c:a1e0::1",
			user: "me",
		});

		const authorityWithoutUser = buildRemoteSshAuthorityForEditorDeepLink({
			sshLoginUsername: null,
			sshHostnameWithoutIpv6Brackets: "fd7a:115c:a1e0::1",
		});
		expect(JSON.parse(decodeLowercaseHexOfUtf8Bytes(authorityWithoutUser))).toEqual({
			hostName: "fd7a:115c:a1e0::1",
		});

		expect(
			buildRemoteSshEditorDeepLinkUrl({
				openTargetId: "cursor",
				remoteSshDestination: { sshLoginUsername: "me", sshHostnameWithoutIpv6Brackets: "fd7a:115c:a1e0::1" },
				absolutePath: "/Users/me/repo",
			}),
		).toBe(`cursor://vscode-remote/ssh-remote+${authorityWithUser}/Users/me/repo`);
	});
});

function decodeLowercaseHexOfUtf8Bytes(hex: string): string {
	const bytePairs = hex.match(/../g) ?? [];
	return new TextDecoder().decode(Uint8Array.from(bytePairs, (bytePair) => Number.parseInt(bytePair, 16)));
}
