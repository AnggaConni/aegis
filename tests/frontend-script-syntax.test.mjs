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
