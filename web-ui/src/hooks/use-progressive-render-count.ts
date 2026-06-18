import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 渐进渲染（progressive append render）的领域逻辑：一个长列表初始只挂载前
 * `initialCount` 个子项，当用户把所属滚动容器滚动到底部、末尾的哨兵元素进入视口时，
 * 再分批（每批 `batchIncrement` 个）追加渲染。已渲染的子项保持常驻、不卸载。
 *
 * 之所以自己手写 IntersectionObserver 而不用 `react-use` 的 `useIntersection`：
 * observer 的 `root`（真正的滚动容器）只有在 commit 之后才存在于 DOM 中，无法以
 * 响应式方式提前传入 `useIntersection` 的依赖。这里改为在 effect 内（此时 DOM 已就绪）
 * 通过 `getScrollRoot(sentinel)`（通常是 `sentinel.closest(".kb-...-scroll")`）解析 root，
 * 既正确又自洽。
 */

const INITIAL_RENDER_COUNT = 10;
const RENDER_BATCH_INCREMENT = 10;
const LOAD_MORE_ROOT_MARGIN = "150px";

export interface UseProgressiveRenderCountOptions {
	/** 列表的真实总长度。 */
	totalCount: number;
	/**
	 * 在 effect 内被调用，从末尾哨兵元素向上解析出该列表所属的滚动容器，
	 * 作为 IntersectionObserver 的 `root`。返回 `null` 时回退为以视口为 root。
	 */
	getScrollRoot: (sentinel: HTMLElement) => HTMLElement | null;
	/** 为 `false` 时暂停哨兵观察（例如拖拽进行中，避免中途插入新节点扰乱 dnd 维度）。默认为 `true`。 */
	enabled?: boolean;
	/**
	 * 保证「该索引处的子项」一定落在已渲染范围内（即使它排在初始 cap 之后）。
	 * 详情页用来确保被选中的卡片即便排在很靠后也会立即渲染，供 `scrollIntoView` 命中。
	 */
	ensureVisibleIndex?: number;
	/** 初始渲染数量，默认 {@link INITIAL_RENDER_COUNT}。 */
	initialCount?: number;
	/** 每次触底追加的数量，默认 {@link RENDER_BATCH_INCREMENT}。 */
	batchIncrement?: number;
}

export interface UseProgressiveRenderCountResult {
	/** 当前应渲染的子项数量，已 clamp 到 `[0, totalCount]`。 */
	visibleCount: number;
	/** 是否还有未渲染的子项（`visibleCount < totalCount`）。 */
	hasMore: boolean;
	/** 尚未渲染的剩余数量。 */
	remainingCount: number;
	/** 挂在列表末尾、`placeholder` 之前的哨兵元素 ref。 */
	loadMoreSentinelRef: RefObject<HTMLDivElement>;
	/** 手动追加一批（供哨兵的点击兜底，或 IntersectionObserver 不可用时使用）。 */
	revealMore: () => void;
}

export function useProgressiveRenderCount({
	totalCount,
	getScrollRoot,
	enabled = true,
	ensureVisibleIndex,
	initialCount = INITIAL_RENDER_COUNT,
	batchIncrement = RENDER_BATCH_INCREMENT,
}: UseProgressiveRenderCountOptions): UseProgressiveRenderCountResult {
	const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
	const [rawVisibleCount, setRawVisibleCount] = useState<number>(() => {
		const base = Math.min(totalCount, initialCount);
		// 若挂载时就有一个排在初始 cap 之后的「必须可见」子项（如被选中的卡片），
		// 直接在初始 state 里把它纳入，避免「先渲染 10 个 → effect 再扩展」两次渲染的竞态
		// （那会让父层依赖卡片已挂载的 scrollIntoView 在首帧扑空）。
		if (ensureVisibleIndex != null && ensureVisibleIndex >= 0) {
			return Math.min(totalCount, Math.max(base, ensureVisibleIndex + 1));
		}
		return base;
	});

	// 读取时再 clamp，使列表缩短时不越界；列表增长时保留用户已展开的数量（只增不重置）。
	const visibleCount = Math.min(rawVisibleCount, totalCount);
	const hasMore = visibleCount < totalCount;
	const remainingCount = totalCount - visibleCount;

	const revealMore = useCallback(() => {
		setRawVisibleCount((current) => Math.min(totalCount, current + batchIncrement));
	}, [totalCount, batchIncrement]);

	// 保证被指定的索引（如被选中的卡片）一定在已渲染范围内。
	useEffect(() => {
		if (ensureVisibleIndex == null || ensureVisibleIndex < 0) {
			return;
		}
		setRawVisibleCount((current) => {
			const required = Math.min(totalCount, ensureVisibleIndex + 1);
			return current >= required ? current : required;
		});
	}, [ensureVisibleIndex, totalCount]);

	// 触底追加：哨兵进入滚动容器视口（含 150px 预取边距）时 +batchIncrement。
	useEffect(() => {
		if (!enabled || !hasMore) {
			return;
		}
		const sentinel = loadMoreSentinelRef.current;
		if (!sentinel) {
			return;
		}
		if (typeof IntersectionObserver === "undefined") {
			// 极旧环境 / SSR 兜底：直接全量渲染。
			setRawVisibleCount(totalCount);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setRawVisibleCount((current) => Math.min(totalCount, current + batchIncrement));
				}
			},
			{
				root: getScrollRoot(sentinel),
				rootMargin: LOAD_MORE_ROOT_MARGIN,
			},
		);
		observer.observe(sentinel);
		return () => {
			observer.disconnect();
		};
	}, [totalCount, enabled, hasMore, getScrollRoot, batchIncrement]);

	return {
		visibleCount,
		hasMore,
		remainingCount,
		loadMoreSentinelRef,
		revealMore,
	};
}
