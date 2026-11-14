import { execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { parse, stringify } from "smol-toml";
import { createServer as createViteServer } from "vite";
import { startCodexConversationProtocolComparisonHost } from "../src/agent-conversation/codex-conversation-protocol-comparison-host";

const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
async function main() {
	const { values } = parseArgs({
		options: {
			directory: { type: "string" },
			"codex-binary": { type: "string", default: "codex" },
			"acp-binary": { type: "string", default: "codex-acp" },
			model: { type: "string" },
			port: { type: "string", default: "0" },
			"owned-comparison-runtime": { type: "boolean", default: false },
		},
	});
	if (!values.directory) throw new Error("请用 --directory 指定持久比较目录。");
	const directory = resolve(values.directory);
	if (
		["/tmp", "/private/tmp", resolve(tmpdir())].some((root) => directory === root || directory.startsWith(`${root}/`))
	)
		throw new Error("比较证据必须保存在持久目录。");
	const resolveExecutable = async (binary: string) =>
		await realpath(
			isAbsolute(binary) ? binary : execFileSync("/usr/bin/which", [binary], { encoding: "utf8" }).trim(),
		);
	const codexBinary = await resolveExecutable(values["codex-binary"]),
		acpBinary = await resolveExecutable(values["acp-binary"]);
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("比较端口必须是 0 至 65535 的整数。");
	if (!values["owned-comparison-runtime"]) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const isolatedHome = join(directory, "isolated-home"),
			isolatedCodexHome = join(directory, "isolated-codex-home");
		await mkdir(isolatedHome, { recursive: true });
		await mkdir(isolatedCodexHome, { recursive: true, mode: 0o700 });
		const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
		const sourceConfiguration = parse(await readFile(join(sourceCodexHome, "config.toml"), "utf8").catch(() => ""));
		const modelId = values.model ?? String(sourceConfiguration.model ?? "");
		if (!modelId) throw new Error("请用 --model 指定两条路径共同使用的模型。");
		const configuration = {
			model: modelId,
			...(sourceConfiguration.model_provider ? { model_provider: sourceConfiguration.model_provider } : {}),
			...(sourceConfiguration.model_providers ? { model_providers: sourceConfiguration.model_providers } : {}),
		};
		await writeFile(join(isolatedCodexHome, "config.toml"), stringify(configuration), { mode: 0o600 });
		let authenticationCopied = false;
		try {
			await copyFile(join(sourceCodexHome, "auth.json"), join(isolatedCodexHome, "auth.json"));
			await chmod(join(isolatedCodexHome, "auth.json"), 0o600);
			authenticationCopied = true;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		const codexVersion = execFileSync(codexBinary, ["--version"], { encoding: "utf8" }).trim();
		const acpVersion = execFileSync(acpBinary, ["--version"], { encoding: "utf8" }).trim();
		if (codexVersion !== "codex-cli 0.168.0") throw new Error(`本轮比较固定 Codex 0.168.0，实际为 ${codexVersion}。`);
		if (!/(?:^|\s)2\.6\.0(?:\s|$)/u.test(acpVersion))
			throw new Error(`本原型固定 codex-acp 2.6.0，实际为 ${acpVersion}。`);
		await writeFile(
			join(directory, "comparison-version-manifest.json"),
			JSON.stringify(
				{
					codexBinary,
					codexVersion,
					acpBinary,
					acpVersion,
					modelId,
					protocolSdkVersion: JSON.parse(
						await readFile(join(repositoryPath, "node_modules/@agentclientprotocol/sdk/package.json"), "utf8"),
					).version,
					workingDirectory: join(directory, "execution-workspace"),
					requestedPermissionMode: "ask_for_every_tool_use",
					effectiveApprovalPolicy: "on-request",
					effectiveSandbox: "read-only",
					literalAskForEveryToolSemanticsVerified: false,
					sourceAuthenticationCopiedWithoutHooksOrPlugins: authenticationCopied,
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		await build({
			entryPoints: [join(repositoryPath, "scripts/codex-acp-owned-app-server-bridge.ts")],
			outfile: join(directory, "codex-acp-owned-app-server-bridge.cjs"),
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node22",
		});
		const bridgeBinary = join(directory, "codex-acp-owned-app-server-bridge.sh");
		await writeFile(
			bridgeBinary,
			`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(directory, "codex-acp-owned-app-server-bridge.cjs"))} "$@"\n`,
			{ mode: 0o700 },
		);
		const environment = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !key.startsWith("KANBAN_") && !key.startsWith("CODEX_") && !key.startsWith("CLINE_"),
			),
		);
		const child = spawn(
			process.execPath,
			[
				...process.execArgv,
				fileURLToPath(import.meta.url),
				...process.argv.slice(2),
				"--owned-comparison-runtime",
				"--model",
				modelId,
				"--codex-binary",
				codexBinary,
				"--acp-binary",
				acpBinary,
			],
			{
				env: {
					...environment,
					HOME: isolatedHome,
					CODEX_HOME: isolatedCodexHome,
					CODEX_SQLITE_HOME: isolatedCodexHome,
				},
				stdio: "inherit",
			},
		);
		for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
		await new Promise<void>((accept) =>
			child.once("close", (code) => {
				process.exitCode = code ?? 1;
				accept();
			}),
		);
		return;
	}
	const vite = await createViteServer({
		root: join(repositoryPath, "web-ui"),
		configFile: join(repositoryPath, "web-ui/vite.config.ts"),
		server: { middlewareMode: true, hmr: false },
		appType: "mpa",
	});
	const host = await startCodexConversationProtocolComparisonHost({
		comparisonDirectory: directory,
		workingDirectory: join(directory, "execution-workspace"),
		codexBinary,
		acpBinary,
		codexBridgeBinary: join(directory, "codex-acp-owned-app-server-bridge.sh"),
		modelId: values.model as string,
		port,
		frontendMiddleware: vite.middlewares,
	}).catch(async (error: unknown) => {
		await vite.close();
		throw error;
	});
	const address = host.server.address();
	if (address && typeof address !== "string")
		process.stdout.write(
			`隔离比较界面：http://127.0.0.1:${address.port}/codex-conversation-comparison.html#controlToken=${host.controlToken}\n`,
		);
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		try {
			await host.close();
		} finally {
			await vite.close();
		}
	};
	const stop = () => {
		void close().catch(() => {
			process.stderr.write("隔离比较宿主未能完整停止，请查看持久诊断。\n");
			process.exitCode = 1;
		});
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
