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
const TIME_ROUND_MS = 3_600_000;

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
	private _lastBoundsKey = '';

	onAdd(map: L.Map): this {
		this._canvas = L.DomUtil.create('canvas', 'wind-canvas-layer') as HTMLCanvasElement;
		this._canvas.style.pointerEvents = 'none';
		this._ctx = this._canvas.getContext('2d')!;

		const pane = map.getPane('overlayPane')!;
		pane.appendChild(this._canvas);

		map.on('moveend', this._onMoveEnd, this);

		loadWindConfig().then(() => this._reset());

		return this;
	}

	onRemove(map: L.Map): this {
		map.off('moveend', this._onMoveEnd, this);

		if (this._canvas.parentNode) {
			this._canvas.parentNode.removeChild(this._canvas);
		}

		return this;
	}

	private _onMoveEnd(): void {
		this._reset();
	}

	private _reset(): void {
		if (!this._map) return;

		const size = this._map.getSize();
		const topLeft = this._map.containerPointToLayerPoint([0, 0]);
		L.DomUtil.setPosition(this._canvas, topLeft);

		const p0 = this._map.latLngToContainerPoint([0, 0]);
		const key = `${Math.round(p0.x)},${Math.round(p0.y)},${size.x},${size.y}`;
		if (key === this._lastBoundsKey) return;
		this._lastBoundsKey = key;

		if (this._canvas.width !== size.x || this._canvas.height !== size.y) {
			this._canvas.width = size.x;
			this._canvas.height = size.y;
		}

		this._redraw();
	}

	private _redraw(): void {
		const map = this._map;
		if (!map) return;

		const size = map.getSize();
		const ctx = this._ctx;
		ctx.clearRect(0, 0, size.x, size.y);

		const now = Math.round(Date.now() / TIME_ROUND_MS) * TIME_ROUND_MS;
		const halfLen = ARROW_LENGTH / 2;

		ctx.lineWidth = 1.5;
		ctx.lineCap = 'round';

		for (let px = GRID_SPACING_PX / 2; px < size.x; px += GRID_SPACING_PX) {
			for (let py = GRID_SPACING_PX / 2; py < size.y; py += GRID_SPACING_PX) {
				const latlng = map.containerPointToLatLng([px, py]);
				const worldX = latlng.lng * WORLD_SCALE;
				const worldY = latlng.lat * WORLD_SCALE;

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
