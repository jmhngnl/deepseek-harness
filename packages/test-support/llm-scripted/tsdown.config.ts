import { defineConfig } from 'tsdown'

/**
 * Builds the plugin entry as one self-contained file admitted by the package
 * whitelist.
 *
 * The bundle is not optional here: a cordis patch row resolves a package by its
 * manifest's `main`, so a package that only emitted `lib/types` would fail to
 * import at boot — and from the browser that failure looks like a route that
 * simply never resolves, which is far harder to read than a build error.
 *
 * `fixedExtension: false` keeps the emitted name `.js`, matching `main`; the
 * default `.mjs` would resolve to nothing.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
])
