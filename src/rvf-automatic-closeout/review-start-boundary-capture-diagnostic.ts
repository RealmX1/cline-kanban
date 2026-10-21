import { z } from "zod";

export const reviewStartBoundaryCaptureDiagnosticSchema = z.object({
	status: z.enum(["pending", "invalidated"]),
	reason: z.string(),
	reason_code: z.enum([
		"native_independent_user_turn_capability_unverified",
		"native_independent_user_turn_boundary_not_yet_observed",
		"native_independent_user_turn_contains_multiple_messages",
		"native_pre_review_turn_not_completed",
		"review_start_boundary_binding_invalidated",
		"review_start_boundary_token_expired",
		"review_start_boundary_native_message_reused",
		"review_start_boundary_host_session_unavailable",
	]),
	recovery_action: z.enum([
		"wait_for_native_turn_completion",
		"request_new_boundary_after_turn_completion",
		"repair_host_capability",
		"retry_capture",
		"inspect_boundary_diagnostic",
	]),
});
export type ReviewStartBoundaryCaptureDiagnostic = z.infer<typeof reviewStartBoundaryCaptureDiagnosticSchema>;
export class ReviewStartBoundaryCaptureError extends Error {
	constructor(public readonly diagnostic: ReviewStartBoundaryCaptureDiagnostic) {
		super(diagnostic.reason);
	}
}
export function boundaryCaptureError(
	reason: string,
	reason_code: ReviewStartBoundaryCaptureDiagnostic["reason_code"],
	status: ReviewStartBoundaryCaptureDiagnostic["status"] = "invalidated",
	recovery_action: ReviewStartBoundaryCaptureDiagnostic["recovery_action"] = "request_new_boundary_after_turn_completion",
) {
	return new ReviewStartBoundaryCaptureError({ status, reason, reason_code, recovery_action });
}
