import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	pickBestInstalledAgentIdFromDetected,
	saveRuntimeConfig,
	updateGlobalRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { createTempDir } from "../../utilities/temp-dir";

function withTemporaryEnv<T>(
	input: {
		home: string;
		pathPrefix?: string;
		replacePath?: boolean;
	},
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousPath = process.env.PATH;
	process.env.HOME = input.home;
	process.env.USERPROFILE = input.home;
	if (input.pathPrefix) {
		process.env.PATH = input.replacePath
			? input.pathPrefix
			: previousPath
				? `${input.pathPrefix}${delimiter}${previousPath}`
				: input.pathPrefix;
	}
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (input.pathPrefix) {
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
		}
	});
}

function writeFakeCommand(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

describe.sequential("runtime-config auto agent selection", () => {
	it("selects agents using the configured priority order", () => {
		expect(pickBestInstalledAgentIdFromDetected(["codex", "opencode", "gemini"])).toBe("codex");
		expect(pickBestInstalledAgentIdFromDetected(["opencode", "droid", "gemini"])).toBe("droid");
		expect(pickBestInstalledAgentIdFromDetected(["cursor-agent", "droid", "gemini"])).toBe("cursor");
		expect(pickBestInstalledAgentIdFromDetected(["kiro-cli", "gemini"])).toBe("kiro");
		expect(pickBestInstalledAgentIdFromDetected(["droid", "gemini", "cline"])).toBe("droid");
		expect(pickBestInstalledAgentIdFromDetected(["gemini", "cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["claude", "codex", "cline"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["claude", "droid"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected([])).toBeNull();
	});

	it("auto-selects and persists when unset", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-");

		try {
			writeFakeCommand(tempBin, "opencode");
			writeFakeCommand(tempBin, "codex");
			writeFakeCommand(tempBin, "gemini");

			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				const isolatedPath = `${tempBin}${delimiter}/usr/bin${delimiter}/bin`;
				await withTemporaryEnv({ home: tempHome, pathPrefix: isolatedPath, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("codex");
					const persisted = JSON.parse(
						readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
					) as {
						selectedAgentId?: string;
						agentAutonomousModeEnabled?: boolean;
						newTaskStartInPlanModeByDefault?: boolean;
						readyForReviewNotificationsEnabled?: boolean;
						commitPromptTemplate?: string;
						openPrPromptTemplate?: string;
					};
					expect(persisted.selectedAgentId).toBe("codex");
					expect(persisted.agentAutonomousModeEnabled).toBeUndefined();
					expect(persisted.newTaskStartInPlanModeByDefault).toBeUndefined();
					expect(persisted.readyForReviewNotificationsEnabled).toBeUndefined();
					expect(persisted.commitPromptTemplate).toBeUndefined();
					expect(persisted.openPrPromptTemplate).toBeUndefined();

					const reloadedState = await loadRuntimeConfig(tempProject);
					expect(reloadedState.selectedAgentId).toBe("codex");
					expect(reloadedState.newTaskStartInPlanModeByDefault).toBe(true);
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not write config when no supported CLI is detected", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-default-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-default-");

		try {
			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("cline");
					expect(existsSync(join(tempHome, ".cline", "kanban", "config.json"))).toBe(false);
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("treats the home directory as global-only config scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-home-scope-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempHome);
				expect(state.globalConfigPath).toBe(join(tempHome, ".cline", "kanban", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);

				const updated = await updateRuntimeConfig(tempHome, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");
				expect(updated.projectConfigPath).toBeNull();

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					shortcuts?: unknown;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.shortcuts).toBeUndefined();
			});
		} finally {
			cleanupHome();
		}
	});

	it("loads global runtime config without a project scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-global-only-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadGlobalRuntimeConfig();
				expect(state.globalConfigPath).toBe(join(tempHome, ".cline", "kanban", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);
			});
		} finally {
			cleanupHome();
		}
	});

	it("normalizes unsupported configured agents to the default launch agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-set-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-set-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-set-");

		try {
			writeFakeCommand(tempBin, "claude");
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						selectedAgentId: "gemini",
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not auto-select when global config file already exists without selected agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-existing-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-existing-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-existing-");

		try {
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						readyForReviewNotificationsEnabled: true,
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("save omits default keys when they were not previously set", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-omit-defaults-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-omit-defaults-",
		);

		try {
			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(join(runtimeConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					ompAgentSessionTransportForNewTasks: "pty_terminal" as const,
					newTaskStartInPlanModeByDefault: true,
					readyForReviewNotificationsEnabled: true,
					notificationSoundEnabled: true,
					autoContinueOnConnectionDropEnabled: true,
					programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: true,
					postDeployVerificationForceCompleteEnabled: false,
					shortcuts: [],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					agentAutonomousModeEnabled?: boolean;
					newTaskStartInPlanModeByDefault?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
					notificationSoundEnabled?: boolean;
					commitPromptTemplate?: string;
					openPrPromptTemplate?: string;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.newTaskStartInPlanModeByDefault).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
				expect(globalPayload.notificationSoundEnabled).toBeUndefined();
				expect(globalPayload.commitPromptTemplate).toBeUndefined();
				expect(globalPayload.openPrPromptTemplate).toBeUndefined();
				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes an existing empty project config file when no shortcuts are saved", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-cleanup-empty-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-cleanup-empty-",
		);

		try {
			const runtimeProjectConfigDir = join(tempProject, ".cline", "kanban");
			mkdirSync(runtimeProjectConfigDir, { recursive: true });
			writeFileSync(join(runtimeProjectConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					ompAgentSessionTransportForNewTasks: "pty_terminal" as const,
					newTaskStartInPlanModeByDefault: true,
					readyForReviewNotificationsEnabled: true,
					notificationSoundEnabled: true,
					autoContinueOnConnectionDropEnabled: true,
					programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: true,
					postDeployVerificationForceCompleteEnabled: false,
					shortcuts: [],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});

				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes the project config file when the last shortcut is deleted", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-remove-last-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-remove-last-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					ompAgentSessionTransportForNewTasks: "pty_terminal" as const,
					newTaskStartInPlanModeByDefault: true,
					readyForReviewNotificationsEnabled: true,
					notificationSoundEnabled: true,
					autoContinueOnConnectionDropEnabled: true,
					programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: true,
					postDeployVerificationForceCompleteEnabled: false,
					shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});
				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(true);

				await updateRuntimeConfig(tempProject, {
					shortcuts: [],
				});

				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("updateRuntimeConfig supports partial updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-partial-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-partial-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const updated = await updateRuntimeConfig(tempProject, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					selectedShortcutLabel?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.selectedShortcutLabel).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists autonomous mode when disabled", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-autonomous-disabled-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-autonomous-disabled-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, {
					agentAutonomousModeEnabled: false,
				});
				expect(updated.agentAutonomousModeEnabled).toBe(false);

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					agentAutonomousModeEnabled?: boolean;
				};
				expect(globalPayload.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists disabled new-task plan mode default explicitly", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir(
			"kanban-home-runtime-config-new-task-plan-disabled-",
		);
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-new-task-plan-disabled-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, {
					newTaskStartInPlanModeByDefault: false,
				});
				expect(updated.newTaskStartInPlanModeByDefault).toBe(false);

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					newTaskStartInPlanModeByDefault?: boolean;
				};
				expect(globalPayload.newTaskStartInPlanModeByDefault).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.newTaskStartInPlanModeByDefault).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("preserves concurrent config updates across processes", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-concurrent-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-concurrent-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const [selectedAgentState, autonomousModeState] = await Promise.all([
					updateRuntimeConfig(tempProject, {
						selectedAgentId: "codex",
					}),
					updateRuntimeConfig(tempProject, {
						agentAutonomousModeEnabled: false,
					}),
				]);

				expect(selectedAgentState.selectedAgentId).toBe("codex");
				expect(autonomousModeState.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("跨浏览器 origin 共享的界面偏好：一条都没有时整个键不落盘", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-ui-prefs-absent-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-ui-prefs-absent-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await updateRuntimeConfig(tempProject, { selectedAgentId: "codex" });

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as Record<string, unknown>;
				expect(globalPayload.userInterfacePreferencesSharedAcrossBrowserOrigins).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("跨浏览器 origin 共享的界面偏好：落盘、重载、且不被后续无关更新抹掉", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-ui-prefs-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-ui-prefs-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const saved = await updateRuntimeConfig(tempProject, {
					userInterfacePreferencesSharedAcrossBrowserOrigins: {
						newTaskAutoReviewEnabled: true,
						workspaceOpenTargetPreferredApplicationId: "zed",
						projectNumericSlotGroupAssignmentsBySlotNumber: { "3": "alpha" },
					},
				});
				expect(saved.userInterfacePreferencesSharedAcrossBrowserOrigins.newTaskAutoReviewEnabled).toBe(true);
				// 这一组没传的字段必须仍是 null（尚未设定），而不是被填成某个默认值。
				expect(saved.userInterfacePreferencesSharedAcrossBrowserOrigins.newTaskAutoReviewMode).toBeNull();

				// 一次完全无关的更新不得顺手清掉这一组。
				await updateRuntimeConfig(tempProject, { selectedAgentId: "codex" });

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.userInterfacePreferencesSharedAcrossBrowserOrigins).toEqual({
					newTaskAutoReviewEnabled: true,
					newTaskAutoReviewMode: null,
					taskCreateDialogPrimaryStartAction: null,
					taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
					workspaceOpenTargetPreferredApplicationId: "zed",
					projectNumericSlotGroupAssignmentsBySlotNumber: { "3": "alpha" },
				});
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("updateGlobalRuntimeConfig 以磁盘为准，不会拿调用方的陈旧快照 revert 掉别处的写入", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-stale-snapshot-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-stale-snapshot-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				// 调用方在这一刻抓到快照，之后就一直拿着它——正是 runtime 缓存 activeRuntimeConfig 的处境。
				const staleSnapshot = await loadRuntimeConfig(tempProject);

				// 另一条路径（项目作用域）写了全局字段，缓存不会被刷新。
				await updateRuntimeConfig(tempProject, {
					userInterfacePreferencesSharedAcrossBrowserOrigins: {
						workspaceOpenTargetPreferredApplicationId: "zed",
					},
				});

				// 拿陈旧快照做一次无关的全局更新，那次写入必须原样保留。
				const updated = await updateGlobalRuntimeConfig(staleSnapshot, { notificationSoundEnabled: false });

				expect(updated.notificationSoundEnabled).toBe(false);
				expect(
					updated.userInterfacePreferencesSharedAcrossBrowserOrigins.workspaceOpenTargetPreferredApplicationId,
				).toBe("zed");

				const reloaded = await loadGlobalRuntimeConfig();
				expect(
					reloaded.userInterfacePreferencesSharedAcrossBrowserOrigins.workspaceOpenTargetPreferredApplicationId,
				).toBe("zed");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("跨浏览器 origin 共享的界面偏好：两个 origin 各基于同一份空快照迁移，字典条目一条都不丢", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-ui-prefs-migrate-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-ui-prefs-migrate-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				// 两个 origin 首次几乎同时打开升级后的界面：各自读到的服务端快照都是「一条都没有」，
				// 于是各自只带上自己 localStorage 里那半份编组。请求串行到达服务端。
				await updateRuntimeConfig(tempProject, {
					userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage: {
						projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "2": "beta" },
						taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: { '["global","claude"]': "opus" },
					},
				});
				const afterSecondOrigin = await updateRuntimeConfig(tempProject, {
					userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage: {
						projectNumericSlotGroupAssignmentsBySlotNumber: { "4": "delta" },
						taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: { '["global","codex"]': "gpt" },
					},
				});

				expect(
					afterSecondOrigin.userInterfacePreferencesSharedAcrossBrowserOrigins
						.projectNumericSlotGroupAssignmentsBySlotNumber,
				).toEqual({ "1": "alpha", "2": "beta", "4": "delta" });
				expect(
					afterSecondOrigin.userInterfacePreferencesSharedAcrossBrowserOrigins
						.taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey,
				).toEqual({ '["global","claude"]': "opus", '["global","codex"]': "gpt" });

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(
					reloaded.userInterfacePreferencesSharedAcrossBrowserOrigins
						.projectNumericSlotGroupAssignmentsBySlotNumber,
				).toEqual({ "1": "alpha", "2": "beta", "4": "delta" });

				// 对立性质：用户主动解除某个槽位绑定走的是整份替换，删除必须真的落下去，
				// 不能因为「迁移会补键」而变得删不掉。
				const afterUserClearedOneSlot = await updateRuntimeConfig(tempProject, {
					userInterfacePreferencesSharedAcrossBrowserOrigins: {
						projectNumericSlotGroupAssignmentsBySlotNumber: { "1": "alpha", "4": "delta" },
					},
				});
				expect(
					afterUserClearedOneSlot.userInterfacePreferencesSharedAcrossBrowserOrigins
						.projectNumericSlotGroupAssignmentsBySlotNumber,
				).toEqual({ "1": "alpha", "4": "delta" });

				const reloadedAfterClear = await loadRuntimeConfig(tempProject);
				expect(
					reloadedAfterClear.userInterfacePreferencesSharedAcrossBrowserOrigins
						.projectNumericSlotGroupAssignmentsBySlotNumber,
				).toEqual({ "1": "alpha", "4": "delta" });
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("跨浏览器 origin 共享的界面偏好：显式 null 把字段清回「服务端无值」", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-ui-prefs-clear-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-ui-prefs-clear-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await updateRuntimeConfig(tempProject, {
					userInterfacePreferencesSharedAcrossBrowserOrigins: {
						workspaceOpenTargetPreferredApplicationId: "zed",
					},
				});

				const cleared = await updateRuntimeConfig(tempProject, {
					userInterfacePreferencesSharedAcrossBrowserOrigins: {
						workspaceOpenTargetPreferredApplicationId: null,
					},
				});
				expect(
					cleared.userInterfacePreferencesSharedAcrossBrowserOrigins.workspaceOpenTargetPreferredApplicationId,
				).toBeNull();

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(
					reloaded.userInterfacePreferencesSharedAcrossBrowserOrigins.workspaceOpenTargetPreferredApplicationId,
				).toBeNull();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
