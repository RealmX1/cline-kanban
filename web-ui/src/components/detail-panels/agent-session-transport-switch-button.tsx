// agent 会话工具条上的「换一条通话通道」开关。
//
// 作用对象是**当前选中的那条 agent 会话**（工具条本身就是会话级的），不是整张卡。
// 切换语义：停掉当前会话 → 立刻用另一条通道续跑同一段对话。因为会停会话，所以先弹确认。
// 服务端一次做完（runtime.switchAgentSessionTransport），前端不做 stop→save→start 三连——
// 那会留下半切状态。失败时会话**停在已停止**并如实报错，不回滚也不降级。
//
// 两个面板都挂这个按钮：切过去之后你看的就是另一个面板（xterm ⇄ 会话面板），
// 只挂在其中一边就会变成「切得过去、切不回来」。
import {
	canAgentSessionTransportBeSwitched,
	getAgentSessionTransportLabel,
	getOppositeAgentSessionTransport,
} from "@runtime-agent-session-transport-selection";
import { ArrowLeftRight } from "lucide-react";
import { type ReactElement, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
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
import { Tooltip } from "@/components/ui/tooltip";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId, RuntimeAgentSessionTransport } from "@/runtime/types";

export function AgentSessionTransportSwitchButton({
	workspaceId,
	taskId,
	agentId,
	currentSessionTransport,
	iconSize = 14,
	variant = "default",
}: {
	workspaceId: string | null;
	// 这条 agent 会话的 id（工具条当前作用的会话），不是看板卡 id。
	taskId: string;
	agentId: RuntimeAgentId | null;
	currentSessionTransport: RuntimeAgentSessionTransport;
	iconSize?: number;
	variant?: "default" | "ghost";
}): ReactElement | null {
	const [isConfirmOpen, setIsConfirmOpen] = useState(false);
	const [isSwitching, setIsSwitching] = useState(false);

	const targetSessionTransport = agentId ? getOppositeAgentSessionTransport(agentId, currentSessionTransport) : null;
	// 只有真有第二条通道的 agent 才渲染这个按钮。
	if (!agentId || !workspaceId || !canAgentSessionTransportBeSwitched(agentId) || !targetSessionTransport) {
		return null;
	}

	const targetTransportLabel = getAgentSessionTransportLabel(targetSessionTransport);
	const currentTransportLabel = getAgentSessionTransportLabel(currentSessionTransport);

	const runSwitch = async (): Promise<void> => {
		setIsConfirmOpen(false);
		setIsSwitching(true);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.switchAgentSessionTransport.mutate({
				taskId,
				targetSessionTransport,
			});
			if (!response.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					// 如实说明「旧会话到底停了没有」：停了就必须让用户知道现在没有会话在跑。
					message: response.priorAgentSessionStopped
						? `The ${currentTransportLabel} session was stopped, but the ${targetTransportLabel} session could not start: ${response.error ?? "unknown error"}. Press Start to retry.`
						: `Could not switch to ${targetTransportLabel}: ${response.error ?? "unknown error"}`,
					timeout: 10000,
				});
			}
		} catch (error) {
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: `Could not switch to ${targetTransportLabel}: ${error instanceof Error ? error.message : String(error)}`,
				timeout: 10000,
			});
		} finally {
			setIsSwitching(false);
		}
	};

	return (
		<>
			<Tooltip side="top" content={`Switch this session to ${targetTransportLabel}`}>
				<Button
					icon={isSwitching ? <Spinner size={iconSize} /> : <ArrowLeftRight size={iconSize} />}
					variant={variant}
					size="sm"
					disabled={isSwitching}
					onClick={() => setIsConfirmOpen(true)}
					aria-label={`Switch this session to ${targetTransportLabel}`}
				/>
			</Tooltip>
			<AlertDialog
				open={isConfirmOpen}
				onOpenChange={(isOpen) => {
					if (!isOpen) {
						setIsConfirmOpen(false);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>{`Switch this session to ${targetTransportLabel}?`}</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						{`The current ${currentTransportLabel} session will be stopped and immediately reopened over ${targetTransportLabel}, continuing the same conversation. If the ${targetTransportLabel} session cannot start, the session stays stopped — nothing is rolled back.`}
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsConfirmOpen(false)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								void runSwitch();
							}}
						>
							{`Switch to ${targetTransportLabel}`}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
