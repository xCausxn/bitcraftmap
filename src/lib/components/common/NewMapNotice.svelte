<script lang="ts">
	import { Map, X } from '@lucide/svelte';

	const SEEN_KEY = 'newMapNoticeSeen';

	function hasSeenNotice(): boolean {
		try {
			return localStorage.getItem(SEEN_KEY) === 'true';
		} catch {
			return true;
		}
	}

	let visible = $state(!hasSeenNotice());

	function dismiss(): void {
		visible = false;
		try {
			localStorage.setItem(SEEN_KEY, 'true');
		} catch { /* ignore */ }
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') dismiss();
	}
</script>

<svelte:window onkeydown={visible ? handleKeydown : undefined} />

{#if visible}
	<div class="fixed inset-0 z-overlay flex items-center justify-center p-4 bg-black/60">
		<div
			class="w-full max-w-sm rounded-xl border border-white/10 bg-[#1E2742] p-5 shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-labelledby="new-map-notice-title"
		>
			<div class="flex items-start gap-3 mb-3">
				<div class="shrink-0 rounded-lg bg-blue-500/15 p-2">
					<Map size={18} class="text-blue-400" />
				</div>
				<div class="flex-1 min-w-0">
					<h2 id="new-map-notice-title" class="text-sm font-semibold text-gray-100">
						We're trialing a new map
					</h2>
					<p class="mt-1 text-xs text-gray-400 leading-relaxed">
						A new version of the map is being trialed at
						<span class="text-gray-200">bitjita.com/map</span>.
						Give it a try and let us know what you think.
					</p>
				</div>
				<button
					type="button"
					onclick={dismiss}
					aria-label="Dismiss notice"
					class="shrink-0 cursor-pointer text-gray-500 hover:text-gray-200 transition-colors"
				>
					<X size={16} />
				</button>
			</div>
			<div class="flex gap-2">
				<button
					type="button"
					onclick={dismiss}
					class="flex-1 text-xs rounded-md px-3 py-2 text-gray-400 hover:text-gray-200 border border-white/10 hover:bg-white/5 transition-colors cursor-pointer"
				>
					Maybe later
				</button>
				<a
					href="https://bitjita.com/map"
					target="_blank"
					rel="noopener noreferrer"
					onclick={dismiss}
					class="flex-1 text-center text-xs rounded-md px-3 py-2 bg-blue-500 hover:bg-blue-400 text-white font-medium transition-colors"
				>
					Try the new map
				</a>
			</div>
		</div>
	</div>
{/if}
