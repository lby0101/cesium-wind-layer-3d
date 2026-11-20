# cesium-wind-layer-3d

A WebGL2-based 3D wind field layer for CesiumJS, using 3D textures and GPU particle advection (GPGPU) for high-performance dynamic wind visualization.

> **Note:** This is a **3D wind field** package, built upon the 2D wind layer package [`cesium-wind-layer`](https://www.npmjs.com/package/cesium-wind-layer) by adding the vertical `w` component for true 3D wind field visualization. This package uses `(u, v, w)` three-component 3D grid data with particles advecting in 3D space.

## Features

- WebGL2 native 3D textures (`sampler3D`) for wind field storage with hardware trilinear interpolation
- GPU particle advection (Runge-Kutta 2) with millions of particles in real-time
- Speed-adaptive line width/length with color ramp mapping
- Runtime dynamic data replacement, parameter adjustment, and visibility control
- Restrict particles to a rectangle or polygon region
- Supports both 2D and 3D scene modes

## Installation

```bash
npm install cesium-wind-layer-3d
```

`cesium` is a peer dependency. Ensure CesiumJS (^1.142.0) is installed.

## Quick Start

```js
import * as Cesium from "cesium";
import { WindLayer3D } from "cesium-wind-layer-3d";

const viewer = new Cesium.Viewer("container");

const windData = {
  u: { array: uArray },   // Float32Array(nx*ny*nz)
  v: { array: vArray },
  w: { array: wArray },
  nx, ny, nz,
  bounds: { west, south, east, north },
  levels: [500, 1500, 3000, 5500], // height per level (meters), ascending
};

const layer = new WindLayer3D(viewer, windData, {
  colors: ["rgb(175,240,91)", "rgb(110,64,170)"],
  particlesTextureSize: 256,
});

layer.zoomTo(2);
```

## Data Contract

### WindData3D

| Field | Type | Description |
|-------|------|-------------|
| `u` / `v` / `w` | `{ array: Float32Array }` | East/North/Vertical wind components (m/s), length `nx*ny*nz` |
| `speed` | `{ array, min, max }` | Optional, computed from u/v/w if missing |
| `nx` / `ny` / `nz` | `number` | Longitude/Latitude/Vertical grid dimensions |
| `bounds` | `{ west, south, east, north }` | Data extent (degrees) |
| `levels` | `number[]` | Height per level (meters), ascending, length `nz` |

Array layout: `index = (z * ny + y) * nx + x`, x=longitude (west→east), y=latitude (south→north), z=level (low→high).

## Options (WindLayerOptions)

| Field | Default | Description |
|-------|---------|-------------|
| `particlesTextureSize` | `128` | Particle texture size, total particles = size² |
| `dropRate` | `0.003` | Base drop rate |
| `dropRateBump` | `0.01` | Speed-dependent drop increment |
| `speedFactor` | `1.0` | Speed scaling factor |
| `lineWidth` | `{ min: 1, max: 2 }` | Line width range (pixels) |
| `lineLength` | `{ min: 20, max: 100 }` | Line length range |
| `heightScale` | `1` | Height exaggeration |
| `colors` | `["white"]` | Color ramp (CSS color array) |
| `flipY` | `false` | Flip Y axis |
| `useViewerBounds` | `false` | Seed particles in viewport bounds |
| `domain` | `undefined` | Normalization domain for color ramp / line length / alpha; defaults to the data speed `[min, p95]` |
| `displayRange` | `undefined` | Display range |
| `displayBounds` | `undefined` | **Only show particles inside this rectangle** (see below) |
| `displayPolygon` | `undefined` | **Only show particles inside this polygon** (see below) |
| `displayMaskResolution` | `1024` | Long-side resolution of the polygon mask |
| `displaySpawnTextureSize` | `256` | Side length of the "random points inside region" texture |
| `dynamic` | `true` | Enable dynamic updates |

## Limiting particles to a region

`displayBounds` (rectangle) and `displayPolygon` (polygon) restrict particles to a region:
particles inside advect normally, ones leaving the region are recycled and respawned inside,
and particles outside the region are never rendered. Both can be given at once (intersection).

```js
const layer = new WindLayer3D(viewer, windData, {
  // Rectangle: {west, south, east, north} | Cesium.Rectangle | [w, s, e, n]
  displayBounds: { west: 118.2, south: 31.2, east: 120.2, north: 32.6 },
});

// Polygon: [[lon, lat], ...] (single ring), an array of rings (first is the outer
// ring, the rest are holes), GeoJSON Polygon/MultiPolygon/Feature, or
// Cesium.PolygonHierarchy
layer.setDisplayRegion({
  displayPolygon: [
    [[117.9, 32.45], [118.9, 32.8], [119.75, 32.35], [119.6, 31.35], [118.6, 31.05]],
  ],
});

layer.setDisplayRegion({ displayPolygon: null }); // clear, back to the full extent
```

- The region is intersected with the data extent; a warning is logged if they do not overlap.
- Points accept `[lon, lat]`, `{lon, lat}` / `{lng, lat}`, `Cartographic` (radians) and
  `Cartesian3` (ECEF).
- With a region set, `zoomTo()` flies to the region instead of the whole data extent.
- Reseeding inside a polygon samples a precomputed "random points inside region" texture,
  so even a tiny region (a district inside a province) stays densely populated.
- Changing the region rebuilds the mask texture and reseeds particles;
  raising `displayMaskResolution` gives a tighter boundary at the cost of a few tens of
  milliseconds during initialization.

## API

| Method | Description |
|--------|-------------|
| `show` | Read/write property for visibility control |
| `updateWindData(data)` | Replace wind data at runtime |
| `updateOptions(options)` | Update options at runtime |
| `setDisplayRegion({ displayBounds, displayPolygon })` | Set/clear the display region at runtime |
| `zoomTo(duration?)` | Fly to the display region (data extent when unset) |
| `destroy()` | Destroy all resources |
| `isDestroyed()` | Check if destroyed |

## Example

```bash
git clone https://github.com/lby0102/cesium-wind-layer-3d.git
cd cesium-wind-layer-3d
npm install
npm run dev
```

Browser will show global 3D wind particle animation (example uses programmatically generated data, no external data files needed).

## Browser Requirements

- WebGL2 (enabled by default in CesiumJS 1.104+)
- Requires `EXT_color_buffer_float` (floating-point texture rendering) and native 3D texture support

## License

MIT
