import { escapeHtml } from './domain.mjs';
export function seriesPath(values,x,y){let open=false;return values.map((v,i)=>{if(!Number.isFinite(v)){open=false;return '';}const s=`${open?'L':'M'}${x(i)},${y(v)}`;open=true;return s;}).join(' ');}
export function oscillatorPanel({values,x,left,right,width,top,label,type='rsi'}){
 const finite=values.filter(Number.isFinite),bottom=top+90;
 const min=type==='rsi'?0:Math.min(0,...finite),max=type==='rsi'?100:Math.max(...finite,1e-9),span=max-min||1;
 const y=v=>top+(max-v)/span*90;
 const thresholds=type==='rsi'?[30,50,70]:[min,max];
 return `<g class="oscillator-panel ${type}-panel"><rect class="macd-panel-bg" x="${left}" y="${top-20}" width="${width-left-right}" height="116" rx="4"/><text class="chart-label" x="${left+6}" y="${top-6}">${escapeHtml(label)}${finite.length?'':' · ข้อมูลไม่ครบ warm-up'}</text>${thresholds.map(v=>`<line class="chart-grid" x1="${left}" x2="${width-right}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis-text" x="${left-5}" y="${y(v)}" text-anchor="end">${Number(v.toFixed(2))}</text>`).join('')}<path class="${type}-chart-line" d="${seriesPath(values,x,y)}"/></g>`;
}
