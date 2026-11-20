#!/usr/bin/env node
// electron-builder's dmgbuild, with one addition: the DMG's hidden files (background, volume icon, Finder
// settings) get positions below the visible window. Finder shows them when "show hidden files" is on (⌘⇧.),
// and without a position they land on top of the artwork. electron-builder's config only allows file/link
// entries, so `npm run dist` points CUSTOM_DMGBUILD_PATH here and this adds dmgbuild's "position" entries.
//
// The real dmgbuild comes from electron-builder's cache. With CUSTOM_DMGBUILD_PATH set electron-builder never
// downloads it, so on a machine that never built a DMG without this wrapper (a fresh CI runner) the wrapper downloads
// it itself – the same release, file and checksums electron-builder's own dmg-builder would use.
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HIDDEN = [
  { x: 120, y: 760, type: 'position', path: '.background.tiff' },
  { x: 300, y: 760, type: 'position', path: '.VolumeIcon.icns' },
  { x: 480, y: 760, type: 'position', path: '.DS_Store' },
];

/**
 * The dmgbuild toolset dmg-builder downloads, read from its own source (dmgUtil.js): pinning these values here would
 * fetch an outdated bundle after every electron-builder upgrade.
 *
 * @param {string} src the text of node_modules/dmg-builder/out/dmgUtil.js
 * @param {'arm64'|'x86_64'} arch the bundle's architecture
 * @returns {{ releaseName: string, filenameWithExt: string, checksums: Record<string, string> } | null} the arguments
 *   for app-builder-lib's downloadBuilderToolset, or null when the source no longer has the expected shape
 */
export function dmgbuildToolset(src, arch) {
  const release = /releaseName:\s*"(dmg-builder@[\w.-]+)"/.exec(src)?.[1];
  const build = /filenameWithExt:\s*`dmgbuild-bundle-\$\{arch\}-([0-9a-f]+)\.tar\.gz`/.exec(src)?.[1];
  const checksums = Object.fromEntries([...src.matchAll(/"(dmgbuild-bundle-(?:arm64|x86_64)-[0-9a-f]+\.tar\.gz)":\s*"([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]]));
  const filenameWithExt = `dmgbuild-bundle-${arch}-${build}.tar.gz`;
  if (!release || !build || !checksums[filenameWithExt]) return null;
  return { releaseName: release, filenameWithExt, checksums };
}

/**
 * electron-builder's tool cache: $ELECTRON_BUILDER_CACHE when it is an absolute path (as electron-builder reads it),
 * else ~/Library/Caches/electron-builder.
 *
 * @returns {string} the cache folder
 */
function cacheDir() {
  const env = process.env.ELECTRON_BUILDER_CACHE?.trim();
  return env && isAbsolute(env) ? env : join(homedir(), 'Library', 'Caches', 'electron-builder');
}

/**
 * The dmgbuild binary electron-builder already downloaded, newest dmg-builder release first.
 *
 * @param {string} cache the electron-builder cache folder
 * @param {'arm64'|'x86_64'} arch the bundle's architecture
 * @returns {string|null} the binary's path, or null when none is cached
 */
function cachedDmgbuild(cache, arch) {
  for (const tool of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('dmg-builder@')).sort().reverse() : []) {
    for (const dir of readdirSync(join(cache, tool))) {
      const bin = join(cache, tool, dir, 'dmgbuild');
      if (dir.startsWith(`dmgbuild-bundle-${arch}`) && !dir.endsWith('.tar.gz') && existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * Downloads dmgbuild into electron-builder's cache through electron-builder's own downloader (checksum-verified).
 *
 * @param {'arm64'|'x86_64'} arch the bundle's architecture
 * @returns {Promise<string>} the binary's path
 * @throws {Error} when dmg-builder's source has an unexpected shape or the download fails
 */
export async function downloadDmgbuild(arch) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const require = createRequire(join(root, 'package.json'));
  const src = readFileSync(require.resolve('dmg-builder/out/dmgUtil.js'), 'utf8');
  const toolset = dmgbuildToolset(src, arch);
  if (!toolset) throw new Error('dmg-builder/out/dmgUtil.js no longer names its dmgbuild download – update scripts/dmgbuild-wrapper.mjs');
  const { downloadBuilderToolset } = require('app-builder-lib/out/util/electronGet');
  return join(await downloadBuilderToolset(toolset), 'dmgbuild');
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('-s');
  if (at >= 0 && args[at + 1]) {
    const file = args[at + 1];
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    const names = new Set((settings.contents || []).map((c) => c.path));
    settings.contents = [...(settings.contents || []), ...HIDDEN.filter((h) => !names.has(h.path))];
    writeFileSync(file, JSON.stringify(settings, null, 2));
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  let real = cachedDmgbuild(cacheDir(), arch);
  if (!real) {
    try {
      real = await downloadDmgbuild(arch);
    } catch (e) {
      console.error(`dmgbuild is not in the electron-builder cache and could not be downloaded: ${e.message}`);
      process.exit(1);
    }
  }
  if (!existsSync(real)) {
    console.error(`dmgbuild missing after the download: ${real}`);
    process.exit(1);
  }
  const r = spawnSync(real, args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

/**
 * Is this file the program being run (electron-builder's dmgbuild) rather than a module imported by the tests? Real
 * paths on both sides: a relative or symlinked invocation must still build, never exit quietly without a DMG.
 *
 * @returns {boolean} whether to run main()
 */
function runAsProgram() {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runAsProgram()) await main();
