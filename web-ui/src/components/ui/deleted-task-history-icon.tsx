/** 沿用 Lucide 的轮廓与线宽，掀起桶盖表示打开已删除任务历史。 */
export function DeletedTaskHistoryIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<g transform="translate(0 -1) rotate(-15 12 6)">
				<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
			</g>
			<path d="M19 8v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8M10 11v6M14 11v6" />
		</svg>
	);
}
