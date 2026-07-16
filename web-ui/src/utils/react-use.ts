import type { DependencyList, Dispatch, SetStateAction } from "react";
import { useCallback, useRef } from "react";
import {
	useCopyToClipboard as useReactUseCopyToClipboard,
	useDebounce as useReactUseDebounce,
	useEvent as useReactUseEvent,
	useInterval as useReactUseInterval,
	useLocalStorage as useReactUseLocalStorage,
	useMeasure as useReactUseMeasure,
	useMedia as useReactUseMedia,
	useTitle as useReactUseTitle,
	useUnmount as useReactUseUnmount,
} from "react-use";

type DomEventOptions = boolean | AddEventListenerOptions;
type StateSetter<T> = Dispatch<SetStateAction<T>>;

function getWindowTarget(): Window | null {
	if (typeof window === "undefined") {
		return null;
	}
	return window;
}

function getDocumentTarget(): Document | null {
	if (typeof document === "undefined") {
		return null;
	}
	return document;
}

export function useWindowEvent<K extends keyof WindowEventMap>(
	name: K,
	handler: ((event: WindowEventMap[K]) => void) | null,
	options?: DomEventOptions,
): void {
	useReactUseEvent(name, handler as ((event?: Event) => void) | null, getWindowTarget(), options);
}

export function useDocumentEvent<K extends keyof DocumentEventMap>(
	name: K,
	handler: ((event: DocumentEventMap[K]) => void) | null,
	options?: DomEventOptions,
): void {
	useReactUseEvent(name, handler as ((event?: Event) => void) | null, getDocumentTarget(), options);
}

export function useInterval(callback: () => void, delayMs: number | null): void {
	useReactUseInterval(callback, delayMs);
}

export function useDebouncedEffect(effect: () => void, delayMs: number, deps: DependencyList): void {
	useReactUseDebounce(effect, delayMs, deps);
}

export function useCopyToClipboard() {
	return useReactUseCopyToClipboard();
}

function resolveNextValue<T>(nextValue: SetStateAction<T>, currentValue: T): T {
	if (typeof nextValue === "function") {
		return (nextValue as (previousValue: T) => T)(currentValue);
	}
	return nextValue;
}

// react-use useLocalStorage 的 `set` 回调依赖数组是 [key, setState]、不含 state（最新 17.6.1 仍如此），
// 传函数式更新器进去会拿到首帧冻结的旧值。这里用 ref 自持最新值、在本层解析 SetStateAction，
// 只向 react-use 传字面量，绕开其 stale 分支。
//
// latestValueRef 仅在渲染期（下方 `latestValueRef.current = currentValue`）随「最新已显示值」同步，
// 而该同步与 react-use 的重渲染同源：只有 setItem 写盘成功、react-use 才会 setState 触发重渲染并推进本 ref。
// 因此绝不在 set 里急切前移 ref——react-use 的 `set` 把 localStorage.setItem 与 setState 放在同一 try 块里，
// setItem 抛错（隐私模式 / 配额耗尽 / 序列化失败）会被静默吞掉并跳过 setState；此时若急切前移 ref，
// ref 就会领先于「既未持久化、也未重渲染显示」的旧值，令下一次函数式更新器基于该幽灵值计算、白吃一次点击。
// 只依赖渲染期同步则 ref 与已显示值永不背离（写盘失败即两者都停在旧值，写盘成功即两者一起前进）。
//
// 代价：同一渲染周期内对同一 key 连续多次函数式 set 会因 ref 尚未经渲染期同步而丢更新。但本仓库这三个 wrapper
// 的全部 setter 调用点均为「每次事件单独一次 set、各自独立渲染周期」（唯二函数式调用点是 Post-Deploy Verification
// 面板的 stayInFront / collapsed toggle），无同周期多次 set，故无需急切前移。若将来新增同周期多次 set 的调用点，
// 应改用「写盘成功才推进 ref」的方案（react-use 的 set 吞错、无法直接得知成败），而非恢复无条件急切前移。
function useStaleClosureSafeLocalStorageSetter<T>(currentValue: T, setStoredValue: (value: T) => void): StateSetter<T> {
	const latestValueRef = useRef(currentValue);
	latestValueRef.current = currentValue;
	return useCallback(
		(nextValue) => {
			const resolvedValue = resolveNextValue(nextValue, latestValueRef.current);
			setStoredValue(resolvedValue);
		},
		[setStoredValue],
	);
}

export function useBooleanLocalStorageValue(key: string, initialValue: boolean): [boolean, StateSetter<boolean>] {
	const [storedValue, setStoredValue] = useReactUseLocalStorage<boolean>(key, initialValue, {
		raw: false,
		serializer: (value) => String(value),
		deserializer: (value) => value === "true",
	});
	const value = storedValue ?? initialValue;
	const setValue = useStaleClosureSafeLocalStorageSetter(value, setStoredValue);
	return [value, setValue];
}

export function useRawLocalStorageValue<T extends string>(
	key: string,
	initialValue: T,
	normalize: (value: string) => T | null,
): [T, StateSetter<T>] {
	const [storedValue, setStoredValue] = useReactUseLocalStorage<string>(key, initialValue, {
		raw: true,
	});
	const value = storedValue ? (normalize(storedValue) ?? initialValue) : initialValue;
	const setValue = useStaleClosureSafeLocalStorageSetter<T>(value, setStoredValue);
	return [value, setValue];
}

export function useJsonLocalStorageValue<T>(key: string, initialValue: T): [T, StateSetter<T>] {
	// react-use's default serializer is JSON.stringify/parse when `raw` is false.
	const [storedValue, setStoredValue] = useReactUseLocalStorage<T>(key, initialValue);
	const value = storedValue ?? initialValue;
	const setValue = useStaleClosureSafeLocalStorageSetter(value, setStoredValue);
	return [value, setValue];
}

export function useDocumentTitle(title: string): void {
	useReactUseTitle(title);
}

export function useMeasure<T extends Element = Element>() {
	return useReactUseMeasure<T>();
}

export function useUnmount(fn: () => void): void {
	useReactUseUnmount(fn);
}

export function useMedia(query: string, defaultState?: boolean): boolean {
	return useReactUseMedia(query, defaultState);
}
