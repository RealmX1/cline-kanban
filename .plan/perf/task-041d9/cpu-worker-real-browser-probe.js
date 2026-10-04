async page => {
 await page.goto('http://127.0.0.1:43919/worker-verification.html');
 const workerUrl='/assets/task-board-semantic-search-worker-C3A2XhWt.js';
 return await page.evaluate(async workerUrl=>{
  const worker=new Worker(workerUrl,{type:'module'});let ticks=0;const timer=setInterval(()=>ticks++,10);const started=performance.now();
  const request=(message)=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('worker timeout')),110000);worker.onmessage=e=>{if(e.data.requestId!==message.requestId)return;clearTimeout(timeout);e.data.ok?resolve(e.data):reject(new Error(e.data.message));};worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message));};worker.postMessage(message);});
  try{
   const documents=[{title:'Deploy web application',prompt:'Release the API service to production',taskId:'same',projectId:'one'},{title:'Bake chocolate cake',prompt:'Prepare butter and flour for dessert',taskId:'same',projectId:'two'}];
   await request({requestId:0,type:'initialize',documents});
   const semantic=await request({requestId:1,type:'search',query:'deploy application',mode:'semantic'});
   const hybrid=await request({requestId:2,type:'search',query:'cake dessert',mode:'hybrid'});
   return {ok:true,semantic,hybrid,mainThreadTimerTicks:ticks,elapsedMs:performance.now()-started};
  }catch(e){return {ok:false,error:String(e),mainThreadTimerTicks:ticks,elapsedMs:performance.now()-started};}
  finally{clearInterval(timer);worker.terminate();}
 },workerUrl);
}
