'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'watchlists.sql'), 'utf8');
const archiveSql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'news_archive.sql'), 'utf8');
const archiveHardeningSql = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'news_archive_least_privilege.sql'),
  'utf8'
);
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
  assert.match(archiveSql, /revoke all on table public\.news_archive from anon, authenticated, service_role/i);
  assert.match(archiveSql, /grant select, insert, update, delete on public\.news_archive to service_role/i);
  assert.match(archiveSql, /revoke all on sequence public\.news_archive_id_seq from anon, authenticated, service_role/i);
  assert.match(archiveSql, /grant usage, select on sequence public\.news_archive_id_seq to service_role/i);
  assert.match(archiveSql, /revoke all on function public\.cleanup_news_archive\(integer\) from public, anon, authenticated, service_role/i);
  assert.match(archiveSql, /grant execute on function public\.cleanup_news_archive\(integer\) to service_role/i);
  assert.match(archiveSql, /on public\.news_archive \(published_at desc, id desc\)/i);
  assert.match(archiveSql, /using gin \(matched_symbols\)/i);
  assert.match(archiveSql, /limit greatest\(1, least\(coalesce\(p_limit, 500\), 2000\)\)/i);
  assert.match(archiveSql, /for update skip locked/i);
});

test('news archive hardening is object-scoped, non-destructive and least-privilege', () => {
  assert.match(archiveHardeningSql, /revoke all on table public\.news_archive from anon, authenticated, service_role/i);
  assert.match(archiveHardeningSql, /grant select, insert, update, delete on table public\.news_archive to service_role/i);
  assert.match(archiveHardeningSql, /revoke all on sequence public\.news_archive_id_seq from anon, authenticated, service_role/i);
  assert.match(archiveHardeningSql, /grant usage, select on sequence public\.news_archive_id_seq to service_role/i);
  assert.match(archiveHardeningSql, /revoke all on function public\.cleanup_news_archive\(integer\) from public, anon, authenticated, service_role/i);
  assert.match(archiveHardeningSql, /grant execute on function public\.cleanup_news_archive\(integer\) to service_role/i);
  assert.doesNotMatch(archiveHardeningSql, /alter default privileges/i);
  assert.doesNotMatch(archiveHardeningSql, /user_watchlists|keepalive|auth\./i);
  assert.doesNotMatch(archiveHardeningSql, /\bdrop\b|\btruncate\b|\bdelete\s+from\b|\binsert\s+into\b|\bupdate\s+public\./i);
});

test('archive secret is configured by environment name only and never committed as a value', () => {
  assert.match(renderConfig, /key: SUPABASE_SECRET_KEY\s+sync: false/);
  assert.doesNotMatch(renderConfig, /SUPABASE_SECRET_KEY\s*[:=]\s*\S+/);
});
