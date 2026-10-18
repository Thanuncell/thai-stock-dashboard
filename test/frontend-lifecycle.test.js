'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

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
  assert.doesNotMatch(indexSource, /แสดงเฉพาะข่าวย้อนหลัง 30 วัน/);
  assert.doesNotMatch(indexSource, /ไปที่ SETTRADE/);
  assert.doesNotMatch(indexSource, /คัดข่าวจากชื่อย่อหุ้นใน Watchlist ที่เลือก/);
  assert.doesNotMatch(indexSource, /id="watchlist-news-status"/);
  assert.doesNotMatch(appSource, /#watchlist-news-status/);
  assert.doesNotMatch(appSource, /setNewsStatus/);
  assert.doesNotMatch(appSource, /30 วัน|1 ปี/);
  assert.match(appSource, /watchlist\.length \? 'ยังไม่มีข่าวของหุ้นในรายการติดตาม' : 'ยังไม่มีหุ้นในรายการติดตาม'/);
});

test('latest and featured news headings share the same spacing', () => {
  assert.match(styleSource, /\.featured-news h3\{margin:12px 0 8px;font-size:12px;font-weight:600\}/);
  assert.match(styleSource, /\.latest-news-heading\{margin:12px 0 8px;font-size:12px;font-weight:600\}/);
});

test('source filtering renders loaded data and auto refresh does not write history', () => {
  const sourceHandler = appSource.match(/document\.querySelectorAll\('\.source-chip'\)[\s\S]*?\n\s*}\)\);/)?.[0] || '';
  assert.doesNotMatch(sourceHandler, /getNews\(/);
  assert.match(sourceHandler, /renderNews\(/);
  assert.match(appSource, /setInterval\(\(\)\s*=>\s*getNews\(\{\s*reason:\s*'poll'/);
  assert.match(appSource, /setInterval\(\(\)\s*=>\s*getWatchlistNews\(\{\s*reason:\s*'poll'/);
});

test('final UI cleanup preserves exact News and chart contracts', () => {
  assert.match(appSource, /query \? 'ไม่พบข่าวที่ตรงกับคำค้นนี้' : 'ยังไม่มีข่าวในหมวดที่เลือก'/);
  assert.match(appSource, /saved \? 'ติดตามแล้ว' : '＋ เพิ่มเข้า Watchlist'/);
  assert.doesNotMatch(appSource, /✓ อยู่ใน Watchlist/);
  assert.doesNotMatch(indexSource, /id="chart-meta"/);
  assert.doesNotMatch(appSource, /#chart-meta/);
  assert.doesNotMatch(indexSource, /id="chart-name"/);
  assert.doesNotMatch(appSource, /#chart-name/);
  assert.match(indexSource, /แหล่งข้อมูล: Yahoo Finance · ล่าช้าประมาณ 15 นาที/);
  assert.match(indexSource, /id="chart-updated">อัปเดตล่าสุด: —/);
  assert.match(appSource, /watchlist\[0\]\?\.symbol \|\| 'PTT'/);
});

test('News pagers preserve state and scroll only their own list with reduced-motion support', () => {
  assert.match(appSource, /window\.matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(appSource, /scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth', block: 'start' \}\)/);
  assert.match(appSource, /watchNewsPage = page; renderWatchlistNews\(\); writeNavigation\('push', 'watchlist'\); scrollNewsListToTop\('#watchlist-news-list'\)/);
  assert.match(appSource, /newsPage = page; writeNavigation\('push', 'news'\);[\s\S]*?if \(archiveConfigured\) await getArchiveNews\(\{ page \}\); else renderNews\(\);[\s\S]*?scrollNewsListToTop\('#latest-news-heading'\)/);
});

test('Technical Analysis wording and Overview anchors remain at baseline', () => {
  assert.match(indexSource, /<h2>สรุปสัญญาณ<\/h2>/);
  assert.match(indexSource, /<small>ความเห็นรวม<\/small>/);
  assert.match(indexSource, /<h3>เหตุผลประกอบสัญญาณ<\/h3>/);
  assert.match(indexSource, /สัญญาณเป็นเพียงหลักฐานทางเทคนิคย้อนหลัง/);
  assert.match(indexSource, /id="market-overview"/);
  assert.match(indexSource, /id="market-data-overview"/);
});
