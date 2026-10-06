// 「要续跑的对话正被 harness 后台会话（Claude `/background`）占着、不能安全收回」的终端面板提示条。
//
// 服务端续跑预检拒绝时写入 summary sidecar（api-contract 的
// runtimeAgentNativeConversationHeldByHarnessBackgroundSessionObservationSchema），并武装盯梢。这里给人三条路：
//   ① 等：kanban 正在盯，能安全收回（idle 且输入框为空）时自动接回这个终端；盯梢有时限，过时会说明；
//   ② 去那边处理：复制 `claude attach <id>`，把草稿 / 对话框处理完再回来；
//   ③ 停止后台会话并在这里续跑：确认后无条件接管——在途回合、等着的对话框、没提交的输入（包括外部编辑器里的
//      草稿）都会丢，已记录的对话保留。
// 为什么不在这里替人判断：「能不能丢」只有人知道，服务端只负责在安全时自动接回。

import { AlertTriangle, Copy, Hand } from "lucide-react";
import { type ReactElement, useState } from "react";

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
import type { RuntimeHarnessBackgroundSessionReclaimBlockedReason, RuntimeTaskSessionSummary } from "@/runtime/types";

const DESCRIPTION_OF_WHY_HARNESS_BACKGROUND_SESSION_WAS_NOT_RECLAIMED: Record<
	RuntimeHarnessBackgroundSessionReclaimBlockedReason,
	string
> = {
	background_session_generating_response_mid_turn: "它正在跑一个回合",
	background_session_waiting_for_user_decision: "它停在一个等你回答的对话框或权限请求上",
	background_session_input_box_has_unsent_text_or_is_hidden:
		"它的输入框里有没提交的内容，或输入框被外部编辑器（Ctrl+G）等盖住了",
	background_session_activity_status_unrecognized: "看不出它此刻是否空闲",
	background_session_did_not_release_after_stop: "停止它之后它仍没有释放这段对话",
};

interface AgentConversationHeldByHarnessBackgroundSessionNoticeProps {
	summary: RuntimeTaskSessionSummary | null;
	isRestartingAgentSession: boolean;
	onForceStopHarnessBackgroundSessionAndResumeHere: () => Promise<void>;
}

export function AgentConversationHeldByHarnessBackgroundSessionNotice({
	summary,
	isRestartingAgentSession,
	onForceStopHarnessBackgroundSessionAndResumeHere,
}: AgentConversationHeldByHarnessBackgroundSessionNoticeProps): ReactElement | null {
	const [isTakeoverConfirmOpen, setIsTakeoverConfirmOpen] = useState(false);
	const [hasCopiedAttachCommand, setHasCopiedAttachCommand] = useState(false);
	const observation = summary?.agentNativeConversationHeldByHarnessBackgroundSessionObservation;
	if (!observation) {
		return null;
	}
	const attachCommand = `claude attach ${observation.harnessBackgroundSessionShortId}`;
	const copyAttachCommand = async () => {
		try {
			await navigator.clipboard.writeText(attachCommand);
			setHasCopiedAttachCommand(true);
		} catch {
			// 剪贴板不可用（非安全上下文等）时命令本身就在文案里，人可以手动选中复制。
		}
	};
	return (
		<div className="flex flex-col gap-2 border-t border-status-orange/30 bg-status-orange/10 px-3 py-2 text-[12px]">
			<div className="flex items-start gap-2 text-status-orange">
				<AlertTriangle size={14} className="mt-0.5 shrink-0" />
				<span>
					这段对话在 Claude Code 后台会话 {observation.harnessBackgroundSessionShortId} 里（终端里执行过
					/background），
					{DESCRIPTION_OF_WHY_HARNESS_BACKGROUND_SESSION_WAS_NOT_RECLAIMED[observation.reclaimBlockedReason]}
					，为了不丢东西没有自动收回。
					{observation.automaticReclaimWatchActive
						? "Kanban 正在盯着它，能安全收回时会自动接回这个终端。"
						: // 停止的原因不止一种（时限、人工停止 / 启动、运行时重启、终端里已有活会话……），观测里也不记是哪一种，
							// 所以不在文案里枚举，免得列举跟不上取消点而说错。
							"Kanban 已停止自动等待；处理完后重启终端即可接回。"}
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					variant="default"
					disabled={isRestartingAgentSession}
					onClick={() => setIsTakeoverConfirmOpen(true)}
				>
					{isRestartingAgentSession ? <Spinner size={12} /> : <Hand size={12} />}
					<span className="ml-1.5">停止后台会话并在这里续跑</span>
				</Button>
				<Button size="sm" variant="ghost" onClick={() => void copyAttachCommand()}>
					<Copy size={12} />
					<span className="ml-1.5 font-mono">{hasCopiedAttachCommand ? "已复制" : attachCommand}</span>
				</Button>
			</div>
			<AlertDialog
				open={isTakeoverConfirmOpen}
				onOpenChange={(isOpen) => {
					if (!isOpen) {
						setIsTakeoverConfirmOpen(false);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>停止后台会话并在这里续跑？</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						会执行 <code className="font-mono">claude stop {observation.harnessBackgroundSessionShortId}</code>
						，再在这个终端里按 id
						续跑同一段对话。已记录的对话都会保留；正在进行的回合、等着你回答的对话框，以及没提交的输入（包括外部编辑器里的草稿）会丢失。需要保留的话，先用{" "}
						<code className="font-mono">{attachCommand}</code> 去那边处理。
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsTakeoverConfirmOpen(false)}>
							取消
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							onClick={() => {
								setIsTakeoverConfirmOpen(false);
								void onForceStopHarnessBackgroundSessionAndResumeHere();
							}}
						>
							停止并在这里续跑
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
