import { useState } from "react";
import {Button} from "../src/components/ui/button";
import { createRoot } from "react-dom/client";
import {TaskAssistanceModelProviderRoutingSettingsSection} from "../src/components/task-assistance-model-provider-routing-settings-section";
import {useTaskAssistanceModelProviderRoutingSettingsDraft} from "../src/hooks/use-task-assistance-model-provider-routing-settings-draft";
import "../src/styles/globals.css";
function Harness(){
 const [open,setOpen]=useState(true);
 const draft=useTaskAssistanceModelProviderRoutingSettingsDraft(open);
 return <main className="min-h-dvh bg-surface-0 p-4 text-text-primary">
  <Button type="button" onClick={()=>setOpen(true)}>打开分析设置</Button>
  {open?<div className="mx-auto max-w-xl space-y-4">
   <TaskAssistanceModelProviderRoutingSettingsSection draft={draft} disabled={false} providers={[{modelProviderId:"deepseek",displayName:"DeepSeek",providerProtocol:"openai_compatible",credentialSource:"environment",alibabaRegion:"beijing",credentialConfigured:true,credentialStatusMessage:null,defaultModelId:"configured-model"}]}/>
   <Button type="button" disabled={!draft.hasUnsavedChanges} onClick={()=>void draft.save().then(()=>setOpen(false))}>保存设置</Button>
   <Button type="button" onClick={()=>setOpen(false)}>取消修改</Button>
  </div>:null}
 </main>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness/>);
