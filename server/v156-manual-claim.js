'use strict';

const RUN_TYPE = 'v156:coverage';
function manualRunKey({ date = new Date(), tag = 'manual-1', type = 'coverage' } = {}) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw Error('Invalid run date');
  if (typeof tag !== 'string' || !/^[a-zA-Z0-9_-]{1,24}$/.test(tag)) throw Error('Invalid manual run tag');
  if (!['coverage','eod'].includes(type)) throw Error('Invalid job type');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = name => parts.find(item => item.type === name)?.value;
  return `v156:${type}:${part('year')}-${part('month')}-${part('day')}:${tag}`;
}

module.exports = { RUN_TYPE, manualRunKey };
