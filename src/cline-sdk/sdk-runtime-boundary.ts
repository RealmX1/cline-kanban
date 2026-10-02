// Centralize direct SDK runtime imports here.
// All native Cline session-host creation and persisted artifact reads should
// flow through this boundary so the rest of Kanban stays decoupled from the
// SDK package layout.

import {
	type AgentEvent,
	type BasicLogger,
	buildWorkspaceMetadata,
	ClineCore,
	type ClineCoreStartInput,
	type CoreSessionEvent,
	createUserInstructionConfigService,
	formatRulesForSystemPrompt,
	getClineDefaultSystemPrompt,
	isRuleEnabled,
	type MessageWithMetadata,
	type RuleConfig,
	resolveClineDataDir,
	type SessionHistoryRecord,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type UserInstructionConfigService,
} from "@clinebot/core";
import { createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog } from "./cline-sdk-core-logger-forwarding-warnings-and-errors-to-kanban-server-log";
import { CLINE_BUILTIN_SLASH_COMMANDS } from "./cline-slash-commands";
import { getCliTelemetryService } from "./cline-telemetry-service";

export { TelemetryLoggerSink, TelemetryService } from "@clinebot/core";

export type ClineSdkSessionHost = ClineCore;
export type ClineSdkBasicLogger = BasicLogger;
export type ClineSdkAgentEvent = AgentEvent;

export type ClineSdkSessionEvent = CoreSessionEvent;

export type ClineSdkStartSessionInput = ClineCoreStartInput;
export type ClineSdkSessionRecord = SessionHistoryRecord;
export type ClineSdkPersistedMessage = MessageWithMetadata;
export type ClineSdkUserInstructionService = UserInstructionConfigService;
export interface ClineSdkSlashCommand {
	name: string;
	instructions: string;
	description?: string;
}
export type ClineSdkToolApprovalRequest = ToolApprovalRequest;
export type ClineSdkToolApprovalResult = ToolApprovalResult;

export async function createClineSdkSessionHost(): Promise<ClineSdkSessionHost> {
	return await ClineCore.create({
		// 固定进程内后端。@clinebot/core@0.0.38 在 "auto" 下每次 create 都会 detached spawn 一个 hub 守护进程：
		// 入口路径由 import.meta.url 推导，打包与否都指向不存在的 entry.js；即使路径正确，入口本身也会
		// 报 `AI is not defined`。结果是每次必崩、写一条 hub-daemon.log，再静默回退到进程内后端。
		// Kanban 不依赖 hub（没有 hub.endpoint / runtimeAddress 的使用），"local" 根本不会触发 spawn。
		// EXPERIMENT_NODE: SDK 修好 hub 守护进程入口后，是否改回 "auto" 以共享 cline CLI 的 hub 会话
		backendMode: "local",
		logger: createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog(),
		telemetry: getCliTelemetryService(),
	});
}

export function resolveClineSdkDataDir(): string {
	return resolveClineDataDir();
}
export async function buildClineSdkWorkspaceMetadata(cwd: string): Promise<string> {
	return await buildWorkspaceMetadata(cwd);
}

export function createClineSdkUserInstructionService(workspacePath: string): ClineSdkUserInstructionService {
	return createUserInstructionConfigService({
		skills: { workspacePath },
		rules: { workspacePath },
		workflows: { workspacePath },
	});
}

export function listClineSdkWorkflowSlashCommands(service?: ClineSdkUserInstructionService): ClineSdkSlashCommand[] {
	const builtIns: ClineSdkSlashCommand[] = CLINE_BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		instructions: "",
		description: command.description,
	}));
	if (!service) {
		return builtIns;
	}
	const byName = new Map<string, ClineSdkSlashCommand>();
	for (const command of builtIns) {
		byName.set(command.name, command);
	}
	for (const command of service.listRuntimeCommands()) {
		if (byName.has(command.name)) {
			continue;
		}
		byName.set(command.name, {
			name: command.name,
			instructions: command.instructions,
			description: command.kind === "workflow" ? "Workflow command" : "Skill command",
		});
	}
	return [...byName.values()];
}

export function resolveClineSdkWorkflowSlashCommand(prompt: string, service: ClineSdkUserInstructionService): string {
	return service.resolveRuntimeSlashCommand(prompt);
}

export function loadClineSdkRulesForSystemPrompt(service: ClineSdkUserInstructionService): string {
	const rules = service
		.listRecords<RuleConfig>("rule")
		.map((record) => record.item)
		.filter(isRuleEnabled)
		.sort((left, right) => left.name.localeCompare(right.name));
	return formatRulesForSystemPrompt(rules);
}

export async function resolveClineSdkSystemPrompt(input: {
	cwd: string;
	providerId: string;
	rules?: string;
}): Promise<string> {
	// The Cline SDK can run against non-Cline providers too, but only the
	// "cline" provider expects the extra workspace metadata block that powers
	// its repo-aware behavior in the same way the official CLI does.
	const shouldAppendWorkspaceMetadata = input.providerId === "cline";
	const workspaceMetadata = shouldAppendWorkspaceMetadata ? await buildWorkspaceMetadata(input.cwd) : "";
	return getClineDefaultSystemPrompt({
		ide: "Kanban",
		rootPath: input.cwd,
		providerId: input.providerId,
		metadata: workspaceMetadata,
		rules: input.rules ?? "",
	});
}
