import {
	AlertTriangle,
	ChevronDown,
	ChevronUp,
	CornerDownLeft,
	FileText,
	GitBranch,
	Globe,
	Plus,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { type PromptScope, type StoredPrompt, usePromptLibrary } from "@/hooks/use-prompt-library";

const COLLAPSED_PROMPT_TEXTAREA_VISIBLE_LINE_COUNT = 4;

const PROMPT_SCOPE_META: Record<
	PromptScope,
	{ label: string; tooltip: string; nextScope: PromptScope; icon: React.ReactElement }
> = {
	task: {
		label: "Task",
		tooltip: "This task only",
		nextScope: "repo",
		icon: <FileText size={14} />,
	},
	repo: {
		label: "Repo",
		tooltip: "This repo",
		nextScope: "global",
		icon: <GitBranch size={14} />,
	},
	global: {
		label: "Global",
		tooltip: "Global · all tasks & repos",
		nextScope: "task",
		icon: <Globe size={14} />,
	},
};

function formatPromptMetadataTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) {
		return "unknown";
	}
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// 只给「不是用户在面板里手写的」来源打标。`manual` 是绝大多数条目的情形，给它也挂一个徽标等于给
// 整个列表加一列永远为真的噪音；而这两种来源恰恰是用户**没有主动创建**、事后需要认出来的那些
// ——尤其抢占那一种：它是在用户不在场时由运行时替他写进来的。
const PROMPT_ORIGIN_BADGE_META: Partial<
	Record<NonNullable<StoredPrompt["origin"]>, { label: string; tooltip: string }>
> = {
	terminal_stash_by_user: {
		label: "Stashed",
		tooltip: "You pressed Ctrl+S in this task's terminal — the unsent input box text was saved here",
	},
	terminal_stash_preempted_by_programmatic_delivery: {
		label: "Auto-stashed",
		tooltip:
			"A programmatic delivery needed this terminal's input box while you were away. Your unsent text was saved here first, then the box was cleared — fill it back in with the ↵ button.",
	},
};

/**
 * 这段正文里有多少处折叠粘贴没能换回原文。
 *
 * 口径与 stash 当下那条 toast 完全一致：三项互斥（整框自洽性校验没过时一次都没配过），相加不重复计数；
 * 且**不**把输入侧账本的 `unrecoverablePasteCount` 加进来——两者会重叠，相加就是虚报。
 */
function countUnrecoveredFoldedPastesInPrompt(prompt: StoredPrompt): number {
	const fidelity = prompt.terminalInputBoxStashFidelity;
	if (!fidelity) {
		// 缺字段 ≠ 保真：手写条目与升级前存的条目本来就没有这个概念，不该凭空显示一个「0 处丢失」的保证。
		return 0;
	}
	return (
		fidelity.placeholdersLeftUnbackfilledBecausePayloadWasDropped +
		fidelity.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched +
		fidelity.placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed
	);
}

/**
 * 「这条不是你自己在面板里写的」徽标。
 *
 * 独立成组件而不是内联在 `PromptMetadataPill` 里：孤儿回收区的条目不复用 `PromptRow`（那里没有
 * scope 切换、没有可编辑正文），但**来源可辨识**这条呈现契约在那个入口同样成立——恰恰更成立，
 * 抢占来源的条目本就是用户不在场时被写进来的，落进回收区后更需要一眼认出来。
 */
function PromptOriginBadge({
	prompt,
	className,
}: {
	prompt: StoredPrompt;
	className?: string;
}): React.ReactElement | null {
	const originMeta = prompt.origin ? PROMPT_ORIGIN_BADGE_META[prompt.origin] : undefined;
	if (!originMeta) {
		return null;
	}
	return (
		<Tooltip content={originMeta.tooltip}>
			<span
				className={cn("pointer-events-auto shrink-0 rounded-full px-1.5 font-medium text-text-primary", className)}
			>
				{originMeta.label}
			</span>
		</Tooltip>
	);
}

function PromptMetadataPill({ prompt }: { prompt: StoredPrompt }): React.ReactElement {
	const scopeMeta = PROMPT_SCOPE_META[prompt.scope];
	return (
		<div className="pointer-events-none absolute -top-[7px] -left-2 z-10 flex max-w-[calc(100%+0.5rem)] items-center gap-1 overflow-hidden rounded-full border border-border-bright bg-surface-3 px-2 py-0.5 text-[10px] leading-4 text-text-secondary shadow-sm">
			<span className="shrink-0 font-medium text-text-primary">{scopeMeta.label}</span>
			<PromptOriginBadge prompt={prompt} className="bg-surface-1" />
			<span className="truncate">Created {formatPromptMetadataTimestamp(prompt.createdAt)}</span>
			<span className="shrink-0 text-text-tertiary">·</span>
			<span className="truncate">Edited {formatPromptMetadataTimestamp(prompt.updatedAt)}</span>
		</div>
	);
}

/**
 * 「这段正文里有 N 处粘贴还原不了」的常驻警告。
 *
 * 必须常驻在条目上，而不是只在暂存那一刻弹一次 toast：抢占来源的条目写进来时用户根本不在场，那条
 * toast 没有任何人看见；即便他当时在场，第二天翻面板时警告也早就没了，于是会把一份缺了几段的正文
 * 当成完好的填进 agent。
 */
function PromptFidelityWarning({ prompt }: { prompt: StoredPrompt }): React.ReactElement | null {
	const unrecoveredFoldedPasteCount = countUnrecoveredFoldedPastesInPrompt(prompt);
	if (unrecoveredFoldedPasteCount === 0) {
		return null;
	}
	return (
		<div className="flex items-center gap-1 px-1.5 pb-1 text-[10px] leading-4 text-status-orange">
			<AlertTriangle size={11} className="shrink-0" />
			<span className="truncate">
				{unrecoveredFoldedPasteCount} pasted section{unrecoveredFoldedPasteCount === 1 ? "" : "s"} could not be
				restored — the placeholder text is kept as-is
			</span>
		</div>
	);
}

function getCollapsedTextareaHeight(textarea: HTMLTextAreaElement): number {
	const styles = getComputedStyle(textarea);
	const lineHeight = Number.parseFloat(styles.lineHeight);
	const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
	const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
	const fallbackLineHeight = 20;
	return (
		(Number.isFinite(lineHeight) ? lineHeight : fallbackLineHeight) * COLLAPSED_PROMPT_TEXTAREA_VISIBLE_LINE_COUNT +
		paddingTop +
		paddingBottom
	);
}

function useAutosizedPromptTextarea({
	ref,
	value,
	isFocusedWithin,
	isExpanded,
	onOverflowChange,
}: {
	ref: React.RefObject<HTMLTextAreaElement | null>;
	value: string;
	isFocusedWithin: boolean;
	isExpanded: boolean;
	onOverflowChange: (hasOverflow: boolean) => void;
}): void {
	useLayoutEffect(() => {
		const textarea = ref.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		const fullHeight = textarea.scrollHeight;
		const collapsedHeight = getCollapsedTextareaHeight(textarea);
		const hasOverflow = fullHeight > collapsedHeight + 1;
		const shouldCollapse = hasOverflow && !isFocusedWithin && !isExpanded;
		textarea.style.height = `${shouldCollapse ? collapsedHeight : fullHeight}px`;
		textarea.style.overflowY = "hidden";
		onOverflowChange(hasOverflow);
	}, [ref, value, isFocusedWithin, isExpanded, onOverflowChange]);
}

function PromptRow({
	prompt,
	onChangeText,
	onToggleScope,
	onFill,
	onRemove,
	shouldAutoFocus,
	onAutoFocusHandled,
}: {
	prompt: StoredPrompt;
	onChangeText: (id: string, text: string) => void;
	onToggleScope: (id: string, scope: PromptScope) => void;
	onFill: (text: string) => void;
	onRemove: (id: string) => void;
	shouldAutoFocus: boolean;
	onAutoFocusHandled: () => void;
}): React.ReactElement {
	const [hasCollapsibleContent, setHasCollapsibleContent] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [isFocusedWithin, setIsFocusedWithin] = useState(false);
	const rowRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useAutosizedPromptTextarea({
		ref: textareaRef,
		value: prompt.text,
		isFocusedWithin,
		isExpanded,
		onOverflowChange: setHasCollapsibleContent,
	});

	useEffect(() => {
		if (!shouldAutoFocus) {
			return;
		}
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		onAutoFocusHandled();
	}, [shouldAutoFocus, onAutoFocusHandled]);

	const isGlobal = prompt.scope === "global";
	const canFill = prompt.text.trim().length > 0;
	const scopeMeta = PROMPT_SCOPE_META[prompt.scope];

	return (
		<div
			ref={rowRef}
			className="group relative mt-3 mb-4 rounded-md border border-border bg-surface-2 py-1 focus-within:border-border-focus"
			onFocus={() => setIsFocusedWithin(true)}
			onBlur={(event) => {
				const nextFocusedElement = event.relatedTarget instanceof Node ? event.relatedTarget : null;
				if (!rowRef.current?.contains(nextFocusedElement)) {
					setIsFocusedWithin(false);
				}
			}}
		>
			<PromptMetadataPill prompt={prompt} />
			<textarea
				ref={textareaRef}
				value={prompt.text}
				onChange={(event) => onChangeText(prompt.id, event.target.value)}
				placeholder="Prompt text…"
				rows={1}
				spellCheck={false}
				className="block min-h-[1.5rem] w-full resize-none overflow-x-hidden bg-transparent p-1.5 text-xs leading-5 text-text-primary placeholder:text-text-tertiary focus:outline-none"
			/>
			<PromptFidelityWarning prompt={prompt} />
			{hasCollapsibleContent ? (
				<Tooltip content={isExpanded ? "Collapse prompt" : "Show full prompt"}>
					<Button
						variant="ghost"
						size="xs"
						icon={isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
						aria-label={isExpanded ? "Collapse prompt" : "Show full prompt"}
						className="absolute bottom-0 left-2 z-20 -mb-3 border border-border-bright bg-surface-2 shadow-sm"
						onClick={() => setIsExpanded((current) => !current)}
					/>
				</Tooltip>
			) : null}
			<div className="pointer-events-none absolute right-2 bottom-0 z-20 -mb-3 flex items-center gap-0.5 rounded-md border border-border-bright bg-surface-2 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
				<Tooltip content={`${scopeMeta.tooltip} · click for next scope`}>
					<Button
						variant="ghost"
						size="xs"
						icon={scopeMeta.icon}
						aria-label="Change prompt scope"
						className={cn(isGlobal && "text-accent hover:text-accent")}
						onClick={() => onToggleScope(prompt.id, scopeMeta.nextScope)}
					/>
				</Tooltip>
				<Tooltip content="Fill into input">
					<Button
						variant="ghost"
						size="xs"
						icon={<CornerDownLeft size={14} />}
						aria-label="Fill prompt into input"
						disabled={!canFill}
						onClick={() => onFill(prompt.text)}
					/>
				</Tooltip>
				<Tooltip content="Delete">
					<Button
						variant="ghost"
						size="xs"
						icon={<Trash2 size={14} />}
						aria-label="Delete prompt"
						className="hover:text-status-red"
						onClick={() => onRemove(prompt.id)}
					/>
				</Tooltip>
			</div>
		</div>
	);
}

/**
 * 归属任务已经不在看板上的条目的回收入口。
 *
 * 为什么不在任务删除时直接把这些条目也删掉：prompt 是用户攒的**资产**，「删掉一个任务」不等于
 * 「销毁我为它写过的模板」。但只留在磁盘上而没有任何入口，等于用户永远拿不回来——所以它们必须
 * 在这里现身，并且只能由用户自己决定是认领还是删除。
 *
 * 默认折叠：这是个低频回收入口，不该在每次打开面板时都占掉正常条目的视线。
 */
function OrphanedPromptsSection({
	orphanedPrompts,
	isExpanded,
	onToggleExpanded,
	onClaim,
	onRemove,
	onFill,
}: {
	orphanedPrompts: StoredPrompt[];
	isExpanded: boolean;
	onToggleExpanded: () => void;
	onClaim: (id: string) => void;
	onRemove: (id: string) => void;
	onFill: (text: string) => void;
}): React.ReactElement {
	return (
		<div className="mt-2 rounded-md border border-border bg-surface-2">
			<button
				type="button"
				onClick={onToggleExpanded}
				className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-text-secondary hover:text-text-primary"
			>
				{isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
				<span className="flex-1 truncate">
					{orphanedPrompts.length} prompt{orphanedPrompts.length === 1 ? "" : "s"} from deleted tasks
				</span>
			</button>
			{isExpanded ? (
				<div className="flex flex-col gap-2 px-2 pb-2">
					{orphanedPrompts.map((prompt) => (
						<div key={prompt.id} className="rounded border border-border-bright bg-surface-1 p-1.5">
							<PromptOriginBadge
								prompt={prompt}
								className="mb-1 inline-block bg-surface-3 text-[10px] leading-4"
							/>
							<p className="line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-text-primary">
								{prompt.text.trim() === "" ? "(empty prompt)" : prompt.text}
							</p>
							<PromptFidelityWarning prompt={prompt} />
							<div className="mt-1 flex items-center gap-1">
								<Tooltip content="Move this prompt to the task you are looking at">
									<Button variant="ghost" size="xs" onClick={() => onClaim(prompt.id)}>
										Claim
									</Button>
								</Tooltip>
								<Tooltip content="Fill into input">
									<Button
										variant="ghost"
										size="xs"
										icon={<CornerDownLeft size={14} />}
										aria-label="Fill orphaned prompt into input"
										disabled={prompt.text.trim().length === 0}
										onClick={() => onFill(prompt.text)}
									/>
								</Tooltip>
								<Tooltip content="Delete">
									<Button
										variant="ghost"
										size="xs"
										icon={<Trash2 size={14} />}
										aria-label="Delete orphaned prompt"
										className="hover:text-status-red"
										onClick={() => onRemove(prompt.id)}
									/>
								</Tooltip>
							</div>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

export function PromptLibraryPanel({
	taskId,
	projectId,
	onFillInput,
	headerContent,
	taskIdsOnBoard = null,
}: {
	taskId: string;
	projectId: string;
	onFillInput: (text: string) => void;
	headerContent?: ReactNode;
	/** 看板上此刻存在的任务 id。null = 还不知道（首屏未加载），此时一条都不标成孤儿。 */
	taskIdsOnBoard?: ReadonlySet<string> | null;
}): React.ReactElement {
	const { prompts, orphanedPrompts, addPrompt, updatePromptText, removePrompt, setPromptScope, claimOrphanedPrompt } =
		usePromptLibrary(taskId, projectId, taskIdsOnBoard);
	const [isOrphanedSectionExpanded, setIsOrphanedSectionExpanded] = useState(false);
	const [pendingFocusPromptId, setPendingFocusPromptId] = useState<string | null>(null);
	const handleAddPrompt = (): void => {
		setPendingFocusPromptId(addPrompt());
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
				{headerContent ?? (
					<span className="text-xs font-medium uppercase tracking-wide text-text-secondary">Prompts</span>
				)}
				<Button variant="ghost" size="xs" icon={<Plus size={14} />} onClick={handleAddPrompt}>
					Add
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pt-1 pb-3">
				{prompts.length === 0 ? (
					<p className="px-1 py-2 text-xs leading-5 text-text-tertiary">
						No saved prompts yet. Add one to fill it into the agent input with a click.
					</p>
				) : (
					prompts.map((prompt) => (
						<PromptRow
							key={prompt.id}
							prompt={prompt}
							onChangeText={updatePromptText}
							onToggleScope={setPromptScope}
							onFill={onFillInput}
							onRemove={removePrompt}
							shouldAutoFocus={pendingFocusPromptId === prompt.id}
							onAutoFocusHandled={() => setPendingFocusPromptId(null)}
						/>
					))
				)}
				{orphanedPrompts.length > 0 ? (
					<OrphanedPromptsSection
						orphanedPrompts={orphanedPrompts}
						isExpanded={isOrphanedSectionExpanded}
						onToggleExpanded={() => setIsOrphanedSectionExpanded((current) => !current)}
						onClaim={claimOrphanedPrompt}
						onRemove={removePrompt}
						onFill={onFillInput}
					/>
				) : null}
			</div>
		</div>
	);
}
