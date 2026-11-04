import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TaskCommandExecutionRecord } from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { prepareDarwinProcessOriginalParentGenerationProbe } from "./darwin-process-original-parent-generation-probe";
import { prepareLinuxKernelChildSubreaperContainmentAddon } from "./linux-kernel-child-subreaper-containment-addon";
import { taskCommandExecutionArtifactDirectory } from "./task-command-execution-store";

const executeFile = promisify(execFile);
export async function readSystemBootIdentity(): Promise<string | null> {
	try {
		return process.platform === "linux"
			? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
			: process.platform === "darwin"
				? (await executeFile("sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 5_000 })).stdout.trim()
				: null;
	} catch {
		return null;
	}
}
export interface OwnedProcessIdentity {
	pid: number;
	startAndCommand: string;
	nativeProcessGenerationIdentity?: string;
}
// command 会随 exec / process.title 改变；PID 与启动时刻共同界定进程代际。
export function hasSameProcessGeneration(
	current: OwnedProcessIdentity | null | undefined,
	expected: OwnedProcessIdentity | undefined,
): boolean {
	if (!current || !expected || current.pid !== expected.pid) return false;
	if (expected.nativeProcessGenerationIdentity !== undefined)
		return current.nativeProcessGenerationIdentity === expected.nativeProcessGenerationIdentity;
	const processStartIdentity = (identity: OwnedProcessIdentity) =>
		identity.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?=\s|$)/)?.[0];
	const currentStart = processStartIdentity(current);
	return currentStart !== undefined && currentStart === processStartIdentity(expected);
}
export async function readProcessIdentity(
	pid: number,
	darwinNativeProbePath?: string | null,
	requireNativeProcessGenerationIdentity = false,
): Promise<OwnedProcessIdentity | null> {
	try {
		const { stdout } = await executeFile("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
			timeout: 5_000,
			env: { ...process.env, LC_ALL: "C" },
		});
		if (!stdout.trim()) return null;
		let nativeProcessGenerationIdentity: string | undefined;
		if (process.platform === "linux" && requireNativeProcessGenerationIdentity) {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
			if (ticks) nativeProcessGenerationIdentity = `linux:${ticks}`;
		} else if (darwinNativeProbePath) {
			const records = JSON.parse(
				(await executeFile(darwinNativeProbePath, ["", String(pid)], { timeout: 1000 })).stdout,
			) as { pid: number; processUniqueIdentity: string }[];
			const uniqueIdentity = records.find((entry) => entry.pid === pid)?.processUniqueIdentity;
			if (uniqueIdentity && /^\d+$/.test(uniqueIdentity))
				nativeProcessGenerationIdentity = `darwin_unique_process_id:${uniqueIdentity}`;
		}
		return {
			pid,
			startAndCommand: stdout.trim(),
			...(nativeProcessGenerationIdentity ? { nativeProcessGenerationIdentity } : {}),
		};
	} catch (error) {
		if ((error as { code?: number | string }).code === 1 || (error as { code?: string }).code === "ENOENT")
			return null;
		throw error;
	}
}

// 独立监督进程不加载 runtime 或插件依赖；启动材料、唯一 nonce 和进程身份均先落盘。
const supervisorSource = String.raw`
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { open, readFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const OWNED_COMMAND_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY='KANBAN_OWNED_COMMAND_EXECUTION_NONCE';
async function readNativeProcessExecutionEnvironmentOwnership(pids,token) {
 if(process.platform==='darwin') {
  if(!materials.darwinOriginalParentGenerationProbePath)return new Map();
  try{return new Map(JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,[token,...pids.map(String)],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024})).map(entry=>[entry.pid,entry]));}catch{return new Map();}
 }
 if(process.platform!=='linux')return new Map();
 return new Map(await Promise.all(pids.map(async pid=>{try{const environment=await readFile('/proc/'+pid+'/environ','utf8');return [pid,{hasExecutionOwnershipToken:environment.split(String.fromCharCode(0)).includes('KANBAN_OWNED_COMMAND_EXECUTION_NONCE='+token)}];}catch{return [pid,{hasExecutionOwnershipToken:null}];}})));
}
const materialsFile = process.argv[2];
const materials = JSON.parse(await readFile(materialsFile, 'utf8'));
const directory = materials.directory;
const nonce = materials.launchNonce;
let outputTail = '';
function captureOutput(chunk) { outputTail=(outputTail+chunk.toString('utf8')).slice(-materials.outputTailMaxChars); }
async function save(name, value) {
 if(materials.outputTailMaxChars && name.startsWith('supervisor-progress-'))value={...value,outputTail};
 const target=join(directory,name); const staging=target+'.'+process.pid+'.pending';
 const handle=await open(staging,'w',0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); await rename(staging,target);
 if(process.platform!=='win32'){const directoryHandle=await open(directory,'r');try{await directoryHandle.sync();}finally{await directoryHandle.close();}}
}
function nativeGeneration(pid) {
 if(!materials.superviseProcessGroup)return {};
 try {
  if(process.platform==='linux'){const value=readFileSync('/proc/'+pid+'/stat','utf8');const ticks=value.slice(value.lastIndexOf(')')+2).split(/\s+/)[19];return ticks?{nativeProcessGenerationIdentity:'linux:'+ticks,observedParentProcessPid:Number(value.slice(value.lastIndexOf(')')+2).split(/\s+/)[1])}:{};}
  if(materials.darwinOriginalParentGenerationProbePath){const row=JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,['',String(pid)],{encoding:'utf8',timeout:5000}))[0];return row?.processUniqueIdentity?{nativeProcessGenerationIdentity:'darwin_unique_process_id:'+row.processUniqueIdentity}:{};}
 }catch{}return {};
}
function identity(pid) {
 try { if(materials.superviseProcessGroup && execFileSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C'}}).trim().startsWith('Z'))return null; const value=execFileSync('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C'}}).trim(); return value ? {pid,startAndCommand:value,...nativeGeneration(pid)}:null; }
 catch(error) { if(error.status===1)return null; throw error; }
}
function hasSameProcessGeneration(current,expected) {
 if(!current || !expected || current.pid!==expected.pid)return false;
 if(materials.superviseProcessGroup && (!current.nativeProcessGenerationIdentity || !expected.nativeProcessGenerationIdentity))return false;
 if(expected.nativeProcessGenerationIdentity!==undefined)return current.nativeProcessGenerationIdentity===expected.nativeProcessGenerationIdentity;
 const processStartIdentity=entry=>entry.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?=\s|$)/)?.[0];
 const currentStart=processStartIdentity(current);return currentStart!==undefined && currentStart===processStartIdentity(expected);
}
async function revoked() { try { await readFile(materials.revocationFile); return true; } catch(error) { if(error.code==='ENOENT')return false; throw error; } }
await mkdir(directory,{recursive:true});
const claimPath=join(directory,'supervisor-claim-'+nonce+'.json');
try { const claim=await open(claimPath,'wx',0o600); await claim.writeFile(JSON.stringify(identity(process.pid))); await claim.sync(); await claim.close(); }
catch(error) { if(error.code!=='EEXIST')throw error; const owner=JSON.parse(await readFile(claimPath,'utf8')); const current=identity(owner.pid); if(materials.preventRedispatch || hasSameProcessGeneration(current,owner)) { process.exitCode=0; } else { await unlink(claimPath); const claim=await open(claimPath,'wx',0o600); await claim.writeFile(JSON.stringify(identity(process.pid))); await claim.sync(); await claim.close(); } }
const owner=JSON.parse(await readFile(claimPath,'utf8'));
if(owner.pid===process.pid) {
 await save('supervisor-identity-'+nonce+'.json',{...identity(process.pid),launchNonce:nonce});
 let child=null; let cancelled=false; let timedOut=false; let cancellationStartedAtEpochMs=null; let nativeOwnershipUnproven=false; let unprovenOwnershipProcesses=[]; const owned=new Map();
 const beforeDispatchProcesses=new Map(); const unrelatedOriginalParentVersions=new Set();
 let pidNamespaceIdentity=null;
 const frozenDispatchAncestorPids=new Set(); const frozenBaselineDescendantPids=new Set(); let frozenDispatchAncestorEvidenceComplete=false;
 let linuxKernelContainmentAddon=null; let linuxKernelContainmentVerified=false; let linuxKernelContainmentContinuityLost=false; let containmentPreparationError=null;
 if(materials.linuxKernelChildSubreaperContainmentRequired) {
  try {
   pidNamespaceIdentity=readlinkSync('/proc/self/ns/pid');
   if(!materials.linuxKernelChildSubreaperContainmentAddonPath)throw new Error(materials.linuxKernelChildSubreaperContainmentUnavailabilityReason??'原生 addon 尚不可用');
   linuxKernelContainmentAddon=createRequire(materialsFile)(materials.linuxKernelChildSubreaperContainmentAddonPath);
   if(linuxKernelContainmentAddon.establish()!==1)throw new Error('PR_SET_CHILD_SUBREAPER/PR_GET_CHILD_SUBREAPER 未核验');
   linuxKernelContainmentVerified=true;
   await save('kernel-child-subreaper-containment-'+nonce+'.json',{launchNonce:nonce,systemBootIdentity:materials.systemBootIdentity,pidNamespaceIdentity,mode:'linux_child_subreaper_established_before_script_dispatch',...identity(process.pid),verifiedAtEpochMs:Date.now()});
  }catch(error){containmentPreparationError=String(error);cancelled=true;}
 }
 let nativeQueryFailureObservations=[];
 function readOriginalParentGenerations(entries) {
  if(!materials.darwinOriginalParentGenerationProbePath)return new Map();
  try {return new Map(JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,['',...entries.map(entry=>String(entry.pid))],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024})).map(entry=>[entry.pid,entry]));}catch(error){nativeQueryFailureObservations.push({query:'darwin_native_process_generations',pidCount:entries.length,code:error.code??null,status:error.status??null,signal:error.signal??null});nativeQueryFailureObservations=nativeQueryFailureObservations.slice(-3);return new Map();}
 }
 function readDarwinNativeProcessSnapshot() {
  if(!materials.darwinOriginalParentGenerationProbePath)throw new Error('Darwin 原生进程快照尚不可用');
  const snapshot=JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,['','--snapshot'],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024}));
  return snapshot.processes.filter(entry=>entry.pid!==snapshot.queryProcessPid).map(entry=>({...entry,parent:entry.parentProcessPid,startAndCommand:entry.processStartIdentity??'native process observation',...(entry.processUniqueIdentity?{nativeProcessGenerationIdentity:'darwin_unique_process_id:'+entry.processUniqueIdentity}:{})}));
 }
 function processEntries() {
  if(materials.superviseProcessGroup && process.platform==='darwin')return readDarwinNativeProcessSnapshot();
  const args=['-axo','pid=,ppid=,lstart=,command=']; const opts={encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024,env:{...process.env,LC_ALL:'C'}};
  const query=materials.superviseProcessGroup?spawnSync('ps',args,opts):null;
  if(query && query.status!==0)throw new Error('原生进程表暂不可读');
  const output=query?query.stdout:execFileSync('ps',args,opts);
  const entries=output.split('\n').map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(match=>({pid:Number(match[1]),parent:Number(match[2]),startAndCommand:match[3].trim()})).filter(entry=>entry.pid!==query?.pid);
  if(materials.superviseProcessGroup && process.platform==='linux')return entries.map(entry=>{const native=nativeGeneration(entry.pid);return {...entry,...native,parent:native.observedParentProcessPid??entry.parent};});
  if(materials.superviseProcessGroup && materials.darwinOriginalParentGenerationProbePath){const versions=readOriginalParentGenerations(entries);return entries.map(entry=>({...entry,...(versions.get(entry.pid)?.processUniqueIdentity?{nativeProcessGenerationIdentity:'darwin_unique_process_id:'+versions.get(entry.pid).processUniqueIdentity}:{})}));}
  return entries;
 }
 function parentGeneration(entry) {
   if(!entry)return null;
   if(!entry.nativeProcessGenerationIdentity){try{if(process.platform==='linux'){readFileSync('/proc/'+entry.pid+'/stat','utf8');return null;}return identity(entry.pid)===null?{absent:true}:null;}catch(error){return error.code==='ENOENT'?{absent:true}:null;}}
   try {
    if(process.platform==='linux'){const value=readFileSync('/proc/'+entry.pid+'/stat','utf8');const fields=value.slice(value.lastIndexOf(')')+2).split(/\s+/);return {parent:Number(fields[1]),generation:'linux:'+fields[19]};}
    const row=readOriginalParentGenerations([entry]).get(entry.pid);return row?{parent:row.parentProcessPid,generation:'darwin_unique_process_id:'+row.processUniqueIdentity}:identity(entry.pid)===null?{absent:true}:null;
   }catch(error){return error.code==='ENOENT'?{absent:true}:null;}
  }
 function captureBeforeDispatchBaseline() {
  beforeDispatchProcesses.clear();unrelatedOriginalParentVersions.clear();frozenDispatchAncestorPids.clear();frozenBaselineDescendantPids.clear();
  const baseline=processEntries();const byPid=new Map(baseline.map(entry=>[entry.pid,entry]));for(const entry of baseline)beforeDispatchProcesses.set(entry.pid,entry);
  let ancestor=process.pid;frozenDispatchAncestorEvidenceComplete=false;
  while(!frozenDispatchAncestorPids.has(ancestor)) {
   const entry=byPid.get(ancestor);if(!entry)break;const current=parentGeneration(entry);
   if(!current||current.generation!==entry.nativeProcessGenerationIdentity||current.parent!==entry.parent)break;
   frozenDispatchAncestorPids.add(ancestor);if(ancestor===1||current.parent===0){frozenDispatchAncestorEvidenceComplete=true;break;}ancestor=current.parent;
  }
  frozenBaselineDescendantPids.add(process.pid);let added=true;
  while(added){added=false;for(const entry of baseline)if(frozenBaselineDescendantPids.has(entry.parent)&&!frozenBaselineDescendantPids.has(entry.pid)){frozenBaselineDescendantPids.add(entry.pid);added=true;}}
  for(const entry of readOriginalParentGenerations(baseline).values())if(!frozenBaselineDescendantPids.has(entry.pid))unrelatedOriginalParentVersions.add(entry.processIdVersion);
  return {launchNonce:nonce,systemBootIdentity:materials.systemBootIdentity,pidNamespaceIdentity,capturedAtEpochMs:Date.now(),ancestorEvidenceComplete:frozenDispatchAncestorEvidenceComplete,ancestorProcesses:baseline.filter(entry=>frozenDispatchAncestorPids.has(entry.pid)).map(({pid,parent,nativeProcessGenerationIdentity})=>({pid,parent,nativeProcessGenerationIdentity})),baselineDescendantProcesses:baseline.filter(entry=>frozenBaselineDescendantPids.has(entry.pid)).map(({pid,parent,nativeProcessGenerationIdentity})=>({pid,parent,nativeProcessGenerationIdentity}))};
 }
 async function collect() {
  if(!child?.pid)return;nativeQueryFailureObservations=[];
  let entries=processEntries(); const unprovenOwnershipPids=new Set(); const unprovenOwnershipReasons=new Map(); const originalParentGenerationByPid=new Map();
  nativeOwnershipUnproven=false;let currentDarwinParentGenerations=new Map();
  function currentParentGeneration(entry){if(!entry)return null;if(process.platform!=='darwin')return parentGeneration(entry);const row=currentDarwinParentGenerations.get(entry.pid);return row?.processUniqueIdentity?{parent:row.parentProcessPid,generation:'darwin_unique_process_id:'+row.processUniqueIdentity}:null;}
  function independentBaselineDescendants(snapshot) {
   if(!frozenDispatchAncestorEvidenceComplete)return new Set();
   const ancestors=new Set([...frozenDispatchAncestorPids,...frozenBaselineDescendantPids]);
   const expiredIndependentObservations=new Set();
   const unrelated=new Set(snapshot.filter(entry=>!ancestors.has(entry.pid)&&entry.nativeProcessGenerationIdentity&&hasSameProcessGeneration(entry,beforeDispatchProcesses.get(entry.pid))&&currentParentGeneration(entry)?.generation===entry.nativeProcessGenerationIdentity).map(entry=>entry.pid));
   let added=true;while(added){added=false;for(const entry of snapshot)if(!unrelated.has(entry.pid)&&!ancestors.has(entry.pid)&&!hasSameProcessGeneration(entry,owned.get(entry.pid))&&unrelated.has(entry.parent)) {
    const current=currentParentGeneration(entry);const parent=snapshot.find(candidate=>candidate.pid===entry.parent);const currentParent=currentParentGeneration(parent);
    if(current?.absent){expiredIndependentObservations.add(entry.pid);}
    else if(current && current.generation===entry.nativeProcessGenerationIdentity && current.parent===entry.parent && currentParent?.generation===parent?.nativeProcessGenerationIdentity && parent?.nativeProcessGenerationIdentity){unrelated.add(entry.pid);added=true;}
   }}
   return new Set([...unrelated,...expiredIndependentObservations]);
  }
  if(materials.superviseProcessGroup) {
   const candidates=entries.filter(entry=>entry.pid!==process.pid && !hasSameProcessGeneration(entry,beforeDispatchProcesses.get(entry.pid)));
   try {
    const environments=await readNativeProcessExecutionEnvironmentOwnership(candidates.map(entry=>entry.pid),nonce);
    const previousEntries=new Map(entries.map(entry=>[entry.pid,entry])); entries=processEntries();
    currentDarwinParentGenerations=readOriginalParentGenerations(entries);
    const independentDescendants=independentBaselineDescendants(entries);
    const nativeGenerations=new Map(entries.filter(entry=>entry.nativeProcessGenerationIdentity && entry.originalParentProcessIdVersion!==undefined).map(entry=>[entry.pid,entry]));for(const [pid,row] of currentDarwinParentGenerations)if(row.processUniqueIdentity)nativeGenerations.set(pid,row); for(const native of nativeGenerations.values())originalParentGenerationByPid.set(native.pid,native.originalParentProcessIdVersion); const unrelatedPids=new Set(); let unrelatedAdded=true;
    while(unrelatedAdded){unrelatedAdded=false;for(const entry of nativeGenerations.values())if(entry.pid!==process.pid&&!unrelatedPids.has(entry.pid)&&unrelatedOriginalParentVersions.has(entry.originalParentProcessIdVersion)){unrelatedPids.add(entry.pid);unrelatedOriginalParentVersions.add(entry.processIdVersion);unrelatedAdded=true;}}
    for(const entry of entries){
     if(entry.pid===process.pid || hasSameProcessGeneration(entry,beforeDispatchProcesses.get(entry.pid)))continue;
     const origin=hasSameProcessGeneration(entry,previousEntries.get(entry.pid))?environments.get(entry.pid):undefined;
     if(origin?.hasExecutionOwnershipToken===true && entry.nativeProcessGenerationIdentity)owned.set(entry.pid,{pid:entry.pid,startAndCommand:entry.startAndCommand,...(entry.nativeProcessGenerationIdentity?{nativeProcessGenerationIdentity:entry.nativeProcessGenerationIdentity}:{})});
     else if(!independentDescendants.has(entry.pid)&&!unrelatedPids.has(entry.pid) && !hasSameProcessGeneration(entry,owned.get(entry.pid)) && !origin?.outsideCurrentUser && !origin?.launchedByServiceManager){unprovenOwnershipPids.add(entry.pid);unprovenOwnershipReasons.set(entry.pid,origin?.hasExecutionOwnershipToken===false?'original_parent_lineage_not_proven':'native_environment_or_process_generation_unavailable');}
    }
   } catch { unprovenOwnershipPids.add(-1); }
  }
  const groupMembers=new Set(); const zombies=new Set(entries.filter(entry=>entry.processIsZombie).map(entry=>entry.pid));
  if(materials.superviseProcessGroup) {
   const groupLines=execFileSync('ps',['-axo','pid=,pgid=,stat='],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024}).split('\n');
   for(const line of groupLines){const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)/);if(!match)continue;const pid=Number(match[1]);if(match[3].startsWith('Z'))zombies.add(pid);else if(Number(match[2])===process.pid && pid!==process.pid)groupMembers.add(pid);}
  }
  const parents=new Set(entries.filter(entry=>!zombies.has(entry.pid)&&(groupMembers.has(entry.pid)||hasSameProcessGeneration(entry,owned.get(entry.pid)))).map(entry=>entry.pid)); if(linuxKernelContainmentVerified&&!linuxKernelContainmentContinuityLost)parents.add(process.pid); let changed=true;
  while(changed){changed=false;for(const entry of entries)if(entry.pid!==process.pid && parents.has(entry.parent)&&!parents.has(entry.pid)){const parent=entries.find(candidate=>candidate.pid===entry.parent);const current=currentParentGeneration(entry);const currentParent=currentParentGeneration(parent);if(!materials.superviseProcessGroup || (current?.generation===entry.nativeProcessGenerationIdentity && current?.parent===entry.parent && currentParent?.generation===parent?.nativeProcessGenerationIdentity && entry.nativeProcessGenerationIdentity && parent?.nativeProcessGenerationIdentity)){parents.add(entry.pid);changed=true;}}}
  for(const entry of entries)if(entry.pid!==process.pid&&parents.has(entry.pid)&&(!materials.superviseProcessGroup||entry.nativeProcessGenerationIdentity))owned.set(entry.pid,{pid:entry.pid,startAndCommand:entry.startAndCommand,...(entry.nativeProcessGenerationIdentity?{nativeProcessGenerationIdentity:entry.nativeProcessGenerationIdentity}:{})});
  for(const entry of entries)if(materials.superviseProcessGroup && parents.has(entry.pid)&&!entry.nativeProcessGenerationIdentity){unprovenOwnershipPids.add(entry.pid);unprovenOwnershipReasons.set(entry.pid,'precise_native_process_generation_unavailable');}
  if(linuxKernelContainmentVerified&&!linuxKernelContainmentContinuityLost)for(const pid of [...unprovenOwnershipPids])if(!parents.has(pid)&&!hasSameProcessGeneration(entries.find(entry=>entry.pid===pid),owned.get(pid)))unprovenOwnershipPids.delete(pid);
  nativeOwnershipUnproven=[...unprovenOwnershipPids].some(pid=>!zombies.has(pid)&&(!parents.has(pid)||unprovenOwnershipReasons.get(pid)==='precise_native_process_generation_unavailable'));
  unprovenOwnershipProcesses=entries.filter(entry=>unprovenOwnershipPids.has(entry.pid)&&!zombies.has(entry.pid)&&(!parents.has(entry.pid)||unprovenOwnershipReasons.get(entry.pid)==='precise_native_process_generation_unavailable')).map(entry=>({pid:entry.pid,parentProcessPid:entry.parent,processStartIdentity:entry.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}/)?.[0]??'unreadable',nativeProcessGenerationIdentity:entry.nativeProcessGenerationIdentity,originalParentProcessGenerationIdentity:originalParentGenerationByPid.has(entry.pid)?'darwin_parent_id_version:'+originalParentGenerationByPid.get(entry.pid):undefined,reason:unprovenOwnershipReasons.get(entry.pid)??'native_process_snapshot_incomplete'}));
  return entries.filter(entry=>!zombies.has(entry.pid)&&hasSameProcessGeneration(entry,owned.get(entry.pid)));
 }
 let postScriptOwnershipRecoveryBudget={evidenceFingerprint:'',unchangedEvidenceProbeCount:0,nextActiveProbeAtEpochMs:0};
 let postScriptOwnershipRecoveryWaiting=false;let lastPassiveProcessEvidenceFingerprint=null;
 const postScriptRecoveryBudgetFile='post-script-ownership-recovery-budget-'+nonce+'.json';
 const postScriptRecoveryEvidenceFingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 function postScriptOwnershipSemanticEvidence(settled){return {settled,cancelled,timedOut,owned:[...owned.values()].map(entry=>[entry.pid,entry.nativeProcessGenerationIdentity??null]),unproven:unprovenOwnershipProcesses.map(entry=>[entry.pid,entry.nativeProcessGenerationIdentity??null,entry.originalParentProcessGenerationIdentity??null,entry.reason]).sort((a,b)=>a[0]-b[0])};}
 function observeKnownPostScriptProcessEvidence(){
  const entries=[...new Map([...owned.values(),...unprovenOwnershipProcesses].map(entry=>[entry.pid,entry])).values()];
  const native=process.platform==='darwin'?readOriginalParentGenerations(entries):new Map();
  return postScriptRecoveryEvidenceFingerprint(entries.map(entry=>{const current=process.platform==='darwin'?native.get(entry.pid):nativeGeneration(entry.pid);return [entry.pid,current?.processUniqueIdentity??current?.nativeProcessGenerationIdentity??null,current?.originalParentProcessIdVersion??null,current?.parentProcessPid??current?.observedParentProcessPid??null];}).sort((a,b)=>a[0]-b[0]));
 }
 async function savePostScriptRecoveryBudget(){await save(postScriptRecoveryBudgetFile,{launchNonce:nonce,...postScriptOwnershipRecoveryBudget,lastPassiveProcessEvidenceFingerprint});}
 function terminate() {
  cancelled=true;
  cancellationStartedAtEpochMs ??= Date.now();
  const signal=Date.now()-cancellationStartedAtEpochMs>=1000?'SIGKILL':'SIGTERM';
  for(const entry of [...owned.values()].reverse()) { const current=identity(entry.pid); if(hasSameProcessGeneration(current,entry)) { try { process.kill(entry.pid,signal); }catch{} } }
 }
 process.on('SIGTERM',terminate); process.on('SIGINT',terminate);
 if(materials.superviseProcessGroup) {
  let ownIdentity=identity(process.pid);
  while(!ownIdentity?.nativeProcessGenerationIdentity && !await revoked() && Date.now()<materials.deadlineAtEpochMs) {
   await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'running',nativeOwnershipUnproven:true,unprovenOwnershipProcesses:[{pid:process.pid,processStartIdentity:'unavailable',reason:'supervisor_precise_native_process_generation_unavailable_before_dispatch'}],ownedProcesses:[],updatedAtEpochMs:Date.now()});
   await new Promise(resolve=>setTimeout(resolve,200));ownIdentity=identity(process.pid);
  }
  if(ownIdentity?.nativeProcessGenerationIdentity){await save('supervisor-identity-'+nonce+'.json',{...ownIdentity,launchNonce:nonce});await save('dispatch-before-process-ancestry-'+nonce+'.json',captureBeforeDispatchBaseline());}
 }
 if(materials.deadlineAtEpochMs && Date.now()>=materials.deadlineAtEpochMs)timedOut=true;
 if(!timedOut && !cancelled && !await revoked()) {
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'dispatch_committed',ownedProcesses:[],dispatchCommittedAtEpochMs:Date.now(),updatedAtEpochMs:Date.now()});
  const stdout=await open(join(directory,'command-'+nonce+'.stdout.txt'),'a',0o600); const stderr=await open(join(directory,'command-'+nonce+'.stderr.txt'),'a',0o600);
  child=spawn(materials.command[0],materials.command.slice(1),{cwd:materials.workingDirectory,env:{...process.env,...materials.environment,...(materials.superviseProcessGroup?{NODE_OPTIONS:materials.commandNodeOptions??undefined}:{}),...(materials.superviseProcessGroup?{[OWNED_COMMAND_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY]:nonce}:{}),KANBAN_COMMAND_EXECUTION_ID:materials.executionId,KANBAN_COMMAND_EXECUTION_REVOCATION_FILE:materials.revocationFile},detached:!materials.superviseProcessGroup,stdio:materials.outputTailMaxChars?['ignore','pipe','pipe']:['ignore',stdout.fd,stderr.fd]});
  if(materials.outputTailMaxChars){child.stdout?.on('data',captureOutput);child.stderr?.on('data',captureOutput);}
  const completion=new Promise(resolve=>{child.once('error',error=>resolve({error:String(error),returncode:null}));child.once('exit',(code,signal)=>resolve({returncode:code,signal}));});
  if(child.pid) { const childIdentity=identity(child.pid); if(childIdentity && (!materials.superviseProcessGroup || childIdentity.nativeProcessGenerationIdentity))owned.set(child.pid,childIdentity); }
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'running',ownedProcesses:[...owned.values()],updatedAtEpochMs:Date.now()});
  await stdout.close();await stderr.close();
  let settled=null;let kernelChildExitObservation=null;void completion.then(value=>{settled=value;});
  while(true) {
   if(postScriptOwnershipRecoveryWaiting) {
    if(materials.deadlineAtEpochMs && Date.now()>=materials.deadlineAtEpochMs)timedOut=true;
    if(cancelled||timedOut||await revoked())terminate();
    const semanticFingerprint=postScriptRecoveryEvidenceFingerprint(postScriptOwnershipSemanticEvidence(settled));
    const passiveFingerprint=observeKnownPostScriptProcessEvidence();
    if(semanticFingerprint!==postScriptOwnershipRecoveryBudget.evidenceFingerprint || passiveFingerprint!==lastPassiveProcessEvidenceFingerprint){postScriptOwnershipRecoveryBudget={evidenceFingerprint:semanticFingerprint,unchangedEvidenceProbeCount:0,nextActiveProbeAtEpochMs:0};lastPassiveProcessEvidenceFingerprint=passiveFingerprint;await savePostScriptRecoveryBudget();}
    if(postScriptOwnershipRecoveryBudget.unchangedEvidenceProbeCount>=3 || Date.now()<postScriptOwnershipRecoveryBudget.nextActiveProbeAtEpochMs) {
     await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelling':'running',...settled,timedOut,nativeOwnershipUnproven,unprovenOwnershipProcesses,ownedProcesses:[...owned.values()],postScriptOwnershipRecoveryBudget,nativeQueryFailureObservations,updatedAtEpochMs:Date.now()});
     const delayUntilEvidenceObservation=Date.now()<materials.deadlineAtEpochMs?Math.min(15000,Math.max(1,materials.deadlineAtEpochMs-Date.now())):15000;
     await new Promise(resolve=>setTimeout(resolve,delayUntilEvidenceObservation));continue;
    }
    postScriptOwnershipRecoveryBudget.unchangedEvidenceProbeCount++;postScriptOwnershipRecoveryBudget.nextActiveProbeAtEpochMs=Date.now()+15000;await savePostScriptRecoveryBudget();
   }
   const liveOwnedSnapshot=await collect();
   if(materials.superviseProcessGroup && !identity(process.pid)?.nativeProcessGenerationIdentity) {
    nativeOwnershipUnproven=true;
    unprovenOwnershipProcesses.push({pid:process.pid,processStartIdentity:'unavailable',reason:'supervisor_precise_native_process_generation_unavailable'});
   } if(materials.deadlineAtEpochMs && Date.now()>=materials.deadlineAtEpochMs)timedOut=true;
   if(cancelled || timedOut || await revoked())terminate();
   if(materials.superviseProcessGroup)for(const entry of owned.values()){const current=identity(entry.pid);if(current && (!entry.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)){nativeOwnershipUnproven=true;unprovenOwnershipProcesses.push({pid:entry.pid,processStartIdentity:'unavailable',reason:'owned_precise_native_process_generation_unavailable'});}}
   kernelChildExitObservation=null;
   if(materials.linuxKernelChildSubreaperContainmentRequired) {
    try {
     if(!linuxKernelContainmentVerified||linuxKernelContainmentAddon.observe()!==1)linuxKernelContainmentContinuityLost=true;
     if(settled!==null&&!linuxKernelContainmentContinuityLost)kernelChildExitObservation=linuxKernelContainmentAddon.reapAndObserve();
     if(linuxKernelContainmentContinuityLost||kernelChildExitObservation<0){nativeOwnershipUnproven=true;unprovenOwnershipProcesses.push({pid:process.pid,processStartIdentity:'unavailable',nativeProcessGenerationIdentity:identity(process.pid)?.nativeProcessGenerationIdentity,reason:linuxKernelContainmentContinuityLost?'linux_kernel_child_subreaper_containment_continuity_unproven':'linux_kernel_descendant_wait_observation_failed'});}
    }catch{linuxKernelContainmentContinuityLost=true;nativeOwnershipUnproven=true;unprovenOwnershipProcesses.push({pid:process.pid,processStartIdentity:'unavailable',reason:'linux_kernel_child_subreaper_containment_observation_unavailable'});}
   }
   if(settled!==null && (!materials.linuxKernelChildSubreaperContainmentRequired||kernelChildExitObservation===0) && !nativeOwnershipUnproven && !(materials.superviseProcessGroup?liveOwnedSnapshot?.length:[...owned.values()].some(entry=>hasSameProcessGeneration(identity(entry.pid),entry))))break;
   const waitingForUnprovenOwnershipOnly=settled!==null && nativeOwnershipUnproven && liveOwnedSnapshot?.length===0;
   if(waitingForUnprovenOwnershipOnly) {
    const semanticFingerprint=postScriptRecoveryEvidenceFingerprint(postScriptOwnershipSemanticEvidence(settled));
    if(!postScriptOwnershipRecoveryWaiting || postScriptOwnershipRecoveryBudget.evidenceFingerprint!==semanticFingerprint){postScriptOwnershipRecoveryBudget={evidenceFingerprint:semanticFingerprint,unchangedEvidenceProbeCount:0,nextActiveProbeAtEpochMs:Date.now()};lastPassiveProcessEvidenceFingerprint=observeKnownPostScriptProcessEvidence();await savePostScriptRecoveryBudget();}
   }
   postScriptOwnershipRecoveryWaiting=waitingForUnprovenOwnershipOnly;
   await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelling':'running',...settled,timedOut,kernelChildExitObservation,linuxKernelContainmentVerified,linuxKernelContainmentContinuityLost,nativeOwnershipUnproven,unprovenOwnershipProcesses,ownedProcesses:[...owned.values()],postScriptOwnershipRecoveryBudget,nativeQueryFailureObservations,updatedAtEpochMs:Date.now()});
   const observationDelay=postScriptOwnershipRecoveryWaiting?Math.max(1,Math.min(15000,postScriptOwnershipRecoveryBudget.unchangedEvidenceProbeCount<3?postScriptOwnershipRecoveryBudget.nextActiveProbeAtEpochMs-Date.now():15000,Date.now()<materials.deadlineAtEpochMs?materials.deadlineAtEpochMs-Date.now():15000)):200;
   await (settled===null?Promise.race([completion,new Promise(resolve=>setTimeout(resolve,observationDelay))]):new Promise(resolve=>setTimeout(resolve,observationDelay)));
  }
  if(cancelled)terminate();
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelled':'exited',timedOut,...settled,kernelChildExitObservation,linuxKernelContainmentVerified,linuxKernelContainmentContinuityLost,nativeOwnershipUnproven,ownedProcesses:[...owned.values()],updatedAtEpochMs:Date.now()});
 } else await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'cancelled',timedOut,error:containmentPreparationError??undefined,ownedProcesses:[],updatedAtEpochMs:Date.now()});
}
`;

export interface IndependentOwnedCommandSupervisorOptions {
	artifactDirectory?: string;
	deadlineAtEpochMs?: number;
	environment?: Record<string, string>;
	outputTailMaxChars?: number;
	preventRedispatch?: boolean;
	superviseProcessGroup?: boolean;
}

type OwnedCommandSupervisorReference = Pick<TaskCommandExecutionRecord, "workspaceId" | "executionId" | "launchNonce">;

export async function inspectOwnedCommandSupervisor(
	record: OwnedCommandSupervisorReference,
	options: IndependentOwnedCommandSupervisorOptions = {},
): Promise<"running" | "exited" | "not_started" | "unknown"> {
	const directory =
		options.artifactDirectory ?? taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	try {
		const aborted = JSON.parse(
			await readFile(join(directory, `supervisor-launch-aborted-${record.launchNonce}.json`), "utf8"),
		) as { launchNonce?: string; phase?: string };
		if (aborted.launchNonce === record.launchNonce && aborted.phase === "supervisor_spawn_not_invoked")
			return "exited";
	} catch {
		/* 没有未派发原件时继续核验。 */
	}

	let hasPersistedSupervisorIdentity = false;
	try {
		const owner = JSON.parse(
			await readFile(join(directory, `supervisor-identity-${record.launchNonce}.json`), "utf8"),
		) as OwnedProcessIdentity;
		hasPersistedSupervisorIdentity = true;
		const launchMaterials = JSON.parse(
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"),
		) as { darwinOriginalParentGenerationProbePath?: string | null; superviseProcessGroup?: boolean };
		const requiresPreciseNativeIdentity =
			options.superviseProcessGroup === true || launchMaterials.superviseProcessGroup === true;
		const current = await readProcessIdentity(
			owner.pid,
			launchMaterials.darwinOriginalParentGenerationProbePath,
			owner.nativeProcessGenerationIdentity !== undefined,
		);
		if (
			requiresPreciseNativeIdentity &&
			current &&
			(!owner.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)
		)
			return "unknown";
		if (hasSameProcessGeneration(current, owner)) return "running";
		const materials = JSON.parse(
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"),
		) as { systemBootIdentity: string | null };
		const currentBoot = await readSystemBootIdentity();
		if (currentBoot && materials.systemBootIdentity && currentBoot !== materials.systemBootIdentity) return "exited";
		const progress = JSON.parse(
			await readFile(join(directory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
		) as { status: string; ownedProcesses: OwnedProcessIdentity[] };
		for (const process of progress.ownedProcesses) {
			const current = await readProcessIdentity(
				process.pid,
				launchMaterials.darwinOriginalParentGenerationProbePath,
				process.nativeProcessGenerationIdentity !== undefined,
			);
			if (
				requiresPreciseNativeIdentity &&
				current &&
				(!process.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)
			)
				return "unknown";
			if (hasSameProcessGeneration(current, process)) return "running";
		}
		// 过期快照可能遗漏失联前刚派生的孤儿；只有终结原件或开机代际变化才能证明全部退出。
		return progress.status === "exited" || progress.status === "cancelled" ? "exited" : "unknown";
	} catch (error) {
		if (hasPersistedSupervisorIdentity || (error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
		try {
			const { stdout } = await executeFile("ps", ["-axo", "command="], {
				timeout: 5_000,
				maxBuffer: 32 * 1024 * 1024,
			});
			if (
				stdout
					.split("\n")
					.some((line) => line.includes(join(directory, `launch-materials-${record.launchNonce}.json`)))
			)
				return "running";
		} catch {
			return "unknown";
		}
		try {
			// 启动材料存在时，监督者可能已派生 worker，缺少首份进度不能证明尚未启动。
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8");
			return "unknown";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_started" : "unknown";
		}
	}
}

export async function launchOwnedCommandSupervisor(
	record: OwnedCommandSupervisorReference &
		Pick<TaskCommandExecutionRecord, "revocationFile" | "launchAttemptCount"> & {
			specification: Pick<
				TaskCommandExecutionRecord["specification"],
				"workingDirectory" | "command" | "resumeCommand"
			>;
		},
	validate: () => Promise<void>,
	options: IndependentOwnedCommandSupervisorOptions = {},
): Promise<void> {
	const directory =
		options.artifactDirectory ?? taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	await mkdir(directory, { recursive: true });
	await lockedFileSystem.withLock({ path: join(directory, "supervisor-launch"), type: "file" }, async () => {
		const inspection = await inspectOwnedCommandSupervisor(record, options);
		if (inspection === "running" || (options.preventRedispatch && inspection !== "not_started")) return;
		let supervisorSpawnMayHaveStarted = false;
		try {
			await validate();
			const entrypoint = join(directory, "owned-command-supervisor.mjs");
			const materialsFile = join(directory, `launch-materials-${record.launchNonce}.json`);
			const linuxContainment =
				options.superviseProcessGroup && process.platform === "linux"
					? await prepareLinuxKernelChildSubreaperContainmentAddon()
					: { addonPath: null, unavailabilityReason: null };

			await lockedFileSystem.writeTextFileAtomic(entrypoint, supervisorSource, { durable: true });
			await lockedFileSystem.writeJsonFileAtomic(
				materialsFile,
				{
					...options,
					directory,
					launchNonce: record.launchNonce,
					executionId: record.executionId,
					revocationFile: record.revocationFile,
					workingDirectory: record.specification.workingDirectory,
					command:
						record.launchAttemptCount > 1 ? record.specification.resumeCommand : record.specification.command,
					systemBootIdentity: await readSystemBootIdentity(),
					linuxKernelChildSubreaperContainmentRequired:
						options.superviseProcessGroup === true && process.platform === "linux",
					linuxKernelChildSubreaperContainmentAddonPath: linuxContainment.addonPath,
					linuxKernelChildSubreaperContainmentUnavailabilityReason: linuxContainment.unavailabilityReason,
					commandNodeOptions: process.env.NODE_OPTIONS ?? null,

					darwinOriginalParentGenerationProbePath: options.superviseProcessGroup
						? await prepareDarwinProcessOriginalParentGenerationProbe()
						: null,
				},
				{ durable: true },
			);
			await validate();
			const log = await open(join(directory, `supervisor-${record.launchNonce}.log`), "a", 0o600);
			try {
				await lockedFileSystem.writeJsonFileAtomic(
					join(directory, `supervisor-spawn-dispatch-barrier-${record.launchNonce}.json`),
					{ launchNonce: record.launchNonce, phase: "supervisor_spawn_may_start" },
					{ durable: true },
				);
				supervisorSpawnMayHaveStarted = true;
				const supervisor = spawn(process.execPath, [entrypoint, materialsFile], {
					detached: true,
					env: options.superviseProcessGroup ? { ...process.env, NODE_OPTIONS: "" } : process.env,
					stdio: ["ignore", log.fd, log.fd],
				});
				await new Promise<void>((resolve, reject) => {
					supervisor.once("spawn", resolve);
					supervisor.once("error", reject);
				});
				supervisor.unref();
			} finally {
				await log.close();
			}
		} catch (error) {
			if (options.preventRedispatch && !supervisorSpawnMayHaveStarted) {
				await lockedFileSystem.writeJsonFileAtomic(
					join(directory, `supervisor-launch-aborted-${record.launchNonce}.json`),
					{ launchNonce: record.launchNonce, phase: "supervisor_spawn_not_invoked", reason: String(error) },
					{ durable: true },
				);
			}
			throw error;
		}
	});
}

async function discoverNativeEnvironmentOwnedCommandProcesses(
	launchNonce: string,
	darwinNativeProbePath?: string | null,
): Promise<OwnedProcessIdentity[]> {
	const { stdout } = await executeFile("ps", ["-axo", "pid=,stat="], { timeout: 1000, maxBuffer: 32 * 1024 * 1024 });
	const pids = stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((fields) => fields[0] && !/^[ZX]/.test(fields[1] ?? ""))
		.map((fields) => Number(fields[0]))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
	if (process.platform === "darwin" && darwinNativeProbePath) {
		const result = await executeFile(darwinNativeProbePath, [launchNonce, ...pids.map(String)], {
			timeout: 1000,
			maxBuffer: 32 * 1024 * 1024,
		});
		const rows = JSON.parse(result.stdout) as {
			pid: number;
			processIdVersion: number;
			processUniqueIdentity: string;
			hasExecutionOwnershipToken: boolean | null;
		}[];
		const identities: OwnedProcessIdentity[] = [];
		for (const row of rows)
			if (row.hasExecutionOwnershipToken === true) {
				const current = await readProcessIdentity(row.pid, darwinNativeProbePath, true);
				if (current?.nativeProcessGenerationIdentity === `darwin_unique_process_id:${row.processUniqueIdentity}`)
					identities.push(current);
			}
		return identities;
	}
	if (process.platform !== "linux") return [];
	const observations = await Promise.all(
		pids.map(async (pid) => {
			try {
				const before = await readProcessIdentity(pid, undefined, true);
				const environment = await readFile(`/proc/${pid}/environ`, "utf8");
				if (
					!environment
						.split(String.fromCharCode(0))
						.includes(`KANBAN_OWNED_COMMAND_EXECUTION_NONCE=${launchNonce}`)
				)
					return null;
				const after = await readProcessIdentity(pid, undefined, true);
				return hasSameProcessGeneration(after, before ?? undefined) ? after : null;
			} catch {
				return null;
			}
		}),
	);
	return observations.filter((identity): identity is OwnedProcessIdentity => identity !== null);
}

export async function cancelOwnedCommandProcesses(
	record: Pick<
		TaskCommandExecutionRecord,
		"workspaceId" | "executionId" | "launchNonce" | "previousLaunchNonces" | "revocationFile"
	> & {
		specification: Pick<TaskCommandExecutionRecord["specification"], "cancelCommand" | "workingDirectory">;
	},
	options: IndependentOwnedCommandSupervisorOptions = {},
): Promise<Record<string, unknown>> {
	const directory =
		options.artifactDirectory ?? taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	const observations: Record<string, unknown>[] = [];
	let darwinNativeProbePath: string | null | undefined;
	let usesPersistentOwnedProcessSupervision = options.superviseProcessGroup === true;
	try {
		const materials = JSON.parse(
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"),
		) as { darwinOriginalParentGenerationProbePath?: string | null; superviseProcessGroup?: boolean };
		darwinNativeProbePath = materials.darwinOriginalParentGenerationProbePath;
		usesPersistentOwnedProcessSupervision ||= materials.superviseProcessGroup === true;
	} catch {
		/* 缺失原件保持未知。 */
	}

	const cancelCommand = record.specification.cancelCommand;
	if (cancelCommand?.[0]) {
		try {
			await executeFile(cancelCommand[0], cancelCommand.slice(1), {
				cwd: record.specification.workingDirectory,
				timeout: 15_000,
				killSignal: "SIGKILL",
				env: { ...process.env, KANBAN_COMMAND_EXECUTION_REVOCATION_FILE: record.revocationFile },
			});
		} catch (error) {
			observations.push({ cancelCommandStatus: "unknown", reason: String(error) });
		}
	}
	try {
		const ownedProcesses: OwnedProcessIdentity[] = [];
		for (const nonce of [...record.previousLaunchNonces, record.launchNonce]) {
			try {
				const progress = JSON.parse(
					await readFile(join(directory, `supervisor-progress-${nonce}.json`), "utf8"),
				) as { ownedProcesses: OwnedProcessIdentity[] };
				ownedProcesses.push(...progress.ownedProcesses);
			} catch {
				observations.push({
					launchNonce: nonce,
					status: "unknown",
					recoveryTrigger: "owned_process_identity_available",
				});
			}
		}
		if (usesPersistentOwnedProcessSupervision) {
			try {
				ownedProcesses.push(
					...(await discoverNativeEnvironmentOwnedCommandProcesses(record.launchNonce, darwinNativeProbePath)),
				);
			} catch {
				observations.push({
					status: "unknown",
					recoveryTrigger: "native_environment_ownership_evidence_available",
				});
			}
		}

		if (usesPersistentOwnedProcessSupervision && ownedProcesses.length > 0) {
			const supplementalPath = join(directory, `supplemental-owned-process-identities-${record.launchNonce}.json`);
			let prior: OwnedProcessIdentity[] = [];
			try {
				prior = (JSON.parse(await readFile(supplementalPath, "utf8")) as { ownedProcesses: OwnedProcessIdentity[] })
					.ownedProcesses;
			} catch {
				/* 首次补证。 */
			}
			const merged = new Map(
				[...prior, ...ownedProcesses].map((identity) => [
					JSON.stringify([identity.pid, identity.nativeProcessGenerationIdentity ?? identity.startAndCommand]),
					identity,
				]),
			);
			await lockedFileSystem.writeJsonFileAtomic(
				supplementalPath,
				{ launchNonce: record.launchNonce, ownedProcesses: [...merged.values()] },
				{ durable: true },
			);
		}
		const terminationRequestedOwners: OwnedProcessIdentity[] = [];
		for (const owner of ownedProcesses.reverse()) {
			try {
				const current = await readProcessIdentity(
					owner.pid,
					darwinNativeProbePath,
					owner.nativeProcessGenerationIdentity !== undefined,
				);
				if (
					(!usesPersistentOwnedProcessSupervision ||
						(owner.nativeProcessGenerationIdentity && current?.nativeProcessGenerationIdentity)) &&
					hasSameProcessGeneration(current, owner)
				) {
					process.kill(owner.pid, "SIGTERM");
					terminationRequestedOwners.push(owner);
				}
				observations.push({
					pid: owner.pid,
					status:
						usesPersistentOwnedProcessSupervision &&
						current &&
						(!owner.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)
							? "precise_native_process_generation_unavailable_no_signal"
							: current
								? hasSameProcessGeneration(current, owner)
									? "termination_requested"
									: "identity_changed_no_signal"
								: "exited",
				});
			} catch {
				observations.push({ pid: owner.pid, status: "unknown" });
			}
		}
		if (terminationRequestedOwners.length > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
			for (const owner of terminationRequestedOwners) {
				try {
					const current = await readProcessIdentity(
						owner.pid,
						darwinNativeProbePath,
						owner.nativeProcessGenerationIdentity !== undefined,
					);
					if (
						(!usesPersistentOwnedProcessSupervision ||
							(owner.nativeProcessGenerationIdentity && current?.nativeProcessGenerationIdentity)) &&
						hasSameProcessGeneration(current, owner)
					)
						process.kill(owner.pid, "SIGKILL");
					observations.push({
						pid: owner.pid,
						status: hasSameProcessGeneration(current, owner)
							? "force_termination_requested"
							: current
								? "identity_changed_no_signal"
								: "exited",
					});
				} catch {
					observations.push({ pid: owner.pid, status: "unknown" });
				}
			}
		}
	} catch {
		observations.push({ status: "unknown", recoveryTrigger: "owned_process_identity_available" });
	}
	return {
		localProcessObservations: observations,
		nativeCancellationStatus: "unknown",
		recoveryTrigger: "native_cancellation_evidence_changed",
	};
}
