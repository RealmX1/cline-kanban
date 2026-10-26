import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import type { TaskVisualizationTaskAttribution } from "../core/task-visualization-artifact-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	TaskVisualizationPublicationFileSizeLimitError,
	taskVisualizationPublicationMaximumFileSizeBytes,
} from "./task-visualization-publication-resource-limits";

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function documentNodes(html: string): DefaultTreeAdapterMap["node"][] {
	const nodes: DefaultTreeAdapterMap["node"][] = [];
	const visit = (node: DefaultTreeAdapterMap["node"]) => {
		nodes.push(node);
		if ("childNodes" in node) for (const child of node.childNodes) visit(child);
	};
	visit(parse(html, { sourceCodeLocationInfo: true }));
	return nodes;
}

export function renderHtmlWithTaskAttribution(html: string, attribution: TaskVisualizationTaskAttribution): string {
	if (!attribution.workspaceId || !attribution.taskId || !attribution.taskTitle)
		throw new Error("任务归属或任务名尚未确认，不能生成完整署名。");
	// 仅改写真实 DOM 中的署名区；脚本、注释里的标签样文本及其余源码逐字保留。
	const previousAttributions = documentNodes(html)
		.filter(
			(node) =>
				"attrs" in node &&
				node.attrs.some(
					(attribute) => attribute.name === "data-kanban-task-attribution" && attribute.value === "v1",
				),
		)
		.map((node) => node.sourceCodeLocation)
		.filter((location) => location !== null && location !== undefined)
		.sort((left, right) => left.startOffset - right.startOffset);
	let withoutAttribution = "";
	let nextOriginalOffset = 0;
	for (const location of previousAttributions) {
		if (location.startOffset >= nextOriginalOffset)
			withoutAttribution += html.slice(nextOriginalOffset, location.startOffset);
		nextOriginalOffset = Math.max(nextOriginalOffset, location.endOffset);
	}
	withoutAttribution += html.slice(nextOriginalOffset);
	const nodes = documentNodes(withoutAttribution);
	const body = nodes.find((node) => "tagName" in node && node.tagName === "body");
	const bodyLocation = body && "tagName" in body ? body.sourceCodeLocation : undefined;
	const firstBodyContent =
		body && "childNodes" in body
			? body.childNodes.find((node) => node.sourceCodeLocation)?.sourceCodeLocation?.startOffset
			: undefined;
	const head = nodes.find((node) => "tagName" in node && node.tagName === "head");
	const headEnd = head && "tagName" in head ? head.sourceCodeLocation?.endTag?.endOffset : undefined;
	const insertionOffset =
		bodyLocation?.startTag?.endOffset ?? firstBodyContent ?? headEnd ?? withoutAttribution.length;
	const signature = `<aside data-kanban-task-attribution="v1" data-workspace-id="${escapeHtml(attribution.workspaceId)}" data-task-id="${escapeHtml(attribution.taskId)}" aria-label="可视化任务署名" style="all:initial;display:block;position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:calc(100vw - 24px);box-sizing:border-box;padding:10px 16px;background:#111827;color:#f9fafb;border:1px solid #374151;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere;pointer-events:none">任务 <strong>${escapeHtml(attribution.taskId)}</strong> · ${escapeHtml(attribution.taskTitle)}</aside>`;
	const attributed =
		withoutAttribution.slice(0, insertionOffset) + signature + withoutAttribution.slice(insertionOffset);
	if (Buffer.byteLength(attributed, "utf8") > taskVisualizationPublicationMaximumFileSizeBytes)
		throw new TaskVisualizationPublicationFileSizeLimitError("HTML 署名后的入口超过单文件 50MB 限额，原文件已保留。");
	return attributed;
}

export async function applyTaskAttributionToHtmlFile(
	sourceHtmlFilePath: string,
	attribution: TaskVisualizationTaskAttribution,
) {
	const canonicalFilePath = await realpath(resolve(sourceHtmlFilePath));
	if (![".html", ".htm"].includes(extname(canonicalFilePath).toLowerCase())) throw new Error("入口必须是 HTML 文件。");
	return await lockedFileSystem.withLock({ path: canonicalFilePath }, async () => {
		const fileStat = await stat(canonicalFilePath);
		if (fileStat.size > taskVisualizationPublicationMaximumFileSizeBytes)
			throw new TaskVisualizationPublicationFileSizeLimitError("HTML 入口超过单文件 50MB 限额，原文件已保留。");
		const original = await readFile(canonicalFilePath, "utf8");
		const attributed = renderHtmlWithTaskAttribution(original, attribution);
		const didUpdateHtml = attributed !== original;
		if (didUpdateHtml)
			await lockedFileSystem.writeTextFileAtomic(canonicalFilePath, attributed, {
				lock: null,
				durable: true,
				fileMode: fileStat.mode & 0o777,
			});
		return { sourceHtmlFilePath: canonicalFilePath, taskAttribution: attribution, didUpdateHtml };
	});
}
