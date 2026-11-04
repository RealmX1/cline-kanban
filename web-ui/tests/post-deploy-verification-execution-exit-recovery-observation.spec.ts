import { expect, test } from "@playwright/test";

const recoveryObservations = [
	{
		reason: "awaiting_exit_confirmation",
		message: "旧执行仍在等待进程身份核验，确认退出后才能重跑。",
		viewportWidth: 390,
	},
	{
		reason: "legacy_execution_ownership_unknown",
		message: "正在补查旧版本执行的归属，当前无法确认进程已经退出。",
		viewportWidth: 1280,
	},
	{
		reason: "unchanged_evidence_budget_exhausted",
		message: "相同证据已补查三次，等待新回执或真实开机代际变化。",
		viewportWidth: 390,
	},
] as const;

for (const observation of recoveryObservations) {
	test(`${observation.reason} 显示退出核验原因并禁止重复执行`, async ({ page }) => {
		await page.setViewportSize({ width: observation.viewportWidth, height: 900 });
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.route("**/api/**", (route) => route.fulfill({ json: { required: false, authenticated: true } }));
		await page.routeWebSocket("**/*", () => {});
		await page.route("**/src/telemetry/sentry.ts*", (route) =>
			route.fulfill({ contentType: "text/javascript", body: "export function initializeSentry() {}" }),
		);
		await page.route("**/src/App.tsx*", (route) =>
			route.fulfill({
				contentType: "text/javascript",
				body: `
import React from '/node_modules/.vite/deps/react.js';
import { PostDeployVerificationChecklistItem } from '/src/components/post-deploy-verification/post-deploy-verification-checklist-item.tsx';
const noop = () => {};
const item = {
 id: 'authored:isolated-execution-recovery', label: '正在核对旧执行的退出状态', checked: false,
 source: 'authored', kind: 'automated_script', guidance: null, cleanup: null,
 script: { entrypoint: 'run.js', interpreter: 'node', timeoutMs: 60000 },
 run: {
  status: 'running', exitCode: null, startedAtIso: '2026-10-31T10:00:00Z', finishedAtIso: null,
  outputExcerpt: '', verificationExecutionAttemptId: '11111111-1111-4111-8111-111111111111',
  recoveryObservation: ${JSON.stringify({ ...observation, unchangedEvidenceProbeCount: 3, nextActiveProbeAtEpochMs: 0 })},
 },
};
export default function IsolatedVerificationExecutionRecoveryFixture() {
 return React.createElement('section', { 'aria-label': '部署验证执行恢复', style: { padding: 16, maxWidth: 480 } },
  React.createElement(PostDeployVerificationChecklistItem, {
   item, interactive: true, isCompleting: false, taskVerified: false,
   onToggle: noop, onRun: noop, onRemoveCustom: noop, onLocate: noop,
  }));
}
`,
			}),
		);
		await page.goto("/");
		const recoveryItem = page.getByRole("region", { name: "部署验证执行恢复" });
		await expect(recoveryItem.getByText("正在核验退出", { exact: true })).toBeVisible();
		await expect(recoveryItem.getByText(observation.message, { exact: true })).toBeVisible();
		await expect(recoveryItem.getByRole("button", { name: "重新运行验证脚本", exact: true })).toBeDisabled();
		await expect(recoveryItem.getByText("通过", { exact: true })).toHaveCount(0);
		expect(pageErrors).toEqual([]);
	});
}
