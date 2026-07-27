import { act, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHomeAgentSession } from "@/hooks/use-home-agent-session";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

const startTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const stopTaskSessionMutateMock = vi.hoisted(() => vi.fn());
const reloadTaskChatSessionMutateMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string | null) => ({
		runtime: {
			startTaskSession: {
				mutate: (input: object) => startTaskSessionMutateMock({ workspaceId, ...input }),
			},
			stopTaskSession: {
				mutate: (input: object) => stopTaskSessionMutateMock({ workspaceId, ...input }),
			},
			reloadTaskChatSession: {
				mutate: (input: object) => reloadTaskChatSessionMutateMock({ workspaceId, ...input }),
			},
		},
	}),
}));

vi.mock("@/runtime/task-session-geometry", () => ({
	estimateTaskSessionGeometry: () => ({ cols: 120, rows: 24 }),
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
}));

interface HookSnapshot {
	panelMode: ReturnType<typeof useHomeAgentSession>["panelMode"];
	sessionKeys: string[];
	taskId: string | null;
}

function createSummary(taskId: string, agentId: RuntimeTaskSessionSummary["agentId"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId,
		workspacePath: "/tmp/repo",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function createRuntimeConfig(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	return {
		selectedAgentId: "codex",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		newTaskStartInPlanModeByDefault: true,
		effectiveCommand: "codex --dangerously-bypass-approvals-and-sandbox",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		readyForReviewNotificationsEnabled: true,
		notificationSoundEnabled: true,
		autoContinueOnConnectionDropEnabled: true,
		postDeployVerificationForceCompleteEnabled: false,
		detectedCommands: ["codex", "claude", "cline"],
		agents: [
			{
				id: "codex",
				label: "OpenAI Codex",
				binary: "codex",
				command: "codex --dangerously-bypass-approvals-and-sandbox",
				defaultArgs: [],
				installed: true,
				configured: true,
			},
			{
				id: "claude",
				label: "Claude Code",
				binary: "claude",
				command: "claude --dangerously-skip-permissions",
				defaultArgs: [],
				installed: true,
				configured: false,
			},
			{
				id: "cline",
				label: "Cline",
				binary: "cline",
				command: "cline",
				defaultArgs: [],
				installed: true,
				configured: false,
			},
		],
		shortcuts: [],
		clineProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		...overrides,
	};
}

function createLegacyRuntimeConfig(overrides: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
	const { clineProviderSettings: _clineProviderSettings, ...legacyConfig } = createRuntimeConfig(overrides);
	return legacyConfig as RuntimeConfigResponse;
}

const DEFAULT_WORKSPACE_GIT: RuntimeGitRepositoryInfo = {
	currentBranch: "main",
	defaultBranch: "main",
	branches: [{ name: "main" }],
};

function createFlushPromises(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: ((value: T) => void) | null = null;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) {
		throw new Error("Could not create deferred promise.");
	}
	return {
		promise,
		resolve: resolvePromise,
	};
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (snapshot === null) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function requireTaskId(taskId: string | null): string {
	if (taskId === null) {
		throw new Error("Expected a task id.");
	}
	return taskId;
}

function HookHarness({
	config,
	clineSessionContextVersion = 0,
	currentProjectId,
	onSnapshot,
	workspaceGit = DEFAULT_WORKSPACE_GIT,
	seedSessionSummary = false,
	// 既有用例断言的是「面板正在被看」时的启动/轮换行为，故默认分段可见；懒启动本身由专门用例覆盖。
	isHomeSidebarAgentSectionCurrentlyVisible = true,
}: {
	config: RuntimeConfigResponse | null;
	clineSessionContextVersion?: number;
	currentProjectId: string | null;
	onSnapshot: (snapshot: HookSnapshot) => void;
	workspaceGit?: RuntimeGitRepositoryInfo | null;
	seedSessionSummary?: boolean;
	isHomeSidebarAgentSectionCurrentlyVisible?: boolean;
}): null {
	const [sessionSummaries, setSessionSummaries] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => ({
			...currentSessions,
			[summary.taskId]: summary,
		}));
	}, []);
	const result = useHomeAgentSession({
		currentProjectId,
		runtimeProjectConfig: config,
		workspaceGit,
		clineSessionContextVersion,
		sessionSummaries,
		setSessionSummaries,
		upsertSessionSummary,
		isHomeSidebarAgentSectionCurrentlyVisible,
	});

	useEffect(() => {
		if (!seedSessionSummary || !result.taskId) {
			return;
		}
		upsertSessionSummary(createSummary(result.taskId, config?.selectedAgentId ?? "cline"));
	}, [config?.selectedAgentId, result.taskId, seedSessionSummary, upsertSessionSummary]);

	useEffect(() => {
		onSnapshot({
			panelMode: result.panelMode,
			sessionKeys: Object.keys(sessionSummaries),
			taskId: result.taskId,
		});
	}, [onSnapshot, result.panelMode, result.taskId, sessionSummaries]);

	return null;
}

describe("useHomeAgentSession", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		startTaskSessionMutateMock.mockReset();
		stopTaskSessionMutateMock.mockReset();
		reloadTaskChatSessionMutateMock.mockReset();
		startTaskSessionMutateMock.mockImplementation(async ({ taskId }: { taskId: string }) => ({
			ok: true,
			summary: createSummary(taskId, "codex"),
		}));
		reloadTaskChatSessionMutateMock.mockImplementation(async ({ taskId }: { taskId: string }) => ({
			ok: true,
			summary: createSummary(taskId, "cline"),
		}));
		notifyErrorMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("starts a home terminal session and rotates it when the selected agent changes", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const initialTaskId = initialSnapshot.taskId;
		expect(initialSnapshot.panelMode).toBe("terminal");
		expect(initialTaskId).toMatch(/^__home_agent__:workspace-1:codex$/);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(startTaskSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: initialTaskId,
				prompt: "",
				baseRef: "main",
			}),
		);
		expect(initialSnapshot.sessionKeys).toEqual([initialTaskId]);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "claude",
						effectiveCommand: "claude --dangerously-skip-permissions",
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const rotatedSnapshot = requireSnapshot(latestSnapshot);
		expect(rotatedSnapshot.panelMode).toBe("terminal");
		expect(rotatedSnapshot.taskId).toMatch(/^__home_agent__:workspace-1:claude$/);
		expect(rotatedSnapshot.taskId).not.toBe(initialTaskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(stopTaskSessionMutateMock).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			taskId: initialTaskId,
		});
		expect(rotatedSnapshot.sessionKeys).toEqual([rotatedSnapshot.taskId]);
	});

	it("does not spawn a home terminal session while the Kanban agent section is not visible", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible={false}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const snapshot = requireSnapshot(latestSnapshot);
		// 会话身份照常派生（面板一旦可见即可立刻挂载），但进程绝不提前 spawn。
		expect(snapshot.panelMode).toBe("terminal");
		expect(snapshot.taskId).toMatch(/^__home_agent__:workspace-1:codex$/);
		expect(snapshot.sessionKeys).toEqual([]);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("spawns the home terminal session when the Kanban agent section first becomes visible", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible={false}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const gatedTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const openedSnapshot = requireSnapshot(latestSnapshot);
		// 会话身份不因可见性翻转而轮换：打开面板拿到的就是之前那个 task id。
		expect(openedSnapshot.taskId).toBe(gatedTaskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(startTaskSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-1",
				taskId: gatedTaskId,
				prompt: "",
				baseRef: "main",
			}),
		);
		expect(openedSnapshot.sessionKeys).toEqual([gatedTaskId]);
	});

	it("keeps the home terminal session alive after the sidebar switches back to projects", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const startedTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);

		// 切回 projects（分段不再可见）只是不再允许「首次启动」，绝不停止已启动的会话——
		// 侧边栏会话的对话内容零持久化，停掉即不可恢复。
		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible={false}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		expect(requireTaskId(requireSnapshot(latestSnapshot).taskId)).toBe(startedTaskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();

		// 再切回 agent 分段：已启动的会话按 workspace+taskId 记住，既不重启也不轮换身份。
		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		expect(requireTaskId(requireSnapshot(latestSnapshot).taskId)).toBe(startedTaskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("does not spawn a home terminal session for a newly selected workspace whose agent section was never visible", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		// workspace-1：用户真的打开过 agent 分段，会话如常启动。
		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const workspaceOneTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);

		// 切回 projects 分段后换项目：workspace-2 的 agent 面板从未可见过，绝不能顺带 spawn 一个隐藏进程。
		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-2"
					isHomeSidebarAgentSectionCurrentlyVisible={false}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const workspaceTwoSnapshot = requireSnapshot(latestSnapshot);
		const workspaceTwoTaskId = requireTaskId(workspaceTwoSnapshot.taskId);
		expect(workspaceTwoTaskId).toMatch(/^__home_agent__:workspace-2:codex$/);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(startTaskSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ workspaceId: "workspace-1", taskId: workspaceOneTaskId }),
		);
		// workspace-1 已启动的会话不因切换项目而被停止。
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();

		// 用户在 workspace-2 主动打开 agent 分段后才启动，且只启动它自己那一个。
		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-2"
					isHomeSidebarAgentSectionCurrentlyVisible
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		expect(requireTaskId(requireSnapshot(latestSnapshot).taskId)).toBe(workspaceTwoTaskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(startTaskSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ workspaceId: "workspace-2", taskId: workspaceTwoTaskId }),
		);

		// 切回 workspace-1：两个会话都还在，谁都不重启、谁都不被停止。
		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					isHomeSidebarAgentSectionCurrentlyVisible
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const returnedSnapshot = requireSnapshot(latestSnapshot);
		expect(returnedSnapshot.taskId).toBe(workspaceOneTaskId);
		expect([...returnedSnapshot.sessionKeys].sort()).toEqual([workspaceOneTaskId, workspaceTwoTaskId].sort());
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("does not restart the home terminal session on a no-op rerender", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const initialTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const rerenderedSnapshot = requireSnapshot(latestSnapshot);
		expect(rerenderedSnapshot.taskId).toBe(initialTaskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("starts the home terminal session even when a stale summary was restored", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					seedSessionSummary
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.panelMode).toBe("terminal");
		expect(snapshot.taskId).toMatch(/^__home_agent__:workspace-1:codex$/);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(1);
		expect(startTaskSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				taskId: snapshot.taskId,
				prompt: "",
				baseRef: "main",
			}),
		);
	});

	it("keeps the same cline home chat session id when the provider changes", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "cline",
						effectiveCommand: "cline",
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const anthropicSnapshot = requireSnapshot(latestSnapshot);
		const anthropicTaskId = anthropicSnapshot.taskId;
		expect(anthropicSnapshot.panelMode).toBe("chat");
		expect(anthropicTaskId).toMatch(/^__home_agent__:workspace-1:cline$/);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "cline",
						effectiveCommand: "cline",
						clineProviderSettings: {
							providerId: "oca",
							modelId: "gpt-5",
							baseUrl: null,
							apiKeyConfigured: false,
							oauthProvider: null,
							oauthAccessTokenConfigured: false,
							oauthRefreshTokenConfigured: false,
							oauthAccountId: null,
							oauthExpiresAt: null,
						},
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const updatedSnapshot = requireSnapshot(latestSnapshot);
		expect(updatedSnapshot.panelMode).toBe("chat");
		expect(updatedSnapshot.taskId).toMatch(/^__home_agent__:workspace-1:cline$/);
		expect(updatedSnapshot.taskId).toBe(anthropicTaskId);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("reloads the home cline chat session when the Cline session context version changes", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "cline",
						effectiveCommand: "cline",
					})}
					clineSessionContextVersion={0}
					currentProjectId="workspace-1"
					seedSessionSummary
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const firstTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(firstTaskId).toMatch(/^__home_agent__:workspace-1:cline$/);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "cline",
						effectiveCommand: "cline",
					})}
					clineSessionContextVersion={1}
					currentProjectId="workspace-1"
					seedSessionSummary
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const secondTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(secondTaskId).toMatch(/^__home_agent__:workspace-1:cline$/);
		expect(secondTaskId).toBe(firstTaskId);
		expect(reloadTaskChatSessionMutateMock).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			taskId: firstTaskId,
		});
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("falls back to empty cline settings when older config shapes omit them", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createLegacyRuntimeConfig({
						selectedAgentId: "cline",
						effectiveCommand: "cline",
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.panelMode).toBe("chat");
		expect(snapshot.taskId).toMatch(/^__home_agent__:workspace-1:cline$/);
		expect(startTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("reuses the same home chat session id after remounting the app", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "cline",
						effectiveCommand: "cline",
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const firstTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);

		await act(async () => {
			root.unmount();
		});
		root = createRoot(container);
		latestSnapshot = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "cline",
						effectiveCommand: "cline",
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const secondTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(secondTaskId).toMatch(/^__home_agent__:workspace-1:cline$/);
		expect(secondTaskId).toBe(firstTaskId);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
	});

	it("stops stale terminal starts when the selected agent changes mid-launch", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const firstStart = createDeferred<{
			ok: boolean;
			summary: RuntimeTaskSessionSummary;
		}>();
		const secondStart = createDeferred<{
			ok: boolean;
			summary: RuntimeTaskSessionSummary;
		}>();

		startTaskSessionMutateMock.mockReset();
		startTaskSessionMutateMock
			.mockImplementationOnce(async () => await firstStart.promise)
			.mockImplementationOnce(async () => await secondStart.promise);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const firstTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(firstTaskId).toMatch(/^__home_agent__:workspace-1:codex$/);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig({
						selectedAgentId: "claude",
						effectiveCommand: "claude --dangerously-skip-permissions",
					})}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const secondTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(secondTaskId).toMatch(/^__home_agent__:workspace-1:claude$/);
		expect(secondTaskId).not.toBe(firstTaskId);
		expect(stopTaskSessionMutateMock).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			taskId: firstTaskId,
		});

		await act(async () => {
			firstStart.resolve({
				ok: true,
				summary: createSummary(firstTaskId, "codex"),
			});
			await createFlushPromises();
			secondStart.resolve({
				ok: true,
				summary: createSummary(secondTaskId, "claude"),
			});
			await createFlushPromises();
		});

		expect(requireSnapshot(latestSnapshot).sessionKeys).toEqual([secondTaskId]);
		expect(stopTaskSessionMutateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-1",
				taskId: firstTaskId,
			}),
		);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(2);
	});

	it("keeps one home terminal session per project when switching workspaces", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const firstTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);
		expect(firstTaskId).toMatch(/^__home_agent__:workspace-1:codex$/);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-2"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const secondSnapshot = requireSnapshot(latestSnapshot);
		expect(secondSnapshot.taskId).toMatch(/^__home_agent__:workspace-2:codex$/);
		expect(secondSnapshot.taskId).not.toBe(firstTaskId);
		expect([...secondSnapshot.sessionKeys].sort()).toEqual([firstTaskId, secondSnapshot.taskId].sort());
		expect(startTaskSessionMutateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				workspaceId: "workspace-2",
				taskId: secondSnapshot.taskId,
			}),
		);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const returnedSnapshot = requireSnapshot(latestSnapshot);
		expect(returnedSnapshot.taskId).toBe(firstTaskId);
		expect([...returnedSnapshot.sessionKeys].sort()).toEqual([firstTaskId, secondSnapshot.taskId].sort());
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(2);
	});

	it("reuses an in-flight project terminal start when switching away and back", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const firstWorkspaceStart = createDeferred<{
			ok: boolean;
			summary: RuntimeTaskSessionSummary;
		}>();
		const secondWorkspaceStart = createDeferred<{
			ok: boolean;
			summary: RuntimeTaskSessionSummary;
		}>();

		startTaskSessionMutateMock.mockReset();
		startTaskSessionMutateMock
			.mockImplementationOnce(async () => await firstWorkspaceStart.promise)
			.mockImplementationOnce(async () => await secondWorkspaceStart.promise);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const workspaceOneTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-2"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		const workspaceTwoTaskId = requireTaskId(requireSnapshot(latestSnapshot).taskId);

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		expect(requireTaskId(requireSnapshot(latestSnapshot).taskId)).toBe(workspaceOneTaskId);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(2);

		await act(async () => {
			root.render(
				<HookHarness
					config={null}
					currentProjectId="workspace-2"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		await act(async () => {
			firstWorkspaceStart.resolve({
				ok: true,
				summary: createSummary(workspaceOneTaskId, "codex"),
			});
			await createFlushPromises();
			secondWorkspaceStart.resolve({
				ok: true,
				summary: createSummary(workspaceTwoTaskId, "codex"),
			});
			await createFlushPromises();
		});

		await act(async () => {
			root.render(
				<HookHarness
					config={createRuntimeConfig()}
					currentProjectId="workspace-2"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await createFlushPromises();
		});

		expect(requireTaskId(requireSnapshot(latestSnapshot).taskId)).toBe(workspaceTwoTaskId);
		expect([...requireSnapshot(latestSnapshot).sessionKeys].sort()).toEqual(
			[workspaceOneTaskId, workspaceTwoTaskId].sort(),
		);
		expect(startTaskSessionMutateMock).toHaveBeenCalledTimes(2);
		expect(stopTaskSessionMutateMock).not.toHaveBeenCalled();
	});
});
