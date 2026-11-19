/**
 * 显示范围（只显示范围内的粒子）相关的纯计算模块。
 *
 * 不依赖 Cesium、不依赖 GL，输入输出都是普通数据，便于单测。
 * 三类范围：
 *   - displayBounds：矩形（经纬度），直接用 uniform 比较，不需要掩膜；
 *   - displayPolygon：多边形（可带洞、可多环），栅格化成掩膜纹理后在着色器里查表；
 *   - 两者可同时给，取交集。
 */

// WGS84
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142451793;
const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const RAD_TO_DEG = 180 / Math.PI;

// 掩膜栅格默认分辨率（长边像素数）。
// 取 1024 而不是风场网格的 nx/ny：风场网格常常只有几公里级分辨率，
// 用它当掩膜会让多边形边界呈块状。
export const DEFAULT_MASK_SIZE = 1024;

// 「范围内随机点」纹理的边长。GPU 重播种时一次纹理采样就能拿到范围内部的
// 随机位置，避免在着色器里做拒绝采样 —— 小多边形（例如省内某个区县）
// 用拒绝采样命中率极低，会让粒子大量卡在范围外、范围内看着稀疏。
export const DEFAULT_SPAWN_TEXTURE_SIZE = 256;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// 输入归一化
// ---------------------------------------------------------------------------

/**
 * 归一化矩形范围。
 * 支持：{west, south, east, north}（含 Cesium.Rectangle）、[west, south, east, north]。
 * @returns {{west:number, south:number, east:number, north:number}|null}
 */
export function normalizeBounds(input) {
  if (!input) return null;

  let west;
  let south;
  let east;
  let north;

  if (Array.isArray(input)) {
    if (input.length < 4) return null;
    [west, south, east, north] = input;
  } else {
    ({ west, south, east, north } = input);
  }

  if (![west, south, east, north].every(isFiniteNumber)) return null;

  return {
    west: Math.min(west, east),
    south: Math.min(south, north),
    east: Math.max(west, east),
    north: Math.max(south, north),
  };
}

// ECEF（Cartesian3）→ 经纬度（度）。迭代法，米级以下精度即可。
function ecefToLonLat(cartesian) {
  const { x, y, z } = cartesian;
  if (![x, y, z].every(isFiniteNumber)) return null;

  const lon = Math.atan2(y, x);
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));

  for (let i = 0; i < 6; i++) {
    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    lat = Math.atan2(z + WGS84_E2 * n * sinLat, p);
  }

  return [lon * RAD_TO_DEG, lat * RAD_TO_DEG];
}

/**
 * 归一化单个点 → [lon, lat]（度）。
 * 支持：[lon, lat]、{lon, lat}、{lng, lat}、Cartographic（弧度）、Cartesian3（ECEF）。
 */
export function normalizePoint(point) {
  if (!point) return null;

  if (Array.isArray(point)) {
    if (point.length < 2 || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) return null;
    return [point[0], point[1]];
  }

  // Cesium.Cartographic：弧度
  if (isFiniteNumber(point.longitude) && isFiniteNumber(point.latitude)) {
    return [point.longitude * RAD_TO_DEG, point.latitude * RAD_TO_DEG];
  }
  if (isFiniteNumber(point.lon) && isFiniteNumber(point.lat)) return [point.lon, point.lat];
  if (isFiniteNumber(point.lng) && isFiniteNumber(point.lat)) return [point.lng, point.lat];
  // Cesium.Cartesian3：ECEF
  if (isFiniteNumber(point.x) && isFiniteNumber(point.y) && isFiniteNumber(point.z)) {
    return ecefToLonLat(point);
  }

  return null;
}

function normalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const points = [];
  for (const item of ring) {
    const point = normalizePoint(item);
    if (point) points.push(point);
  }
  return points.length >= 3 ? points : null;
}

function collectRings(input, out, depth = 0) {
  if (!input || depth > 8) return;

  // Cesium.PolygonHierarchy：{ positions, holes: [{ positions, holes }] }
  if (Array.isArray(input.positions)) {
    const ring = normalizeRing(input.positions);
    if (ring) out.push(ring);
    if (Array.isArray(input.holes)) {
      for (const hole of input.holes) collectRings(hole, out, depth + 1);
    }
    return;
  }

  // GeoJSON：{ type: "Polygon" | "MultiPolygon", coordinates }
  if (input.type === "Polygon" || input.type === "MultiPolygon") {
    collectRings(input.coordinates, out, depth + 1);
    return;
  }
  // GeoJSON Feature
  if (input.type === "Feature" && input.geometry) {
    collectRings(input.geometry, out, depth + 1);
    return;
  }

  if (!Array.isArray(input) || input.length === 0) return;

  // 环数组：[[[lon,lat],...], ...]
  if (Array.isArray(input[0]) && Array.isArray(input[0][0])) {
    for (const ring of input) collectRings(ring, out, depth + 1);
    return;
  }
  // 单个环：[[lon,lat], ...] 或 [{lon,lat}, ...]
  const ring = normalizeRing(input);
  if (ring) out.push(ring);
}

/**
 * 归一化多边形。
 * 支持：单环点数组、环数组、GeoJSON Polygon/MultiPolygon/Feature、Cesium.PolygonHierarchy。
 * @returns {number[][][]|null} rings，每个环是 [[lon, lat], ...]
 */
export function normalizePolygon(input) {
  const rings = [];
  collectRings(input, rings);
  return rings.length ? rings : null;
}

// ---------------------------------------------------------------------------
// 多边形栅格化（扫描线 + even-odd 填充）
// ---------------------------------------------------------------------------

function collectEdges(rings) {
  const edges = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      if (y1 === y2) continue; // 水平边不参与求交
      edges.push([x1, y1, x2, y2]);
    }
  }
  return edges;
}

/**
 * 把多边形环栅格化成掩膜。
 *
 * 行索引 0 对应最南（v = 0），与 WebGL 纹理坐标一致（上传时不翻转 Y）；
 * 采样约定：uv = ((lon - west) / lonSpan, (lat - south) / latSpan)。
 *
 * @param {number[][][]} rings 归一化后的环
 * @param {{west:number,south:number,east:number,north:number}} bounds 掩膜覆盖范围
 * @param {number} maxSize 长边像素数
 * @returns {{width:number, height:number, data:Uint8Array, insideCount:number}|null}
 */
export function rasterizePolygon(rings, bounds, maxSize = DEFAULT_MASK_SIZE) {
  if (!rings || !rings.length) return null;

  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;

  const scale = maxSize / Math.max(lonSpan, latSpan);
  const width = Math.max(2, Math.round(lonSpan * scale));
  const height = Math.max(2, Math.round(latSpan * scale));
  const data = new Uint8Array(width * height);
  const edges = collectEdges(rings);

  let insideCount = 0;

  for (let j = 0; j < height; j++) {
    const lat = bounds.south + ((j + 0.5) / height) * latSpan;
    const crossings = [];
    for (const [x1, y1, x2, y2] of edges) {
      // 半开区间判定，避免顶点处重复计数
      if (y1 > lat !== y2 > lat) {
        crossings.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    const rowOffset = j * width;
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      // 像素中心落在 [x0, x1] 内才填：centerLon = west + (i + 0.5) * lonSpan / width
      const i0 = Math.max(0, Math.ceil(((crossings[k] - bounds.west) / lonSpan) * width - 0.5));
      const i1 = Math.min(
        width - 1,
        Math.floor(((crossings[k + 1] - bounds.west) / lonSpan) * width - 0.5)
      );
      for (let i = i0; i <= i1; i++) {
        if (data[rowOffset + i] === 0) {
          data[rowOffset + i] = 255;
          insideCount++;
        }
      }
    }
  }

  return { width, height, data, insideCount };
}

/**
 * 预生成「范围内随机点」数据：RGBA32F，每个像素存 (lon, lat, 0, 1)。
 *
 * 着色器重播种时一次纹理采样就能拿到范围内部的随机位置；CPU 侧初始播种
 * 用同一份数据。相比在着色器里做拒绝采样，小多边形的命中率是 100%。
 *
 * @param {{width:number,height:number,data:Uint8Array,insideCount:number}} mask
 * @param {{west:number,south:number,east:number,north:number}} maskBounds
 * @param {number} size 纹理边长
 * @returns {{width:number, height:number, data:Float32Array}|null}
 */
export function createSpawnData(mask, maskBounds, size = DEFAULT_SPAWN_TEXTURE_SIZE) {
  if (!mask || !mask.insideCount) return null;

  const { width, height, data } = mask;
  const inside = new Int32Array(mask.insideCount);
  let k = 0;
  for (let idx = 0; idx < width * height; idx++) {
    if (data[idx]) inside[k++] = idx;
  }

  const lonSpan = maskBounds.east - maskBounds.west;
  const latSpan = maskBounds.north - maskBounds.south;
  const out = new Float32Array(size * size * 4);

  for (let s = 0; s < size * size; s++) {
    const idx = inside[(Math.random() * inside.length) | 0];
    const i = idx % width;
    const j = (idx / width) | 0;
    // 半个掩膜像素的抖动：否则小多边形里粒子会全落在同一组栅格点上
    out[s * 4 + 0] = maskBounds.west + ((i + 0.5 + (Math.random() - 0.5)) / width) * lonSpan;
    out[s * 4 + 1] = maskBounds.south + ((j + 0.5 + (Math.random() - 0.5)) / height) * latSpan;
    out[s * 4 + 2] = 0;
    out[s * 4 + 3] = 1;
  }

  return { width: size, height: size, data: out };
}

/** CPU 侧从「范围内随机点」里随机取一个位置 */
export function pickSpawnPoint(spawn) {
  const s = (Math.random() * spawn.width * spawn.height) | 0;
  return [spawn.data[s * 4], spawn.data[s * 4 + 1]];
}

/**
 * 采样掩膜（CPU 侧），与着色器里的 uv 约定一致。
 * @returns {boolean} 是否在范围内
 */
export function sampleMask(mask, bounds, lon, lat) {
  if (!mask) return false;
  const { width, height, data } = mask;
  const u = (lon - bounds.west) / (bounds.east - bounds.west);
  const v = (lat - bounds.south) / (bounds.north - bounds.south);
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return false;
  const i = Math.min(width - 1, Math.floor(u * width));
  const j = Math.min(height - 1, Math.floor(v * height));
  return data[j * width + i] > 127;
}

// ---------------------------------------------------------------------------
// 组合出 region
// ---------------------------------------------------------------------------

function intersectBounds(a, b) {
  if (!a) return b;
  const result = {
    west: Math.max(a.west, b.west),
    south: Math.max(a.south, b.south),
    east: Math.min(a.east, b.east),
    north: Math.min(a.north, b.north),
  };
  return result.east > result.west && result.north > result.south ? result : null;
}

function sameBounds(a, b) {
  return a.west === b.west && a.south === b.south && a.east === b.east && a.north === b.north;
}

/**
 * 由风场数据与图层选项推导出显示范围。
 * @returns {object|null} null 表示不裁剪（保持原行为）
 */
export function createDisplayRegion(windData, options = {}) {
  const dataBounds = windData?.bounds;
  if (!dataBounds) return null;

  const requestedBounds = normalizeBounds(options.displayBounds);
  const rings = normalizePolygon(options.displayPolygon);
  if (!requestedBounds && !rings) return null;

  // 矩形范围与数据范围求交；完全不相交时退化成“空范围”，交给掩膜逻辑处理
  const bounds = requestedBounds ? intersectBounds(requestedBounds, dataBounds) : dataBounds;
  if (requestedBounds && !bounds) {
    console.warn("[cesium-wind-layer-3d] displayBounds 与风场数据范围没有交集，范围内不会有粒子。");
    return null;
  }

  // 既没有多边形、矩形又等于数据范围 → 相当于没裁剪
  if (!rings && sameBounds(bounds, dataBounds)) return null;

  let mask = null;
  let spawn = null;
  if (rings) {
    mask = rasterizePolygon(rings, dataBounds, options.displayMaskResolution ?? DEFAULT_MASK_SIZE);
    if (!mask) return null;
    if (mask.insideCount === 0) {
      console.warn("[cesium-wind-layer-3d] displayPolygon 与风场数据范围没有交集，范围内不会有粒子。");
    } else {
      spawn = createSpawnData(
        mask,
        dataBounds,
        options.displaySpawnTextureSize ?? DEFAULT_SPAWN_TEXTURE_SIZE
      );
    }
  }

  return {
    bounds,
    rings,
    mask,
    spawn,
    // 掩膜与随机点纹理覆盖的都是整个数据范围（与风场 3D 纹理的 lon/lat 映射一致）
    maskBounds: dataBounds,
  };
}

/**
 * 初始粒子数据：位置限制在显示范围内。
 *
 * 布局与着色器一致：(lon, lat, zNorm, fresh)，zNorm ∈ [0,1] 映射最低..最高层。
 * 多边形直接用「范围内随机点」数据取位，矩形则在矩形内均匀取位。
 *
 * @returns {Float32Array}
 */
export function createRandomParticleData(size, dataBounds, region) {
  const total = size * size;
  const data = new Float32Array(total * 4);

  const bounds = region?.bounds ?? dataBounds;
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const spawn = region?.spawn ?? null;

  for (let i = 0; i < total; i++) {
    let lon;
    let lat;

    if (spawn) {
      [lon, lat] = pickSpawnPoint(spawn);
    } else {
      lon = bounds.west + Math.random() * lonSpan;
      lat = bounds.south + Math.random() * latSpan;
    }

    data[i * 4 + 0] = lon;
    data[i * 4 + 1] = lat;
    data[i * 4 + 2] = Math.random(); // zNorm
    data[i * 4 + 3] = 1.0; // fresh 标记：首帧作单点渲染，随后转为流线
  }

  return data;
}
