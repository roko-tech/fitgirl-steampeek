# FitGirl SteamPeek

A userscript that adds a compact Steam info card to FitGirl Repacks pages, giving you ratings, trailers, screenshots, and reviews without leaving the site.

![Violentmonkey](https://img.shields.io/badge/Violentmonkey-compatible-green) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-green) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Steam Ratings** — star rating, review score, positive percentage bar
- **Metacritic Score** — colored badge (green/yellow/red) linked to the Metacritic page
- **Game Info Bar** — release date, developer, and genre tags at a glance
- **Trailers** — watch Steam trailers in a fullscreen lightbox with HLS streaming support, navigate between trailers with arrow keys
- **Screenshots** — browse screenshots in a lightbox overlay with keyboard navigation
- **Most Helpful Reviews** — top 15 reviews with playtime, helpfulness score, and expand/collapse
- **Smart Caching** — caches Steam data in localStorage (7-day expiry) with automatic quota management
- **3-Tier URL Resolution** — finds the Steam page via RiotPixels, Steam Search API, or CS.RIN.RU
- **Purge Cache** — menu command in Violentmonkey/Tampermonkey to clear all cached data

## Installation

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/)
2. Click the link below to install the script:

   **[Install FitGirl SteamPeek](https://github.com/roko-tech/fitgirl-steampeek/raw/master/fitgirl-steampeek.user.js)**

3. Visit any game page on [FitGirl Repacks](https://fitgirl-repacks.site/) — the Steam info card appears automatically

## Screenshots

*Coming soon*

## How It Works

When you open a game page on FitGirl Repacks, the script:

1. Finds the CS.RIN.RU and RiotPixels links on the page
2. Resolves the Steam Store URL through a 3-tier system (RiotPixels → Steam Search → CS.RIN.RU)
3. Fetches game details and reviews from the Steam API
4. Renders a compact card with ratings, game info, and tabbed media panels

## Permissions

| Permission | Reason |
|---|---|
| `store.steampowered.com` | Fetch game details, reviews, and search |
| `ru.riotpixels.com` | Extract Steam URL from RiotPixels page |
| `cs.rin.ru` | Fallback Steam URL extraction (requires login) |
| `cdn.jsdelivr.net` | Load hls.js for trailer streaming |

## Cache Management

The script caches Steam data in `localStorage` to avoid repeated API calls. Cache entries expire after 7 days.

To manually clear all cached data:
- Click the Violentmonkey/Tampermonkey icon in your browser toolbar
- Select **Purge Steam Enhancer Cache** from the script menu

## License

MIT
