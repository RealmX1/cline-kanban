import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isKanbanCursorAgentModelId, KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTerminalAgentModelOverrideSettings,
} from "../core/api-contract";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../core/session-activity";
import { quoteShellArg } from "../core/shell";
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
import {
	getOpenCodeAuthPathCandidates,
	getOpenCodeConfigPathCandidates,
	getOpenCodeModelStatePathCandidates,
} from "./opencode-paths";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	parentSessionId?: string;
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

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const explicitModelId = resolveTerminalAgentModelOverride(input, "claude");
		const args = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {
			CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
			FORCE_HYPERLINK: "1",
		};
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);
		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			args.push("--dangerously-skip-permissions");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
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
		if (input.startInPlanMode) {
			const withoutImmediateBypass = args.filter((arg) => arg !== "--dangerously-skip-permissions");
			args.length = 0;
			args.push(...withoutImmediateBypass);
			if (!hasCliOption(args, "--allow-dangerously-skip-permissions")) {
				args.push("--allow-dangerously-skip-permissions");
			}
			args.push("--permission-mode", "plan");
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
		const explicitModelId = resolveTerminalAgentModelOverride(input, "codex");
		const codexArgs = explicitModelId ? setModelCliOption(input.args, explicitModelId) : [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		let deferredStartupInput: string | undefined;
		const appendedSystemPrompt = resolveAgentAppendSystemPrompt(input);

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		// Codex = inline transcript agent（见 agent-catalog.ts 的 agentRendersTranscriptInline）：强制
		// --no-alt-screen 把完整历史渲染进 scrollback。与 session-manager 的 suppressScrollbackErasure
		// 门控同源，二者必须一致，否则「让历史进 scrollback」与「保护 scrollback 不被 CSI 3 J 清掉」会打架。
		if (!hasCliOption(codexArgs, "--no-alt-screen")) {
			codexArgs.push("--no-alt-screen");
		}

		if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		const parentSessionId = normalizeParentSessionId(input.parentSessionId);
		if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		} else if (parentSessionId) {
			if (!hasCodexWorkingDirectoryOverride(codexArgs)) {
				codexArgs.push("-C", input.cwd);
			}
			if (!codexArgs.includes("fork")) {
				codexArgs.push("fork", parentSessionId);
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

		logTuiFreezeWarning(
			`[tui-freeze] codex-startup-prompt taskId=${input.taskId} hasFork=${parentSessionId !== null} hasResume=${Boolean(input.resumeFromTrash)} promptChars=${trimmed.length} deferredViaInput=${deferredStartupInput !== undefined}`,
		);

		if (hooks) {
			return {
				binary,
				args: codexArgs,
				env,
				deferredStartupInput,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupInput,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

const cursorAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const explicitModelId = resolveTerminalAgentModelOverride(input, "cursor");
		const args = setModelCliOption(input.args, explicitModelId ?? KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID);
		const env: Record<string, string | undefined> = {};

		if (!hasCliOption(args, "--workspace")) {
			args.push("--workspace", input.cwd);
		}

		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--force") &&
			!hasCliOption(args, "--yolo")
		) {
			args.push("--force");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--continue") && !hasCliOption(args, "--resume")) {
			args.push("--continue");
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
		};
	},
};

const geminiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--yolo")) {
			args.push("--yolo");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume")) {
			args.push("--resume", "latest");
		}

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
		const shouldWriteSettings = Boolean(hooks) || input.startInPlanMode || input.autonomousModeEnabled !== undefined;
		if (shouldWriteSettings) {
			const settingsPath = join(getHookAgentDirectory("droid"), "settings.json");
			const settings: Record<string, unknown> = {
				autonomyMode: input.startInPlanMode ? "spec" : input.autonomousModeEnabled ? "auto-high" : "normal",
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

		if (input.autonomousModeEnabled && !hasCliOption(args, "--trust-all-tools")) {
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

		if (input.autonomousModeEnabled && !hasCliOption(args, "--auto-approve-all")) {
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

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	cursor: cursorAdapter,
	gemini: geminiAdapter,
	opencode: opencodeAdapter,
	droid: droidAdapter,
	kiro: kiroAdapter,
	cline: clineAdapter,
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
