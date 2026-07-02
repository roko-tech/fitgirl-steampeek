// ==UserScript==
// @name         FitGirl SteamPeek
// @namespace    https://github.com/roko-tech/fitgirl-steampeek
// @version      1.15
// @description  Peek at Steam ratings, trailers, screenshots, and reviews directly on FitGirl pages
// @author       roko-tech
// @license      MIT
// @homepage     https://github.com/roko-tech/fitgirl-steampeek
// @supportURL   https://github.com/roko-tech/fitgirl-steampeek/issues
// @icon         https://store.steampowered.com/favicon.ico
// @updateURL    https://github.com/roko-tech/fitgirl-steampeek/raw/master/fitgirl-steampeek.user.js
// @downloadURL  https://github.com/roko-tech/fitgirl-steampeek/raw/master/fitgirl-steampeek.user.js
// @match        https://fitgirl-repacks.site/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_info
// @connect      store.steampowered.com
// @connect      cs.rin.ru
// @connect      www.protondb.com
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js#sha256=a91c218fd92b39c2c929b1a08400bc8e85df34a5d474dece920103a2c51675df
// @run-at       document-end
// ==/UserScript==
(function () {
    'use strict';
    const CONFIG = {
        // Derived from @version so the cache-key namespace can't drift from the release version.
        VERSION: (typeof GM_info !== 'undefined' && GM_info.script?.version) || '1.15',
        CACHE_PREFIX: 'se8:',
        CACHE_EXPIRY_DAYS: 7,
        MAX_COMMENTS: 15,
        MAX_SCREENSHOTS: 9,
        MAX_GENRES: 4,
        MAX_CACHE_ENTRIES: 50,
        MAX_PICKER: 6,
        MAX_RECENT: 8,
        OBSERVER_TIMEOUT: 15000
    };
    // ==================== RESOLVER (pure, testable) ====================
    const Resolver = {
        // Tier-0: a Steam CDN URL whose path encodes the GAME's appid (not a movie's).
        // Movie thumbnails use a per-movie ID under steam/apps/<movieId>/<hash>/movie_*.jpg;
        // game-level assets use the real appid under the known prefixes below.
        APPID_RE: /(?:steamstatic\.com|steamcdn-a\.akamaihd\.net)[^"'\s]*?(?:store_trailers\/(\d+)\/|steam\/apps\/(\d+)\/(?:ss_|header|library_|extras\/|capsule_|page_bg))/i,
        appIdFromHtml(html) {
            const m = String(html).match(this.APPID_RE);
            return m ? (m[1] || m[2]) : null;
        },
        titleFromPath(pathname) {
            let path = pathname;
            try { path = decodeURIComponent(path); } catch { /* keep encoded form */ }
            return path.replace(/^\/|\/$/g, '').replace(/-/g, ' ').trim();
        },
        // Archive/search/pagination paths must not be treated as game pages even
        // when they happen to contain exactly one article.
        isListPath(pathname, search) {
            return /^\/(tag|category|page|author)\//.test(pathname)
                || new URLSearchParams(search).has('s');
        },
        norm(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); },
        // Prefer (a) exact normalized match, (b) item whose name CONTAINS the full
        // target as a substring (mitigates the wrong-sequel risk when the original
        // query has been shortened to find any results), (c) first item.
        pickSearchResult(items, title) {
            if (!items?.length) return null;
            const target   = this.norm(title);
            const exact    = items.find(i => this.norm(i.name) === target);
            const contains = !exact && items.find(i => this.norm(i.name).includes(target));
            return exact || contains || items[0];
        },
        appIdFromManualValue(value) {
            const m = String(value).match(/\/app\/(\d+)/) || String(value).trim().match(/^(\d+)$/);
            return m ? m[1] : null;
        }
    };
    // Node test hook: export the pure logic and bail before any DOM/storage access.
    if (typeof document === 'undefined') {
        if (typeof module !== 'undefined') module.exports = { Resolver };
        return;
    }
    const DARK = {
        bg0: '#0d1117', bg1: '#161b22', bg2: '#21262d',
        txt: '#e6edf3', txt2: '#8b949e', txt3: '#6e7681',
        border: '#30363d',
        accent: '#66c0f4', accentDark: '#1b2838',
        green: '#3fb950', yellow: '#d29922', red: '#f85149', purple: '#bc8cff'
    };
    const LIGHT = {
        bg0: '#ffffff', bg1: '#f6f8fa', bg2: '#eaeef2',
        txt: '#1f2328', txt2: '#656d76', txt3: '#8b949e',
        border: '#d0d7de',
        accent: '#0969da', accentDark: '#ddf4ff',
        green: '#1a7f37', yellow: '#9a6700', red: '#cf222e', purple: '#8250df'
    };
    // ==================== THEME ====================
    const THEME_KEY = 'se-theme-pref';
    function getThemePref() { return localStorage.getItem(THEME_KEY) || 'auto'; }
    function setThemePref(v) { localStorage.setItem(THEME_KEY, v); }
    // ==================== SETTINGS ====================
    const SETTINGS_KEY = 'se-settings';
    const SETTINGS_DEFAULTS = {
        showCompat: true, showFeaturePills: true, showBlurb: true, showPcgw: true, showRecent: true,
        defaultMediaTab: 'trailers', defaultReviewSort: 'helpful', collapseByDefault: false
    };
    const Settings = {
        _cache: null,
        all() {
            if (!this._cache) {
                let stored = {};
                try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch {}
                this._cache = { ...SETTINGS_DEFAULTS, ...stored };
            }
            return this._cache;
        },
        get(k) { return this.all()[k]; },
        set(k, v) {
            this._cache = { ...this.all(), [k]: v };
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._cache)); } catch {}
        }
    };
    const SETTINGS_UI = [
        { key: 'theme',            label: 'Theme',                              type: 'select', options: ['auto', 'light', 'dark'], proxy: true },
        { key: 'showCompat',       label: 'ProtonDB / Steam Deck pills',        type: 'toggle' },
        { key: 'showFeaturePills', label: 'Platform / controller / DLC pills',  type: 'toggle' },
        { key: 'showBlurb',        label: 'Game description',                   type: 'toggle' },
        { key: 'showPcgw',         label: 'PCGamingWiki link',                  type: 'toggle' },
        { key: 'showRecent',       label: 'Recently viewed list',               type: 'toggle' },
        { key: 'defaultMediaTab',  label: 'Default tab',                        type: 'select', options: ['trailers', 'screenshots', 'reviews', 'sysreq'] },
        { key: 'defaultReviewSort',label: 'Default review sort',                type: 'select', options: ['helpful', 'recent'] },
        { key: 'collapseByDefault',label: 'Start collapsed (on reload)',        type: 'toggle' }
    ];
    function detectTheme() {
        const contentEl = document.querySelector('.entry-content, .post-content, article, .site-content, main, #content')
                       || document.body;
        let el = contentEl;
        while (el) {
            const bg = getComputedStyle(el).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
                const match = bg.match(/\d+/g);
                if (match) {
                    const brightness = (parseInt(match[0]) + parseInt(match[1]) + parseInt(match[2])) / 3;
                    return brightness > 127 ? 'light' : 'dark';
                }
            }
            el = el.parentElement;
        }
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    function resolveTheme() {
        const pref = getThemePref();
        return pref === 'auto' ? detectTheme() : pref;
    }
    let C = resolveTheme() === 'light' ? LIGHT : DARK;
    // ==================== DYNAMIC STYLES ====================
    let styleEl = null;
    function injectStyles() {
        if (styleEl) styleEl.remove();
        styleEl = Object.assign(document.createElement('style'), { textContent: buildCSS() });
        document.head.appendChild(styleEl);
    }
    function buildCSS() {
        return `
            #se-card {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 13px;
                color: ${C.txt};
            }
            #se-card * { box-sizing: border-box; }
            #se-card a  { color: ${C.accent}; }
            @keyframes se-spin { to { transform: rotate(360deg); } }
            @keyframes se-in   { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
            @keyframes se-shimmer {
                0%   { background-position: -200% 0; }
                100% { background-position: 200% 0; }
            }
            .se-spinner {
                display: inline-block;
                width: 13px; height: 13px;
                border: 2px solid ${C.border};
                border-top-color: ${C.accent};
                border-radius: 50%;
                animation: se-spin .8s linear infinite;
                vertical-align: middle;
                margin-right: 6px;
            }
            .se-skeleton {
                background: linear-gradient(90deg, ${C.bg2} 25%, ${C.border} 50%, ${C.bg2} 75%);
                background-size: 200% 100%;
                animation: se-shimmer 1.5s ease infinite;
                border-radius: 6px;
            }
            .se-tab {
                padding: 4px 11px;
                background: ${C.bg2};
                color: ${C.txt2};
                border: 1px solid ${C.border};
                border-radius: 5px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                transition: .2s;
            }
            .se-tab:hover  { color: ${C.txt}; border-color: ${C.accent}; }
            .se-tab.active { background: ${C.accentDark}; color: ${C.accent}; border-color: ${C.accent}; }
            .se-img-card {
                border-radius: 6px;
                overflow: hidden;
                cursor: pointer;
                border: 1px solid ${C.border};
                transition: .2s;
            }
            .se-img-card:hover { border-color: ${C.accent}; transform: scale(1.03); }
            .se-review {
                padding: 10px 12px;
                border-radius: 8px;
                background: ${C.bg1};
                border-left: 3px solid;
                margin-bottom: 8px;
                animation: se-in .25s ease;
            }
            .se-review:hover { background: ${C.bg2}; }
            .se-panel { transition: opacity .2s ease; }
            .se-genre-pill {
                display: inline-block;
                padding: 2px 8px;
                border-radius: 10px;
                font-size: 11px;
                font-weight: 600;
                background: ${C.bg2};
                color: ${C.txt2};
                border: 1px solid ${C.border};
            }
            .se-lightbox {
                position: fixed; inset: 0; z-index: 99999;
                background: rgba(0,0,0,.92);
                display: flex; align-items: center; justify-content: center;
                animation: se-in .2s ease; cursor: pointer;
            }
            .se-lightbox img {
                max-width: 92vw; max-height: 90vh; object-fit: contain;
                border-radius: 6px; cursor: default; animation: se-in .25s ease;
            }
            .se-lb-btn {
                position: absolute; top: 50%; transform: translateY(-50%);
                background: rgba(22,27,34,.85); color: ${C.txt};
                border: 1px solid ${C.border}; border-radius: 50%;
                width: 40px; height: 40px; font-size: 20px; cursor: pointer;
                display: flex; align-items: center; justify-content: center; transition: .2s;
            }
            .se-lb-btn:hover { background: ${C.bg2}; border-color: ${C.accent}; color: ${C.accent}; }
            .se-lb-close {
                position: absolute; top: 16px; right: 20px;
                background: rgba(22,27,34,.85); color: ${C.txt};
                border: 1px solid ${C.border}; border-radius: 50%;
                width: 36px; height: 36px; font-size: 18px; cursor: pointer;
                display: flex; align-items: center; justify-content: center; transition: .2s;
            }
            .se-lb-close:hover { background: ${C.bg2}; border-color: ${C.red}; color: ${C.red}; }
            .se-lb-counter {
                position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
                font-size: 13px; color: ${C.txt2};
                background: rgba(22,27,34,.85); padding: 4px 14px;
                border-radius: 20px; border: 1px solid ${C.border};
            }
            .se-theme-btn {
                background: none; border: none; color: ${C.txt2};
                cursor: pointer; font-size: 14px; padding: 2px 7px;
                border-radius: 4px; line-height: 1; transition: .2s;
            }
            .se-theme-btn:hover { color: ${C.accent}; }
            #se-card::-webkit-scrollbar       { width: 4px; }
            #se-card::-webkit-scrollbar-thumb { background: ${C.accent}; border-radius: 2px; }
            @media (max-width: 480px) {
                #se-toggle, #se-refresh, .se-theme-btn { font-size: 18px !important; padding: 7px 10px !important; }
                .se-tab { padding: 6px 12px; }
                .se-lb-btn   { width: 48px; height: 48px; }
                .se-lb-close { width: 44px; height: 44px; }
            }
            @media (prefers-reduced-motion: reduce) {
                .se-spinner   { animation: none; border-top-color: ${C.txt2}; }
                .se-skeleton  { animation: none; background: ${C.bg2}; }
                .se-review,
                .se-lightbox,
                .se-lightbox img { animation: none; }
                #se-card *    { transition: none !important; }
            }
        `;
    }
    injectStyles();
    // ==================== UTILS ====================
    const Utils = {
        cKey(k) { return CONFIG.CACHE_PREFIX + `v${CONFIG.VERSION}:` + k; },
        getCache(key) {
            try {
                const d = JSON.parse(localStorage.getItem(this.cKey(key)));
                if (!d) return null;
                const exp = new Date(d.ts);
                exp.setDate(exp.getDate() + CONFIG.CACHE_EXPIRY_DAYS);
                if (new Date() > exp) { localStorage.removeItem(this.cKey(key)); return null; }
                return d.data;
            } catch { return null; }
        },
        setCache(key, data) {
            this._evictIfOverLimit();
            try {
                localStorage.setItem(this.cKey(key), JSON.stringify({ data, ts: new Date().toISOString() }));
            } catch {
                this._evictOldest();
                try {
                    localStorage.setItem(this.cKey(key), JSON.stringify({ data, ts: new Date().toISOString() }));
                } catch {}
            }
        },
        clearCache(key) { localStorage.removeItem(this.cKey(key)); },
        _listEntries() {
            const entries = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(CONFIG.CACHE_PREFIX)) {
                    try {
                        const d = JSON.parse(localStorage.getItem(k));
                        entries.push({ key: k, ts: d.ts || '' });
                    } catch { entries.push({ key: k, ts: '' }); }
                }
            }
            return entries;
        },
        _evictIfOverLimit() {
            const entries = this._listEntries();
            if (entries.length < CONFIG.MAX_CACHE_ENTRIES) return;
            entries.sort((a, b) => a.ts.localeCompare(b.ts));
            const toRemove = entries.length - CONFIG.MAX_CACHE_ENTRIES + 1; // make room for one more
            for (let i = 0; i < toRemove; i++) localStorage.removeItem(entries[i].key);
        },
        _evictOldest() {
            const entries = this._listEntries();
            entries.sort((a, b) => a.ts.localeCompare(b.ts));
            const toRemove = Math.max(1, entries.length - CONFIG.MAX_CACHE_ENTRIES);
            for (let i = 0; i < toRemove; i++) localStorage.removeItem(entries[i].key);
        },
        // Attribute-safe: quotes are escaped too, so values may sit inside "..." attributes.
        escHtml(s) {
            if (!s) return '';
            return String(s).replace(/[&<>"']/g, c => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            ));
        },
        forceHttps(url) {
            return url ? url.replace(/^http:\/\//i, 'https://') : '';
        },
        formatMins(m) {
            if (m < 60) return `${m}m`;
            const h = Math.floor(m / 60);
            return h < 1000 ? `${h}h` : `${(h / 1000).toFixed(1)}k h`;
        },
        formatDate(ts) {
            const d = Math.floor((Date.now() - ts * 1000) / 86400000);
            if (d <= 0) return 'Today';
            if (d === 1) return '1d ago';
            if (d < 7) return `${d}d ago`;
            if (d < 30) return `${Math.floor(d / 7)}w ago`;
            if (d < 365) return `${Math.floor(d / 30)}mo ago`;
            return `${Math.floor(d / 365)}y ago`;
        },
        ratingStars(desc) {
            const map = {
                'Overwhelmingly Positive': '★★★★★',
                'Very Positive':           '★★★★½',
                'Positive':                '★★★★☆',
                'Mostly Positive':         '★★★½☆',
                'Mixed':                   '★★★☆☆',
                'Mostly Negative':         '★★☆☆☆',
                'Negative':                '★½☆☆☆',
                'Very Negative':           '★☆☆☆☆',
                'Overwhelmingly Negative': '☆☆☆☆☆'
            };
            for (const [k, v] of Object.entries(map)) if (desc?.includes(k)) return v;
            return '☆☆☆☆☆';
        },
        ratingColor(desc) {
            if (desc?.includes('Overwhelmingly Positive') || desc?.includes('Very Positive')) return C.green;
            if (desc?.includes('Positive')) return '#7bc96f';
            if (desc?.includes('Mixed')) return C.yellow;
            return C.red;
        },
        metacriticColor(score) {
            if (score >= 75) return '#6c3';
            if (score >= 50) return '#fc3';
            return '#f33';
        }
    };
    // ==================== API ====================
    const API = {
        req(cfg) {
            return new Promise((res, rej) => GM_xmlhttpRequest({
                ...cfg,
                timeout: 15000,
                onload:    r => (r.status >= 200 && r.status < 300) ? res(r) : rej(new Error(`HTTP ${r.status}`)),
                onerror:   rej,
                ontimeout: () => rej(new Error('Request timed out'))
            }));
        },
        async csrin(url) {
            return this.req({
                method: 'GET', url, anonymous: false,
                headers: { 'Referer': 'https://cs.rin.ru/', 'User-Agent': navigator.userAgent }
            });
        },
        async appDetails(id) {
            const r = await this.req({ method: 'GET', url: `https://store.steampowered.com/api/appdetails?appids=${id}&l=en` });
            return JSON.parse(r.responseText);
        },
        async reviews(id, n = CONFIG.MAX_COMMENTS, opts = {}) {
            const filter = opts.filter || 'helpful';
            const reviewType = opts.review_type || 'all';
            const r = await this.req({ method: 'GET', url: `https://store.steampowered.com/appreviews/${id}?json=1&language=english&filter=${filter}&review_type=${reviewType}&purchase_type=all&num_per_page=${n}` });
            return JSON.parse(r.responseText);
        },
        async steamSearch(title) {
            // cc is mandatory: without it storesearch returns zero results (verified 2026-07-02).
            const r = await this.req({ method: 'GET', url: `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=en&cc=US` });
            return JSON.parse(r.responseText);
        },
        async deckCompat(id) {
            const r = await this.req({ method: 'GET', url: `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${id}&l=english` });
            return JSON.parse(r.responseText);
        },
        async protonDb(id) {
            const r = await this.req({ method: 'GET', url: `https://www.protondb.com/api/v1/reports/summaries/${id}.json` });
            return JSON.parse(r.responseText);
        }
    };
    // ==================== MAIN CLASS ====================
    class SteamCard {
        constructor() {
            this.path       = location.pathname;
            this.link       = null;
            this.anchor     = null;
            this.appId      = null;
            this._reviews   = null;
            this._collapsed = (() => {
                if (Settings.get('collapseByDefault')) return true; // the setting wins on every load
                return localStorage.getItem('se-collapsed') === '1';
            })();
            this._settingsOpen = false;
            this._reviewsReady = null;
            this._reviewsResolve = null;
            this._screenshotUrls = [];
            this._cachedRating  = null;
            this._cachedReviews = null;
            this._cachedDetails = null;
            this._ratingForCache  = null;
            this._reviewsForCache = null;
            this._detailsForCache = null;
            this._cachedCompat    = null;
            this._compatForCache  = null;
            this._gen = 0;
        }
        init() {
            this._findAnchor(({ csrin, anchor }) => {
                this.link   = csrin || null;
                this.anchor = anchor;
                this._build();
                this._load();
            });
        }
        // ── DOM watcher ─────────────────────────────────────────────────────
        _findAnchor(cb) {
            const find = () => {
                const csrin = [...document.querySelectorAll('a[href*="cs.rin.ru"]')]
                    .find(a => /discussion|cs\.rin\.ru/i.test(a.textContent));
                const anchor = csrin
                    || document.querySelector('.entry-content')
                    || document.querySelector('article.post');
                return anchor ? { csrin: csrin || null, anchor } : null;
            };
            const result = find();
            if (result) { cb(result); return; }
            const tid = setTimeout(() => {
                obs.disconnect();
                console.warn('[SE] Timed out finding a card anchor');
            }, CONFIG.OBSERVER_TIMEOUT);
            const obs = new MutationObserver(() => {
                const r = find();
                if (r) { clearTimeout(tid); obs.disconnect(); cb(r); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }
        // ── Card shell ──────────────────────────────────────────────────────
        _build() {
            const card = document.createElement('div');
            card.id = 'se-card';
            card.style.cssText = `
                border: 1px solid ${C.border};
                border-radius: 10px;
                margin: 14px 0;
                max-width: 680px;
                background: ${C.bg1};
                overflow: hidden;
                animation: se-in .3s ease;
            `;
            card.insertAdjacentHTML('afterbegin',
                `<div style="height:2px;background:linear-gradient(90deg,${C.accent},${C.purple},${C.accent});"></div>`
            );
            const pref = getThemePref();
            const themeIcon = pref === 'auto' ? '◐' : pref === 'light' ? '☀' : '🌙';
            const themeTitle = pref === 'auto' ? 'Theme: Auto' : pref === 'light' ? 'Theme: Light' : 'Theme: Dark';
            const hdr = document.createElement('div');
            hdr.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 9px 14px;
                border-bottom: 1px solid ${C.border};
            `;
            hdr.innerHTML = `
                <span style="font-weight:700;font-size:14px;color:${C.accent};display:flex;align-items:center;gap:7px;">
                    <svg width="15" height="15" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" fill="none" stroke="${C.accent}" stroke-width="2"/>
                        <circle cx="12" cy="12" r="4"  fill="${C.accent}"/>
                    </svg>
                    Steam Info
                    <span id="se-badge" style="font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;"></span>
                </span>
                <div style="display:flex;gap:4px;">
                    <button id="se-settings" title="Settings"
                        class="se-theme-btn">⚙</button>
                    <button id="se-theme"  title="${themeTitle}"
                        class="se-theme-btn">${themeIcon}</button>
                    <button id="se-toggle"  title="Collapse"
                        style="background:none;border:none;color:${C.txt2};cursor:pointer;font-size:15px;padding:2px 7px;border-radius:4px;line-height:1;">▾</button>
                    <button id="se-refresh" title="Refresh"
                        style="background:none;border:none;color:${C.txt2};cursor:pointer;font-size:15px;padding:2px 7px;border-radius:4px;line-height:1;">⟳</button>
                </div>
            `;
            const body = document.createElement('div');
            body.id = 'se-body';
            body.style.cssText = 'padding:12px 14px;';
            const settingsPanel = document.createElement('div');
            settingsPanel.id = 'se-settings-panel';
            settingsPanel.style.cssText = `display:${this._settingsOpen ? 'block' : 'none'};padding:11px 14px;border-bottom:1px solid ${C.border};background:${C.bg0};`;
            this._renderSettingsPanel(settingsPanel);
            card.appendChild(hdr);
            card.appendChild(settingsPanel);
            card.appendChild(body);
            hdr.querySelector('#se-settings').onclick = () => {
                this._settingsOpen = !this._settingsOpen;
                settingsPanel.style.display = this._settingsOpen ? 'block' : 'none';
            };
            hdr.querySelector('#se-toggle').onclick = () => {
                this._collapsed = !this._collapsed;
                body.style.display = this._collapsed ? 'none' : 'block';
                hdr.querySelector('#se-toggle').textContent = this._collapsed ? '▸' : '▾';
                localStorage.setItem('se-collapsed', this._collapsed ? '1' : '0');
            };
            if (this._collapsed) {
                body.style.display = 'none';
                hdr.querySelector('#se-toggle').textContent = '▸';
            }
            hdr.querySelector('#se-refresh').onclick = () => this._refresh();
            hdr.querySelector('#se-theme').onclick = () => this._cycleTheme();
            this.card = card;
            this.body = body;
            if (this.link) {
                this.link.parentNode.insertBefore(card, this.link.nextSibling);
            } else {
                this.anchor.insertBefore(card, this.anchor.firstChild);
            }
            this._setBody(`<span class="se-spinner"></span> Loading Steam data…`);
        }
        // ── Settings panel ──────────────────────────────────────────────────
        _renderSettingsPanel(panel) {
            panel.innerHTML = `<div style="font-weight:700;color:${C.accent};font-size:12px;margin-bottom:9px;">⚙ Settings</div>`;
            const rows = document.createElement('div');
            rows.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
            SETTINGS_UI.forEach(s => {
                const cur = s.proxy ? getThemePref() : Settings.get(s.key);
                const row = document.createElement('label');
                row.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:${C.txt2};cursor:pointer;`;
                row.innerHTML = `<span>${s.label}</span>`;
                let control;
                if (s.type === 'toggle') {
                    control = document.createElement('input');
                    control.type = 'checkbox';
                    control.checked = !!cur;
                    control.style.cssText = `width:15px;height:15px;cursor:pointer;accent-color:${C.accent};flex-shrink:0;`;
                    control.onchange = () => this._onSettingChange(s, control.checked);
                } else {
                    control = document.createElement('select');
                    control.style.cssText = `font-size:12px;padding:2px 6px;border-radius:5px;background:${C.bg2};color:${C.txt};border:1px solid ${C.border};cursor:pointer;`;
                    s.options.forEach(o => {
                        const opt = document.createElement('option');
                        opt.value = o; opt.textContent = o;
                        if (o === cur) opt.selected = true;
                        control.appendChild(opt);
                    });
                    control.onchange = () => this._onSettingChange(s, control.value);
                }
                row.appendChild(control);
                rows.appendChild(row);
            });
            panel.appendChild(rows);
            const purge = document.createElement('button');
            purge.textContent = '🗑 Purge cache & reload';
            purge.style.cssText = `margin-top:10px;padding:4px 10px;background:${C.bg2};color:${C.txt};border:1px solid ${C.border};border-radius:5px;cursor:pointer;font-size:12px;`;
            purge.onclick = () => {
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith(CONFIG.CACHE_PREFIX)) localStorage.removeItem(k);
                }
                location.reload();
            };
            panel.appendChild(purge);
        }
        _onSettingChange(s, val) {
            if (s.proxy) { setThemePref(val); this._settingsOpen = true; this._applyTheme(); return; }
            Settings.set(s.key, val);
            if (s.key === 'collapseByDefault') return; // applies on the next page load
            this._load(); // re-render body from cache with the new gates (panel stays open)
        }
        _setBody(html) { this.body.innerHTML = html; }
        _setBadge(label, color, tooltip) {
            const b = this.card?.querySelector('#se-badge');
            if (!b || !label) { if (b) { b.textContent = ''; b.title = ''; } return; }
            b.textContent = label;
            b.title = tooltip || '';
            b.style.cssText = `
                background: ${color}22; color: ${color};
                border: 1px solid ${color}55;
                font-size: 10px; padding: 1px 6px;
                border-radius: 4px; font-weight: 600;
                vertical-align: middle; margin-left: 6px;
                cursor: ${tooltip ? 'help' : 'default'};
            `;
        }
        // ── Theme toggle ─────────────────────────────────────────────────────
        _applyTheme() {
            C = resolveTheme() === 'light' ? LIGHT : DARK;
            injectStyles();
            const parent  = this.card.parentNode;
            const sibling = this.card.nextSibling;
            this.card.remove();
            this._build();
            if (sibling) parent.insertBefore(this.card, sibling);
            else         parent.appendChild(this.card);
            this._reviews = null;
            this._cachedRating  = null;
            this._cachedReviews = null;
            this._cachedDetails = null;
            this._cachedCompat  = null;
            this._screenshotUrls = [];
            this._load();
        }
        _cycleTheme() {
            const order = ['auto', 'light', 'dark'];
            const cur = getThemePref();
            setThemePref(order[(order.indexOf(cur) + 1) % order.length]);
            this._applyTheme();
        }
        // ── Load orchestrator ───────────────────────────────────────────────
        async _load() {
            const gen = ++this._gen;
            this._ratingForCache  = null;
            this._reviewsForCache = null;
            this._detailsForCache = null;
            this._compatForCache  = null;
            try {
                const cached = Utils.getCache(this.path);
                let entry;
                if (cached?.steamUrl) {
                    this._setBadge(cached.manual ? 'manual' : 'cached', cached.manual ? C.accent : C.txt3, cached.manual ? 'Manually set Steam app ID' : 'Loaded from local cache (7-day TTL)');
                    if (cached.ratingData)  this._cachedRating  = cached.ratingData;
                    if (cached.reviewsData) this._cachedReviews = cached.reviewsData;
                    if (cached.detailsData) this._cachedDetails = cached.detailsData;
                    if (cached.compatData)  this._cachedCompat  = cached.compatData;
                    entry = { ...cached };
                    await this._display(cached.steamUrl, gen);
                } else {
                    const { url, tier } = await this._fetchUrl();
                    if (!url) return;
                    const badgeMap = {
                        page:  [C.green,  'page',   'Steam app ID extracted from the FitGirl page DOM'],
                        steam: [C.accent, 'search', 'Resolved via Steam store search by title'],
                        csrin: [C.yellow, 'cs.rin', 'Resolved via the CS.RIN.RU discussion thread']
                    };
                    const [col, label, tip] = badgeMap[tier] || [C.txt3, tier, ''];
                    this._setBadge(label, col, tip);
                    entry = { steamUrl: url };
                    Utils.setCache(this.path, entry);
                    await this._display(url, gen);
                }
                if (gen !== this._gen) return;
                // Persist any rating/review/details data freshly fetched during display.
                let dirty = false;
                if (this._ratingForCache  && entry.ratingData  !== this._ratingForCache)  { entry.ratingData  = this._ratingForCache;  dirty = true; }
                if (this._reviewsForCache && entry.reviewsData !== this._reviewsForCache) { entry.reviewsData = this._reviewsForCache; dirty = true; }
                if (this._detailsForCache && entry.detailsData !== this._detailsForCache) { entry.detailsData = this._detailsForCache; dirty = true; }
                if (this._compatForCache  && entry.compatData  !== this._compatForCache)  { entry.compatData  = this._compatForCache;  dirty = true; }
                if (dirty) Utils.setCache(this.path, entry);
            } catch (e) {
                console.error('[SE]', e);
                this._setBody(`
                    <div style="color:${C.red};font-size:13px;margin-bottom:8px;">⚠ ${Utils.escHtml(e.message)}</div>
                    <button id="se-retry"
                        style="padding:4px 12px;background:${C.bg2};color:${C.txt};
                               border:1px solid ${C.border};border-radius:5px;cursor:pointer;font-size:12px;">
                        Retry
                    </button>
                    <button id="se-manual"
                        style="margin-left:6px;padding:4px 12px;background:${C.bg2};color:${C.txt};
                               border:1px solid ${C.border};border-radius:5px;cursor:pointer;font-size:12px;">
                        Pick the right game
                    </button>
                `);
                this.body.querySelector('#se-retry')?.addEventListener('click', () => this._refresh());
                this.body.querySelector('#se-manual')?.addEventListener('click', () => this._showPicker());
            }
        }
        // ── 3-Tier URL resolution ────────────────────────────────────────────
        async _fetchUrl() {
            const domUrl = this._fromPageDom();
            if (domUrl) return { url: domUrl, tier: 'page' };
            try {
                const title = Resolver.titleFromPath(this.path);
                if (title) {
                    const url = await this._fromSteamSearch(title);
                    if (url) return { url, tier: 'steam' };
                }
            } catch (e) {
                console.warn('[SE] Steam search failed:', e.message);
            }
            if (!this.link) throw new Error('No Steam URL found on page');
            try {
                const r = await API.csrin(this.link.href);
                const m = r.responseText.match(/https?:\/\/store\.steampowered\.com\/app\/\d+[^\s"']*/i);
                if (!m) throw new Error('Steam URL not found on CS.RIN.RU');
                return { url: m[0], tier: 'csrin' };
            } catch (e) {
                if (/HTTP (401|403)/.test(e.message)) { this._authWall(); return {}; }
                throw e;
            }
        }
        _fromPageDom() {
            // Scan only the post content: comments below it must not steer resolution.
            const root = document.querySelector('.entry-content') || document.body;
            const id = Resolver.appIdFromHtml(root.innerHTML);
            return id ? `https://store.steampowered.com/app/${id}/` : null;
        }
        // Progressive shortening: retry with fewer words until the API returns anything.
        async _searchCandidates(title) {
            if (!title) return [];
            const words = title.split(/\s+/);
            for (let n = words.length; n >= 1; n--) {
                if (n < words.length) await new Promise(r => setTimeout(r, 200));
                const json = await API.steamSearch(words.slice(0, n).join(' '));
                if (json.items?.length) return json.items;
            }
            return [];
        }
        async _fromSteamSearch(title) {
            const best = Resolver.pickSearchResult(await this._searchCandidates(title), title);
            return best ? `https://store.steampowered.com/app/${best.id}/` : null;
        }
        // ── Display ─────────────────────────────────────────────────────────
        async _display(steamUrl, gen) {
            const idMatch = steamUrl.match(/app\/(\d+)/);
            if (!idMatch) return;
            this.appId = idMatch[1];
            const isLight = C === LIGHT;
            this._setBody(`
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                    <span style="display:inline-flex;align-items:center;gap:10px;">
                        <a href="${Utils.escHtml(steamUrl)}" target="_blank" rel="noopener noreferrer"
                           style="display:inline-flex;align-items:center;gap:6px;padding:5px 14px;
                                  background:linear-gradient(135deg,${C.accentDark},${isLight ? '#b6d4f0' : '#2a475e'});
                                  color:${isLight ? C.accent : 'white'};text-decoration:none;border-radius:6px;
                                  font-weight:700;font-size:13px;border:1px solid ${C.accent};">
                            <svg width="13" height="13" viewBox="0 0 24 24">
                                <path fill="${isLight ? C.accent : 'white'}" d="M12,2C6.48,2,2,6.48,2,12s4.48,10,10,10s10-4.48,10-10S17.52,2,12,2z"/>
                            </svg>
                            Steam Store
                        </a>
                        <button id="se-copy" title="Copy Steam link"
                           style="background:none;border:none;color:${C.txt3};cursor:pointer;font-size:14px;padding:0 2px;line-height:1;">⧉</button>
                        ${Settings.get('showPcgw') ? `<a href="https://www.pcgamingwiki.com/api/appid.php?appid=${this.appId}" target="_blank" rel="noopener noreferrer"
                           title="Fixes, DRM/Denuvo & anti-cheat info on PCGamingWiki"
                           style="font-size:11px;color:${C.txt3};text-decoration:underline;">🔧 PCGamingWiki</a>` : ''}
                        <a id="se-wrong" href="#" title="Not the right game? Enter the correct Steam URL"
                           style="font-size:11px;color:${C.txt3};text-decoration:underline;cursor:pointer;">Wrong game?</a>
                    </span>
                    <span id="se-rating-inline" style="font-size:12px;color:${C.txt2};display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <span class="se-skeleton" style="width:180px;height:14px;display:inline-block;"></span>
                    </span>
                </div>
                <div id="se-rating-bar" style="margin-bottom:12px;">
                    <div class="se-skeleton" style="height:4px;"></div>
                </div>
                <div id="se-compat-bar"></div>
                <div id="se-info-bar"></div>
                <div id="se-blurb"></div>
                <div id="se-media-wrap">
                    <div style="display:flex;gap:6px;margin-bottom:10px;">
                        <div class="se-skeleton" style="width:100px;height:28px;"></div>
                        <div class="se-skeleton" style="width:110px;height:28px;"></div>
                        <div class="se-skeleton" style="width:120px;height:28px;"></div>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:8px;">
                        <div class="se-skeleton" style="height:105px;"></div>
                        <div class="se-skeleton" style="height:105px;"></div>
                        <div class="se-skeleton" style="height:105px;"></div>
                    </div>
                </div>
                <div id="se-recent"></div>
            `);
            this._reviewsReady = new Promise(resolve => { this._reviewsResolve = resolve; });
            this.body.querySelector('#se-wrong')?.addEventListener('click', (e) => {
                e.preventDefault();
                this._showPicker();
            });
            this.body.querySelector('#se-copy')?.addEventListener('click', () => {
                const b = this.body.querySelector('#se-copy');
                const flash = t => { if (b) { b.textContent = t; setTimeout(() => { b.textContent = '⧉'; }, 1200); } };
                if (!navigator.clipboard) { flash('✗'); return; }
                navigator.clipboard.writeText(steamUrl).then(() => flash('✓'), () => flash('✗'));
            });
            this._renderRecent();
            await Promise.allSettled([
                this._loadRatingAndReviews(this.appId, gen),
                this._loadMedia(this.appId, gen),
                this._loadCompat(this.appId, gen)
            ]);
        }
        // ── Rating + Reviews ────────────────────────────────────────────────
        async _loadRatingAndReviews(id, gen) {
            const resolve = this._reviewsResolve;
            try {
                if (this._cachedRating && this._cachedReviews) {
                    this._reviews = this._cachedReviews;
                    this._renderRating(this._cachedRating);
                    resolve?.();
                    this._cachedRating = null;
                    this._cachedReviews = null;
                    return;
                }
                const data = await API.reviews(id, CONFIG.MAX_COMMENTS);
                if (gen !== this._gen) return;
                this._reviews = data.reviews || [];
                const qs = data.query_summary;
                if (qs) {
                    this._renderRating(qs);
                    // Stash for the single cache write performed by _load() at the end.
                    this._ratingForCache  = qs;
                    this._reviewsForCache = this._reviews;
                }
            } catch (e) {
                if (gen !== this._gen) return;
                console.error('[SE] rating error:', e);
                const ratingEl = this.body.querySelector('#se-rating-inline');
                if (ratingEl) {
                    ratingEl.innerHTML = `<span style="color:${C.txt3};font-size:12px;">Rating unavailable</span>`;
                }
            } finally {
                resolve?.();
            }
        }
        _renderRating(qs) {
            const pct = qs.total_reviews > 0
                ? Math.round((qs.total_positive / qs.total_reviews) * 100) : 0;
            const col = Utils.ratingColor(qs.review_score_desc);
            const ratingEl = this.body.querySelector('#se-rating-inline');
            const barEl    = this.body.querySelector('#se-rating-bar');
            if (!ratingEl || !barEl) return;
            ratingEl.innerHTML = `
                <span style="color:#ffd700;letter-spacing:1px;">${Utils.ratingStars(qs.review_score_desc)}</span>
                <span style="color:${col};font-weight:700;">${Utils.escHtml(qs.review_score_desc)}</span>
                <span style="color:${C.txt3};">${qs.total_reviews.toLocaleString()} reviews · ${pct}%</span>
                <span id="se-metacritic-slot"></span>
            `;
            barEl.innerHTML = `
                <div style="height:4px;background:${C.bg2};border-radius:2px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${col};
                                border-radius:2px;transition:width 1s ease;"></div>
                </div>
            `;
        }
        // ── Metacritic badge ────────────────────────────────────────────────
        _renderMetacritic(mc) {
            if (!mc?.score) return;
            const slot = this.body.querySelector('#se-metacritic-slot');
            if (!slot) return;
            const col = Utils.metacriticColor(mc.score);
            const badge = document.createElement('a');
            badge.href = (mc.url && /^https?:\/\//i.test(mc.url)) ? mc.url : '#';
            badge.target = '_blank';
            badge.rel = 'noopener noreferrer';
            badge.title = `Metacritic: ${mc.score}`;
            badge.style.cssText = `
                display:inline-flex;align-items:center;gap:4px;
                padding:2px 8px;border-radius:4px;font-size:12px;font-weight:800;
                background:${col};color:#000;text-decoration:none;
                border:1px solid ${col};transition:.2s;
            `;
            badge.textContent = mc.score;
            badge.addEventListener('mouseenter', () => { badge.style.opacity = '0.85'; });
            badge.addEventListener('mouseleave', () => { badge.style.opacity = '1'; });
            slot.appendChild(badge);
        }
        // ── Game info bar ───────────────────────────────────────────────────
        _renderInfoBar(d) {
            const bar = this.body.querySelector('#se-info-bar');
            if (!bar) return;
            const parts = [];
            if (d.is_free) {
                parts.push(`<span class="se-genre-pill" style="border-color:${C.green};color:${C.green};">🆓 Free to Play</span>`);
            } else if (d.price_overview) {
                const p = d.price_overview;
                const price = p.discount_percent > 0
                    ? `<span style="color:${C.green};font-weight:700;">-${p.discount_percent}%</span> <s style="color:${C.txt3};">${Utils.escHtml(p.initial_formatted)}</s> <b>${Utils.escHtml(p.final_formatted)}</b>`
                    : `<b>${Utils.escHtml(p.final_formatted)}</b>`;
                parts.push(`<span style="color:${C.txt2};">💲 ${price}</span>`);
            }
            if (d.release_date?.date) {
                parts.push(`<span style="color:${C.txt2};">📅 ${Utils.escHtml(d.release_date.date)}</span>`);
            }
            const dev = d.developers?.[0];
            if (dev) {
                parts.push(`<span style="color:${C.txt2};">🏢 ${Utils.escHtml(dev)}</span>`);
            }
            const genres = (d.genres || []).slice(0, CONFIG.MAX_GENRES);
            if (genres.length) {
                const pills = genres.map(g =>
                    `<span class="se-genre-pill">${Utils.escHtml(g.description)}</span>`
                ).join(' ');
                parts.push(pills);
            }
            // DRM / third-party-account notices straight from appdetails — never gated by a
            // setting: for this audience they outrank every other pill.
            const notice = s => {
                const t = String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                return Utils.escHtml(t.length > 90 ? t.slice(0, 90) + '…' : t);
            };
            if (d.drm_notice) {
                parts.push(`<span class="se-genre-pill" style="border-color:${C.red};color:${C.red};" title="DRM notice from Steam">🔒 ${notice(d.drm_notice)}</span>`);
            }
            if (d.ext_user_account_notice) {
                parts.push(`<span class="se-genre-pill" style="border-color:${C.yellow};color:${C.yellow};" title="Third-party account required (Steam notice)">👤 ${notice(d.ext_user_account_notice)}</span>`);
            }
            // Platform / feature / DLC / maturity signals — all from the already-fetched appdetails.
            if (Settings.get('showFeaturePills')) {
            const plat = d.platforms || {};
            const platIcons = [plat.windows && '🪟', plat.mac && '🍎', plat.linux && '🐧'].filter(Boolean).join(' ');
            if (platIcons) parts.push(`<span class="se-genre-pill" title="Available platforms">${platIcons}</span>`);
            const cats = (d.categories || []).map(c => c.description || '');
            const hasCat = re => cats.some(c => re.test(c));
            const feats = [];
            if (d.controller_support === 'full' || hasCat(/full controller/i)) feats.push('🎮 Controller');
            else if (hasCat(/partial controller/i)) feats.push('🎮 Partial pad');
            if (hasCat(/co-?op/i)) feats.push('👥 Co-op');
            else if (hasCat(/multi-?player|pvp/i)) feats.push('🌐 Multiplayer');
            else if (hasCat(/single-?player/i)) feats.push('👤 Single-player');
            if (hasCat(/cloud/i)) feats.push('☁ Cloud');
            feats.forEach(f => parts.push(`<span class="se-genre-pill">${f}</span>`));
            if (d.dlc?.length) parts.push(`<span class="se-genre-pill" title="DLC on Steam">🧩 ${d.dlc.length} DLC</span>`);
            if (d.recommendations?.total) parts.push(`<span class="se-genre-pill" title="Steam recommendations">👍 ${d.recommendations.total.toLocaleString()}</span>`);
            if (d.required_age >= 17 || d.content_descriptors?.ids?.length) {
                parts.push(`<span class="se-genre-pill" style="border-color:${C.yellow};color:${C.yellow};" title="Mature content">🔞 Mature</span>`);
            }
            } // end showFeaturePills
            if (!parts.length) return;
            bar.style.cssText = `
                display:flex;align-items:center;gap:8px;flex-wrap:wrap;
                padding:8px 10px;margin-bottom:12px;
                background:${C.bg0};border-radius:8px;
                border:1px solid ${C.border};
                font-size:12px;
            `;
            bar.innerHTML = parts.join(`<span style="color:${C.txt3};">·</span>`);
        }
        // ── Short description blurb ──────────────────────────────────────────
        _renderBlurb(d) {
            if (!Settings.get('showBlurb')) return;
            const el = this.body.querySelector('#se-blurb');
            if (!el || !d.short_description) return;
            el.style.cssText = `font-size:12px;color:${C.txt2};line-height:1.5;margin:-2px 0 12px;
                display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;`;
            el.textContent = d.short_description;
        }
        // ── Steam Deck / Proton compatibility ───────────────────────────────
        async _loadCompat(id, gen) {
            if (!Settings.get('showCompat')) return;
            if (this._cachedCompat) { this._renderCompat(this._cachedCompat); this._cachedCompat = null; return; }
            const [proton, deck] = await Promise.allSettled([API.protonDb(id), API.deckCompat(id)]);
            if (gen !== this._gen) return;
            const compat = { proton: null, deck: null };
            if (proton.status === 'fulfilled' && proton.value?.tier) {
                compat.proton = { tier: proton.value.tier, total: proton.value.total || 0 };
            }
            if (deck.status === 'fulfilled') {
                const cat = deck.value?.results?.resolved_category;
                if (cat) compat.deck = cat;
            }
            // Stash for the single cache write in _load() so cached pageviews don't re-hit the network.
            if (compat.proton || compat.deck) this._compatForCache = compat;
            this._renderCompat(compat);
        }
        _renderCompat(compat) {
            const bar = this.body.querySelector('#se-compat-bar');
            if (!bar || !compat) return;
            const pills = [];
            if (compat.proton?.tier) {
                const t = compat.proton;
                const map = { platinum: '#dfe6ee', gold: '#cfb53b', silver: '#9aa4ad', bronze: '#cd7f32', borked: C.red, native: C.green, pending: C.txt3 };
                const col = map[t.tier] || C.txt2;
                const label = t.tier.charAt(0).toUpperCase() + t.tier.slice(1);
                pills.push(`<span class="se-genre-pill" title="ProtonDB community rating${t.total ? ` · ${t.total} reports` : ''}" style="border-color:${col};color:${col};">🐧 Proton: ${label}</span>`);
            }
            if (compat.deck) {
                const dmap = { 1: ['Unsupported', C.red], 2: ['Playable', C.yellow], 3: ['Verified', C.green] };
                if (dmap[compat.deck]) {
                    const [txt, col] = dmap[compat.deck];
                    pills.push(`<span class="se-genre-pill" title="Steam Deck compatibility (Valve)" style="border-color:${col};color:${col};">🎮 Deck: ${txt}</span>`);
                }
            }
            if (!pills.length) return;
            bar.style.cssText = `display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px;`;
            bar.innerHTML = pills.join('');
        }
        // ── System requirements (sanitized to text) ─────────────────────────
        _renderSysReq(req) {
            const out = document.createElement('div');
            out.style.cssText = `font-size:12px;color:${C.txt2};line-height:1.6;`;
            const fmt = (html) => {
                // Parse inert: DOMParser never loads resources or runs handlers,
                // unlike a live innerHTML assignment.
                const doc = new DOMParser().parseFromString(
                    String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(li|p|div|ul)>/gi, '\n'),
                    'text/html'
                );
                return (doc.body.textContent || '').replace(/\n{2,}/g, '\n').trim();
            };
            const parts = [];
            if (req.minimum) parts.push(fmt(req.minimum));
            if (req.recommended) parts.push(fmt(req.recommended));
            out.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${Utils.escHtml(parts.join('\n\n'))}</pre>`;
            return out;
        }
        // ── Media panels ─────────────────────────────────────────────────────
        async _loadMedia(id, gen) {
            try {
                let d;
                if (this._cachedDetails) {
                    d = this._cachedDetails;
                    this._cachedDetails = null;
                } else {
                    const det   = await API.appDetails(id);
                    const entry = det && det[id];
                    if (!entry?.success || !entry.data) {
                        const wrap = this.body.querySelector('#se-media-wrap');
                        if (wrap) wrap.innerHTML = `<span style="color:${C.txt3};font-size:12px;">⚠ This Steam app is not publicly accessible.</span>`;
                        return;
                    }
                    d = entry.data;
                    this._detailsForCache = d;
                }
                if (gen !== this._gen) return;
                const wrap = this.body.querySelector('#se-media-wrap');
                if (!d || !wrap) return;
                this._renderInfoBar(d);
                this._renderBlurb(d);
                const movies = d.movies || [];
                const shots  = (d.screenshots || []).slice(0, CONFIG.MAX_SCREENSHOTS);
                this._screenshotUrls = shots.map(s => s.path_full);
                await this._reviewsReady;
                if (gen !== this._gen) return;
                // Render Metacritic after the rating renders its #se-metacritic-slot (created in _renderRating).
                this._renderMetacritic(d.metacritic);
                const revs = this._reviews || [];
                const sysReq = d.pc_requirements?.minimum ? d.pc_requirements : null;
                const tabs = [
                    movies.length && { id: 'se-trailers',    label: `🎬 Trailers (${movies.length})` },
                    shots.length  && { id: 'se-screenshots', label: `📸 Screenshots (${shots.length})` },
                    revs.length   && { id: 'se-reviews',     label: `💬 Reviews (${revs.length})` },
                    sysReq        && { id: 'se-sysreq',      label: `🖥 System Reqs` }
                ].filter(Boolean);
                if (!tabs.length) {
                    wrap.innerHTML = `<span style="color:${C.txt3};font-size:12px;">No media available.</span>`;
                    return;
                }
                const wantId = 'se-' + Settings.get('defaultMediaTab');
                const activeId = tabs.some(t => t.id === wantId) ? wantId : tabs[0].id;
                wrap.innerHTML = '';
                const tabBar = document.createElement('div');
                tabBar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;';
                let activePanel = null;
                tabs.forEach((t, i) => {
                    const btn = document.createElement('button');
                    btn.className = 'se-tab' + (t.id === activeId ? ' active' : '');
                    btn.textContent = t.label;
                    btn.onclick = () => {
                        tabBar.querySelectorAll('.se-tab').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        const target = wrap.querySelector('#' + t.id);
                        if (activePanel && activePanel !== target) {
                            activePanel.style.opacity = '0';
                            const prev = activePanel;
                            const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
                            setTimeout(() => {
                                prev.style.display = 'none';
                                target.style.display = 'block';
                                requestAnimationFrame(() => { target.style.opacity = '1'; });
                            }, delay);
                        } else {
                            wrap.querySelectorAll('.se-panel').forEach(p => { p.style.display = 'none'; p.style.opacity = '0'; });
                            target.style.display = 'block';
                            requestAnimationFrame(() => { target.style.opacity = '1'; });
                        }
                        activePanel = target;
                    };
                    tabBar.appendChild(btn);
                });
                wrap.appendChild(tabBar);
                // ── Trailers ──
                if (movies.length) {
                    // Keep _trailers index-aligned with `movies` (and the grid) so a click maps by index, not by name.
                    this._trailers = movies.map((m, i) => ({
                        url: Utils.forceHttps(m.hls_h264 || m.dash_h264 || m.webm?.max || m.mp4?.max || m.webm?.['480'] || m.mp4?.['480'] || ''),
                        name: m.name || `Trailer ${i + 1}`
                    }));
                    const panel = this._panel('se-trailers', activeId === 'se-trailers');
                    if (activeId === 'se-trailers') activePanel = panel;
                    const grid  = document.createElement('div');
                    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;';
                    movies.forEach((m, i) => {
                        const card = document.createElement('div');
                        card.className = 'se-img-card';
                        const trailerName = Utils.escHtml(m.name) || `Trailer ${i + 1}`;
                        const videoUrl = m.hls_h264 || m.dash_h264 || m.webm?.max || m.mp4?.max || m.webm?.['480'] || m.mp4?.['480'];
                        card.innerHTML = `
                            <div class="se-trailer-container" style="position:relative;padding-bottom:56.25%;background:#000;overflow:hidden;">
                                <img src="${Utils.escHtml(m.thumbnail)}" alt="${trailerName}" loading="lazy"
                                     style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;transition:.3s;">
                                <div class="se-play-overlay" style="position:absolute;inset:0;display:flex;align-items:center;
                                            justify-content:center;background:rgba(0,0,0,.3);">
                                    <div style="width:42px;height:42px;background:rgba(27,40,56,.9);
                                                border-radius:50%;display:flex;align-items:center;
                                                justify-content:center;border:2px solid ${C.accent};">
                                        <svg width="15" height="15" viewBox="0 0 24 24">
                                            <path fill="${C.accent}" d="M8,5.14V19.14L19,12.14Z"/>
                                        </svg>
                                    </div>
                                </div>
                            </div>
                            <div style="padding:6px 10px;font-size:12px;font-weight:600;color:${C.txt};
                                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                                ${trailerName}
                            </div>
                        `;
                        card.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!videoUrl) return;
                            this._showVideoLightbox(i);
                        });
                        grid.appendChild(card);
                    });
                    panel.appendChild(grid);
                    wrap.appendChild(panel);
                }
                // ── Screenshots ──
                if (shots.length) {
                    const panel = this._panel('se-screenshots', activeId === 'se-screenshots');
                    if (activeId === 'se-screenshots') activePanel = panel;
                    const grid  = document.createElement('div');
                    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:8px;';
                    shots.forEach((s, idx) => {
                        const card = document.createElement('div');
                        card.className = 'se-img-card';
                        card.innerHTML = `
                            <img src="${Utils.escHtml(s.path_thumbnail)}" loading="lazy" alt="Screenshot"
                                 style="width:100%;height:105px;object-fit:cover;display:block;">
                        `;
                        card.onclick = () => this._showLightbox(idx);
                        grid.appendChild(card);
                    });
                    panel.appendChild(grid);
                    wrap.appendChild(panel);
                }
                // ── Most Helpful Reviews ──
                if (revs.length) {
                    const panel = this._panel('se-reviews', activeId === 'se-reviews');
                    if (activeId === 'se-reviews') activePanel = panel;
                    panel.style.maxHeight   = '400px';
                    panel.style.overflowY   = 'auto';
                    panel.style.paddingRight = '4px';
                    this._buildReviewsPanel(panel, revs, gen);
                    wrap.appendChild(panel);
                }
                // ── System Requirements ──
                if (sysReq) {
                    const visible = activeId === 'se-sysreq';
                    const panel = this._panel('se-sysreq', visible);
                    if (visible) activePanel = panel;
                    panel.style.maxHeight   = '400px';
                    panel.style.overflowY   = 'auto';
                    panel.style.paddingRight = '4px';
                    panel.appendChild(this._renderSysReq(sysReq));
                    wrap.appendChild(panel);
                }
            } catch (e) {
                console.error('[SE] media error:', e);
                const wrap = this.body.querySelector('#se-media-wrap');
                if (wrap) {
                    wrap.innerHTML = `<span style="color:${C.txt3};font-size:12px;">⚠ Failed to load media: ${Utils.escHtml(e.message)}</span>`;
                }
            }
        }
        // ── Reviews panel (filter/sort + render) ─────────────────────────────
        _buildReviewsPanel(panel, revs, gen) {
            const state = { filter: Settings.get('defaultReviewSort'), review_type: 'all' };
            const chipRow = document.createElement('div');
            chipRow.style.cssText = `display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;
                position:sticky;top:0;background:${C.bg1};padding-bottom:6px;z-index:1;`;
            const list = document.createElement('div');
            const mkChip = (label, key, val) => {
                const b = document.createElement('button');
                b.className = 'se-tab' + (state[key] === val ? ' active' : '');
                b.textContent = label;
                b.dataset.k = key;
                b.onclick = async () => {
                    if (state[key] === val) return;
                    state[key] = val;
                    chipRow.querySelectorAll(`[data-k="${key}"]`).forEach(x => x.classList.remove('active'));
                    b.classList.add('active');
                    list.innerHTML = `<span class="se-spinner"></span> Loading reviews…`;
                    try {
                        const data = await API.reviews(this.appId, CONFIG.MAX_COMMENTS, state);
                        this._renderReviewList(list, data.reviews || []);
                    } catch {
                        list.innerHTML = `<span style="color:${C.txt3};font-size:12px;">Could not load reviews.</span>`;
                    }
                };
                return b;
            };
            [['👍 Helpful', 'filter', 'helpful'], ['🕒 Recent', 'filter', 'recent']]
                .forEach(([l, k, v]) => chipRow.appendChild(mkChip(l, k, v)));
            const sep = document.createElement('span');
            sep.style.cssText = `width:1px;align-self:stretch;background:${C.border};margin:0 3px;`;
            chipRow.appendChild(sep);
            [['All', 'review_type', 'all'], ['👍 Positive', 'review_type', 'positive'], ['👎 Negative', 'review_type', 'negative']]
                .forEach(([l, k, v]) => chipRow.appendChild(mkChip(l, k, v)));
            panel.appendChild(chipRow);
            panel.appendChild(list);
            // The prefetched `revs` are the 'helpful' set; if the default sort differs, fetch it.
            if (state.filter === 'helpful' && state.review_type === 'all') {
                this._renderReviewList(list, revs);
            } else {
                list.innerHTML = `<span class="se-spinner"></span> Loading reviews…`;
                API.reviews(this.appId, CONFIG.MAX_COMMENTS, state)
                    .then(data => { if (gen === this._gen) this._renderReviewList(list, data.reviews || []); })
                    .catch(() => { if (gen === this._gen) this._renderReviewList(list, revs); });
            }
        }
        _renderReviewList(list, revs) {
            list.innerHTML = '';
            if (!revs.length) {
                list.innerHTML = `<span style="color:${C.txt3};font-size:12px;">No reviews match this filter.</span>`;
                return;
            }
            revs.forEach(rv => list.appendChild(this._buildReviewEl(rv)));
        }
        _buildReviewEl(rv) {
            const col         = rv.voted_up ? C.green : C.red;
            const text        = rv.review || '';
            const escapedText = Utils.escHtml(text);
            const short       = text.length > 180;
            const clip        = short ? Utils.escHtml(text.slice(0, 180)) + '…' : escapedText;
            const helpScore   = rv.votes_up ?? 0;
            let expanded      = false;
            const div = document.createElement('div');
            div.className = 'se-review';
            div.style.borderLeftColor = col;
            const username = Utils.escHtml(rv.author?.personaname ?? 'User');
            div.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <span class="se-avatar-wrap" style="flex-shrink:0;"></span>
                    <div style="flex:1;min-width:0;">
                        <span style="font-weight:700;font-size:13px;">
                            ${username}
                        </span>
                        <span style="margin-left:6px;font-size:11px;padding:2px 7px;border-radius:10px;
                                     color:${col};background:${rv.voted_up ? 'rgba(63,185,80,.18)' : 'rgba(248,81,73,.18)'};">
                            ${rv.voted_up ? '✓ Recommended' : '✗ Not Recommended'}
                        </span>
                    </div>
                    <span style="font-size:11px;color:${C.txt3};flex-shrink:0;">
                        ⏱ ${Utils.formatMins(rv.author?.playtime_forever ?? 0)}
                        · ${Utils.formatDate(rv.timestamp_created)}
                    </span>
                </div>
                <div class="rv-text"
                     style="font-size:12px;line-height:1.6;color:${C.txt2};cursor:${short ? 'pointer' : 'default'};"
                     title="${short ? 'Click to expand' : ''}">
                    ${clip}
                </div>
                <div style="margin-top:7px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <div style="display:flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;
                                border-radius:5px;background:rgba(63,185,80,.12);
                                border:1px solid rgba(63,185,80,.25);color:${C.green};">
                        👍 <strong>${helpScore.toLocaleString()}</strong> found this helpful
                    </div>
                    ${rv.votes_funny > 0 ? `
                    <div style="font-size:11px;padding:3px 8px;border-radius:5px;
                                background:rgba(88,166,255,.1);border:1px solid rgba(88,166,255,.2);color:${C.txt2};">
                        😄 ${rv.votes_funny.toLocaleString()} funny
                    </div>` : ''}
                    <span style="font-size:11px;color:${C.txt3};margin-left:auto;">
                        💬 ${rv.comment_count ?? 0} comments
                    </span>
                </div>
            `;
            const avatarWrap = div.querySelector('.se-avatar-wrap');
            if (rv.author?.avatar) {
                const img = document.createElement('img');
                img.src = rv.author.avatar;
                img.loading = 'lazy';
                img.width = 28;
                img.height = 28;
                img.style.cssText = `border-radius:50%;border:2px solid ${col};`;
                img.addEventListener('error', () => { img.style.display = 'none'; });
                avatarWrap.appendChild(img);
            }
            if (short) {
                const rvText = div.querySelector('.rv-text');
                rvText.tabIndex = 0;
                rvText.setAttribute('role', 'button');
                rvText.setAttribute('aria-expanded', 'false');
                const toggle = () => {
                    expanded = !expanded;
                    rvText.innerHTML = expanded ? escapedText : clip;
                    rvText.title = expanded ? 'Click to collapse' : 'Click to expand';
                    rvText.setAttribute('aria-expanded', String(expanded));
                };
                rvText.onclick = toggle;
                rvText.onkeydown = (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                };
            }
            return div;
        }
        // ── Video lightbox with navigation ──────────────────────────────────
        _showVideoLightbox(index) {
            const trailers = this._trailers || [];
            if (!trailers.length) return;
            let current = index;
            let hlsInstance = null;
            const prevFocus = document.activeElement;
            document.querySelector('.se-lightbox')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'se-lightbox';
            overlay.tabIndex = -1;
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-label', 'Trailer viewer');
            const video = document.createElement('video');
            video.controls = true;
            video.playsInline = true;
            video.style.cssText = `
                max-width:92vw;max-height:90vh;width:auto;height:auto;
                border-radius:6px;background:#000;cursor:default;
                animation:se-in .25s ease;`;
            video.addEventListener('click', (e) => e.stopPropagation());
            const errMsg = document.createElement('div');
            errMsg.style.cssText = `
                display:none;flex-direction:column;align-items:center;gap:10px;
                color:${C.txt3};font-size:13px;`;
            const titleBar = document.createElement('div');
            titleBar.style.cssText = `
                position:absolute;top:16px;left:50%;transform:translateX(-50%);
                font-size:13px;color:${C.txt2};background:rgba(22,27,34,.85);
                padding:4px 14px;border-radius:20px;border:1px solid ${C.border};
                white-space:nowrap;max-width:80vw;overflow:hidden;text-overflow:ellipsis;`;
            const counter = document.createElement('div');
            counter.className = 'se-lb-counter';
            const loadTrailer = (idx) => {
                if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                video.pause();
                video.removeAttribute('src');
                video.load();
                video.style.display = 'block';
                errMsg.style.display = 'none';
                current = idx;
                const t = trailers[current];
                const url = t.url;
                titleBar.textContent = t.name;
                counter.textContent = `${current + 1} / ${trailers.length}`;
                errMsg.innerHTML = `
                    <span>Video failed to load</span>
                    <a href="${Utils.escHtml(url)}" target="_blank" rel="noopener noreferrer"
                       style="padding:5px 14px;background:${C.bg2};color:${C.accent};
                              border:1px solid ${C.accent};border-radius:5px;font-size:12px;
                              text-decoration:none;" onclick="event.stopPropagation();">
                        Open in new tab
                    </a>`;
                const isHls = url.includes('.m3u8');
                if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
                    hlsInstance = new Hls();
                    hlsInstance.loadSource(url);
                    hlsInstance.attachMedia(video);
                    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => video.play());
                    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
                        if (data.fatal) {
                            hlsInstance.destroy(); hlsInstance = null;
                            video.style.display = 'none';
                            errMsg.style.display = 'flex';
                        }
                    });
                } else if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = url;
                    video.play();
                } else {
                    video.src = url;
                    video.play();
                }
            };
            const navigate = (dir) => {
                const next = (current + dir + trailers.length) % trailers.length;
                loadTrailer(next);
            };
            video.addEventListener('error', () => {
                if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                video.style.display = 'none';
                errMsg.style.display = 'flex';
            });
            const closeBtn = document.createElement('button');
            closeBtn.className = 'se-lb-close';
            closeBtn.textContent = '✕';
            const cleanup = () => {
                if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                video.pause();
                video.removeAttribute('src');
                video.load();
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                prevFocus?.focus?.();
            };
            closeBtn.onclick = (e) => { e.stopPropagation(); cleanup(); };
            overlay.onclick = cleanup;
            if (trailers.length > 1) {
                const prevBtn = document.createElement('button');
                prevBtn.className = 'se-lb-btn';
                prevBtn.style.left = '16px';
                prevBtn.textContent = '‹';
                prevBtn.onclick = (e) => { e.stopPropagation(); navigate(-1); };
                const nextBtn = document.createElement('button');
                nextBtn.className = 'se-lb-btn';
                nextBtn.style.right = '16px';
                nextBtn.textContent = '›';
                nextBtn.onclick = (e) => { e.stopPropagation(); navigate(1); };
                overlay.appendChild(prevBtn);
                overlay.appendChild(nextBtn);
            }
            const onKey = (e) => {
                if (e.key === 'Escape') cleanup();
                // Leave arrow keys to the focused <video>: they seek there natively.
                const arrowsFree = e.target !== video;
                if (arrowsFree && trailers.length > 1 && e.key === 'ArrowLeft')  navigate(-1);
                if (arrowsFree && trailers.length > 1 && e.key === 'ArrowRight') navigate(1);
                if (e.key === 'Tab') {
                    const f = overlay.querySelectorAll('button, a[href], video');
                    if (f.length) {
                        const first = f[0], last = f[f.length - 1];
                        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                    }
                }
            };
            document.addEventListener('keydown', onKey);
            overlay.appendChild(video);
            overlay.appendChild(errMsg);
            overlay.appendChild(titleBar);
            overlay.appendChild(closeBtn);
            overlay.appendChild(counter);
            overlay.querySelector('.se-lb-close')?.setAttribute('aria-label', 'Close');
            overlay.querySelectorAll('.se-lb-btn').forEach((b, i) => b.setAttribute('aria-label', i === 0 ? 'Previous trailer' : 'Next trailer'));
            document.body.appendChild(overlay);
            closeBtn.focus();
            loadTrailer(current);
        }
        // ── Screenshot lightbox ─────────────────────────────────────────────
        _showLightbox(index) {
            const urls = this._screenshotUrls;
            if (!urls.length) return;
            let current = index;
            let navigating = false;
            const prevFocus = document.activeElement;
            document.querySelector('.se-lightbox')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'se-lightbox';
            overlay.tabIndex = -1;
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-label', 'Screenshot viewer');
            const spinner = document.createElement('div');
            spinner.className = 'se-spinner';
            spinner.style.cssText = 'width:28px;height:28px;position:absolute;';
            const img = document.createElement('img');
            img.style.transition = 'opacity .15s ease';
            img.style.opacity = '0';
            img.alt = `Screenshot ${current + 1}`;
            const preload = (idx) => {
                const u = urls[((idx % urls.length) + urls.length) % urls.length];
                if (!u) return;
                const p = new Image();
                p.src = u;
            };
            const loadImage = (url) => {
                img.style.opacity = '0';
                spinner.style.display = 'inline-block';
                img.src = url;
                if (urls.length > 1) { preload(current + 1); preload(current - 1); }
            };
            img.addEventListener('load', () => {
                spinner.style.display = 'none';
                img.style.opacity = '1';
                navigating = false;
            });
            img.addEventListener('error', () => {
                spinner.style.display = 'none';
                img.style.opacity = '1';
                navigating = false;
            });
            loadImage(urls[current]);
            const counter = document.createElement('div');
            counter.className = 'se-lb-counter';
            const updateCounter = () => { counter.textContent = `${current + 1} / ${urls.length}`; };
            updateCounter();
            const navigate = (dir) => {
                if (navigating) return;
                navigating = true;
                current = (current + dir + urls.length) % urls.length;
                img.alt = `Screenshot ${current + 1}`;
                loadImage(urls[current]);
                updateCounter();
            };
            const cleanup = () => {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                prevFocus?.focus?.();
            };
            const onKey = (e) => {
                if (e.key === 'Escape')     cleanup();
                if (e.key === 'ArrowLeft')  navigate(-1);
                if (e.key === 'ArrowRight') navigate(1);
                if (e.key === 'Tab') {
                    const f = overlay.querySelectorAll('button, a[href]');
                    if (f.length) {
                        const first = f[0], last = f[f.length - 1];
                        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                    }
                }
            };
            const closeBtn = document.createElement('button');
            closeBtn.className = 'se-lb-close';
            closeBtn.textContent = '✕';
            closeBtn.onclick = (e) => { e.stopPropagation(); cleanup(); };
            if (urls.length > 1) {
                const prevBtn = document.createElement('button');
                prevBtn.className = 'se-lb-btn';
                prevBtn.style.left = '16px';
                prevBtn.textContent = '‹';
                prevBtn.onclick = (e) => { e.stopPropagation(); navigate(-1); };
                const nextBtn = document.createElement('button');
                nextBtn.className = 'se-lb-btn';
                nextBtn.style.right = '16px';
                nextBtn.textContent = '›';
                nextBtn.onclick = (e) => { e.stopPropagation(); navigate(1); };
                overlay.appendChild(prevBtn);
                overlay.appendChild(nextBtn);
            }
            img.onclick = (e) => e.stopPropagation();
            overlay.onclick = cleanup;
            overlay.appendChild(spinner);
            overlay.appendChild(img);
            overlay.appendChild(closeBtn);
            overlay.appendChild(counter);
            overlay.querySelector('.se-lb-close')?.setAttribute('aria-label', 'Close');
            overlay.querySelectorAll('.se-lb-btn').forEach((b, i) => b.setAttribute('aria-label', i === 0 ? 'Previous screenshot' : 'Next screenshot'));
            document.body.appendChild(overlay);
            document.addEventListener('keydown', onKey);
            closeBtn.focus();
        }
        // ── Helpers ──────────────────────────────────────────────────────────
        _panel(id, visible) {
            const p = document.createElement('div');
            p.id = id;
            p.className = 'se-panel';
            p.style.display = visible ? 'block' : 'none';
            p.style.opacity = visible ? '1' : '0';
            return p;
        }
        _authWall() {
            this._setBody(`
                <div style="padding:10px 12px;background:rgba(210,153,34,.1);
                            border-radius:8px;border-left:3px solid ${C.yellow};">
                    <div style="font-weight:700;color:${C.yellow};margin-bottom:5px;">🔒 Login Required</div>
                    <p style="margin:0 0 10px;font-size:12px;color:${C.txt2};">
                        Please login to CS.RIN.RU to access Steam data.
                    </p>
                    <button id="se-auth"
                        style="padding:4px 12px;background:${C.accent};color:#000;border:none;
                               border-radius:5px;cursor:pointer;font-weight:700;font-size:12px;margin-right:6px;">
                        Open CS.RIN.RU
                    </button>
                    <button id="se-reload"
                        style="padding:4px 12px;background:${C.bg2};color:${C.txt};
                               border:1px solid ${C.border};border-radius:5px;cursor:pointer;font-size:12px;">
                        Reload
                    </button>
                </div>
            `);
            this.body.querySelector('#se-auth')?.addEventListener('click',
                () => GM_openInTab(this.link.href, { active: true }));
            this.body.querySelector('#se-reload')?.addEventListener('click',
                () => location.reload());
        }
        _applyManual(value) {
            const id = Resolver.appIdFromManualValue(value);
            if (!id) {
                alert('Not a valid Steam URL or app ID.\nPaste e.g. https://store.steampowered.com/app/12345/… or just the numeric ID.');
                return;
            }
            this._applyAppId(id);
        }
        _applyAppId(id) {
            Utils.setCache(this.path, { steamUrl: `https://store.steampowered.com/app/${id}/`, manual: true });
            this._reviews = null;
            this._cachedRating    = null;
            this._cachedReviews   = null;
            this._cachedDetails   = null;
            this._ratingForCache  = null;
            this._reviewsForCache = null;
            this._detailsForCache = null;
            this._screenshotUrls = [];
            this._setBadge('', '');
            this._setBody(`<span class="se-spinner"></span> Loading Steam data…`);
            this._load();
        }
        // ── Wrong-game recovery: inline candidate picker ────────────────────
        async _showPicker() {
            const gen = ++this._gen; // cancels in-flight loads so they can't stomp the picker
            this._setBody(`<span class="se-spinner"></span> Searching Steam…`);
            let items = [];
            try { items = await this._searchCandidates(Resolver.titleFromPath(this.path)); }
            catch { /* no results — manual entry below still works */ }
            if (gen !== this._gen) return;
            this._setBody('');
            const box = document.createElement('div');
            box.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
            const head = document.createElement('div');
            head.style.cssText = `font-weight:700;font-size:13px;color:${C.txt};`;
            head.textContent = items.length ? 'Which game is this?' : 'No Steam matches found.';
            box.appendChild(head);
            items.slice(0, CONFIG.MAX_PICKER).forEach(it => {
                const row = document.createElement('button');
                row.style.cssText = `display:flex;align-items:center;gap:10px;padding:6px 8px;width:100%;
                    background:${C.bg0};border:1px solid ${C.border};border-radius:6px;
                    cursor:pointer;text-align:left;color:${C.txt};font-size:12px;`;
                if (it.tiny_image) {
                    const img = document.createElement('img');
                    img.src = Utils.forceHttps(it.tiny_image);
                    img.alt = '';
                    img.loading = 'lazy';
                    img.style.cssText = 'width:60px;height:23px;object-fit:cover;border-radius:3px;flex-shrink:0;';
                    img.addEventListener('error', () => { img.style.display = 'none'; });
                    row.appendChild(img);
                }
                const name = document.createElement('span');
                name.textContent = it.name;
                name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                const idTag = document.createElement('span');
                idTag.textContent = `#${it.id}`;
                idTag.style.cssText = `color:${C.txt3};font-size:11px;flex-shrink:0;`;
                row.appendChild(name);
                row.appendChild(idTag);
                row.onclick = () => this._applyAppId(String(it.id));
                box.appendChild(row);
            });
            const foot = document.createElement('div');
            foot.style.cssText = 'display:flex;gap:6px;margin-top:4px;';
            const paste = document.createElement('button');
            paste.className = 'se-tab';
            paste.textContent = '⌨ Paste URL / app ID…';
            paste.onclick = () => {
                const v = prompt('Paste the correct Steam store URL or appID:');
                if (v) this._applyManual(v);
            };
            const cancel = document.createElement('button');
            cancel.className = 'se-tab';
            cancel.textContent = 'Cancel';
            cancel.onclick = () => this._load();
            foot.appendChild(paste);
            foot.appendChild(cancel);
            box.appendChild(foot);
            this.body.appendChild(box);
        }
        // ── Recently viewed (from cache, zero network) ──────────────────────
        _renderRecent() {
            if (!Settings.get('showRecent')) return;
            const slot = this.body.querySelector('#se-recent');
            if (!slot) return;
            const rows = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || !k.startsWith(CONFIG.CACHE_PREFIX)) continue;
                const rest = k.slice(CONFIG.CACHE_PREFIX.length);
                const sep = rest.indexOf(':');
                if (sep === -1) continue;
                const path = rest.slice(sep + 1);
                if (!path.startsWith('/') || path === this.path) continue;
                try {
                    // Tolerant of entries written by older versions: read only name/rating.
                    const d = JSON.parse(localStorage.getItem(k));
                    const name = d?.data?.detailsData?.name;
                    if (!name) continue;
                    rows.push({ path, name, ts: d.ts || '', desc: d.data.ratingData?.review_score_desc || '' });
                } catch { /* unreadable entry — skip */ }
            }
            if (!rows.length) return;
            rows.sort((a, b) => b.ts.localeCompare(a.ts));
            const det = document.createElement('details');
            det.style.cssText = `margin-top:12px;border-top:1px solid ${C.border};padding-top:8px;`;
            const sum = document.createElement('summary');
            sum.textContent = `🕘 Recently viewed (${Math.min(rows.length, CONFIG.MAX_RECENT)})`;
            sum.style.cssText = `cursor:pointer;font-size:12px;font-weight:600;color:${C.txt2};`;
            det.appendChild(sum);
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:8px;';
            rows.slice(0, CONFIG.MAX_RECENT).forEach(r => {
                const line = document.createElement('div');
                line.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;';
                const a = document.createElement('a');
                a.href = r.path;
                a.textContent = r.name;
                a.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                const stars = document.createElement('span');
                stars.textContent = r.desc ? Utils.ratingStars(r.desc) : '';
                stars.title = r.desc;
                stars.style.cssText = 'color:#ffd700;flex-shrink:0;letter-spacing:1px;font-size:11px;';
                line.appendChild(a);
                line.appendChild(stars);
                list.appendChild(line);
            });
            det.appendChild(list);
            slot.replaceChildren(det);
        }
        _refresh() {
            Utils.clearCache(this.path);
            this._reviews = null;
            this._cachedRating    = null;
            this._cachedReviews   = null;
            this._cachedDetails   = null;
            this._ratingForCache  = null;
            this._reviewsForCache = null;
            this._detailsForCache = null;
            this._screenshotUrls = [];
            this._setBadge('', '');
            this._setBody(`<span class="se-spinner"></span> Refreshing…`);
            this._load();
        }
    }
    // ==================== PURGE MENU ====================
    GM_registerMenuCommand('🗑️ Purge Steam Enhancer Cache', () => {
        let count = 0;
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(CONFIG.CACHE_PREFIX)) keysToRemove.push(k);
        }
        keysToRemove.forEach(k => { localStorage.removeItem(k); count++; });
        const msg = count > 0
            ? `Purged ${count} cached entries. Reload the page to fetch fresh data.`
            : 'Cache is already empty.';
        if (typeof GM_notification === 'function') {
            GM_notification({ text: msg, title: 'Steam Enhancer', timeout: 3000 });
        } else {
            alert(msg);
        }
    });
    // ==================== BOOT ====================
    const isSinglePost = document.body.classList.contains('single')
                      || (!Resolver.isListPath(location.pathname, location.search)
                          && document.querySelectorAll('article.post').length === 1);
    let activeCard = null;
    if (isSinglePost) {
        activeCard = new SteamCard();
        activeCard.init();
    }
    // ── Auto-theme: re-detect when the host page changes its body class.
    //    Coalesce bursts of mutations into one check per animation frame to
    //    avoid running detectTheme() on every class toggle.
    let themeRaf = 0;
    new MutationObserver(() => {
        if (themeRaf) return;
        themeRaf = requestAnimationFrame(() => {
            themeRaf = 0;
            if (!activeCard || getThemePref() !== 'auto') return;
            const next = detectTheme();
            const cur  = (C === LIGHT) ? 'light' : 'dark';
            if (next !== cur) activeCard._applyTheme();
        });
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
