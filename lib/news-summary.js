'use strict';
const { reviewNewsItem } = require('./news-quality');

function fallbackNewsSummary(value = '') {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length < 20 || !/[\p{L}\p{N}]/u.test(text)) return '';
  if (/(ผลประกอบการ|กำไร|ขาดทุน|รายได้|งบการเงิน|earnings|financial results|revenue|profit)/i.test(text)) {
    return 'ข้อความข่าวมีคำสำคัญเกี่ยวกับผลประกอบการ ควรตรวจสอบตัวเลขและรายละเอียดจากข่าวต้นฉบับ';
  }
  if (/(เติบโต|ปันผลเพิ่ม|ฟื้นตัว|ชนะประมูล|คว้างาน|ยอดขายโต)/i.test(text)) {
    return 'ข้อความข่าวมีคำสำคัญเชิงบวก ควรตรวจสอบบริบท ตัวเลข และผลกระทบจากข่าวต้นฉบับ';
  }
  if (/(ร่วง|หดตัว|ผิดนัด|ถูกฟ้อง|เพิ่มทุน|ลดเป้า|เลื่อนโครงการ|ต้นทุนพุ่ง)/i.test(text)) {
    return 'ข้อความข่าวมีคำสำคัญเกี่ยวกับความเสี่ยง ควรตรวจสอบรายละเอียดและผลกระทบจากข่าวต้นฉบับ';
  }
  return 'คำสำคัญยังไม่เพียงพอสำหรับประเมินผลกระทบ ควรอ่านรายละเอียดจากข่าวต้นฉบับ';
}

// Read-time display metadata only; never grants verification or writes an archive row.
function withNewsRulesSummary(item) {
  if (reviewNewsItem(item).status !== 'VERIFIED') return null;
  if (item.analysisMode === 'ai' && String(item.analysisSummary || '').trim()) return item;
  const snippet = String(item.snippet || '').replace(/\s+/g, ' ').trim();
  const summary = snippet.length >= 20 && /[\p{L}\p{N}]/u.test(snippet)
    ? fallbackNewsSummary(`${item.title || ''} ${snippet}`) : '';
  return { ...item, analysisSummary: summary, analysisMode: summary ? 'rules' : '' };
}

module.exports = { fallbackNewsSummary, withNewsRulesSummary };
