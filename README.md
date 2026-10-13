# SETscope

Thai stock dashboard. Run `start.bat` (Node.js 18 or newer is required), then open http://127.0.0.1:4173.

## Deploy from GitHub

This app needs a small Node.js server to proxy Yahoo Finance and RSS requests. GitHub Pages only serves static files, so use Render's free web service instead. Push this repository to GitHub, sign in to [Render](https://render.com/), create a new Blueprint, and select the repository. Render reads `render.yaml`, builds the Node app, and gives it a public `onrender.com` URL. The free service may sleep after 15 minutes with no incoming traffic and take time to wake; see [Render free-instance limits](https://render.com/docs/free).

## Yahoo Finance market data

The dashboard searches Yahoo Finance's Thai equity results (symbols ending in `.BK`) by company name or ticker, with a maximum of 12 locally saved watchlist symbols. The Yahoo Finance search and chart endpoints are undocumented and may change; search coverage follows Yahoo's market-symbol index, so check the SET securities directory if a listed symbol is not returned. Quotes and analysis poll every minute. Yahoo labels Thai stock quotes as delayed; the dashboard discloses an approximately 15-minute delay.

The main interactive chart is TradingView's Advanced Chart widget using SET symbols such as `SET:PTT`. It provides chart timeframes, indicators, and drawing tools. Availability and data delay depend on TradingView's market-data coverage and widget terms. The side-panel RSI, MACD, SMA and EMA summary is calculated separately from Yahoo Finance's returned closing-price series, which is delayed for Thai stocks. The light/dark theme and watchlist are saved in the browser.

## News

The news panel reads Google News RSS search feeds for Thunhoon, Kaohoon, SETTRADE and SET and refreshes every 5 minutes. Headlines link to the publisher story. Feed availability and update timing depend on the publishers and feed service.

Technical signals are for educational purposes, not investment advice. Yahoo Finance data must not be presented as real-time for SET: Yahoo classifies it as delayed. Search results are limited to symbols indexed by Yahoo Finance; Yahoo chart data is also an undocumented service.
