import { Loader2 } from "lucide-react";

import { cn } from "@/components/ui/cn";

// 只用于短暂的加载态（按钮提交中、请求在途）。常驻的「在跑」标记别用它：无限旋转让浏览器每帧都提交合成，
// 看板页可见期间系统合成器一直忙（见 use-session-activity-dot-breathing-opacity-on-shared-fine-clock）。
export function Spinner({ size = 16, className }: { size?: number; className?: string }): React.ReactElement {
	return (
		<Loader2 size={size} className={cn("animate-spin motion-reduce:animate-none text-text-secondary", className)} />
	);
}
