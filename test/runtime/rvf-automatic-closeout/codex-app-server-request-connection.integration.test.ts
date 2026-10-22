import { afterEach, describe, expect, it, vi } from "vitest";
import { withCodexAppServerRequestConnection } from "../../../src/rvf-automatic-closeout/codex-app-server-request-connection";
import { readCodexConversationTurns } from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";

// fixture 只实现 stdio 协议，不读取 Codex 配置、真实会话或用户 HOME。
function createFixtureConnectionInput(responseScript: string) {
	return {
		workingDirectory: process.cwd(),
		binary: process.execPath,
		environment: {},
		argumentsBeforeSubcommand: [
			"-e",
			`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const respond = async (request) => { ${responseScript} };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (bytes) => {
  input += bytes;
  for (let newline; (newline = input.indexOf('\\n')) !== -1;) {
    const request = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (request.method === 'initialize') send({id:request.id,result:{}});
    else if (request.method === 'fixture/pid') send({id:request.id,result:process.pid});
    else if (request.id) void respond(request);
  }
});
`,
		],
	};
}

function expectFixtureProcessExited(pid: number) {
	expect(() => process.kill(pid, 0)).toThrow();
}

afterEach(() => vi.useRealTimers());

describe("Codex 独享 stdio 请求连接", { timeout: 30_000 }, () => {
	it("大响应跨 stdout chunks 保留工具输出内的 Unicode 分隔符，并继续分页", async () => {
		const fixture = createFixtureConnectionInput(`
const nextPage = request.params.cursor === 'page-2';
const text = nextPage ? '第二页' : '中文😀前\\u2028中\\u2029后' + '工具输出'.repeat(100000);
const result = {data:[{id:nextPage?'turn-2':'turn-1',status:'completed',items:[{id:'tool',type:'commandExecution',aggregatedOutput:text}]}],nextCursor:nextPage?null:'page-2'};
send({method:'fixture/notification',params:{text:'通知\\u2028正文'}});
send({id:999999,result:'其它请求'});
const bytes = Buffer.from(JSON.stringify({id:request.id,result})+'\\r\\n');
for(let offset=0;offset<bytes.length;offset+=32767) {
  await new Promise(resolve=>process.stdout.write(bytes.subarray(offset,offset+32767),resolve));
}
`);
		let pid = 0;
		const turns = await withCodexAppServerRequestConnection(fixture, async (port) => {
			pid = (await port.request("fixture/pid", {})) as number;
			return readCodexConversationTurns(port, "fixture-thread");
		});
		expect(turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2"]);
		expect(turns[0]?.items[0]?.aggregatedOutput).toBe(`中文😀前\u2028中\u2029后${"工具输出".repeat(100000)}`);
		expect(turns[1]?.items[0]?.aggregatedOutput).toBe("第二页");
		expectFixtureProcessExited(pid);
	});

	it("按 id 匹配并发乱序响应，合法原生错误后连接仍可使用", async () => {
		const fixture = createFixtureConnectionInput(`
if(request.method==='fixture/error') send({id:request.id,error:{message:'原生拒绝'}});
else if(request.method==='fixture/first') global.firstRequest=request;
else {
  send({id:request.id,result:'第二个响应'});
  if(global.firstRequest) {send({id:global.firstRequest.id,result:'第一个响应'});global.firstRequest=null;}
}
`);
		await withCodexAppServerRequestConnection(fixture, async (port) => {
			await expect(port.request("fixture/error", {})).rejects.toThrow("原生拒绝");
			expect(await Promise.all([port.request("fixture/first", {}), port.request("fixture/second", {})])).toEqual([
				"第一个响应",
				"第二个响应",
			]);
		});
	});

	it("stdout end 的完整无换行尾帧先于进程 close 被消费", async () => {
		const fixture = createFixtureConnectionInput(`
const text='尾帧\\u2028正文\\u2029'+ '输出'.repeat(100000);
process.stdout.end(JSON.stringify({id:request.id,result:text}),()=>process.exit(0));
`);
		await expect(
			withCodexAppServerRequestConnection(fixture, (port) => port.request("fixture/eof", {})),
		).resolves.toBe(`尾帧\u2028正文\u2029${"输出".repeat(100000)}`);
	});

	it.each([
		'{"id":2,"result":"SECRET_UNTERMINATED',
		'{"id":3,"error":{"message":42},"private":"SECRET_SCHEMA"}',
		'{"id":3,"result":null,"error":{"message":"SECRET_BOTH"}}',
		'{"id":3,"private":"SECRET_MISSING"}',
	])("协议损坏立即拒绝所有 pending，不暴露原始正文：%s", async (frame) => {
		const fixture = createFixtureConnectionInput(`
if(request.method==='fixture/corrupt') process.stdout.write(${JSON.stringify(`${frame}\n`)});
`);
		let pid = 0;
		await withCodexAppServerRequestConnection(fixture, async (port) => {
			pid = (await port.request("fixture/pid", {})) as number;
			const responses = await Promise.allSettled([
				port.request("fixture/corrupt", {}),
				port.request("fixture/other-pending", {}),
			]);
			for (const response of responses) {
				expect(response.status).toBe("rejected");
				if (response.status !== "rejected") throw new Error("损坏响应意外完成。");
				expect(response.reason.message).toContain("协议错误");
				expect(response.reason.message).not.toContain("SECRET");
			}
			await expect(port.request("fixture/after-corruption", {})).rejects.toThrow("连接已关闭");
		});
		expectFixtureProcessExited(pid);
	});

	it("提前退出拒绝未返回请求，且释放子进程", async () => {
		let pid = 0;
		await expect(
			withCodexAppServerRequestConnection(createFixtureConnectionInput("process.exit(7);"), async (port) => {
				pid = (await port.request("fixture/pid", {})) as number;
				return port.request("fixture/exit", {});
			}),
		).rejects.toThrow("code=7");
		expectFixtureProcessExited(pid);
	});

	it("operation 抛错且子进程忽略 SIGTERM 时最终强制清理", async () => {
		let pid = 0;
		await expect(
			withCodexAppServerRequestConnection(
				createFixtureConnectionInput("process.on('SIGTERM',()=>{}); send({id:request.id,result:process.pid});"),
				async (port) => {
					pid = (await port.request("fixture/ignore-termination", {})) as number;
					throw new Error("operation 故意失败");
				},
			),
		).rejects.toThrow("operation 故意失败");
		expectFixtureProcessExited(pid);
	});

	it("真正无响应时仍精确保留 20 秒请求预算", async () => {
		let requestIssued = () => {};
		const issued = new Promise<void>((resolve) => {
			requestIssued = resolve;
		});
		let pid = 0;
		const result = withCodexAppServerRequestConnection(createFixtureConnectionInput(""), async (port) => {
			pid = (await port.request("fixture/pid", {})) as number;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const response = port.request("fixture/no-response", {});
			requestIssued();
			return response;
		});
		const rejected = expect(result).rejects.toThrow("Codex 原生请求超时：fixture/no-response");
		await issued;
		await vi.advanceTimersByTimeAsync(19_999);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
		expectFixtureProcessExited(pid);
	});
});
