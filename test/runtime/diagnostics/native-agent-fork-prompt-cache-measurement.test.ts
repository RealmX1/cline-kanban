import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	analyzeNativeTurn,
	assessHistoryReuse,
	buildIsolatedEnvironment,
	classifyKimiPreSubmissionRejection,
	isAllowedNativeCodexExecutableLink,
	nativeLiveMeasurementMatrixIsComplete,
	readCodexNativePromptConfigurationEvidence,
	readKimiSessionIdentityFromNativeState,
	resolveOperationRecovery,
	verifyForkHistoryInheritance,
} from "../../../scripts/measure-native-agent-fork-prompt-cache.mjs";

const marker = "CACHE_MEASUREMENT_REQUEST=isolated-fixture";
const jsonLines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const codexUsage = (input: number, cached: number, total = 999_999) => ({
	type: "event_msg",
	payload: {
		type: "token_count",
		info: {
			total_token_usage: { input_tokens: total, cached_input_tokens: total },
			last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 5 },
		},
	},
});
const codexStart = [
	{ type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "max" } },
	{ type: "event_msg", payload: { type: "user_message", message: marker } },
];
const kimiRequest = (toolsHash = "stable-tools") => ({
	type: "llm.request",
	agentId: "main",
	kind: "loop",
	model: "k3.1-pro",
	modelAlias: "kimi-code/k3.1-pro",
	thinkingEffort: "high",
	toolsHash,
	systemPromptHash: "stable-system",
});
const kimiUsage = {
	type: "usage.record",
	agentId: "main",
	model: "kimi-code/k3.1-pro",
	usageScope: "turn",
	usage: { inputOther: 199, inputCacheRead: 29_184, inputCacheCreation: 0, output: 7 },
};

describe("原生 fork 缓存计量的离线证据边界", () => {
	it("只读取本次 marker 后的 last_token_usage，排除继承及累计计数并去重通知", () => {
		const usage = codexUsage(32_000, 12_928);
		const result = analyzeNativeTurn(
			"codex",
			jsonLines([codexUsage(80_000, 79_000), ...codexStart, usage, usage]),
			marker,
		);
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0]).toMatchObject({ inputTokens: 32_000, cachedInputTokens: 12_928 });
	});

	it("缺失 cache 字段与只有累计 usage 都是证据不足", () => {
		const usage = codexUsage(32_000, 0);
		Reflect.deleteProperty(usage.payload.info.last_token_usage, "cached_input_tokens");
		expect(analyzeNativeTurn("codex", jsonLines([...codexStart, usage]), marker).problems.length).toBeGreaterThan(0);
		expect(
			analyzeNativeTurn("codex", jsonLines([...codexStart, { type: "turn.completed", usage: {} }]), marker).requests,
		).toHaveLength(0);
	});

	it("恢复补读包含后续回合的父记录时仍只计量原请求", () => {
		const result = analyzeNativeTurn(
			"codex",
			jsonLines([
				...codexStart,
				codexUsage(32_000, 12_928),
				{ type: "event_msg", payload: { type: "task_complete" } },
				{ type: "event_msg", payload: { type: "user_message", message: "另一个后续请求" } },
				codexUsage(33_000, 32_000, 1_100_000),
			]),
			marker,
		);
		expect(result.requests).toHaveLength(1);
		expect(result.completed).toBe(true);
	});

	it("Kimi 将 usage.record 关联最近的 llm.request，inputOther 不冒充总输入", () => {
		const result = analyzeNativeTurn(
			"kimi",
			jsonLines([
				kimiRequest(),
				kimiUsage,
				{ type: "turn.prompt", prompt: marker },
				kimiRequest(),
				kimiUsage,
				{ type: "turn.ended" },
			]),
			marker,
		);
		expect(result.requests).toHaveLength(1);
		expect(result.requests[0]).toMatchObject({ inputTokens: 29_383, cachedInputTokens: 29_184 });
		expect(result.completed).toBe(true);
	});

	it("Kimi 缺少关联请求、缺少用量字段或多请求无法配对时保留未知", () => {
		for (const records of [
			[kimiUsage],
			[kimiRequest(), { ...kimiUsage, usage: { inputOther: 10 } }],
			[kimiRequest(), kimiRequest(), kimiUsage],
			[kimiRequest(), { ...kimiUsage, usageScope: "session" }],
			[kimiRequest(), { ...kimiUsage, usage: { ...kimiUsage.usage, inputOther: -1 } }],
		]) {
			const result = analyzeNativeTurn(
				"kimi",
				jsonLines([{ type: "turn.prompt", prompt: marker }, ...records]),
				marker,
			);
			expect(result.problems.length).toBeGreaterThan(0);
		}
	});

	it("保留可拆分的逐请求读数，发生压缩则不作确定结论", () => {
		const result = analyzeNativeTurn(
			"codex",
			jsonLines([...codexStart, codexUsage(32_000, 0), { type: "compacted" }, codexUsage(9_000, 0, 1_000_001)]),
			marker,
		);
		expect(result.requests).toHaveLength(2);
		expect(result.problems.join(" ")).toContain("压缩");
	});

	const measurement = (inputTokens: number, cachedInputTokens: number, configurationFingerprint = "stable") => ({
		inputTokens,
		cachedInputTokens,
		outputTokens: 5,
		model: "fixed-model",
		configurationFingerprint,
	});
	const comparison = {
		baseline: measurement(13_100, 12_928),
		hotBefore: measurement(130_000, 128_000),
		hotAfter: measurement(130_100, 128_000),
	};

	it("扣掉公共前缀，避免把固定 12928 cached tokens 判成父历史复用", () => {
		const result = assessHistoryReuse({ ...comparison, fork: measurement(130_000, 12_928) });
		expect(result).toMatchObject({ status: "measured", historyReuseRatio: 0 });
		expect(assessHistoryReuse({ ...comparison, fork: measurement(130_000, 128_000) }).historyReuseRatio).toBe(1);
	});

	it("冷基线自身 miss 时仍以空历史 input 上界排除公共前缀假命中", () => {
		expect(
			assessHistoryReuse({ ...comparison, baseline: measurement(13_100, 0), fork: measurement(130_000, 5_504) }),
		).toMatchObject({ status: "measured", historyReuseRatio: 0 });
	});

	it("Codex 分页历史引用必须绑定父身份、完整字节与 ordinal 边界", () => {
		const parentTranscript = `${jsonLines([
			{ type: "session_meta", ordinal: 0, payload: { id: "parent", base_instructions: "stable" } },
			{ type: "event_msg", ordinal: 1, payload: { message: marker } },
		])}\n`;
		const frozenParentSha256 = createHash("sha256").update(parentTranscript).digest("hex");
		const reference = {
			thread_id: "parent",
			end_byte_offset: Buffer.byteLength(parentTranscript),
			end_ordinal_exclusive: 2,
		};
		for (const change of [{}, { thread_id: "other-parent" }, { end_byte_offset: 1 }, { end_ordinal_exclusive: 99 }]) {
			const childTranscript = jsonLines([
				{
					type: "session_meta",
					payload: {
						id: "child",
						forked_from_id: "parent",
						forked_from_ordinal_exclusive: 2,
						history_base: { ...reference, ...change },
						base_instructions: "stable",
					},
				},
			]);
			expect(
				verifyForkHistoryInheritance({
					agent: "codex",
					childTranscript,
					parentTranscript,
					parentSessionId: "parent",
					frozenParentSha256,
					parentPrompts: [marker],
				}).verified,
			).toBe(Object.keys(change).length === 0);
		}
	});

	it("Kimi 的继承校验同时要求原生 forkedFrom、完整子身份与复制的父提示词", () => {
		const parentTranscript = jsonLines([{ type: "turn.prompt", prompt: marker }]);
		const input = {
			agent: "kimi" as const,
			parentTranscript,
			childTranscript: parentTranscript,
			parentSessionId: "session_parent",
			childSessionId: "session_child",
			parentPrompts: [marker],
			frozenParentSha256: createHash("sha256").update(parentTranscript).digest("hex"),
		};
		expect(
			verifyForkHistoryInheritance({
				...input,
				childSessionState: { id: "session_child", forkedFrom: "session_parent" },
			}).verified,
		).toBe(true);
		for (const childSessionState of [
			undefined,
			{ id: "session_other", forkedFrom: "session_parent" },
			{ id: "session_child", forkedFrom: "session_other" },
		]) {
			expect(verifyForkHistoryInheritance({ ...input, childSessionState }).verified).toBe(false);
		}
	});

	it("Codex 工具快照继承须显式读取父记录，工具变化与缺失不可冒充稳定", () => {
		const metadata = { type: "session_meta", payload: { base_instructions: { text: "stable-instructions" } } };
		const parent = jsonLines([
			metadata,
			{ type: "response_item", payload: { type: "additional_tools", tools: ["one-tool"] } },
		]);
		const child = jsonLines([
			{ ...metadata, payload: { ...metadata.payload, history_base: { thread_id: "bound-parent" } } },
		]);
		expect(readCodexNativePromptConfigurationEvidence(child, parent)).toEqual(
			readCodexNativePromptConfigurationEvidence(parent),
		);
		expect(readCodexNativePromptConfigurationEvidence(child).additionalToolsSha256).toBeNull();
		expect(readCodexNativePromptConfigurationEvidence(parent.replace("one-tool", "changed-tool"))).not.toEqual(
			readCodexNativePromptConfigurationEvidence(parent),
		);
	});

	it("热对照失效、模型配置变化、身份与父文件校验失败都阻止缓存结论", () => {
		for (const change of [
			{ hotBefore: measurement(130_000, 12_928) },
			{ fork: measurement(130_000, 128_000, "changed-tools") },
			{ integrityProblems: ["父会话被改写"] },
		]) {
			expect(assessHistoryReuse({ ...comparison, fork: measurement(130_000, 128_000), ...change })).toMatchObject({
				status: "insufficient_evidence",
				historyReuseRatio: null,
			});
		}
	});

	it("中断后先补证，已完成不重发；只有能证明未 spawn 的请求可有界重试", () => {
		expect(resolveOperationRecovery({ status: "submitting", completed: true })).toBe("complete");
		expect(resolveOperationRecovery({ status: "completed" })).toBe("complete");
		expect(resolveOperationRecovery({ status: "prepared" })).toBe("execute");
		expect(resolveOperationRecovery({ status: "submitting", accepted: true })).toBe("await_native_evidence");
		expect(resolveOperationRecovery({ status: "submitting" })).toBe("await_native_evidence");
		expect(resolveOperationRecovery({ status: "not_submitted", spawnErrorCode: "ENOENT", attemptCount: 1 })).toBe(
			"execute",
		);
		expect(resolveOperationRecovery({ status: "not_submitted", spawnErrorCode: "ENOENT", attemptCount: 2 })).toBe(
			"await_native_evidence",
		);
	});

	it("凭据拒绝只有结合原生记录证明未开始请求时才允许恢复，失败历史继续保留", () => {
		const stderr = "error: failed to run prompt: provider managed:kimi-code has no credential configured\n";
		const profileOnly = [{ type: "metadata" }, { type: "profile.bind" }];
		expect(classifyKimiPreSubmissionRejection(stderr, [jsonLines(profileOnly)])).toBe("AUTH_TOKEN_MISSING");
		for (const added of [{ type: "llm.request" }, { type: "usage.record" }, { type: "turn.prompt" }]) {
			expect(classifyKimiPreSubmissionRejection(stderr, [jsonLines([...profileOnly, added])])).toBeNull();
		}
		expect(classifyKimiPreSubmissionRejection(stderr, [])).toBeNull();
		expect(classifyKimiPreSubmissionRejection("network error", [jsonLines(profileOnly)])).toBeNull();
		expect(
			resolveOperationRecovery({
				status: "not_submitted",
				preSubmissionRejectionCode: "AUTH_TOKEN_MISSING",
				attemptCount: 1,
			}),
		).toBe("execute");
		expect(
			resolveOperationRecovery({
				status: "not_submitted",
				preSubmissionRejectionCode: "AUTH_TOKEN_MISSING",
				attemptCount: 2,
			}),
		).toBe("await_native_evidence");
	});

	it("Kimi 完整身份来自原生 state，保留 session_ 前缀；会话未找到须证实调用前拒绝才重试", () => {
		const state = { id: "session_authoritative-id", agents: { main: { homedir: "/isolated/agents/main" } } };
		expect(readKimiSessionIdentityFromNativeState(state, "/isolated/agents/main")).toBe("session_authoritative-id");
		expect(readKimiSessionIdentityFromNativeState(state, "/other/agents/main")).toBeUndefined();
		const error = 'error: failed to run prompt: Session "wrong-id" not found.\n';
		expect(classifyKimiPreSubmissionRejection(error, [jsonLines([{ type: "metadata" }])])).toBe(
			"SESSION_ID_NOT_FOUND",
		);
		expect(classifyKimiPreSubmissionRejection(error, [jsonLines([{ type: "metadata" }, kimiRequest()])])).toBeNull();
		expect(
			resolveOperationRecovery({
				status: "not_submitted",
				preSubmissionRejectionCode: "SESSION_ID_NOT_FOUND",
				attemptCount: 1,
			}),
		).toBe("execute");
	});

	it("仅允许 Codex 原生 apply_patch 入口指向锁定二进制，存储与凭据外链仍被拒绝", () => {
		const allowedPath = "codex-home/tmp/arg0-macos/codex-arg0example/apply_patch";
		expect(isAllowedNativeCodexExecutableLink(allowedPath, "/pinned/codex", "/pinned/codex")).toBe(true);
		for (const path of [
			"codex-home/auth.json",
			"codex-home/sessions",
			"home/.config",
			"codex-home/tmp/other/apply_patch",
		]) {
			expect(isAllowedNativeCodexExecutableLink(path, "/pinned/codex", "/pinned/codex")).toBe(false);
		}
		expect(isAllowedNativeCodexExecutableLink(allowedPath, "/other/codex", "/pinned/codex")).toBe(false);
	});

	it("隔离 HOME 与两个 Codex 存储目录，去掉任务 hook、会话身份和 shell 注入", () => {
		const isolated = buildIsolatedEnvironment(
			{
				PATH: "/bin",
				HOME: "/real-home",
				CODEX_HOME: "/real-codex",
				KANBAN_HOOK_TASK_ID: "real-task",
				CODEX_THREAD_ID: "real-thread",
				NODE_OPTIONS: "--require=hook.js",
				BASH_ENV: "real-hook",
				OPENAI_API_KEY: "test-private-key",
			},
			{ home: "/isolated/home", codexHome: "/isolated/codex", kimiHome: "/isolated/kimi" },
		);
		expect(isolated).toMatchObject({
			HOME: "/isolated/home",
			CODEX_HOME: "/isolated/codex",
			CODEX_SQLITE_HOME: "/isolated/codex",
			KIMI_CODE_HOME: "/isolated/kimi",
		});
		for (const key of ["KANBAN_HOOK_TASK_ID", "CODEX_THREAD_ID", "NODE_OPTIONS", "BASH_ENV"])
			expect(isolated).not.toHaveProperty(key);
	});

	it("Kimi 系统提示变化使配置指纹不同，不能把输入前缀变化判成历史不复用", () => {
		const transcript = (systemPromptHash: string) =>
			jsonLines([
				{ type: "turn.prompt", prompt: marker },
				{ ...kimiRequest(), systemPromptHash },
				kimiUsage,
				{ type: "turn.ended" },
			]);
		const parent = analyzeNativeTurn("kimi", transcript("system-A"), marker);
		const drifted = analyzeNativeTurn("kimi", transcript("system-B"), marker);
		expect(parent.problems).toEqual([]);
		expect(drifted.problems).toEqual([]);
		expect(parent.requests[0]?.configurationFingerprint).not.toBe(drifted.requests[0]?.configurationFingerprint);
		const shared = {
			inputTokens: 130_000,
			cachedInputTokens: 128_000,
			outputTokens: 5,
			model: "kimi-code/k3.1-pro",
			configurationFingerprint: "same-fingerprint",
		};
		expect(
			assessHistoryReuse({
				baseline: { ...shared, inputTokens: 13_100, cachedInputTokens: 12_928, systemPromptHash: "system-A" },
				hotBefore: { ...shared, systemPromptHash: "system-A" },
				hotAfter: { ...shared, systemPromptHash: "system-A" },
				fork: { ...shared, cachedInputTokens: 12_928, systemPromptHash: "system-B" },
			}),
		).toMatchObject({ status: "insufficient_evidence", historyReuseRatio: null });
	});

	it("分身第二轮缺少有效计量时，实时矩阵不算完成", () => {
		const request = { inputTokens: 130_000, cachedInputTokens: 128_000, outputTokens: 5 };
		const second = {
			key: "kimi-32000-fork-1-second",
			sessionId: "session_child",
			status: "completed",
			native: { accepted: true, completed: true, requests: [request], problems: [] as string[] },
		};
		const manifest = {
			options: { agents: ["kimi"], contextTokens: [32_000] },
			operations: [second],
		};
		expect(nativeLiveMeasurementMatrixIsComplete(manifest)).toBe(true);
		expect(
			nativeLiveMeasurementMatrixIsComplete({
				...manifest,
				operations: [
					{
						...second,
						native: {
							accepted: true,
							completed: true,
							requests: [],
							problems: ["本次请求没有可用的原生逐请求计量"],
						},
					},
				],
			}),
		).toBe(false);
		expect(
			nativeLiveMeasurementMatrixIsComplete({
				...manifest,
				operations: [{ ...second, native: { ...second.native, problems: ["本轮发生上下文压缩"] } }],
			}),
		).toBe(false);
		expect(
			nativeLiveMeasurementMatrixIsComplete({
				...manifest,
				operations: [{ ...second, native: { ...second.native, requests: [request, request] } }],
			}),
		).toBe(false);
		expect(
			nativeLiveMeasurementMatrixIsComplete({
				...manifest,
				operations: [
					{ ...second, native: { accepted: true, completed: false, requests: [request], problems: [] } },
				],
			}),
		).toBe(false);
		expect(nativeLiveMeasurementMatrixIsComplete({ ...manifest, operations: [] })).toBe(false);
	});

	it("首次定位 Kimi transcript 时就保存可核验 forkedFrom 的 state 快照", () => {
		const scratch = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".kimi-state-snapshot-"));
		const evidence = join(scratch, "evidence");
		const kimiHome = join(scratch, "kimi-source-home");
		const binaryDirectory = join(scratch, "bin");
		mkdirSync(kimiHome, { recursive: true });
		mkdirSync(binaryDirectory, { recursive: true });
		writeFileSync(
			join(kimiHome, "config.toml"),
			[
				'[models."kimi-code/k3.1-pro"]',
				'provider = "fixture"',
				"",
				"[providers.fixture]",
				'api_key = "fixture-key"',
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		const binary = join(binaryDirectory, "kimi");
		writeFileSync(
			binary,
			[
				"#!/usr/bin/env node",
				"import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
				"import { join } from 'node:path';",
				"import { randomUUID } from 'node:crypto';",
				"if (process.argv[2] === '--version') { process.stdout.write('kimi 2.3.1\\n'); process.exit(0); }",
				"const sessions = join(process.env.KIMI_CODE_HOME, 'sessions');",
				"const paths = (id) => {",
				"  const root = join(sessions, id);",
				"  const agentHome = join(root, 'agents', 'main');",
				"  return { root, agentHome, wire: join(agentHome, 'wire.jsonl'), state: join(root, 'state.json') };",
				"};",
				"const writeState = (id, forkedFrom) => {",
				"  const current = paths(id);",
				"  mkdirSync(current.agentHome, { recursive: true });",
				"  writeFileSync(current.state, JSON.stringify({ id, ...(forkedFrom ? { forkedFrom } : {}), agents: { main: { homedir: current.agentHome } } }));",
				"  return current;",
				"};",
				"const appendTurn = (id, prompt) => {",
				"  const current = paths(id);",
				"  const existed = existsSync(current.wire);",
				"  const usage = !existed && prompt.length > 1000",
				"    ? { inputOther: 32000, inputCacheRead: 0, inputCacheCreation: 0, output: 5 }",
				"    : existed",
				"      ? { inputOther: 2000, inputCacheRead: 128000, inputCacheCreation: 0, output: 5 }",
				"      : { inputOther: 13100, inputCacheRead: 0, inputCacheCreation: 0, output: 5 };",
				"  const records = [",
				"    { type: 'turn.prompt', prompt },",
				"    { type: 'llm.request', agentId: 'main', modelAlias: 'kimi-code/k3.1-pro', thinkingEffort: 'high', toolsHash: 'stable-tools', systemPromptHash: 'stable-system' },",
				"    { type: 'usage.record', agentId: 'main', model: 'kimi-code/k3.1-pro', usageScope: 'turn', usage },",
				"    { type: 'turn.ended' },",
				"  ];",
				"  writeFileSync(current.wire, (existed ? readFileSync(current.wire, 'utf8') : '') + records.map((record) => JSON.stringify(record)).join('\\n') + '\\n');",
				"};",
				"const args = process.argv.slice(2);",
				"if (args[0] === 'fork') {",
				"  const parent = paths(args[1]);",
				"  const id = 'session_' + randomUUID();",
				"  const child = writeState(id, args[1]);",
				"  if (existsSync(parent.wire)) copyFileSync(parent.wire, child.wire);",
				"  else writeFileSync(child.wire, '');",
				"  process.exit(0);",
				"}",
				"let sessionId;",
				"let prompt = 'OK';",
				"for (let index = 0; index < args.length; index += 1) {",
				"  if (args[index] === '--session') sessionId = args[index + 1];",
				"  if (args[index] === '--prompt') prompt = args[index + 1];",
				"}",
				"if (!sessionId) sessionId = 'session_' + randomUUID();",
				"if (!existsSync(paths(sessionId).state)) writeState(sessionId);",
				"appendTurn(sessionId, prompt);",
				"",
			].join("\n"),
			{ mode: 0o700 },
		);
		chmodSync(binary, 0o700);
		const script = fileURLToPath(
			new URL("../../../scripts/measure-native-agent-fork-prompt-cache.mjs", import.meta.url),
		);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: [binaryDirectory, process.env.PATH].filter(Boolean).join(delimiter),
			KIMI_CODE_HOME: kimiHome,
		};
		delete env.OPENAI_API_KEY;
		for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
		try {
			const run = spawnSync(
				process.execPath,
				[
					script,
					"--agents",
					"kimi",
					"--context-tokens",
					"32000",
					"--fork-count",
					"1",
					"--timeout-ms",
					"5000",
					"--evidence-directory",
					evidence,
				],
				{ encoding: "utf8", timeout: 20_000, env },
			);
			expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
			const measurements = JSON.parse(readFileSync(join(evidence, "measurements.json"), "utf8")) as {
				cases: { forks: { problems?: string[]; status: string }[] }[];
			};
			expect(measurements.cases[0]?.forks[0]?.problems ?? []).not.toContain("分身未证实继承冻结父历史");
			expect(measurements.cases[0]?.forks[0]?.status).toBe("measured");
			const manifest = JSON.parse(readFileSync(join(evidence, "manifest.json"), "utf8")) as {
				operations: { key: string; nativeSessionStateArtifactPath?: string }[];
			};
			const fork = manifest.operations.find((item) => item.key === "kimi-32000-fork-1-first");
			expect(fork?.nativeSessionStateArtifactPath).toBeTruthy();
			const state = JSON.parse(readFileSync(join(evidence, fork?.nativeSessionStateArtifactPath ?? ""), "utf8")) as {
				forkedFrom?: string;
			};
			expect(state.forkedFrom).toMatch(/^session_/);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
