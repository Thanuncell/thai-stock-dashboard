'use strict';

function createWatchlistService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  function endpoint() {
    return new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/user_watchlists`);
  }

  async function load(userId, authorization) {
    const url = endpoint();
    url.searchParams.set('select', 'watchlists,active_watchlist_id');
    url.searchParams.set('user_id', `eq.${userId}`);
    const upstream = await fetchImpl(url, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization },
      signal: AbortSignal.timeout(8000)
    });
    if (!upstream.ok) throw Error((await upstream.text()).slice(0, 300));
    const rows = await upstream.json();
    return rows[0] || null;
  }

  async function save(userId, authorization, normalized) {
    const url = endpoint();
    url.searchParams.set('on_conflict', 'user_id');
    const upstream = await fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: authorization,
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        user_id: userId,
        watchlists: normalized.watchlists,
        active_watchlist_id: normalized.activeWatchlistId
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!upstream.ok) throw Error((await upstream.text()).slice(0, 300));
  }

  return { load, save };
}

module.exports = { createWatchlistService };
