'use strict';

const { validSourceTime } = require('../lib/settrade-active-hydration');
// Reuse the reviewed, static calendar and completed-session policy only.
// This module does not invoke automation, schedulers or calendar acquisition.
const { bangkokDay, tradingDay, latestSession } = require('./automation-policy');

function sourceMarketTime(value) {
  if (validSourceTime(value)) return value;
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2})\s+(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s+(\d{4})\s+(\d{2}:\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const year = Number(match[3]) > 2400 ? Number(match[3]) - 543 : Number(match[3]);
  const timestamp = `${year}-${String(months.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}T${match[4]}+07:00`;
  return validSourceTime(timestamp) ? timestamp : null;
}

function assessActiveSession(value, { now, maxIntradayAgeMs }) {
  const sourceAsOf = sourceMarketTime(value);
  const reject = reason => ({ accepted: false, reason, sourceAsOf });
  if (!sourceAsOf) return reject(value ? 'INVALID_DATA' : 'SOURCE_TIME_UNVERIFIED');
  const sourceTime = Date.parse(sourceAsOf);
  if (!Number.isFinite(now) || sourceTime > now) return reject('INVALID_DATA');
  const today = bangkokDay(now), sourceDay = bangkokDay(sourceTime);
  const todayTrading = tradingDay(today), sourceTrading = tradingDay(sourceDay);
  if (todayTrading === null) return reject('CALENDAR_UNAVAILABLE');
  // Compare sessions before accepting a timestamp; a recent fetch cannot make
  // an old market snapshot current. Missing calendar years are never guessed.
  if (sourceTrading === false) return reject('INVALID_DATA');
  if (sourceTrading === true && sourceDay === today && now - sourceTime <= maxIntradayAgeMs) {
    return { accepted: true, reason: null, sourceAsOf, session: sourceDay, context: 'RECENT_SESSION' };
  }
  const completed = latestSession(now);
  if (!completed || sourceTrading === null) return reject('CALENDAR_UNAVAILABLE');
  if (sourceDay !== completed) return reject('SOURCE_SESSION_STALE');
  // A dated snapshot of the latest completed session is usable over closures;
  // this is not evidence that it is today's live ranking or the final close.
  return { accepted: true, reason: null, sourceAsOf, session: sourceDay, context: 'SESSION_SNAPSHOT' };
}

module.exports = { sourceMarketTime, assessActiveSession };
