import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import {
	createProjectVisualIdentityStore,
	normalizeUploadedProjectIconImage,
} from "../../src/state/project-visual-identity-store";

describe("项目标识原子存储和上传边界", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "project-visual-identity-store-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});
	const presetRequest = {
		workspaceId: "registered-project",
		iconSource: "preset",
		presetIconId: "Ship",
		colorId: "teal",
		imageAssetId: null,
	} as const;
	it.each(["jpeg", "webp", "png"] as const)("合法 %s 均重新编码为 PNG", async (format) => {
		const bytes = await sharp({ create: { width: 20, height: 40, channels: 3, background: "blue" } })
			.toFormat(format)
			.toBuffer();
		const normalized = await normalizeUploadedProjectIconImage({
			mediaType: `image/${format}`,
			base64Content: bytes.toString("base64"),
		});
		expect(await sharp(normalized).metadata()).toMatchObject({ format: "png", width: 128, height: 128 });
	});
	it("自定义优先，重新创建 store 后保持，恢复建议不改仓库", async () => {
		const store = createProjectVisualIdentityStore(root, async () => true);
		expect((await store.read(presetRequest.workspaceId, "cline-kanban")).presetIconId).toBe("KanbanSquare");
		await store.save(presetRequest);
		expect(
			(
				await createProjectVisualIdentityStore(root, async () => true).read(
					presetRequest.workspaceId,
					"cline-kanban",
				)
			).presetIconId,
		).toBe("Ship");
		await store.reset(presetRequest.workspaceId, "cline-kanban");
		expect((await store.read(presetRequest.workspaceId, "cline-kanban")).presetIconId).toBe("KanbanSquare");
	});
	it("保存失败保留已保存配置", async () => {
		const store = createProjectVisualIdentityStore(root, async () => true);
		await store.save(presetRequest);
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockRejectedValueOnce(new Error("模拟磁盘写入失败"));
		await expect(store.save({ ...presetRequest, colorId: "red" })).rejects.toThrow("模拟磁盘写入失败");
		expect((await store.read(presetRequest.workspaceId, "cline-kanban")).colorId).toBe("teal");
	});
	it("透明补边到 128 方图、按 hash 读取与替换，损坏配置安全回退", async () => {
		const store = createProjectVisualIdentityStore(root, async () => true);
		const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		const identity = await store.save({
			...presetRequest,
			iconSource: "uploaded_image",
			imageUpload: { mediaType: "image/png", base64Content: bytes.toString("base64") },
		});
		expect(identity.imageAssetId).toMatch(/^[a-f0-9]{64}$/);
		const image = await store.readImage(presetRequest.workspaceId, identity.imageAssetId as string);
		const output = sharp(Buffer.from(image.base64Content, "base64"));
		expect(await output.metadata()).toMatchObject({ width: 128, height: 128, format: "png", hasAlpha: true });
		const { data } = await output.raw().toBuffer({ resolveWithObject: true });
		expect(data[3]).toBe(0);
		expect(data[(64 * 128 + 64) * 4 + 3]).toBe(255);
		await store.save({
			...presetRequest,
			iconSource: "uploaded_image",
			imageAssetId: identity.imageAssetId,
			colorId: "blue",
		});
		await store.save(presetRequest);
		await writeFile(join(root, presetRequest.workspaceId, "project-visual-identity.json"), "broken");
		expect((await store.read(presetRequest.workspaceId, "cline-kanban")).presetIconId).toBe("KanbanSquare");
	});
	it("拒绝伪造格式、损坏、SVG、动画、过大图片和路径遍历", async () => {
		const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } })
			.png()
			.toBuffer();
		await expect(
			normalizeUploadedProjectIconImage({ mediaType: "image/jpeg", base64Content: png.toString("base64") }),
		).rejects.toThrow("格式");
		await expect(
			normalizeUploadedProjectIconImage({
				mediaType: "image/png",
				base64Content: Buffer.from("corrupt").toString("base64"),
			}),
		).rejects.toThrow();
		await expect(
			normalizeUploadedProjectIconImage({
				mediaType: "image/png",
				base64Content: Buffer.from('<svg width="2" height="2"></svg>').toString("base64"),
			}),
		).rejects.toThrow("格式");
		const oversized = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		await expect(
			normalizeUploadedProjectIconImage({ mediaType: "image/png", base64Content: oversized.toString("base64") }),
		).rejects.toThrow("4096");
		await expect(
			normalizeUploadedProjectIconImage({
				mediaType: "image/png",
				base64Content: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
			}),
		).rejects.toThrow("2 MiB");
		const animationPixels = Buffer.alloc(2 * 4 * 4, 255);
		animationPixels.fill(0, 2 * 2 * 4);
		const animated = await sharp(animationPixels, {
			raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
		})
			.webp({ loop: 0, delay: [100, 100] })
			.toBuffer();
		await expect(
			normalizeUploadedProjectIconImage({ mediaType: "image/webp", base64Content: animated.toString("base64") }),
		).rejects.toThrow("动画");
		await expect(
			normalizeUploadedProjectIconImage({ mediaType: "image/png", base64Content: "%%%%" }),
		).rejects.toThrow("编码");
		// APNG 的控制块可被只读首帧的解码器忽略，仍须拒绝上传。
		const animationControlChunk = Buffer.alloc(20);
		animationControlChunk.writeUInt32BE(8, 0);
		animationControlChunk.write("acTL", 4, "ascii");
		animationControlChunk.writeUInt32BE(2, 8);
		let crc = 0xffffffff;
		for (const byte of animationControlChunk.subarray(4, 16)) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		animationControlChunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 16);
		const animatedPng = Buffer.concat([png.subarray(0, 33), animationControlChunk, png.subarray(33)]);
		await expect(
			normalizeUploadedProjectIconImage({ mediaType: "image/png", base64Content: animatedPng.toString("base64") }),
		).rejects.toThrow("动画");
		const store = createProjectVisualIdentityStore(root, async () => true);
		await expect(store.save({ ...presetRequest, workspaceId: "../escape" })).rejects.toThrow("workspace");
		await expect(store.readImage(presetRequest.workspaceId, "../secret")).rejects.toThrow();
		await expect(createProjectVisualIdentityStore(root, async () => false).save(presetRequest)).rejects.toThrow(
			"未注册",
		);
	});
});
