// 唯一允许 import `@agentclientprotocol/sdk` 的模块。其余 ACP 代码只从这里取类型与工厂，
// 好让协议 SDK 的版本升级、方法重命名、废弃 API 迁移都收敛在一个文件里
//（与 src/cline-sdk/sdk-runtime-boundary.ts 对 @clinebot/core 的做法一致）。

import type { ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
	ClientCapabilities,
	ContentBlock,
	CreateElicitationRequest,
	CreateElicitationResponse,
	InitializeResponse,
	NewSessionResponse,
	PermissionOption,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionId,
	SessionNotification,
	SessionUpdate,
	StopReason,
	ToolCall,
	ToolCallContent,
	ToolCallStatus,
	ToolCallUpdate,
	ToolKind,
} from "@agentclientprotocol/sdk";
import {
	AGENT_METHODS,
	CLIENT_METHODS,
	type ClientConnection,
	type ClientContext,
	client,
	ndJsonStream,
	PROTOCOL_VERSION,
	type Stream,
} from "@agentclientprotocol/sdk";

export type AcpClientConnection = ClientConnection;
export type AcpClientContext = ClientContext;
export type AcpClientCapabilities = ClientCapabilities;
export type AcpContentBlock = ContentBlock;
export type AcpCreateElicitationRequest = CreateElicitationRequest;
export type AcpCreateElicitationResponse = CreateElicitationResponse;
export type AcpInitializeResponse = InitializeResponse;
export type AcpNewSessionResponse = NewSessionResponse;
export type AcpPermissionOption = PermissionOption;
export type AcpPromptResponse = PromptResponse;
export type AcpRequestPermissionRequest = RequestPermissionRequest;
export type AcpRequestPermissionResponse = RequestPermissionResponse;
export type AcpSessionId = SessionId;
export type AcpSessionNotification = SessionNotification;
export type AcpSessionUpdate = SessionUpdate;
export type AcpStopReason = StopReason;
export type AcpToolCall = ToolCall;
export type AcpToolCallContent = ToolCallContent;
export type AcpToolCallStatus = ToolCallStatus;
export type AcpToolCallUpdate = ToolCallUpdate;
export type AcpToolKind = ToolKind;

export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const ACP_AGENT_METHODS = AGENT_METHODS;
export const ACP_CLIENT_METHODS = CLIENT_METHODS;

// ACP 的 auth_required。omp 在未配置 provider 凭据时用它拒绝 session/new。
export const ACP_AUTH_REQUIRED_ERROR_CODE = -32000;

export interface AcpClientHandlers {
	// 每一条 session/update 通知。这是 agent 侧全部流式内容的唯一通道。
	handleSessionUpdate(notification: AcpSessionNotification): void;
	// agent 请求执行敏感工具的授权。必须实现：omp 不看 client capability 就会发。
	handlePermissionRequest(request: AcpRequestPermissionRequest): Promise<AcpRequestPermissionResponse>;
	// 表单型 elicitation。omp 的 plan 审批走这条；不声明该能力它会静默自动批准计划。
	handleElicitationRequest(request: AcpCreateElicitationRequest): Promise<AcpCreateElicitationResponse>;
}

export function buildKanbanAcpClientCapabilities(): AcpClientCapabilities {
	return {
		// 声明 form 型 elicitation 是**安全语义**要求而非 UI 增强：omp 在 client 未声明它时
		// 会把「计划待批」直接自动批准（acp-agent.ts #requestAcpPlanApprovalChoice），
		// 于是 plan 模式表面正常、实则从不征求用户同意。
		elicitation: { form: {} },
		// v1 不代理 fs / terminal：让 agent 自己读写工作树与跑命令，Kanban 现有的 worktree diff
		// 面板照常反映改动，省掉一整层 IO 代理。
	};
}

// 把子进程的 stdio 接成 ACP 的 NDJSON 双向流。注意参数次序是 (写给 agent 的 stdin, 读 agent 的 stdout)。
export function createAcpNdJsonStreamOverChildProcessStdio(
	child: ChildProcessByStdio<Writable, Readable, Readable>,
): Stream {
	return ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
}

// 建一个注册好 Kanban 处理器的 ACP 客户端并连上流。返回的连接是长生命周期的：
// 刻意不用 SDK 的 connectWith(op)，那个 helper 在 op 结束时就关闭连接，不适合常驻会话。
export function connectKanbanAcpClient(stream: Stream, handlers: AcpClientHandlers): AcpClientConnection {
	return client({ name: "cline-kanban" })
		.onNotification(CLIENT_METHODS.session_update, ({ params }) => {
			handlers.handleSessionUpdate(params);
		})
		.onRequest(CLIENT_METHODS.session_request_permission, async ({ params }) => {
			return await handlers.handlePermissionRequest(params);
		})
		.onRequest(CLIENT_METHODS.elicitation_create, async ({ params }) => {
			return await handlers.handleElicitationRequest(params);
		})
		.connect(stream);
}

export function isAcpAuthenticationRequiredError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === ACP_AUTH_REQUIRED_ERROR_CODE;
}
