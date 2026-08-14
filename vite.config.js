import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The generated @polkadot-api/descriptors package lazy-imports each
// chain's FULL metadata (~1.5 MB total) for getOfflineApi/getTypedCodecs,
// which this app never calls; getTypedApi needs only the checksum and
// type-shape chunks. Harmless as never-fetched lazy chunks, but the
// singlefile build inlines every dynamic import — so stub them out.
// Anything that does call descriptors.getMetadata() then fails loudly.
// The regex is coupled to papi's generated chunk naming, so the build
// FAILS if nothing matched — otherwise a papi rename would silently
// re-inline the metadata and balloon the bundle right back to ~2.4 MB.
const stubPapiDescriptorMetadata = () => {
  let stubbed = 0
  return {
    name: 'stub-papi-descriptor-metadata',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      if (/descriptors[/\\]dist[/\\]\w+_metadata-[\w-]+\.js$/.test(id)) {
        stubbed++
        return 'export default ""'
      }
    },
    buildEnd() {
      if (stubbed === 0) {
        throw new Error(
          'stub-papi-descriptor-metadata matched no modules — papi likely renamed its metadata chunks; update the regex or the bundle regrows by ~1.5 MB'
        )
      }
    }
  }
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), stubPapiDescriptorMetadata()],
  server: {
    host: true,
    port: 5174
  }
})
