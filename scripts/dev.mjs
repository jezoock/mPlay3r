// Development runner: starts the Sass watcher and the Stencil dev server in one terminal.

import { fork, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cssWatcher = fork(path.join(root, 'scripts', 'build-css.mjs'), ['--watch'], { stdio: 'inherit' });
let stencil;

const shutdown = code => {
  cssWatcher.kill();
  stencil?.kill();
  process.exit(code ?? 0);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

cssWatcher.on('message', message => {
  if (message !== 'ready' || stencil) {
    return;
  }
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'stencil.cmd' : 'stencil');
  stencil = spawn(bin, ['build', '--dev', '--watch', '--serve'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  stencil.on('exit', code => shutdown(code));
});

cssWatcher.on('exit', code => {
  if (!stencil) {
    process.exit(code ?? 1);
  }
});
