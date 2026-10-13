import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('inline JavaScript in the frontend parses successfully', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  let checked = 0;

  for (let index = 0; index < scripts.length; index += 1) {
    const attributes = scripts[index][1] || '';
    const source = scripts[index][2] || '';
    if (!source.trim()) continue;
    if (/\bsrc\s*=/.test(attributes)) continue;
    if (/\btype\s*=\s*["'](?:application\/(?:ld\+)?json|importmap|text\/template)["']/i.test(attributes)) continue;

    new vm.Script(source, { filename: 'index.html:inline-script-' + (index + 1) });
    checked += 1;
  }

  assert.ok(checked > 0, 'expected at least one inline JavaScript block to validate');
});

test('frontend merges combined and bucket feeds and removes duplicate rows', () => {
  assert.match(html, /const bucketRows = \(payload\.recentResults \|\| \[\]\)\.concat/);
  assert.match(html, /payload\.riskContextResults \|\| \[\]/);
  assert.match(html, /evidenceType: String\(row\.evidenceType \|\| 'incident'\)/);
  assert.match(html, /const sourceRows = \(Array\.isArray\(payload\.results\) \? payload\.results : \[\]\)\.concat\(bucketRows\)/);
  assert.match(html, /const seenRows = new Set\(\)/);
  assert.match(html, /if \(!stableKey \|\| seenRows\.has\(stableKey\)\) return false/);
});


test('mobile map collapse control and glowing current-position marker are present', () => {
  assert.match(html, /id="mobile-map-toggle"/);
  assert.match(html, /function toggleMobileMap\(\)/);
  assert.match(html, /#radar-top-layout\.map-collapsed\s*\{\s*grid-template-rows:\s*54px auto;/);
  assert.match(html, /\.gps-user-marker::before/);
  assert.match(html, /@keyframes gps-location-wave/);
  assert.match(html, /function createUserLocationIcon\(\)/);
  assert.match(html, /userMarker\.setIcon\(createUserLocationIcon\(\)\)/);
});


test('mobile map toggle wins over the desktop-hidden default rule', () => {
  assert.match(html, /@media\s*\(max-width:\s*800px\)[\s\S]*?#map-panel \.map-mobile-toggle\s*\{[\s\S]*?display:\s*inline-flex/);
  assert.match(html, /\.map-mobile-toggle\s*\{\s*display:\s*none;\s*\}/);
});

test('mobile bottom navigation is compact and radar content scrolls naturally', () => {
  assert.match(html, /<nav id="bottom-navigation"/);
  assert.match(html, /#bottom-navigation\s*\{[\s\S]*?height:\s*calc\(54px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(html, /#bottom-navigation \.nav-btn > i/);
  assert.match(html, /#radar-sidebar\s*\{\s*max-height:\s*none;\s*overflow:\s*visible;/);
  assert.match(html, /body > main\s*\{\s*min-height:\s*0;\s*overflow:\s*hidden;\s*\}/);
  assert.match(html, /#view-radar\s*\{\s*height:\s*100%;\s*min-height:\s*0;/);
});


test('mobile alert detail panel is hosted below the header, not over the intel feed', () => {
  const headerEnd = html.indexOf('</header>');
  const mobileHostStart = html.indexOf('<div id="mobile-detail-host"');
  const mainStart = html.indexOf('<main class="flex-1 relative bg-slate-50">');
  assert.ok(headerEnd >= 0 && mobileHostStart > headerEnd && mainStart > mobileHostStart);
  assert.match(html, /function syncIncidentDetailPlacement\(\)/);
  assert.match(html, /if \(isMobile && panel\.parentElement !== mobileHost\)\s*\{\s*mobileHost\.appendChild\(panel\)/);
  assert.match(html, /else if \(!isMobile && panel\.parentElement !== workspace\)\s*\{\s*workspace\.insertBefore\(panel, topLayout\.nextSibling\)/);
  assert.match(html, /document\.getElementById\('incident-detail-panel'\)\.setAttribute\('data-selection-state', 'selected'\)/);
  assert.match(html, /setAttribute\('data-selection-state', 'empty'\)/);
});

test('mobile detail panel is compact and reserves layout space rather than floating over content', () => {
  assert.match(html, /#mobile-detail-host\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /@media\s*\(max-width:\s*800px\)[\s\S]*?#mobile-detail-host\s*\{\s*display:\s*block/);
  assert.match(html, /#incident-detail-panel\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*7px 8px;/);
  assert.match(html, /#incident-detail-panel\[data-selection-state="empty"\] #detail-desc/);
  assert.match(html, /#view-radar\s*\{\s*height:\s*100%;\s*min-height:\s*0;/);
});


test('free TinyFish Search runs only through the protected Worker endpoint', () => {
  assert.match(html, /const TINYFISH_PROXY_URL = 'https:\/\/[^']+\/nearby-intel'/);
  assert.match(html, /fetchTinyFishIntel\(userLocation\.lat, userLocation\.lng/);
  assert.doesNotMatch(html, /TINYFISH_API_KEY\s*=/);
});


test('frontend separates historical incidents from structural risk context', () => {
  assert.match(html, /article\.evidenceType === 'structural-risk' \|\| bucket === 'risk-context'/);
  assert.match(html, /Risk context & prevalence · not live incident reports/);
  assert.match(html, /This is historical context, not evidence of an active attack/);
  assert.doesNotMatch(html, /tips\.push\('This source is undated\. Do not treat it as evidence of an active incident/);
});

test('geolocation fallback never triggers a TinyFish current-location search', () => {
  assert.match(html, /if \(usingFallbackLocation\) \{\s*updateSourceStatus\('tinyfish', 'GPS required for local search'/);
  assert.match(html, /'Outside UK API coverage'/);
});


test('frontend classifies wider gender-based violence context separately from sexual-violence incidents', () => {
  assert.match(html, /gender based violence|gender\[- \]based violence/);
  assert.match(html, /Gender-based violence awareness/);
  assert.match(html, /Use risk studies to inform prevention and access to support/);
});


test('news categories trigger topic-specific prevention guidance and linked source reports', () => {
  assert.match(html, /function renderNewsDrivenRecommendations\(container\)/);
  assert.match(html, /classifySafetyText\(String\(article\.title \|\| ''\) \+ ' ' \+ String\(article\.snippet \|\| ''\)\)/);
  assert.match(html, /Personal safety guidance: sexual-violence reports/);
  assert.match(html, /Safety guidance: bombing and explosion reports/);
  assert.match(html, /Prevention guidance: theft and snatch theft/);
  assert.match(html, /Related source reports/);
  assert.match(html, /Review related news/);
  assert.match(html, /if \(webIntel\.length\) renderNewsDrivenRecommendations\(container\)/);
});

test('context-specific advice does not frame historical or structural-risk results as active incidents', () => {
  assert.match(html, /Based on a prevalence study or wider risk assessment/);
  assert.match(html, /Historical incident context\. It can inform preparedness, but it does not establish that the incident is active now/);
  assert.match(html, /The source date is unconfirmed\. Check the original report and current local guidance/);
  assert.match(html, /perpetrators are responsible for abuse/);
});


test('specific sexual-violence language takes precedence over broader gender-based context', () => {
  assert.match(html, /Classify specific sexual-violence reports before the broader GBV category/);
  assert.match(html, /return 'sexual_violence';[\s\S]*?return 'gender_based_violence';/);
});


test('mobile header is compact and uses a refined branded lockup', () => {
  assert.match(html, /<header id="app-header"/);
  assert.match(html, /class="brand-symbol"/);
  assert.match(html, /class="brand-wordmark"/);
  assert.match(html, /#app-header \{ height:52px; min-height:52px;/);
  assert.match(html, /#header-account-button/);
  assert.match(html, /#gps-status \.animate-ping \{ display:none;/);
});

test('mobile safety overview is compact while preserving signal context and recommendations', () => {
  assert.match(html, /#awareness-overview #awareness-risk-copy[\s\S]*?-webkit-line-clamp:2/);
  assert.match(html, /#awareness-overview \.awareness-action[\s\S]*?white-space:nowrap/);
  assert.match(html, /News signals can inform prevention/);
  assert.match(html, /web result\(s\) are available/);
  assert.match(html, /These can inform proportionate prevention, but do not confirm an active incident near you/);
  assert.match(html, /View tailored tips/);
});


test('mobile overview actions row and refreshed GPS status remain compact', () => {
  assert.match(html, /#awareness-actions-row \{ align-items:center; gap:8px; margin-top:7px !important; \}/);
  assert.match(html, /#gps-status span:last-child \{ font-size:9px !important; \}/);
  assert.match(html, /id="awareness-actions-row"/);
});


test('hazard overview separates current local signals from regional context and expires stale data', () => {
  assert.match(html, /routeHazardCandidates = \[\]/);
  assert.match(html, /gempaterkini\.json/);
  assert.match(html, /gempadirasakan\.json/);
  assert.match(html, /function isFreshHazardSignal\(item\)/);
  assert.match(html, /function currentRegionalHazards\(radiusKm = 50\)/);
  assert.match(html, /No qualifying mapped signal was found within 10 km/);
  assert.match(html, /recent regional signal\(s\) are between 10 and 50 km away/);
  assert.match(html, /6 data feeds responding/);
  assert.match(html, /isFreshHazardSignal\(inc\)/);
});

test('NASA EONET is a separate global natural-event source and never plots polygons as exact points', () => {
  assert.match(html, /https:\/\/eonet\.gsfc\.nasa\.gov\/api\/v3\/events/);
  assert.match(html, /id="status-eonet"/);
  assert.match(html, /NASA EONET · open natural events/);
  assert.match(html, /item\.type === 'Point' && Array\.isArray\(item\.coordinates\)/);
  assert.match(html, /skips them rather than plotting a polygon centroid as an exact incident/);
});

test('BMKG feed expansion only elevates recent timestamped earthquakes', () => {
  assert.match(html, /const ageHours = stamp \? \(Date\.now\(\) - new Date\(stamp\)\.getTime\(\)\) \/ 3600000 : NaN/);
  assert.match(html, /ageHours > 72/);
  assert.match(html, /magnitude >= 4\.5/);
  assert.match(html, /tsunamiPotential/);
});
