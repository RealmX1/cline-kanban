import { afterEach, describe, expect, it } from "vitest";

import {
	isBrowserOnTheSameMachineAsAgentRuntimeHost,
	resolveProjectFilesystemAccessRouteForBrowser,
	resolveRemoteSshDestinationForAgentRuntimeHost,
} from "@/utils/resolve-project-filesystem-access-route-for-browser";

const originalLocation = window.location;

function setPageHostname(hostname: string): void {
	Object.defineProperty(window, "location", { value: { hostname }, writable: true, configurable: true });
}

describe("resolve-project-filesystem-access-route-for-browser", () => {
	afterEach(() => {
		Object.defineProperty(window, "location", { value: originalLocation, writable: true, configurable: true });
	});

	it("spawns on the runtime host when the page is served from a loopback address", () => {
		setPageHostname("localhost");
		expect(isBrowserOnTheSameMachineAsAgentRuntimeHost()).toBe(true);
		expect(resolveProjectFilesystemAccessRouteForBrowser()).toBe(
			"spawn-on-runtime-host-because-browser-shares-the-machine",
		);
	});

	// 浏览器访问 http://[::1]:3484 时 hostname 带方括号，仍是本机，不能走 SSH 打开自己。
	it("spawns on the runtime host when the page is served from the bracketed IPv6 loopback", () => {
		setPageHostname(new URL("http://[::1]:3484").hostname);
		expect(isBrowserOnTheSameMachineAsAgentRuntimeHost()).toBe(true);
		expect(resolveProjectFilesystemAccessRouteForBrowser()).toBe(
			"spawn-on-runtime-host-because-browser-shares-the-machine",
		);
	});

	it("uses a Remote-SSH deep link when the page is reached through a tailnet name", () => {
		setPageHostname("my-machine.example-tailnet.ts.net");
		expect(isBrowserOnTheSameMachineAsAgentRuntimeHost()).toBe(false);
		expect(resolveProjectFilesystemAccessRouteForBrowser()).toBe("remote-ssh-editor-deep-link");
	});

	it("targets the page hostname with the runtime account, or no account when it is unknown", () => {
		setPageHostname("my-machine.example-tailnet.ts.net");
		expect(
			resolveRemoteSshDestinationForAgentRuntimeHost({
				operatingSystemAccountUsername: "me",
				operatingSystemHostname: "Mac-mini.local",
			}),
		).toEqual({ sshLoginUsername: "me", sshHostnameWithoutIpv6Brackets: "my-machine.example-tailnet.ts.net" });
		expect(
			resolveRemoteSshDestinationForAgentRuntimeHost({
				operatingSystemAccountUsername: null,
				operatingSystemHostname: "container",
			}),
		).toEqual({ sshLoginUsername: null, sshHostnameWithoutIpv6Brackets: "my-machine.example-tailnet.ts.net" });
	});

	// `location.hostname` 对 IPv6 字面量带方括号；SSH 目标要里面的地址。
	it("strips the URL brackets from an IPv6 literal page hostname and keeps IPv4 as is", () => {
		setPageHostname("[fd7a:115c:a1e0::1]");
		expect(
			resolveRemoteSshDestinationForAgentRuntimeHost({
				operatingSystemAccountUsername: "me",
				operatingSystemHostname: "Mac-mini.local",
			}),
		).toEqual({ sshLoginUsername: "me", sshHostnameWithoutIpv6Brackets: "fd7a:115c:a1e0::1" });

		setPageHostname("100.64.0.7");
		expect(
			resolveRemoteSshDestinationForAgentRuntimeHost({
				operatingSystemAccountUsername: "me",
				operatingSystemHostname: "Mac-mini.local",
			}),
		).toEqual({ sshLoginUsername: "me", sshHostnameWithoutIpv6Brackets: "100.64.0.7" });
	});
});
