'use strict';

// Preserve date-only precision from an explicit source "as of date" label.
// This validates provenance; it does not infer a clock time or trading session.
function sourceMarketDate(value) {
  if (typeof value !== 'string') return null;
  const months = [['ม.ค.','มกราคม'],['ก.พ.','กุมภาพันธ์'],['มี.ค.','มีนาคม'],['เม.ย.','เมษายน'],
    ['พ.ค.','พฤษภาคม'],['มิ.ย.','มิถุนายน'],['ก.ค.','กรกฎาคม'],['ส.ค.','สิงหาคม'],
    ['ก.ย.','กันยายน'],['ต.ค.','ตุลาคม'],['พ.ย.','พฤศจิกายน'],['ธ.ค.','ธันวาคม']];
  let year, month, day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) [year, month, day] = iso.slice(1).map(Number);
  else {
    const thai = /^(\d{1,2})\s+([^\s]+)\s+(\d{4})$/.exec(value);
    if (!thai) return null;
    day = Number(thai[1]); month = months.findIndex(names => names.includes(thai[2])) + 1;
    year = Number(thai[3]); if (year > 2400) year -= 543;
  }
  const actual = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2100 && actual.getUTCFullYear() === year
    && actual.getUTCMonth() + 1 === month && actual.getUTCDate() === day ? value : null;
}

module.exports = { sourceMarketDate };
