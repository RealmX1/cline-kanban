import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { resolveAgentSessionPtyHostModeEnablement } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-mode-enablement";
import {
	listAgentSessionPtyHostGenerationSocketPaths,
	resolveAgentSessionPtyHostSocketPath,
} from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";

const enabledInput = {
	agentSessionPtyHostModeEnvironmentValue: "enabled",
	kanbanDesktopEnvironmentValue: undefined,
	runtimePortWasAutoSelected: false,
	runtimeServesRemoteHost: false,
	platform: "darwin" as NodeJS.Platform,
};

describe("resolveAgentSessionPtyHostModeEnablement", () => {
	it("is enabled only when explicitly opted in on a fixed port", () => {
		expect(resolveAgentSessionPtyHostModeEnablement(enabledInput)).toEqual({ agentSessionPtyHostModeEnabled: true });
		expect(
			resolveAgentSessionPtyHostModeEnablement({
				...enabledInput,
				agentSessionPtyHostModeEnvironmentValue: undefined,
			}),
		).toEqual({ agentSessionPtyHostModeEnabled: false, disabledReason: "not_opted_in" });
	});

	it("is forced off for auto ports, remote host mode, win32 and the Electron desktop shell", () => {
		expect(resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, runtimePortWasAutoSelected: true })).toEqual({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "runtime_port_auto_selected",
		});
		expect(resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, runtimeServesRemoteHost: true })).toEqual({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "remote_host_mode",
		});
		expect(resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, platform: "win32" })).toEqual({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "unsupported_platform_win32",
		});
		expect(resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, kanbanDesktopEnvironmentValue: "1" })).toEqual(
			{
				agentSessionPtyHostModeEnabled: false,
				disabledReason: "electron_desktop_shell",
			},
		);
	});
});

describe("agent session pty host socket path for runtime identity", () => {
	it("places sockets under the runtime home and enumerates every generation of the same port only", () => {
		// 刻意用 /tmp 下的短目录：os.tmpdir()（macOS 的 /var/folders/…）本身就长到会触发 sun_path 回退。
		const runtimeHomeDirectoryPath = mkdtempSync("/tmp/kph-");
		onTestFinished(() => rmSync(runtimeHomeDirectoryPath, { recursive: true, force: true }));
		const identity = { runtimeHomeDirectoryPath, runtimePort: 3484 };
		const firstGenerationSocketPath = resolveAgentSessionPtyHostSocketPath(identity, "a".repeat(64));
		const secondGenerationSocketPath = resolveAgentSessionPtyHostSocketPath(identity, "b".repeat(64));
		const otherPortSocketPath = resolveAgentSessionPtyHostSocketPath(
			{ ...identity, runtimePort: 3486 },
			"c".repeat(64),
		);
		for (const socketPath of [firstGenerationSocketPath, secondGenerationSocketPath, otherPortSocketPath]) {
			mkdirSync(join(socketPath, ".."), { recursive: true });
			writeFileSync(socketPath, "");
		}

		expect(firstGenerationSocketPath).toBe(
			join(runtimeHomeDirectoryPath, "agent-session-pty-host", `p3484-${"a".repeat(12)}.sock`),
		);
		expect(listAgentSessionPtyHostGenerationSocketPaths(identity)).toEqual([
			firstGenerationSocketPath,
			secondGenerationSocketPath,
		]);
	});

	it("falls back to a short directory when the runtime home would overflow the unix socket path limit", () => {
		const identity = { runtimeHomeDirectoryPath: `/tmp/${"deep/".repeat(30)}kanban`, runtimePort: 3484 };

		const socketPath = resolveAgentSessionPtyHostSocketPath(identity, "d".repeat(64));

		expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103);
		expect(socketPath).toMatch(/^\/tmp\/kanban-agent-session-pty-host-\d+\/[0-9a-f]{12}-p3484-d{12}\.sock$/);
	});
});
