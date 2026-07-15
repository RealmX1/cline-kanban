// 部署 / Post-Deploy Verification 各模块（deploy-marker / post-deploy-verification-state /
// task-deploy-correlation / deployment-api / deployment CLI）容错降级时的告警统一出口。
// 沿用 diagnostics/*-logger.ts 的 process.stderr.write 约定：绕过 no-console lint
// （grit/no-console.grit），无需 opt-in 即在服务端日志可见。各调用点自带 [模块名] 前缀，
// 这里只补 [warn] 级别标签，形如 `[warn] [deploy-marker] ...`。
export function logDeploymentDiagnosticWarning(message: string): void {
	try {
		process.stderr.write(`[warn] ${message}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
}
