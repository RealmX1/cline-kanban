import pLimit from "p-limit";

// 计算一次 workspace diff 时，会为每个变更文件读取 old/new 内容（`git show <ref>:path` 子进程 +
// `fs.readFile` 工作树读取）。若无界并发（`Promise.all(files.map(...))`），N 个文件会在事件循环线程上
// 同时触发 N 个 `uv_spawn`（git 子进程的 spawn 发生在 loop 线程），成百上千个 spawn 直接把事件循环
// 卡死数十秒；机器上还并行跑着十几个数百 MB 的 agent 进程时尤甚。
//
// 这个上限是「跨所有请求共享的模块级单例」——关键在于共享：即便同时有 N 个 tRPC 请求各自 fan-out，
// 总并发的 git/fs 文件读取也被钳制成常数（GIT_FILE_READ_CONCURRENCY_LIMIT），而非每请求各自 N。
// 被限流的任务内部只直接调用 git-show / readFile，不再经此 limiter 入队，故不会自我嵌套、不会死锁。
const GIT_FILE_READ_CONCURRENCY_LIMIT = 12;

export const gitFileReadConcurrencyLimiter = pLimit(GIT_FILE_READ_CONCURRENCY_LIMIT);
