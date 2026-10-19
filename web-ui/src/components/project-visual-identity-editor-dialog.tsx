import {
	getDefaultProjectVisualIdentity,
	MAX_PROJECT_ICON_UPLOAD_BYTES,
	PROJECT_PRESET_ICON_IDS,
	PROJECT_VISUAL_COLOR_IDS,
	type ProjectVisualIdentity,
	type SetProjectVisualIdentityRequest,
} from "@runtime-project-visual-identity";
import { type ChangeEvent, useRef, useState } from "react";
import {
	PROJECT_PRESET_ICON_CHINESE_NAMES,
	PROJECT_PRESET_ICON_COMPONENTS,
	PROJECT_VISUAL_COLOR_CHINESE_NAMES,
	ProjectIcon,
} from "@/components/project-visual-identity";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { resetProjectVisualIdentity, saveProjectVisualIdentity } from "@/runtime/project-visual-identity-query";
import type { RuntimeProjectSummary } from "@/runtime/types";

export function ProjectVisualIdentityEditorDialog({
	project,
	onClose,
}: {
	project: RuntimeProjectSummary;
	onClose: () => void;
}) {
	const defaultIdentity = getDefaultProjectVisualIdentity(project.id, project.name);
	const [draft, setDraft] = useState<ProjectVisualIdentity>(project.visualIdentity ?? defaultIdentity);
	const [pendingImageUpload, setPendingImageUpload] = useState<SetProjectVisualIdentityRequest["imageUpload"]>();
	const [imagePreviewDataUrl, setImagePreviewDataUrl] = useState<string>();
	const [shouldResetToDefault, setShouldResetToDefault] = useState(false);
	const [query, setQuery] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [isReadingImage, setIsReadingImage] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const uploadInputRef = useRef<HTMLInputElement>(null);
	async function readImage(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		setError(null);
		if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
			setError("请选择 PNG、JPEG 或 WebP 图片");
			return;
		}
		if (file.size > MAX_PROJECT_ICON_UPLOAD_BYTES) {
			setError("图片文件不得超过 2 MiB");
			return;
		}
		setIsReadingImage(true);
		try {
			const image = await createImageBitmap(file);
			const { width, height } = image;
			image.close();
			if (width > 4096 || height > 4096) throw new Error("图片长宽均不得超过 4096px");
			const dataUrl = await new Promise<string>((resolvePromise, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolvePromise(String(reader.result));
				reader.onerror = () => reject(new Error("图片读取失败"));
				reader.readAsDataURL(file);
			});
			setPendingImageUpload({
				mediaType: file.type as "image/png" | "image/jpeg" | "image/webp",
				base64Content: dataUrl.slice(dataUrl.indexOf(",") + 1),
			});
			setImagePreviewDataUrl(dataUrl);
			setDraft((previous) => ({ ...previous, iconSource: "uploaded_image", imageAssetId: null }));
			setShouldResetToDefault(false);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "图片无法读取，请重新选择");
		} finally {
			setIsReadingImage(false);
		}
	}
	async function save() {
		setIsSaving(true);
		setError(null);
		try {
			if (shouldResetToDefault) await resetProjectVisualIdentity(project.id);
			else
				await saveProjectVisualIdentity({
					workspaceId: project.id,
					...draft,
					...(pendingImageUpload ? { imageUpload: pendingImageUpload } : {}),
				});
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "保存失败，请重试");
		} finally {
			setIsSaving(false);
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !isSaving) onClose();
			}}
			contentAriaDescribedBy="project-icon-upload-guidance"
		>
			<DialogHeader title="编辑项目图标与颜色" />
			<DialogBody className="space-y-4">
				<div className="flex min-h-11 min-w-0 items-center gap-3" role="group" aria-label="项目标识预览">
					<ProjectIcon
						project={project}
						visualIdentity={draft}
						imagePreviewDataUrl={imagePreviewDataUrl}
						size={32}
					/>
					<span className="min-w-0 truncate text-base font-medium text-text-primary" title={project.name}>
						{project.name}
					</span>
				</div>
				<fieldset disabled={isSaving || isReadingImage} className="space-y-4">
					<div>
						<div className="mb-2 text-sm text-text-primary">颜色</div>
						<div className="flex flex-wrap gap-1.5">
							{PROJECT_VISUAL_COLOR_IDS.map((colorId) => (
								<button
									key={colorId}
									type="button"
									aria-label={PROJECT_VISUAL_COLOR_CHINESE_NAMES[colorId]}
									aria-pressed={draft.colorId === colorId}
									title={PROJECT_VISUAL_COLOR_CHINESE_NAMES[colorId]}
									onClick={() => {
										setDraft((previous) => ({ ...previous, colorId }));
										setShouldResetToDefault(false);
									}}
									className={cn(
										"flex h-11 w-11 items-center justify-center rounded-md border focus-visible:outline-2 focus-visible:outline-border-focus",
										draft.colorId === colorId
											? "border-text-primary bg-surface-3"
											: "border-transparent hover:bg-surface-3",
									)}
								>
									<span
										className="h-5 w-5 rounded-full"
										style={{ backgroundColor: `var(--color-project-identity-${colorId})` }}
									/>
								</button>
							))}
						</div>
					</div>
					<div className="space-y-2">
						<label htmlFor="project-preset-icon-search" className="block text-sm text-text-primary">
							预设图标
						</label>
						<input
							id="project-preset-icon-search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索中文名称或英文标识符"
							className="min-h-11 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-text-primary placeholder:text-text-secondary focus:outline-2 focus:outline-border-focus"
						/>
						<div className="grid grid-cols-6 gap-1" role="group" aria-label="预设图标">
							{PROJECT_PRESET_ICON_IDS.filter((id) =>
								`${id} ${PROJECT_PRESET_ICON_CHINESE_NAMES[id]}`
									.toLowerCase()
									.includes(query.trim().toLowerCase()),
							).map((id) => {
								const Icon = PROJECT_PRESET_ICON_COMPONENTS[id];
								return (
									<button
										key={id}
										type="button"
										aria-label={`${PROJECT_PRESET_ICON_CHINESE_NAMES[id]} ${id}`}
										title={`${PROJECT_PRESET_ICON_CHINESE_NAMES[id]} · ${id}`}
										aria-pressed={draft.iconSource === "preset" && draft.presetIconId === id}
										onClick={() => {
											setDraft((previous) => ({
												...previous,
												iconSource: "preset",
												presetIconId: id,
												imageAssetId: null,
											}));
											setPendingImageUpload(undefined);
											setImagePreviewDataUrl(undefined);
											setShouldResetToDefault(false);
										}}
										className={cn(
											"flex min-h-11 items-center justify-center rounded-md border focus-visible:outline-2 focus-visible:outline-border-focus",
											draft.iconSource === "preset" && draft.presetIconId === id
												? "border-text-primary bg-surface-3"
												: "border-transparent hover:bg-surface-3",
										)}
									>
										<Icon size={22} style={{ color: `var(--color-project-identity-${draft.colorId})` }} />
									</button>
								);
							})}
						</div>
						{PROJECT_PRESET_ICON_IDS.every(
							(id) =>
								!`${id} ${PROJECT_PRESET_ICON_CHINESE_NAMES[id]}`
									.toLowerCase()
									.includes(query.trim().toLowerCase()),
						) ? (
							<p className="text-sm text-text-secondary">没有匹配的图标</p>
						) : null}
					</div>
					<div className="space-y-2">
						<input
							ref={uploadInputRef}
							type="file"
							accept="image/png,image/jpeg,image/webp"
							onChange={(event) => void readImage(event)}
							className="hidden"
							aria-label="上传项目图片"
						/>
						<Button className="min-h-11" onClick={() => uploadInputRef.current?.click()}>
							{isReadingImage
								? "正在读取图片…"
								: draft.iconSource === "uploaded_image"
									? "替换图片"
									: "上传图片"}
						</Button>
						<p id="project-icon-upload-guidance" className="text-xs text-text-secondary">
							PNG、JPEG、WebP，最大 2 MiB，长宽各不超过 4096px。不支持动画。完整保留图案，等比例缩放并透明补边。
						</p>
					</div>
				</fieldset>
				{error ? (
					<p role="alert" className="text-sm text-status-red">
						{error}
					</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button
					className="mr-auto min-h-11"
					disabled={isSaving || isReadingImage}
					onClick={() => {
						setDraft(defaultIdentity);
						setPendingImageUpload(undefined);
						setImagePreviewDataUrl(undefined);
						setShouldResetToDefault(true);
						setError(null);
					}}
				>
					恢复默认
				</Button>
				<Button className="min-h-11" disabled={isSaving} onClick={onClose}>
					取消
				</Button>
				<Button
					className="min-h-11"
					variant="primary"
					disabled={isSaving || isReadingImage}
					onClick={() => void save()}
				>
					{isSaving ? "正在保存…" : "保存"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
