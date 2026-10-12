import type { TaskImage } from "@/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const ACCEPTED_IMAGE_TYPE_SET = new Set<string>(ACCEPTED_IMAGE_TYPES);

export const ACCEPTED_TASK_IMAGE_INPUT_ACCEPT = ACCEPTED_IMAGE_TYPES.join(",");

export function isAcceptedTaskImageFile(file: File): boolean {
	return ACCEPTED_IMAGE_TYPE_SET.has(file.type);
}

export async function fileToTaskImage(file: File): Promise<TaskImage | null> {
	return await new Promise((resolve) => {
		if (!isAcceptedTaskImageFile(file)) {
			resolve(null);
			return;
		}
		if (file.size > MAX_IMAGE_SIZE_BYTES) {
			resolve(null);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				resolve(null);
				return;
			}
			const base64 = result.split(",")[1];
			if (!base64) {
				resolve(null);
				return;
			}
			resolve({
				id: createRandomUuidV4WithInsecureContextFallback().replaceAll("-", "").slice(0, 12),
				data: base64,
				mimeType: file.type,
				name: file.name || undefined,
			});
		};
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
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
