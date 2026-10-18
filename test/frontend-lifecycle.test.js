'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('frontend setup remains single-shot and global listeners are not duplicated', () => {
  assert.equal((appSource.match(/addEventListener\('setscope:authenticated',\s*setup,\s*\{\s*once:\s*true\s*\}\)/g) || []).length, 1);
  assert.match(appSource, /if\s*\(document\.body\.classList\.contains\('authenticated'\)\)\s*setup\(\)/);
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

test('breadcrumb, bell and broker controls preserve accessible UI contracts', () => {
  assert.match(indexSource, /id="breadcrumb-home"[^>]*>ตลาดหุ้นไทย<\/a>/);
  assert.match(indexSource, /id="breadcrumb-current"[^>]*>ภาพรวม<\/span>/);
  assert.match(indexSource, /id="alerts-toggle"[\s\S]*?<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(indexSource, />🔔</);
  assert.match(indexSource, /data-source="broker">โบรกเกอร์<\/button>/);
  assert.match(indexSource, /<h3[^>]*id="latest-news-heading"[^>]*>ข่าวล่าสุด<\/h3>/);
});

test('news and watchlist UI omit archive-age copy', () => {
  assert.doesNotMatch(appSource, /คลังข่าวย้อนหลังสูงสุด 1 ปี ตามข้อมูลที่ต้นทางมี/);
  assert.doesNotMatch(appSource, /ข่าวสดย้อนหลัง 30 วัน/);
  assert.doesNotMatch(appSource, /โหลดฟีดไม่สำเร็จ · ข่าวย้อนหลัง 30 วัน/);
  assert.doesNotMatch(indexSource, /คัดข่าวย้อนหลัง 30 วันจากชื่อย่อหุ้นใน Watchlist ที่เลือก/);
  assert.match(indexSource, /คัดข่าวจากชื่อย่อหุ้นใน Watchlist ที่เลือก/);
});

test('source filtering renders loaded data and auto refresh does not write history', () => {
  const sourceHandler = appSource.match(/document\.querySelectorAll\('\.source-chip'\)[\s\S]*?\n\s*}\)\);/)?.[0] || '';
  assert.doesNotMatch(sourceHandler, /getNews\(/);
  assert.match(sourceHandler, /renderNews\(/);
  assert.match(appSource, /setInterval\(\(\)\s*=>\s*getNews\(\{\s*reason:\s*'poll'/);
  assert.match(appSource, /setInterval\(\(\)\s*=>\s*getWatchlistNews\(\{\s*reason:\s*'poll'/);
});
