import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { resolveTaskConversationSessionMainContextForkSelection } from "@runtime-session-activity";
import { useEffect, useId, useRef, useState } from "react";
import {
	CreationWorkbenchContextControl,
	CreationWorkbenchStartupSettings,
} from "@/components/creation-workbench-startup-settings";
import { hostNonModalFloatingForm } from "@/components/host-non-modal-floating-form";
import { NonModalFloatingFormWindow } from "@/components/non-modal-floating-form-window";
import {
	TaskEditorHiddenSettingsManager,
	TaskEditorSettingGroup,
	TaskEditorSettingPresentationProvider,
} from "@/components/task-editor-setting-groups";
import { TaskNameInputWithAiSuggestions } from "@/components/task-name-input-with-ai-suggestions";
import { TaskPromptComposer } from "@/components/task-prompt-composer";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { useFormPrimaryActionSubmitKeyboardShortcut } from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";
import {
	previewTaskConversationSessionCreation,
	submitOrRecoverTaskConversationSessionCreation,
} from "@/runtime/task-conversation-session-creation-query";
import type { RuntimeCreationResolvedSettings, RuntimeTaskConversationSessionCreateRequest } from "@/runtime/types";
import {
	useHaveUserInterfacePreferencesLoadedFromServer,
	useSideSessionStartInPlanModePreference,
} from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";
import {
	haveUserInterfacePreferencesLoadedFromServer,
	readEffectiveUserInterfacePreferenceValue,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import {
	closeSideSessionCreationWorkbench,
	createSideSessionCreationDraft,
	persistSideSessionCreationDraft,
	readActiveSideSessionCreationDraft,
	type SideSessionCreationWorkbenchDraft,
	type SideSessionCreationWorkbenchTarget,
	updatePersistedSideSessionCreationDraftRequest,
	useSideSessionCreationWorkbenchTarget,
} from "@/state/side-session-creation-workbench-store";
import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";

const BY_THE_WAY_CREATION_AGENT_IDS = ["claude", "codex"] as const;
type SideSessionCreationRole = "task_collaborator" | "by_the_way";
type SideSessionDraftImages = NonNullable<RuntimeTaskConversationSessionCreateRequest["images"]>;

function mergeSideSessionDraftImages(
	current: RuntimeTaskConversationSessionCreateRequest["images"],
	incoming: RuntimeTaskConversationSessionCreateRequest["images"],
): SideSessionDraftImages {
	const merged = [...(current ?? [])];
	const seen = new Set(merged.map((image) => image.id));
	for (const image of incoming ?? []) {
		if (seen.has(image.id)) continue;
		merged.push(image);
		seen.add(image.id);
	}
	return merged;
}

interface LiveSideSessionDraftImageTarget {
	matches(draftId: string, sessionRole: SideSessionCreationRole): boolean;
	currentImages(): RuntimeTaskConversationSessionCreateRequest["images"];
	applyImages(images: SideSessionDraftImages): void;
}

// 后到的图片只交给仍显示同一草稿的窗口，不能覆盖其他任务或角色的正文。
const liveSideSessionDraftImageTargets = new Set<LiveSideSessionDraftImageTarget>();

function isByTheWayCreationAgent(agentId: string): boolean {
	return (BY_THE_WAY_CREATION_AGENT_IDS as readonly string[]).includes(agentId);
}

function sideSessionPlanPreferenceField(role: "task_collaborator" | "by_the_way") {
	return role === "task_collaborator" ? "newPeerSessionStartInPlanMode" : "newByTheWaySessionStartInPlanMode";
}

const startupSettingLabels = [
	{ key: "agent", label: "Agent" },
	{ key: "model", label: "模型与参数" },
	{ key: "plan_mode", label: "Plan Mode" },
	{ key: "permissions", label: "Agent 权限" },
	{ key: "codex_configuration_profile", label: "Codex profile" },
	{ key: "session_initialization", label: "会话上下文" },
];

export function SideSessionCreationWorkbench() {
	const target = useSideSessionCreationWorkbenchTarget();
	return target ? (
		<HostedSideSessionCreationWorkbench
			key={JSON.stringify([target.workspaceId, target.task.id, target.task.createdAt])}
			target={target}
			onClose={closeSideSessionCreationWorkbench}
		/>
	) : null;
}

function SideSessionCreationWorkbenchForm({
	target: boundTarget,
	onClose,
}: {
	target: SideSessionCreationWorkbenchTarget;
	onClose: () => void;
}) {
	const liveTarget = useSideSessionCreationWorkbenchTarget();
	const latestBoundTarget = useRef(boundTarget);
	if (
		liveTarget?.workspaceId === boundTarget.workspaceId &&
		liveTarget.task.id === boundTarget.task.id &&
		liveTarget.task.createdAt === boundTarget.task.createdAt &&
		liveTarget.mainSessionSummary.taskId === boundTarget.mainSessionSummary.taskId
	)
		latestBoundTarget.current = {
			...boundTarget,
			mainSessionSummary: liveTarget.mainSessionSummary,
			taskSessions: liveTarget.taskSessions,
		};
	const target = latestBoundTarget.current;
	const sessionFieldIdPrefix = useId();
	const [role, setRole] = useState<"task_collaborator" | "by_the_way">("task_collaborator");
	const [planPreference, setPlanPreference] = useSideSessionStartInPlanModePreference(role);
	const preferencesLoaded = useHaveUserInterfacePreferencesLoadedFromServer();
	const draftsAwaitingPlanPreferenceHydration = useRef(new Set<string>());
	const planEditedDraftIds = useRef(new Set<string>());
	const rememberNewDraftUntilPlanPreferenceHydrates = (draft: SideSessionCreationWorkbenchDraft) => {
		if (!haveUserInterfacePreferencesLoadedFromServer())
			draftsAwaitingPlanPreferenceHydration.current.add(draft.draftId);
		return draft;
	};
	const [initialDraftRecovery] = useState(() => {
		try {
			const saved = readActiveSideSessionCreationDraft(target, "task_collaborator");
			return {
				draft:
					saved ??
					rememberNewDraftUntilPlanPreferenceHydrates(
						createSideSessionCreationDraft(target, "task_collaborator", planPreference),
					),
				error: null,
			};
		} catch (cause) {
			return {
				draft: rememberNewDraftUntilPlanPreferenceHydrates(
					createSideSessionCreationDraft(target, "task_collaborator", planPreference),
				),
				error: String(cause),
			};
		}
	});
	const [draft, setDraft] = useState<SideSessionCreationWorkbenchDraft>(initialDraftRecovery.draft);
	const [error, setError] = useState<string | null>(initialDraftRecovery.error);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isPreparingImages, setIsPreparingImages] = useState(false);
	const [preview, setPreview] = useState<RuntimeCreationResolvedSettings | null>(null);
	const submissionInFlight = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const previewGeneration = useRef(0);
	const latestDraft = useRef(draft);
	latestDraft.current = draft;
	const request = draft.request;
	const defaultAgentId = role === "by_the_way" && !isByTheWayCreationAgent(target.agentId) ? "codex" : target.agentId;
	const agentId = request.agentId ?? target.agentId;
	const forkSelection = resolveTaskConversationSessionMainContextForkSelection({
		workspaceTaskId: target.task.id,
		launchAgentId: agentId,
		sessionRole: role,
		mainSessionSummary: target.mainSessionSummary,
		mainSessionWorkingDirectoryPath: target.mainSessionSummary.workspacePath,
		existingTaskConversationSessionSummaries: Object.values(target.taskSessions),
	});
	const contextSource = forkSelection.forkRejectionReason ? "fresh" : request.contextSource;
	const agents = target.agents?.filter((agent) => role !== "by_the_way" || isByTheWayCreationAgent(agent.id));
	const installed = agents?.find((agent) => agent.id === agentId)?.installed !== false;
	const canUseAgent =
		getRuntimeLaunchSupportedAgentCatalog().some((agent) => agent.id === agentId) &&
		installed &&
		(role !== "by_the_way" || isByTheWayCreationAgent(agentId));
	const persist = (next: SideSessionCreationWorkbenchDraft) => {
		latestDraft.current = next;
		setDraft(next);
		persistSideSessionCreationDraft(target, next, next.request.sessionRole);
	};
	const persistDraftRef = useRef(persist);
	persistDraftRef.current = persist;
	useEffect(() => {
		const imageTarget: LiveSideSessionDraftImageTarget = {
			matches(draftId, sessionRole) {
				const current = latestDraft.current;
				return current.draftId === draftId && current.request.sessionRole === sessionRole;
			},
			currentImages() {
				return latestDraft.current.request.images;
			},
			applyImages(images) {
				const current = latestDraft.current;
				if (current.pendingSubmission) return;
				persistDraftRef.current({ ...current, request: { ...current.request, images } });
			},
		};
		liveSideSessionDraftImageTargets.add(imageTarget);
		return () => {
			liveSideSessionDraftImageTargets.delete(imageTarget);
		};
	}, []);
	const update = (patch: Partial<RuntimeTaskConversationSessionCreateRequest>) => {
		if (isSubmitting || latestDraft.current.pendingSubmission) return;
		try {
			previewGeneration.current += 1;
			persist({ ...latestDraft.current, request: { ...latestDraft.current.request, ...patch } });
			setError(null);
			setPreview(null);
		} catch (cause) {
			setError(String(cause));
		}
	};
	const submit = async (frozenDraft = draft) => {
		if (submissionInFlight.current || isPreparingImages || !canUseAgent) return;
		submissionInFlight.current = true;
		setIsSubmitting(true);
		setError(null);
		try {
			const geometry = resolveAgentTerminalGeometryForTaskSessionSpawn(target.task.id);
			const frozen = frozenDraft.pendingSubmission ?? {
				...frozenDraft.request,
				contextSource,
				cols: geometry.cols,
				rows: geometry.rows,
			};
			// 请求发出前写盘；响应丢失和重启先核验原请求，不能换目标、设置或首条消息。
			persist({ ...frozenDraft, pendingSubmission: frozen });
			const result = await submitOrRecoverTaskConversationSessionCreation(target.workspaceId, frozen);
			const creation = result.creation;
			if (!result.ok && !creation) persist({ ...frozenDraft, pendingSubmission: undefined });
			// 确定失败或明确未启动的禁止结果要换新草稿，否则同一幂等请求会占住入口。
			// 尚未启动或启动结果未知则保留原提交，不能当成成功关掉窗口。
			if (creation?.status === "failed" || creation?.status === "execution_prohibited") {
				const replacement = createSideSessionCreationDraft(target, frozen.sessionRole, frozen.startInPlanMode);
				persist({ ...replacement, request: { ...frozenDraft.request, idempotencyKey: replacement.draftId } });
			}
			if (!creation || creation.status !== "started")
				throw new Error(result.error ?? creation?.notice ?? "创建未完成，原输入和提交身份已保留。");
			persistSideSessionCreationDraft(target, null, frozen.sessionRole, frozenDraft.draftId);
			if (mounted.current) {
				target.onCreated?.(creation.taskConversationSessionId);
				onClose();
			}
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			submissionInFlight.current = false;
			if (mounted.current) setIsSubmitting(false);
		}
	};
	useEffect(() => {
		if (draft.pendingSubmission) void submit(draft);
	}, []);
	useEffect(() => {
		if (!preferencesLoaded) return;
		const pendingDraftIds = [...draftsAwaitingPlanPreferenceHydration.current];
		for (const draftId of pendingDraftIds) {
			draftsAwaitingPlanPreferenceHydration.current.delete(draftId);
			if (planEditedDraftIds.current.has(draftId)) continue;
			const current = latestDraft.current;
			if (current.draftId === draftId) {
				if (current.pendingSubmission) continue;
				const preferred =
					readEffectiveUserInterfacePreferenceValue(sideSessionPlanPreferenceField(current.request.sessionRole)) ??
					false;
				if (current.request.startInPlanMode !== preferred)
					persist({ ...current, request: { ...current.request, startInPlanMode: preferred } });
				continue;
			}
			for (const pendingRole of ["task_collaborator", "by_the_way"] as const) {
				const saved = readActiveSideSessionCreationDraft(target, pendingRole);
				if (!saved || saved.draftId !== draftId || saved.pendingSubmission) continue;
				const preferred =
					readEffectiveUserInterfacePreferenceValue(sideSessionPlanPreferenceField(pendingRole)) ?? false;
				if (saved.request.startInPlanMode === preferred) break;
				persistSideSessionCreationDraft(
					target,
					{ ...saved, request: { ...saved.request, startInPlanMode: preferred } },
					pendingRole,
				);
				break;
			}
		}
	}, [planPreference, preferencesLoaded, role, target]);
	const handleKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: () => submit(),
		disabled: isSubmitting || isPreparingImages || !canUseAgent,
	});
	const selectRole = (nextRole: typeof role) => {
		if (isSubmitting) return;
		try {
			previewGeneration.current += 1;
			persistSideSessionCreationDraft(target, draft, role);
			setRole(nextRole);
			// 新类型的偏好由该类型的 hook 读取；草稿已存在时始终保留它自己的值。
			const nextPlanPreference =
				readEffectiveUserInterfacePreferenceValue(sideSessionPlanPreferenceField(nextRole)) ?? false;
			const savedNextDraft = readActiveSideSessionCreationDraft(target, nextRole);
			const nextDraft =
				savedNextDraft ??
				rememberNewDraftUntilPlanPreferenceHydrates(
					createSideSessionCreationDraft(target, nextRole, nextPlanPreference),
				);
			setDraft(nextDraft);
			setError(null);
			setPreview(null);
		} catch (cause) {
			setError(String(cause));
		}
	};
	return (
		<NonModalFloatingFormWindow
			open
			collapseControlLabel="会话创建"
			ownershipLabel={`${target.workspaceId} / ${target.task.title} · ${target.task.id}`}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			onClickCapture={undefined}
			onKeyDownCapture={undefined}
			title={role === "task_collaborator" ? "新建 Peer 会话" : "新建 By the way 会话"}
			onKeyDown={handleKeyDown}
		>
			<TaskEditorSettingPresentationProvider temporarilyRevealedKeys={new Set()}>
				<DialogBody>
					<p className="mb-3 break-words text-xs text-text-secondary">
						宿主：{target.task.title} · {target.task.id}
						<br />
						工作目录：{target.mainSessionSummary.workspacePath}
					</p>
					<label
						htmlFor={`${sessionFieldIdPrefix}-creation-workbench-session-role`}
						className="mb-1 block text-xs text-text-secondary"
					>
						创建类型
					</label>
					<NativeSelect
						id={`${sessionFieldIdPrefix}-creation-workbench-session-role`}
						value={role}
						disabled={isSubmitting}
						onChange={(event) => selectRole(event.currentTarget.value as typeof role)}
					>
						<option value="task_collaborator">Peer 协作会话</option>
						<option value="by_the_way">By the way</option>
					</NativeSelect>
					<fieldset disabled={isSubmitting || Boolean(draft.pendingSubmission)} className="mt-4 min-w-0 space-y-5">
						{/* 名称与正文各自挂在带前缀的 draftId 上，切换角色时分别卸载。 */}
						<TaskNameInputWithAiSuggestions
							key={`side-session-name:${draft.draftId}`}
							namingTarget="conversation_session"
							taskName={request.conversationSessionName ?? ""}
							onTaskNameChange={(conversationSessionName) => update({ conversationSessionName })}
							taskDescription={request.initialMessage}
						/>
						<TaskPromptComposer
							key={`side-session-prompt:${draft.draftId}`}
							id={`${sessionFieldIdPrefix}-creation-workbench-side-session-prompt`}
							workspaceId={target.workspaceId}
							minimumTextareaHeight={112}
							placeholder="首条消息可留空，创建后再输入…"
							value={request.initialMessage}
							onValueChange={(initialMessage) => update({ initialMessage })}
							images={request.images ?? []}
							onImagesChange={(value) => {
								// 发起读取的表单卸载后，内存里的 latestDraft 仍是关闭前正文。只能把后到的图片并入当前草稿。
								const ownerDraftId = draft.draftId;
								const ownerRole = role;
								const thisInstanceStillShowsDraft =
									mounted.current &&
									latestDraft.current.draftId === ownerDraftId &&
									latestDraft.current.request.sessionRole === ownerRole;
								if (thisInstanceStillShowsDraft) {
									update({ images: value });
									return;
								}
								const liveTarget = [...liveSideSessionDraftImageTargets].find((candidate) =>
									candidate.matches(ownerDraftId, ownerRole),
								);
								const liveShowsDraft = liveTarget?.matches(ownerDraftId, ownerRole) ?? false;
								const baseImages = liveShowsDraft
									? liveTarget?.currentImages()
									: readActiveSideSessionCreationDraft(target, ownerRole)?.request.images;
								const images = mergeSideSessionDraftImages(baseImages, value);
								updatePersistedSideSessionCreationDraftRequest(target, ownerRole, ownerDraftId, { images });
								if (liveShowsDraft) liveTarget?.applyImages(images);
							}}
							onImagePreparationPendingChange={setIsPreparingImages}
						/>
						<CreationWorkbenchStartupSettings
							active
							workspaceId={target.workspaceId}
							agentId={agentId}
							defaultAgentId={defaultAgentId}
							agents={agents}
							selectableAgentIds={role === "by_the_way" ? BY_THE_WAY_CREATION_AGENT_IDS : undefined}
							onAgentIdChange={(nextAgentId) =>
								update({
									agentId: nextAgentId ?? defaultAgentId,
									terminalAgentModelOverrideSettings: undefined,
									codexConfigurationProfileId: undefined,
									requestedAgentSessionTransport: undefined,
								})
							}
							terminalAgentModelOverrideSettings={request.terminalAgentModelOverrideSettings}
							onTerminalAgentModelOverrideSettingsChange={(terminalAgentModelOverrideSettings) =>
								update({ terminalAgentModelOverrideSettings })
							}
							startInPlanMode={request.startInPlanMode}
							onStartInPlanModeChange={(startInPlanMode) => {
								planEditedDraftIds.current.add(latestDraft.current.draftId);
								draftsAwaitingPlanPreferenceHydration.current.delete(latestDraft.current.draftId);
								update({ startInPlanMode });
								setPlanPreference(startInPlanMode);
							}}
							taskAgentPermissionMode={request.taskAgentPermissionMode ?? "bypass_all_permission_prompts"}
							onTaskAgentPermissionModeChange={(taskAgentPermissionMode) => update({ taskAgentPermissionMode })}
							codexConfigurationProfileId={request.codexConfigurationProfileId}
							onCodexConfigurationProfileIdChange={(codexConfigurationProfileId) =>
								update({ codexConfigurationProfileId, codexConfigurationPermissionSelectionSource: "profile" })
							}
							codexConfigurationPermissionSelectionSource={request.codexConfigurationPermissionSelectionSource}
							onCodexConfigurationPermissionSelectionSourceChange={(
								codexConfigurationPermissionSelectionSource,
							) => update({ codexConfigurationPermissionSelectionSource })}
							roleReadOnly={role === "by_the_way"}
						/>
						<TaskEditorSettingGroup
							title="更多设置"
							settings={[
								{
									key: "session_initialization",
									label: "会话上下文",
									summary: contextSource === "fresh" ? "全新上下文" : "复刻当前主会话",
									content: (
										<CreationWorkbenchContextControl
											sideSessionContext={{
												value: contextSource === "fresh" ? "fresh" : "current_main",
												onChange: (value) => update({ contextSource: value }),
												forkRejectionReason: forkSelection.forkRejectionReason,
											}}
										/>
									),
								},
							]}
						/>
						{agentId === "omp" && (
							<label
								htmlFor={`${sessionFieldIdPrefix}-side-session-creation-transport`}
								className="block text-xs text-text-secondary"
							>
								会话通道
								<NativeSelect
									id={`${sessionFieldIdPrefix}-side-session-creation-transport`}
									value={request.requestedAgentSessionTransport ?? ""}
									onChange={(event) =>
										update({
											requestedAgentSessionTransport: event.currentTarget.value
												? (event.currentTarget.value as "pty_terminal" | "acp_stdio_subprocess")
												: undefined,
										})
									}
								>
									<option value="">Agent 当前默认通道</option>
									<option value="pty_terminal">TUI</option>
									<option value="acp_stdio_subprocess">ACP</option>
								</NativeSelect>
							</label>
						)}
						<TaskEditorHiddenSettingsManager settings={startupSettingLabels} />
					</fieldset>
					<p className="mt-3 text-xs text-text-secondary">
						{role === "by_the_way" ? "持续只读。" : "共用宿主工作目录，主会话负责卡片生命周期。"}
					</p>
					{role === "by_the_way" && !isByTheWayCreationAgent(agentId) && (
						<p className="mt-2 text-xs text-text-secondary">By the way 只支持 Claude 与 Codex。</p>
					)}
					{preview && (
						<p role="status" className="mt-2 break-words text-xs text-text-secondary">
							Plan：{preview.startInPlanMode.value ? "开启" : "关闭"} · 模型：
							{preview.modelId.value ?? "Agent 默认配置"} · 权限：
							{preview.roleReadOnlyConstraint.value
								? "持续只读"
								: preview.requestedTaskAgentPermissionMode.value}
						</p>
					)}
					{error && (
						<p role="alert" className="mt-2 text-xs text-status-red">
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						size="sm"
						disabled={isSubmitting}
						onClick={() => {
							const generation = ++previewGeneration.current;
							void previewTaskConversationSessionCreation(target.workspaceId, { ...request, contextSource })
								.then((result) => {
									if (mounted.current && previewGeneration.current === generation) {
										setPreview(result.resolvedSettings);
										setError(result.error ?? null);
									}
								})
								.catch((cause) => {
									if (mounted.current && previewGeneration.current === generation) setError(String(cause));
								});
						}}
					>
						预览启动设置
					</Button>
					<Button
						size="sm"
						variant="primary"
						disabled={isSubmitting || isPreparingImages || !canUseAgent}
						onClick={() => void submit()}
					>
						{isSubmitting ? "正在创建…" : draft.pendingSubmission ? "核验原提交" : "创建会话"}
					</Button>
				</DialogFooter>
			</TaskEditorSettingPresentationProvider>
		</NonModalFloatingFormWindow>
	);
}

const HostedSideSessionCreationWorkbench = hostNonModalFloatingForm(SideSessionCreationWorkbenchForm, {
	formKind: "task-session-creation",
	openingRequestIdentity: (props) => props.target.openingRequestIdentity,
	isOpen: () => true,
	instanceIdentity: (props) =>
		JSON.stringify([props.target.workspaceId, props.target.task.id, props.target.task.createdAt]),
	ownership: (props) => ({
		workspaceId: props.target.workspaceId,
		taskId: props.target.task.id,
		taskIncarnationCreatedAtEpochMs: props.target.task.createdAt,
		conversationSessionId: props.target.mainSessionSummary.taskId,
	}),
	withClose: (props, close) => ({ ...props, onClose: close }),
	onClosed: (props) => props.onClose(),
});
