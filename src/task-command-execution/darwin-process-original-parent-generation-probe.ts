import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

const executeFile = promisify(execFile);
// 原始父代际不会随 reparent 改变；只返回内核身份，不读取或输出环境原文。
const darwinProcessOriginalParentGenerationProbeSource = String.raw`
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <errno.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct DarwinProcessUniqueIdentity {
 uint8_t executable_uuid[16]; uint64_t unique_process_id; uint64_t parent_unique_process_id;
 int32_t process_id_version; int32_t original_parent_process_id_version;
 uint64_t reserved_two; uint64_t reserved_three;
};
_Static_assert(sizeof(struct DarwinProcessUniqueIdentity)==56,"unexpected native identity layout");
const int DARWIN_PROCESS_UNIQUE_IDENTITY_FLAVOR=17;
int environment_ownership(int pid,const char *token) {
 int limit_query[2]={CTL_KERN,KERN_ARGMAX},limit=0; size_t limit_size=sizeof(limit);
 if(sysctl(limit_query,2,&limit,&limit_size,NULL,0)!=0 || limit<=0)return -1;
 char *bytes=malloc((size_t)limit); if(!bytes)return -1;
 int query[3]={CTL_KERN,KERN_PROCARGS2,pid},result=-1,argument_count=0; size_t length=(size_t)limit;
 if(sysctl(query,3,bytes,&length,NULL,0)!=0 || length<sizeof(int))goto finish;
 memcpy(&argument_count,bytes,sizeof(argument_count)); if(argument_count<1)goto finish;
 char *cursor=bytes+sizeof(argument_count),*end=bytes+length,*boundary=memchr(cursor,0,(size_t)(end-cursor));
 if(!boundary)goto finish; cursor=boundary+1; while(cursor<end && *cursor==0)cursor++;
 for(int index=0;index<argument_count;index++){if(cursor>=end)goto finish;boundary=memchr(cursor,0,(size_t)(end-cursor));if(!boundary)goto finish;cursor=boundary+1;}
 result=0; const char *key="KANBAN_OWNED_COMMAND_EXECUTION_NONCE="; size_t key_length=strlen(key),token_length=strlen(token);
 while(cursor<end && *cursor!=0){boundary=memchr(cursor,0,(size_t)(end-cursor));if(!boundary){result=-1;goto finish;}
  if((size_t)(boundary-cursor)==key_length+token_length && memcmp(cursor,key,key_length)==0 && memcmp(cursor+key_length,token,token_length)==0){result=1;goto finish;}
  cursor=boundary+1;
 }
 finish:free(bytes);return result;
}
int emit_coherent_native_process_generation_and_origin_observation(int pid,const char *token,int written,int *complete) {
 struct DarwinProcessUniqueIdentity identity,after;memset(&identity,0,sizeof(identity));memset(&after,0,sizeof(after));
 struct proc_bsdinfo info;memset(&info,0,sizeof(info));
 int identity_known=proc_pidinfo(pid,DARWIN_PROCESS_UNIQUE_IDENTITY_FLAVOR,0,&identity,sizeof(identity))==sizeof(identity);
 int identity_errno=identity_known?0:errno;
 int info_known=proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info);
 int has_token=token[0]?environment_ownership(pid,token):-1;
 int after_known=proc_pidinfo(pid,DARWIN_PROCESS_UNIQUE_IDENTITY_FLAVOR,0,&after,sizeof(after))==sizeof(after);
 int coherent=identity_known && after_known && identity.unique_process_id==after.unique_process_id;
 if(!coherent)*complete=0;
 if(written)printf(",");
 printf("{\"pid\":%d,\"parentProcessPid\":%d,\"outsideCurrentUser\":%s,\"hasExecutionOwnershipToken\":%s,\"processIsZombie\":%s,\"processStartIdentity\":\"native process observation\"",pid,info_known?info.pbi_ppid:-1,info_known && info.pbi_uid!=getuid()?"true":"false",has_token<0?"null":has_token?"true":"false",info_known && info.pbi_status==SZOMB?"true":"false");
 if(coherent) printf(",\"processUniqueIdentity\":\"%llu\",\"processIdVersion\":%d,\"originalParentProcessIdVersion\":%d",(unsigned long long)identity.unique_process_id,identity.process_id_version,identity.original_parent_process_id_version);
 else printf(",\"nativeProcessSnapshotUnproven\":true,\"nativeProcessLookupErrno\":%d",identity_errno);
 printf("}");return written+1;
}
int main(int argc,char **argv) {
 int snapshot=argc==3 && strcmp(argv[2],"--snapshot")==0,complete=1,written=0;
 pid_t *pids=NULL;int count=0;
 if(snapshot) {
  int capacity=proc_listallpids(NULL,0);if(capacity<=0)return 2;capacity=capacity*2+128;
  pids=calloc((size_t)capacity,sizeof(pid_t));if(!pids)return 2;
  count=proc_listallpids(pids,capacity*(int)sizeof(pid_t));if(count<0 || count>=capacity){free(pids);return 2;}
  printf("{\"queryProcessPid\":%d,\"processes\":[",getpid());
 }else printf("[");
 int entries=snapshot?count:argc-2;
 for(int index=0;index<entries;index++) {int pid=snapshot?pids[index]:atoi(argv[index+2]);if(pid>0)written=emit_coherent_native_process_generation_and_origin_observation(pid,argv[1],written,&complete);}
 if(snapshot){printf("],\"snapshotComplete\":%s}\n",complete?"true":"false");free(pids);}else printf("]\n");
 return 0;
}

`;

export async function prepareDarwinProcessOriginalParentGenerationProbe(): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	const fingerprint = createHash("sha256").update(darwinProcessOriginalParentGenerationProbeSource).digest("hex");
	const directory = join(getRuntimeHomePath(), "darwin-owned-process-native-probes", fingerprint);
	const sourcePath = join(directory, "darwin-owned-process-native-probe.c");
	const executablePath = join(directory, "darwin-owned-process-native-probe");
	const stagingExecutablePath = `${executablePath}.${randomUUID()}.pending`;
	try {
		await mkdir(directory, { recursive: true });
		return await lockedFileSystem.withLock({ path: executablePath, type: "file" }, async () => {
			try {
				await access(executablePath);
				return executablePath;
			} catch {
				/* 首次编译缓存。 */
			}
			await lockedFileSystem.writeTextFileAtomic(sourcePath, darwinProcessOriginalParentGenerationProbeSource, {
				durable: true,
			});
			await executeFile("/usr/bin/cc", ["-O2", sourcePath, "-o", stagingExecutablePath], { timeout: 15_000 });
			await rename(stagingExecutablePath, executablePath);
			return executablePath;
		});
	} catch {
		await rm(stagingExecutablePath, { force: true }).catch(() => undefined);
		return null;
	}
}
