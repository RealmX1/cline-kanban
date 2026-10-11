// 「这段对话没有落进 agent 自己的会话存储」的终端面板提示条（目前只有 Cursor 会产出这类观测）。
//
// 两种形态：
//   - 首轮未在启动窗口内落盘（会话还活着）：说明原因；若认出了 Workspace Trust 对话框，告诉人去终端里应答。
//   - 对话从未建立（进程已退 / 续跑被预检拒绝）：续跑注定接不上任何东西，「刷新」也一样。给两条能走通的出路：
//       ① 用原 prompt 全新开局（会真的把 prompt 再发一遍——例如 `/cline-kanban-local-deploy` 会真的去部署，所以先确认）；
//       ② 从既有对话迁入（例如同 prompt 的另一张卡留下的孤儿对话），迁入后按 id 续跑、不重发 prompt。
// 迁入哪一段由人决定，kanban 不替人挑。

import { AlertTriangle, History, Play } from "lucide-react";
import { type ReactElement, useState } from "react";

import { TaskAgentSessionInitializationControl } from "@/components/task-agent-session-initialization-control";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeTaskAgentSessionInitialization, RuntimeTaskSessionSummary } from "@/runtime/types";

// 搜索框按子串匹配标题 / 消息：取原 prompt 第一行的前 60 个字，足够把同 prompt 的对话搜出来。
function summarizeTaskPromptForAgentSessionSearch(taskPrompt: string): string {
	return (taskPrompt.trim().split("\n")[0] ?? "").slice(0, 60);
}

interface AgentNativeConversationPersistenceRecoveryNoticeProps {
	summary: RuntimeTaskSessionSummary | null;
	workspaceId: string | null;
	originalTaskPromptForFreshStart: string | null;
	isRestartingAgentSession: boolean;
	onStartFreshAgentSessionWithOriginalTaskPrompt?: () => Promise<void>;
	onAdoptExistingAgentConversationAndResume: (initialization: RuntimeTaskAgentSessionInitialization) => Promise<void>;
}

// 恢复条的本地状态（选中的待迁入对话、两个弹窗的开关、迁入选择器内部的搜索状态）只属于一条会话。
// 宿主 AgentTerminalPanel 在切换详情卡片 / 子会话时复用同一个实例（渲染处没有按会话区分的 key），
// 不按会话身份重挂载的话，上一条会话里选中的对话会带到下一条会话、「迁入并续跑」直接可点，
// 把错误的对话复制进另一张卡的工作目录并钉成它的身份。所以按 summary.taskId 给内层加 key：会话一变整棵子树重挂载。
export function AgentNativeConversationPersistenceRecoveryNotice(
	props: AgentNativeConversationPersistenceRecoveryNoticeProps,
): ReactElement {
	return (
		<AgentNativeConversationPersistenceRecoveryNoticeScopedToOneTaskSession
			key={props.summary?.taskId ?? "no-task-session-summary"}
			{...props}
		/>
	);
}

function AgentNativeConversationPersistenceRecoveryNoticeScopedToOneTaskSession({
	summary,
	workspaceId,
	originalTaskPromptForFreshStart,
	isRestartingAgentSession,
	onStartFreshAgentSessionWithOriginalTaskPrompt,
	onAdoptExistingAgentConversationAndResume,
}: AgentNativeConversationPersistenceRecoveryNoticeProps): ReactElement | null {
	const [isFreshStartConfirmOpen, setIsFreshStartConfirmOpen] = useState(false);
	const [isAdoptDialogOpen, setIsAdoptDialogOpen] = useState(false);
	const [selectedAgentConversationToAdopt, setSelectedAgentConversationToAdopt] = useState<
		RuntimeTaskAgentSessionInitialization | undefined
	>(undefined);
	const observation = summary?.agentNativeConversationPersistenceObservation;
	if (!observation || observation.persistenceStatus === "conversation_established_in_agent_native_store") {
		return null;
	}
	const waitingOnWorkspaceTrustDialog =
		observation.suspectedBlockingCause === "agent_workspace_trust_prompt_awaiting_answer";

	if (observation.persistenceStatus === "first_prompt_not_persisted_within_startup_window") {
		return (
			<div className="flex items-start gap-2 border-t border-status-orange/30 bg-status-orange/10 px-3 py-2 text-[12px] text-status-orange">
				<AlertTriangle size={14} className="mt-0.5 shrink-0" />
				<span>
					{waitingOnWorkspaceTrustDialog
						? "对话还没建立：终端里停在 Workspace Trust 对话框上。确认这个目录可信后在终端里按 a，prompt 会随即提交。"
						: "对话还没建立：首个 prompt 还没进入 agent 的会话存储。看一眼终端，agent 可能在等你操作。"}
				</span>
			</div>
		);
	}

	const canStartFreshWithOriginalTaskPrompt =
		onStartFreshAgentSessionWithOriginalTaskPrompt !== undefined &&
		originalTaskPromptForFreshStart !== null &&
		originalTaskPromptForFreshStart.trim().length > 0;
	return (
		<div className="flex flex-col gap-2 border-t border-status-orange/30 bg-status-orange/10 px-3 py-2 text-[12px]">
			<div className="flex items-start gap-2 text-status-orange">
				<AlertTriangle size={14} className="mt-0.5 shrink-0" />
				<span>
					这段对话从未在 agent 的会话存储里建立
					{waitingOnWorkspaceTrustDialog ? "（当时停在了 Workspace Trust 对话框）" : ""}
					，没有东西可以续跑——刷新终端也一样。
				</span>
			</div>
			<div className="flex flex-wrap gap-2">
				{canStartFreshWithOriginalTaskPrompt ? (
					<Button
						size="sm"
						variant="default"
						disabled={isRestartingAgentSession}
						onClick={() => setIsFreshStartConfirmOpen(true)}
					>
						<Play size={12} />
						<span className="ml-1.5">用原 prompt 全新开局</span>
					</Button>
				) : null}
				<Button
					size="sm"
					variant="default"
					disabled={isRestartingAgentSession}
					onClick={() => setIsAdoptDialogOpen(true)}
				>
					{isRestartingAgentSession ? <Spinner size={12} /> : <History size={12} />}
					<span className="ml-1.5">从既有 {summary?.agentId === "cursor" ? "Cursor " : ""}对话迁入…</span>
				</Button>
			</div>
			<AlertDialog
				open={isFreshStartConfirmOpen}
				onOpenChange={(isOpen) => {
					if (!isOpen) {
						setIsFreshStartConfirmOpen(false);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>用原 prompt 全新开局？</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						会以一段全新的对话启动 agent，并把下面这段 prompt 原样再发一遍。prompt 里的指令会被真的执行一次。
					</AlertDialogDescription>
					<pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-[12px] text-text-primary">
						{originalTaskPromptForFreshStart}
					</pre>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsFreshStartConfirmOpen(false)}>
							取消
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							onClick={() => {
								setIsFreshStartConfirmOpen(false);
								void onStartFreshAgentSessionWithOriginalTaskPrompt?.();
							}}
						>
							全新开局
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
			<AlertDialog
				open={isAdoptDialogOpen}
				onOpenChange={(isOpen) => {
					if (!isOpen) {
						setIsAdoptDialogOpen(false);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>从既有对话迁入</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						选一段既有对话接到这个任务上：它会被复制进本任务的工作目录（源对话不受影响），之后按它的 id
						续跑，不会重发 prompt。
					</AlertDialogDescription>
					<div className="mt-3">
						<TaskAgentSessionInitializationControl
							agentId={summary?.agentId ?? undefined}
							defaultAgentId={summary?.agentId ?? null}
							workspaceId={workspaceId}
							value={selectedAgentConversationToAdopt}
							onChange={setSelectedAgentConversationToAdopt}
							onAgentIdChange={() => {}}
							initialSessionSearchScope="all_local_sessions"
							initialSessionSearchQuery={
								originalTaskPromptForFreshStart
									? summarizeTaskPromptForAgentSessionSearch(originalTaskPromptForFreshStart)
									: ""
							}
						/>
					</div>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsAdoptDialogOpen(false)}>
							取消
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							disabled={!selectedAgentConversationToAdopt}
							onClick={() => {
								if (!selectedAgentConversationToAdopt) {
									return;
								}
								setIsAdoptDialogOpen(false);
								void onAdoptExistingAgentConversationAndResume(selectedAgentConversationToAdopt);
							}}
						>
							迁入并续跑
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
