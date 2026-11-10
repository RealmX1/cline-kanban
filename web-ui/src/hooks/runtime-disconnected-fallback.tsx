import { AlertCircle } from "lucide-react";
import type { ReactElement } from "react";
import { RuntimeSystemLoadAndRuntimeStatus } from "@/components/runtime-system-load-and-runtime-status";
import { useIsMobile } from "@/hooks/use-is-mobile";

export function RuntimeDisconnectedFallback(): ReactElement {
	const isMobile = useIsMobile();
	return (
		<div className="relative flex h-[100svh] items-center justify-center bg-surface-0 p-6">
			<div className="absolute inset-x-0 top-0 flex justify-end border-b border-border bg-surface-1 px-2 py-1">
				<RuntimeSystemLoadAndRuntimeStatus isMobile={isMobile} />
			</div>
			<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
				<AlertCircle size={48} />
				<h3 className="font-semibold text-text-primary">Kanban 连接已断开</h3>
				<p className="text-text-secondary">正在自动重连，连接恢复后将继续显示工作区。</p>
			</div>
		</div>
	);
}
