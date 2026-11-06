import { z } from "zod";

export const codexSourceSharedPluginNativeLaunchPreparationIntentSchema = z.object({
	schemaVersion: z.literal(1),
	intentId: z.string().uuid(),
	writerId: z.string().uuid(),
	sourceIdentity: z.string(),
	baseWriterMarketplaceConfigurationDigest: z.string(),
	effectiveConfigurationToml: z.string(),
	sourceInstallationStatePath: z.string(),
	status: z.enum(["pending", "completed"]),
	createdAtMs: z.number(),
	nextEvidenceObservationAtMs: z.number(),
	failureReason: z.string().optional(),
});
