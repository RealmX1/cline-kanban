# Stage-First Overview 按 raw 列归属判定 stage 成员

Cross-Repository Stage-First Overview（跨-repo 概览，见 `CONTEXT.md`）按 board 的**列归属**（raw column membership）判定每个 stage 的成员，In-Progress 阶段内部再按活跃度自行二分 Active / Stale——**刻意不复用**主看板计数所用的 live-session overlay（`src/server/project-task-counts-live-session-overlay.ts` 的 `applyLiveSessionStateToProjectTaskCounts`，它会把 `awaiting_review` 的 task 从 `in_progress` 挪进 `review`、把 `interrupted` 的挪进 `trash`）。

原因：概览要让「停在 `in_progress` 列、但 agent 已交棒等审 / 卡住 / 空闲」的 task 仍留在 In-Progress 的 **Stale** 组里可见，而不是消失进 Review 计数。这与主看板计数口径不同是**有意为之**——因此 `RuntimeProjectSummary` 同时携带 overlay 后的 `taskCounts`（主看板用）与 raw 的 `rawColumnTaskCounts`（本概览用），二者并存不冲突。

未来若有人想「统一」两处口径把 overlay 也套到概览上，会破坏 Stale 组的可见性——请先读本 ADR。
