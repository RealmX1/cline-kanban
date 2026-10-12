import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REMOTE_SSH_OPEN_TARGET_OPTIONS_FOOTNOTE, useOpenWorkspace } from "@/hooks/use-open-workspace";
import type { RuntimeHostRemoteEditorAccessIdentity } from "@/runtime/types";

const runtimeMocks = vi.hoisted(() => ({
	runCommand: vi.fn(),
	storedOpenTargetApplicationId: "vscode",
	setStoredOpenTargetApplicationId: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { runCommand: { mutate: runtimeMocks.runCommand } } }),
}));

vi.mock("@/runtime/use-user-interface-preferences-shared-across-browser-origins", () => ({
	useWorkspaceOpenTargetPreferredApplicationIdPreference: () => [
		runtimeMocks.storedOpenTargetApplicationId,
		runtimeMocks.setStoredOpenTargetApplicationId,
	],
}));

const RUNTIME_HOST_IDENTITY: RuntimeHostRemoteEditorAccessIdentity = {
	operatingSystemAccountUsername: "kanban-user",
	operatingSystemHostname: "kanban-host.local",
};

type UseOpenWorkspaceResult = ReturnType<typeof useOpenWorkspace>;

const originalLocation = window.location;

function setPageHostname(hostname: string): void {
	Object.defineProperty(window, "location", { value: { hostname }, writable: true, configurable: true });
}

describe("useOpenWorkspace", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: UseOpenWorkspaceResult | null;
	let clickedAnchorHrefs: string[];

	function HookHarness(props: Parameters<typeof useOpenWorkspace>[0]): null {
		latest = useOpenWorkspace(props);
		return null;
	}

	function render(identity: RuntimeHostRemoteEditorAccessIdentity | null): void {
		act(() => {
			root.render(
				<HookHarness
					currentProjectId="project-1"
					workspacePath="/Users/kanban-user/My Repo"
					runtimeHostRemoteEditorAccessIdentity={identity}
				/>,
			);
		});
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		runtimeMocks.runCommand.mockReset().mockResolvedValue({ exitCode: 0, combinedOutput: "" });
		runtimeMocks.setStoredOpenTargetApplicationId.mockReset();
		runtimeMocks.storedOpenTargetApplicationId = "vscode";
		clickedAnchorHrefs = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
			clickedAnchorHrefs.push(this.getAttribute("href") ?? "");
		});
		latest = null;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.restoreAllMocks();
		Object.defineProperty(window, "location", { value: originalLocation, writable: true, configurable: true });
	});

	it("opens a Remote-SSH deep link on this device instead of spawning on the runtime host when accessed remotely", () => {
		setPageHostname("my-machine.example-tailnet.ts.net");
		render(RUNTIME_HOST_IDENTITY);

		expect(latest?.openTargetOptions.map((option) => option.label)).toContain("VS Code (Remote-SSH)");
		expect(latest?.openTargetOptionsFootnote).toBe(REMOTE_SSH_OPEN_TARGET_OPTIONS_FOOTNOTE);
		act(() => {
			latest?.onOpenWorkspace();
		});

		expect(runtimeMocks.runCommand).not.toHaveBeenCalled();
		expect(clickedAnchorHrefs).toEqual([
			"vscode://vscode-remote/ssh-remote+kanban-user@my-machine.example-tailnet.ts.net/Users/kanban-user/My%20Repo",
		]);
	});

	// IPv6 字面量的可读 authority 会被 Remote-SSH 当成「主机:端口」拒掉，深链里必须是十六进制 JSON authority。
	it("opens an IPv6-literal page through the hex JSON Remote-SSH authority without URL brackets", () => {
		setPageHostname("[fd7a:115c:a1e0::1]");
		render(RUNTIME_HOST_IDENTITY);
		act(() => {
			latest?.onOpenWorkspace();
		});

		const expectedHexJsonAuthority = Array.from(
			new TextEncoder().encode(JSON.stringify({ hostName: "fd7a:115c:a1e0::1", user: "kanban-user" })),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		expect(clickedAnchorHrefs).toEqual([
			`vscode://vscode-remote/ssh-remote+${expectedHexJsonAuthority}/Users/kanban-user/My%20Repo`,
		]);
	});

	it("reads an unsupported stored target (Finder) as VS Code remotely without writing the preference back", () => {
		setPageHostname("my-machine.example-tailnet.ts.net");
		runtimeMocks.storedOpenTargetApplicationId = "finder";
		render(RUNTIME_HOST_IDENTITY);

		expect(latest?.selectedOpenTargetId).toBe("vscode");
		expect(runtimeMocks.setStoredOpenTargetApplicationId).not.toHaveBeenCalled();
	});

	it("keeps Open disabled remotely until the runtime host identity has loaded", () => {
		setPageHostname("my-machine.example-tailnet.ts.net");
		render(null);

		expect(latest?.canOpenWorkspace).toBe(false);
		act(() => {
			latest?.onOpenWorkspace();
		});
		expect(clickedAnchorHrefs).toEqual([]);
	});

	it("still spawns the editor on the runtime host when the browser is on the same machine", async () => {
		setPageHostname("127.0.0.1");
		render(null);

		expect(latest?.openTargetOptionsFootnote).toBeNull();
		expect(latest?.canOpenWorkspace).toBe(true);
		await act(async () => {
			latest?.onOpenWorkspace();
		});

		expect(runtimeMocks.runCommand).toHaveBeenCalledTimes(1);
		expect(clickedAnchorHrefs).toEqual([]);
	});
});
