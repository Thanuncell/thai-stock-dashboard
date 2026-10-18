'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'watchlists.sql'), 'utf8');
const archiveSql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'news_archive.sql'), 'utf8');
const renderConfig = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');

test('watchlist table keeps RLS enabled with per-user SELECT, INSERT and UPDATE policies', () => {
  assert.match(sql, /alter table public\.user_watchlists enable row level security/i);
  assert.match(sql, /for select to authenticated[\s\S]*?using\s*\(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(sql, /for insert to authenticated[\s\S]*?with check\s*\(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(sql, /for update to authenticated[\s\S]*?using\s*\(\(select auth\.uid\(\)\) = user_id\)[\s\S]*?with check\s*\(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.doesNotMatch(sql, /service_role/i);
});

test('news archive is additive, indexed, RLS-locked and cleaned in bounded batches', () => {
  assert.match(archiveSql, /create table if not exists public\.news_archive/i);
  assert.match(archiveSql, /alter table public\.news_archive enable row level security/i);
  assert.match(archiveSql, /alter table public\.news_archive force row level security/i);
  assert.match(archiveSql, /revoke all on public\.news_archive from anon, authenticated/i);
  assert.match(archiveSql, /on public\.news_archive \(published_at desc, id desc\)/i);
  assert.match(archiveSql, /using gin \(matched_symbols\)/i);
  assert.match(archiveSql, /limit greatest\(1, least\(coalesce\(p_limit, 500\), 2000\)\)/i);
  assert.match(archiveSql, /for update skip locked/i);
});

test('archive secret is configured by environment name only and never committed as a value', () => {
  assert.match(renderConfig, /key: SUPABASE_SECRET_KEY\s+sync: false/);
  assert.doesNotMatch(renderConfig, /SUPABASE_SECRET_KEY\s*[:=]\s*\S+/);
});
