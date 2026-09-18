import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Resolution across the workspace boundary is not configured here either, and
// the split is the point (#46). `dev` matches the `development` condition in
// each package's `exports` map and serves `packages/*/src` — no build needed to
// iterate. `build` matches `production`, which no package declares, so it falls
// through to `default` and assembles this bundle out of `packages/*/dist/*.js`:
// the built output really is what ships. Both halves come from Vite's default
// `resolve.conditions`, so there is nothing here to drift.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Vite 8 runs on Rolldown: manual chunking moved from
        // `output.manualChunks` to `output.codeSplitting.groups` (a boolean
        // `manualChunks` fn is deprecated and silently ignored once this is
        // set). Without these groups, three + its postprocessing subpaths
        // and react/react-dom land in the single entry chunk.
        //
        // The split is not about first paint — the shell loads this from
        // local disk. It is about what an UPDATE costs: an installed app
        // fetches its UI bundle from the Pages deploy file by file and skips
        // any hash it already has, and Vite names assets by content hash, so
        // keeping the vendors out of the entry chunk means a UI-only change
        // re-ships ~154 kB gzipped instead of ~469 kB. The same split keeps
        // them in the browser cache on the Pages site. What enforces it is
        // `scripts/check-bundle-size.mjs` (#57), re-measuring the built
        // output after this config runs. `[\\/]` (not `/`) in the test
        // regexes so matching stays correct on Windows paths.
        codeSplitting: {
          groups: [
            {
              name: 'vendor-three',
              // Matches both `three` itself and the
              // `three/examples/jsm/postprocessing/*` passes the viewport
              // pulls in — both resolve under node_modules/three/. three's
              // core alone minifies past 500 kB, so `maxSize` tells rolldown
              // to slice this group into several near-equal chunks instead
              // of leaving one oversized `vendor-three` chunk.
              test: /node_modules[\\/]three[\\/]/,
              maxSize: 350_000,
            },
            {
              name: 'vendor-react',
              // react-dom depends on scheduler; group it with react so the
              // vendor-react chunk stays self-contained.
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'vendor-mantine',
              // Mantine and the floating-ui it positions tooltips with. It
              // arrived with the frame (#96, the ui vocabulary) and pushed
              // the entry chunk past the ceiling on its own; it changes
              // on a dependency bump, never on an edit, so it caches well as
              // one chunk.
              test: /node_modules[\\/](@mantine|@floating-ui|clsx)[\\/]/,
            },
          ],
        },
      },
    },
  },
})
