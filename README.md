# PS5 Store Price Comparator

Compares PlayStation 5 game prices between Saudi Arabia (SAR) and USA (USD) using live store data.

## Features

- Search PlayStation store games and compare prices across regions
- Local price proxy with disk cache to avoid burning API credits
- Saudi Arabia (SAR) vs USA (USD) price comparison with currency conversion
- Automatic product discovery and pricing via chihiro + API.SH

## Setup

1. Get an API.SH key and place it in `psn-proxy/key.txt` (chmod 600)
2. Install Node.js dependencies (none required - uses fetch)
3. Start the local proxy: `node psn-proxy/server.js`
4. Open `psn-price-compare.html` in a browser

## Usage

- Start proxy: `node psn-proxy/server.js` (listens on 127.0.0.1:8787)
- Open the HTML file in browser
- Search for games and compare SA vs US prices

## API

- Proxy: `GET /game?id=<product_id>&region=<en-us|ar-sa>`
- Proxy: `GET /health`

## Configuration

- Regions: `en-us` (USA), `ar-sa` (Saudi Arabia)
- Currency: USD, SAR
- FX rate: 1 USD = 3.75 SAR

## Fixed

- Trademark symbol (`™`, `®`, `©`) normalization in search to prevent filtering issues
- Proxy CORS and Private Network Access support
- Fetch timeouts to prevent hanging requests
- Search early-break optimization

## License

MIT
