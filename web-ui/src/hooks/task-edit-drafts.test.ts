import { describe, expect, it } from "vitest";

import { areTaskImagesEqual } from "@/hooks/task-edit-drafts";
import type { TaskImage } from "@/types";

// 字段顺序与 runtimeTaskImageSchema / fileToTaskImage 一致（id, data, mimeType, name?）。
// 真实构造路径（schema 解析、fileToTaskImage、展开拷贝）产出的都是这个顺序。
function createImage(id: string, data: string, overrides: Partial<TaskImage> = {}): TaskImage {
	return { id, data, mimeType: "image/png", ...overrides };
}

const LARGE_IMAGE_DATA = `data:image/png;base64,${"a".repeat(1_000_000)}`;

describe("areTaskImagesEqual", () => {
	it("treats the same array reference as equal", () => {
		const images = [createImage("image-1", LARGE_IMAGE_DATA)];
		expect(areTaskImagesEqual(images, images)).toBe(true);
	});

	it("treats identical content as equal without depending on identity", () => {
		const left = [createImage("image-1", LARGE_IMAGE_DATA, { name: "paste.png" })];
		const right = [createImage("image-1", LARGE_IMAGE_DATA, { name: "paste.png" })];
		expect(areTaskImagesEqual(left, right)).toBe(true);
	});

	it("detects same-length data whose content differs", () => {
		// 长度早退放它过去，必须靠 data 本身判出不等——粘贴图改一个字节就是这种形态。
		const left = [createImage("image-1", LARGE_IMAGE_DATA)];
		const right = [createImage("image-1", `${LARGE_IMAGE_DATA.slice(0, -1)}b`)];
		expect(areTaskImagesEqual(left, right)).toBe(false);
	});

	it("detects a difference in a later entry", () => {
		const left = [createImage("image-1", "x"), createImage("image-2", "same")];
		const right = [createImage("image-1", "x"), createImage("image-2", "different")];
		expect(areTaskImagesEqual(left, right)).toBe(false);
	});

	it("treats a missing optional name the same as an undefined one", () => {
		const left = [createImage("image-1", "x")];
		const right = [createImage("image-1", "x", { name: undefined })];
		expect(areTaskImagesEqual(left, right)).toBe(true);
	});

	it("detects a name-only difference", () => {
		// name 是 schema 里的可选字段：跳过它会把「只改了文件名」误判成没动过，静默丢掉那次改动。
		const left = [createImage("image-1", "x", { name: "before.png" })];
		const right = [createImage("image-1", "x", { name: "after.png" })];
		expect(areTaskImagesEqual(left, right)).toBe(false);
	});

	describe("matches the JSON.stringify comparison it replaced", () => {
		// 等价性只在真实构造路径的输入形态上成立：字段顺序一致（见 createImage）。
		// JSON.stringify 对键的插入顺序敏感而字段级比较不敏感，但排序异常的输入在仓内不存在。
		const cases: Array<{ name: string; left: TaskImage[]; right: TaskImage[] }> = [
			{ name: "both empty", left: [], right: [] },
			{
				name: "single large image, identical content",
				left: [createImage("image-1", LARGE_IMAGE_DATA)],
				right: [createImage("image-1", LARGE_IMAGE_DATA)],
			},
			{
				name: "identical content including optional name",
				left: [createImage("image-1", LARGE_IMAGE_DATA, { name: "paste.png" })],
				right: [createImage("image-1", LARGE_IMAGE_DATA, { name: "paste.png" })],
			},
			{
				name: "missing name vs undefined name",
				left: [createImage("image-1", "x")],
				right: [createImage("image-1", "x", { name: undefined })],
			},
			{
				name: "different array lengths",
				left: [createImage("image-1", LARGE_IMAGE_DATA)],
				right: [createImage("image-1", LARGE_IMAGE_DATA), createImage("image-2", "y")],
			},
			{
				name: "same byte length, different content",
				left: [createImage("image-1", LARGE_IMAGE_DATA)],
				right: [createImage("image-1", `${LARGE_IMAGE_DATA.slice(0, -1)}b`)],
			},
			{
				name: "content differs at the first byte",
				left: [createImage("image-1", LARGE_IMAGE_DATA)],
				right: [createImage("image-1", `b${LARGE_IMAGE_DATA.slice(1)}`)],
			},
			{
				name: "different id",
				left: [createImage("image-1", "x")],
				right: [createImage("image-2", "x")],
			},
			{
				name: "different mimeType",
				left: [createImage("image-1", "x")],
				right: [createImage("image-1", "x", { mimeType: "image/jpeg" })],
			},
			{
				name: "different name",
				left: [createImage("image-1", "x", { name: "before.png" })],
				right: [createImage("image-1", "x", { name: "after.png" })],
			},
			{
				name: "name vs missing name",
				left: [createImage("image-1", "x", { name: "paste.png" })],
				right: [createImage("image-1", "x")],
			},
			{
				name: "multiple images, all equal",
				left: [createImage("image-1", LARGE_IMAGE_DATA), createImage("image-2", "y", { name: "b.png" })],
				right: [createImage("image-1", LARGE_IMAGE_DATA), createImage("image-2", "y", { name: "b.png" })],
			},
			{
				name: "multiple images, difference in the last entry",
				left: [createImage("image-1", LARGE_IMAGE_DATA), createImage("image-2", "y")],
				right: [createImage("image-1", LARGE_IMAGE_DATA), createImage("image-2", "z")],
			},
		];

		it.each(cases)("$name", ({ left, right }) => {
			expect(areTaskImagesEqual(left, right)).toBe(JSON.stringify(left) === JSON.stringify(right));
		});
	});
});
