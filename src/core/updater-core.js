/**
 * Updater core logic: semantic versioning, asset resolution, and state helpers.
 * Zero external dependencies — pure JavaScript.
 */

export function parseSemver(v) {
  const str = String(v || '').trim().replace(/^[vV]/, '');
  const [core, prerelease] = str.split('-');
  const parts = core.split('.').map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { major: parts[0], minor: parts[1], patch: parts[2], prerelease: prerelease ?? null };
}

export function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (p1.major !== p2.major) return p1.major > p2.major ? 1 : -1;
  if (p1.minor !== p2.minor) return p1.minor > p2.minor ? 1 : -1;
  if (p1.patch !== p2.patch) return p1.patch > p2.patch ? 1 : -1;
  if (!p1.prerelease && p2.prerelease) return 1;
  if (p1.prerelease && !p2.prerelease) return -1;
  return 0;
}

export function findPlatformAsset(assets, platform = process.platform, arch = process.arch, isPortable = false) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  if (platform === 'win32') {
    if (isPortable) {
      const portable = assets.find((a) => a.name?.endsWith('.exe') && a.name?.includes('Portable'));
      if (portable) return portable;
    }
    const setup = assets.find((a) => a.name?.endsWith('.exe') && a.name?.includes('Setup'));
    if (setup) return setup;
    return assets.find((a) => a.name?.endsWith('.exe')) ?? null;
  }

  if (platform === 'darwin') {
    const isArm = arch === 'arm64';
    const armDmg = assets.find((a) => a.name?.endsWith('.dmg') && a.name?.includes('arm64'));
    const x64Dmg = assets.find((a) => a.name?.endsWith('.dmg') && (a.name?.includes('x64') || !a.name?.includes('arm64')));
    if (isArm && armDmg) return armDmg;
    if (x64Dmg) return x64Dmg;
    return assets.find((a) => a.name?.endsWith('.dmg') || a.name?.endsWith('.zip')) ?? null;
  }

  if (platform === 'linux') {
    const appImage = assets.find((a) => a.name?.endsWith('.AppImage'));
    if (appImage) return appImage;
    return assets.find((a) => a.name?.endsWith('.deb')) ?? null;
  }

  return assets[0] ?? null;
}
