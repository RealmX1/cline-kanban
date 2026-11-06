import { describe, expect, it } from "vitest";

import { shouldShowStartupOnboardingDialog } from "@/runtime/onboarding";

describe("runtime onboarding helpers", () => {
	it("shows startup onboarding at least once for configured users", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: false,
			}),
		).toBe(true);
	});

	it("does not reopen startup onboarding after it has been shown", () => {
		expect(
			shouldShowStartupOnboardingDialog({
				hasShownOnboardingDialog: true,
			}),
		).toBe(false);
	});
});
