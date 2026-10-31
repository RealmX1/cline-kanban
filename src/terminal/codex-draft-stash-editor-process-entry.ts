import { runCodexDraftStashEditorInvocation } from "./codex-draft-stash-editor-bridge";

try {
	const directoryPath = process.argv[2];
	const nativeEditorFilePath = process.argv[3];
	if (!directoryPath || !nativeEditorFilePath) throw new Error("缺少本代草稿编辑器参数。");
	process.exitCode = await runCodexDraftStashEditorInvocation(directoryPath, nativeEditorFilePath);
} catch (error) {
	process.stderr.write(`Codex 草稿导出失败，原稿保留：${String(error)}\n`);
	process.exitCode = 1;
}
