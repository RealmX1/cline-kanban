async page => {
 const close=page.getByRole('dialog',{name:'Get started'}).getByRole('button',{name:'Close'});if(await close.count())await close.click();
 const boxes=await page.locator('.kb-board [data-task-id]').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+20,id:e.dataset.taskId};}).filter(p=>p.x>0&&p.x<innerWidth&&p.y>50&&p.y<innerHeight-40).slice(0,5));
 if(boxes.length<2)throw new Error('可见卡片不足');
 const idle=null;
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline.stack',transferMode:'ReturnAsStream'});
 const cards=page.locator('.kb-board [data-task-id]');const count=await cards.count();
 for(let i=0;i<20;i++){const point=boxes[i%boxes.length];await page.mouse.move(point.x,point.y);await page.waitForTimeout(250);}

 const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await complete;let trace='';for(;;){const chunk=await cdp.send('IO.read',{handle:stream});trace+=chunk.data;if(chunk.eof)break;}await cdp.send('IO.close',{handle:stream});
 const events=JSON.parse(trace).traceEvents;const layouts=events.filter(e=>e.name==='Layout'||e.name==='UpdateLayoutTree');
 return {idle,hoveredTaskIds:boxes.map(p=>p.id),rawTrace:trace,cardCount:count,dependencyPathCount:await page.locator('.kb-dependency-surface svg path').count(),layoutCount:layouts.length,stackedLayouts:layouts.filter(e=>e.args?.beginData?.stackTrace||e.args?.data?.stackTrace),traceEventCount:events.length};
}
