import { describe, expect, it } from "vitest";

import {
	normalizeDecodedTerminalOutput,
	normalizeTerminalText,
	stripAnsiAndControl,
} from "../../../src/terminal/terminal-output-normalization";

// stripAnsiAndControl 的历史逐码点实现,内嵌为等价性 reference:切片化重写必须与它
// **逐字节等价**(含既有怪癖——两字节转义 `ESC ( B` 漏出末字节、C1 控制符按可打印保留、
// ESC 后代理对整对吞掉)。下游 substance / connection-error 语义依赖这一等价性。
const REFERENCE_ESCAPE = String.fromCharCode(0x1b);
const REFERENCE_BELL = String.fromCharCode(0x07);

function referenceStripAnsiAndControl(input: string): string {
	let output = "";
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	for (const char of input) {
		if (mode === "text") {
			if (char === REFERENCE_ESCAPE) {
				mode = "escape";
				continue;
			}
			const code = char.charCodeAt(0);
			if ((code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t") {
				output += char;
			}
			continue;
		}
		if (mode === "escape") {
			if (char === "[") {
				mode = "csi";
				continue;
			}
			if (char === "]") {
				mode = "osc";
				continue;
			}
			mode = "text";
			continue;
		}
		if (mode === "csi") {
			const code = char.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				mode = "text";
			}
			continue;
		}
		if (mode === "osc") {
			if (char === REFERENCE_BELL) {
				mode = "text";
			} else if (char === REFERENCE_ESCAPE) {
				mode = "osc_escape";
			}
			continue;
		}
		if (mode === "osc_escape") {
			mode = char === "\\" ? "text" : "osc";
		}
	}
	return output;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// 手工构造的边界 corpus:CSI / OSC(BEL 与 ST 两种终止)/ 裸 ESC / 两字节转义怪癖 /
// 控制字符剔除 / C1 保留 / emoji 与代理对(含 ESC 后紧跟代理对、孤立半代理)/ 断裂序列。
const HANDCRAFTED_CORPUS: string[] = [
	"",
	"plain text with no escapes",
	"line one\r\nline two\ttabbed",
	`${ESC}[2K\r✻ Cogitating… (12s · esc to interrupt)`,
	`${ESC}[38;5;213mcolored${ESC}[0m rest`,
	`${ESC}]0;window title${BEL}after osc bell`,
	`${ESC}]0;window title${ESC}\\after osc st`,
	`${ESC}]0;unterminated osc swallows everything`,
	`${ESC}(Btwo-byte escape leaks the final byte`,
	`${ESC}(${ESC}[1mescape into escape`,
	`bare escape at end ${ESC}`,
	`${ESC}[incomplete csi swallows to end`,
	`${ESC}[1;31;42mfull sgr${ESC}[m`,
	"control chars \u0000\u0001\u0008 are dropped \u000b\u000c",
	"delete char \u007f dropped",
	"c1 controls \u0080\u009f are retained (historical behavior)",
	"emoji 🎉 and pair 👨‍👩‍👧 survive",
	`${ESC}🎉surrogate pair right after ESC is swallowed whole`,
	"lone high surrogate \ud800 retained",
	"lone low surrogate \udc00 retained",
	`${ESC}\ud800lone high surrogate after ESC`,
	`${ESC}[${ESC}]nested opener bytes inside csi`,
	`${ESC}]osc with ${ESC}x fake st then ${BEL}done`,
	"\r\r\r,repeated redraw prefixes",
	`interleaved ${ESC}[1A${ESC}[2Ktext${ESC}]t${BEL}tail${ESC}(B!`,
];

// 种子伪随机串(mulberry32,确定性):在含 ESC / 括号 / 终止符 / 控制符 / 代理对半 /
// 普通字符的字母表上随机拼接,广撒网覆盖手工 corpus 想不到的状态机路径。
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const RANDOM_ALPHABET = [
	ESC,
	BEL,
	"[",
	"]",
	"\\",
	"(",
	"B",
	"m",
	"K",
	";",
	"1",
	"a",
	"文",
	" ",
	"\n",
	"\r",
	"\t",
	"\u0001",
	"\u007f",
	"\u0080",
	"🎉",
	"\ud800",
	"\udc00",
];

function buildSeededRandomSamples(sampleCount: number, maxLength: number): string[] {
	const nextRandom = mulberry32(0x5eed);
	const samples: string[] = [];
	for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
		const length = 1 + Math.floor(nextRandom() * maxLength);
		let sample = "";
		for (let charIndex = 0; charIndex < length; charIndex++) {
			sample += RANDOM_ALPHABET[Math.floor(nextRandom() * RANDOM_ALPHABET.length)];
		}
		samples.push(sample);
	}
	return samples;
}

describe("stripAnsiAndControl 切片化实现:与历史逐码点 reference 逐字节等价", () => {
	it("手工边界 corpus 全量等价(含 ESC ( B 漏字节怪癖、C1 保留、ESC 后代理对整吞)", () => {
		for (const sample of HANDCRAFTED_CORPUS) {
			expect(stripAnsiAndControl(sample), JSON.stringify(sample)).toBe(referenceStripAnsiAndControl(sample));
		}
	});

	it("种子伪随机串(500 条 × ≤64 字符)全量等价", () => {
		for (const sample of buildSeededRandomSamples(500, 64)) {
			expect(stripAnsiAndControl(sample), JSON.stringify(sample)).toBe(referenceStripAnsiAndControl(sample));
		}
	});

	it("纯文本 chunk 直接返回原串引用(零分配快路径)", () => {
		const pureText = "nothing to strip here at all";
		expect(stripAnsiAndControl(pureText)).toBe(pureText);
	});
});

describe("normalizeTerminalText / normalizeDecodedTerminalOutput", () => {
	it("小写化并折叠全部空白(含重绘 \\r)为单空格", () => {
		expect(normalizeTerminalText("Hello\r\n  WORLD\t!")).toBe("hello world !");
	});

	it("组合调用:先 strip 再归一化", () => {
		expect(normalizeDecodedTerminalOutput(`${ESC}[31mAPI  Error${ESC}[0m\rRetrying`)).toBe("api error retrying");
	});
});
