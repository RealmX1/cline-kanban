import { ChevronDown, ChevronUp, CornerDownLeft, FileText, GitBranch, Globe, Plus, Trash2 } from "lucide-react";
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

function PromptMetadataPill({ prompt }: { prompt: StoredPrompt }): React.ReactElement {
	const scopeMeta = PROMPT_SCOPE_META[prompt.scope];
	return (
		<div className="pointer-events-none absolute -top-[7px] -left-2 z-10 flex max-w-[calc(100%+0.5rem)] items-center gap-1 overflow-hidden rounded-full border border-border-bright bg-surface-3 px-2 py-0.5 text-[10px] leading-4 text-text-secondary shadow-sm">
			<span className="shrink-0 font-medium text-text-primary">{scopeMeta.label}</span>
			<span className="truncate">Created {formatPromptMetadataTimestamp(prompt.createdAt)}</span>
			<span className="shrink-0 text-text-tertiary">·</span>
			<span className="truncate">Edited {formatPromptMetadataTimestamp(prompt.updatedAt)}</span>
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

export function PromptLibraryPanel({
	taskId,
	projectId,
	onFillInput,
	headerContent,
}: {
	taskId: string;
	projectId: string;
	onFillInput: (text: string) => void;
	headerContent?: ReactNode;
}): React.ReactElement {
	const { prompts, addPrompt, updatePromptText, removePrompt, setPromptScope } = usePromptLibrary(taskId, projectId);
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
			</div>
		</div>
	);
}
