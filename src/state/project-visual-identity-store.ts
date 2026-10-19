import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import {
	getDefaultProjectVisualIdentity,
	MAX_PROJECT_ICON_IMAGE_DIMENSION,
	MAX_PROJECT_ICON_UPLOAD_BYTES,
	type ProjectVisualIdentity,
	projectIconImageAssetIdSchema,
	projectVisualIdentitySchema,
	type SetProjectVisualIdentityRequest,
	setProjectVisualIdentityRequestSchema,
} from "../core/project-visual-identity";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspacesRootPath, listWorkspaceIndexEntries } from "./workspace-state";

function containsAnimatedPngControlChunk(bytes: Buffer): boolean {
	// 部分 libvips PNG loader 只读 APNG 首帧，不报告 pages；以 PNG chunk 类型补齐动画拒绝。
	for (let offset = 8; offset + 12 <= bytes.length; ) {
		const chunkLength = bytes.readUInt32BE(offset);
		if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") return true;
		offset += chunkLength + 12;
	}
	return false;
}

export async function normalizeUploadedProjectIconImage(
	upload: NonNullable<SetProjectVisualIdentityRequest["imageUpload"]>,
): Promise<Buffer> {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(upload.base64Content))
		throw new Error("图片编码无效");
	const bytes = Buffer.from(upload.base64Content, "base64");
	if (bytes.length === 0 || bytes.length > MAX_PROJECT_ICON_UPLOAD_BYTES) throw new Error("图片文件不得超过 2 MiB");
	const image = sharp(bytes, {
		animated: true,
		limitInputPixels: MAX_PROJECT_ICON_IMAGE_DIMENSION ** 2,
		failOn: "warning",
	});
	const metadata = await image.metadata();
	const expectedFormat = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[upload.mediaType];
	if (!expectedFormat || metadata.format !== expectedFormat)
		throw new Error("图片实际格式与声明类型不一致，仅支持 PNG、JPEG、WebP");
	if ((metadata.pages ?? 1) !== 1 || (metadata.format === "png" && containsAnimatedPngControlChunk(bytes)))
		throw new Error("不支持动画图片");
	if (
		!metadata.width ||
		!metadata.height ||
		metadata.width > MAX_PROJECT_ICON_IMAGE_DIMENSION ||
		metadata.height > MAX_PROJECT_ICON_IMAGE_DIMENSION
	)
		throw new Error("图片长宽均不得超过 4096px");
	return await image
		.autoOrient()
		.resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();
}

export function createProjectVisualIdentityStore(
	workspacesRootPath: string,
	isWorkspaceRegistered: (workspaceId: string) => Promise<boolean>,
) {
	function workspaceDirectory(workspaceId: string): string {
		const directory = resolve(workspacesRootPath, workspaceId);
		if (dirname(directory) !== resolve(workspacesRootPath)) throw new Error("无效的 workspace ID");
		return directory;
	}
	async function withWorkspaceLock<T>(workspaceId: string, operation: (directory: string) => Promise<T>): Promise<T> {
		const directory = workspaceDirectory(workspaceId);
		// 与永久删除共用根锁，防止删除后保存请求重新建出一个孤立 workspace。
		return await lockedFileSystem.withLock(
			{ path: workspacesRootPath, type: "directory", lockfileName: ".workspaces.lock" },
			async () => {
				if (!(await isWorkspaceRegistered(workspaceId))) throw new Error("项目未注册或已删除");
				const metadata = await lstat(directory).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				});
				if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink()))
					throw new Error("项目状态目录不安全");
				return await lockedFileSystem.withLock(
					{ path: directory, type: "directory", lockfilePath: join(workspacesRootPath, `${workspaceId}.lock`) },
					() => operation(directory),
				);
			},
		);
	}
	return {
		async read(workspaceId: string, projectName: string): Promise<ProjectVisualIdentity> {
			const fallback = getDefaultProjectVisualIdentity(workspaceId, projectName);
			try {
				const parsed = projectVisualIdentitySchema.safeParse(
					JSON.parse(
						await readFile(join(workspaceDirectory(workspaceId), "project-visual-identity.json"), "utf8"),
					),
				);
				return parsed.success ? parsed.data : fallback;
			} catch {
				return fallback;
			}
		},
		async save(request: SetProjectVisualIdentityRequest): Promise<ProjectVisualIdentity> {
			const parsed = setProjectVisualIdentityRequestSchema.parse(request);
			// 解码放在锁外，避免 CPU 工作占用全局项目索引锁。
			const normalizedImage = parsed.imageUpload
				? await normalizeUploadedProjectIconImage(parsed.imageUpload)
				: null;
			return await withWorkspaceLock(parsed.workspaceId, async (directory) => {
				let imageAssetId = parsed.imageAssetId;
				const imageDirectory = join(directory, "uploaded-project-icon-images");
				if (normalizedImage) {
					imageAssetId = createHash("sha256").update(normalizedImage).digest("hex");
					await mkdir(imageDirectory, { recursive: true });
					const stagingPath = join(imageDirectory, `${imageAssetId}.${randomUUID()}.png`);
					try {
						await writeFile(stagingPath, normalizedImage);
						await rename(stagingPath, join(imageDirectory, `${imageAssetId}.png`));
					} finally {
						await rm(stagingPath, { force: true });
					}
				} else if (imageAssetId) {
					await readFile(join(imageDirectory, `${imageAssetId}.png`));
				}
				const identity = projectVisualIdentitySchema.parse({
					iconSource: parsed.iconSource,
					presetIconId: parsed.presetIconId,
					colorId: parsed.colorId,
					imageAssetId,
				});
				await lockedFileSystem.writeJsonFileAtomic(join(directory, "project-visual-identity.json"), identity, {
					lock: null,
				});
				return identity;
			});
		},
		async reset(workspaceId: string, projectName: string): Promise<ProjectVisualIdentity> {
			return await withWorkspaceLock(workspaceId, async (directory) => {
				await lockedFileSystem.writeJsonFileAtomic(join(directory, "project-visual-identity.json"), null, {
					lock: null,
				});
				return getDefaultProjectVisualIdentity(workspaceId, projectName);
			});
		},
		async readImage(
			workspaceId: string,
			imageAssetId: string,
		): Promise<{ mediaType: "image/png"; base64Content: string }> {
			projectIconImageAssetIdSchema.parse(imageAssetId);
			return await withWorkspaceLock(workspaceId, async (directory) => ({
				mediaType: "image/png",
				base64Content: (
					await readFile(join(directory, "uploaded-project-icon-images", `${imageAssetId}.png`))
				).toString("base64"),
			}));
		},
	};
}

export const projectVisualIdentityStore = createProjectVisualIdentityStore(
	getWorkspacesRootPath(),
	async (workspaceId) => (await listWorkspaceIndexEntries()).some((entry) => entry.workspaceId === workspaceId),
);
