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
	it("受支持固定端口缺省启用，环境覆盖不依赖持久设置", () => {
		expect(resolveAgentSessionPtyHostModeEnablement(enabledInput)).toMatchObject({
			agentSessionPtyHostModeEnabled: true,
		});
		expect(
			resolveAgentSessionPtyHostModeEnablement({
				...enabledInput,
				agentSessionPtyHostModeEnvironmentValue: undefined,
			}),
		).toMatchObject({ agentSessionPtyHostModeEnabled: true, enablementPreferenceSource: "default_enabled" });
	});

	it("显式开关持久生效，环境覆盖归一化且无效值维持关闭结果", () => {
		const persistedDisabled = {
			...enabledInput,
			agentSessionPtyHostModeEnvironmentValue: undefined,
			agentSessionPtyHostEnablementPreference: "disabled" as const,
		};
		expect(resolveAgentSessionPtyHostModeEnablement(persistedDisabled)).toMatchObject({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "persistent_preference_disabled",
			canAdoptExistingHostedSessions: true,
		});
		expect(
			resolveAgentSessionPtyHostModeEnablement({
				...persistedDisabled,
				agentSessionPtyHostModeEnvironmentValue: " EnAbLeD ",
			}),
		).toMatchObject({ agentSessionPtyHostModeEnabled: true, enablementPreferenceSource: "environment_override" });
		for (const value of ["disabled", " DiSaBlEd ", "", "invalid"]) {
			expect(
				resolveAgentSessionPtyHostModeEnablement({
					...enabledInput,
					agentSessionPtyHostModeEnvironmentValue: value,
				}),
			).toMatchObject({ agentSessionPtyHostModeEnabled: false, enablementPreferenceSource: "environment_override" });
		}
		expect(
			resolveAgentSessionPtyHostModeEnablement({
				...enabledInput,
				agentSessionPtyHostModeEnvironmentValue: "invalid",
			}),
		).toMatchObject({ disabledReason: "invalid_environment_override" });
		expect(resolveAgentSessionPtyHostModeEnablement({ ...persistedDisabled, platform: "win32" })).toMatchObject({
			disabledReason: "unsupported_platform_win32",
			canAdoptExistingHostedSessions: false,
		});
	});

	it("is forced off for auto ports, remote host mode, win32 and the Electron desktop shell", () => {
		expect(
			resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, runtimePortWasAutoSelected: true }),
		).toMatchObject({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "runtime_port_auto_selected",
		});
		expect(
			resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, runtimeServesRemoteHost: true }),
		).toMatchObject({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "remote_host_mode",
		});
		expect(resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, platform: "win32" })).toMatchObject({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "unsupported_platform_win32",
		});
		expect(
			resolveAgentSessionPtyHostModeEnablement({ ...enabledInput, kanbanDesktopEnvironmentValue: "1" }),
		).toMatchObject({
			agentSessionPtyHostModeEnabled: false,
			disabledReason: "electron_desktop_shell",
		});
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
