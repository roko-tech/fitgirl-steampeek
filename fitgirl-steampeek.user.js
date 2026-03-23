// ==UserScript==
// @name         FitGirl SteamPeek
// @namespace    https://github.com/roko-tech/fitgirl-steampeek
// @version      1.1
// @description  Peek at Steam ratings, trailers, screenshots, and reviews directly on FitGirl pages
// @author       roko-tech
// @license      MIT
// @homepage     https://github.com/roko-tech/fitgirl-steampeek
// @supportURL   https://github.com/roko-tech/fitgirl-steampeek/issues
// @icon         https://store.steampowered.com/favicon.ico
// @match        https://fitgirl-repacks.site/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      ru.riotpixels.com
// @connect      store.steampowered.com
// @connect      cs.rin.ru
// @require      https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js
// @run-at       document-end
// ==/UserScript==
(function () {
    'use strict';
    const CONFIG = {
        VERSION: '1.1',
        CACHE_PREFIX: 'se8:',
        CACHE_EXPIRY_DAYS: 7,
        MAX_COMMENTS: 15,
        MAX_SCREENSHOTS: 9,
        MAX_GENRES: 4,
        MAX_CACHE_ENTRIES: 50,
        OBSERVER_TIMEOUT: 15000
    };
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
    function detectTheme() {
        // Check the content area background, not body (FitGirl has dark body but light content)
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
    const C = detectTheme() === 'light' ? LIGHT : DARK;
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
            const raw = JSON.stringify({ data, ts: new Date().toISOString() });
            try {
                localStorage.setItem(this.cKey(key), raw);
            } catch (e) {
                if (e.name === 'QuotaExceededError' || e.code === 22) {
                    this._evictOldest();
                    try { localStorage.setItem(this.cKey(key), raw); } catch {}
                }
            }
            this._enforceMaxEntries();
        },
        clearCache(key) { localStorage.removeItem(this.cKey(key)); },
        _evictOldest() {
            const entries = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k.startsWith(CONFIG.CACHE_PREFIX)) continue;
                try {
                    const d = JSON.parse(localStorage.getItem(k));
                    entries.push({ key: k, ts: d.ts || '' });
                } catch { entries.push({ key: k, ts: '' }); }
            }
            entries.sort((a, b) => a.ts.localeCompare(b.ts));
            const toRemove = Math.min(5, entries.length);
            for (let i = 0; i < toRemove; i++) localStorage.removeItem(entries[i].key);
        },
        _enforceMaxEntries() {
            const entries = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k.startsWith(CONFIG.CACHE_PREFIX)) {
                    try {
                        const d = JSON.parse(localStorage.getItem(k));
                        entries.push({ key: k, ts: d.ts || '' });
                    } catch { entries.push({ key: k, ts: '' }); }
                }
            }
            if (entries.length <= CONFIG.MAX_CACHE_ENTRIES) return;
            entries.sort((a, b) => a.ts.localeCompare(b.ts));
            const excess = entries.length - CONFIG.MAX_CACHE_ENTRIES;
            for (let i = 0; i < excess; i++) localStorage.removeItem(entries[i].key);
        },
        forceHttps(url) {
            return url ? url.replace(/^http:\/\//i, 'https://') : url;
        },
        escHtml(s) {
            if (!s) return '';
            const d = document.createElement('div');
            d.textContent = s;
            return d.innerHTML;
        },
        formatMins(m) {
            if (m < 60) return `${m}m`;
            const h = Math.floor(m / 60);
            return h < 1000 ? `${h}h` : `${(h / 1000).toFixed(1)}k h`;
        },
        formatDate(ts) {
            if (!ts) return 'Unknown';
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
            if (score >= 75) return C.green;
            if (score >= 50) return C.yellow;
            return C.red;
        },
        extractTitle() {
            const h1 = document.querySelector('h1.entry-title, h1');
            return (h1?.textContent || document.title || '')
                .replace(/–\s*fitgirl\s*repacks?/i, '')
                .replace(/\[.*?\]/g, '')
                .replace(/\(.*?\)/g, '')
                .replace(/v[\d.]+.*/i, '')
                .replace(/\+\s*(all|[\d]+)\s*(dlcs?|updates?|extras?).*/i, '')
                .replace(/repack\s*by.*/i, '')
                .trim();
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
                method: 'GET', url, anonymous: false, cookies: true,
                headers: { 'Referer': 'https://cs.rin.ru/', 'User-Agent': navigator.userAgent }
            });
        },
        async riotpixels(url) {
            return this.req({
                method: 'GET', url,
                headers: { 'Referer': 'https://fitgirl-repacks.site/' }
            });
        },
        async appDetails(id) {
            const r = await this.req({ method: 'GET', url: `https://store.steampowered.com/api/appdetails?appids=${id}&l=en` });
            return JSON.parse(r.responseText);
        },
        async reviews(id, n = CONFIG.MAX_COMMENTS) {
            const r = await this.req({ method: 'GET', url: `https://store.steampowered.com/appreviews/${id}?json=1&language=english&filter=helpful&purchase_type=all&num_per_page=${n}` });
            return JSON.parse(r.responseText);
        },
        async steamSearch(title) {
            const r = await this.req({ method: 'GET', url: `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=en&cc=US` });
            return JSON.parse(r.responseText);
        }
    };
    // ==================== STYLES ====================
    document.head.appendChild(Object.assign(document.createElement('style'), {
        textContent: `
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
            .se-panel {
                transition: opacity .2s ease;
            }
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
                position: fixed;
                inset: 0;
                z-index: 99999;
                background: rgba(0,0,0,.92);
                display: flex;
                align-items: center;
                justify-content: center;
                animation: se-in .2s ease;
                cursor: pointer;
            }
            .se-lightbox img {
                max-width: 92vw;
                max-height: 90vh;
                object-fit: contain;
                border-radius: 6px;
                cursor: default;
                animation: se-in .25s ease;
            }
            .se-lb-btn {
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
                background: rgba(22,27,34,.85);
                color: ${C.txt};
                border: 1px solid ${C.border};
                border-radius: 50%;
                width: 40px;
                height: 40px;
                font-size: 20px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: .2s;
            }
            .se-lb-btn:hover { background: ${C.bg2}; border-color: ${C.accent}; color: ${C.accent}; }
            .se-lb-close {
                position: absolute;
                top: 16px;
                right: 20px;
                background: rgba(22,27,34,.85);
                color: ${C.txt};
                border: 1px solid ${C.border};
                border-radius: 50%;
                width: 36px;
                height: 36px;
                font-size: 18px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: .2s;
            }
            .se-lb-close:hover { background: ${C.bg2}; border-color: ${C.red}; color: ${C.red}; }
            .se-lb-counter {
                position: absolute;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 13px;
                color: ${C.txt2};
                background: rgba(22,27,34,.85);
                padding: 4px 14px;
                border-radius: 20px;
                border: 1px solid ${C.border};
            }
            #se-card::-webkit-scrollbar       { width: 4px; }
            #se-card::-webkit-scrollbar-thumb { background: ${C.accent}; border-radius: 2px; }
        `
    }));
    // ==================== MAIN CLASS ====================
    class SteamCard {
        constructor() {
            this.path       = location.pathname;
            this.link       = null;
            this.riotLink   = null;
            this.appId      = null;
            this._reviews   = null;
            this._collapsed = false;
            this._reviewsReady = null;
            this._reviewsResolve = null;
            this._screenshotUrls = [];
        }
        init() {
            this._waitForLinks(({ csrin, riotpixels }) => {
                this.link     = csrin;
                this.riotLink = riotpixels || null;
                this._build();
                this._load();
            });
        }
        // ── DOM watcher ─────────────────────────────────────────────────────
        _waitForLinks(cb) {
            const find = () => {
                const csrin = [...document.querySelectorAll('a[href*="cs.rin.ru"]')]
                    .find(a => /discussion|cs\.rin\.ru/i.test(a.textContent));
                const riotpixels = document.querySelector('a[href*="riotpixels.com"]');
                return csrin ? { csrin, riotpixels } : null;
            };
            const result = find();
            if (result) { cb(result); return; }
            const tid = setTimeout(() => {
                obs.disconnect();
                console.warn('[SE] Timed out waiting for CS.RIN.RU link');
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
                    <button id="se-toggle"  title="Collapse"
                        style="background:none;border:none;color:${C.txt2};cursor:pointer;font-size:15px;padding:2px 7px;border-radius:4px;line-height:1;">▾</button>
                    <button id="se-refresh" title="Refresh"
                        style="background:none;border:none;color:${C.txt2};cursor:pointer;font-size:15px;padding:2px 7px;border-radius:4px;line-height:1;">⟳</button>
                </div>
            `;
            const body = document.createElement('div');
            body.id = 'se-body';
            body.style.cssText = 'padding:12px 14px;';
            card.appendChild(hdr);
            card.appendChild(body);
            hdr.querySelector('#se-toggle').onclick = () => {
                this._collapsed = !this._collapsed;
                body.style.display = this._collapsed ? 'none' : 'block';
                hdr.querySelector('#se-toggle').textContent = this._collapsed ? '▸' : '▾';
            };
            hdr.querySelector('#se-refresh').onclick = () => this._refresh();
            this.card = card;
            this.body = body;
            this.link.parentNode.insertBefore(card, this.link.nextSibling);
            this._setBody(`<span class="se-spinner"></span> Loading Steam data…`);
        }
        _setBody(html) { this.body.innerHTML = html; }
        _setBadge(label, color) {
            const b = this.card?.querySelector('#se-badge');
            if (!b || !label) { if (b) b.textContent = ''; return; }
            b.textContent = label;
            b.style.cssText = `
                background: ${color}22; color: ${color};
                border: 1px solid ${color}55;
                font-size: 10px; padding: 1px 6px;
                border-radius: 4px; font-weight: 600;
                vertical-align: middle; margin-left: 6px;
            `;
        }
        // ── Loading skeleton ────────────────────────────────────────────────
        _skeleton() {
            return `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
                    <div class="se-skeleton" style="width:120px;height:32px;"></div>
                    <div class="se-skeleton" style="width:240px;height:16px;"></div>
                </div>
                <div class="se-skeleton" style="height:4px;margin-bottom:12px;"></div>
                <div class="se-skeleton" style="height:36px;margin-bottom:12px;border-radius:8px;"></div>
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
            `;
        }
        // ── Load orchestrator ───────────────────────────────────────────────
        async _load() {
            try {
                const cached = Utils.getCache(this.path);
                if (cached?.steamUrl) {
                    this._setBadge('cached', C.txt3);
                    if (cached.ratingData) this._cachedRating = cached.ratingData;
                    if (cached.reviewsData) this._cachedReviews = cached.reviewsData;
                    await this._display(cached.steamUrl);
                    return;
                }
                const { url, tier } = await this._fetchUrl();
                if (!url) return;
                Utils.setCache(this.path, { steamUrl: url });
                const badgeMap = {
                    riotpixels: [C.green,  'riotpixels'],
                    steam:      [C.accent, 'search'],
                    csrin:      [C.yellow, 'cs.rin']
                };
                const [col, label] = badgeMap[tier] || [C.txt3, tier];
                this._setBadge(label, col);
                await this._display(url);
            } catch (e) {
                console.error('[SE]', e);
                this._setBody(`
                    <div style="color:${C.red};font-size:13px;margin-bottom:8px;">⚠ ${Utils.escHtml(e.message)}</div>
                    <button id="se-retry"
                        style="padding:4px 12px;background:${C.bg2};color:${C.txt};
                               border:1px solid ${C.border};border-radius:5px;cursor:pointer;font-size:12px;">
                        Retry
                    </button>
                `);
                this.body.querySelector('#se-retry')?.addEventListener('click', () => this._refresh());
            }
        }
        // ── 3-Tier URL resolution ────────────────────────────────────────────
        async _fetchUrl() {
            if (this.riotLink?.href) {
                try {
                    const url = await this._fromRiotPixels(this.riotLink.href);
                    if (url) return { url, tier: 'riotpixels' };
                } catch (e) {
                    console.warn('[SE] RiotPixels failed:', e.message);
                }
            }
            try {
                const title = Utils.extractTitle();
                if (title) {
                    const url = await this._fromSteamSearch(title);
                    if (url) return { url, tier: 'steam' };
                }
            } catch (e) {
                console.warn('[SE] Steam search failed:', e.message);
            }
            const r = await API.csrin(this.link.href);
            if (r.status === 401 || r.status === 403) { this._authWall(); return {}; }
            const m = r.responseText.match(/https?:\/\/store\.steampowered\.com\/app\/\d+[^\s"']*/i);
            if (!m) throw new Error('Steam URL not found on CS.RIN.RU');
            return { url: m[0], tier: 'csrin' };
        }
        async _fromRiotPixels(riotUrl) {
            const r = await API.riotpixels(riotUrl);
            const m = r.responseText.match(
                /href="(https?:\/\/store\.steampowered\.com\/app\/(\d+)[^"]*)"/i
            );
            if (!m) throw new Error('Steam link not found on RiotPixels');
            return `https://store.steampowered.com/app/${m[2]}/`;
        }
        async _fromSteamSearch(title) {
            const json = await API.steamSearch(title);
            if (!json.items?.length) return null;
            const norm  = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
            const exact = json.items.find(i => norm(i.name) === norm(title));
            const best  = exact || json.items[0];
            return `https://store.steampowered.com/app/${best.id}/`;
        }
        // ── Display ─────────────────────────────────────────────────────────
        async _display(steamUrl) {
            const idMatch = steamUrl.match(/app\/(\d+)/);
            if (!idMatch) return;
            this.appId = idMatch[1];
            this._setBody(`
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                    <a href="${Utils.escHtml(steamUrl)}" target="_blank" rel="noopener noreferrer"
                       style="display:inline-flex;align-items:center;gap:6px;padding:5px 14px;
                              background:linear-gradient(135deg,${C.accentDark},${C === LIGHT ? '#b6d4f0' : '#2a475e'});
                              color:${C === LIGHT ? C.accent : 'white'};text-decoration:none;border-radius:6px;
                              font-weight:700;font-size:13px;border:1px solid ${C.accent};">
                        <svg width="13" height="13" viewBox="0 0 24 24">
                            <path fill="${C === LIGHT ? C.accent : 'white'}" d="M12,2C6.48,2,2,6.48,2,12s4.48,10,10,10s10-4.48,10-10S17.52,2,12,2z"/>
                        </svg>
                        Steam Store
                    </a>
                    <span id="se-rating-inline" style="font-size:12px;color:${C.txt2};display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <span class="se-skeleton" style="width:180px;height:14px;display:inline-block;"></span>
                    </span>
                </div>
                <div id="se-rating-bar" style="margin-bottom:12px;">
                    <div class="se-skeleton" style="height:4px;"></div>
                </div>
                <div id="se-info-bar"></div>
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
            `);
            this._reviewsReady = new Promise(resolve => { this._reviewsResolve = resolve; });
            await Promise.allSettled([
                this._loadRatingAndReviews(this.appId),
                this._loadMedia(this.appId)
            ]);
        }
        // ── Rating + Reviews ────────────────────────────────────────────────
        async _loadRatingAndReviews(id) {
            try {
                if (this._cachedRating && this._cachedReviews) {
                    this._reviews = this._cachedReviews;
                    this._renderRating(this._cachedRating);
                    this._reviewsResolve?.();
                    this._cachedRating = null;
                    this._cachedReviews = null;
                    return;
                }
                const data = await API.reviews(id, CONFIG.MAX_COMMENTS);
                this._reviews = data.reviews || [];
                const qs = data.query_summary;
                if (qs) {
                    this._renderRating(qs);
                    const cached = Utils.getCache(this.path);
                    if (cached) {
                        cached.ratingData = qs;
                        cached.reviewsData = this._reviews;
                        Utils.setCache(this.path, cached);
                    }
                }
            } catch (e) {
                console.error('[SE] rating error:', e);
                const ratingEl = this.body.querySelector('#se-rating-inline');
                if (ratingEl) {
                    ratingEl.innerHTML = `<span style="color:${C.txt3};font-size:12px;">Rating unavailable</span>`;
                }
            } finally {
                this._reviewsResolve?.();
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
            badge.href = mc.url || '#';
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
        // ── Media panels ─────────────────────────────────────────────────────
        async _loadMedia(id) {
            try {
                const det  = await API.appDetails(id);
                const d    = det[id]?.data;
                const wrap = this.body.querySelector('#se-media-wrap');
                if (!d || !wrap) return;
                // Render info bar and Metacritic from appDetails
                this._renderInfoBar(d);
                this._renderMetacritic(d.metacritic);
                const movies = d.movies || [];
                const shots  = (d.screenshots || []).slice(0, CONFIG.MAX_SCREENSHOTS);
                this._screenshotUrls = shots.map(s => s.path_full);
                await this._reviewsReady;
                const revs = this._reviews || [];
                const tabs = [
                    movies.length && { id: 'se-trailers',    label: `🎬 Trailers (${movies.length})` },
                    shots.length  && { id: 'se-screenshots', label: `📸 Screenshots (${shots.length})` },
                    revs.length   && { id: 'se-reviews',     label: `💬 Most Helpful (${revs.length})` }
                ].filter(Boolean);
                if (!tabs.length) {
                    wrap.innerHTML = `<span style="color:${C.txt3};font-size:12px;">No media available.</span>`;
                    return;
                }
                wrap.innerHTML = '';
                // Tab bar
                const tabBar = document.createElement('div');
                tabBar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;';
                let activePanel = null;
                tabs.forEach((t, i) => {
                    const btn = document.createElement('button');
                    btn.className = 'se-tab' + (i === 0 ? ' active' : '');
                    btn.textContent = t.label;
                    btn.onclick = () => {
                        tabBar.querySelectorAll('.se-tab').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        // Smooth transition: fade out current, fade in new
                        const panels = wrap.querySelectorAll('.se-panel');
                        const target = wrap.querySelector('#' + t.id);
                        if (activePanel && activePanel !== target) {
                            activePanel.style.opacity = '0';
                            const prev = activePanel;
                            setTimeout(() => {
                                prev.style.display = 'none';
                                target.style.display = 'block';
                                requestAnimationFrame(() => {
                                    target.style.opacity = '1';
                                });
                            }, 200);
                        } else {
                            panels.forEach(p => { p.style.display = 'none'; p.style.opacity = '0'; });
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
                    // Build trailer list for lightbox navigation
                    this._trailers = movies.map((m, i) => ({
                        url: Utils.forceHttps(m.hls_h264 || m.dash_h264 || m.webm?.max || m.mp4?.max || m.webm?.['480'] || m.mp4?.['480'] || ''),
                        name: m.name || `Trailer ${i + 1}`
                    })).filter(t => t.url);
                    const panel = this._panel('se-trailers', true);
                    activePanel = panel;
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
                            // Find this trailer's index in the filtered list
                            const idx = this._trailers.findIndex(t => t.name === (m.name || `Trailer ${i + 1}`));
                            this._showVideoLightbox(idx >= 0 ? idx : 0);
                        });
                        grid.appendChild(card);
                    });
                    panel.appendChild(grid);
                    wrap.appendChild(panel);
                }
                // ── Screenshots ──
                if (shots.length) {
                    const panel = this._panel('se-screenshots', !movies.length);
                    if (!movies.length) activePanel = panel;
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
                    const panel = this._panel('se-reviews', !movies.length && !shots.length);
                    if (!movies.length && !shots.length) activePanel = panel;
                    panel.style.maxHeight   = '400px';
                    panel.style.overflowY   = 'auto';
                    panel.style.paddingRight = '4px';
                    revs.forEach(rv => {
                        const col        = rv.voted_up ? C.green : C.red;
                        const text       = rv.review || '';
                        const escapedText = Utils.escHtml(text);
                        const short      = text.length > 180;
                        const clip       = short ? Utils.escHtml(text.slice(0, 180)) + '…' : escapedText;
                        const helpScore  = rv.votes_up ?? 0;
                        let expanded     = false;
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
                            rvText.onclick = () => {
                                expanded = !expanded;
                                rvText.innerHTML = expanded ? escapedText : clip;
                                rvText.title = expanded ? 'Click to collapse' : 'Click to expand';
                            };
                        }
                        panel.appendChild(div);
                    });
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
        // ── Video lightbox with navigation ──────────────────────────────────
        _showVideoLightbox(index) {
            const trailers = this._trailers || [];
            if (!trailers.length) return;
            let current = index;
            let hlsInstance = null;
            document.querySelector('.se-lightbox')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'se-lightbox';
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
            // Load a trailer by index
            const loadTrailer = (idx) => {
                // Cleanup previous
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
            // Close
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
            };
            closeBtn.onclick = (e) => { e.stopPropagation(); cleanup(); };
            overlay.onclick = cleanup;
            // Arrow buttons (only if multiple trailers)
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
                if (trailers.length > 1 && e.key === 'ArrowLeft')  navigate(-1);
                if (trailers.length > 1 && e.key === 'ArrowRight') navigate(1);
            };
            document.addEventListener('keydown', onKey);
            overlay.appendChild(video);
            overlay.appendChild(errMsg);
            overlay.appendChild(titleBar);
            overlay.appendChild(closeBtn);
            overlay.appendChild(counter);
            document.body.appendChild(overlay);
            // Load the initial trailer
            loadTrailer(current);
        }
        // ── Screenshot lightbox ─────────────────────────────────────────────
        _showLightbox(index) {
            const urls = this._screenshotUrls;
            if (!urls.length) return;
            let current = index;
            let navigating = false;
            // Remove existing lightbox
            document.querySelector('.se-lightbox')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'se-lightbox';
            // Spinner shown while image loads
            const spinner = document.createElement('div');
            spinner.className = 'se-spinner';
            spinner.style.cssText = 'width:28px;height:28px;position:absolute;';
            const img = document.createElement('img');
            img.style.transition = 'opacity .15s ease';
            img.style.opacity = '0';
            img.alt = `Screenshot ${current + 1}`;
            // Show image only after it loads
            const loadImage = (url) => {
                img.style.opacity = '0';
                spinner.style.display = 'inline-block';
                img.src = url;
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
            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'se-lb-close';
            closeBtn.textContent = '✕';
            closeBtn.onclick = (e) => { e.stopPropagation(); overlay.remove(); };
            // Arrow buttons
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
            overlay.onclick = () => overlay.remove();
            overlay.appendChild(spinner);
            overlay.appendChild(img);
            overlay.appendChild(closeBtn);
            overlay.appendChild(counter);
            document.body.appendChild(overlay);
            // Keyboard navigation
            const onKey = (e) => {
                if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
                if (e.key === 'ArrowLeft')  navigate(-1);
                if (e.key === 'ArrowRight') navigate(1);
            };
            document.addEventListener('keydown', onKey);
            // Cleanup listener when overlay is removed
            const obs = new MutationObserver(() => {
                if (!document.body.contains(overlay)) {
                    document.removeEventListener('keydown', onKey);
                    obs.disconnect();
                }
            });
            obs.observe(document.body, { childList: true });
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
        _refresh() {
            Utils.clearCache(this.path);
            this._reviews = null;
            this._cachedRating = null;
            this._cachedReviews = null;
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
    // Only run on single post pages, not listing/archive/home pages
    if (document.body.classList.contains('single') ||
        document.querySelector('article.post') && document.querySelectorAll('article.post').length === 1) {
        new SteamCard().init();
    }
})();
