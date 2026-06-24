// 通知提示音 WAV 资源生成器（零依赖、纯 Node、license-clean、可复现）。
//
// 为什么自合成而非引入第三方音频文件：用户选定经 howler 播放「真实音效文件」，但外部 CC0 素材的下载与
// 授权核实在本环境不便且不确定；自合成 WAV 完全受控、确定性可复现、无任何第三方授权牵连，且随时可被
// 设计师指定的音频原样替换（文件名/路径不变即可）。三档音色与 board-card 的状态点颜色语义一一对应：
//   - notify-complete  绿：完成待审——柔和上行二音 C5→E5
//   - notify-attention 金：阻塞等你——中频双击「叮」（A5 双脉冲）
//   - notify-error     红：运行出错——低沉下行二音 A4→F4
//
// 运行：node web-ui/scripts/generate-notification-sounds.mjs
// 输出：web-ui/public/assets/sounds/notify-{complete,attention,error}.wav（16-bit PCM, 单声道, 44.1kHz）

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 44100;

const NOTE_FREQUENCY_HZ = {
	F4: 349.23,
	A4: 440.0,
	C5: 523.25,
	E5: 659.25,
	A5: 880.0,
};

// 单个「拨弦式」音：8ms 起音淡入 + 指数衰减，避免起止爆音（click）。叠一层弱二次谐波增加暖度。
function renderPluckedTone({ frequencyHz, durationSeconds, peakAmplitude, decayRate }) {
	const sampleCount = Math.round(durationSeconds * SAMPLE_RATE);
	const samples = new Float64Array(sampleCount);
	const attackSeconds = 0.008;
	const attackSamples = Math.max(1, Math.round(attackSeconds * SAMPLE_RATE));
	for (let i = 0; i < sampleCount; i++) {
		const t = i / SAMPLE_RATE;
		const attackGain = i < attackSamples ? i / attackSamples : 1;
		const decayGain = Math.exp(-decayRate * t);
		const fundamental = Math.sin(2 * Math.PI * frequencyHz * t);
		const secondHarmonic = 0.25 * Math.sin(2 * Math.PI * frequencyHz * 2 * t);
		samples[i] = peakAmplitude * attackGain * decayGain * (fundamental + secondHarmonic);
	}
	return samples;
}

function concatSegments(segments) {
	const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
	const out = new Float64Array(totalLength);
	let offset = 0;
	for (const segment of segments) {
		out.set(segment, offset);
		offset += segment.length;
	}
	return out;
}

function silence(durationSeconds) {
	return new Float64Array(Math.round(durationSeconds * SAMPLE_RATE));
}

// 整段做一次软限幅归一化，确保不削顶（howler 端音量再统一压到 0.5）。
function normalize(samples, ceiling = 0.9) {
	let peak = 0;
	for (const sample of samples) {
		peak = Math.max(peak, Math.abs(sample));
	}
	if (peak === 0) {
		return samples;
	}
	const gain = ceiling / peak;
	const out = new Float64Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		out[i] = samples[i] * gain;
	}
	return out;
}

function encodeWavPcm16Mono(samples) {
	const dataByteLength = samples.length * 2;
	const buffer = Buffer.alloc(44 + dataByteLength);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataByteLength, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16); // fmt chunk size
	buffer.writeUInt16LE(1, 20); // audio format = PCM
	buffer.writeUInt16LE(1, 22); // channels = mono
	buffer.writeUInt32LE(SAMPLE_RATE, 24);
	buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
	buffer.writeUInt16LE(2, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataByteLength, 40);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
	}
	return buffer;
}

// complete（绿）：C5→E5 上行二音，~0.5s。
function renderComplete() {
	return normalize(
		concatSegments([
			renderPluckedTone({ frequencyHz: NOTE_FREQUENCY_HZ.C5, durationSeconds: 0.22, peakAmplitude: 0.8, decayRate: 9 }),
			renderPluckedTone({ frequencyHz: NOTE_FREQUENCY_HZ.E5, durationSeconds: 0.3, peakAmplitude: 0.8, decayRate: 7 }),
		]),
	);
}

// attention（金）：A5 双脉冲短「叮」，~0.32s。两记同音快速点击，听感是「请注意」。
function renderAttention() {
	return normalize(
		concatSegments([
			renderPluckedTone({ frequencyHz: NOTE_FREQUENCY_HZ.A5, durationSeconds: 0.12, peakAmplitude: 0.8, decayRate: 18 }),
			silence(0.04),
			renderPluckedTone({ frequencyHz: NOTE_FREQUENCY_HZ.A5, durationSeconds: 0.16, peakAmplitude: 0.8, decayRate: 14 }),
		]),
	);
}

// error（红）：A4→F4 下行二音，~0.5s，衰减更慢、音区更低，听感「沉/出错」。
function renderError() {
	return normalize(
		concatSegments([
			renderPluckedTone({ frequencyHz: NOTE_FREQUENCY_HZ.A4, durationSeconds: 0.22, peakAmplitude: 0.8, decayRate: 6 }),
			renderPluckedTone({ frequencyHz: NOTE_FREQUENCY_HZ.F4, durationSeconds: 0.32, peakAmplitude: 0.8, decayRate: 5 }),
		]),
	);
}

function main() {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const outputDir = join(scriptDir, "..", "public", "assets", "sounds");
	mkdirSync(outputDir, { recursive: true });

	const tiers = [
		{ name: "notify-complete.wav", samples: renderComplete() },
		{ name: "notify-attention.wav", samples: renderAttention() },
		{ name: "notify-error.wav", samples: renderError() },
	];
	for (const tier of tiers) {
		const outputPath = join(outputDir, tier.name);
		writeFileSync(outputPath, encodeWavPcm16Mono(tier.samples));
		// biome-ignore lint/suspicious/noConsole: build-time generator script reports its outputs.
		console.log(`wrote ${outputPath} (${tier.samples.length} samples)`);
	}
}

main();
