'use strict';
// Owner-review synthetic news. These are NOT real news or live Gemini outputs.
const positive = 'PTT ได้รับคำสั่งซื้อก๊าซเพิ่มเติมจากลูกค้าอุตสาหกรรม';
const negative = 'AOT แจ้งปิดอาคารผู้โดยสารบางส่วนเพื่อซ่อมแซม ทำให้การให้บริการลดลงชั่วคราว';
const text = `ข่าวจำลองสำหรับทดสอบเท่านั้น ${positive} บริษัทระบุว่าสามารถส่งมอบได้จากกำลังการผลิตที่มีอยู่ ขณะที่ ${negative} หน่วยงานกำลังจัดแผนฟื้นฟูการให้บริการตามปกติ รายงานนี้ไม่มีคำแนะนำลงทุน`;
const noMatch = 'ข่าวจำลองสำหรับทดสอบเท่านั้น องค์กรชุมชนจัดกิจกรรมปลูกต้นไม้ในสวนสาธารณะ โดยไม่มีบริษัทจดทะเบียนที่เกี่ยวข้องและไม่มีข้อมูลผลกระทบต่อธุรกิจ';
const html = `<!doctype html><html lang="th"><head><title>ข่าวจำลอง — อุตสาหกรรมและสนามบิน</title></head><body><nav>เมนู โฆษณา สมัครสมาชิก</nav><main><article><h1>ข่าวจำลอง — อุตสาหกรรมและสนามบิน</h1><p>${text}</p><p>${text}</p></article></main><footer>ติดต่อเรา ส่วนท้ายที่ไม่ใช่ข่าว</footer></body></html>`;
const output = { summary: ['ข่าวจำลองกล่าวถึงคำสั่งซื้อก๊าซเพิ่มเติมของ PTT','AOT แจ้งหยุดให้บริการอาคารผู้โดยสารบางส่วนชั่วคราวในข่าวจำลอง'], stocks: [
  {symbol:'PTT', direction:'positive', reason:'คำสั่งซื้อเพิ่มเติมอาจสนับสนุนยอดขายก๊าซตามที่ข่าวระบุ', evidence:positive},
  {symbol:'AOT', direction:'negative', reason:'การปิดอาคารบางส่วนอาจจำกัดการให้บริการชั่วคราวตามข่าว', evidence:negative}
] };
function mockProvider() {
  let calls = 0;
  return { get calls() {return calls;}, async generate({article, signal}) {
    calls++;
    if (signal.aborted) throw Object.assign(Error('ABORTED'), {code:'PROVIDER_TIMEOUT'});
    if (article.includes('[failure]')) throw Object.assign(Error('Fixture failure'), {code:'PROVIDER_FAILURE', confirmedFailure:true});
    if (article.includes('[invalid]')) return '{broken';
    return JSON.stringify(article.includes(positive) && article.includes(negative) ? output : {summary:['ข้อมูลจำลองไม่มีหุ้นที่ยืนยันความเกี่ยวข้องได้','ผลนี้เป็น Fixture สำหรับทดสอบ ไม่ใช่ผลจาก Gemini จริง'],stocks:[]});
  }};
}
module.exports = {positive,negative,text,noMatch,html,output,mockProvider};
