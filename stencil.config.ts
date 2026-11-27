import { join } from 'path';
import { Config } from '@stencil/core';
import { sass } from '@stencil/sass';

export const config: Config = {
  namespace: 'mplay3r',
  srcDir: 'src',
  tsconfig: 'tsconfig.build.json',
  globalScript: 'src/global/app.ts',
  minifyJs: true,
  minifyCss: true,
  extras: {
    appendChildSlotFix: true,
    cloneNodeFix: true,
  },
  plugins: [sass()],
  watchExternalDirs: [join(__dirname, 'dist', 'css')],
  devServer: {
    port: 3333,
    openBrowser: false,
    excludeHmr: ['**/dist/css/**'],
  },
  outputTargets: [
    {
      // Standalone Web / PWA build and Tauri v2 desktop frontendDist.
      type: 'www',
      serviceWorker: null,
      copy: [
        { src: '../dist/css', dest: 'css' },
        { src: 'embed-demo.html', dest: 'embed-demo.html' },
        { src: 'manifest.webmanifest', dest: 'manifest.webmanifest' },
        { src: 'icons', dest: 'icons' },
        { src: 'sw.js', dest: 'sw.js' },
      ],
    },
    {
      // Lazy-loaded ESM/CJS distribution + loader for web apps and CDNs.
      type: 'dist',
      dir: 'dist',
      esmLoaderPath: '../loader',
      // Keep dist/css written by scripts/build-css.mjs.
      empty: false,
    },
    {
      // Standalone tree-shakable custom elements bundle for embedding in external web apps.
      type: 'dist-custom-elements',
      dir: 'dist/components',
      customElementsExportBehavior: 'auto-define-custom-elements',
      externalRuntime: false,
    },
  ],
};
