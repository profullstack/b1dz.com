// Bundle the CLI into dist/b1dz.js for npm (@profullstack/b1dz).
// The shebang comes from src/index.ts. Workspace packages (@b1dz/*) are
// inlined; every real npm dependency stays external and must be listed in
// package.json "dependencies" (the build fails otherwise).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const externals = new Set();
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/b1dz.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __b1dzCreateRequire } from 'node:module';\nconst require = __b1dzCreateRequire(import.meta.url);",
  },
  define: { 'process.env.B1DZ_BUNDLED_VERSION': JSON.stringify(pkg.version) },
  plugins: [{
    name: 'externalize-npm',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith('@b1dz/') || args.path.startsWith('node:')) return null;
        // React 17 has no "exports" map, so Node's ESM loader cannot resolve
        // 'react/jsx-runtime'; inline it (it require()s 'react', still external).
        if (args.path === 'react/jsx-runtime') return null;
        const parts = args.path.split('/');
        const name = args.path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        externals.add(name);
        return { path: args.path, external: true };
      });
    },
  }],
});
const missing = [...externals].filter((name) => !(name in (pkg.dependencies ?? {})));
if (missing.length) {
  console.error(`bundle imports packages missing from dependencies: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`dist/b1dz.js (${pkg.version}); externals: ${[...externals].sort().join(' ')}`);
