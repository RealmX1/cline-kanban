import type { TaskImage } from "@/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";
import { readBrowserFileAsBase64 } from "@/utils/read-browser-file-as-base64";

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const ACCEPTED_IMAGE_TYPE_SET = new Set<string>(ACCEPTED_IMAGE_TYPES);

export const ACCEPTED_TASK_IMAGE_INPUT_ACCEPT = ACCEPTED_IMAGE_TYPES.join(",");

export function isAcceptedTaskImageFile(file: File): boolean {
	return ACCEPTED_IMAGE_TYPE_SET.has(file.type);
}

export async function fileToTaskImage(file: File): Promise<TaskImage | null> {
	if (!isAcceptedTaskImageFile(file) || file.size > MAX_IMAGE_SIZE_BYTES) return null;
	try {
		const base64 = await readBrowserFileAsBase64(file);
		if (!base64) return null;
		return {
			id: createRandomUuidV4WithInsecureContextFallback().replaceAll("-", "").slice(0, 12),
			data: base64,
			mimeType: file.type,
			name: file.name || undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Synchronously collect accepted image files from a DataTransfer.
 * Checks `items` first (more reliable for clipboard paste events where
 * `files` can be empty), then falls back to `files`.
 * Must be called synchronously during the event -- browsers clear the
 * DataTransfer after the synchronous dispatch window.
 */
export function collectImageFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
	const files: File[] = [];
	if (dataTransfer.items && dataTransfer.items.length > 0) {
		for (let i = 0; i < dataTransfer.items.length; i++) {
			const item = dataTransfer.items[i];
			if (!item || item.kind !== "file") {
				continue;
			}
			const file = item.getAsFile();
			if (file && isAcceptedTaskImageFile(file)) {
				files.push(file);
			}
		}
	}
	if (files.length === 0) {
		for (const file of Array.from(dataTransfer.files)) {
			if (isAcceptedTaskImageFile(file)) {
				files.push(file);
			}
		}
	}
	return files;
}

export async function extractImagesFromDataTransfer(dataTransfer: DataTransfer): Promise<TaskImage[]> {
	const files = collectImageFilesFromDataTransfer(dataTransfer);
	const images: TaskImage[] = [];
	for (const file of files) {
		const image = await fileToTaskImage(file);
		if (image) {
			images.push(image);
		}
	}
	return images;
}
