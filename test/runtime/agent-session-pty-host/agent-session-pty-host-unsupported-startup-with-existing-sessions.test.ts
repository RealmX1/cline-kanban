import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAgentSessionPtyHostRuntimeFacadeWhenEnabled } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-startup";
import * as generationDiscovery from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import * as readOnlyHostQueries from "../../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import { createTempDir } from "../../utilities/temp-dir";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe.skipIf(process.platform === "win32")("不支持的启动方式保留既有 hosted 会话", () => {
	it("Electron 不接管存量，但也不能静默当作不存在；原会话自然退出后可继续启动", async () => {
		const directory = createTempDir("kanban-unsupported-hosted-startup-");
		try {
			vi.stubEnv("HOME", directory.path);
			vi.stubEnv("KANBAN_DESKTOP", "1");
			const runtimeHome = join(directory.path, ".cline", "kanban");
			await mkdir(runtimeHome, { recursive: true });
			await writeFile(join(runtimeHome, "config.json"), JSON.stringify({ selectedAgentId: "codex" }));
			vi.spyOn(generationDiscovery, "listAgentSessionPtyHostGenerationSocketPaths").mockReturnValue([
				"/isolated-host.sock",
			]);
			const query = vi.spyOn(readOnlyHostQueries, "queryAgentSessionPtyHostReadOnlyStatus").mockResolvedValue({
				hostProcessId: 123,
				hostStartedAtEpochMs: 100,
				hostProcessInstanceId: "isolated-host-instance",
				hostBuildIdentity: "isolated-host-build",
				hostLifecycleState: "serving",
				controllerProcessId: null,
				hostedSessions: [
					{
						hostedSessionKey: "original-key",
						workspaceId: "isolated-workspace",
						conversationSessionId: "original-session",
						hostedSessionKind: "task_agent_session",
						processId: 124,
						processStartedAtEpochMs: 101,
						exited: false,
						adoptionRecordPresent: true,
						outputEndByteOffset: 1,
					},
				],
			});
			await expect(
				startAgentSessionPtyHostRuntimeFacadeWhenEnabled({ runtimePortWasAutoSelected: false, warn: () => {} }),
			).rejects.toThrow("等待原会话自然结束");
			query.mockResolvedValue({
				kind: "agent_session_pty_host_unreachable",
				failureMessage: "原 host 已退出",
				noHostIsListening: true,
			});
			await expect(
				startAgentSessionPtyHostRuntimeFacadeWhenEnabled({ runtimePortWasAutoSelected: false, warn: () => {} }),
			).resolves.toBeNull();
		} finally {
			directory.cleanup();
		}
	});
});
