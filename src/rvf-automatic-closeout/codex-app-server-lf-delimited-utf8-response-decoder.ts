import { StringDecoder } from "node:string_decoder";

// JSONL 只以 LF 分帧；readline 在 Node 24 会把 JSON 字符串内的 U+2028/U+2029 也拆开。
export function createCodexAppServerLfDelimitedUtf8ResponseDecoder(acceptResponseFrame: (frame: string) => void) {
	const utf8Decoder = new StringDecoder("utf8");
	let pendingResponseFragments: string[] = [];
	const acceptCompleteResponseFrame = (frame: string) =>
		acceptResponseFrame(frame.endsWith("\r") ? frame.slice(0, -1) : frame);
	const acceptDecodedText = (text: string) => {
		let fragmentStart = 0;
		for (
			let newlineIndex = text.indexOf("\n");
			newlineIndex !== -1;
			newlineIndex = text.indexOf("\n", fragmentStart)
		) {
			const fragment = text.slice(fragmentStart, newlineIndex);
			const frame = pendingResponseFragments.length ? pendingResponseFragments.join("") + fragment : fragment;
			pendingResponseFragments = [];
			acceptCompleteResponseFrame(frame);
			fragmentStart = newlineIndex + 1;
		}
		if (fragmentStart < text.length) pendingResponseFragments.push(text.slice(fragmentStart));
	};
	return {
		write: (bytes: Buffer) => acceptDecodedText(utf8Decoder.write(bytes)),
		end: () => {
			acceptDecodedText(utf8Decoder.end());
			if (pendingResponseFragments.length) acceptCompleteResponseFrame(pendingResponseFragments.join(""));
			pendingResponseFragments = [];
		},
	};
}
