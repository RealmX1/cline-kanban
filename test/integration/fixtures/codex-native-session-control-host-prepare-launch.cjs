// 供隔离原生 PTY 夹具调用产品启动准备；不启动模型、不连接生产 runtime。
const options = JSON.parse(process.argv[2]);
require(`${options.sourceRoot}/node_modules/tsx/dist/cjs/index.cjs`);
const { randomUUID } = require("node:crypto");
const { prepareCodexNativeSessionControlHostLaunch } = require(`${options.sourceRoot}/src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch.ts`);
const codexTuiArguments = [
 ...(options.profileName ? ["--profile", options.profileName] : ["-c", 'developer_instructions="CONTROL_HOST_CONFIGURATION_MARKER 仅返回模拟回复。"']),
 "--no-alt-screen", "-C", options.repositoryPath, "BOUNDARY_ORIGINAL_IMPLEMENTATION_TURN",
];

prepareCodexNativeSessionControlHostLaunch({
 binary: options.codexBinary,
 arguments: codexTuiArguments,
 workingDirectoryPath: options.repositoryPath,
 environment: process.env,
 workspaceId: "synthetic-native-workspace",
 conversationSessionId: "synthetic-native-task",
 runtimeSessionIncarnationId: randomUUID(),
}).then(launch => {
 if (!launch && options.profileName) {
  process.stdout.write(JSON.stringify({ binary: options.codexBinary, args: codexTuiArguments, endpoint: null }));
  return;
 }
 if (!launch) throw new Error("隔离原生二进制不支持受控启动");
 process.stdout.write(JSON.stringify({ binary: launch.binary, args: launch.args, endpoint: launch.endpoint }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
