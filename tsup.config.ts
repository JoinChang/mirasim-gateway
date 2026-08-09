import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
  onSuccess: 'cp -r src/db/migrations dist/migrations',
});
