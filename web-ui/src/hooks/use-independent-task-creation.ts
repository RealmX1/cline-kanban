import { useEffect, useRef, useState } from "react";
import {
	independentTaskCreationClient,
	saveIndependentTaskCreationDraft,
} from "@/runtime/independent-task-creation-query";
import type { IndependentTaskCreationDraft, IndependentTaskCreationDraftEdit } from "@/runtime/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

type EditableDraftFields = Omit<IndependentTaskCreationDraftEdit, "requestId" | "expectedRevision">;
const editableFields = (draft: IndependentTaskCreationDraft): EditableDraftFields => ({
	userTaskDescription: draft.userTaskDescription,
	title: draft.title,
	initialPrompt: draft.initialPrompt,
	titleWasEditedByUser: draft.titleWasEditedByUser,
	initialPromptWasEditedByUser: draft.initialPromptWasEditedByUser,
	contextInheritance: draft.contextInheritance,
	worktreeSource: draft.worktreeSource,
	modelProviderId: draft.modelProviderId,
	generationSource: draft.generationSource,
});

export function useIndependentTaskCreation(
	workspaceId: string,
	sourceTaskId: string,
	sourceTaskConversationSessionId: string,
) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<IndependentTaskCreationDraft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = useRef(draft);
	const edits = useRef(0);
	const savedEdits = useRef(0);
	const epoch = useRef(0);
	const saveChain = useRef(Promise.resolve());
	const autoGenerate = useRef(false);
	const client = independentTaskCreationClient(workspaceId);
	function replace(value: IndependentTaskCreationDraft) {
		current.current = value;
		setDraft(value);
	}
	function accept(value: IndependentTaskCreationDraft, startedAtEdit: number) {
		if (value.requestId !== current.current?.requestId || value.revision < current.current.revision) return;
		replace(edits.current === startedAtEdit ? value : { ...value, ...editableFields(current.current) });
	}
	async function persistEdits() {
		const run = async () => {
			const value = current.current;
			if (!value || savedEdits.current === edits.current || value.status === "created") return;
			const version = edits.current;
			let revision = value.revision;
			try {
				// 生成开始会推进服务端版本；冲突时只刷新版本，不丢本地编辑。
				const remote = await client.read.query({ requestId: value.requestId });
				revision = remote.revision;
				const updated = await saveIndependentTaskCreationDraft(workspaceId, {
					requestId: value.requestId,
					expectedRevision: revision,
					...editableFields(value),
				});
				accept(updated, version);
				savedEdits.current = version;
			} catch (cause) {
				setError(`草稿尚未保存：${cause instanceof Error ? cause.message : String(cause)}`);
				throw cause;
			}
		};
		const result = saveChain.current.catch(() => {}).then(run);
		saveChain.current = result;
		return await result;
	}
	function edit(fields: Partial<EditableDraftFields>) {
		if (!current.current) return;
		edits.current++;
		replace({ ...current.current, ...fields });
	}
	useEffect(() => {
		if (!open || !draft || edits.current === savedEdits.current) return;
		const timer = window.setTimeout(() => {
			void persistEdits().catch(() => {});
		}, 450);
		return () => window.clearTimeout(timer);
	}, [open, draft]);
	useEffect(
		() => () => {
			epoch.current++;
		},
		[workspaceId, sourceTaskId, sourceTaskConversationSessionId],
	);
	async function generate(allowIncompleteContext = false) {
		const requestEpoch = epoch.current;
		setBusy(true);
		setError(null);
		try {
			await persistEdits();
			if (!current.current) return;
			const version = edits.current;
			const result = await client.generate.mutate({ requestId: current.current.requestId, allowIncompleteContext });
			if (epoch.current === requestEpoch) accept(result, version);
		} catch (cause) {
			if (epoch.current === requestEpoch) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (epoch.current === requestEpoch) setBusy(false);
		}
	}
	async function begin(forceNew = false) {
		const requestEpoch = ++epoch.current;
		setOpen(true);
		setBusy(true);
		setError(null);
		try {
			const existing = forceNew
				? null
				: await client.latestDraft.query({ sourceTaskId, sourceTaskConversationSessionId });
			const result = existing
				? await client.read.query({ requestId: existing.requestId })
				: await client.prepare.mutate({
						sourceTaskId,
						sourceTaskConversationSessionId,
						requestId: createRandomUuidV4WithInsecureContextFallback(),
					});
			if (epoch.current !== requestEpoch) return;
			edits.current = 0;
			savedEdits.current = 0;
			replace(result);
			autoGenerate.current = !existing;
		} catch (cause) {
			if (epoch.current === requestEpoch) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (epoch.current === requestEpoch) setBusy(false);
		}
	}
	useEffect(() => {
		if (!open || !draft || busy) return;
		if (draft.status === "waiting_for_source_turn") {
			const requestEpoch = epoch.current;
			const timer = window.setTimeout(() => {
				void client.prepare
					.mutate({ requestId: draft.requestId, sourceTaskId, sourceTaskConversationSessionId })
					.then((value) => {
						if (epoch.current === requestEpoch) accept(value, edits.current);
					})
					.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
			}, 2000);
			return () => window.clearTimeout(timer);
		}
		if (autoGenerate.current && draft.status === "ready") {
			autoGenerate.current = false;
			if (!draft.contextWarnings.length) void generate();
		}
	}, [open, draft, busy]);
	async function create(allowIncompleteContext: boolean) {
		setBusy(true);
		setError(null);
		try {
			await persistEdits();
			let value = current.current;
			if (!value) return;
			if (!value.initialPromptWasEditedByUser && value.generatedFromDescription !== value.userTaskDescription) {
				const version = edits.current;
				const generated = await client.generate.mutate({ requestId: value.requestId, allowIncompleteContext });
				accept(generated, version);
				if (edits.current !== version) throw new Error("生成期间你修改了草稿，请核对后再次创建。");
				value = current.current;
				if (!value || value.errorMessage) return;
			}
			const result = await client.create.mutate({ requestId: value.requestId });
			replace(result);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	async function close() {
		try {
			await persistEdits();
			setOpen(false);
		} catch {
			/* 保留窗口和未保存的输入。 */
		}
	}
	return { open, draft, busy, error, begin, edit, generate, create, close };
}
