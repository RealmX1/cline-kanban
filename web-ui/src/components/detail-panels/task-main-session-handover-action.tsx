import { ArrowRightLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
	cancelTaskMainSessionHandover,
	prepareTaskMainSessionHandover,
	requestTaskMainSessionHandover,
	retryTaskMainSessionHandover,
} from "@/runtime/task-main-session-handover-query";
import type { RuntimeTaskSessionSummary, TaskMainSessionHandoverPrepareResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

const handoverStatusLabels = {
	waiting_for_sessions_to_stop: "正在等待相关会话停下，随后自动交接。",
	report_delivery_pending: "Codex 正在接任并读取交接材料。",
	awaiting_user_message: "Codex 已接任，汇报后等待你的下一条消息。",
	failed: "交接未完成，可查看原因并重试。",
	cancelled: "已取消交接。",
	completed: "主会话交接已完成。",
};

export function TaskMainSessionHandoverAction({
	workspaceId,
	taskCard,
	mainSessionSummary,
}: {
	workspaceId: string;
	taskCard: BoardCard;
	mainSessionSummary: RuntimeTaskSessionSummary;
}) {
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState<TaskMainSessionHandoverPrepareResponse | null>(null);
	const [target, setTarget] = useState("new_codex_session");
	const [notes, setNotes] = useState("");
	const [planPaths, setPlanPaths] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showWaitChoice, setShowWaitChoice] = useState(false);
	const requestId = useRef(createRandomUuidV4WithInsecureContextFallback());
	const requestEpoch = useRef(0);
	const record = taskCard.taskMainSessionHandover;
	useEffect(() => {
		requestEpoch.current += 1;
		setOpen(false);
		setPreview(null);
		setError(null);
		setBusy(false);
	}, [workspaceId, taskCard.id]);
	const isClaudeMain =
		mainSessionSummary.agentId === "claude" ||
		(mainSessionSummary.agentId == null &&
			(taskCard.mostRecentlyLaunchedAgentSessionAgentId ?? taskCard.agentId) === "claude");
	if (!isClaudeMain && !record) return null;
	const inProgress =
		record &&
		["waiting_for_sessions_to_stop", "report_delivery_pending", "awaiting_user_message"].includes(record.status);
	const targetIsBusy =
		preview?.busyTaskConversationSessionIds.includes(preview.mainTaskConversationSessionId) ||
		(target !== "new_codex_session" && preview?.busyTaskConversationSessionIds.includes(target));
	async function openPreview() {
		const epoch = ++requestEpoch.current;
		setOpen(true);
		setBusy(true);
		setError(null);
		setPreview(null);
		setTarget("new_codex_session");
		setShowWaitChoice(false);
		setNotes("");
		setPlanPaths("");
		requestId.current = createRandomUuidV4WithInsecureContextFallback();
		try {
			const result = await prepareTaskMainSessionHandover(workspaceId, taskCard.id);
			if (requestEpoch.current === epoch) setPreview(result);
		} catch (cause) {
			if (requestEpoch.current === epoch) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (requestEpoch.current === epoch) setBusy(false);
		}
	}
	async function submit() {
		if (!preview) return;
		const epoch = requestEpoch.current;
		if (targetIsBusy && !showWaitChoice) {
			setShowWaitChoice(true);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await requestTaskMainSessionHandover(workspaceId, {
				taskId: taskCard.id,
				expectedMainTaskConversationSessionId: preview.mainTaskConversationSessionId,
				requestId: requestId.current,
				destination:
					target === "new_codex_session"
						? { kind: "new_codex_session" }
						: { kind: "existing_codex_session", taskConversationSessionId: target },
				userContextNotes: notes,
				additionalPlanReferencePaths: planPaths
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			});
			if (requestEpoch.current === epoch) setOpen(false);
		} catch (cause) {
			if (requestEpoch.current === epoch) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (requestEpoch.current === epoch) setBusy(false);
		}
	}
	async function actOnRecord(action: "cancel" | "retry") {
		const epoch = requestEpoch.current;
		setBusy(true);
		setError(null);
		try {
			await (action === "cancel" ? cancelTaskMainSessionHandover : retryTaskMainSessionHandover)(
				workspaceId,
				taskCard.id,
			);
		} catch (cause) {
			if (requestEpoch.current === epoch) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (requestEpoch.current === epoch) setBusy(false);
		}
	}
	return (
		<div
			data-verification-anchor={`task-main-session-handover:${taskCard.id}`}
			className="border-b border-border px-2 py-2 text-xs text-text-secondary"
		>
			{record && record.status !== "completed" && (
				<div role="status" className="mb-2 space-y-1">
					<p>{handoverStatusLabels[record.status]}</p>
					{record.errorMessage && <p className="break-words text-status-red">{record.errorMessage}</p>}
					{(record.status === "waiting_for_sessions_to_stop" ||
						(record.status === "failed" &&
							mainSessionSummary.taskId === record.sourceTaskConversationSessionId)) && (
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => void actOnRecord("cancel")}>
							取消等待
						</Button>
					)}
					{record.status === "failed" && (
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => void actOnRecord("retry")}>
							重试交接
						</Button>
					)}
				</div>
			)}
			{!inProgress && isClaudeMain && (
				<Button size="sm" variant="ghost" icon={<ArrowRightLeft size={14} />} onClick={() => void openPreview()}>
					交接给 Codex
				</Button>
			)}
			{error && !open && (
				<p role="alert" className="mt-1 break-words text-status-red">
					{error}
				</p>
			)}
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!busy) setOpen(value);
				}}
				contentClassName="max-w-2xl"
			>
				<DialogHeader title={showWaitChoice ? "等待会话停下后交接" : "交接主会话给 Codex"} />
				<DialogBody className="space-y-4 overflow-y-auto">
					{busy && !preview && <p role="status">正在读取交接材料…</p>}
					{error && (
						<p role="alert" className="break-words text-status-red">
							{error}
						</p>
					)}
					{preview &&
						(showWaitChoice ? (
							<p>
								原 Claude 或所选 Codex
								仍在生成内容。选择等待后，会在两者都停下时自动交接；关闭浏览器后仍会继续等待。
							</p>
						) : (
							<>
								<label className="block space-y-1 text-sm">
									<span>接收会话</span>
									<select
										aria-label="接收会话"
										className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-text-primary"
										value={target}
										onChange={(event) => setTarget(event.target.value)}
									>
										<option value="new_codex_session">新建 Codex 会话（默认）</option>
										{preview.codexPeerTaskConversationSessionIds.map((id) => (
											<option key={id} value={id}>
												已有 Codex：{id}
											</option>
										))}
									</select>
								</label>
								<div className="space-y-2 text-sm">
									<p className="font-medium text-text-primary">交接材料</p>
									<p className="break-words">
										阶段目标：{preview.material.currentWorkPhaseGoal ?? "尚未记录"}
									</p>
									{preview.material.planReferences.map((plan) => (
										<p key={plan.absolutePath} className="break-all">
											计划：{plan.absolutePath}（
											{plan.approvalStatus === "approved" ? "有批准证据" : "批准状态待确认"}）
										</p>
									))}
									{preview.material.transcriptReferences.map((path) => (
										<p key={path} className="break-all">
											transcript：{path}
										</p>
									))}
									<details>
										<summary className="cursor-pointer">查看最后一条 agent 消息</summary>
										<p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
											{preview.material.lastAgentMessage?.text ?? "缺失"}
										</p>
									</details>
									{preview.material.missingMaterialDescriptions.length > 0 && (
										<div className="space-y-1">
											<p>以下材料尚未确认，仍可交接：</p>
											<ul className="list-disc space-y-1 pl-5">
												{preview.material.missingMaterialDescriptions.map((description) => (
													<li key={description}>{description}</li>
												))}
											</ul>
										</div>
									)}
								</div>
								<label className="block space-y-1 text-sm">
									<span>补充计划路径（可选，每行一个）</span>
									<textarea
										aria-label="补充计划路径"
										className="min-h-16 w-full rounded-md border border-border bg-surface-2 p-2 text-text-primary"
										value={planPaths}
										onChange={(event) => setPlanPaths(event.target.value)}
									/>
								</label>
								<label className="block space-y-1 text-sm">
									<span>补充交接说明（可选）</span>
									<textarea
										aria-label="补充交接说明"
										className="min-h-20 w-full rounded-md border border-border bg-surface-2 p-2 text-text-primary"
										value={notes}
										onChange={(event) => setNotes(event.target.value)}
									/>
								</label>
								<p className="text-sm">Codex 会先汇报计划总览、已经实现和有待进行，然后等待你的消息。</p>
							</>
						))}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
						{showWaitChoice ? "暂不交接" : "取消"}
					</Button>
					<Button disabled={busy || !preview} autoFocus={showWaitChoice} onClick={() => void submit()}>
						{showWaitChoice ? "等待两者都停下后自动交接" : "确认交接"}
					</Button>
				</DialogFooter>
			</Dialog>
		</div>
	);
}
