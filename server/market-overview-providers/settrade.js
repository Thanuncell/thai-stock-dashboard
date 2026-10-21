'use strict';

const { createSettradeService } = require('../settrade-service');

function createSettradeProvider(options = {}) {
  const service = options.service || createSettradeService(options);
  return {
    name: 'SETTRADE',
    getOverview(force = false) {
      return service.getOverview(force);
    },
    safety: service.safety
  };
}

module.exports = { createSettradeProvider };
