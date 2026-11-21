import { GLOBAL_MARKDOWN_DRAFT_TITLE_MAX_LENGTH } from "@runtime-contract";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Link } from "@tiptap/extension-link";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { NotebookPen, Pencil, Plus, Redo2, Trash2, Undo2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	NonModalFloatingFormWindow,
	type NonModalFloatingFormWindowBounds,
} from "@/components/non-modal-floating-form-window";
import { useNonModalFloatingFormWindowHost } from "@/components/non-modal-floating-form-window-host-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
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
import { Tooltip } from "@/components/ui/tooltip";
import type { GlobalMarkdownDraft } from "@/runtime/global-markdown-draft-query";
import {
	globalMarkdownDraftBrowserSession,
	untitledGlobalMarkdownDraftTitle,
} from "@/state/global-markdown-draft-browser-session";

const draftWindowBoundsStorageKey = "kanban.global-markdown-draft.window-bounds";
const draftScrollStorageKey = (draftId: string) => `kanban.global-markdown-draft.scroll-position.${draftId}`;
const draftEditorExtensions = [
	StarterKit.configure({ codeBlock: false, link: false, paragraph: false, trailingNode: false }),
	CodeBlock.extend({
		renderMarkdown(node, helpers) {
			const content = helpers.renderChildren(node.content ?? []);
			let fenceLength = 3;
			for (const run of content.matchAll(/~+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1);
			const fence = "~".repeat(fenceLength);
			const language = node.attrs?.language;
			return `${fence}${language ? ` ${language}` : ""}\n${content}\n${fence}`;
		},
	}),
	Link.extend({
		renderMarkdown(node, helpers) {
			const href = String(node.attrs?.href ?? "").replace(/[\\<>]/g, "\\$&");
			const title = String(node.attrs?.title ?? "").replace(/[\\"]/g, "\\$&");
			return `[${helpers.renderChildren(node)}](<${href}>${title ? ` "${title}"` : ""})`;
		},
	}).configure({ openOnClick: false, markdownLinks: true }),
	Paragraph.extend({
		renderMarkdown(node, helpers, context) {
			const markdown = this.parent?.(node, helpers, context) ?? "";
			return markdown
				.replace(/^([ \t]{0,3})([-+#=>])/gm, "$1\\$2")
				.replace(/^([ \t]{0,3}\d{1,9})([.)])(?=\s|$)/gm, "$1\\$2");
		},
	}),
	Markdown,
];

function readDraftWindowBounds(): NonModalFloatingFormWindowBounds | undefined {
	try {
		const bounds = JSON.parse(localStorage.getItem(draftWindowBoundsStorageKey) ?? "null");
		if (
			bounds &&
			[bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) &&
			bounds.width > 0 &&
			bounds.height > 0
		)
			return bounds;
	} catch {
		// 缺少有效布局时使用窗口默认尺寸。
	}
}

function writeDraftWindowPreference(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// 仅影响当前浏览器的布局或阅读位置记忆。
	}
}

export function GlobalMarkdownDraftEntry({ isMobile }: { isMobile: boolean }) {
	const host = useNonModalFloatingFormWindowHost();
	if (!host) return null;
	return (
		<Tooltip side="bottom" content="草稿">
			<Button
				variant="ghost"
				size="sm"
				icon={<NotebookPen size={16} />}
				aria-label="草稿"
				data-verification-anchor="global-markdown-draft-entry"
				className={cn("ml-0.5 shrink-0", isMobile && "min-h-11 min-w-11")}
				onClick={(event) =>
					host.openWindow({
						formKind: "global-markdown-draft",
						instanceIdentity: "global-markdown-drafts",
						ownership: {},
						focusReturnElementCapturedAtOpeningRequest: event.currentTarget,
						render: (session) => <GlobalMarkdownDraftWindow onClose={session.close} />,
					})
				}
			/>
		</Tooltip>
	);
}

function GlobalMarkdownDraftWindow({ onClose }: { onClose: () => void }) {
	const drafts = useSyncExternalStore(
		globalMarkdownDraftBrowserSession.subscribe,
		globalMarkdownDraftBrowserSession.getSnapshot,
	);
	const [initialBounds] = useState(readDraftWindowBounds);
	const [renamingDraftId, setRenamingDraftId] = useState<string | null>(null);
	const [deleteCandidate, setDeleteCandidate] = useState<GlobalMarkdownDraft | null>(null);
	const activeDraft = drafts.drafts.find(({ id }) => id === drafts.selectedDraftId) ?? drafts.drafts[0];
	const deletingActiveDraft = activeDraft ? drafts.deletingDraftIds.has(activeDraft.id) : false;
	const pendingActiveDraft = activeDraft ? drafts.pendingDraftIds.has(activeDraft.id) : false;
	useEffect(() => {
		void globalMarkdownDraftBrowserSession.refresh();
	}, []);
	useEffect(() => {
		if (
			activeDraft &&
			(!drafts.selectedDraftId ||
				(!drafts.listLoading &&
					!drafts.listFailed &&
					!drafts.drafts.some(({ id }) => id === drafts.selectedDraftId)))
		)
			globalMarkdownDraftBrowserSession.select(activeDraft.id);
	}, [activeDraft, drafts.selectedDraftId, drafts.listLoading, drafts.listFailed, drafts.drafts]);

	return (
		<>
			<NonModalFloatingFormWindow
				open
				onOpenChange={(open) => {
					if (!open) onClose();
				}}
				title="草稿"
				collapseControlLabel="草稿浮窗"
				verificationAnchor="global-markdown-draft-window"
				resizableLayout={{
					initialBounds,
					onBoundsChange: (bounds) => writeDraftWindowPreference(draftWindowBoundsStorageKey, bounds),
				}}
			>
				<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
					<select
						aria-label="选择草稿"
						className="h-9 min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
						value={activeDraft?.id ?? ""}
						disabled={!activeDraft}
						onChange={(event) => {
							setRenamingDraftId(null);
							globalMarkdownDraftBrowserSession.select(event.target.value);
						}}
					>
						{!activeDraft && <option value="">{drafts.listLoading ? "正在读取草稿…" : "暂无草稿"}</option>}
						{drafts.drafts.map((draft) => (
							<option key={draft.id} value={draft.id}>
								{draft.title}
							</option>
						))}
					</select>
					<Button
						variant="ghost"
						size="sm"
						icon={<Plus size={16} />}
						aria-label="新建草稿"
						title="新建草稿"
						className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
						onClick={globalMarkdownDraftBrowserSession.create}
					/>
					<Button
						variant="ghost"
						size="sm"
						icon={<Pencil size={15} />}
						aria-label="重命名草稿"
						title="重命名草稿"
						className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
						disabled={!activeDraft || deletingActiveDraft}
						onClick={() => setRenamingDraftId(activeDraft?.id ?? null)}
					/>
					<Button
						variant="ghost"
						size="sm"
						icon={<Trash2 size={15} />}
						aria-label="删除草稿"
						title="删除草稿"
						className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
						disabled={!activeDraft || pendingActiveDraft || deletingActiveDraft}
						onClick={() => {
							if (!activeDraft) return;
							if (activeDraft.markdown.trim() || activeDraft.title !== untitledGlobalMarkdownDraftTitle)
								setDeleteCandidate(activeDraft);
							else void globalMarkdownDraftBrowserSession.delete(activeDraft);
						}}
					/>
				</div>
				{activeDraft && renamingDraftId === activeDraft.id && (
					<RenameGlobalMarkdownDraft draft={activeDraft} onClose={() => setRenamingDraftId(null)} />
				)}
				<div className="flex min-h-8 shrink-0 items-center gap-2 px-3 py-1 text-xs text-text-secondary">
					<p role="status" className="min-w-0 flex-1">
						{drafts.recoveryStorageFailed
							? "浏览器恢复副本写入失败，请保留本页直至保存完成。"
							: drafts.saveFailed
								? "同步失败，已保留本地副本。"
								: deletingActiveDraft
									? "正在删除…"
									: pendingActiveDraft
										? "待同步…"
										: drafts.notice || (activeDraft ? "已保存" : "")}
					</p>
					{(drafts.saveFailed || drafts.listFailed) && (
						<Button size="sm" variant="ghost" onClick={globalMarkdownDraftBrowserSession.retry}>
							重试
						</Button>
					)}
				</div>
				{drafts.listFailed && <p className="shrink-0 px-3 pb-2 text-xs text-text-secondary">读取草稿列表失败。</p>}
				{activeDraft ? (
					<GlobalMarkdownDraftEditor key={activeDraft.id} draft={activeDraft} editable={!deletingActiveDraft} />
				) : !drafts.listLoading && !drafts.listFailed ? (
					<p className="flex flex-1 items-center justify-center p-4 text-sm text-text-secondary">
						新建一份草稿即可开始编辑。
					</p>
				) : null}
			</NonModalFloatingFormWindow>
			<AlertDialog
				open={deleteCandidate !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteCandidate(null);
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>删除草稿</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>永久删除「{deleteCandidate?.title}」及其正文？</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="ghost">取消</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								if (deleteCandidate) void globalMarkdownDraftBrowserSession.delete(deleteCandidate);
							}}
						>
							删除草稿
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}

function RenameGlobalMarkdownDraft({ draft, onClose }: { draft: GlobalMarkdownDraft; onClose: () => void }) {
	const [title, setTitle] = useState(draft.title);
	const inputRef = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		inputRef.current?.focus({ preventScroll: true });
		inputRef.current?.select();
	}, []);
	return (
		<form
			className="flex shrink-0 items-center gap-1 px-2 pt-1"
			onSubmit={(event) => {
				event.preventDefault();
				if (!title.trim()) return;
				globalMarkdownDraftBrowserSession.edit(draft, { title: title.trim() });
				onClose();
			}}
		>
			<input
				ref={inputRef}
				aria-label="草稿标题"
				maxLength={GLOBAL_MARKDOWN_DRAFT_TITLE_MAX_LENGTH}
				value={title}
				onChange={(event) => setTitle(event.target.value)}
				className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
			/>
			<Button size="sm" type="submit" disabled={!title.trim()}>
				保存标题
			</Button>
			<Button size="sm" type="button" variant="ghost" onClick={onClose}>
				取消
			</Button>
		</form>
	);
}

function GlobalMarkdownDraftEditor({ draft, editable }: { draft: GlobalMarkdownDraft; editable: boolean }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const editorMarkdownRef = useRef(draft.markdown);
	const editor = useEditor({
		extensions: draftEditorExtensions,
		content: draft.markdown,
		contentType: "markdown",
		editable,
		shouldRerenderOnTransaction: false,
		editorProps: {
			attributes: {
				role: "textbox",
				"aria-label": "草稿正文",
				"aria-multiline": "true",
				class: "min-h-full outline-none",
			},
		},
		onUpdate: ({ editor }) => {
			const markdown = editor.getMarkdown();
			editorMarkdownRef.current = markdown;
			globalMarkdownDraftBrowserSession.edit(draft, { markdown });
		},
	});
	const history = useEditorState({
		editor,
		selector: ({ editor }) => ({ canUndo: editor?.can().undo() ?? false, canRedo: editor?.can().redo() ?? false }),
	});
	useLayoutEffect(() => {
		if (!editor) return;
		if (editor.isEditable !== editable) editor.setEditable(editable, false);
		if (editorMarkdownRef.current !== draft.markdown) {
			editor
				.chain()
				.setMeta("addToHistory", false)
				.setContent(draft.markdown, { contentType: "markdown", emitUpdate: false })
				.run();
			editorMarkdownRef.current = draft.markdown;
		}
	}, [draft.markdown, editable, editor]);
	useLayoutEffect(() => {
		if (!editor || !scrollRef.current) return;
		try {
			const storedPosition = Number(localStorage.getItem(draftScrollStorageKey(draft.id)));
			if (Number.isFinite(storedPosition)) scrollRef.current.scrollTop = storedPosition;
		} catch {
			// 无法读取浏览器偏好时从正文顶部打开。
		}
	}, [draft.id, editor]);
	return (
		<>
			<div
				ref={scrollRef}
				data-verification-anchor="global-markdown-draft-editor-scroll"
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface-0 text-sm leading-relaxed text-text-primary"
				onScroll={(event) => {
					if (event.currentTarget.clientHeight)
						writeDraftWindowPreference(draftScrollStorageKey(draft.id), event.currentTarget.scrollTop);
				}}
			>
				<EditorContent
					editor={editor}
					className={cn(
						"h-full [&_.tiptap]:px-4 [&_.tiptap]:py-3 [&_.tiptap]:break-words [&_.tiptap_p]:my-1",
						"[&_.tiptap_h1]:mt-4 [&_.tiptap_h1]:text-2xl [&_.tiptap_h2]:mt-4 [&_.tiptap_h2]:text-xl",
						"[&_.tiptap_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_.tiptap_h3]:text-lg",
						"[&_.tiptap_ul]:list-disc [&_.tiptap_ol]:list-decimal [&_.tiptap_:is(ol,ul)]:pl-6",
						"[&_.tiptap_blockquote]:my-2 [&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-border-bright [&_.tiptap_blockquote]:pl-3",
						"[&_.tiptap_code]:rounded [&_.tiptap_code]:bg-surface-2 [&_.tiptap_code]:px-1",
						"[&_.tiptap_pre]:my-2 [&_.tiptap_pre]:overflow-x-auto [&_.tiptap_pre]:rounded [&_.tiptap_pre]:bg-surface-2 [&_.tiptap_pre]:p-2",
						"[&_.tiptap_pre_code]:p-0 [&_.tiptap_a]:text-accent [&_.tiptap_a]:underline",
					)}
				/>
			</div>
			<div className="flex h-8 shrink-0 items-center gap-1 border-t border-border px-2">
				<Button
					size="sm"
					variant="ghost"
					icon={<Undo2 size={16} />}
					aria-label="撤销"
					title="撤销"
					disabled={!editable || !history?.canUndo}
					onClick={() => editor?.chain().focus().undo().run()}
				/>
				<Button
					size="sm"
					variant="ghost"
					icon={<Redo2 size={16} />}
					aria-label="重做"
					title="重做"
					disabled={!editable || !history?.canRedo}
					onClick={() => editor?.chain().focus().redo().run()}
				/>
			</div>
		</>
	);
}
