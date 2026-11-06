export function shouldShowStartupOnboardingDialog(input: { hasShownOnboardingDialog: boolean }): boolean {
	if (!input.hasShownOnboardingDialog) {
		return true;
	}
	return false;
}
