import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isKanbanCursorAgentModelId } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTerminalAgentModelOverrideSettings,
} from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { resolveOmpApprovalModeFlagValue } from "../core/omp-approval-mode-flag";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../core/session-activity";
import { quoteShellArg } from "../core/shell";
import { resolveTaskAgentPermissionModeForAgent } from "../core/task-agent-permission-mode";
import { logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	combineAppendSystemPrompts,
	resolveHomeAgentAppendSystemPrompt,
	resolveTaskSessionAppendSystemPrompt,
} from "../prompts/append-system-prompt";
import { getRuntimeHomePath } from "../state/workspace-state";
import { hasClaudeInteractivePrompt, hasClaudeStartupUiRendered } from "./claude-readiness";
import { configureCodexHooks, hasCodexConfigOverride } from "./codex-hook-config";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import { seedKanbanManagedKimiCodeHome } from "./kimi-hook-config";
import { hasKimiInteractivePrompt } from "./kimi-readiness";
import { detectOmpTerminalTitleStateTransition } from "./omp-terminal-title-state";
import { writeOmpTuiLaunchConfigOverlay } from "./omp-tui-launch-config";
import {
	getOpenCodeAuthPathCandidates,
	getOpenCodeConfigPathCandidates,
	getOpenCodeModelStatePathCandidates,
} from "./opencode-paths";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";
import { resolveCursorLaunchDefaultModelId } from "./terminal-agent-model-selection";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	// 每任务的放权档位。与 startInPlanMode **正交**：plan 起步只决定开局模式，不得在这里
	// 被翻译成「降权」——不能同时表达两者的 harness（droid）是显式例外，见
	// doesPlanModeStartOverridePermissionModeForAgent。
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	// 「续跑既有对话、不重投 prompt」，但**不**带垃圾桶语义（不清聊天、不按转录反查模型）。
	// 目前唯一的来源是通道切换后重开会话（omp 的 TUI ⇄ ACP）。语义上与 resumeFromTrash 的续跑
	// 部分一致，故 adapter 里两者一律并为同一条分支处理；只有 omp 需要认它——别的 agent 不可切换，
	// 到不了这条路径（可切换 agent 集合见 core/agent-session-transport-selection.ts）。
	resumePriorAgentConversationWithoutResendingPrompt?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	parentSessionId?: string;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	readOnlyQuestionSession?: boolean;
	forkLatestWorkingDirectorySession?: boolean;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	deferredStartupInput?: string;
	// 本次启动是否会接续 / 重播一段既有的 agent 对话（`--continue` / `--resume <id>` / `--fork-session`
	// 等已被拼进 args）。session-manager 用它武装 resume substantive guard：重播出来的旧 transcript
	// 不是「agent 刚刚响应」，不得推进 lastSubstantiveOutputAt（卡片左上角的「agent 上次响应」读它）。
	// 必须由**决定是否加 resume 旗标的那段代码**如实置位——它是唯一知道真相的地方；用「该任务此前是否
	// 产出过」等外部状态反推会误判崩溃后从原始 prompt 全新重跑的 auto-restart（那种启动毫无重播）。
	// 只在 resumeFromTrash 时续跑的 adapter 可以不设本字段：那条触发器对全部 adapter 一致，
	// session-manager 已在武装点统一 OR 进去。本字段专门覆盖 resumeFromTrash 之外的续跑路径
	// （taskAgentSessionInitialization 的 --resume <id>、forkLatestWorkingDirectorySession 的 fork）。
	resumesPriorAgentConversation?: boolean;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function escapeForTemplateLiteral(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}

function powerShellQuote(value: string): string {
	return `"${value.replaceAll("`", "``").replaceAll('"', '`"')}"`;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

function buildHooksCommand(args: string[]): string {
	return buildHooksCommandParts(args).map(quoteShellArg).join(" ");
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

function removeCliOptionsWithValues(args: string[], optionNames: readonly string[]): string[] {
	const optionNameSet = new Set(optionNames);
	const nextArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (optionNameSet.has(arg)) {
			index += 1;
			continue;
		}
		if (optionNames.some((optionName) => arg.startsWith(`${optionName}=`))) {
			continue;
		}
		nextArgs.push(arg);
	}
	return nextArgs;
}

function setModelCliOption(args: string[], modelId: string): string[] {
	const trimmedModelId = modelId.trim();
	if (!trimmedModelId) {
		return [...args];
	}
	return [...removeCliOptionsWithValues(args, ["--model", "-m"]), "--model", trimmedModelId];
}

function resolveTerminalAgentModelOverride(
	input: AgentAdapterLaunchInput,
	agentId: RuntimeTaskTerminalAgentModelOverrideSettings["agentId"],
): string | null {
	if (input.terminalAgentModelOverrideSettings?.agentId !== agentId) {
		return null;
	}
	const modelId = input.terminalAgentModelOverrideSettings.modelId.trim();
	if (agentId === "cursor" && !isKanbanCursorAgentModelId(modelId)) {
		return null;
	}
	return modelId || null;
}

function hasCodexWorkingDirectoryOverride(args: string[]): boolean {
	return args.includes("-C") || hasCliOption(args, "--cd");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeParentSessionId(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (!UUID_PATTERN.test(trimmed)) {
		process.stderr.write(
			`kanban: parent_session_id "${trimmed}" is not a UUID; codex fork expects a session UUID. Ignoring.\n`,
		);
		return null;
	}
	return trimmed;
}

function warnUnsupportedParentSessionId(agentId: RuntimeAgentId, parentSessionId: string | undefined): void {
	if (!parentSessionId || !parentSessionId.trim()) {
		return;
	}
	process.stderr.write(
		`kanban: agent "${agentId}" does not support parent_session_id; ignoring "${parentSessionId.trim()}".\n`,
	);
}

function getClineHookScriptPath(
	hooksDir: string,
	hookName: "Notification" | "TaskComplete" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse",
): string {
	if (process.platform === "win32") {
		return join(hooksDir, `${hookName}.ps1`);
	}
	return join(hooksDir, hookName);
}

function buildClineHookScriptContent(event: RuntimeHookEvent): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", event, "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
try {
  $inputText | & ${command} | Out-Null
} catch {
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
echo '{"cancel":false}'
`;
}

function buildClineNotificationHookScriptContent(): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
if (
  $inputText -match '"event"\\s*:\\s*"user_attention"' -and
  $inputText -notmatch '"source"\\s*:\\s*"completion_result"'
) {
  try {
    $inputText | & ${command} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
if printf '%s' "$INPUT" | grep -Eq '"event"[[:space:]]*:[[:space:]]*"user_attention"' &&
  ! printf '%s' "$INPUT" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"completion_result"'; then
  printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePreToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const reviewCommand = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const review = reviewCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${review} | Out-Null
  } catch {
  }
} else {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const review = reviewCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${review} >/dev/null 2>&1 || true
else
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePostToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildOpenCodePluginContent(
	reviewCommand: string,
	toInProgressCommand: string,
	activityCommand: string,
): string {
	const reviewCmd = escapeForTemplateLiteral(reviewCommand);
	const toInProgressCmd = escapeForTemplateLiteral(toInProgressCommand);
	const activityCmd = escapeForTemplateLiteral(activityCommand);
	return `export const KanbanPlugin = async ({ $, client }) => {
  if (globalThis.__kanbanOpencodePluginV3) return {};
  globalThis.__kanbanOpencodePluginV3 = true;

  if (!process?.env?.KANBAN_HOOK_TASK_ID) return {};

  let currentState = "idle";
  let rootSessionID = null;
  const childSessionCache = new Map();
  const messageRoleByID = new Map();
  const assistantTextByMessageID = new Map();
  const latestAssistantBySessionID = new Map();
  const toolInputByCallID = new Map();

  const asRecord = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value;
  };

  const getMessageKey = (sessionID, messageID) => String(sessionID) + ":" + String(messageID);
  const getToolCallKey = (sessionID, callID) => String(sessionID) + ":" + String(callID);

  const encodePayload = (payload) => {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    try {
      return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    } catch {
      return "";
    }
  };

	const notify = async (kind, payload) => {
		try {
			const encoded = encodePayload(payload);
			if (kind === "review") {
				if (encoded) {
					await $\`${reviewCmd} --metadata-base64 \${encoded}\`;
				} else {
					await $\`${reviewCmd}\`;
				}
				return;
			}
			if (kind === "in_progress") {
				if (encoded) {
					await $\`${toInProgressCmd} --metadata-base64 \${encoded}\`;
				} else {
					await $\`${toInProgressCmd}\`;
				}
				return;
			}
			if (encoded) {
				await $\`${activityCmd} --metadata-base64 \${encoded}\`;
			} else {
				await $\`${activityCmd}\`;
			}
		} catch {
			// Best effort: hook errors should never break OpenCode event handling.
		}
	};

  const notifyReview = async (sessionID, payload = {}) => {
    const mergedPayload = {
      ...payload,
      last_assistant_message:
        typeof payload.last_assistant_message === "string"
          ? payload.last_assistant_message
          : (latestAssistantBySessionID.get(sessionID) ?? undefined),
    };
		await notify("review", mergedPayload);
  };

  const notifyInProgress = async (payload = {}) => {
		await notify("in_progress", payload);
  };

  const notifyActivity = async (payload = {}) => {
		await notify("activity", payload);
  };

  const isChildSession = async (sessionID) => {
    if (!sessionID) return true;
    if (!client?.session?.list) return true;
    if (childSessionCache.has(sessionID)) {
      return childSessionCache.get(sessionID);
    }
    try {
      const sessions = await client.session.list();
      const session = sessions.data?.find((candidate) => candidate.id === sessionID);
      const isChild = !!session?.parentID;
      childSessionCache.set(sessionID, isChild);
      return isChild;
    } catch {
      return true;
    }
  };

  const handleBusy = async (sessionID) => {
    if (!sessionID) {
      return;
    }
    if (!rootSessionID) {
      rootSessionID = sessionID;
    }
    if (sessionID !== rootSessionID) {
      return;
    }
    if (currentState === "idle") {
      currentState = "busy";
      await notifyInProgress({
        hook_event_name: "session.status",
      });
    }
  };

  const handleReview = async (sessionID, payload = {}, force = false) => {
    if (!sessionID) {
      return;
    }
    if (!rootSessionID) {
      rootSessionID = sessionID;
    }
    if (rootSessionID && sessionID !== rootSessionID) {
      return;
    }

    const shouldNotify = force || currentState === "busy";
    if (shouldNotify) {
      currentState = "idle";
      await notifyReview(sessionID, payload);
      rootSessionID = null;
    }
  };

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = asRecord(event.properties?.info);
        const sessionID = typeof info?.sessionID === "string" ? info.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }

        const messageID = typeof info?.id === "string" ? info.id : null;
        const role = typeof info?.role === "string" ? info.role : null;
        if (messageID && role) {
          messageRoleByID.set(getMessageKey(sessionID, messageID), role);
          if (role === "assistant" && !assistantTextByMessageID.has(getMessageKey(sessionID, messageID))) {
            assistantTextByMessageID.set(getMessageKey(sessionID, messageID), "");
          }
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = asRecord(event.properties?.part);
        if (!part) {
          return;
        }

        const sessionID = typeof part.sessionID === "string" ? part.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }

        if (part.type !== "text") {
          return;
        }

        const messageID = typeof part.messageID === "string" ? part.messageID : null;
        if (!messageID) {
          return;
        }

        const messageKey = getMessageKey(sessionID, messageID);
        if (messageRoleByID.get(messageKey) !== "assistant") {
          return;
        }

        const delta = typeof event.properties?.delta === "string" ? event.properties.delta : "";
        const fullText = typeof part.text === "string" ? part.text : "";
        const previousText = assistantTextByMessageID.get(messageKey) ?? "";
        const nextText = delta ? previousText + delta : (fullText || previousText);
        const normalized = nextText.trim();
        if (!normalized) {
          return;
        }

        assistantTextByMessageID.set(messageKey, normalized);
        latestAssistantBySessionID.set(sessionID, normalized);
        return;
      }

      const sessionID = event.properties?.sessionID;
      if (await isChildSession(sessionID)) {
        return;
      }

      if (event.type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "busy") {
          await handleBusy(sessionID);
        } else if (status?.type === "idle") {
          await handleReview(sessionID, {
            hook_event_name: "session.status",
          });
        }
      }

      if (event.type === "session.busy") {
        await handleBusy(sessionID);
      }
      if (event.type === "session.idle") {
        await handleReview(sessionID, {
          hook_event_name: "session.idle",
        });
      }
      if (event.type === "session.error") {
        await handleReview(
          sessionID,
          {
            hook_event_name: "session.error",
          },
          true,
        );
      }
    },
    "tool.execute.before": async (input, output) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
      if (await isChildSession(sessionID)) {
        return;
      }

      await handleBusy(sessionID);

      const toolName = typeof input?.tool === "string" ? input.tool : undefined;
      const callID = typeof input?.callID === "string" ? input.callID : "";
      const toolInput = asRecord(output?.args);
      if (callID) {
        toolInputByCallID.set(getToolCallKey(sessionID, callID), toolInput);
      }

      await notifyActivity({
        hook_event_name: "BeforeTool",
        tool_name: toolName,
        tool_input: toolInput ?? undefined,
      });
    },
    "tool.execute.after": async (input) => {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : null;
      if (await isChildSession(sessionID)) {
        return;
      }

      const toolName = typeof input?.tool === "string" ? input.tool : undefined;
      const callID = typeof input?.callID === "string" ? input.callID : "";
      const toolInput = callID ? toolInputByCallID.get(getToolCallKey(sessionID, callID)) : null;
      if (callID) {
        toolInputByCallID.delete(getToolCallKey(sessionID, callID));
      }

      await notifyActivity({
        hook_event_name: "AfterTool",
        tool_name: toolName,
        tool_input: toolInput ?? undefined,
      });
    },
    "permission.ask": async (_permission, output) => {
      if (output?.status === "ask") {
        const sessionID = typeof _permission?.sessionID === "string" ? _permission.sessionID : null;
        if (await isChildSession(sessionID)) {
          return;
        }
        await handleReview(
          sessionID,
          {
            hook_event_name: "PermissionRequest",
            notification_type: "permission.asked",
          },
          true,
        );
      }
    },
  };
};
`;
}

function resolveTaskAgentSessionInitialization(
	input: AgentAdapterLaunchInput,
): RuntimeTaskAgentSessionInitialization | null {
	const explicitInitialization = input.taskAgentSessionInitialization;
	if (explicitInitialization) {
		if (explicitInitialization.sourceAgentId !== input.agentId) {
			throw new Error(
				`Task session initialization agent "${explicitInitialization.sourceAgentId}" does not match selected agent "${input.agentId}".`,
			);
		}
		if (
			explicitInitialization.sourceAgentId === "cursor" &&
			explicitInitialization.sourceSessionReuseMode === "fork_existing_session"
		) {
			throw new Error("Cursor Agent does not support forking existing sessions.");
		}
		return explicitInitialization;
	}
	const legacyParentSessionId = normalizeParentSessionId(input.parentSessionId);
	return input.agentId === "codex" && legacyParentSessionId
		? {
				sourceAgentId: "codex",
				sourceSessionId: legacyParentSessionId,
				sourceSessionReuseMode: "fork_existing_session",
			}
		: null;
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

const KIRO_KANBAN_AGENT_NAME = "kanban";

function getKiroAgentConfigPath(): string {
	return join(homedir(), ".kiro", "agents", `${KIRO_KANBAN_AGENT_NAME}.json`);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

// Wraps a command in bracketed-paste framing so a TUI agent (Claude Code, Codex)
// treats it as a single pasted submission terminated by Enter. Exported so the
// output-reactions framework can inject continuation prompts through the same
// mechanism used for deferred startup input.
export function toBracketedPasteSubmission(command: string): string {
	return `\u001b[200~${command}\u001b[201~\r`;
}

function resolveAgentAppendSystemPrompt(input: AgentAdapterLaunchInput): string | null {
	return combineAppendSystemPrompts(
		resolveHomeAgentAppendSystemPrompt(input.taskId),
		resolveTaskSessionAppendSystemPrompt(input.taskId, input.cwd),
	);
}

function prependTaskSessionGuidanceToPrompt(input: AgentAdapterLaunchInput): string {
	const prompt = input.prompt.trim();
	const taskSessionPrompt = resolveTaskSessionAppendSystemPrompt(input.taskId, input.cwd);
	if (!prompt || !taskSessionPrompt) {
		return input.prompt;
	}
	return `${taskSessionPrompt}\n\n# Task\n${input.prompt}`;
}

// 解析本次启动实际生效的放权档位：不能原生表达中间档的 harness 在此保守降级到「每次询问」。
function resolveLaunchPermissionMode(input: AgentAdapterLaunchInput): RuntimeTaskAgentPermissionMode {
	return resolveTaskAgentPermissionModeForAgent(input.agentId, input.taskAgentPermissionMode).effectivePermissionMode;
}

// Claude Code 的「plan 起步」与「放权档位」都落在 --permission-mode 这一个旗标上，所以必须
// 在一处统一决策，否则两个分支各推一次会产生重复且互相打架的 --permission-mode。
// 正交语义靠 --allow-dangerously-skip-permissions 达成：它不是「现在就放行」，而是「预授权本会话
// 后续可以切到 bypass」——于是 plan 起步的会话仍保有用户选定的 bypass 档。
// 注意：只有 readOnly / plan 这两个「开局必须只读」的分支才剔除已存在的放行旗标；其余情况下
// 调用方（快捷方式等）显式传入的旗标一律原样保留。
function stripClaudeImmediateBypassAndPermissionModeArgs(args: string[]): void {
	const stripped = removeCliOptionsWithValues(
		args.filter((arg) => arg !== "--dangerously-skip-permissions"),
		["--permission-mode"],
	);
	args.length = 0;
	args.push(...stripped);
}

function applyClaudePermissionAndPlanModeArgs(args: string[], input: AgentAdapterLaunchInput): void {
	const permissionMode = resolveLaunchPermissionMode(input);

	// 只读提问会话是最强约束，压过其余一切。
	if (input.readOnlyQuestionSession) {
		stripClaudeImmediateBypassAndPermissionModeArgs(args);
		args.push("--permission-mode", "plan", "--tools", "Read,Glob,Grep,WebSearch,WebFetch");
		return;
	}

	if (input.startInPlanMode) {
		stripClaudeImmediateBypassAndPermissionModeArgs(args);
		if (
			permissionMode === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--allow-dangerously-skip-permissions")
		) {
			args.push("--allow-dangerously-skip-permissions");
		}
		args.push("--permission-mode", "plan");
		return;
	}

	if (permissionMode === "bypass_all_permission_prompts") {
		if (!hasCliOption(args, "--dangerously-skip-permissions")) {
			args.push("--dangerously-skip-permissions");
		}
		return;
	}
	if (permissionMode === "auto_approve_file_edits_only" && !hasCliOption(args, "--permission-mode")) {
		args.push("--permission-mode", "acceptEdits");
	}
	// ask_for_every_tool_use：不加任何旗标，走 Claude Code 自身的逐次询问默认。
}

// Kanban 侧的 Claude Code 渲染模式逃生阀。取值 "inline" 时退回旧的 main-screen 渲染，
// 其余取值（含未设置）一律走 Kanban 默认的 fullscreen。
//
// 为什么另起一个 Kanban 命名空间的变量、而不是直接尊重继承来的 CLAUDE_CODE_* ：那些变量是
// **Claude Code 注入给自己子进程的**，无法区分「用户表态」与「Kanban 恰好被一个 Claude Code
// 会话启动」。若把继承值当表态，从 Claude Code 终端里起的 Kanban 会让全部 task agent 静默退回
// inline，而用户从未做过这个选择。
export const KANBAN_CLAUDE_CODE_TERMINAL_RENDERING_MODE_ENV_VAR = "KANBAN_CLAUDE_CODE_TERMINAL_RENDERING_MODE";

// Claude Code 的 TUI 渲染模式（它自己 `/tui` 的两档：`fullscreen` / `default`）。Kanban 默认选
// fullscreen——即 alt-screen 上的无闪烁渲染器，与 Codex 等其余 alt-screen agent 形态一致。
//
// 历史：2026-05-08「修复 Claude Code 交互式任务启动」曾写死 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
// 把 Claude 摁成 inline，当时是为了让 deferred startup input 的就绪判定能在 normal buffer 的
// 输出里看到提示符。该前提已经不成立：就绪与人机争用让路都改走 terminal-input-box-reader 的
// 结构判定，而它读的是 TerminalStateMirror.getScreenSnapshot() → `buffer.active`，alt-screen 下
// 读的正是 Claude 重绘的那块备用屏。真机实测（v2.1.228，cols=100）：fullscreen 下输入框画法不变
// （两条 U+2500 边界线夹 `❯`），只是从屏顶移到屏底，readTerminalInputBox 照常命中。
//
// 代价是已知且与 Codex 同构的：alt-screen agent 的会话历史留在备用屏内、normal buffer 不增长，
// 因此「阅读 scrollback transcript」入口对 Claude 会话不再出现（见 terminal-scrollback-transcript-extraction）。
//
// 为什么用 CLAUDE_CODE_NO_FLICKER 而不是写用户 settings.json 的 `tui` 键：env 在 Claude 的判定
// 顺序里压过用户设置，才能保证「Kanban 起的会话默认 fullscreen」不被宿主机的 `/tui default` 偏好
// 推翻；而写用户 settings 则会污染用户在 Kanban 之外的 Claude 会话。
//
// 两档都**成对**写出：另一档显式置 undefined 以抹掉继承值（buildTerminalEnvironment 会据此删键）。
// 缺了这一步，从 Claude Code 会话里起的 Kanban 会把继承来的 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
// 一路传下去——它在 Claude 的判定顺序里排在 NO_FLICKER 之前，会把 fullscreen 直接否决掉。
function resolveClaudeCodeTerminalRenderingModeEnv(): Record<string, string | undefined> {
	const requestedMode = process.env[KANBAN_CLAUDE_CODE_TERMINAL_RENDERING_MODE_ENV_VAR]?.trim().toLowerCase();
	if (requestedMode === "inline") {
		return { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_NO_FLICKER: undefined };
	}
	return { CLAUDE_CODE_NO_FLICKER: "1", CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: undefined };
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const taskAgentSessionInitialization = resolveTaskAgentSessionInitialization(input);
		const explicitModelId = resolveTerminalAgentModelOverride(input, "claude");
		const args = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {
			...resolveClaudeCodeTerminalRenderingModeEnv(),
			FORCE_HYPERLINK: "1",
		};
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);
		applyClaudePermissionAndPlanModeArgs(args, input);
		// 三条互斥的续跑分支任一命中 ⇒ 本次启动会重播既有对话（见 PreparedAgentLaunch 同名字段）。
		const resumesPriorAgentConversation = Boolean(
			input.resumeFromTrash || taskAgentSessionInitialization || input.forkLatestWorkingDirectorySession,
		);
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		} else if (taskAgentSessionInitialization && !hasCliOption(args, "--resume")) {
			args.push("--resume", taskAgentSessionInitialization.sourceSessionId);
			if (
				taskAgentSessionInitialization.sourceSessionReuseMode === "fork_existing_session" &&
				!hasCliOption(args, "--fork-session")
			) {
				args.push("--fork-session");
			}
		} else if (input.forkLatestWorkingDirectorySession) {
			if (!hasCliOption(args, "--continue")) {
				args.push("--continue");
			}
			if (!hasCliOption(args, "--fork-session")) {
				args.push("--fork-session");
			}
		}
		// Claude Code 的 `--continue`（「Refresh terminal session」/恢复任务时用）会用会话最后一条
		// 已记录回合的「裸」model id `claude-opus-4-8` 重建模型——这丢掉了 1M context 选择，静默回退到
		// 200k 变体（实测：即便会话本来跑在 1M，`--continue` 也会掉到 200k；而尚未产出回合的会话因为
		// 「无可重建」反而留在默认 1M，于是表现为「时好时坏」）。显式传 `--model default`（一个随版本
		// 自动跟进的别名，当前解析为 1M 的 `claude-opus-4-8[1m]`，换代后自动指向新默认）可让每次启动
		// （全新与恢复）都落到看板预期的默认模型，并覆盖上述重建。仅在未显式指定 model 时注入，故按任务
		// 指定的具体模型仍然优先。注意：只有 `--model` 这个「旗标」能解析 `default` 别名并压过 `--continue`
		// 的重建；`ANTHROPIC_MODEL=default` 环境变量会被当成名为 "default" 的自定义模型（实测失效）。
		if (!explicitModelId && !hasCliOption(args, "--model")) {
			args.push("--model", "default");
		}
		const hooks = resolveHookContext(input);
		if (hooks) {
			const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");
			const hooksSettings = {
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					PreToolUse: [
						{
							// Stage 5：Claude 原生「计划待批 / 澄清提问」经它自己的工具触发（ExitPlanMode /
							// AskUserQuestion）。PreToolUse 在工具执行前触发——此刻用户需先批/答 → 映射为
							// to_review；具体人轴（plan_review / question）由 ingest 端 classifyHookUserTurnKind
							// 读 metadata.toolName 区分。须排在下方 *→activity 之前（专用 matcher 优先）。镜像
							// Notification 的 permission_prompt+* 双 matcher：保留 *→activity 继续喂活动 feed，
							// 两者对同一工具双触发幂等（activity 不转换、仅 applyHookActivity，metadata-only 漏斗
							// 分支 preserve userTurnKind，不冲掉已采集的人轴）。
							matcher: "ExitPlanMode|AskUserQuestion",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
			};
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const trimmed = input.prompt.trim();
		if (!input.resumeFromTrash && trimmed) {
			args.push(trimmed);
		}
		return {
			args,
			env: {
				...env,
			},
			resumesPriorAgentConversation,
			detectOutputTransition: claudePromptDetector,
			shouldInspectOutputForTransition: shouldInspectClaudeOutputForTransition,
		};
	},
};

function claudePromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	// 旧门控 `state==="awaiting_review"` → facet 真相源（行为保持，见 isAwaitingUserReviewTurn 注释）。
	if (!isAwaitingUserReviewTurn(resolveSessionFacets(summary))) {
		return null;
	}
	// 仅在 reviewReason === "attention" 时根据 TUI 输出回到 running。
	// reviewReason === "hook" 表示 Claude 在 Stop / Notification hook 后等待用户审查，
	// 而 Claude 的 TUI 输入框 / 启动横幅会随着每一次重绘出现 — 如果在 "hook" 下也接受
	// prompt-ready，那么 hook 触发后下一帧 TUI 重绘就会立刻把状态翻回 running，
	// "等待审查" 的语义就丢失了。"hook" -> running 应由 UserPromptSubmit hook 走
	// `hook.to_in_progress` 路径触发，而不是靠终端输出探测。
	if (summary.reviewReason !== "attention") {
		return null;
	}
	if (hasClaudeInteractivePrompt(data) || hasClaudeStartupUiRendered(data)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectClaudeOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	// 与 claudePromptDetector 保持一致：仅在 reviewReason === "attention" 时才需要解码
	// 输出来探测 prompt-ready 转移。
	return isAwaitingUserReviewTurn(resolveSessionFacets(summary)) && summary.reviewReason === "attention";
}

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	// 旧门控 `state==="awaiting_review"` → facet 真相源（行为保持，见 isAwaitingUserReviewTurn 注释）。
	if (!isAwaitingUserReviewTurn(resolveSessionFacets(summary))) {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		isAwaitingUserReviewTurn(resolveSessionFacets(summary)) &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const taskAgentSessionInitialization = resolveTaskAgentSessionInitialization(input);
		const explicitModelId = resolveTerminalAgentModelOverride(input, "codex");
		const codexArgs = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		let deferredStartupInput: string | undefined;
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		// codex 的放权是 sandbox × approval 两个正交旗标，但它表达不出「改文件放行、执行命令仍询问」
		// 这一中间档（理由见 task-agent-permission-mode.ts 里 codex 那段注释），所以中间档已在领域层
		// 保守降级成「每次询问」，这里只剩两档要落地。
		// 「每次询问」必须显式推 --ask-for-approval untrusted：codex 的默认审批策略来自用户自己的
		// config.toml，什么都不推等于把档位交给用户全局配置决定——那会静默放宽用户在本任务上选的档。
		// 与 startInPlanMode 无关——codex 的 plan 起步走 deferred `/plan` 斜杠命令，不占用这两个旗标。
		const codexPermissionMode = resolveLaunchPermissionMode(input);
		const hasExplicitCodexApprovalPolicy =
			hasCliOption(codexArgs, "--ask-for-approval") || hasCliOption(codexArgs, "-a");
		if (
			codexPermissionMode === "bypass_all_permission_prompts" &&
			!hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")
		) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		} else if (
			codexPermissionMode === "ask_for_every_tool_use" &&
			!hasExplicitCodexApprovalPolicy &&
			!hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")
		) {
			codexArgs.push("--ask-for-approval", "untrusted");
		}
		const parentSessionId = normalizeParentSessionId(input.parentSessionId);
		if (input.readOnlyQuestionSession) {
			const withoutBypass = codexArgs.filter((arg) => arg !== "--dangerously-bypass-approvals-and-sandbox");
			codexArgs.length = 0;
			codexArgs.push(...removeCliOptionsWithValues(withoutBypass, ["--sandbox", "-s", "--ask-for-approval", "-a"]));
			codexArgs.push("--sandbox", "read-only", "--ask-for-approval", "never");
		}
		if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		} else if (taskAgentSessionInitialization) {
			if (!hasCodexWorkingDirectoryOverride(codexArgs)) {
				codexArgs.push("-C", input.cwd);
			}
			const sessionSubcommand =
				taskAgentSessionInitialization.sourceSessionReuseMode === "fork_existing_session" ? "fork" : "resume";
			if (!codexArgs.includes(sessionSubcommand)) {
				codexArgs.push(sessionSubcommand, taskAgentSessionInitialization.sourceSessionId);
			}
		} else if (parentSessionId || input.forkLatestWorkingDirectorySession) {
			if (!hasCodexWorkingDirectoryOverride(codexArgs)) {
				codexArgs.push("-C", input.cwd);
			}
			if (!codexArgs.includes("fork")) {
				codexArgs.push("fork");
				if (parentSessionId) {
					codexArgs.push(parentSessionId);
				} else {
					codexArgs.push("--last");
				}
			}
		}

		if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			configureCodexHooks(codexArgs);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const trimmed = input.prompt.trim();
		if (input.startInPlanMode) {
			const planCommand = trimmed ? `/plan ${trimmed}` : "/plan";
			deferredStartupInput = toBracketedPasteSubmission(planCommand);
		} else if (trimmed) {
			codexArgs.push(trimmed);
		}
		const resumesSession =
			Boolean(input.resumeFromTrash) ||
			(!input.resumeFromTrash &&
				taskAgentSessionInitialization?.sourceSessionReuseMode === "resume_existing_session");
		const forksSession =
			!input.resumeFromTrash &&
			(taskAgentSessionInitialization?.sourceSessionReuseMode === "fork_existing_session" ||
				(!taskAgentSessionInitialization &&
					(parentSessionId !== null || Boolean(input.forkLatestWorkingDirectorySession))));

		logTuiFreezeWarning(
			`[tui-freeze] codex-startup-prompt taskId=${input.taskId} hasFork=${forksSession} hasResume=${resumesSession} promptChars=${trimmed.length} deferredViaInput=${deferredStartupInput !== undefined}`,
		);

		// 这里刻意只保留**唯一一个** return：hooks 配置只是就地改写 codexArgs / env（见上方
		// `if (hooks)` 块），并不改变 PreparedAgentLaunch 的形状，所以不需要按 hooks 分叉出第二个
		// return。曾经存在的「hooks 分支 return + 默认 return」两份逐字重复的对象字面量，导致给
		// PreparedAgentLaunch 新增字段时只补了其中一份，而生产任务会话恒有 workspaceId、恒走
		// hooks 分支，字段静默丢失（resumesPriorAgentConversation 就这样漏过一次）。单 return 从
		// 结构上根除这类漏改。
		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupInput,
			// resume 与 fork 都会把既有会话的 transcript 重播进新 TUI（见 PreparedAgentLaunch 同名字段）。
			resumesPriorAgentConversation: resumesSession || forksSession,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

const cursorAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const taskAgentSessionInitialization = resolveTaskAgentSessionInitialization(input);
		const explicitModelId = resolveTerminalAgentModelOverride(input, "cursor");
		// cursor 是唯一**无条件**传 `--model` 的 adapter（claude / codex 只在有显式 override 时才传），
		// 所以这个默认值必须跟得上上游改名：从实际模型目录解析（带 TTL 缓存，热路径零开销），
		// 探测失败才回落写死的常量。上一版直接用常量，结果每次会话都在传一个上游早已删除的 model id。
		const args = setModelCliOption(input.args, explicitModelId ?? (await resolveCursorLaunchDefaultModelId()));
		const env: Record<string, string | undefined> = {};

		if (!hasCliOption(args, "--workspace")) {
			args.push("--workspace", input.cwd);
		}

		// cursor-agent 的 --force（放行命令）与 --plan（开局只读规划）是两个独立布尔旗标，实测可并存，
		// 故这里不再让 plan 起步压掉放权档。cursor 无法表达「只放行编辑」，中间档已由
		// resolveLaunchPermissionMode 保守降级为「每次询问」。
		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--force") &&
			!hasCliOption(args, "--yolo")
		) {
			args.push("--force");
		}

		const resumesPriorAgentConversation = Boolean(input.resumeFromTrash || taskAgentSessionInitialization);
		if (input.resumeFromTrash && !hasCliOption(args, "--continue") && !hasCliOption(args, "--resume")) {
			args.push("--continue");
		} else if (taskAgentSessionInitialization && !hasCliOption(args, "--resume")) {
			args.push("--resume", taskAgentSessionInitialization.sourceSessionId);
		}

		if (input.startInPlanMode && !hasCliOption(args, "--plan") && !hasCliOption(args, "--mode")) {
			args.push("--plan");
		}

		const trimmed = prependTaskSessionGuidanceToPrompt(input).trim();
		if (!input.resumeFromTrash && trimmed) {
			args.push(trimmed);
		}

		return {
			args,
			env,
			resumesPriorAgentConversation,
		};
	},
};

const geminiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		const geminiPermissionMode = resolveLaunchPermissionMode(input);
		if (geminiPermissionMode === "bypass_all_permission_prompts" && !hasCliOption(args, "--yolo")) {
			args.push("--yolo");
		} else if (geminiPermissionMode === "auto_approve_file_edits_only" && !hasCliOption(args, "--approval-mode")) {
			args.push("--approval-mode=auto_edit");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume")) {
			args.push("--resume", "latest");
		}

		// plan 起步用 --approval-mode=plan 表达，会盖掉上面的 auto_edit（同一旗标）；--yolo 是独立
		// 旗标故 bypass 档在 plan 起步下依然保留。
		if (input.startInPlanMode) {
			args.push("--approval-mode=plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const configPath = join(getHookAgentDirectory("gemini"), "settings.json");
			const geminiHookCommand = buildHooksCommand(["gemini-hook"]);

			const config = {
				hooks: {
					BeforeTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					BeforeAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					Notification: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
				},
			};
			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;
		}

		const prompt = prependTaskSessionGuidanceToPrompt(input);
		const trimmed = prompt.trim();
		if (trimmed) {
			args.push("-i", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

async function resolveOpenCodeBaseConfigPath(explicitPath: string | undefined): Promise<string | null> {
	const candidates = getOpenCodeConfigPathCandidates({ explicitPath });
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Keep searching.
		}
	}
	return null;
}

function hasOpenCodeModelArg(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--model" || arg === "-m") {
			return true;
		}
		if (arg.startsWith("--model=") || arg.startsWith("-m=")) {
			return true;
		}
	}
	return false;
}

function hasOpenCodeAgentArg(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--agent") {
			return true;
		}
		if (arg.startsWith("--agent=")) {
			return true;
		}
	}
	return false;
}

function normalizeOpenCodeModel(providerId: string, modelId: string): string {
	if (modelId.startsWith(`${providerId}/`)) {
		return modelId;
	}
	return `${providerId}/${modelId}`;
}

function stripJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < input.length; i += 1) {
		const current = input[i];
		const next = i + 1 < input.length ? input[i + 1] : "";

		if (inLineComment) {
			if (current === "\n") {
				inLineComment = false;
				output += current;
			}
			continue;
		}
		if (inBlockComment) {
			if (current === "*" && next === "/") {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}
		if (!inString && current === "/" && next === "/") {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (!inString && current === "/" && next === "*") {
			inBlockComment = true;
			i += 1;
			continue;
		}

		output += current;
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (current === "\\") {
				escaped = true;
			} else if (current === '"') {
				inString = false;
			}
			continue;
		}
		if (current === '"') {
			inString = true;
		}
	}
	return output;
}

function tryExtractOpenCodeModelFromConfig(rawConfig: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawConfig);
	} catch {
		try {
			parsed = JSON.parse(stripJsonComments(rawConfig));
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const root = parsed as Record<string, unknown>;

	const directModel = root.model;
	if (typeof directModel === "string" && directModel.trim()) {
		return directModel.trim();
	}

	const mode = root.mode;
	if (mode && typeof mode === "object" && !Array.isArray(mode)) {
		const build = (mode as Record<string, unknown>).build;
		if (build && typeof build === "object" && !Array.isArray(build)) {
			const model = (build as Record<string, unknown>).model;
			if (typeof model === "string" && model.trim()) {
				return model.trim();
			}
		}
	}

	const agent = root.agent;
	if (agent && typeof agent === "object" && !Array.isArray(agent)) {
		const build = (agent as Record<string, unknown>).build;
		if (build && typeof build === "object" && !Array.isArray(build)) {
			const model = (build as Record<string, unknown>).model;
			if (typeof model === "string" && model.trim()) {
				return model.trim();
			}
		}
	}

	return null;
}

async function resolveOpenCodePreferredModelArg(configPath: string | null): Promise<string | null> {
	if (configPath) {
		try {
			const rawConfig = await readFile(configPath, "utf8");
			const modelFromConfig = tryExtractOpenCodeModelFromConfig(rawConfig);
			if (modelFromConfig) {
				return modelFromConfig;
			}
		} catch {
			// Fall through to state-based fallback.
		}
	}

	const modelStateCandidates = getOpenCodeModelStatePathCandidates();
	let recentModels: Array<{ providerID?: unknown; modelID?: unknown }> = [];
	for (const modelStatePath of modelStateCandidates) {
		try {
			const raw = await readFile(modelStatePath, "utf8");
			const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: unknown; modelID?: unknown }> };
			if (Array.isArray(parsed.recent)) {
				recentModels = parsed.recent;
				break;
			}
		} catch {
			// Keep searching through candidate state paths.
		}
	}
	if (recentModels.length === 0) {
		return null;
	}

	const configuredProviders = new Set<string>();
	for (const authPath of getOpenCodeAuthPathCandidates()) {
		try {
			const raw = await readFile(authPath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			for (const [provider, value] of Object.entries(parsed)) {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					continue;
				}
				const key = (value as Record<string, unknown>).key;
				if (typeof key === "string" && key.trim()) {
					configuredProviders.add(provider);
				}
			}
			break;
		} catch {
			// Keep searching through candidate auth paths.
		}
	}

	const candidates: Array<{ providerId: string; model: string }> = [];
	for (const entry of recentModels) {
		const providerId = typeof entry.providerID === "string" ? entry.providerID.trim() : "";
		const modelId = typeof entry.modelID === "string" ? entry.modelID.trim() : "";
		if (!providerId || !modelId) {
			continue;
		}
		candidates.push({ providerId, model: normalizeOpenCodeModel(providerId, modelId) });
	}
	if (candidates.length === 0) {
		return null;
	}

	const preferredProviderOrder = ["openrouter", "anthropic", "openai", "opencode", "google", "amazon-bedrock"];
	for (const providerId of preferredProviderOrder) {
		const match = candidates.find((candidate) => candidate.providerId === providerId);
		if (!match) {
			continue;
		}
		if (configuredProviders.size === 0 || configuredProviders.has(providerId)) {
			return match.model;
		}
	}

	const configuredMatch = candidates.find((candidate) => configuredProviders.has(candidate.providerId));
	if (configuredMatch) {
		return configuredMatch.model;
	}

	return candidates[0].model;
}

const opencodeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		const baseConfigPath = await resolveOpenCodeBaseConfigPath(input.env?.OPENCODE_CONFIG);
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			env.OPENCODE_EXPERIMENTAL_PLAN_MODE = "true";
			if (!hasOpenCodeAgentArg(args)) {
				args.push("--agent", "plan");
			}
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const pluginPath = join(getHookAgentDirectory("opencode"), "kanban.js");
			const configPath = join(getHookAgentDirectory("opencode"), "opencode.json");

			const pluginContent = buildOpenCodePluginContent(
				buildHookCommand("to_review", { source: "opencode" }),
				buildHookCommand("to_in_progress", { source: "opencode" }),
				buildHookCommand("activity", { source: "opencode" }),
			);
			await ensureTextFile(pluginPath, pluginContent);
			const pluginFileUrl = pathToFileURL(pluginPath).href;
			const config = {
				plugin: [pluginFileUrl],
			};
			await ensureTextFile(configPath, JSON.stringify(config));
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.OPENCODE_CONFIG = configPath;
		}

		// Workaround: with --prompt, OpenCode can pick an unexpected provider/model.
		// Explicitly pass the user's preferred model so prompt runs stay on their usual provider.
		if (!hasOpenCodeModelArg(args)) {
			const preferredModel = await resolveOpenCodePreferredModelArg(baseConfigPath);
			if (preferredModel) {
				args.push("--model", preferredModel);
			}
		}

		const prompt = prependTaskSessionGuidanceToPrompt(input);
		const trimmed = prompt.trim();
		if (trimmed) {
			args.push("--prompt", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

const droidAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		// settings.json 必写：autonomyMode 要如实反映当前放权档（"normal" 同样是一个有意义的档位，
		// 不写就会退回 droid 自己的默认，权限档形同虚设）。
		{
			const settingsPath = join(getHookAgentDirectory("droid"), "settings.json");
			const settings: Record<string, unknown> = {
				// droid 的 autonomyMode 是**单轴**（spec / normal / auto-high），无法同时表达
				// 「plan 起步」与「放权档位」。这是已知的 harness 限制，由
				// doesPlanModeStartOverridePermissionModeForAgent 在 UI 侧明示，此处不静默假装两者都生效。
				autonomyMode: input.startInPlanMode
					? "spec"
					: resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts"
						? "auto-high"
						: "normal",
			};

			if (hooks) {
				const droidActiveToolMatcher = "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create";
				const reviewNotifyCommand = buildHooksCommand(["notify", "--event", "to_review", "--source", "droid"]);
				const inProgressNotifyCommand = buildHooksCommand([
					"notify",
					"--event",
					"to_in_progress",
					"--source",
					"droid",
				]);
				const activityNotifyCommand = buildHooksCommand(["notify", "--event", "activity", "--source", "droid"]);
				settings.hooks = {
					Stop: [{ hooks: [{ type: "command", command: reviewNotifyCommand }] }],
					Notification: [
						{ hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PreToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: droidActiveToolMatcher, hooks: [{ type: "command", command: inProgressNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PostToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: inProgressNotifyCommand }] },
					],
					PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] }],
					UserPromptSubmit: [{ hooks: [{ type: "command", command: inProgressNotifyCommand }] }],
				};

				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			await ensureTextFile(settingsPath, JSON.stringify(settings, null, 2));
			if (!hasCliOption(args, "--settings")) {
				args.push("--settings", settingsPath);
			}
		}

		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);
		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, prependTaskSessionGuidanceToPrompt(input), "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const kiroAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		// kiro 的 plan 起步是纯 prompt 注入，与 --trust-all-tools 天然正交。
		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--trust-all-tools")
		) {
			args.push("--trust-all-tools");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);
		if (hooks || appendedSystemPrompt) {
			const configPath = getKiroAgentConfigPath();
			const config: Record<string, unknown> = {
				name: KIRO_KANBAN_AGENT_NAME,
				description: "Kanban-managed Kiro agent with hook forwarding.",
				tools: ["*"],
			};

			if (hooks) {
				config.hooks = {
					agentSpawn: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "agentSpawn",
							}),
						},
					],
					userPromptSubmit: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "userPromptSubmit",
							}),
						},
					],
					preToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
					],
					postToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "postToolUse",
							}),
						},
					],
					stop: [
						{
							command: buildHookCommand("to_review", {
								source: "kiro",
								hookEventName: "stop",
								activityText: "Waiting for review",
							}),
						},
					],
				};
				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			if (appendedSystemPrompt) {
				config.prompt = appendedSystemPrompt;
			}

			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			if (!hasCliOption(args, "--agent")) {
				args.push("--agent", KIRO_KANBAN_AGENT_NAME);
			}
		}

		const trimmedPrompt = input.prompt.trim();
		const planPrompt = input.startInPlanMode
			? [
					"First, inspect the codebase and produce a clear implementation plan only.",
					"Do not modify files, do not use write tools, and do not implement anything yet.",
					"After you present the plan, ask for approval before making changes.",
					trimmedPrompt
						? `\n\nTask:\n${trimmedPrompt}`
						: " Ask the user what they want planned if the task is unclear.",
				].join(" ")
			: input.prompt;
		const withPromptLaunch = withPrompt(args, planPrompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const clineAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--auto-approve-all")
		) {
			args.push("--auto-approve-all");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			args.push("--plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const hooksDir = getHookAgentDirectory("cline");
			const notificationHookPath = getClineHookScriptPath(hooksDir, "Notification");
			const taskCompleteHookPath = getClineHookScriptPath(hooksDir, "TaskComplete");
			const userPromptSubmitHookPath = getClineHookScriptPath(hooksDir, "UserPromptSubmit");
			const preToolUseHookPath = getClineHookScriptPath(hooksDir, "PreToolUse");
			const postToolUseHookPath = getClineHookScriptPath(hooksDir, "PostToolUse");
			const executable = process.platform !== "win32";

			await ensureTextFile(notificationHookPath, buildClineNotificationHookScriptContent(), executable);
			await ensureTextFile(taskCompleteHookPath, buildClineHookScriptContent("to_review"), executable);
			await ensureTextFile(userPromptSubmitHookPath, buildClineHookScriptContent("to_in_progress"), executable);
			await ensureTextFile(preToolUseHookPath, buildClinePreToolUseHookScriptContent(), executable);
			await ensureTextFile(postToolUseHookPath, buildClinePostToolUseHookScriptContent(), executable);

			if (!hasCliOption(args, "--hooks-dir")) {
				args.push("--hooks-dir", hooksDir);
			}

			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const withPromptLaunch = withPrompt(args, prependTaskSessionGuidanceToPrompt(input), "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

// Kimi Code TUI 的「等待用户审查 → 回到 running」输出探测：与 claudePromptDetector 对齐（而非 codex）。
// kimi 与 claude 同为 Stop hook 驱动 to_review，故门控口径必须一致——仅在 awaiting-review 且
// reviewReason === "attention" 时，凭输入提示符重现判定 agent 已回到空闲。
function kimiPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (!isAwaitingUserReviewTurn(resolveSessionFacets(summary))) {
		return null;
	}
	// 仅在 reviewReason === "attention"（如 resumeFromTrash 恢复会话）时根据 TUI 输出回到 running。
	// reviewReason === "hook" 表示 kimi 在 Stop / StopFailure hook 后等待用户审查，而 kimi 的 TUI
	// 输入框会随每一次重绘出现 — 若在 "hook" 下也接受 prompt-ready，hook 触发后下一帧 TUI 重绘就会
	// 立刻把状态翻回 running，"等待审查" 的语义（含完成通知）就丢失了。codex 靠 session-manager 的
	// awaitingCodexPromptAfterEnter enter 守卫兜住这次即时翻转，kimi 没有该守卫、也没有 claude 曾缺的
	// 门控，故必须在此对齐 claude。"hook" -> running 应由 UserPromptSubmit hook 走 `hook.to_in_progress`
	// 路径触发，而不是靠终端输出探测。
	if (summary.reviewReason !== "attention") {
		return null;
	}
	if (hasKimiInteractivePrompt(data)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectKimiOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	// 与 kimiPromptDetector / claude 保持一致：仅在 reviewReason === "attention" 时才需要解码输出来探测
	// prompt-ready 转移；"hook" -> running 由 UserPromptSubmit hook 驱动，不走输出探测。
	return isAwaitingUserReviewTurn(resolveSessionFacets(summary)) && summary.reviewReason === "attention";
}

// Kimi Code CLI（Moonshot 的原生终端 agent）。与 codexAdapter 同为「全屏 TUI + 无位置
// prompt」形态，故任务 prompt 一律经 deferredStartupInput 在 TUI 就绪后 bracketed-paste 注入
//（`kimi -p` 是单发 print 模式，不产生持久交互会话，不能用于托管会话）。
const kimiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		// 仅在有显式 override 时才注入 `-m/--model`（setModelCliOption 正好清理这两个写法）；
		// 无 override 时不传，交回 kimi config.toml 的 default_model——与 claude / codex adapter 一致。
		const explicitModelId = resolveTerminalAgentModelOverride(input, "kimi");
		const args = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {
			// 会话中途自升级会打断托管会话（tui.toml [upgrade] auto_install 默认开）；关掉它。
			KIMI_CLI_NO_AUTO_UPDATE: "1",
		};

		// kimi 的 --plan 与 --yolo 是独立旗标，plan 起步不影响放权档。
		if (
			resolveLaunchPermissionMode(input) === "bypass_all_permission_prompts" &&
			!hasCliOption(args, "--yolo") &&
			!hasCliOption(args, "-y")
		) {
			args.push("--yolo");
		}
		if (input.startInPlanMode && !hasCliOption(args, "--plan")) {
			args.push("--plan");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue") && !hasCliOption(args, "-c")) {
			args.push("--continue");
		}

		// hook 只能声明在 kimi 已解析 home 的 config.toml；派生一个 Kanban 托管的 seeded
		// KIMI_CODE_HOME（软链登录态 + 注入 Kanban hooks），不改动用户全局 ~/.kimi-code。
		const hooks = resolveHookContext(input);
		if (hooks) {
			env.KIMI_CODE_HOME = await seedKanbanManagedKimiCodeHome(process.env);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const trimmed = input.prompt.trim();
		const deferredStartupInput = !input.resumeFromTrash && trimmed ? toBracketedPasteSubmission(trimmed) : undefined;

		return {
			args,
			env,
			deferredStartupInput,
			detectOutputTransition: kimiPromptDetector,
			shouldInspectOutputForTransition: shouldInspectKimiOutputForTransition,
		};
	},
};

// oh-my-pi（omp）的 PTY TUI 通道。omp 还有一条 ACP 通道（src/acp-client-session/），两条通道
// 共用同一份 omp 磁盘会话存储（omp 的 SessionManager 按 cwd 建库），因而可以随时互相切换——
// 走哪条由 core/agent-session-transport-selection.ts 决定，不是这里。
//
// 形态上模板是 cursorAdapter 而不是 codex/kimi：omp 的根命令吃**位置 prompt** 并在 mode.init()
// 完成后自动提交（main.ts 的 `session.prompt(initialMessage)`），所以不需要 deferredStartupInput，
// 也就完全不必碰 session-manager 的就绪判定与注入闸。
const ompAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {
			// 首启的全屏 setup 向导会切 alt-screen 盖住 TUI 并等人操作，托管会话必须跳过。
			// 这是 omp 侧唯一的读取点（setup-wizard/index.ts）。
			OMP_SKIP_SETUP: "1",
		};

		// 放权档三档与 omp 的 `--approval-mode` 一一对应；映射表与 ACP 通道共用一份
		// （core/omp-approval-mode-flag.ts），否则切换通道会静默改变放权语义。
		// 必须**显式**传：omp 的 schema 默认虽是 yolo，但「默认值」不算 isConfigured，权限门仍会保留。
		if (!hasCliOption(args, "--approval-mode")) {
			args.push("--approval-mode", resolveOmpApprovalModeFlagValue(resolveLaunchPermissionMode(input)));
		}

		// plan 起步经 Kanban 托管的设置 overlay 表达，**不动放权档**（AGENTS.md 的正交轴铁律）。
		// 续跑时不重放 plan 起步：用户已在对话中途，omp 的会话记录里存着当前模式。
		// 续跑（垃圾桶恢复 / 通道切换）在 adapter 里是同一条分支：都不重投 prompt、都加 --continue、
		// 都武装重播守卫、都不重放 plan 起步。
		const shouldContinuePriorConversation = Boolean(
			input.resumeFromTrash || input.resumePriorAgentConversationWithoutResendingPrompt,
		);
		const shouldStartInPlanMode = Boolean(input.startInPlanMode) && !shouldContinuePriorConversation;
		const launchConfigOverlay = await writeOmpTuiLaunchConfigOverlay({
			hookAgentDirectory: getHookAgentDirectory("omp"),
			taskId: input.taskId,
			startInPlanMode: shouldStartInPlanMode,
		});
		args.push("--config", launchConfigOverlay.configFilePath);

		// 续跑用 `--continue`。**绝不**发裸 `-r` / `--resume`：无值时 omp 会弹一个全屏 session picker
		// 等人上下键选（main.ts），托管会话会就此卡死。
		// omp 的 terminal breadcrumb 认的是 TTY 设备路径（ttyid.ts），新 PTY 每次 id 都不同，于是
		// `--continue` 落到 fallback「该 cwd 下最近的一条 session」——每 task 一个 worktree，这个
		// fallback 恰好正确。注意它并不锁定某个具体 sessionId。
		const resumesPriorAgentConversation = shouldContinuePriorConversation;
		if (shouldContinuePriorConversation && !hasCliOption(args, "--continue") && !hasCliOption(args, "-c")) {
			args.push("--continue");
		}

		// 位置 prompt：omp 在 TUI 初始化完成后自动提交它。续跑时不重投——那会凭空多出一轮。
		const trimmed = prependTaskSessionGuidanceToPrompt(input).trim();
		if (!shouldContinuePriorConversation && trimmed) {
			args.push(trimmed);
		}

		return {
			args,
			env,
			resumesPriorAgentConversation,
			// 状态判定读 OSC 终端标题（omp 把三态编码在标题分隔符里），比 cursor/kiro/droid 那种
			// 「只能靠 scanForStalls 兜底」结构化得多，且不需要写 omp extension。
			// 不设 shouldInspectOutputForTransition：缺省即恒扫，spinner 帧本来就要被看到。
			detectOutputTransition: detectOmpTerminalTitleStateTransition,
		};
	},
};

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	cursor: cursorAdapter,
	gemini: geminiAdapter,
	opencode: opencodeAdapter,
	droid: droidAdapter,
	kiro: kiroAdapter,
	cline: clineAdapter,
	kimi: kimiAdapter,
	omp: ompAdapter,
};

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	if (input.agentId !== "codex") {
		warnUnsupportedParentSessionId(input.agentId, input.parentSessionId);
	}
	return await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: preparedPrompt,
	});
}
