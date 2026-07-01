import { toBlob } from "html-to-image";

import { fileToTaskImage } from "@/components/task-image-input-utils";
import type { TaskImage } from "@/types";

const SCREENSHOT_FILE_NAME = "kanban-bug-screenshot.png";

/**
 * Capture the current page as a PNG and convert it to a TaskImage (base64 inline), reusing
 * the same attachment pipeline as manually-added task images.
 *
 * ponytail: DOM-to-image via html-to-image. Known ceiling — it rasterizes the live DOM, so
 * <canvas>/WebGL surfaces (e.g. the xterm terminal) and cross-origin images may render blank
 * or partial. Swap to getDisplayMedia if pixel-accurate terminal capture is ever needed
 * (that trades away the "silent automatic" capture for a screen-picker prompt).
 *
 * Returns null when capture fails (best-effort — the bug report is still submittable without it).
 */
export async function capturePageScreenshotAsTaskImage(): Promise<TaskImage | null> {
	try {
		const blob = await toBlob(document.body, {
			// Cap pixel ratio so a HiDPI screen doesn't blow past the 20MB TaskImage limit.
			pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
			backgroundColor: "#1F2428",
			cacheBust: true,
		});
		if (!blob) {
			return null;
		}
		const file = new File([blob], SCREENSHOT_FILE_NAME, { type: "image/png" });
		return await fileToTaskImage(file);
	} catch {
		return null;
	}
}
