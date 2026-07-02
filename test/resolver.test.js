'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Resolver } = require('../fitgirl-steampeek.user.js');

// ── titleFromPath ────────────────────────────────────────────────────────
test('titleFromPath: slug becomes a spaced title', () => {
    assert.equal(Resolver.titleFromPath('/hades-ii-v1-0/'), 'hades ii v1 0');
});
test('titleFromPath: decodes percent-encoding', () => {
    assert.equal(Resolver.titleFromPath('/caf%C3%A9-game/'), 'café game');
});
test('titleFromPath: malformed encoding keeps the encoded form', () => {
    assert.equal(Resolver.titleFromPath('/bad-%zz-slug/'), 'bad %zz slug');
});
test('titleFromPath: root path yields empty title', () => {
    assert.equal(Resolver.titleFromPath('/'), '');
});

// ── appIdFromHtml (tier-0) ───────────────────────────────────────────────
test('appIdFromHtml: game header asset', () => {
    const html = '<img src="https://cdn.akamai.steamstatic.com/steam/apps/1145360/header.jpg">';
    assert.equal(Resolver.appIdFromHtml(html), '1145360');
});
test('appIdFromHtml: screenshot asset under store_item_assets', () => {
    const html = '<img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/ss_abc123.1920x1080.jpg">';
    assert.equal(Resolver.appIdFromHtml(html), '1145360');
});
test('appIdFromHtml: store_trailers URL', () => {
    const html = '<video src="https://store.akamai.steamstatic.com/store_trailers/2358720/trailer.mp4">';
    assert.equal(Resolver.appIdFromHtml(html), '2358720');
});
test('appIdFromHtml: legacy akamaihd CDN with capsule asset', () => {
    const html = '<img src="https://cdn.steamcdn-a.akamaihd.net/steam/apps/70/capsule_616x353.jpg">';
    assert.equal(Resolver.appIdFromHtml(html), '70');
});
test('appIdFromHtml: movie thumbnail (per-movie id) does NOT match', () => {
    const html = '<img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/257074535/hash123/movie_600x337.jpg">';
    assert.equal(Resolver.appIdFromHtml(html), null);
});
test('appIdFromHtml: no Steam asset yields null', () => {
    assert.equal(Resolver.appIdFromHtml('<p>plain post about a game</p>'), null);
});

// ── pickSearchResult ─────────────────────────────────────────────────────
test('pickSearchResult: exact normalized match beats list order', () => {
    const items = [{ id: 1, name: 'Hades II' }, { id: 2, name: 'Hades' }];
    assert.equal(Resolver.pickSearchResult(items, 'hades').id, 2);
});
test('pickSearchResult: exact match ignores punctuation and case', () => {
    const items = [{ id: 1, name: 'Half-Life 2: Episode One' }, { id: 2, name: 'Half-Life 2' }];
    assert.equal(Resolver.pickSearchResult(items, 'half life 2').id, 2);
});
test('pickSearchResult: name containing the full target beats first item', () => {
    const items = [{ id: 1, name: 'Something Else' }, { id: 2, name: 'The Portal Experiment' }];
    assert.equal(Resolver.pickSearchResult(items, 'portal').id, 2);
});
test('pickSearchResult: falls back to the first item', () => {
    const items = [{ id: 1, name: 'Foo' }, { id: 2, name: 'Bar' }];
    assert.equal(Resolver.pickSearchResult(items, 'portal').id, 1);
});
test('pickSearchResult: empty or missing items yield null', () => {
    assert.equal(Resolver.pickSearchResult([], 'x'), null);
    assert.equal(Resolver.pickSearchResult(undefined, 'x'), null);
});

// ── appIdFromManualValue ─────────────────────────────────────────────────
test('appIdFromManualValue: full store URL', () => {
    assert.equal(Resolver.appIdFromManualValue('https://store.steampowered.com/app/70/Half-Life/'), '70');
});
test('appIdFromManualValue: bare short appid with whitespace', () => {
    assert.equal(Resolver.appIdFromManualValue('  70 '), '70');
});
test('appIdFromManualValue: bare long appid', () => {
    assert.equal(Resolver.appIdFromManualValue('1145360'), '1145360');
});
test('appIdFromManualValue: garbage yields null', () => {
    assert.equal(Resolver.appIdFromManualValue('not a steam thing'), null);
});

// ── isListPath ───────────────────────────────────────────────────────────
test('isListPath: archive and pagination paths are list pages', () => {
    assert.equal(Resolver.isListPath('/tag/action/', ''), true);
    assert.equal(Resolver.isListPath('/category/updates/', ''), true);
    assert.equal(Resolver.isListPath('/page/2/', ''), true);
    assert.equal(Resolver.isListPath('/author/fitgirl/', ''), true);
});
test('isListPath: search query is a list page', () => {
    assert.equal(Resolver.isListPath('/', '?s=hades'), true);
});
test('isListPath: a game slug is not a list page', () => {
    assert.equal(Resolver.isListPath('/hades-ii/', ''), false);
});
