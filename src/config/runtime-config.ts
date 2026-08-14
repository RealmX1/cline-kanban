// Persists Kanban-owned runtime preferences on disk.
// This module should store Kanban settings such as selected agents,
// shortcuts, and prompt templates, not SDK-owned Cline secrets or OAuth data.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import {
	type RuntimeAgentId,
	type RuntimeAgentSessionTransport,
	type RuntimeProjectShortcut,
	runtimeAgentIdSchema,
	runtimeAgentSessionTransportSchema,
} from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { detectInstalledCommands } from "../terminal/agent-registry";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils";

interface RuntimeGlobalConfigFileShape {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	agentAutonomousModeEnabled?: boolean;
	newTaskStartInPlanModeByDefault?: boolean;
	ompAgentSessionTransportForNewTasks?: RuntimeAgentSessionTransport;
	readyForReviewNotificationsEnabled?: boolean;
	notificationSoundEnabled?: boolean;
	autoContinueOnConnectionDropEnabled?: boolean;
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled?: boolean;
	postDeployVerificationForceCompleteEnabled?: boolean;
	// Legacy 键（Post-Deploy Verification 全量重命名前叫 guidedVerificationForceCompleteEnabled）。
	// 仅用于读时兼容:旧 config.json 里若只有这个键,回退读它;下一次写入只落新键,旧键随原子覆盖自然消失。
	guidedVerificationForceCompleteEnabled?: boolean;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	newTaskStartInPlanModeByDefault: boolean;
	ompAgentSessionTransportForNewTasks: RuntimeAgentSessionTransport;
	readyForReviewNotificationsEnabled: boolean;
	notificationSoundEnabled: boolean;
	autoContinueOnConnectionDropEnabled: boolean;
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: boolean;
	postDeployVerificationForceCompleteEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	agentAutonomousModeEnabled?: boolean;
	newTaskStartInPlanModeByDefault?: boolean;
	ompAgentSessionTransportForNewTasks?: RuntimeAgentSessionTransport;
	readyForReviewNotificationsEnabled?: boolean;
	notificationSoundEnabled?: boolean;
	autoContinueOnConnectionDropEnabled?: boolean;
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled?: boolean;
	postDeployVerificationForceCompleteEnabled?: boolean;
	shortcuts?: RuntimeProjectShortcut[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_PARENT_DIR = ".cline";
const PROJECT_CONFIG_DIR = "kanban";
const PROJECT_CONFIG_FILENAME = "config.json";
const DEFAULT_AGENT_ID: RuntimeAgentId = "cline";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex", "cursor", "droid", "kiro"];
const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = true;
const DEFAULT_NEW_TASK_START_IN_PLAN_MODE_BY_DEFAULT = true;
// omp 新任务默认走 TUI（PTY）而不是 ACP：ACP 通道尚有一批未收口的缺口（历史纯内存、无 stall 兜底、
// mcpServers 恒空、provider 错误伪装成正常回答），TUI 与 Claude Code / Codex / Kimi 同构、可直接用。
// 这只是**新任务默认值**——建卡时固化到卡上，改它不追溯已有卡片（见 runtimeBoardCardSchema 的
// ompAgentSessionTransport）。活会话当刻在用哪条通道读 summary.sessionTransport，与本值无关。
const DEFAULT_OMP_AGENT_SESSION_TRANSPORT_FOR_NEW_TASKS: RuntimeAgentSessionTransport = "pty_terminal";
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_NOTIFICATION_SOUND_ENABLED = true;
const DEFAULT_AUTO_CONTINUE_ON_CONNECTION_DROP_ENABLED = true;
// 程序化投递撞上「人类输入框里有未提交内容」时的争用策略开关（计划里的 auto / never_preempt 两档）。
// true（默认，auto）：人**不在场**时先把那段未提交内容无损暂存进 Prompt Library 再放行投递；人在场时
// 仍只挂起可见、绝不动框。false（never_preempt）：任何情况下都只挂起，等人自己让路或预算耗尽诚实失败。
const DEFAULT_PROGRAMMATIC_DELIVERY_MAY_AUTO_STASH_ABSENT_HUMAN_INPUT_BOX_ENABLED = true;
// 部署后验证的「强制完成」是绕过安全确认的逃生阀，默认关闭；CLI 传 --force 且此开关开启才生效。
const DEFAULT_POST_DEPLOY_VERIFICATION_FORCE_COMPLETE_ENABLED = false;
const DEFAULT_COMMIT_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "kanban-pre-cherry-pick"
5. Cherry-pick the task commit into P. If this fails because .git/index.lock exists, wait briefly for any active git process to finish. If the lock remains and no git process is active, treat the lock as stale, remove it, and retry.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If step 4 created a new stash entry, restore that stash with: git -C P stash pop <stash-ref>
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;
const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current task worktree.

Steps:
1. Ensure all intended changes are committed in the current task worktree.
2. If currently on detached HEAD, create a branch at the current commit in this worktree.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		const catalogEntry = getRuntimeAgentCatalogEntry(agentId);
		const binary = catalogEntry?.binary ?? agentId;
		if (detected.has(binary) || detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

// 以 runtimeAgentIdSchema 为唯一真源做校验，而不是手写 OR 链——手写链在新增 agent 时
// 不会编译报错，漏改会让持久化的 agent 选择静默回落到 DEFAULT_AGENT_ID。
function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	const parsed = runtimeAgentIdSchema.safeParse(agentId);
	if (parsed.success && isRuntimeAgentLaunchSupported(parsed.data)) {
		return parsed.data;
	}
	return DEFAULT_AGENT_ID;
}

// 以 runtimeAgentSessionTransportSchema 为唯一真源做校验，与 normalizeAgentId 同理：
// 手写字面量比较在新增 transport 取值时不会编译报错，漏改会让持久化的选择静默回落。
function normalizeAgentSessionTransport(
	transport: RuntimeAgentSessionTransport | string | null | undefined,
	fallback: RuntimeAgentSessionTransport,
): RuntimeAgentSessionTransport {
	const parsed = runtimeAgentSessionTransportSchema.safeParse(transport);
	return parsed.success ? parsed.data : fallback;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
	if (!shortcut || typeof shortcut !== "object") {
		return null;
	}

	const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
	const command = typeof shortcut.command === "string" ? shortcut.command.trim() : "";
	const icon = typeof shortcut.icon === "string" ? shortcut.icon.trim() : "";

	if (!label || !command) {
		return null;
	}

	return {
		label,
		command,
		icon: icon || undefined,
	};
}

function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [];
	}
	const normalized: RuntimeProjectShortcut[] = [];
	for (const shortcut of shortcuts) {
		const parsed = normalizeShortcut(shortcut);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized;
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_PARENT_DIR, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRuntimeConfigPaths(cwd: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (cwd === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedHome = normalizePathForComparison(homedir());
	if (normalizedCwd === normalizedHome) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
	};
}

function getRuntimeConfigLockRequests(cwd: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(cwd);
	const requests: LockRequest[] = [
		{
			path: paths.globalConfigPath,
			type: "file",
		},
	];
	if (paths.projectConfigPath) {
		requests.push({
			path: paths.projectConfigPath,
			type: "file",
		});
	}
	return requests;
}

function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}): RuntimeConfigState {
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			globalConfig?.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		newTaskStartInPlanModeByDefault: normalizeBoolean(
			globalConfig?.newTaskStartInPlanModeByDefault,
			DEFAULT_NEW_TASK_START_IN_PLAN_MODE_BY_DEFAULT,
		),
		ompAgentSessionTransportForNewTasks: normalizeAgentSessionTransport(
			globalConfig?.ompAgentSessionTransportForNewTasks,
			DEFAULT_OMP_AGENT_SESSION_TRANSPORT_FOR_NEW_TASKS,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			globalConfig?.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		notificationSoundEnabled: normalizeBoolean(
			globalConfig?.notificationSoundEnabled,
			DEFAULT_NOTIFICATION_SOUND_ENABLED,
		),
		autoContinueOnConnectionDropEnabled: normalizeBoolean(
			globalConfig?.autoContinueOnConnectionDropEnabled,
			DEFAULT_AUTO_CONTINUE_ON_CONNECTION_DROP_ENABLED,
		),
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: normalizeBoolean(
			globalConfig?.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
			DEFAULT_PROGRAMMATIC_DELIVERY_MAY_AUTO_STASH_ABSENT_HUMAN_INPUT_BOX_ENABLED,
		),
		postDeployVerificationForceCompleteEnabled: normalizeBoolean(
			globalConfig?.postDeployVerificationForceCompleteEnabled ??
				globalConfig?.guidedVerificationForceCompleteEnabled,
			DEFAULT_POST_DEPLOY_VERIFICATION_FORCE_COMPLETE_ENABLED,
		),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		newTaskStartInPlanModeByDefault?: boolean;
		ompAgentSessionTransportForNewTasks?: RuntimeAgentSessionTransport;
		readyForReviewNotificationsEnabled?: boolean;
		notificationSoundEnabled?: boolean;
		autoContinueOnConnectionDropEnabled?: boolean;
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled?: boolean;
		postDeployVerificationForceCompleteEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(configPath);
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing, "selectedAgentId")
		? normalizeAgentId(existing?.selectedAgentId)
		: undefined;
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(existing, "selectedShortcutLabel")
		? normalizeShortcutLabel(existing?.selectedShortcutLabel)
		: undefined;
	const agentAutonomousModeEnabled =
		config.agentAutonomousModeEnabled === undefined
			? DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
			: normalizeBoolean(config.agentAutonomousModeEnabled, DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED);
	const newTaskStartInPlanModeByDefault =
		config.newTaskStartInPlanModeByDefault === undefined
			? DEFAULT_NEW_TASK_START_IN_PLAN_MODE_BY_DEFAULT
			: normalizeBoolean(config.newTaskStartInPlanModeByDefault, DEFAULT_NEW_TASK_START_IN_PLAN_MODE_BY_DEFAULT);
	const ompAgentSessionTransportForNewTasks =
		config.ompAgentSessionTransportForNewTasks === undefined
			? DEFAULT_OMP_AGENT_SESSION_TRANSPORT_FOR_NEW_TASKS
			: normalizeAgentSessionTransport(
					config.ompAgentSessionTransportForNewTasks,
					DEFAULT_OMP_AGENT_SESSION_TRANSPORT_FOR_NEW_TASKS,
				);
	const readyForReviewNotificationsEnabled =
		config.readyForReviewNotificationsEnabled === undefined
			? DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.readyForReviewNotificationsEnabled, DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED);
	const notificationSoundEnabled =
		config.notificationSoundEnabled === undefined
			? DEFAULT_NOTIFICATION_SOUND_ENABLED
			: normalizeBoolean(config.notificationSoundEnabled, DEFAULT_NOTIFICATION_SOUND_ENABLED);
	const autoContinueOnConnectionDropEnabled =
		config.autoContinueOnConnectionDropEnabled === undefined
			? DEFAULT_AUTO_CONTINUE_ON_CONNECTION_DROP_ENABLED
			: normalizeBoolean(
					config.autoContinueOnConnectionDropEnabled,
					DEFAULT_AUTO_CONTINUE_ON_CONNECTION_DROP_ENABLED,
				);
	const programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled =
		config.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled === undefined
			? DEFAULT_PROGRAMMATIC_DELIVERY_MAY_AUTO_STASH_ABSENT_HUMAN_INPUT_BOX_ENABLED
			: normalizeBoolean(
					config.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
					DEFAULT_PROGRAMMATIC_DELIVERY_MAY_AUTO_STASH_ABSENT_HUMAN_INPUT_BOX_ENABLED,
				);
	const postDeployVerificationForceCompleteEnabled =
		config.postDeployVerificationForceCompleteEnabled === undefined
			? DEFAULT_POST_DEPLOY_VERIFICATION_FORCE_COMPLETE_ENABLED
			: normalizeBoolean(
					config.postDeployVerificationForceCompleteEnabled,
					DEFAULT_POST_DEPLOY_VERIFICATION_FORCE_COMPLETE_ENABLED,
				);
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);

	const payload: RuntimeGlobalConfigFileShape = {};
	if (selectedAgentId !== undefined) {
		if (hasOwnKey(existing, "selectedAgentId") || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}
	if (
		hasOwnKey(existing, "agentAutonomousModeEnabled") ||
		agentAutonomousModeEnabled !== DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
	) {
		payload.agentAutonomousModeEnabled = agentAutonomousModeEnabled;
	}
	if (
		hasOwnKey(existing, "newTaskStartInPlanModeByDefault") ||
		newTaskStartInPlanModeByDefault !== DEFAULT_NEW_TASK_START_IN_PLAN_MODE_BY_DEFAULT
	) {
		payload.newTaskStartInPlanModeByDefault = newTaskStartInPlanModeByDefault;
	}
	if (
		hasOwnKey(existing, "ompAgentSessionTransportForNewTasks") ||
		ompAgentSessionTransportForNewTasks !== DEFAULT_OMP_AGENT_SESSION_TRANSPORT_FOR_NEW_TASKS
	) {
		payload.ompAgentSessionTransportForNewTasks = ompAgentSessionTransportForNewTasks;
	}
	if (
		hasOwnKey(existing, "readyForReviewNotificationsEnabled") ||
		readyForReviewNotificationsEnabled !== DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
	) {
		payload.readyForReviewNotificationsEnabled = readyForReviewNotificationsEnabled;
	}
	if (
		hasOwnKey(existing, "notificationSoundEnabled") ||
		notificationSoundEnabled !== DEFAULT_NOTIFICATION_SOUND_ENABLED
	) {
		payload.notificationSoundEnabled = notificationSoundEnabled;
	}
	if (
		hasOwnKey(existing, "autoContinueOnConnectionDropEnabled") ||
		autoContinueOnConnectionDropEnabled !== DEFAULT_AUTO_CONTINUE_ON_CONNECTION_DROP_ENABLED
	) {
		payload.autoContinueOnConnectionDropEnabled = autoContinueOnConnectionDropEnabled;
	}
	if (
		hasOwnKey(existing, "programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled") ||
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled !==
			DEFAULT_PROGRAMMATIC_DELIVERY_MAY_AUTO_STASH_ABSENT_HUMAN_INPUT_BOX_ENABLED
	) {
		payload.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled =
			programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled;
	}
	if (
		hasOwnKey(existing, "postDeployVerificationForceCompleteEnabled") ||
		postDeployVerificationForceCompleteEnabled !== DEFAULT_POST_DEPLOY_VERIFICATION_FORCE_COMPLETE_ENABLED
	) {
		payload.postDeployVerificationForceCompleteEnabled = postDeployVerificationForceCompleteEnabled;
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(
		configPath,
		{
			shortcuts: normalizedShortcuts,
		} satisfies RuntimeProjectConfigFileShape,
		{
			lock: null,
		},
	);
}

interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

async function readRuntimeConfigFiles(cwd: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}

async function loadRuntimeConfigLocked(cwd: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(configFiles.globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			configFiles.globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState(configFiles);
}

function createRuntimeConfigStateFromValues(input: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	newTaskStartInPlanModeByDefault: boolean;
	ompAgentSessionTransportForNewTasks: RuntimeAgentSessionTransport;
	readyForReviewNotificationsEnabled: boolean;
	notificationSoundEnabled: boolean;
	autoContinueOnConnectionDropEnabled: boolean;
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: boolean;
	postDeployVerificationForceCompleteEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
}): RuntimeConfigState {
	return {
		globalConfigPath: input.globalConfigPath,
		projectConfigPath: input.projectConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			input.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		newTaskStartInPlanModeByDefault: normalizeBoolean(
			input.newTaskStartInPlanModeByDefault,
			DEFAULT_NEW_TASK_START_IN_PLAN_MODE_BY_DEFAULT,
		),
		ompAgentSessionTransportForNewTasks: normalizeAgentSessionTransport(
			input.ompAgentSessionTransportForNewTasks,
			DEFAULT_OMP_AGENT_SESSION_TRANSPORT_FOR_NEW_TASKS,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			input.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		notificationSoundEnabled: normalizeBoolean(input.notificationSoundEnabled, DEFAULT_NOTIFICATION_SOUND_ENABLED),
		autoContinueOnConnectionDropEnabled: normalizeBoolean(
			input.autoContinueOnConnectionDropEnabled,
			DEFAULT_AUTO_CONTINUE_ON_CONNECTION_DROP_ENABLED,
		),
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: normalizeBoolean(
			input.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
			DEFAULT_PROGRAMMATIC_DELIVERY_MAY_AUTO_STASH_ABSENT_HUMAN_INPUT_BOX_ENABLED,
		),
		postDeployVerificationForceCompleteEnabled: normalizeBoolean(
			input.postDeployVerificationForceCompleteEnabled,
			DEFAULT_POST_DEPLOY_VERIFICATION_FORCE_COMPLETE_ENABLED,
		),
		shortcuts: normalizeShortcuts(input.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(input.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(input.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

export function toGlobalRuntimeConfigState(current: RuntimeConfigState): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: null,
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentAutonomousModeEnabled: current.agentAutonomousModeEnabled,
		newTaskStartInPlanModeByDefault: current.newTaskStartInPlanModeByDefault,
		ompAgentSessionTransportForNewTasks: current.ompAgentSessionTransportForNewTasks,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		notificationSoundEnabled: current.notificationSoundEnabled,
		autoContinueOnConnectionDropEnabled: current.autoContinueOnConnectionDropEnabled,
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
			current.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
		postDeployVerificationForceCompleteEnabled: current.postDeployVerificationForceCompleteEnabled,
		shortcuts: [],
		commitPromptTemplate: current.commitPromptTemplate,
		openPrPromptTemplate: current.openPrPromptTemplate,
	});
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(cwd),
		async () => await loadRuntimeConfigLocked(cwd),
	);
}

export async function loadGlobalRuntimeConfig(): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(null);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(null),
		async () => await loadRuntimeConfigLocked(null),
	);
}

export async function saveRuntimeConfig(
	cwd: string,
	config: {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		agentAutonomousModeEnabled: boolean;
		newTaskStartInPlanModeByDefault: boolean;
		ompAgentSessionTransportForNewTasks: RuntimeAgentSessionTransport;
		readyForReviewNotificationsEnabled: boolean;
		notificationSoundEnabled: boolean;
		autoContinueOnConnectionDropEnabled: boolean;
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: boolean;
		postDeployVerificationForceCompleteEnabled: boolean;
		shortcuts: RuntimeProjectShortcut[];
		commitPromptTemplate: string;
		openPrPromptTemplate: string;
	},
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			newTaskStartInPlanModeByDefault: config.newTaskStartInPlanModeByDefault,
			ompAgentSessionTransportForNewTasks: config.ompAgentSessionTransportForNewTasks,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			notificationSoundEnabled: config.notificationSoundEnabled,
			autoContinueOnConnectionDropEnabled: config.autoContinueOnConnectionDropEnabled,
			programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
				config.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
			postDeployVerificationForceCompleteEnabled: config.postDeployVerificationForceCompleteEnabled,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts: config.shortcuts });
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			newTaskStartInPlanModeByDefault: config.newTaskStartInPlanModeByDefault,
			ompAgentSessionTransportForNewTasks: config.ompAgentSessionTransportForNewTasks,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			notificationSoundEnabled: config.notificationSoundEnabled,
			autoContinueOnConnectionDropEnabled: config.autoContinueOnConnectionDropEnabled,
			programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
				config.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
			postDeployVerificationForceCompleteEnabled: config.postDeployVerificationForceCompleteEnabled,
			shortcuts: config.shortcuts,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
		});
	});
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const current = await loadRuntimeConfigLocked(cwd);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		const nextConfig = {
			selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
			selectedShortcutLabel:
				updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
			agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
			newTaskStartInPlanModeByDefault:
				updates.newTaskStartInPlanModeByDefault ?? current.newTaskStartInPlanModeByDefault,
			ompAgentSessionTransportForNewTasks:
				updates.ompAgentSessionTransportForNewTasks ?? current.ompAgentSessionTransportForNewTasks,
			readyForReviewNotificationsEnabled:
				updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
			notificationSoundEnabled: updates.notificationSoundEnabled ?? current.notificationSoundEnabled,
			autoContinueOnConnectionDropEnabled:
				updates.autoContinueOnConnectionDropEnabled ?? current.autoContinueOnConnectionDropEnabled,
			programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
				updates.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled ??
				current.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
			postDeployVerificationForceCompleteEnabled:
				updates.postDeployVerificationForceCompleteEnabled ?? current.postDeployVerificationForceCompleteEnabled,
			shortcuts: projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts,
			commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
			openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
		};

		const hasChanges =
			nextConfig.selectedAgentId !== current.selectedAgentId ||
			nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
			nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
			nextConfig.newTaskStartInPlanModeByDefault !== current.newTaskStartInPlanModeByDefault ||
			nextConfig.ompAgentSessionTransportForNewTasks !== current.ompAgentSessionTransportForNewTasks ||
			nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
			nextConfig.notificationSoundEnabled !== current.notificationSoundEnabled ||
			nextConfig.autoContinueOnConnectionDropEnabled !== current.autoContinueOnConnectionDropEnabled ||
			nextConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled !==
				current.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled ||
			nextConfig.postDeployVerificationForceCompleteEnabled !== current.postDeployVerificationForceCompleteEnabled ||
			nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
			nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate ||
			!areRuntimeProjectShortcutsEqual(nextConfig.shortcuts, current.shortcuts);

		if (!hasChanges) {
			return current;
		}

		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			newTaskStartInPlanModeByDefault: nextConfig.newTaskStartInPlanModeByDefault,
			ompAgentSessionTransportForNewTasks: nextConfig.ompAgentSessionTransportForNewTasks,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			notificationSoundEnabled: nextConfig.notificationSoundEnabled,
			autoContinueOnConnectionDropEnabled: nextConfig.autoContinueOnConnectionDropEnabled,
			programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
				nextConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
			postDeployVerificationForceCompleteEnabled: nextConfig.postDeployVerificationForceCompleteEnabled,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextConfig.shortcuts,
		});
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			newTaskStartInPlanModeByDefault: nextConfig.newTaskStartInPlanModeByDefault,
			ompAgentSessionTransportForNewTasks: nextConfig.ompAgentSessionTransportForNewTasks,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			notificationSoundEnabled: nextConfig.notificationSoundEnabled,
			autoContinueOnConnectionDropEnabled: nextConfig.autoContinueOnConnectionDropEnabled,
			programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
				nextConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
			postDeployVerificationForceCompleteEnabled: nextConfig.postDeployVerificationForceCompleteEnabled,
			shortcuts: nextConfig.shortcuts,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
		});
	});
}

export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(
		[
			{
				path: globalConfigPath,
				type: "file",
			},
		],
		async () => {
			const nextConfig = {
				selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
				selectedShortcutLabel:
					updates.selectedShortcutLabel === undefined
						? current.selectedShortcutLabel
						: updates.selectedShortcutLabel,
				agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
				newTaskStartInPlanModeByDefault:
					updates.newTaskStartInPlanModeByDefault ?? current.newTaskStartInPlanModeByDefault,
				ompAgentSessionTransportForNewTasks:
					updates.ompAgentSessionTransportForNewTasks ?? current.ompAgentSessionTransportForNewTasks,
				readyForReviewNotificationsEnabled:
					updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
				notificationSoundEnabled: updates.notificationSoundEnabled ?? current.notificationSoundEnabled,
				autoContinueOnConnectionDropEnabled:
					updates.autoContinueOnConnectionDropEnabled ?? current.autoContinueOnConnectionDropEnabled,
				programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
					updates.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled ??
					current.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
				postDeployVerificationForceCompleteEnabled:
					updates.postDeployVerificationForceCompleteEnabled ?? current.postDeployVerificationForceCompleteEnabled,
				shortcuts: current.shortcuts,
				commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
				openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
			};

			const hasChanges =
				nextConfig.selectedAgentId !== current.selectedAgentId ||
				nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
				nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
				nextConfig.newTaskStartInPlanModeByDefault !== current.newTaskStartInPlanModeByDefault ||
				nextConfig.ompAgentSessionTransportForNewTasks !== current.ompAgentSessionTransportForNewTasks ||
				nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
				nextConfig.notificationSoundEnabled !== current.notificationSoundEnabled ||
				nextConfig.autoContinueOnConnectionDropEnabled !== current.autoContinueOnConnectionDropEnabled ||
				nextConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled !==
					current.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled ||
				nextConfig.postDeployVerificationForceCompleteEnabled !==
					current.postDeployVerificationForceCompleteEnabled ||
				nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
				nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate;

			if (!hasChanges) {
				return current;
			}

			await writeRuntimeGlobalConfigFile(globalConfigPath, {
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				newTaskStartInPlanModeByDefault: nextConfig.newTaskStartInPlanModeByDefault,
				ompAgentSessionTransportForNewTasks: nextConfig.ompAgentSessionTransportForNewTasks,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				notificationSoundEnabled: nextConfig.notificationSoundEnabled,
				autoContinueOnConnectionDropEnabled: nextConfig.autoContinueOnConnectionDropEnabled,
				programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
					nextConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
				postDeployVerificationForceCompleteEnabled: nextConfig.postDeployVerificationForceCompleteEnabled,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			});

			return createRuntimeConfigStateFromValues({
				globalConfigPath,
				projectConfigPath: current.projectConfigPath,
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				newTaskStartInPlanModeByDefault: nextConfig.newTaskStartInPlanModeByDefault,
				ompAgentSessionTransportForNewTasks: nextConfig.ompAgentSessionTransportForNewTasks,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				notificationSoundEnabled: nextConfig.notificationSoundEnabled,
				autoContinueOnConnectionDropEnabled: nextConfig.autoContinueOnConnectionDropEnabled,
				programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled:
					nextConfig.programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled,
				postDeployVerificationForceCompleteEnabled: nextConfig.postDeployVerificationForceCompleteEnabled,
				shortcuts: nextConfig.shortcuts,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			});
		},
	);
}
