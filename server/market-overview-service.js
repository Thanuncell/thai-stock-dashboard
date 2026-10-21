'use strict';

const { EMPTY_FOREIGN, EMPTY_NVDR, EMPTY_TFEX, LINKS } = require('./settrade-service');

function unavailableOverview(error, now = Date.now) {
  const fetchedAt = new Date(now()).toISOString();
  return {
    indices: [],
    breadth: [],
    closeSummary: '',
    nvdr: { ...EMPTY_NVDR },
    foreign: { ...EMPTY_FOREIGN },
    tfex: { ...EMPTY_TFEX },
    activeValue: [],
    source: 'SETTRADE',
    fetchedAt,
    asOf: null,
    delayed: true,
    stale: false,
    partial: true,
    dataState: 'unavailable',
    marketDate: null,
    errors: [String(error?.code || error?.message || 'MARKET_OVERVIEW_UNAVAILABLE')],
    links: LINKS,
    fieldStatus: {},
    sourceStatus: { settrade: { state: error?.code === 'SCRAPER_DISABLED' ? 'DISABLED' : 'UNAVAILABLE' } },
    activeValueStatus: 'ข้อมูลภาพรวมตลาดไม่พร้อม'
  };
}

function createMarketOverviewService({
  provider,
  shadowProvider = null,
  shadowEnabled = process.env.MARKET_OVERVIEW_SHADOW_API_ENABLED === 'true',
  now = Date.now
} = {}) {
  if (!provider?.getOverview) throw Error('Market Overview provider is required');

  async function getOverview(force = false) {
    let result;
    try {
      result = await provider.getOverview(force);
    } catch (error) {
      result = { value: unavailableOverview(error, now), meta: { status: 'unavailable', staleAgeMs: 0 } };
    }

    const value = { ...result.value, sourceStatus: { ...(result.value.sourceStatus || {}) } };
    if (!shadowEnabled) {
      value.sourceStatus.shadow = { state: 'DISABLED' };
      return { ...result, value };
    }
    if (!shadowProvider?.compare) {
      value.sourceStatus.shadow = { state: 'UNVERIFIED', reason: 'NO_CONFIGURED_CANDIDATE' };
      return { ...result, value };
    }

    try {
      const comparison = await shadowProvider.compare(value);
      value.sourceStatus.shadow = {
        state: comparison?.status || 'UNVERIFIED',
        checkedAt: new Date(now()).toISOString()
      };
    } catch (error) {
      value.sourceStatus.shadow = { state: 'UNVERIFIED', reason: error.message };
    }
    return { ...result, value };
  }

  return { getOverview };
}

module.exports = { createMarketOverviewService, unavailableOverview };
