import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { buildProjectTaskDeepLinkUrl } from "@/hooks/app-utils";
import { useIndependentTaskCreation } from "@/hooks/use-independent-task-creation";
import {
	independentTaskCreationClient,
	loadIndependentTaskCreationProviders,
} from "@/runtime/independent-task-creation-query";
import type { NotificationProviderProfile } from "@/runtime/notification-intelligence-query";
import type { IndependentTaskCreationDraft } from "@/runtime/types";

const inputClassName =
	"w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-accent";

export function IndependentTaskCreationAction({
	workspaceId,
	sourceTaskId,
	sourceSessionId,
}: {
	workspaceId: string;
	sourceTaskId: string;
	sourceSessionId: string;
}) {
	const creation = useIndependentTaskCreation(workspaceId, sourceTaskId, sourceSessionId);
	const { draft, busy } = creation;
	const [allowIncompleteContext, setAllowIncompleteContext] = useState(false);
	const [providers, setProviders] = useState<NotificationProviderProfile[]>([]);
	const [derivedTasks, setDerivedTasks] = useState<{ taskId: string; title: string }[]>([]);
	useEffect(() => {
		let active = true;
		void independentTaskCreationClient(workspaceId)
			.list.query({ sourceTaskId, sourceTaskConversationSessionId: sourceSessionId })
			.then((result) => {
				if (active) setDerivedTasks(result.tasks);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [workspaceId, sourceTaskId, sourceSessionId, draft?.createdTaskId]);
	useEffect(() => {
		if (creation.open)
			void loadIndependentTaskCreationProviders()
				.then((profiles) =>
					setProviders(profiles.filter((profile) => profile.providerProtocol === "openai_compatible")),
				)
				.catch(() => {});
	}, [creation.open]);
	const unavailable =
		draft?.status === "waiting_for_source_turn" || draft?.status === "created" || draft?.status === "creating";
	return (
		<div
			className="px-2 pb-2"
			data-verification-anchor={`independent-task-creation:${sourceTaskId}:${sourceSessionId}`}
		>
			<Button size="sm" variant="ghost" icon={<GitBranch size={13} />} onClick={() => void creation.begin()}>
				分出独立任务
			</Button>
			{derivedTasks.map((task) => (
				<a
					key={task.taskId}
					className="block truncate py-1 text-xs text-accent underline"
					href={buildProjectTaskDeepLinkUrl(workspaceId, task.taskId)}
				>
					{task.title}
				</a>
			))}
			<Dialog
				open={creation.open}
				onOpenChange={(value) => {
					if (!value && !busy) void creation.close();
				}}
				contentClassName="max-w-2xl"
			>
				<DialogHeader title="分出独立任务" />
				<DialogBody className="space-y-4 text-sm text-text-secondary">
					<p>来源会话继续保留。新任务使用独立的工作树和会话身份。</p>
					{!draft && busy && <p role="status">正在固定来源材料…</p>}
					{draft?.status === "ready" && draft.contextCapturedAt === null && (
						<Button disabled={busy} onClick={() => void creation.begin(true)}>
							重新固定当前来源
						</Button>
					)}
					{(creation.error || draft?.errorMessage) && (
						<p role="alert" className="whitespace-pre-wrap break-words text-status-red">
							{creation.error || draft?.errorMessage}
						</p>
					)}
					{draft?.status === "waiting_for_source_turn" && (
						<p role="status">来源正在回答。等待本轮结束后固定材料，不会中断它。</p>
					)}
					{draft?.createdTaskId ? (
						<div className="space-y-3">
							<p>独立任务卡已创建。</p>
							<a
								className="text-accent underline"
								href={buildProjectTaskDeepLinkUrl(workspaceId, draft.createdTaskId)}
							>
								打开 {draft.title}
							</a>
							<Button variant="ghost" onClick={() => void creation.begin(true)}>
								再分出一个任务
							</Button>
						</div>
					) : (
						draft && (
							<fieldset disabled={Boolean(unavailable)} className="space-y-4 disabled:opacity-60">
								<label className="block space-y-1">
									<span>本次分出说明（可选）</span>
									<textarea
										aria-label="本次分出说明"
										className={`${inputClassName} min-h-20`}
										value={draft.userTaskDescription}
										onChange={(event) => creation.edit({ userTaskDescription: event.target.value })}
										placeholder="这次分出要完成什么；留空时自动建议"
									/>
								</label>
								<label className="block space-y-1">
									<span>任务上下文</span>
									<select
										aria-label="任务上下文"
										className={inputClassName}
										value={draft.contextInheritance}
										onChange={(event) =>
											creation.edit({
												contextInheritance: event.target
													.value as IndependentTaskCreationDraft["contextInheritance"],
											})
										}
									>
										<option value="fork_source_conversation" disabled={Boolean(draft.forkUnavailableReason)}>
											完整继承来源会话（默认）
										</option>
										<option value="fresh_conversation">全新上下文，只提供 Initial Prompt</option>
									</select>
								</label>
								{draft.forkUnavailableReason ? (
									<p className="text-status-yellow">
										完整继承不可用：{draft.forkUnavailableReason} 请选全新上下文。
									</p>
								) : (
									<p className="text-xs">
										完整继承也会带入历史 compaction 和上下文。自动建议使用单独整理的材料。
									</p>
								)}
								<label className="block space-y-1">
									<span>工作树来源</span>
									<select
										aria-label="工作树来源"
										className={inputClassName}
										value={draft.worktreeSource}
										onChange={(event) =>
											creation.edit({
												worktreeSource: event.target
													.value as IndependentTaskCreationDraft["worktreeSource"],
											})
										}
									>
										<option value="local_main_immediately">立即从 local main 新建（默认）</option>
										<option value="local_main_after_source_task_landed">
											先存 Backlog，来源完成并合入后手动启动
										</option>
										<option value="copy_source_git_working_state_immediately">
											立即复制来源 Git 工作状态（包含 dirty）
										</option>
									</select>
								</label>
								<p className="text-xs">
									{draft.worktreeSource === "copy_source_git_working_state_immediately"
										? "创建时复制 HEAD、未合入提交、staged、unstaged 和非 ignored 的 untracked 文件，保留暂存区别。"
										: draft.worktreeSource === "local_main_after_source_task_landed"
											? "现在只建卡；启动时从当时的 local main 建树。服务端会核验来源成果已合入。"
											: "创建时使用 local main；来源任务尚未合入的工作不会自动包含。"}
								</p>
								<details className="text-xs">
									<summary className="cursor-pointer">
										查看固定时的 Git 状态（未合入提交：{draft.sourceCommitsNotInLocalMain ?? "未知"}）
									</summary>
									<pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">
										{draft.sourceGitStatus || "工作树干净"}
									</pre>
								</details>
								{draft.contextWarnings.length > 0 && (
									<div className="space-y-2 rounded-md border border-border p-3">
										<p>来源材料有缺口，已保留完整可用原文：</p>
										<ul className="list-disc pl-5">
											{draft.contextWarnings.map((warning) => (
												<li key={warning}>{warning}</li>
											))}
										</ul>
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={allowIncompleteContext}
												onChange={(event) => setAllowIncompleteContext(event.target.checked)}
											/>
											根据现有材料生成
										</label>
									</div>
								)}
								<div className="flex flex-wrap items-end gap-2">
									<label className="min-w-0 flex-1 space-y-1">
										<span>建议生成模型</span>
										<select
											aria-label="建议生成模型"
											className={inputClassName}
											value={draft.modelProviderId ?? ""}
											onChange={(event) =>
												creation.edit({ modelProviderId: event.target.value || undefined })
											}
										>
											<option value="">默认绑定（未指定时 DeepSeek Flash）</option>
											{providers.map((provider) => (
												<option key={provider.modelProviderId} value={provider.modelProviderId}>
													{provider.displayName}
												</option>
											))}
										</select>
									</label>
									<Button
										variant="default"
										disabled={
											busy ||
											draft.contextCapturedAt === null ||
											(draft.contextWarnings.length > 0 && !allowIncompleteContext)
										}
										onClick={() => void creation.generate(allowIncompleteContext)}
									>
										{busy ? "正在处理…" : "更新草稿"}
									</Button>
								</div>
								<label className="block space-y-1">
									<span>任务标题</span>
									<input
										aria-label="任务标题"
										maxLength={80}
										className={inputClassName}
										value={draft.title}
										onChange={(event) =>
											creation.edit({ title: event.target.value, titleWasEditedByUser: true })
										}
									/>
								</label>
								<label className="block space-y-1">
									<span>建议生成方式</span>
									<select
										aria-label="建议生成方式"
										className={inputClassName}
										value={draft.generationSource}
										onChange={(event) =>
											creation.edit({
												generationSource: event.target
													.value as IndependentTaskCreationDraft["generationSource"],
											})
										}
									>
										<option value="kanban_model_provider">Kanban 模型 API（默认）</option>
										<option
											value="source_agent_fork"
											disabled={Boolean(draft.sourceAgentGenerationUnavailableReason)}
										>
											从固定来源另开 Agent 分身
										</option>
									</select>
								</label>
								{draft.generationSource === "source_agent_fork" && (
									<p className="text-status-yellow">
										会额外调用来源 Agent，完整历史可能产生较高费用。点击更新草稿或创建才执行，不修改来源对话。
									</p>
								)}
								{draft.sourceAgentGenerationUnavailableReason && (
									<p className="text-xs">{draft.sourceAgentGenerationUnavailableReason}</p>
								)}
								<label className="block space-y-1">
									<span>Initial Prompt（必填，可手动编辑）</span>
									<textarea
										aria-label="Initial Prompt"
										className={`${inputClassName} min-h-40`}
										value={draft.initialPrompt}
										onChange={(event) =>
											creation.edit({
												initialPrompt: event.target.value,
												initialPromptWasEditedByUser: true,
											})
										}
									/>
								</label>
								<p className="text-xs">
									输入会自动保存；更新草稿保留你手改的标题和 Initial Prompt。不会在每次按键时调用模型。
								</p>
							</fieldset>
						)
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={() => void creation.close()}>
						关闭
					</Button>
					{!draft?.createdTaskId && (
						<Button
							disabled={
								busy ||
								!draft ||
								draft.contextCapturedAt === null ||
								Boolean(unavailable) ||
								!draft.title.trim() ||
								!draft.initialPrompt.trim() ||
								(draft.contextInheritance === "fork_source_conversation" &&
									Boolean(draft.forkUnavailableReason))
							}
							onClick={() => void creation.create(allowIncompleteContext)}
						>
							{draft?.worktreeSource === "local_main_after_source_task_landed"
								? "创建 Backlog 任务"
								: "创建并启动"}
						</Button>
					)}
				</DialogFooter>
			</Dialog>
		</div>
	);
}
