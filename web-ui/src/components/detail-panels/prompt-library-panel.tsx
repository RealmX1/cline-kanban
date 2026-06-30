import { CornerDownLeft, Globe, Plus, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { type PromptScope, type StoredPrompt, usePromptLibrary } from "@/hooks/use-prompt-library";

const PROMPT_TEXTAREA_MAX_HEIGHT = 160;

function PromptRow({
	prompt,
	onChangeText,
	onToggleScope,
	onFill,
	onRemove,
}: {
	prompt: StoredPrompt;
	onChangeText: (id: string, text: string) => void;
	onToggleScope: (id: string, scope: PromptScope) => void;
	onFill: (text: string) => void;
	onRemove: (id: string) => void;
}): React.ReactElement {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, PROMPT_TEXTAREA_MAX_HEIGHT)}px`;
		textarea.style.overflowY = textarea.scrollHeight > PROMPT_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
	}, [prompt.text]);

	const isGlobal = prompt.scope === "global";
	const canFill = prompt.text.trim().length > 0;

	return (
		<div className="group relative rounded-md border border-border bg-surface-2 focus-within:border-border-focus">
			<textarea
				ref={textareaRef}
				value={prompt.text}
				onChange={(event) => onChangeText(prompt.id, event.target.value)}
				placeholder="Prompt text…"
				rows={1}
				spellCheck={false}
				className="block min-h-[1.5rem] w-full resize-none overflow-x-hidden bg-transparent p-1.5 text-xs leading-5 text-text-primary placeholder:text-text-tertiary focus:outline-none"
			/>
			{/* Action cluster floats at the bottom-right and reveals on hover/focus so it never
			    competes with the textarea for horizontal width nor pins itself to the top. */}
			<div className="pointer-events-none absolute right-1 bottom-1 flex items-center gap-0.5 rounded-md border border-border-bright bg-surface-2 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
				<Tooltip content={isGlobal ? "Global · all tasks & repos" : "This task only"}>
					<Button
						variant="ghost"
						size="xs"
						icon={<Globe size={14} />}
						aria-label={isGlobal ? "Make task-specific" : "Make global"}
						className={cn(isGlobal && "text-accent hover:text-accent")}
						onClick={() => onToggleScope(prompt.id, isGlobal ? "task" : "global")}
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
	onFillInput,
}: {
	taskId: string;
	onFillInput: (text: string) => void;
}): React.ReactElement {
	const { prompts, addPrompt, updatePromptText, removePrompt, setPromptScope } = usePromptLibrary(taskId);

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
				<span className="text-xs font-medium uppercase tracking-wide text-text-secondary">Prompts</span>
				<Button variant="ghost" size="xs" icon={<Plus size={14} />} onClick={addPrompt}>
					Add
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-3">
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
						/>
					))
				)}
			</div>
		</div>
	);
}
