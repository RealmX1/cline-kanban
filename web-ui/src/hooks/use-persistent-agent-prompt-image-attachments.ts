import {
	splitAgentPromptImageAttachmentReferences,
	withAgentPromptImageAttachmentReferences,
} from "@runtime-agent-prompt-image-attachment-reference";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentPromptImageAttachmentQueries } from "@/runtime/agent-prompt-image-attachments-query";
import type { TaskImage } from "@/types";

const imagePreviewCache = new Map<string, TaskImage>();
let cachedImageCharacterCount = 0;
function cacheImagePreview(image: TaskImage) {
	cachedImageCharacterCount -= imagePreviewCache.get(image.id)?.data.length ?? 0;
	imagePreviewCache.delete(image.id);
	imagePreviewCache.set(image.id, image);
	cachedImageCharacterCount += image.data.length;
	while (cachedImageCharacterCount > 32 * 1024 * 1024) {
		const oldest = imagePreviewCache.entries().next().value;
		if (!oldest) break;
		cachedImageCharacterCount -= oldest[1].data.length;
		imagePreviewCache.delete(oldest[0]);
	}
}

/** 只有文本存储的提示词入口也能保留图片，不要求各业务协议各建一套附件存储。 */
export function usePersistentAgentPromptImageAttachments({
	value,
	onValueChange,
	enabled,
}: {
	value: string;
	onValueChange: (value: string) => void;
	enabled: boolean;
}) {
	const parsed = useMemo(() => splitAgentPromptImageAttachmentReferences(enabled ? value : ""), [enabled, value]);
	const latestInputRef = useRef({ value, onValueChange });
	latestInputRef.current = { value, onValueChange };
	const [loadedImagePreviews, setLoadedImagePreviews] = useState<ReadonlyMap<string, TaskImage>>(new Map());
	const [preparingImages, setPreparingImages] = useState<TaskImage[]>([]);
	const preparingImagesRef = useRef(preparingImages);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const imageAttachmentIdsKey = JSON.stringify(
		parsed.imageAttachmentReferences.map((reference) => reference.imageAttachmentId),
	);
	useEffect(() => {
		const ids: string[] = JSON.parse(imageAttachmentIdsKey);
		const missing = ids.filter((id) => !imagePreviewCache.has(id));
		if (!missing.length) return;
		let abandoned = false;
		void agentPromptImageAttachmentQueries
			.read(missing)
			.then((images) => {
				if (abandoned) return;
				for (const image of images) cacheImagePreview(image);
				setLoadedImagePreviews(new Map(images.map((image) => [image.id, image])));
			})
			.catch(() => {
				if (!abandoned) setErrorMessage("图片预览暂不可用；已保存的附件引用仍保留。重新打开可重试。");
			});
		return () => {
			abandoned = true;
		};
	}, [imageAttachmentIdsKey]);
	const images = useMemo(
		() => [
			...parsed.imageAttachmentReferences.map(
				(reference) =>
					loadedImagePreviews.get(reference.imageAttachmentId) ??
					imagePreviewCache.get(reference.imageAttachmentId) ?? {
						id: reference.imageAttachmentId,
						data: "",
						mimeType: reference.imageMimeType,
						name: reference.imageDisplayName,
					},
			),
			...preparingImages,
		],
		[parsed, preparingImages, loadedImagePreviews],
	);
	const updateVisibleText = useCallback((text: string) => {
		const current = latestInputRef.current;
		current.onValueChange(
			withAgentPromptImageAttachmentReferences(
				text,
				splitAgentPromptImageAttachmentReferences(current.value).imageAttachmentReferences,
			),
		);
	}, []);
	const updateImages = useCallback((nextImages: TaskImage[]) => {
		const current = latestInputRef.current;
		const split = splitAgentPromptImageAttachmentReferences(current.value);
		const retained = split.imageAttachmentReferences.filter((reference) =>
			nextImages.some((image) => image.id === reference.imageAttachmentId),
		);
		const additions = nextImages.filter(
			(image) =>
				!split.imageAttachmentReferences.some((reference) => reference.imageAttachmentId === image.id) &&
				!preparingImagesRef.current.some((pending) => pending.id === image.id),
		);
		preparingImagesRef.current = [
			...preparingImagesRef.current.filter((image) => nextImages.some((next) => next.id === image.id)),
			...additions,
		];
		setPreparingImages(preparingImagesRef.current);
		if (retained.length !== split.imageAttachmentReferences.length)
			current.onValueChange(
				withAgentPromptImageAttachmentReferences(split.promptTextWithoutImageReferences, retained),
			);
		if (!additions.length) return;
		setErrorMessage(null);
		void agentPromptImageAttachmentQueries
			.save(additions)
			.then((references) => {
				const accepted = references.filter((_, index) =>
					preparingImagesRef.current.some((image) => image.id === additions[index]?.id),
				);
				const newPreviews: [string, TaskImage][] = [];
				for (const [index, reference] of references.entries()) {
					const image = additions[index];
					if (image) {
						const preview = { ...image, id: reference.imageAttachmentId };
						cacheImagePreview(preview);
						newPreviews.push([preview.id, preview]);
					}
				}
				const latest = latestInputRef.current;
				const latestSplit = splitAgentPromptImageAttachmentReferences(latest.value);
				const combined = [
					...latestSplit.imageAttachmentReferences,
					...accepted.filter(
						(reference) =>
							!latestSplit.imageAttachmentReferences.some(
								(existing) => existing.imageAttachmentId === reference.imageAttachmentId,
							),
					),
				];
				latest.onValueChange(
					withAgentPromptImageAttachmentReferences(latestSplit.promptTextWithoutImageReferences, combined),
				);
				preparingImagesRef.current = preparingImagesRef.current.filter(
					(image) => !additions.some((added) => added.id === image.id),
				);
				if (mountedRef.current) {
					setLoadedImagePreviews((current) => new Map([...current, ...newPreviews]));
					setPreparingImages(preparingImagesRef.current);
				}
			})
			.catch((error: unknown) => {
				if (mountedRef.current)
					setErrorMessage(
						`图片未保存，请移除后重新添加：${error instanceof Error ? error.message : String(error)}`,
					);
			});
	}, []);
	return {
		visibleText: enabled ? parsed.promptTextWithoutImageReferences : value,
		onVisibleTextChange: enabled ? updateVisibleText : onValueChange,
		images,
		onImagesChange: updateImages,
		isPreparingImages: preparingImages.length > 0,
		errorMessage,
	};
}
