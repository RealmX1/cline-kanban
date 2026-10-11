import type { RuntimePostDeployVerificationTask } from "./api-contract";

// Post-Deploy Verification 任务条目「已结案 / 仍待核对」的唯一判据。服务端（门禁、对账、CLI、record 延续）与 web-ui
// （顶栏 badge、面板标题、分区计数与排序、门禁预检）共用这一份——两边各写一份曾经漂移过（web-ui 漏了
// carriedForwardIntoDeploymentId 的排除）。纯函数、只有类型依赖：web-ui 经
// `@runtime-post-deploy-verification-task-closed-and-awaiting-verification-predicates` 直接引用（三处 alias 同步）。
//
// 容忍字段缺失：服务端读到的条目已由 zod default 补齐 2026-10-11 新增字段；web-ui 收到的是 JSON，旧 runtime（回滚 /
// 版本错位）与浏览器测试 fixture 可能根本没有这些键，缺失一律按默认值（null / false）处理。

// 已结案 = 全勾通过（verifiedAt）或带原因结案（postDeployVerificationClosure）二者之一。
export function isPostDeployVerificationTaskClosed(
	task: Pick<RuntimePostDeployVerificationTask, "verifiedAt" | "postDeployVerificationClosure">,
): boolean {
	return task.verifiedAt !== null || (task.postDeployVerificationClosure ?? null) !== null;
}

/** 仍在等核对的条目：未结案、未被移除、不是只读展示、也没被延续到更新的组。 */
export function isPostDeployVerificationTaskAwaitingVerification(task: RuntimePostDeployVerificationTask): boolean {
	return (
		!isPostDeployVerificationTaskClosed(task) &&
		task.droppedReason === null &&
		task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded !== true &&
		(task.carriedForwardIntoDeploymentId ?? null) === null
	);
}
