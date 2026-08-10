import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The generated @polkadot-api/descriptors package lazy-imports each
// chain's FULL metadata (~1.5 MB total) for getOfflineApi/getTypedCodecs,
// which this app never calls; getTypedApi needs only the checksum and
// type-shape chunks. Harmless as never-fetched lazy chunks, but the
// singlefile build inlines every dynamic import — so stub them out.
// Anything that does call descriptors.getMetadata() then fails loudly.
const stubPapiDescriptorMetadata = () => ({
  name: 'stub-papi-descriptor-metadata',
  apply: 'build',
  enforce: 'pre',
  load(id) {
    if (/descriptors[/\\]dist[/\\]\w+_metadata-[\w-]+\.js$/.test(id)) {
      return 'export default ""'
    }
  }
})

export default defineConfig({
  plugins: [react(), viteSingleFile(), stubPapiDescriptorMetadata()],
  server: {
    host: true,
    port: 5174
  }
})
