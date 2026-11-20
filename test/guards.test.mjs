// Electron shell guards: navigation origin checks, external links, permissions, IPC senders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin, safeExternalUrl, appOverlayUrl, subframeNavigationAllowed, permissionAllowed, isTrustedIpcSender, APP_PERMISSIONS } from '../electron/guards.mjs';

const APP = 'http://localhost:47390';

test('sameOrigin compares origins, not prefixes', () => {
  assert.ok(sameOrigin('http://localhost:47390/', APP));
  assert.ok(sameOrigin('http://localhost:47390/player.html?x=1#y', APP));
  for (const bad of [
    'http://localhost:47390@evil.com/', 'http://localhost:473901/', 'http://localhost:47390.evil.com/',
    'https://localhost:47390/', 'http://127.0.0.1:47390/', 'http://localhost:47391/', 'file:///etc/passwd',
    'javascript:alert(1)', 'data:text/html,hi', 'about:blank', '', 'not a url', null, undefined,
  ]) assert.equal(sameOrigin(bad, APP), false, String(bad));
  assert.equal(sameOrigin(APP, null), false);
});

test('safeExternalUrl only passes https without credentials', () => {
  assert.equal(safeExternalUrl('https://github.com/x/y'), 'https://github.com/x/y');
  for (const bad of [
    'http://example.com/', 'file:///Applications/Calculator.app', 'smb://evil/share', 'javascript:alert(1)',
    'https://user:pw@example.com/', 'https://user@example.com/', 'ftp://x/', 'x-apple.systempreferences:', 'https://', 42, null,
    `https://example.com/${'a'.repeat(5000)}`,
  ]) assert.equal(safeExternalUrl(bad), null, String(bad).slice(0, 60));
});

test('appOverlayUrl lets exactly the app\'s own overlay page through (the TV overview in the system browser)', () => {
  assert.equal(appOverlayUrl(`${APP}/overlay?run=current&w=tv`, APP), `${APP}/overlay?run=current&w=tv`);
  assert.equal(appOverlayUrl(`${APP}/overlay`, APP), `${APP}/overlay`);
  for (const bad of [
    `${APP}/api/runs/current/overlay`, `${APP}/api/v1/runs/current`, `${APP}/`, `${APP}/overlay.html`, `${APP}/overlay/x`,
    `${APP}/overlay#x`, 'http://localhost:47391/overlay', 'http://example.com/overlay', `${APP}@evil.com/overlay`,
    'http://user:pw@localhost:47390/overlay', 'file:///overlay', 'javascript:alert(1)', 42, null, `${APP}/overlay?${'a'.repeat(5000)}`,
  ]) assert.equal(appOverlayUrl(bad, APP), null, String(bad).slice(0, 60));
  assert.equal(appOverlayUrl(`${APP}/overlay`, null), null, 'no server yet');
});

test('subframes stay on the app origin', () => {
  assert.ok(subframeNavigationAllowed(`${APP}/player.html?rom=x`, APP));
  assert.ok(subframeNavigationAllowed('about:blank', APP));
  assert.ok(!subframeNavigationAllowed('https://evil.example/', APP));
  assert.ok(!subframeNavigationAllowed('http://localhost:47390@evil.com/', APP));
});

test('permissions: only the app’s own, only for the app origin', () => {
  assert.deepEqual([...APP_PERMISSIONS].sort(), ['clipboard-sanitized-write', 'fullscreen']);
  assert.ok(permissionAllowed('fullscreen', `${APP}/player.html`, APP));
  assert.ok(permissionAllowed('clipboard-sanitized-write', APP, APP)); // check handler passes an origin
  for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'pointerLock', 'openExternal', 'midiSysex', 'display-capture', 'hid', 'usb', 'serial', 'unknown']) {
    assert.equal(permissionAllowed(p, APP, APP), false, p);
  }
  assert.equal(permissionAllowed('fullscreen', 'https://evil.example/', APP), false);
  assert.equal(permissionAllowed('fullscreen', '', APP), false);
  assert.equal(permissionAllowed('fullscreen', APP, null), false);
});

test('IPC is trusted only from the app window’s main frame on the app origin', () => {
  const mainFrame = { url: `${APP}/#/play`, parent: null, processId: 1, routingId: 1 };
  const wc = { mainFrame };
  assert.ok(isTrustedIpcSender({ sender: wc, senderFrame: mainFrame }, wc, APP));
  // same frame, different wrapper object
  assert.ok(isTrustedIpcSender({ sender: wc, senderFrame: { ...mainFrame } }, wc, APP));
  const iframe = { url: `${APP}/player.html`, parent: mainFrame, processId: 1, routingId: 2 };
  assert.ok(!isTrustedIpcSender({ sender: wc, senderFrame: iframe }, wc, APP));
  assert.ok(!isTrustedIpcSender({ sender: wc, senderFrame: { ...mainFrame, url: 'https://evil.example/' } }, wc, APP));
  assert.ok(!isTrustedIpcSender({ sender: wc, senderFrame: { ...mainFrame, url: 'http://localhost:47390@evil.com/' } }, wc, APP));
  assert.ok(!isTrustedIpcSender({ sender: { mainFrame }, senderFrame: mainFrame }, wc, APP)); // other webContents
  assert.ok(!isTrustedIpcSender({ sender: wc, senderFrame: null }, wc, APP));
  assert.ok(!isTrustedIpcSender({ sender: wc, senderFrame: mainFrame }, wc, null)); // before the server is up
  assert.ok(!isTrustedIpcSender({ sender: wc, senderFrame: mainFrame }, undefined, APP)); // no window
});
