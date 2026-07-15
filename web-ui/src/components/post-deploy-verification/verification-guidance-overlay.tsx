import { AlertTriangle, CheckCircle2, Eye, X, XCircle } from "lucide-react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import type { RuntimePostDeployVerificationGuidance } from "@/runtime/types";

export interface VerificationGuidanceOverlayProps {
	// 被引导核对的验证项标签（overlay 标题）。
	label: string;
	guidance: RuntimePostDeployVerificationGuidance;
	// 「看到预期 ✓」：把该项置 checked 并关闭。
	onConfirmObserved: () => void;
	// 「未通过 ✗」：仅关闭（不勾选），让用户排查。
	onReportFailed: () => void;
	onClose: () => void;
}

// 引导人工型验证的分步浮层（plan Stage 4）：现场指导步骤 + 预期观察 + 失败特征 + 通过/未通过按钮。
// 固定左下角、portal 到 body、z 高于面板，便于用户对照被 spotlight 高亮的目标元素同时读步骤。
export function VerificationGuidanceOverlay({
	label,
	guidance,
	onConfirmObserved,
	onReportFailed,
	onClose,
}: VerificationGuidanceOverlayProps): ReactElement | null {
	if (typeof document === "undefined") {
		return null;
	}

	return createPortal(
		<div className="fixed bottom-20 left-4 z-[80] flex max-h-[70vh] w-[340px] flex-col rounded-lg border border-border-bright bg-surface-2 shadow-2xl">
			{/* 标题栏 */}
			<div className="flex shrink-0 items-center justify-between gap-2 rounded-t-lg border-b border-border bg-surface-1 px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<Eye size={16} className="shrink-0 text-accent" />
					<span className="truncate text-sm font-semibold text-text-primary" title={label}>
						{label}
					</span>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="关闭引导"
					className="cursor-pointer rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-primary"
				>
					<X size={14} />
				</button>
			</div>

			{/* 正文（滚动区） */}
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
				{/* 分步指导 */}
				<div>
					<h4 className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
						操作步骤
					</h4>
					<ol className="m-0 list-decimal space-y-1 pl-4 text-[12px] text-text-secondary">
						{guidance.steps.map((step, index) => (
							<li key={`${index}-${step}`}>{step}</li>
						))}
					</ol>
				</div>

				{/* 预期观察 */}
				<div className="rounded-md border border-status-green/30 bg-status-green/10 px-2 py-1.5">
					<div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-status-green">
						<CheckCircle2 size={11} />
						预期观察
					</div>
					<p className="m-0 text-[12px] text-text-secondary">{guidance.expectedObservation}</p>
				</div>

				{/* 失败特征（可选） */}
				{guidance.failureSignature ? (
					<div className="rounded-md border border-status-orange/30 bg-status-orange/10 px-2 py-1.5">
						<div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-status-orange">
							<AlertTriangle size={11} />
							失败特征
						</div>
						<p className="m-0 text-[12px] text-text-secondary">{guidance.failureSignature}</p>
					</div>
				) : null}
			</div>

			{/* 判定按钮 */}
			<div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
				<Button size="sm" variant="primary" fill icon={<CheckCircle2 size={14} />} onClick={onConfirmObserved}>
					看到预期 ✓
				</Button>
				<Button size="sm" variant="default" fill icon={<XCircle size={14} />} onClick={onReportFailed}>
					未通过 ✗
				</Button>
			</div>
		</div>,
		document.body,
	);
}
