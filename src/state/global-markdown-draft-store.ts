import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	createGlobalMarkdownDraftRecoveryTitle,
	type globalMarkdownDraftCreateInputSchema,
	type globalMarkdownDraftDeleteInputSchema,
	type globalMarkdownDraftDeleteResultSchema,
	globalMarkdownDraftSchema,
	type globalMarkdownDraftUpdateInputSchema,
	type globalMarkdownDraftUpdateResultSchema,
} from "../core/api-contract";
import { type LockedFileSystem, lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "./runtime-home-path";

const storedGlobalMarkdownDraftSaveReceiptsSchema = z.object({
	appliedSaveSequenceByWriter: z.record(z.string().uuid(), z.number().int().positive()).optional(),
	appliedSaveRequestIds: z.array(z.string().uuid()).optional(),
});
const storedGlobalMarkdownDraftsSchema = z.object({
	drafts: z.array(
		globalMarkdownDraftSchema.extend({
			...storedGlobalMarkdownDraftSaveReceiptsSchema.shape,
			recoveredFromDraftId: z.string().uuid().optional(),
		}),
	),
	deletedDrafts: z.array(
		storedGlobalMarkdownDraftSaveReceiptsSchema.extend(globalMarkdownDraftSchema.pick({ id: true }).shape),
	),
});
type StoredGlobalMarkdownDrafts = z.infer<typeof storedGlobalMarkdownDraftsSchema>;
type GlobalMarkdownDraft = z.infer<typeof globalMarkdownDraftSchema>;

export class GlobalMarkdownDraftStore {
	constructor(
		private readonly filePath: string,
		private readonly filesystem: LockedFileSystem,
	) {}

	private async read(): Promise<StoredGlobalMarkdownDrafts> {
		const contents = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return null;
		});
		return contents === null
			? { drafts: [], deletedDrafts: [] }
			: storedGlobalMarkdownDraftsSchema.parse(JSON.parse(contents));
	}

	private async write(snapshot: StoredGlobalMarkdownDrafts) {
		await this.filesystem.writeJsonFileAtomic(this.filePath, snapshot, {
			lock: null,
			durable: true,
			fileMode: 0o600,
		});
	}

	async list(): Promise<GlobalMarkdownDraft[]> {
		return (await this.read()).drafts.map((draft) => globalMarkdownDraftSchema.parse(draft));
	}

	create(input: z.infer<typeof globalMarkdownDraftCreateInputSchema>): Promise<GlobalMarkdownDraft | null> {
		return this.filesystem.withLock({ path: this.filePath }, async () => {
			const snapshot = await this.read();
			if (snapshot.deletedDrafts.some(({ id }) => id === input.id)) {
				await this.write(snapshot);
				return null;
			}
			const existingDraft = snapshot.drafts.find(({ id }) => id === input.id);
			if (existingDraft) {
				await this.write(snapshot);
				return globalMarkdownDraftSchema.parse(existingDraft);
			}
			const draft = { ...input, version: 1, updatedAt: Date.now() };
			snapshot.drafts.push(draft);
			await this.write(snapshot);
			return draft;
		});
	}

	update(
		input: z.infer<typeof globalMarkdownDraftUpdateInputSchema>,
	): Promise<z.infer<typeof globalMarkdownDraftUpdateResultSchema>> {
		return this.filesystem.withLock({ path: this.filePath }, async () => {
			const snapshot = await this.read();
			const { id, title, markdown, expectedVersion, saveRequestId, saveWriterId, saveSequence } = input;
			const currentDraft = snapshot.drafts.find((draft) => draft.id === id);
			const previousDraftIdentity = currentDraft ?? snapshot.deletedDrafts.find((draft) => draft.id === id);
			if (
				(previousDraftIdentity?.appliedSaveSequenceByWriter?.[saveWriterId] ?? 0) >= saveSequence ||
				previousDraftIdentity?.appliedSaveRequestIds?.includes(saveRequestId)
			) {
				await this.write(snapshot);
				return { status: "saved", draft: currentDraft ? globalMarkdownDraftSchema.parse(currentDraft) : null };
			}

			const existingRecovery = snapshot.drafts.find(
				(draft) => draft.id === saveRequestId && draft.recoveredFromDraftId === id,
			);
			const deletedRecovery = snapshot.deletedDrafts.some((draft) => draft.id === saveRequestId);
			if (currentDraft?.version === expectedVersion && !existingRecovery && !deletedRecovery) {
				Object.assign(currentDraft, {
					title,
					markdown,
					version: expectedVersion + 1,
					updatedAt: Date.now(),
					appliedSaveSequenceByWriter: {
						...currentDraft.appliedSaveSequenceByWriter,
						[saveWriterId]: saveSequence,
					},
				});
				await this.write(snapshot);
				return { status: "saved", draft: globalMarkdownDraftSchema.parse(currentDraft) };
			}

			let recoveryDraft = existingRecovery;
			if (!recoveryDraft && !deletedRecovery) {
				if (snapshot.drafts.some((draft) => draft.id === saveRequestId)) throw new Error("恢复草稿身份已被占用。");
				recoveryDraft = {
					id: saveRequestId,
					title: createGlobalMarkdownDraftRecoveryTitle(title),
					markdown,
					version: 1,
					updatedAt: Date.now(),
					recoveredFromDraftId: id,
				};
				snapshot.drafts.push(recoveryDraft);
			}
			await this.write(snapshot);
			return {
				status: "recovered",
				draft: recoveryDraft ? globalMarkdownDraftSchema.parse(recoveryDraft) : null,
				currentDraft: currentDraft ? globalMarkdownDraftSchema.parse(currentDraft) : null,
			};
		});
	}

	delete({
		id,
		expectedVersion,
	}: z.infer<typeof globalMarkdownDraftDeleteInputSchema>): Promise<
		z.infer<typeof globalMarkdownDraftDeleteResultSchema>
	> {
		return this.filesystem.withLock({ path: this.filePath }, async () => {
			const snapshot = await this.read();
			const currentDraft = snapshot.drafts.find((draft) => draft.id === id);
			if (!currentDraft) {
				if (snapshot.deletedDrafts.some((draft) => draft.id === id)) await this.write(snapshot);
				return { status: "deleted" };
			}
			if (currentDraft.version !== expectedVersion) {
				return { status: "conflict", currentDraft: globalMarkdownDraftSchema.parse(currentDraft) };
			}
			snapshot.drafts = snapshot.drafts.filter((draft) => draft.id !== id);
			snapshot.deletedDrafts.push({
				id,
				appliedSaveSequenceByWriter: currentDraft.appliedSaveSequenceByWriter,
				appliedSaveRequestIds: currentDraft.appliedSaveRequestIds,
			});
			await this.write(snapshot);
			return { status: "deleted" };
		});
	}
}

export const globalMarkdownDraftStore = new GlobalMarkdownDraftStore(
	join(getRuntimeHomePath(), "global-markdown-drafts.json"),
	lockedFileSystem,
);
