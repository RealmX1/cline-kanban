import { z } from "zod";

export const runtimeTaskStickerEntrySchema = z.object({
	taskStickerEntryId: z.string().min(1),
	stickerText: z.string().min(1),
	isCollapsed: z.boolean(),
	createdAt: z.number().finite(),
	updatedAt: z.number().finite(),
});
export type RuntimeTaskStickerEntry = z.infer<typeof runtimeTaskStickerEntrySchema>;
