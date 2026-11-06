'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let technical,DrawingWorkspace;
test.before(async()=>{technical=await import('../client/technical.mjs');({DrawingWorkspace}=await import('../client/drawings.mjs'));});
const at=Date.UTC(2026,9,20,3),step=60000;
function roleRows(direction,volume=1000){return Array.from({length:39},(_,i)=>{
 const close=i>=35?(direction>0?112:88):100;
 return {time:at+i*step,availableAt:at+(i+1)*step,complete:true,open:close,close,high:i===25?110:close+2,low:i===25?90:close-2,volume:i>=35?volume:1000};
});}
const levels=(rows,last=rows.at(-1).close,asOf=rows.at(-1).availableAt)=>technical.priceStructure(rows,last,{asOf,candleTime:rows.at(-1).time,interval:'1m',atr:2});

function signalDonutFixture(){
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const renderer=source.slice(source.indexOf('function updateSignalDonut('),source.indexOf('function renderPriceLevels('));
 const props=new Map(),classes=new Map(),attributes=new Map(),total={textContent:''};
 const donut={
  style:{setProperty:(key,value)=>props.set(key,value),removeProperty:key=>props.delete(key)},
  classList:{toggle:(key,on)=>classes.set(key,on)},
  setAttribute:(key,value)=>attributes.set(key,value)
 };
 const update=vm.runInNewContext(renderer+'\nupdateSignalDonut',{ $:selector=>selector==='#signal-donut'?donut:total });
 return {update,props,classes,attributes,total};
}

test('donut blends center on the true ratio boundaries and preserve a narrow active segment',()=>{
 const {update,props}=signalDonutFixture();
 const palette=['var(--green)','#dfa63f','var(--red)'];
 for(const [counts,boundaries] of [[[2,1,0],[240]],[[1,1,1],[120,240]],[[1,0,2],[120]],[[99,0,1],[356.4]]]){
  update(...counts,counts.reduce((sum,count)=>sum+count,0));
  const fill=props.get('--donut-fill');
  const origin=Number(fill.match(/from (-?[\d.]+)deg/)[1]);
  const stops=[...fill.matchAll(/(var\(--(?:green|red)\)|#dfa63f) ([\d.]+)deg/g)].map(([,color,angle])=>({color,angle:Number(angle)}));
  const active=palette.filter((_,index)=>counts[index]>0);
  assert.deepEqual([...new Set(stops.map(stop=>stop.color))].sort(),[...active].sort());
  assert.equal(stops[0].color,stops.at(-1).color,'matching endpoint colors close the seam');
  assert.equal(stops[0].angle,0);
  assert.equal(stops.at(-1).angle,360);
  const blends=stops.slice(1).flatMap((right,index)=>{
   const left=stops[index];
   return right.color===left.color?[]:[(left.angle+right.angle)/2+origin+90];
  });
  assert.deepEqual(blends.map(angle=>Number(angle.toFixed(6))),[0,...boundaries]);
  for(const color of active)assert.ok(stops.some((stop,index)=>index>0&&stop.color===color&&
   stops[index-1].color===color&&stop.angle>stops[index-1].angle),'each active color retains a solid arc');
 }
});

test('single-state donut stays solid and no-data clears the fill while preserving the accessible summary',()=>{
 const {update,props,classes,attributes,total}=signalDonutFixture();
 update(3,0,0,3);
 assert.equal(props.get('--donut-fill'),'var(--green)');
 assert.equal(total.textContent,'3');
 assert.equal(classes.get('no-data'),false);
 assert.equal(attributes.get('aria-label'),'สัดส่วนสัญญาณ ซื้อ 3 ถือ 0 ขาย 0 จาก 3 สัญญาณ');
 update(0,0,0,0);
 assert.equal(props.has('--donut-fill'),false);
 assert.equal(total.textContent,'—');
 assert.equal(classes.get('no-data'),true);
 assert.equal(attributes.get('aria-label'),'ยังไม่มีข้อมูลพอสรุปสัญญาณ');
});

function renderSignalEvidence({warnings=[],rows=260,unconfirmed=false,reasonCount}={}){
 const history=Array.from({length:rows},(_,i)=>({time:at+i*step,open:100+i*.1,high:102+i*.1,low:99+i*.1,close:101+i*.1,volume:1000+i}));
 const snapshot=technical.createTechnicalSnapshot({symbol:'PTT',timeframe:'1D',history,indicatorHistory:history,levelsHistory:history,
  fetchedAt:unconfirmed?null:new Date(at+rows*step).toISOString(),technicalMeta:{indicator:{interval:'1m',receivedAt:unconfirmed?null:new Date(at+rows*step).toISOString(),historyReasons:warnings}}});
 const before=JSON.stringify(snapshot),nodes=new Map();
 const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{dataset:{},style:{},textContent:'',innerHTML:''});return nodes.get(selector);};
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const renderer=source.slice(source.indexOf('function technicalTimeText('),source.indexOf('\nfunction indicatorLabel('));
 const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const view=reasonCount===undefined?snapshot:{...snapshot,summary:{...snapshot.summary,reasons:snapshot.summary.reasons.slice(0,reasonCount)}};
 const context=vm.createContext({technicalSnapshot:()=>view,createTechnicalSnapshot:technical.createTechnicalSnapshot,
  document:{getElementById:node},$:node,setText:(key,value)=>{node(key).textContent=value;},setTechnicalPanelState:()=>{},
  renderPriceLevels:()=>{},updateSignalDonut:()=>{},indicatorLabel:key=>key,escapeHtml,number:String,currentRange:'1D',latestMarket:{history},history});
 vm.runInContext(renderer+'\ndrawSignals(history);',context);
 return {snapshot,before,nodes,html:node('#technical-reasons').innerHTML,referenceNote:context.technicalReferenceNote};
}

test('signal evidence renders three readable reason groups and indicator details without serialized snapshot JSON',()=>{
 const {html,snapshot}=renderSignalEvidence();
 assert.doesNotMatch(html,/<pre\b|"(?:ruleId|candleTime|priceBasis)"\s*:/i);
 assert.match(html,/<div class="compact-reasons" role="list">/);
 assert.deepEqual([...html.matchAll(/class="technical-reason-number" aria-hidden="true">(\d+)</g)].map(match=>match[1]),['01','02','03']);
 for(const reason of snapshot.summary.reasons)assert.ok(html.includes(reason.text),'all three computed reasons remain readable');
 assert.equal(snapshot.summary.reasons.length,3);
 assert.match(html,/<details class="technical-evidence"><summary>ดูหลักฐานและค่ารายตัว<\/summary>/);
 for(const key of Object.keys(snapshot.availability))assert.ok(html.includes(key+':</span> <span class="evidence-status">พร้อม</span>'),'indicator availability remains');
 for(const reason of snapshot.analysis.reasons)assert.ok(html.includes(reason.key+' · '+reason.value),'individual indicator values remain');
});

test('reason cards follow the actual number of reasons',()=>{
 const {html}=renderSignalEvidence({reasonCount:2});
 assert.deepEqual([...html.matchAll(/class="technical-reason-number" aria-hidden="true">(\d+)</g)].map(match=>match[1]),['01','02']);
});

test('rendering signal evidence preserves the complete frozen calculation snapshot and all indicator series',()=>{
 const {snapshot,before,nodes}=renderSignalEvidence();
 assert.equal(JSON.stringify(snapshot),before);
 assert.equal(nodes.get('.analysis-panel').dataset.snapshotId,snapshot.id);
 assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot.summary.reasons));
 for(const key of ['rsi','macd','sma20','ema20','ema50','ema100','ema200','bb','atr'])assert.ok(snapshot.series[key]);
 assert.ok(snapshot.quality);assert.ok(snapshot.levels);assert.ok(snapshot.crosses);assert.ok(snapshot.priceBasis);
});

test('reference notes omit the generic warning on every timeframe while preserving internal warnings',()=>{
 const {snapshot,before,nodes,html,referenceNote}=renderSignalEvidence({warnings:['INVALID_NUMERIC']});
 assert.deepEqual(snapshot.quality.warnings,['INVALID_NUMERIC']);
 assert.equal(JSON.stringify(snapshot),before);
 assert.doesNotMatch(nodes.get('#analysis-note').textContent,/มีข้อควรตรวจสอบข้อมูล/);
 for (const timeframe of Object.keys(technical.RANGE_INTERVAL)) {
  const note=referenceNote({...snapshot,timeframe});
  assert.doesNotMatch(note,/มีข้อควรตรวจสอบข้อมูล/);
  assert.ok(note.includes('ช่วง '+timeframe));
 }
 assert.doesNotMatch(html,/<pre\b/i);
});

test('insufficient technical history remains unavailable without fabricated evidence or indicator values',()=>{
 const {snapshot,before,html,nodes}=renderSignalEvidence({rows:12});
 assert.equal(snapshot.analysis,null);assert.equal(JSON.stringify(snapshot),before);
 assert.match(html,/ข้อมูลยังไม่พอ/);assert.doesNotMatch(html,/<pre\b|technical-evidence/);
 assert.equal(nodes.get('#rsi-value').textContent,'—');
});
test('unconfirmed history shows waiting for close rather than a misleading shortage or fabricated signal',()=>{
 const {snapshot,nodes,html}=renderSignalEvidence({rows:40,unconfirmed:true});assert.equal(snapshot.summary.status,'waiting-close');assert.equal(nodes.get('#overall-signal').textContent,'รอแท่งปิด');assert.match(html,/ยังไม่มีแท่งที่ยืนยันแล้ว/);assert.match(nodes.get('#technical-plan').textContent,/รอหลักฐานว่าแท่งปิด/);assert.equal(nodes.get('#rsi-value').textContent,'—');
});
test('critical quality with insufficient history remains data review in the visible renderer',()=>{
 const {nodes,html}=renderSignalEvidence({rows:12,warnings:['HISTORICAL_ANOMALY']});assert.equal(nodes.get('#overall-signal').textContent,'ข้อมูลต้องตรวจสอบ');assert.match(html,/ข้อมูลต้องตรวจสอบ/);assert.equal(nodes.get('rsi-signal').textContent,'ข้อมูลต้องตรวจสอบ');
});
for(const [direction,source,type,value]of [[1,'Swing high','support',110],[-1,'Swing low','resistance',90]]){
 test(`${source} cannot change into ${type} on an unconfirmed/zero-volume breakout`,()=>{
  const rows=roleRows(direction,0),s=levels(rows);assert.ok(s.zones.some(z=>z.value===value&&z.state==='breakout-pending-volume'));
  assert.ok(!s[type+'Details'].some(z=>z.value===value&&z.source===source),'role flip requires completed breakout evidence, not just price side');
 });
 test(`${source} may legitimately change into ${type} after completed confirmed breakout and retest`,()=>{
  const rows=roleRows(direction);const s=levels(rows.slice(0,36)),detail=s[type+'Details'].find(z=>z.value===value&&z.source===source);
  assert.ok(detail);assert.equal(detail.originalType,direction>0?'resistance':'support');
  assert.equal(detail.roleConfirmation.kind,'breakout-confirmed');assert.ok(detail.roleConfirmation.confirmedAt<=rows.at(-1).availableAt);
  assert.ok(detail.sourceLabel.includes(source));assert.ok(detail.sourceLabel.includes(direction>0?'แนวรับ':'แนวต้าน'));assert.match(detail.sourceLabel,/กลับบทบาทยืนยัน/);
  const retest={...rows.at(-1),time:at+45*step,availableAt:at+46*step,low:direction>0?109.9:86,high:direction>0?114:90.1};
  const r=levels([...rows,retest])[type+'Details'].find(z=>z.value===value&&z.source===source);assert.equal(r.roleConfirmation.kind,'retest-confirmed');
 });
 test(`${source} role confirmation has no future evidence in replay and matches snapshot explanation`,()=>{
  const rows=roleRows(direction),cut=rows[34].availableAt;
  const earlier=technical.priceStructure(rows,100,{asOf:cut,candleTime:rows[34].time,interval:'1m',atr:2}),prefix=levels(rows.slice(0,35),100,cut);
  assert.deepEqual(earlier,prefix);
  const snapshot=technical.createTechnicalSnapshot({symbol:'PTT',timeframe:'1D',history:rows,indicatorHistory:rows,levelsHistory:rows,fetchedAt:new Date(rows.at(-1).availableAt).toISOString()});
  assert.deepEqual(snapshot.analysis.levels,snapshot.levels);
  const reason=snapshot.summary.reasons.find(r=>r.group==='structure');assert.equal(reason.values[type],snapshot.levels[type+'s'][0]??null);
  for(const d of [...snapshot.levels.supportDetails,...snapshot.levels.resistanceDetails])if(d.roleConfirmation)assert.ok(d.roleConfirmation.confirmedAt<=snapshot.asOf);
 });
}

test('confirmed structure reasons use Thai labels and retain the original event kinds',()=>{
 const rows=roleRows(1);
 for (const [count,kind,label] of [
  [36,'breakout-confirmed','ยืนยันการทะลุระดับราคา'],
  [39,'retest-confirmed','ยืนยันการกลับมาทดสอบระดับราคา']
 ]) {
  const history=rows.slice(0,count);
  const snapshot=technical.createTechnicalSnapshot({symbol:'PTT',timeframe:'1D',history,
   fetchedAt:new Date(history.at(-1).availableAt).toISOString()});
  const reason=snapshot.summary.reasons.find(item=>item.ruleId==='STRUCTURE-CONFIRMED-1');
  assert.equal(reason.values.event.kind,kind);
  assert.ok(reason.text.endsWith(' · '+label));
  assert.doesNotMatch(reason.text,/breakout-confirmed|retest-confirmed/);
 }
});

function drawingHarness(){
 const captures=new Set(),hostHandlers={},controlHandlers={},form={elements:{},hidden:true,addEventListener(){}};
 for(const end of ['a','b'])for(const key of ['Time','Price'])form.elements[end+key]={value:''};
 const status={textContent:''},list={innerHTML:''},remove={disabled:false};
 const host={classList:{toggle(){}},addEventListener:(name,fn)=>{hostHandlers[name]=fn;},setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id),focus(){}};
 const controls={addEventListener:(name,fn)=>{controlHandlers[name]=fn;},querySelectorAll:()=>[],querySelector:q=>q==='form'?form:q==='[data-draw-list]'?list:q==='[data-draw-delete]'?remove:status};
 const writes=[],workspace=new DrawingWorkspace({host,controls,read:()=>[],write:(key,items)=>writes.push({key,items:structuredClone(items)}),redraw(){}});
 workspace.bind('PTT:1D');workspace.anchor=e=>e.point;
 const event=(id,price=100,time=at,target=null)=>({pointerId:id,pointerType:'mouse',point:{time,price},target:{closest:()=>target},preventDefault(){}});
 const escape=()=>hostHandlers.keydown({key:'Escape',preventDefault(){}});
 const mode=tool=>controlHandlers.click({target:{closest:q=>q==='[data-draw-tool]'?{dataset:{drawTool:tool}}:null}});
 const original={id:'existing',type:'trend',a:{time:at,price:100},b:{time:at+step,price:110}};
 return {workspace,event,escape,mode,original,writes,captures,status};
}

test('drawing persistence wording names this device on normal and failed local writes',()=>{
 const h=drawingHarness();
 assert.equal(h.status.textContent,'เลื่อน/ซูมกราฟตามปกติ · ภาพวาดบันทึกแยกตามบัญชีบนอุปกรณ์นี้');
 h.workspace.items=[h.original];h.workspace.write=()=>{throw Error('fixture storage full');};h.workspace.save();
 assert.equal(h.status.textContent,'บันทึกบนอุปกรณ์นี้ไม่สำเร็จ ภาพวาดยังอยู่ในหน้านี้');
 assert.deepEqual(h.workspace.items,[h.original]);assert.equal(h.writes.length,0);
});
test('Escape cancels a new drawing without persisting a draft or keeping pointer capture',()=>{
 const h=drawingHarness(),w=h.workspace;h.mode('trend');w.pointerDown(h.event(1));w.pointerMove(h.event(1,120,at+step));h.escape();
 assert.deepEqual(w.items,[]);assert.equal(w.gesture,null);assert.equal(h.writes.length,0);assert.equal(h.captures.size,0);
 w.pointerUp(h.event(1));assert.equal(h.writes.length,0);
});
for(const handle of ['move','a','b'])for(const cancel of ['Escape','pointercancel'])test(`${cancel} restores both anchors before ${handle} edit and does not publish partial state`,()=>{
 const h=drawingHarness(),w=h.workspace;w.items=[structuredClone(h.original)];h.mode('select');
 w.pointerDown(h.event(1,100,at,{dataset:{drawShape:'existing',handle}}));w.pointerMove(h.event(1,120,at+step));
 if(cancel==='Escape')h.escape();else w.pointerUp(h.event(1),true);
 assert.deepEqual(w.items,[h.original]);assert.ok(h.writes.every(write=>JSON.stringify(write.items)===JSON.stringify([h.original])));assert.equal(w.gesture,null);
});
test('mode switch cancels a draft and releases capture; later pointerup cannot save it',()=>{
 const h=drawingHarness(),w=h.workspace;h.mode('trend');w.pointerDown(h.event(1));w.pointerMove(h.event(1,120,at+step));h.mode('pan');w.pointerUp(h.event(1));
 assert.deepEqual(w.items,[]);assert.equal(h.captures.size,0);assert.equal(h.writes.length,0);
});
test('a second drawing pointer cannot overwrite an in-flight gesture or leave an orphan draft',()=>{
 const h=drawingHarness(),w=h.workspace;h.mode('trend');w.pointerDown(h.event(1));w.pointerDown(h.event(2,120,at+step));
 assert.equal(w.items.length,1);assert.equal(w.gesture.pointer,1);w.pointerUp(h.event(1),true);assert.deepEqual(w.items,[]);
});
test('symbol/timeframe bind and account reset cancel in-flight edits without writing across context',()=>{
 for(const action of ['bind','reset']){const h=drawingHarness(),w=h.workspace;w.items=[structuredClone(h.original)];h.mode('select');w.pointerDown(h.event(1,100,at,{dataset:{drawShape:'existing',handle:'a'}}));w.pointerMove(h.event(1,120,at+step));
  if(action==='bind')w.bind('CPALL:1W');else w.reset();w.pointerUp(h.event(1));assert.deepEqual(w.items,[]);assert.equal(w.gesture,null);assert.equal(h.captures.size,0);assert.equal(h.writes.length,0);
 }
});
