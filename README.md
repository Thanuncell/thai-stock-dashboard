# SETscope

Local Thai market dashboard. Run `start.bat` (Node.js 18 or newer is required), then open http://127.0.0.1:4173.

## Deploy from GitHub

This app needs a small Node.js server to proxy Yahoo Finance and RSS requests. GitHub Pages only serves static files, so use Render's free web service instead. Push this repository to GitHub, sign in to [Render](https://render.com/), create a new Blueprint, and select the repository. Render reads `render.yaml`, builds the Node app, and gives it a public `onrender.com` URL. The free service may sleep after 15 minutes with no incoming traffic and take time to wake; see [Render free-instance limits](https://render.com/docs/free).

## Yahoo Finance market data

The server requests Thai listings using Yahoo Finance symbols such as `PTT.BK`, and requests the SET index as `^SET.BK`. It polls every minute. Yahoo labels Thai stock quotes as delayed quotes; the dashboard discloses an approximately 15-minute delay. Yahoo does not publish this chart endpoint as a supported public API, so access or response formats may change. The server keeps requests on the backend to avoid browser CORS issues.

The chart loads Yahoo Finance historical intervals: 1-minute bars for 1D, 15-minute for 1W, daily for 1M/3M, and weekly for 1Y. Technical indicators are computed from Yahoo's returned closing-price series. Data availability and intervals are subject to Yahoo's service limits.

## News

The news panel reads Google News RSS search feeds for Thunhoon, Kaohoon, SETTRADE and SET and refreshes every 5 minutes. Headlines link to the publisher story. Feed availability and update timing depend on the publishers and feed service.

Technical signals are for educational purposes, not investment advice. Yahoo Finance data must not be presented as real-time for SET: Yahoo classifies it as delayed.
