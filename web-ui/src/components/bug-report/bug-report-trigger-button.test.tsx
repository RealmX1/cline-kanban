import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BugReportTriggerButton } from "@/components/bug-report/bug-report-trigger-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskImage } from "@/types";

const { captureScreenshot, observeDialog } = vi.hoisted(() => ({
	captureScreenshot: vi.fn(),
	observeDialog: vi.fn(),
}));
vi.mock("@/components/bug-report/capture-page-screenshot", () => ({
	capturePageScreenshotAsTaskImage: captureScreenshot,
}));
vi.mock("@/components/bug-report/bug-report-dialog", () => ({
	BugReportDialog: (props: { open: boolean; initialScreenshot: TaskImage | null; activeView: string }) => {
		observeDialog(props);
		return props.open ? <div role="dialog">Report bug</div> : null;
	},
}));

it.each([null, { id: "screenshot", data: "image", mimeType: "image/png" }])(
	"截图完成后才打开报告框，截图失败仍可报告：%s",
	async (screenshot) => {
		let finishCapture!: (image: TaskImage | null) => void;
		captureScreenshot.mockReturnValue(
			new Promise<TaskImage | null>((resolve) => {
				finishCapture = resolve;
			}),
		);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
		const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		try {
			await act(async () =>
				root.render(
					<TooltipProvider>
						<BugReportTriggerButton projects={[]} currentProjectId={null} activeView="task:fixture" />
					</TooltipProvider>,
				),
			);
			const trigger = container.querySelector<HTMLButtonElement>('[data-testid="open-bug-report-button"]');
			expect(trigger).not.toBeNull();
			expect(trigger?.querySelector(".lucide-message-square-warning")).not.toBeNull();
			await act(async () => trigger?.click());
			expect(trigger?.disabled).toBe(true);
			expect(container.querySelector('[role="dialog"]')).toBeNull();
			await act(async () => finishCapture(screenshot));
			expect(trigger?.disabled).toBe(false);
			expect(container.querySelector('[role="dialog"]')).not.toBeNull();
			expect(observeDialog).toHaveBeenLastCalledWith(
				expect.objectContaining({ open: true, initialScreenshot: screenshot, activeView: "task:fixture" }),
			);
		} finally {
			await act(async () => root.unmount());
			container.remove();
			actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		}
	},
);
