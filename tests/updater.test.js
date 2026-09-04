import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemver, compareSemver, findPlatformAsset } from '../src/core/updater-core.js';

test('parseSemver parses standard and prefixed versions', () => {
  assert.deepEqual(parseSemver('0.1.0'), { major: 0, minor: 1, patch: 0, prerelease: null });
  assert.deepEqual(parseSemver('v0.1.1'), { major: 0, minor: 1, patch: 1, prerelease: null });
  assert.deepEqual(parseSemver('V1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, prerelease: 'beta.1' });
});

test('compareSemver accurately compares versions', () => {
  assert.equal(compareSemver('0.1.1', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.1.1'), -1);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.equal(compareSemver('v0.2.0', '0.1.9'), 1);
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
  assert.equal(compareSemver('0.1.1', '0.1.1-rc1'), 1);
});

test('findPlatformAsset picks the right installer for platform and arch', () => {
  const assets = [
    { name: 'ModelProof-0.1.1-linux-amd64.deb', browser_download_url: 'https://example.com/deb' },
    { name: 'ModelProof-0.1.1-linux-x86_64.AppImage', browser_download_url: 'https://example.com/appimage' },
    { name: 'ModelProof-0.1.1-mac-arm64.dmg', browser_download_url: 'https://example.com/mac-arm' },
    { name: 'ModelProof-0.1.1-mac-x64.dmg', browser_download_url: 'https://example.com/mac-x64' },
    { name: 'ModelProof-0.1.1-Portable-x64.exe', browser_download_url: 'https://example.com/portable' },
    { name: 'ModelProof-0.1.1-Setup-x64.exe', browser_download_url: 'https://example.com/setup' },
  ];

  const winAsset = findPlatformAsset(assets, 'win32', 'x64');
  assert.equal(winAsset.name, 'ModelProof-0.1.1-Setup-x64.exe');

  const winPortableAsset = findPlatformAsset(assets, 'win32', 'x64', true);
  assert.equal(winPortableAsset.name, 'ModelProof-0.1.1-Portable-x64.exe');

  const macArmAsset = findPlatformAsset(assets, 'darwin', 'arm64');
  assert.equal(macArmAsset.name, 'ModelProof-0.1.1-mac-arm64.dmg');

  const macIntelAsset = findPlatformAsset(assets, 'darwin', 'x64');
  assert.equal(macIntelAsset.name, 'ModelProof-0.1.1-mac-x64.dmg');

  const linuxAsset = findPlatformAsset(assets, 'linux', 'x64');
  assert.equal(linuxAsset.name, 'ModelProof-0.1.1-linux-x86_64.AppImage');
});
