import { runtimeCodexProtocolComparisonSnapshotSchema } from "@runtime-contract";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentConversationChatPanel } from "@/components/detail-panels/agent-conversation-chat-panel";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ExpandedForegroundViewProvider } from "@/expanded-foreground-view/expanded-foreground-view-provider";
import type { RuntimeCodexProtocolComparisonSnapshot } from "@/runtime/types";
import "@/styles/globals.css";

type BackendId = "codex_native" | "codex_acp";
const readComparisonControlToken = () => new URLSearchParams(window.location.hash.slice(1)).get("controlToken") ?? "";
async function command(backend: BackendId, operation: string, parameters: Record<string, unknown> = {}) {
	const response = await fetch("/codex-comparison-api/command", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Kanban-Codex-Comparison": readComparisonControlToken() },
		body: JSON.stringify({ backend, operation, ...parameters }),
	});
	const result = (await response.json()) as { ok: boolean; error?: string; result?: unknown };
	if (!response.ok || !result.ok) throw new Error(result.error ?? "比较操作失败。");
	return result.result;
}
function ComparisonPane({
	backend,
	snapshot,
}: {
	backend: BackendId;
	snapshot: RuntimeCodexProtocolComparisonSnapshot;
}) {
	const session = snapshot.sessions[backend];
	const [error, setError] = useState<string | null>(null);
	const [isControlling, setIsControlling] = useState(false);
	const [turns, setTurns] = useState<{ id: string; status: string }[]>([]);
	const [boundaryTurnId, setBoundaryTurnId] = useState("");
	const [startInPlanMode, setStartInPlanMode] = useState(false);
	const runControl = useCallback(
		async (operation: string, parameters: Record<string, unknown> = {}) => {
			setError(null);
			setIsControlling(true);
			try {
				const result = await command(backend, operation, parameters);
				if (operation === "history") setTurns(result as { id: string; status: string }[]);
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				setIsControlling(false);
			}
		},
		[backend],
	);
	const send = useCallback(
		async (_taskId: string, text: string, options?: { images?: unknown[] }) => {
			try {
				await command(backend, "send", { text, images: options?.images, idempotencyKey: crypto.randomUUID() });
				return { ok: true };
			} catch (reason) {
				return { ok: false, message: reason instanceof Error ? reason.message : String(reason) };
			}
		},
		[backend],
	);
	const cancel = useCallback(async () => {
		try {
			await command(backend, "interrupt");
			return { ok: true };
		} catch (reason) {
			return { ok: false, message: String(reason) };
		}
	}, [backend]);
	const decide = useCallback(
		async (_taskId: string, decisionId: string, optionId: string | null) => {
			try {
				await command(backend, "decision", {
					decisionId,
					optionId,
					runtimeSessionIncarnationId: session.summary?.runtimeSessionIncarnationId,
				});
				return { ok: true };
			} catch (reason) {
				return { ok: false, message: String(reason) };
			}
		},
		[backend, session.summary?.runtimeSessionIncarnationId],
	);
	const boundaryIndex = turns.findIndex((turn) => turn.id === boundaryTurnId);
	return (
		<section
			className="flex h-[42rem] min-h-0 min-w-0 flex-col border-border md:h-full md:border-r"
			aria-label={backend === "codex_native" ? "原生 App Server" : "ACP"}
		>
			<div className="space-y-2 border-b border-border p-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className="font-semibold">
						{backend === "codex_native" ? "原生 App Server" : "ACP + 原生证据桥接"}
					</h2>
					<span className="text-xs text-text-secondary">
						{session.summary?.turnOwner === "agent" ? "执行中" : session.summary?.pid ? "等待输入" : "未运行"} ·
						接受{session.summary?.agentConversationPromptSubmissionAcceptance?.status ?? "未知"}
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						disabled={isControlling || Boolean(session.summary?.pid)}
						onClick={() => void runControl("start", { startInPlanMode })}
					>
						启动／恢复
					</Button>
					<Button disabled={isControlling || !session.summary?.pid} onClick={() => void runControl("stop")}>
						停止会话
					</Button>
					<Button disabled={isControlling || !session.summary?.pid} onClick={() => void runControl("history")}>
						读取回合
					</Button>
					<label className="flex items-center gap-1 text-xs">
						<input
							type="checkbox"
							checked={startInPlanMode}
							disabled={Boolean(session.summary?.pid)}
							onChange={(event) => setStartInPlanMode(event.target.checked)}
						/>
						新会话先规划
					</label>
				</div>
				<p className="break-all font-mono text-xs text-text-secondary">
					{session.summary?.agentNativeConversationSessionIdentity?.nativeSessionId ??
						session.recovery.nativeSessionId ??
						"启动后显示原生会话 ID"}
				</p>
				{turns.length > 1 ? (
					<div className="flex items-center gap-2">
						<NativeSelect
							aria-label="Rewind 边界"
							value={boundaryTurnId}
							onChange={(event) => setBoundaryTurnId(event.target.value)}
						>
							<option value="">选择要移除的起始回合</option>
							{turns.slice(1).map((turn) => (
								<option key={turn.id} value={turn.id}>
									{turn.id} · {turn.status}
								</option>
							))}
						</NativeSelect>
						<Button
							disabled={isControlling || boundaryIndex < 1}
							onClick={() =>
								void runControl("rewind", {
									boundaryTurnId,
									lastPreBoundaryTurnId: turns[boundaryIndex - 1]?.id,
								})
							}
						>
							保留原会话并 Rewind
						</Button>
					</div>
				) : null}
				{error ? (
					<p role="alert" className="text-sm text-status-red">
						{error}
					</p>
				) : null}
			</div>
			<div className="flex min-h-0 flex-1 flex-col">
				<AgentConversationChatPanel
					key={session.summary?.runtimeSessionIncarnationId ?? backend}
					taskId={backend}
					agentId="codex"
					summary={session.summary}
					incomingMessages={session.messages}
					onSendMessage={send}
					onCancelTurn={cancel}
					onResolveUserDecision={decide}
					composerPlaceholder="输入这一条路径的比较消息…"
					showComposerModeToggle={false}
				/>
			</div>
		</section>
	);
}
function ComparisonPage() {
	const [snapshot, setSnapshot] = useState<RuntimeCodexProtocolComparisonSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let stream: EventSource | null = null;
		const connect = () => {
			stream?.close();
			const token = readComparisonControlToken();
			if (!token) {
				setError("请使用启动命令提供的完整地址连接隔离宿主。");
				return;
			}
			stream = new EventSource(`/codex-comparison-api/events?controlToken=${encodeURIComponent(token)}`);
			stream.onmessage = (event) => {
				try {
					setSnapshot(runtimeCodexProtocolComparisonSnapshotSchema.parse(JSON.parse(event.data)));
					setError(null);
				} catch {
					setError("比较状态格式无效，已保留当前界面。");
				}
			};
			stream.onerror = () => setError("与比较宿主断开，正在自动重连；未重发输入。");
		};
		connect();
		window.addEventListener("hashchange", connect);
		return () => {
			window.removeEventListener("hashchange", connect);
			stream?.close();
		};
	}, []);
	return (
		<main className="flex h-dvh min-h-0 flex-col overflow-y-auto bg-surface-0 text-text-primary md:overflow-hidden">
			<header className="shrink-0 space-y-1 border-b border-border p-4">
				<h1 className="text-lg font-semibold">Codex 协议比较</h1>
				<p className="text-sm text-text-secondary">
					两条路径共用只读沙箱和聊天投递逻辑，扩权时询问。Rewind 创建历史分支；工作区文件保持当前内容。
				</p>
				{snapshot ? (
					<p className="break-all text-xs text-text-secondary">
						模型 {snapshot.modelId} · 隔离目录 {snapshot.workingDirectory}
					</p>
				) : (
					<p role="status">正在连接隔离比较宿主…</p>
				)}
				{error ? (
					<p role="alert" className="text-sm text-status-red">
						{error}
					</p>
				) : null}
			</header>
			{snapshot ? (
				<div className="grid min-h-0 flex-1 md:grid-cols-2">
					<ComparisonPane backend="codex_native" snapshot={snapshot} />
					<ComparisonPane backend="codex_acp" snapshot={snapshot} />
				</div>
			) : null}
		</main>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("比较界面缺少根元素。");
createRoot(root).render(
	<TooltipProvider>
		<ExpandedForegroundViewProvider>
			<ComparisonPage />
		</ExpandedForegroundViewProvider>
	</TooltipProvider>,
);
