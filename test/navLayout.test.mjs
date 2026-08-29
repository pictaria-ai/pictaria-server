import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url);

test('every shared-nav page reserves the supporter slot before the primary nav', () => {
  const pages = readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith('.html'))
    .filter((name) => readFileSync(new URL(name, PUBLIC_DIR), 'utf8').includes('src="/nav.js"'));

  assert.ok(pages.length >= 9, 'expected every interactive Server page');
  for (const page of pages) {
    const source = readFileSync(new URL(page, PUBLIC_DIR), 'utf8');
    const header = source.match(/<header class="p-topbar">[\s\S]*?<\/header>/)?.[0];
    assert.ok(header, `${page} has a topbar`);
    const brandEnd = header.indexOf('</a>');
    const slot = header.indexOf('<span class="p-supporter-slot" aria-live="polite"></span>');
    const nav = header.indexOf('<nav class="p-nav">');
    assert.ok(brandEnd >= 0 && brandEnd < slot && slot < nav, `${page} reserves the badge slot between brand and nav`);
  }
});

test('the supporter slot has stable desktop and compact mobile footprints', () => {
  const css = readFileSync(new URL('pictaria.css', PUBLIC_DIR), 'utf8');
  const nav = readFileSync(new URL('nav.js', PUBLIC_DIR), 'utf8');

  assert.match(css, /\.p-supporter-slot\s*\{[^}]*flex:\s*0 0 112px;/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.p-supporter-slot\s*\{\s*flex-basis:\s*32px;/);
  assert.match(nav, /slot\.replaceChildren\(\);/);
  assert.match(nav, /slot\.append\(chip\);/);
});
