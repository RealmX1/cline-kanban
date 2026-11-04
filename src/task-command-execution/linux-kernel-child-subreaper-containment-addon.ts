import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

const executeFile = promisify(execFile);
// N-API 只在独立监督者内设置 subreaper；Web runtime 只编译，不加载或改变自身的收养边界。
const linuxKernelChildSubreaperContainmentAddonSource = `
#include <node_api.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <errno.h>
#include <string.h>
static napi_value integer(napi_env env,int value){napi_value result;napi_create_int32(env,value,&result);return result;}
static napi_value establish(napi_env env,napi_callback_info info){
 int enabled=0;
 if(prctl(PR_SET_CHILD_SUBREAPER,1,0,0,0)!=0 || prctl(PR_GET_CHILD_SUBREAPER,&enabled,0,0,0)!=0)return integer(env,-errno);
 return integer(env,enabled==1?1:0);
}
static napi_value observe(napi_env env,napi_callback_info info){
 int enabled=0;if(prctl(PR_GET_CHILD_SUBREAPER,&enabled,0,0,0)!=0)return integer(env,-errno);
 return integer(env,enabled);
}
// 只在 Node 已收到根命令 exit 事件、所有同步查询已结束后调用，避免抢走 libuv 的根进程回执。
static napi_value reap_and_observe(napi_env env,napi_callback_info info){
 for(int iteration=0;iteration<64;iteration++){
  siginfo_t event;memset(&event,0,sizeof(event));
  if(waitid(P_ALL,0,&event,WEXITED|WNOHANG|WNOWAIT)!=0)return integer(env,errno==ECHILD?0:-errno);
  if(event.si_pid==0)return integer(env,1);
  int status=0;if(waitpid(event.si_pid,&status,WNOHANG)<0 && errno!=ECHILD)return integer(env,-errno);
 }
 return integer(env,1);
}
NAPI_MODULE_INIT(){
 napi_value establish_function,observe_function,reap_function;
 napi_create_function(env,"establish",NAPI_AUTO_LENGTH,establish,NULL,&establish_function);
 napi_create_function(env,"observe",NAPI_AUTO_LENGTH,observe,NULL,&observe_function);
 napi_create_function(env,"reapAndObserve",NAPI_AUTO_LENGTH,reap_and_observe,NULL,&reap_function);
 napi_set_named_property(env,exports,"establish",establish_function);
 napi_set_named_property(env,exports,"observe",observe_function);
 napi_set_named_property(env,exports,"reapAndObserve",reap_function);
 return exports;
}
`;

export async function prepareLinuxKernelChildSubreaperContainmentAddon(): Promise<{
	addonPath: string | null;
	unavailabilityReason: string | null;
}> {
	if (process.platform !== "linux") return { addonPath: null, unavailabilityReason: null };
	const fingerprint = createHash("sha256")
		.update(`${process.arch}:napi8:${linuxKernelChildSubreaperContainmentAddonSource}`)
		.digest("hex");
	const directory = join(getRuntimeHomePath(), "linux-kernel-child-subreaper-containment-addons", fingerprint);
	const sourcePath = join(directory, "linux-kernel-child-subreaper-containment-addon.c");
	const addonPath = join(directory, "linux-kernel-child-subreaper-containment-addon.node");
	const stagingAddonPath = `${addonPath}.${randomUUID()}.pending`;
	try {
		await mkdir(directory, { recursive: true });
		return await lockedFileSystem.withLock({ path: addonPath, type: "file" }, async () => {
			try {
				await access(addonPath);
				return { addonPath, unavailabilityReason: null };
			} catch {
				/* 首次编译。 */
			}
			const nodeBinaryPath = await realpath(process.execPath);
			const headersDirectory = join(dirname(dirname(nodeBinaryPath)), "include", "node");
			await access(join(headersDirectory, "node_api.h"));
			await lockedFileSystem.writeTextFileAtomic(sourcePath, linuxKernelChildSubreaperContainmentAddonSource, {
				durable: true,
			});
			await executeFile(
				"cc",
				["-shared", "-fPIC", "-O2", "-DNAPI_VERSION=8", "-I", headersDirectory, sourcePath, "-o", stagingAddonPath],
				{ timeout: 15_000 },
			);
			await rename(stagingAddonPath, addonPath);
			return { addonPath, unavailabilityReason: null };
		});
	} catch (error) {
		await rm(stagingAddonPath, { force: true }).catch(() => undefined);
		return { addonPath: null, unavailabilityReason: `Linux 原生 containment 不可用：${String(error).slice(-1600)}` };
	}
}
