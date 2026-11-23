// Isolated UI contract: injected transport must authenticate server-side and never retry.
export function mountNewsImpact({root,auth,send,preview=true}) {
  if(!root||!auth||typeof send!=='function')throw Error('MISSING_UI_CONTRACT');
  const legacy=document.createElement('div');legacy.id='news-explore-view';
  while(root.firstChild)legacy.append(root.firstChild);
  const tabs=document.createElement('div');tabs.className='impact-tabs';tabs.setAttribute('role','group');tabs.setAttribute('aria-label','มุมมองข่าว');
  tabs.innerHTML='<button type="button" id="news-explore-tab" aria-pressed="true">สำรวจข่าว</button><button type="button" id="news-impact-tab" aria-pressed="false">วิเคราะห์ข่าว</button>';
  const pane=document.createElement('section');pane.id='news-impact-view';pane.hidden=true;
  pane.innerHTML=`<div class="impact-heading"><div class="section-overline">NEWS IMPACT</div><h2>วิเคราะห์ผลกระทบข่าว</h2><p>อ่านประเด็นสำคัญ และหุ้นไทยที่อาจได้รับผลกระทบพร้อมเหตุผล</p></div><p class="impact-preview">${preview?'พื้นที่ทดสอบ Offline · ใช้ข่าวและผลวิเคราะห์จำลอง · ไม่ใช่คำแนะนำลงทุน':'ข้อมูลเพื่อประกอบการศึกษา ไม่ใช่คำแนะนำลงทุน'}</p><form id="impact-form"><fieldset class="impact-mode"><legend>เลือกรูปแบบข่าว</legend><label><input type="radio" name="mode" value="url" checked> URL ข่าว</label><label><input type="radio" name="mode" value="text"> ข้อความข่าว</label></fieldset><label id="impact-input-label" for="impact-input">URL ข่าว</label><textarea id="impact-input" rows="4" maxlength="20000" required placeholder="https://..."></textarea><div class="impact-actions"><button type="submit" id="impact-submit">วิเคราะห์ผลกระทบ</button></div></form><div id="impact-status" role="status" aria-live="polite">กรอกข่าวแล้วกดวิเคราะห์ผลกระทบเพื่อเริ่มต้น</div><div id="impact-result"></div>`;
  root.append(tabs,legacy,pane);
  const $=s=>pane.querySelector(s);
  let busy=false,revision=0,controller=null;
  const setView=analyze=>{legacy.hidden=analyze;pane.hidden=!analyze;tabs.querySelector('#news-explore-tab').setAttribute('aria-pressed',String(!analyze));tabs.querySelector('#news-impact-tab').setAttribute('aria-pressed',String(analyze));};
  tabs.querySelector('#news-explore-tab').onclick=()=>setView(false);
  tabs.querySelector('#news-impact-tab').onclick=()=>setView(true);
  const show=(value)=>{
    const box=$('#impact-result');box.replaceChildren();
    const heading=document.createElement('h3');heading.textContent='สรุปข่าว';box.append(heading);
    const list=document.createElement('ul');for(const text of value.summary){const item=document.createElement('li');item.textContent=text;list.append(item);}box.append(list);
    for(const [key,title]of [['positive','หุ้นที่อาจได้รับผลบวก'],['negative','หุ้นที่อาจได้รับผลลบ']]){
      const section=document.createElement('section');section.className=`impact-group ${key}`;
      const h=document.createElement('h3');h.textContent=title;section.append(h);
      if(!value[key].length){const p=document.createElement('p');p.textContent='ไม่พบหุ้นที่ยืนยันความเกี่ยวข้องได้';section.append(p);}
      for(const stock of value[key]){const article=document.createElement('article');const name=document.createElement('strong');name.textContent=stock.name===stock.symbol?stock.symbol:`${stock.symbol} · ${stock.name}`;const reason=document.createElement('p');reason.textContent=stock.reason;const evidence=document.createElement('blockquote');evidence.textContent=stock.evidence;article.append(name,reason,evidence);section.append(article);}box.append(section);
    }
  };
  const messages={FEATURE_UNAVAILABLE:'ฟีเจอร์นี้ยังไม่เปิดใช้งานสำหรับบัญชีนี้',INVALID_INPUT:'กรุณากรอกข้อความข่าวอย่างน้อย 60 ตัวอักษร',INVALID_URL:'URL ข่าวไม่ถูกต้อง',UNSAFE_URL:'URL นี้ไม่รองรับ',READER_UNAVAILABLE:'ไม่สามารถอ่านข่าวจาก URL นี้ได้',EMPTY_ARTICLE:'ไม่พบเนื้อหาข่าวที่อ่านได้',READER_PAYWALL:'ข่าวนี้จำกัดการเข้าถึง กรุณาใช้เนื้อหาที่คุณมีสิทธิ์อ่าน',READER_RESTRICTED:'ข่าวนี้จำกัดการเข้าถึง',INVALID_PROVIDER_JSON:'ผลวิเคราะห์ไม่ถูกต้อง กรุณาลองใหม่ด้วยตนเอง',INVALID_PROVIDER_OUTPUT:'ผลวิเคราะห์ไม่ถูกต้อง กรุณาลองใหม่ด้วยตนเอง',PROVIDER_FAILURE:'วิเคราะห์ไม่สำเร็จ กรุณาลองใหม่ด้วยตนเอง',UNAUTHORIZED:'กรุณาเข้าสู่ระบบ',PROVIDER_RATE_LIMIT:'ผู้ให้บริการจำกัดการใช้งาน กรุณาลองใหม่ด้วยตนเองภายหลัง',PROVIDER_TIMEOUT:'ยังยืนยันผลไม่ได้ กรุณาตรวจสอบก่อนส่งคำขอใหม่ ระบบจะไม่ลองซ้ำอัตโนมัติ',READER_JS_REQUIRED:'ข่าวนี้ต้องใช้ JavaScript กรุณาวางข้อความข่าวที่คุณมีสิทธิ์อ่าน',IN_PROGRESS:'กำลังวิเคราะห์ข่าว...',BUSY:'ระบบยังไม่พร้อมรับงาน กรุณาลองใหม่ด้วยตนเอง',REQUEST_CONFLICT:'คำขอนี้ใช้กับข่าวอื่นแล้ว กรุณาเริ่มคำขอใหม่'};
  $('#impact-form').onchange=()=>{const text=$('input[name=mode]:checked').value==='text';$('#impact-input-label').textContent=text?'ข้อความข่าว':'URL ข่าว';$('#impact-input').placeholder=text?'วางเนื้อหาข่าวที่ต้องการวิเคราะห์':'https://...';};
  $('#impact-form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;
    const identity=auth.captureIdentity();if(!identity?.ownerId){$('#impact-status').textContent=messages.UNAUTHORIZED;return;}
    const mode=$('input[name=mode]:checked').value,value=$('#impact-input').value.trim();
    const requestKey=crypto.randomUUID();
    const current=++revision;busy=true;controller=new AbortController();$('#impact-submit').disabled=true;$('#impact-input').disabled=true;for(const radio of pane.querySelectorAll('input[name=mode]'))radio.disabled=true;
    $('#impact-status').textContent='กำลังวิเคราะห์ข่าว...';$('#impact-result').replaceChildren();
    try{
      const response=await send({mode,value,requestKey},controller.signal);
      if(current!==revision||!auth.isCurrentIdentity(identity))return;
      if(response.code){throw Object.assign(Error('SAFE_ERROR'),{code:response.code});}
      if(response.result){show(response.result);$('#impact-status').textContent=response.result.status==='no_match'?'ไม่พบหุ้นไทยที่ยืนยันความเกี่ยวข้องได้':'วิเคราะห์เสร็จแล้ว';}
      else {$('#impact-status').textContent=messages[response.kind]||'ยังไม่มีผลวิเคราะห์ กรุณาตรวจสอบอีกครั้งด้วยตนเอง';}
    }catch(error){if(current===revision&&auth.isCurrentIdentity(identity))$('#impact-status').textContent=messages[error.code]||'วิเคราะห์ไม่สำเร็จ กรุณาลองใหม่ด้วยตนเอง';}
    finally{if(current===revision){busy=false;$('#impact-submit').disabled=false;$('#impact-input').disabled=false;for(const radio of pane.querySelectorAll('input[name=mode]'))radio.disabled=false;}}
  };
  window.addEventListener('setscope:session-boundary',()=>{revision++;controller?.abort();busy=false;$('#impact-result').replaceChildren();$('#impact-input').value='';$('#impact-status').textContent='กรอกข่าวแล้วกดวิเคราะห์ผลกระทบเพื่อเริ่มต้น';$('#impact-submit').disabled=false;$('#impact-input').disabled=false;for(const radio of pane.querySelectorAll('input[name=mode]'))radio.disabled=false;});
  return {setView};
}
