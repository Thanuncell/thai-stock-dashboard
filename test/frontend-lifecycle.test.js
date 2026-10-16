'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('frontend setup remains single-shot and global listeners are not duplicated', () => {
  assert.equal((appSource.match(/addEventListener\('setscope:authenticated',\s*setup,\s*\{\s*once:\s*true\s*\}\)/g) || []).length, 1);
  assert.equal((appSource.match(/window\.addEventListener\('resize'/g) || []).length, 1);
  assert.equal((appSource.match(/window\.addEventListener\('orientationchange'/g) || []).length, 1);
  assert.equal((appSource.match(/document\.addEventListener\('fullscreenchange'/g) || []).length, 1);
  assert.equal((appSource.match(/document\.addEventListener\('keydown'/g) || []).length, 1);
});

test('frontend owns one debounced search timer and one cloud sync timer', () => {
  assert.equal((appSource.match(/let searchTimer/g) || []).length, 1);
  assert.equal((appSource.match(/let watchlistSyncTimer/g) || []).length, 1);
  assert.equal((appSource.match(/clearTimeout\(searchTimer\)/g) || []).length, 1);
  assert.equal((appSource.match(/clearTimeout\(watchlistSyncTimer\)/g) || []).length, 1);
});
