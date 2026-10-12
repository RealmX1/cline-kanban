// 关系账本容错降级时的告警出口。沿用 diagnostics/*-logger.ts 的 process.stderr.write 约定
// （绕过 grit/no-console.grit），在服务端日志可见。
export function logInterWorkUnitRelationLedgerDiagnosticWarning(message: string): void {
	try {
		process.stderr.write(`[warn] [inter-work-unit-relation-ledger] ${message}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
}
