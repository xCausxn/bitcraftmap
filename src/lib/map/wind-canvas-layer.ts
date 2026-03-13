import L from 'leaflet';
import { makeNoise4D } from './open-simplex-noise';

interface WindOctave {
	scale: number;
	weight: number;
	cycleSec: number;
}

interface WindConfig {
	seed: number;
	timestampOffset: number;
	loopRadius: number;
	noiseMul: number;
	timeMultiplier: number;
	octaves: WindOctave[];
}

const DEFAULT_CONFIG: WindConfig = {
	seed: 1596423,
	timestampOffset: 1750000000000,
	loopRadius: 100000.0,
	noiseMul: 10.0,
	timeMultiplier: 1.0,
	octaves: [
		{ scale: 0.00002, weight: 1.0, cycleSec: 2239487994240 },
		{ scale: 0.000015, weight: 0.75, cycleSec: 2239487994240 },
		{ scale: 0.00008, weight: 0.03, cycleSec: 3732470 }
	]
};

const TWO_PI = Math.PI * 2;
const GRID_SPACING_PX = 50;
const ARROW_LENGTH = 18;
const ARROW_HEAD = 5;
const ARROW_HEAD_ANGLE = 0.5;
const WORLD_SCALE = 1;

let windConfig: WindConfig = DEFAULT_CONFIG;
let noise4D = makeNoise4D(windConfig.seed);
let configLoaded = false;

async function loadWindConfig(): Promise<void> {
	if (configLoaded) return;
	configLoaded = true;
	try {
		const res = await fetch('/api/wind');
		if (!res.ok) return;
		const data = await res.json();
		if (data && data.seed != null) {
			windConfig = {
				seed: data.seed ?? DEFAULT_CONFIG.seed,
				timestampOffset: data.timestamp_offset ?? DEFAULT_CONFIG.timestampOffset,
				loopRadius: data.loop_radius ?? DEFAULT_CONFIG.loopRadius,
				noiseMul: data.noise_mul ?? DEFAULT_CONFIG.noiseMul,
				timeMultiplier: data.time_multiplier ?? DEFAULT_CONFIG.timeMultiplier,
				octaves: Array.isArray(data.octaves)
					? data.octaves.map((o: Record<string, number>) => ({
							scale: o.scale,
							weight: o.weight,
							cycleSec: o.cycle_sec
						}))
					: DEFAULT_CONFIG.octaves
			};
			if (windConfig.seed !== DEFAULT_CONFIG.seed) {
				noise4D = makeNoise4D(windConfig.seed);
			}
		}
	} catch {
		// use defaults
	}
}

function computeWindAngle(worldX: number, worldY: number, timeMs: number): number {
	const adjusted = timeMs - windConfig.timestampOffset;
	let sum = 0;
	let div = 0;

	for (const oct of windConfig.octaves) {
		const phase =
			(adjusted / (oct.cycleSec * 1000)) * TWO_PI * windConfig.timeMultiplier;
		const z = Math.sin(phase) * windConfig.loopRadius;
		const w = Math.cos(phase) * windConfig.loopRadius;
		sum += noise4D(worldX * oct.scale, worldY * oct.scale, z, w) * oct.weight;
		div += oct.weight;
	}

	if (div === 0) return 0;
	const val = sum / div + 1.0;
	return (val * windConfig.noiseMul * TWO_PI) % TWO_PI;
}

export class WindCanvasLayer extends L.Layer {
	private _canvas!: HTMLCanvasElement;
	private _ctx!: CanvasRenderingContext2D;
	private _rafId: number | null = null;

	onAdd(map: L.Map): this {
		this._canvas = L.DomUtil.create('canvas', 'wind-canvas-layer') as HTMLCanvasElement;
		this._canvas.style.pointerEvents = 'none';
		this._ctx = this._canvas.getContext('2d')!;

		const pane = map.getPane('overlayPane')!;
		pane.appendChild(this._canvas);

		map.on('moveend', this._onMoveEnd, this);

		loadWindConfig().then(() => {
			this._reset();
			this._animate();
		});

		return this;
	}

	onRemove(map: L.Map): this {
		map.off('moveend', this._onMoveEnd, this);

		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}

		if (this._canvas.parentNode) {
			this._canvas.parentNode.removeChild(this._canvas);
		}

		return this;
	}

	private _animate(): void {
		this._redraw();
		this._rafId = requestAnimationFrame(() => this._animate());
	}

	private _onMoveEnd(): void {
		this._reset();
	}

	private _reset(): void {
		if (!this._map) return;

		const size = this._map.getSize();

		if (this._canvas.width !== size.x || this._canvas.height !== size.y) {
			this._canvas.width = size.x;
			this._canvas.height = size.y;
		}
	}

	private _redraw(): void {
		const map = this._map;
		if (!map) return;

		const size = map.getSize();
		const ctx = this._ctx;

		// Position canvas to cover the current viewport
		const topLeft = map.containerPointToLayerPoint([0, 0]);
		L.DomUtil.setPosition(this._canvas, topLeft);

		ctx.clearRect(0, 0, size.x, size.y);

		const now = Date.now();
		const halfLen = ARROW_LENGTH / 2;

		ctx.lineWidth = 1.5;
		ctx.lineCap = 'round';

		// Compute a world-aligned grid: snap to world coordinates so arrows stay fixed
		const bounds = map.getBounds();
		const topLeftWorld = bounds.getNorthWest();
		const bottomRightWorld = bounds.getSouthEast();

		// Determine world-space grid spacing from screen spacing
		const centerLatLng = map.getCenter();
		const p1 = map.latLngToContainerPoint(centerLatLng);
		const p2 = L.point(p1.x + GRID_SPACING_PX, p1.y);
		const ll2 = map.containerPointToLatLng(p2);
		const worldStep = Math.abs(ll2.lng - centerLatLng.lng);

		if (worldStep === 0) return;

		// Snap grid origin to world coordinates
		const startX = Math.floor(topLeftWorld.lng / worldStep) * worldStep;
		const startY = Math.floor(bottomRightWorld.lat / worldStep) * worldStep;
		const endX = topLeftWorld.lng + (bottomRightWorld.lng - topLeftWorld.lng) + worldStep;
		const endY = topLeftWorld.lat + worldStep;

		for (let wx = startX; wx <= endX; wx += worldStep) {
			for (let wy = startY; wy <= endY; wy += worldStep) {
				const screenPt = map.latLngToContainerPoint([wy, wx]);
				const px = screenPt.x;
				const py = screenPt.y;

				const worldX = wx * WORLD_SCALE;
				const worldY = wy * WORLD_SCALE;

				const angle = computeWindAngle(worldX, worldY, now);
				const hue = (angle * 180) / Math.PI;

				const cosA = Math.cos(angle);
				const sinA = Math.sin(angle);
				const tipX = px + cosA * halfLen;
				const tipY = py + sinA * halfLen;
				const tailX = px - cosA * halfLen;
				const tailY = py - sinA * halfLen;

				ctx.strokeStyle = `hsl(${hue}, 70%, 55%)`;
				ctx.beginPath();

				// Shaft
				ctx.moveTo(tailX, tailY);
				ctx.lineTo(tipX, tipY);

				// Arrowhead
				ctx.moveTo(
					tipX - ARROW_HEAD * Math.cos(angle - ARROW_HEAD_ANGLE),
					tipY - ARROW_HEAD * Math.sin(angle - ARROW_HEAD_ANGLE)
				);
				ctx.lineTo(tipX, tipY);
				ctx.lineTo(
					tipX - ARROW_HEAD * Math.cos(angle + ARROW_HEAD_ANGLE),
					tipY - ARROW_HEAD * Math.sin(angle + ARROW_HEAD_ANGLE)
				);

				ctx.stroke();
			}
		}
	}
}
