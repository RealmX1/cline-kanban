// runtime（controller）与 agent session PTY host 之间的 JSON 控制消息。
//
// 跨版本契约（热重启后新 runtime 要对接旧 build 拉起的 host，host 也会长期跑旧 bundle）：
// - 握手消息（controller_hello / host_hello_acknowledged / controller_rejected）的形状**永久冻结**，
//   双方据此协商 protocolVersion，之后才谈别的消息。
// - `terminate_all_hosted_sessions_and_exit` 同样冻结：离线的 `kanban runtime stop --terminate-hosted-agent-sessions`
//   要能对任何版本的 host 发出它。
// - 其余消息只增不改：加字段用可选字段，改语义就新起一个消息类型。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*`（host bundle 的 import 守卫会检查）。

export const AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION = 1;

export type AgentSessionPtyHostHostedSessionKind = "task_agent_session" | "shell_session";

// host 只用它来列出与诊断；会话属于哪个 workspace / task 的权威记录在 runtime 侧。
export interface AgentSessionPtyHostHostedSessionDescriptor {
	workspaceId: string;
	// 新 runtime 接管时据此加载该 workspace 的 terminal manager（缺省时按 workspace 索引补）。
	workspaceRepositoryPath?: string;
	taskId: string;
	hostedSessionKind: AgentSessionPtyHostHostedSessionKind;
}

export interface AgentSessionPtyHostHostedSessionExitRecord {
	exitCode: number;
	signal: number | null;
	exitedAtEpochMs: number;
}

export interface AgentSessionPtyHostHostedSessionListing {
	hostedSessionKey: string;
	hostedSessionChannelNumber: number;
	hostedSessionDescriptor: AgentSessionPtyHostHostedSessionDescriptor;
	pid: number;
	spawnedAtEpochMs: number;
	// 输出环形缓冲当前保留的绝对字节区间 [retained, end)。
	retainedOutputStartByteOffset: number;
	outputEndByteOffset: number;
	// null：进程仍在运行。非 null：进程已退出、退出记录还在等 controller 确认。
	exitRecord: AgentSessionPtyHostHostedSessionExitRecord | null;
	// 最近一次 resize 后的终端尺寸（接管时还原 mirror 尺寸用）。
	cols: number;
	rows: number;
	// runtime 最近一次推来的接管记录（host 只存不解析）；从未推过为 null。
	adoptionRecord: unknown;
	// runtime 缺席期间 hooks CLI 存进来、尚未被 runtime 确认的 hook 事件条数。旧 host 不报（缺省按 0）。
	// 带了这个字段（哪怕是 0）即说明 host 支持 hook spool：runtime 只对这样的 host 发 spool 读请求。
	pendingHookSpoolEntryCount?: number;
	// true：controller 已确认这条会话的退出，但 spool 里还有未确认的 hook 事件，host 把会话留到 spool 被确认清空。
	// 新 runtime 只需排空它的 spool，不应再把它当接管候选（它的退出已经交付过）。旧 host 不报。
	exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged?: boolean;
}

// 一条存在 host 里、等 runtime 回来取走的 hook 事件。
export interface HostedSessionHookSpoolEntry {
	// 每条会话内单调递增；runtime 按它确认（≤ 该序号的条目一并移除）。
	hookSpoolEntrySequenceNumber: number;
	spooledAtEpochMs: number;
	// runtime hooks.ingest 的请求体原文（host 只存不解析）。
	spooledHookIngestRequest: unknown;
}

// ---- controller → host ----

export interface ControllerHelloMessage {
	type: "controller_hello";
	protocolVersion: number;
	controllerProcessId: number;
}

export interface SpawnHostedSessionRequestMessage {
	type: "spawn_hosted_session_request";
	requestId: string;
	hostedSessionKey: string;
	hostedSessionDescriptor: AgentSessionPtyHostHostedSessionDescriptor;
	binary: string;
	args: string[];
	cwd: string;
	// runtime 已按 buildTerminalEnvironment 算好的完整环境；host 原样交给 node-pty，绝不混入自身 env。
	env: Record<string, string>;
	terminalName: string;
	cols: number;
	rows: number;
}

export interface ResizeHostedSessionMessage {
	type: "resize_hosted_session";
	hostedSessionKey: string;
	cols: number;
	rows: number;
	pixelWidth?: number;
	pixelHeight?: number;
}

export interface PauseHostedSessionOutputMessage {
	type: "pause_hosted_session_output";
	hostedSessionKey: string;
}

export interface ResumeHostedSessionOutputMessage {
	type: "resume_hosted_session_output";
	hostedSessionKey: string;
}

export interface StopHostedSessionMessage {
	type: "stop_hosted_session";
	hostedSessionKey: string;
	force: boolean;
}

// 确认退出时若该会话 spool 里还有未确认的 hook 事件，支持 spool 的 host 保留会话、等 spool 被确认清空再移除
// （并推一次 hosted_session_hook_spool_entries_pending）；旧 host 总是连同 spool 一起移除。
export interface AcknowledgeHostedSessionExitMessage {
	type: "acknowledge_hosted_session_exit";
	hostedSessionKey: string;
	// true：连同未确认的 spool 一起移除（runtime 拒绝接管、已下令终止的会话：它的 hook 事件不再有人应用）。
	// host 移除非空 spool 时写一条 host 日志，不静默。
	discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession?: boolean;
}

export interface ListHostedSessionsRequestMessage {
	type: "list_hosted_sessions_request";
	requestId: string;
}

// runtime 把「新 runtime 接管这条会话所需的状态」推给 host 保管（会话 summary 快照 + 需跨重启的内存态）。
// host 与会话同寿，所以 runtime 被 kill -9 后这份记录仍在；host 只存最新一份、不解析内容。
export interface PutHostedSessionAdoptionRecordMessage {
	type: "put_hosted_session_adoption_record";
	hostedSessionKey: string;
	adoptionRecord: unknown;
}

// 订阅一条会话的输出：host 先把环形缓冲里 [fromByteOffset, 当前末尾) 的字节作为「追赶」帧发出，随后转为实时推送。
// 同一连接上帧有序，所以 controller 可以按响应里的 catchUpEndByteOffset 区分追赶字节与实时字节。
export interface AttachHostedSessionOutputStreamRequestMessage {
	type: "attach_hosted_session_output_stream_request";
	requestId: string;
	hostedSessionKey: string;
	fromByteOffset: number;
}

// 新 build 的 host 已经起来：本 host 不再接受新 spawn，存量会话全部退出并被确认后自行退出。
export interface RetireWhenDrainedMessage {
	type: "retire_when_drained";
}

// 冻结：终止全部会话（进程组 SIGTERM，5s 后升级 SIGKILL）后退出。
export interface TerminateAllHostedSessionsAndExitMessage {
	type: "terminate_all_hosted_sessions_and_exit";
}

// 取一条会话 spool 里的全部待确认 hook 事件（按序号升序）。runtime 逐条应用后再确认。
export interface ReadHostedSessionHookSpoolEntriesRequestMessage {
	type: "read_hosted_session_hook_spool_entries_request";
	requestId: string;
	hostedSessionKey: string;
}

export interface AcknowledgeHostedSessionHookSpoolEntriesMessage {
	type: "acknowledge_hosted_session_hook_spool_entries";
	hostedSessionKey: string;
	throughHookSpoolEntrySequenceNumber: number;
}

export type AgentSessionPtyHostControllerToHostMessage =
	| ControllerHelloMessage
	| SpawnHostedSessionRequestMessage
	| ResizeHostedSessionMessage
	| PauseHostedSessionOutputMessage
	| ResumeHostedSessionOutputMessage
	| StopHostedSessionMessage
	| AcknowledgeHostedSessionExitMessage
	| ListHostedSessionsRequestMessage
	| PutHostedSessionAdoptionRecordMessage
	| AttachHostedSessionOutputStreamRequestMessage
	| RetireWhenDrainedMessage
	| TerminateAllHostedSessionsAndExitMessage
	| ReadHostedSessionHookSpoolEntriesRequestMessage
	| AcknowledgeHostedSessionHookSpoolEntriesMessage;

// ---- host → controller ----

export interface HostHelloAcknowledgedMessage {
	type: "host_hello_acknowledged";
	protocolVersion: number;
	hostProcessId: number;
	hostBuildIdentity: string;
	hostStartedAtEpochMs: number;
}

export interface ControllerRejectedMessage {
	type: "controller_rejected";
	reason: "protocol_version_unsupported" | "host_is_terminating";
	hostSupportedProtocolVersion: number;
}

// 单 controller 槽：新 controller 握手成功时，旧 controller 收到这条后被断开。
export interface ControllerSupersededMessage {
	type: "controller_superseded";
}

export type SpawnHostedSessionOutcome =
	| { kind: "spawned"; hostedSessionChannelNumber: number; pid: number; spawnedAtEpochMs: number }
	| { kind: "spawn_failed"; errorCode: string; errorMessage: string };

export interface SpawnHostedSessionResponseMessage {
	type: "spawn_hosted_session_response";
	requestId: string;
	outcome: SpawnHostedSessionOutcome;
}

export interface HostedSessionExitedMessage {
	type: "hosted_session_exited";
	hostedSessionKey: string;
	exitRecord: AgentSessionPtyHostHostedSessionExitRecord;
}

export interface ListHostedSessionsResponseMessage {
	type: "list_hosted_sessions_response";
	requestId: string;
	hostedSessions: AgentSessionPtyHostHostedSessionListing[];
}

export type AttachHostedSessionOutputStreamOutcome =
	| {
			kind: "attached";
			// 追赶字节区间 [catchUpStartByteOffset, catchUpEndByteOffset)；请求偏移早于环形缓冲保留起点时，
			// 起点被抬到保留起点，中间被覆盖掉的字节数见 overwrittenByteCountBeforeCatchUpStart。
			catchUpStartByteOffset: number;
			catchUpEndByteOffset: number;
			overwrittenByteCountBeforeCatchUpStart: number;
	  }
	| { kind: "unknown_hosted_session" };

export interface AttachHostedSessionOutputStreamResponseMessage {
	type: "attach_hosted_session_output_stream_response";
	requestId: string;
	outcome: AttachHostedSessionOutputStreamOutcome;
}

export type ReadHostedSessionHookSpoolEntriesOutcome =
	| { kind: "read"; hookSpoolEntries: HostedSessionHookSpoolEntry[] }
	| { kind: "unknown_hosted_session" };

export interface ReadHostedSessionHookSpoolEntriesResponseMessage {
	type: "read_hosted_session_hook_spool_entries_response";
	requestId: string;
	outcome: ReadHostedSessionHookSpoolEntriesOutcome;
}

// 有 controller 时，每存进一条就推一次：runtime 据此及时取走，不必轮询。
export interface HostedSessionHookSpoolEntriesPendingMessage {
	type: "hosted_session_hook_spool_entries_pending";
	hostedSessionKey: string;
	pendingHookSpoolEntryCount: number;
}

export type AgentSessionPtyHostHostToControllerMessage =
	| HostHelloAcknowledgedMessage
	| ControllerRejectedMessage
	| ControllerSupersededMessage
	| SpawnHostedSessionResponseMessage
	| HostedSessionExitedMessage
	| ListHostedSessionsResponseMessage
	| AttachHostedSessionOutputStreamResponseMessage
	| ReadHostedSessionHookSpoolEntriesResponseMessage
	| HostedSessionHookSpoolEntriesPendingMessage;

// ---- hosted 会话里的 CLI（hooks CLI 等）↔ host ----
//
// 第二种客户端角色：跑在 hosted agent 会话里的 `kanban hooks …` 等进程，在 runtime 不可达时直连 host。
// 它不占 controller 槽、不会顶掉在线的 runtime；一条连接只发一个请求、收到响应即断开。
// 只增不改：旧 host 不认这个握手会直接断开连接，CLI 按「host 不可用」处理。

export interface HostedSessionCliClientHelloMessage {
	type: "hosted_session_cli_client_hello";
	protocolVersion: number;
	hostedSessionCliClientProcessId: number;
}

// 把一条 hook 事件存进会话的 spool，等 runtime 回来按序应用。
export interface AppendHookEventToHostedSessionSpoolRequestMessage {
	type: "append_hook_event_to_hosted_session_spool_request";
	requestId: string;
	hostedSessionKey: string;
	spooledHookIngestRequest: unknown;
	// true：可与紧挨着的上一条同类条目合并为这一条（只保留最新）。由 CLI 按事件语义判定（不带决策载荷的
	// activity），host 不解析载荷。生命周期事件一律 false、逐条保留。
	coalescibleWithAdjacentCoalescibleHookSpoolEntry: boolean;
}

// 「runtime 是不是正在重启」的证据：CLI 写动词在 runtime 不可达时据此决定等待重试还是直接报错。
export interface QueryControllerPresenceRequestMessage {
	type: "query_controller_presence_request";
	requestId: string;
}

export type AgentSessionPtyHostHostedSessionCliClientToHostMessage =
	| HostedSessionCliClientHelloMessage
	| AppendHookEventToHostedSessionSpoolRequestMessage
	| QueryControllerPresenceRequestMessage;

export type AppendHookEventToHostedSessionSpoolOutcome =
	| { kind: "spooled"; hookSpoolEntrySequenceNumber: number }
	| { kind: "spool_rejected"; reason: "unknown_hosted_session" | "hook_spool_full" | "host_is_terminating" };

export interface AppendHookEventToHostedSessionSpoolResponseMessage {
	type: "append_hook_event_to_hosted_session_spool_response";
	requestId: string;
	outcome: AppendHookEventToHostedSessionSpoolOutcome;
}

export interface QueryControllerPresenceResponseMessage {
	type: "query_controller_presence_response";
	requestId: string;
	controllerConnected: boolean;
	// controller 不在时：自哪一刻起不在（上一个 controller 断开的时刻；从未有过 controller 时为 host 启动时刻）。
	controllerAbsentSinceEpochMs: number | null;
}

export type AgentSessionPtyHostHostToHostedSessionCliClientMessage =
	| AppendHookEventToHostedSessionSpoolResponseMessage
	| QueryControllerPresenceResponseMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 只校验 type 字段是字符串：两端是同仓库代码，消息体的细粒度校验交给各处理分支对缺失字段的防御。
// 未知 type 由处理方忽略（向前兼容：旧 host 收到新消息类型不应断连）。
export function readWireControlMessageType(message: unknown): string | null {
	return isRecord(message) && typeof message.type === "string" ? message.type : null;
}
