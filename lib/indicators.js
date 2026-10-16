(function initializeIndicators(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SETscopeIndicators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const formatNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  function computeSmaSeries(values, period) {
    let sum = 0;
    return values.map((value, index) => {
      sum += value;
      if (index >= period) sum -= values[index - period];
      return index >= period - 1 ? sum / period : null;
    });
  }

  function createRequestSequence() {
    let latest = 0;
    return {
      begin() { latest += 1; return latest; },
      isCurrent(requestId) { return requestId === latest; },
      invalidate() { latest += 1; }
    };
  }

  function alignIndicatorSeries(sourceRows, values, visibleRows) {
    const byTime = new Map(), byDay = new Map();
    sourceRows.forEach((row, index) => {
      const value = values[index];
      byTime.set(Number(row.time), value);
      const date = new Date(Number(row.time));
      if (!Number.isNaN(+date)) byDay.set(date.toISOString().slice(0, 10), value);
    });
    return visibleRows.map(row => {
      const exact = byTime.get(Number(row.time));
      if (exact !== undefined) return exact;
      const date = new Date(Number(row.time));
      return Number.isNaN(+date) ? null : (byDay.get(date.toISOString().slice(0, 10)) ?? null);
    });
  }

  function computeEma(values, period) {
    const numbers = (values || []).map(Number).filter(Number.isFinite);
    if (!numbers.length) return [];
    const result = Array(numbers.length).fill(null);
    if (numbers.length < period) return result;
    let ema = numbers.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    result[period - 1] = ema;
    const k = 2 / (period + 1);
    for (let index = period; index < numbers.length; index++) {
      ema = numbers[index] * k + ema * (1 - k);
      result[index] = ema;
    }
    return result;
  }

  function emaAtPeriod(values, period) {
    return computeEma(values, period).at(-1) ?? null;
  }

  function findPriceLevels(bars, last) {
    if (!Number.isFinite(Number(last)) || Number(last) <= 0) return { supports: [], resistances: [], supportDetails: [], resistanceDetails: [] };
    const recent = (bars || []).filter(bar => [bar.low, bar.high, bar.close].every(value => Number.isFinite(Number(value)) && Number(value) > 0)).slice(-260);
    const supports = [], resistances = [];
    for (let i = 2; i < recent.length - 2; i++) {
      const low = Number(recent[i].low), high = Number(recent[i].high);
      const neighbors = [recent[i - 2], recent[i - 1], recent[i + 1], recent[i + 2]];
      if (Number.isFinite(low) && low < last && neighbors.every(bar => low <= Number(bar.low))) supports.push(low);
      if (Number.isFinite(high) && high > last && neighbors.every(bar => high >= Number(bar.high))) resistances.push(high);
    }
    const gap = Math.max(last * 0.005, 0.01);
    const nearest = (levels, ascending, source) => {
      const selected = [];
      for (const level of [...new Set(levels)].sort((a, b) => ascending ? a - b : b - a)) {
        if (selected.every(item => Math.abs(item.value - level) >= gap)) selected.push({ value: level, source });
        if (selected.length === 3) break;
      }
      return selected;
    };
    const supportDetails = nearest(supports, false, 'Swing low');
    const resistanceDetails = nearest(resistances, true, 'Swing high');
    const pivotBar = recent.at(-1);
    if (pivotBar && (supportDetails.length < 3 || resistanceDetails.length < 3)) {
      const high = Number(pivotBar.high), low = Number(pivotBar.low), close = Number(pivotBar.close);
      const pivot = (high + low + close) / 3;
      const pivotSupports = [2 * pivot - high, pivot - (high - low), low - 2 * (high - pivot)].filter(level => level > 0 && level < last);
      const pivotResistances = [2 * pivot - low, pivot + (high - low), high + 2 * (pivot - low)].filter(level => level > last);
      for (const candidate of nearest(pivotSupports, false, 'Classic Pivot')) {
        if (supportDetails.every(item => Math.abs(item.value - candidate.value) >= gap)) supportDetails.push(candidate);
        if (supportDetails.length === 3) break;
      }
      for (const candidate of nearest(pivotResistances, true, 'Classic Pivot')) {
        if (resistanceDetails.every(item => Math.abs(item.value - candidate.value) >= gap)) resistanceDetails.push(candidate);
        if (resistanceDetails.length === 3) break;
      }
    }
    supportDetails.sort((a, b) => b.value - a.value).splice(3);
    resistanceDetails.sort((a, b) => a.value - b.value).splice(3);
    supportDetails.forEach((item, index) => Object.assign(item, { type: 'support', rank: index + 1 }));
    resistanceDetails.forEach((item, index) => Object.assign(item, { type: 'resistance', rank: index + 1 }));
    return {
      supports: supportDetails.map(item => item.value),
      resistances: resistanceDetails.map(item => item.value),
      supportDetails,
      resistanceDetails
    };
  }

  function analyseTechnicals(bars, levelBars = bars) {
    const usable = (bars || []).filter(bar => Number.isFinite(Number(bar.close)) && Number(bar.close) > 0);
    const values = usable.map(bar => Number(bar.close));
    if (values.length < 30) return null;
    const period = 14;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const change = values[i] - values[i - 1];
      if (change > 0) avgGain += change; else avgLoss -= change;
    }
    avgGain /= period; avgLoss /= period;
    for (let i = period + 1; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    }
    const rsi = avgGain === 0 && avgLoss === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    const sma20 = values.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
    const emas = { ema20: emaAtPeriod(values, 20), ema50: emaAtPeriod(values, 50), ema100: emaAtPeriod(values, 100), ema200: emaAtPeriod(values, 200) };
    const fast = computeEma(values, 12), slow = computeEma(values, 26);
    const macd = values.map((_, index) => Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : null);
    const macdIndexes = macd.map((value, index) => Number.isFinite(value) ? index : -1).filter(index => index >= 0);
    const signalValues = computeEma(macdIndexes.map(index => macd[index]), 9);
    const signalLine = Array(values.length).fill(null);
    macdIndexes.forEach((sourceIndex, index) => { signalLine[sourceIndex] = signalValues[index]; });
    const histogram = macd.map((value, index) => Number.isFinite(value) && Number.isFinite(signalLine[index]) ? value - signalLine[index] : null);
    const last = values.at(-1);
    const macdLast = macd.at(-1), macdSignalLast = signalLine.at(-1);
    const macdDiff = Number.isFinite(macdLast) && Number.isFinite(macdSignalLast) ? macdLast - macdSignalLast : null;
    const signals = {
      rsi: rsi < 30 ? 'ซื้อ' : rsi > 70 ? 'ขาย' : 'เป็นกลาง',
      sma: last >= sma20 ? 'ซื้อ' : 'ขาย'
    };
    if (macdDiff !== null) signals.macd = macdDiff > 0 ? 'ซื้อ' : macdDiff < 0 ? 'ขาย' : 'เป็นกลาง';
    Object.entries(emas).forEach(([key, value]) => { if (value !== null) signals[key] = last > value ? 'ซื้อ' : last < value ? 'ขาย' : 'เป็นกลาง'; });
    const reasons = [
      { key: 'RSI (14)', signal: signals.rsi, value: `RSI ${rsi.toFixed(1)}`, detail: rsi < 30 ? 'ต่ำกว่า 30: แรงขายมาก อาจเกิดแรงรีบาวด์ แต่ยังไม่ยืนยันว่าราคากลับตัว' : rsi > 70 ? 'สูงกว่า 70: ภาวะซื้อมาก ราคาอาจย่อตัวได้ แต่ในขาขึ้น RSI อาจสูงต่อเนื่อง' : 'อยู่ระหว่าง 30–70: ยังไม่เข้าขอบเขตซื้อมาก/ขายมากตามเกณฑ์ทั่วไป' },
      { key: 'SMA (20)', signal: signals.sma, value: `ราคา ${formatNumber(last)} · SMA ${formatNumber(sma20)}`, detail: last >= sma20 ? 'ราคาปิดอยู่เหนือค่าเฉลี่ย 20 แท่ง เป็นหลักฐานสนับสนุนแนวโน้มระยะสั้น' : 'ราคาปิดต่ำกว่าค่าเฉลี่ย 20 แท่ง แสดงว่าแนวโน้มระยะสั้นยังอ่อน' },
      { key: 'EMA (20)', signal: signals.ema20, value: `ราคา ${formatNumber(last)} · EMA ${formatNumber(emas.ema20)}`, detail: `ราคา${last >= emas.ema20 ? 'อยู่เหนือ' : 'อยู่ใต้'}ค่าเฉลี่ย 20 แท่ง ใช้ดูโมเมนตัมระยะสั้น` }
    ];
    if (signals.macd) reasons.splice(1, 0, { key: 'MACD (12, 26, 9)', signal: signals.macd, value: `MACD ${macdLast.toFixed(3)} · Signal ${macdSignalLast.toFixed(3)}`, detail: macdDiff > 0 ? 'เส้น MACD อยู่เหนือเส้น Signal โมเมนตัมระยะสั้นเป็นบวก' : macdDiff < 0 ? 'เส้น MACD อยู่ใต้เส้น Signal โมเมนตัมระยะสั้นเป็นลบ' : 'เส้น MACD และ Signal อยู่ระดับเดียวกัน โมเมนตัมยังไม่ชี้ทิศทาง' });
    for (const [key, emaPeriod, horizon] of [['ema50', 50, 'ระยะสั้นถึงกลาง'], ['ema100', 100, 'ระยะกลาง'], ['ema200', 200, 'ระยะยาว']]) {
      if (emas[key] === null) continue;
      reasons.push({ key: `EMA (${emaPeriod})`, signal: signals[key], value: `ราคา ${formatNumber(last)} · EMA ${formatNumber(emas[key])}`, detail: `ราคา${last >= emas[key] ? 'อยู่เหนือ' : 'อยู่ใต้'}ค่าเฉลี่ย ${emaPeriod} แท่ง เป็นหลักฐานแนวโน้ม${horizon}` });
    }
    const buy = Object.values(signals).filter(value => value === 'ซื้อ').length;
    const sell = Object.values(signals).filter(value => value === 'ขาย').length;
    const overall = buy > sell + 1 ? 'ซื้อ' : sell > buy + 1 ? 'ขาย' : 'เป็นกลาง';
    const levels = findPriceLevels(levelBars || usable, last);
    return { values, rsi, sma20, emas, macd: macdLast, macdSignal: macdSignalLast, macdSeries: macd, signalSeries: signalLine, macdHistogram: histogram, last, signals, reasons, buy, sell, overall, levels, available: Object.keys(signals).length, total: 7 };
  }

  return { analyseTechnicals, alignIndicatorSeries, computeEma, computeSmaSeries, createRequestSequence, emaAtPeriod, findPriceLevels };
});
