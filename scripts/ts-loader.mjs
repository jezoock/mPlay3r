// Node 22+ resolve hook allowing extensionless TypeScript relative imports in `node --test`.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier) && context.parentURL) {
      const baseDir = path.dirname(fileURLToPath(context.parentURL));
      const tsFile = path.resolve(baseDir, `${specifier}.ts`);
      if (fs.existsSync(tsFile)) {
        return { url: pathToFileURL(tsFile).href, shortCircuit: true };
      }
      const indexTsFile = path.resolve(baseDir, specifier, 'index.ts');
      if (fs.existsSync(indexTsFile)) {
        return { url: pathToFileURL(indexTsFile).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
