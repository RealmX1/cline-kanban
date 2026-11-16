export function formatLineChangeCountWithThousandsSuffix(lineChangeCount: number): string {
	if (lineChangeCount < 1_000) return String(lineChangeCount);
	if (lineChangeCount < 10_000) return `${(Math.round(lineChangeCount / 100) / 10).toFixed(1)}K`;
	return `${Math.round(lineChangeCount / 1_000)}K`;
}
