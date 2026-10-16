'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'watchlists.sql'), 'utf8');

test('watchlist table keeps RLS enabled with per-user SELECT, INSERT and UPDATE policies', () => {
  assert.match(sql, /alter table public\.user_watchlists enable row level security/i);
  assert.match(sql, /for select to authenticated[\s\S]*?using\s*\(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(sql, /for insert to authenticated[\s\S]*?with check\s*\(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(sql, /for update to authenticated[\s\S]*?using\s*\(\(select auth\.uid\(\)\) = user_id\)[\s\S]*?with check\s*\(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.doesNotMatch(sql, /service_role/i);
});
