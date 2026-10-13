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


test('free-only mode removes the paid news proxy and rejects legacy cached news', () => {
  assert.doesNotMatch(html, /TINYFISH_PROXY_URL|fetchTinyFishIntel|civilaegis-tinyfish-proxy/);
  assert.match(html, /webIntel = \[\];/);
  assert.match(html, /Disabled · free mode/);
  assert.match(html, /News & OSINT search is disabled in Free Mode/);
});
