import { z } from "zod";
import { kanbanBoardCardWorkUnitQualifiedReferenceSchema } from "./inter-work-unit-relation-ledger-event-contract";

export const retainedTaskPromptVersionSchema = z.discriminatedUnion("availability", [
	z.object({ availability: z.literal("available"), text: z.string() }),
	z.object({ availability: z.enum(["not_recorded", "content_missing_or_invalid"]), text: z.null() }),
]);
export const permanentlyDeletedTaskPromptVersionsRequestSchema = z.object({
	kanbanBoardCard: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
});
export const permanentlyDeletedTaskPromptVersionsResponseSchema = z.object({
	beforePermanentRemoval: retainedTaskPromptVersionSchema,
	atCreation: retainedTaskPromptVersionSchema,
	comparison: z.enum(["same", "different", "unknown"]),
});
export const listPermanentlyDeletedTaskCardsRequestSchema = z.object({
	workspaceId: z.string().min(1).optional(),
	query: z.string().max(2000).default(""),
	cursor: z.string().nullable().default(null),
});
export const permanentlyDeletedTaskCardEntrySchema = z.object({
	kanbanBoardCard: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	workspaceRepositoryPath: z.string().nullable(),
	titleBeforePermanentRemoval: z.string().nullable(),
	permanentlyRemovedFromBoardAt: z.number(),
	promptPreview: z.string().nullable(),
	matchedPromptVersions: z.array(z.enum(["before_permanent_removal", "at_creation"])),
});
export const listPermanentlyDeletedTaskCardsResponseSchema = z.object({
	entries: z.array(permanentlyDeletedTaskCardEntrySchema),
	nextCursor: z.string().nullable(),
	knownWorkspaces: z.array(z.object({ workspaceId: z.string(), workspaceRepositoryPath: z.string().nullable() })),
});
export type RetainedTaskPromptVersion = z.infer<typeof retainedTaskPromptVersionSchema>;
export type PermanentlyDeletedTaskCardEntry = z.infer<typeof permanentlyDeletedTaskCardEntrySchema>;
export type ListPermanentlyDeletedTaskCardsRequest = z.input<typeof listPermanentlyDeletedTaskCardsRequestSchema>;
export type ListPermanentlyDeletedTaskCardsResponse = z.infer<typeof listPermanentlyDeletedTaskCardsResponseSchema>;
export type PermanentlyDeletedTaskPromptVersionsRequest = z.infer<
	typeof permanentlyDeletedTaskPromptVersionsRequestSchema
>;
export type PermanentlyDeletedTaskPromptVersionsResponse = z.infer<
	typeof permanentlyDeletedTaskPromptVersionsResponseSchema
>;
