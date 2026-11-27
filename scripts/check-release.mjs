// Release-readiness & GitHub Pages subpath verifier for mPlay3r.
// Checks version parity across package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json,
// CORE_VERSION in mplay3r-app.tsx, CHANGELOG.md, and validates subpath-safe PWA/Embed asset URLs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function readText(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

export function collectReleaseChecks() {
  const errors = [];

  const pkg = JSON.parse(readText('package.json'));
  const pkgVersion = pkg.version;

  const cargoToml = readText('src-tauri/Cargo.toml');
  const cargoMatch = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml);
  const cargoVersion = cargoMatch?.[1];

  const tauriConf = JSON.parse(readText('src-tauri/tauri.conf.json'));
  const tauriVersion = tauriConf.version;

  const appTsx = readText('src/components/mplay3r-app/mplay3r-app.tsx');
  const coreMatch = /const\s+CORE_VERSION\s*=\s*'([^']+)'/.exec(appTsx);
  const coreVersion = coreMatch?.[1];

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkgVersion || '')) {
    errors.push(`package.json version is not valid SemVer: "${pkgVersion}"`);
  }
  if (cargoVersion !== pkgVersion) {
    errors.push(`Version mismatch: src-tauri/Cargo.toml (${cargoVersion}) !== package.json (${pkgVersion})`);
  }
  if (tauriVersion !== pkgVersion) {
    errors.push(`Version mismatch: src-tauri/tauri.conf.json (${tauriVersion}) !== package.json (${pkgVersion})`);
  }
  if (coreVersion !== pkgVersion) {
    errors.push(`Version mismatch: CORE_VERSION (${coreVersion}) !== package.json (${pkgVersion})`);
  }

  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    errors.push('Missing CHANGELOG.md');
  } else {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    if (!changelog.includes(`## [${pkgVersion}]`)) {
      errors.push(`CHANGELOG.md does not contain a "## [${pkgVersion}]" release section`);
    }
  }

  // Ensure standalone Web/PWA & Embed Demo work cleanly under subpath hosting (e.g. GitHub Pages /mPlay3r/).
  const htmlFiles = ['src/index.html', 'src/embed-demo.html'];
  for (const file of htmlFiles) {
    const html = readText(file);
    if (/(?:href|src)="\/(?:css|build|icons|manifest\.webmanifest|sw\.js)/.test(html)) {
      errors.push(`${file} contains root-absolute asset URLs that break GitHub Pages subpath deployments (use "./..." instead)`);
    }
  }

  const manifest = JSON.parse(readText('src/manifest.webmanifest'));
  if (manifest.start_url !== './' || manifest.scope !== './') {
    errors.push(`src/manifest.webmanifest must use relative start_url="./" and scope="./" for subpath PWA compatibility`);
  }
  if (!manifest.icons?.[0]?.src?.startsWith('./')) {
    errors.push('src/manifest.webmanifest icon src must be relative ("./icons/icon.svg")');
  }

  const sw = readText('src/sw.js');
  if (sw.includes("'/css/") || sw.includes("'/icons/") || sw.includes("'/manifest.webmanifest'")) {
    errors.push('src/sw.js contains root-absolute cache entries; use relative "./..." paths');
  }

  return {
    version: pkgVersion,
    versions: {
      packageJson: pkgVersion,
      cargoToml: cargoVersion,
      tauriConf: tauriVersion,
      coreVersion,
    },
    errors,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = collectReleaseChecks();
  if (report.errors.length > 0) {
    console.error('Release readiness check failed:');
    for (const err of report.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  console.log(`Release readiness check passed for mPlay3r v${report.version} (versions synced & GitHub Pages subpath-safe).`);
}
