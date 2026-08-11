import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const slimBindingsIndex = new URL(
	'./src/lib/relay-bindings/index.ts',
	import.meta.url
).pathname;

/**
 * The generated files in vendor/bitcraft-bindings import their module index as
 * `.`, which would pull the full 274-table generated index into the bundle.
 * Redirect it to our hand-pruned index, which registers only the tables we
 * subscribe to. See src/lib/relay-bindings/index.ts.
 */
function bitcraftBindingsSlimIndex(): Plugin {
	return {
		name: 'bitcraft-bindings-slim-index',
		enforce: 'pre',
		resolveId(source, importer) {
			if (
				importer?.includes('vendor/bitcraft-bindings/') &&
				(source === '.' || source === './index' || source === './index.ts')
			) {
				return slimBindingsIndex;
			}
		}
	};
}

export default defineConfig({
	plugins: [bitcraftBindingsSlimIndex(), tailwindcss(), sveltekit()],
	server: {
		fs: {
			// vendor/bitcraft-bindings sits outside SvelteKit's default allow list
			allow: ['.']
		}
	}
});
