import { escapeHtml } from './domain.mjs';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const point=p=>p&&finite(p.time)&&p.time>0&&finite(p.price)&&p.price>0;
export function validDrawings(value){
 const ids=new Set();return (Array.isArray(value)?value:[]).filter(d=>d&&typeof d.id==='string'&&/^[a-z0-9-]{1,80}$/i.test(d.id)&&!ids.has(d.id)&&ids.add(d.id)&&['trend','horizontal','measure'].includes(d.type)&&point(d.a)&&point(d.b)).slice(0,100).map(d=>({id:d.id,type:d.type,a:{time:d.a.time,price:d.a.price},b:{time:d.b.time,price:d.b.price}}));
}
export function projectAnchor(anchor,rows,x,y){
 if(!point(anchor)||!rows.length)return null;
 let i=rows.findIndex(row=>row.time>=anchor.time);
 if(i===0){const step=rows[1]?.time-rows[0].time||1;return {x:x((anchor.time-rows[0].time)/step),y:y(anchor.price)};}
 if(i<0)i=rows.length-1;
 const previous=rows[Math.max(0,i-1)],next=rows[i];
 const index=i===0?0:i-1+(anchor.time-previous.time)/(next.time-previous.time||1);
 return {x:x(index),y:y(anchor.price)};
}
export function measurement(d){return {change:d.b.price-d.a.price,percent:(d.b.price/d.a.price-1)*100,elapsed:d.b.time-d.a.time};}

// Local-only drawing state uses the caller's existing authenticated storage boundary.
export class DrawingWorkspace {
 constructor({host,controls,read,write,redraw,onModeChange=()=>{}}){
  Object.assign(this,{host,controls,read,write,redraw,onModeChange,key:'',items:[],selected:'',tool:'pan',gesture:null,context:null});
  controls.addEventListener('click',e=>{
   const tool=e.target.closest('[data-draw-tool]')?.dataset.drawTool;
   if(tool){this.cancelGesture();this.onModeChange();this.tool=tool;this.sync();return;}
   const select=e.target.closest('[data-drawing-id]')?.dataset.drawingId;
   if(select){this.cancelGesture();this.onModeChange();this.selected=select;this.tool='select';this.sync();redraw();return;}
   if(e.target.closest('[data-draw-delete]'))this.remove();
   if(e.target.closest('[data-draw-reset]')){this.cancelGesture();this.onModeChange();this.items=[];this.selected='';this.save();}
  });
  controls.querySelector('form').addEventListener('submit',e=>{
   e.preventDefault();const selected=this.selected;
   const inputs=Object.fromEntries(new FormData(e.currentTarget));
   this.cancelGesture();
   const d=this.items.find(d=>d.id===selected);if(!d)return;
   const a={time:Date.parse(inputs.aTime+'Z'),price:Number(inputs.aPrice)},b={time:Date.parse(inputs.bTime+'Z'),price:Number(inputs.bPrice)};
   if(!point(a)||!point(b)){this.message('กรุณาระบุวันเวลาและราคามากกว่าศูนย์');return;}
   d.a=a;d.b=d.type==='horizontal'?{...b,price:a.price}:b;this.save();
  });
  host.addEventListener('keydown',e=>{
   if(['Delete','Backspace'].includes(e.key)&&this.selected){e.preventDefault();this.remove();}
   if(e.key==='Escape'){this.cancelGesture();this.onModeChange();this.tool='pan';this.sync();redraw();}
  });
 }
 release(pointer){if(this.host.hasPointerCapture?.(pointer))this.host.releasePointerCapture?.(pointer);}
 cancelGesture(){
  const g=this.gesture;if(!g)return;
  this.gesture=null;
  const index=this.items.findIndex(d=>d.id===g.original.id);
  if(index>=0){if(g.created)this.items.splice(index,1);else this.items[index]=g.original;}
  if(g.created)this.selected=g.previousSelection||'';
  this.release(g.pointer);this.sync();this.redraw();
 }
 suspend(){this.cancelGesture();this.onModeChange();this.context=null;}
 reset(){this.suspend();this.key='';this.items=[];this.selected='';this.tool='pan';this.sync();}
 bind(key){if(key===this.key)return;this.suspend();this.key=key;this.items=validDrawings(this.read('setscope-drawings:'+key,[]));this.selected='';this.tool='pan';this.sync();}
 message(text){this.controls.querySelector('[data-draw-status]').textContent=text;}
 sync(){
  this.host.classList.toggle('drawing-active',this.tool!=='pan');
  this.controls.querySelectorAll('[data-draw-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.drawTool===this.tool)));
  this.controls.querySelector('[data-draw-list]').innerHTML=this.items.map((d,i)=>`<button type="button" data-drawing-id="${d.id}" aria-pressed="${d.id===this.selected}">${escapeHtml(({trend:'เส้นแนวโน้ม',horizontal:'เส้นราคา',measure:'วัดราคา'})[d.type])} ${i+1}</button>`).join('');
  const form=this.controls.querySelector('form'),d=this.items.find(d=>d.id===this.selected);form.hidden=!d;
  this.controls.querySelector('[data-draw-delete]').disabled=!d;
  if(d){for(const end of ['a','b']){form.elements[end+'Time'].value=new Date(d[end].time).toISOString().slice(0,-1);form.elements[end+'Price'].value=d[end].price;}}
  this.message(this.tool==='pan'?'เลื่อน/ซูมกราฟตามปกติ · ภาพวาดบันทึกแยกตามบัญชีบนอุปกรณ์นี้':this.tool==='select'?'เลือกเส้นเพื่อย้าย · ลากจุดปลายเพื่อแก้ไข · แก้ตัวเลขด้านล่างได้':'ลากบนกราฟราคาเพื่อวาด · Esc กลับโหมดเลื่อนกราฟ');
 }
 save(){this.items=validDrawings(this.items);try{this.write('setscope-drawings:'+this.key,this.items);this.sync();}catch{this.sync();this.message('บันทึกบนอุปกรณ์นี้ไม่สำเร็จ ภาพวาดยังอยู่ในหน้านี้');}this.redraw();}
 remove(){this.cancelGesture();this.onModeChange();this.items=this.items.filter(d=>d.id!==this.selected);this.selected='';this.save();}
 anchor(event){
  const c=this.context,svg=this.host.querySelector('svg');if(!c||!svg)return null;
  const bounds=svg.getBoundingClientRect(),px=(event.clientX-bounds.left)*c.width/bounds.width,py=(event.clientY-bounds.top)*c.height/bounds.height;
  if(px<c.left||px>c.width-c.right||py<c.top||py>c.bottom)return null;
  const i=Math.max(0,Math.min(c.rows.length-1,Math.round((px-c.x(0))/c.step)));
  return {time:c.rows[i].time,price:c.max-(py-c.top)/(c.bottom-c.top)*c.span,px,py};
 }
 pointerDown(e){
  if(this.tool==='pan')return false;
  if(this.gesture)return true;
  const p=this.anchor(e);if(!p)return true;
  const target=e.target.closest('[data-draw-shape]'),id=target?.dataset.drawShape;
  if(this.tool==='select'){
   const d=this.items.find(d=>d.id===id);this.selected=d?.id||'';
   if(d)this.gesture={pointer:e.pointerId,start:p,original:structuredClone(d),handle:target.dataset.handle||'move'};
  }else if(this.items.length<100){
   const id=globalThis.crypto?.randomUUID?.()||'d-'+Date.now().toString(36);
   const d={id,type:this.tool,a:{time:p.time,price:p.price},b:{time:p.time,price:p.price}};
   const previousSelection=this.selected;
   this.items.push(d);this.selected=id;this.gesture={pointer:e.pointerId,start:p,original:structuredClone(d),handle:'b',created:true,previousSelection};
  }
  // Keep the layout fixed throughout the gesture. The editor opens on release.
  this.host.focus?.({preventScroll:true});this.host.setPointerCapture?.(e.pointerId);e.preventDefault();this.redraw();return true;
 }
 pointerMove(e){
  if(!this.gesture||e.pointerId!==this.gesture.pointer)return this.tool!=='pan';
  const p=this.anchor(e),d=this.items.find(d=>d.id===this.selected);if(!p||!d)return true;
  const g=this.gesture;
  if(g.handle==='move'){
   const dt=p.time-g.start.time,dp=p.price-g.start.price;
   if(Math.min(g.original.a.price,g.original.b.price)+dp<=0||Math.min(g.original.a.time,g.original.b.time)+dt<=0)return true;
   for(const end of ['a','b'])d[end]={time:g.original[end].time+dt,price:g.original[end].price+dp};
  }else d[g.handle]={time:p.time,price:p.price};
  if(d.type==='horizontal')d.b.price=d.a.price=g.handle==='b'?p.price:d.a.price;
  e.preventDefault();this.redraw();return true;
 }
 pointerUp(e,cancel=false){
  if(this.gesture?.pointer===e.pointerId){if(cancel)this.cancelGesture();else {this.gesture=null;this.release(e.pointerId);this.save();}}
  return this.tool!=='pan';
 }
 svg(context){
  this.context=context;const {rows,x,y,left,right,width,top,bottom}=context;
  const ordered=this.items.filter(d=>d.id!==this.selected).concat(this.items.filter(d=>d.id===this.selected));
  return `<defs><clipPath id="drawing-clip"><rect x="${left}" y="${top}" width="${width-left-right}" height="${bottom-top}"/></clipPath></defs><g class="drawing-layer" clip-path="url(#drawing-clip)">${ordered.map(d=>{
   const a=projectAnchor(d.a,rows,x,y),b=projectAnchor(d.b,rows,x,y);if(!a||!b)return '';
   const selected=d.id===this.selected,attrs=`data-draw-shape="${d.id}"`;
   const line=`<line ${attrs} class="drawing-hit" x1="${d.type==='horizontal'?left:a.x}" y1="${a.y}" x2="${d.type==='horizontal'?width-right:b.x}" y2="${d.type==='horizontal'?a.y:b.y}"/><line ${attrs} class="drawing-line" x1="${d.type==='horizontal'?left:a.x}" y1="${a.y}" x2="${d.type==='horizontal'?width-right:b.x}" y2="${d.type==='horizontal'?a.y:b.y}"/>`;
   const m=measurement(d),label=d.type==='measure'?`${m.change.toFixed(2)} (${m.percent.toFixed(2)}%) · ${(Math.abs(m.elapsed)/3600000).toFixed(1)} ชม.`:'';
   return `<g class="drawing ${selected?'selected':''}">${line}${label?`<text class="drawing-label" x="${b.x+5}" y="${b.y-8}">${label}</text>`:''}${selected?['a','b'].map(end=>{const p=end==='a'?a:b;return `<circle ${attrs} data-handle="${end}" class="drawing-handle" cx="${p.x}" cy="${p.y}" r="7"/>`;}).join(''):''}</g>`;
  }).join('')}</g>`;
 }
}
