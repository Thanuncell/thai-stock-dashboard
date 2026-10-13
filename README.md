# SETscope

Thai stock dashboard. Run `start.bat` (Node.js 18 or newer is required), then open http://127.0.0.1:4173.

## Deploy from GitHub

This app needs a small Node.js server to proxy Yahoo Finance and RSS requests. GitHub Pages only serves static files, so use Render's free web service instead. Push this repository to GitHub, sign in to [Render](https://render.com/), create a new Blueprint, and select the repository. Render reads `render.yaml`, builds the Node app, and gives it a public `onrender.com` URL. The free service may sleep after 15 minutes with no incoming traffic and take time to wake; see [Render free-instance limits](https://render.com/docs/free).

## Authentication setup

Email/password sign-up and sign-in use Supabase Auth; passwords are never stored by this app. Before the dashboard is available, create a Supabase project and set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Render's Environment settings (use the anon/publishable key, never a service-role or secret key). In Supabase, allow the deployed site's URL as an Auth redirect URL and configure email confirmation. The dashboard data APIs validate each access token with Supabase before returning search, market, or news data. If the variables are missing, the site stays on the setup/login screen and the APIs refuse access.

The sign-up page requires accepting the Terms and acknowledging the Privacy Notice. Review `terms.html` and `privacy.html`, fill in the real controller/support contact, and verify data retention and provider descriptions before public launch. Watchlists and alert preferences remain in browser storage; they are not synchronized to the user's account.

## Yahoo Finance market data

The dashboard searches Yahoo Finance's Thai equity results (symbols ending in `.BK`) by company name or ticker, with up to five locally saved watchlists and 30 symbols in each list. The selected list drives the sidebar, watchlist movers, market requests, and alert settings. Watchlists are stored in the browser and the previous single-list data is migrated on first load. The Yahoo Finance search and chart endpoints are undocumented and may change; search coverage follows Yahoo's market-symbol index, so check the SET securities directory if a listed symbol is not returned. Quotes and analysis poll every minute. Yahoo labels Thai stock quotes as delayed; the dashboard discloses an approximately 15-minute delay.

The main chart is rendered by SETscope as an OHLC candlestick chart with volume and selectable SMA 20 / EMA 20, 50, 100, and 200 overlays. Its data comes from Yahoo Finance, not TradingView; Yahoo Finance data for Thai stocks is delayed (the API response currently labels the delay as approximately 15 minutes). The side-panel RSI, MACD, SMA and EMA summary is calculated separately from Yahoo Finance closing prices. The technical panel explains the indicator evidence on each side, calculates nearby swing-low supports and swing-high resistances from the same selected chart timeframe, and describes a condition to monitor. A long EMA is omitted from the vote until enough bars are available. These are approximate levels and educational context, not an instruction to trade. The Technical View stock search changes the active chart only; the selected symbol stays in the search field. Adding to the Watchlist requires the separate add button. The light/dark theme and watchlist are saved in the browser. The watchlist scrolls independently when it has more items than fit on screen.

The SET Index banner uses Yahoo Finance for price, volume, high, and low. To display the SET market's accumulated trading value in million baht, configure the `SET_API_KEY` environment variable in Render. The backend requests the delayed index endpoint from SET's Market Data API. The value remains unavailable when this key is not configured or the API cannot return it; it is not estimated from volume.

Alert settings are created only for symbols in the currently selected Watchlist. Users can enable technical signal-change alerts and set an upper or lower price threshold. Alert preferences, state, and recent history are stored in that browser's local storage. The dashboard polls once per minute while the page is open; browser notifications require permission. There is no server-side push or background monitoring after closing the page, and Yahoo's Thai quotes are delayed.

## News

The news panel reads Google News RSS search feeds for Thunhoon, Kaohoon, SETTRADE and SET and refreshes every 5 minutes. Headlines link to the publisher story. A lightweight Thai headline keyword heuristic labels each item positive, negative, or neutral; it marks whether the headline mentions the currently viewed stock. This is a headline-level hint, not full-article sentiment or investment advice. Feed availability and update timing depend on the publishers and feed service.

Technical signals are for educational purposes, not investment advice. Yahoo Finance data must not be presented as real-time for SET: Yahoo classifies it as delayed. Search results are limited to symbols indexed by Yahoo Finance; Yahoo chart data is also an undocumented service.
