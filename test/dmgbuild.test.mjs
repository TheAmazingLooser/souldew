// The DMG build's dmgbuild wrapper (scripts/dmgbuild-wrapper.mjs): on a machine without electron-builder's cached
// dmgbuild (a fresh CI runner) it downloads the same bundle dmg-builder would – read from dmg-builder's own source, so
// an electron-builder upgrade that changes that source fails here instead of in a release build on macOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { dmgbuildToolset } = await import('../scripts/dmgbuild-wrapper.mjs');
const require = createRequire(new URL('../package.json', import.meta.url));

test('dmgbuild: the installed dmg-builder names its download – release, file and checksum for both architectures', () => {
  const src = readFileSync(require.resolve('dmg-builder/out/dmgUtil.js'), 'utf8');
  for (const arch of ['arm64', 'x86_64']) {
    const t = dmgbuildToolset(src, arch);
    assert.ok(t, `${arch}: dmg-builder's source has the expected shape`);
    assert.match(t.releaseName, /^dmg-builder@\d+\.\d+\.\d+$/);
    assert.match(t.filenameWithExt, new RegExp(`^dmgbuild-bundle-${arch}-[0-9a-f]+\\.tar\\.gz$`));
    assert.match(t.checksums[t.filenameWithExt], /^[0-9a-f]{64}$/, 'never downloaded without a checksum');
  }
  // the downloader the wrapper borrows is still there
  assert.equal(typeof require('app-builder-lib/out/util/electronGet').downloadBuilderToolset, 'function');
});

test('dmgbuild: an unexpected dmg-builder source gives no download (the wrapper stops with a message)', () => {
  assert.equal(dmgbuildToolset('', 'arm64'), null);
  const src = 'releaseName: "dmg-builder@1.2.5", filenameWithExt: `dmgbuild-bundle-${arch}-abc.tar.gz`, checksums: { "dmgbuild-bundle-x86_64-abc.tar.gz": "' + 'a'.repeat(64) + '" }';
  assert.equal(dmgbuildToolset(src, 'arm64'), null, 'no checksum for this architecture');
  assert.equal(dmgbuildToolset(src, 'x86_64')?.filenameWithExt, 'dmgbuild-bundle-x86_64-abc.tar.gz');
});
