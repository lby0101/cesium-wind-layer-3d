import { describe, it, expect, vi } from "vitest";
import {
  normalizeBounds,
  normalizePoint,
  normalizePolygon,
  rasterizePolygon,
  sampleMask,
  createSpawnData,
  pickSpawnPoint,
  createDisplayRegion,
  createRandomParticleData,
} from "../src/displayRegion.js";

const DATA_BOUNDS = { west: 116, south: 30, east: 122, north: 36 };

// 与 segmentDraw 顶点着色器一致的 lon/lat/height → ECEF
function lonLatToEcef(lon, lat, h = 0) {
  const a = 6378137.0;
  const b = 6356752.3142;
  const e2 = 6.69437999014e-3;
  const latitude = (lat * Math.PI) / 180;
  const longitude = (lon * Math.PI) / 180;
  const cosLat = Math.cos(latitude);
  const sinLat = Math.sin(latitude);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  return {
    x: (n + h) * cosLat * Math.cos(longitude),
    y: (n + h) * cosLat * Math.sin(longitude),
    z: ((b * b) / (a * a) * n + h) * sinLat,
  };
}

describe("normalizeBounds", () => {
  it("接受对象与数组，并把反向坐标归正", () => {
    expect(normalizeBounds({ west: 1, south: 2, east: 3, north: 4 })).toEqual({
      west: 1,
      south: 2,
      east: 3,
      north: 4,
    });
    expect(normalizeBounds([3, 4, 1, 2])).toEqual({ west: 1, south: 2, east: 3, north: 4 });
  });

  it("Cesium.Rectangle 结构（west/south/east/north）直接可用", () => {
    const rectangleLike = { west: 116.5, south: 31.5, east: 117.5, north: 32.5, width: 1, height: 1 };
    expect(normalizeBounds(rectangleLike)).toEqual({
      west: 116.5,
      south: 31.5,
      east: 117.5,
      north: 32.5,
    });
  });

  it("缺字段或非数值返回 null", () => {
    expect(normalizeBounds(null)).toBeNull();
    expect(normalizeBounds([1, 2, 3])).toBeNull();
    expect(normalizeBounds({ west: 1, south: 2, east: 3 })).toBeNull();
    expect(normalizeBounds({ west: "1", south: 2, east: 3, north: 4 })).toBeNull();
  });
});

describe("normalizePoint", () => {
  it("支持数组 / {lon,lat} / {lng,lat}", () => {
    expect(normalizePoint([118.5, 31.25])).toEqual([118.5, 31.25]);
    expect(normalizePoint({ lon: 118.5, lat: 31.25 })).toEqual([118.5, 31.25]);
    expect(normalizePoint({ lng: 118.5, lat: 31.25 })).toEqual([118.5, 31.25]);
  });

  it("Cartographic（弧度）转成度", () => {
    const lon = (118.5 * Math.PI) / 180;
    const lat = (31.25 * Math.PI) / 180;
    const [outLon, outLat] = normalizePoint({ longitude: lon, latitude: lat, height: 0 });
    expect(outLon).toBeCloseTo(118.5, 9);
    expect(outLat).toBeCloseTo(31.25, 9);
  });

  it("Cartesian3（ECEF）与正算互为逆运算", () => {
    for (const [lon, lat] of [
      [118.5, 31.25],
      [0, 0],
      [-121.9, 35.1],
      [179.5, -80.25],
    ]) {
      const [outLon, outLat] = normalizePoint(lonLatToEcef(lon, lat, 1200));
      expect(outLon).toBeCloseTo(lon, 6);
      expect(outLat).toBeCloseTo(lat, 6);
    }
  });

  it("非法点返回 null", () => {
    expect(normalizePoint(null)).toBeNull();
    expect(normalizePoint([1])).toBeNull();
    expect(normalizePoint({ x: 1, y: 2 })).toBeNull();
  });
});

describe("normalizePolygon", () => {
  it("单环点数组", () => {
    const rings = normalizePolygon([
      [116, 30],
      [117, 30],
      [117, 31],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(3);
  });

  it("环数组与 GeoJSON Polygon（带洞）", () => {
    const rings = normalizePolygon([
      [
        [116, 30],
        [118, 30],
        [118, 32],
        [116, 32],
      ],
      [
        [116.5, 30.5],
        [117.5, 30.5],
        [117.5, 31.5],
        [116.5, 31.5],
      ],
    ]);
    expect(rings).toHaveLength(2);

    const geoJson = normalizePolygon({
      type: "Polygon",
      coordinates: [
        [
          [116, 30],
          [118, 30],
          [118, 32],
          [116, 32],
          [116, 30],
        ],
        [
          [116.5, 30.5],
          [117.5, 30.5],
          [117.5, 31.5],
          [116.5, 31.5],
          [116.5, 30.5],
        ],
      ],
    });
    expect(geoJson).toHaveLength(2);
  });

  it("GeoJSON MultiPolygon 与 Feature", () => {
    const multi = {
      type: "MultiPolygon",
      coordinates: [
        [[[116, 30], [117, 30], [117, 31], [116, 31]]],
        [[[119, 33], [120, 33], [120, 34], [119, 34]]],
      ],
    };
    expect(normalizePolygon(multi)).toHaveLength(2);
    expect(normalizePolygon({ type: "Feature", geometry: multi })).toHaveLength(2);
  });

  it("Cesium.PolygonHierarchy（positions + holes）", () => {
    const hierarchy = {
      positions: [lonLatToEcef(116, 30), lonLatToEcef(118, 30), lonLatToEcef(118, 32)],
      holes: [
        {
          positions: [lonLatToEcef(116.5, 30.5), lonLatToEcef(117.5, 30.5), lonLatToEcef(117.5, 31.5)],
          holes: [],
        },
      ],
    };
    const rings = normalizePolygon(hierarchy);
    expect(rings).toHaveLength(2);
    expect(rings[0][0][0]).toBeCloseTo(116, 6);
    expect(rings[0][0][1]).toBeCloseTo(30, 6);
  });

  it("点数不足或空输入返回 null", () => {
    expect(normalizePolygon(null)).toBeNull();
    expect(normalizePolygon([])).toBeNull();
    expect(
      normalizePolygon([
        [116, 30],
        [117, 30],
      ])
    ).toBeNull();
  });
});

describe("rasterizePolygon / sampleMask", () => {
  const square = [
    [
      [117, 31],
      [119, 31],
      [119, 33],
      [117, 33],
    ],
  ];

  it("矩形多边形：掩膜覆盖率与几何面积一致，行序为南→北", () => {
    const mask = rasterizePolygon(square, DATA_BOUNDS, 600);
    expect(mask.width).toBe(600);
    expect(mask.height).toBe(600);

    // 2°×2° / (6°×6°) = 1/9
    const ratio = mask.insideCount / (mask.width * mask.height);
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(0.12);

    // 第一行（最南）不应命中，最后一行（最北）应命中
    expect(sampleMask(mask, DATA_BOUNDS, 118, 30.2)).toBe(false);
    expect(sampleMask(mask, DATA_BOUNDS, 118, 33.5)).toBe(false);
    expect(sampleMask(mask, DATA_BOUNDS, 118, 32.9)).toBe(true);
  });

  it("内部点命中、外部点不命中、洞不命中", () => {
    const ringWithHole = [
      square[0],
      [
        [117.5, 31.5],
        [118.5, 31.5],
        [118.5, 32.5],
        [117.5, 32.5],
      ],
    ];
    const mask = rasterizePolygon(ringWithHole, DATA_BOUNDS, 600);

    expect(sampleMask(mask, DATA_BOUNDS, 118, 32)).toBe(false); // 洞
    expect(sampleMask(mask, DATA_BOUNDS, 117.2, 31.2)).toBe(true); // 环内
    expect(sampleMask(mask, DATA_BOUNDS, 120, 32)).toBe(false); // 环外
    expect(sampleMask(mask, DATA_BOUNDS, 118, 40)).toBe(false); // 范围外
  });

  it("凹多边形（L 形）拐角处不误判", () => {
    const lShape = [
      [
        [117, 31],
        [119, 31],
        [119, 32],
        [118, 32],
        [118, 33],
        [117, 33],
      ],
    ];
    const mask = rasterizePolygon(lShape, DATA_BOUNDS, 600);
    expect(sampleMask(mask, DATA_BOUNDS, 117.5, 32.5)).toBe(true); // 竖边
    expect(sampleMask(mask, DATA_BOUNDS, 118.5, 32.5)).toBe(false); // 缺口
    expect(sampleMask(mask, DATA_BOUNDS, 118.5, 31.5)).toBe(true); // 横边
  });

  it("掩膜边界与解析判定在像素尺度内一致", () => {
    const mask = rasterizePolygon(square, DATA_BOUNDS, 600);
    const texelLon = (DATA_BOUNDS.east - DATA_BOUNDS.west) / mask.width;
    const texelLat = (DATA_BOUNDS.north - DATA_BOUNDS.south) / mask.height;

    for (let i = 0; i < 400; i++) {
      const lon = DATA_BOUNDS.west + Math.random() * 6;
      const lat = DATA_BOUNDS.south + Math.random() * 6;
      const analytic = lon > 117 && lon < 119 && lat > 31 && lat < 33;
      const inMask = sampleMask(mask, DATA_BOUNDS, lon, lat);
      // 只有贴着边界的采样点允许差一个像素
      const nearEdge =
        Math.abs(lon - 117) < texelLon ||
        Math.abs(lon - 119) < texelLon ||
        Math.abs(lat - 31) < texelLat ||
        Math.abs(lat - 33) < texelLat;
      if (!nearEdge) expect(inMask).toBe(analytic);
    }
  });
});

describe("createDisplayRegion", () => {
  const windData = { bounds: DATA_BOUNDS };

  it("未传范围 → null（不裁剪）", () => {
    expect(createDisplayRegion(windData, {})).toBeNull();
    expect(createDisplayRegion(windData, { displayBounds: null, displayPolygon: null })).toBeNull();
  });

  it("矩形等于数据范围 → null（等价于不裁剪）", () => {
    expect(createDisplayRegion(windData, { displayBounds: { ...DATA_BOUNDS } })).toBeNull();
  });

  it("矩形超出数据范围时被裁剪到数据范围", () => {
    const region = createDisplayRegion(windData, {
      displayBounds: { west: 100, south: 20, east: 130, north: 40 },
    });
    expect(region).toBeNull(); // 裁剪后等于数据范围

    const partial = createDisplayRegion(windData, {
      displayBounds: { west: 100, south: 20, east: 118, north: 40 },
    });
    expect(partial.bounds).toEqual({ west: 116, south: 30, east: 118, north: 36 });
    expect(partial.mask).toBeNull();
  });

  it("多边形生成掩膜，矩形与多边形同时给取交集", () => {
    const region = createDisplayRegion(windData, {
      displayBounds: [116, 30, 119, 33],
      displayPolygon: [
        [
          [117, 31],
          [119, 31],
          [119, 33],
          [117, 33],
        ],
      ],
    });
    expect(region.bounds).toEqual({ west: 116, south: 30, east: 119, north: 33 });
    expect(region.mask).not.toBeNull();
    expect(region.maskBounds).toEqual(DATA_BOUNDS);
  });

  it("范围与数据无交集 → null 并告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createDisplayRegion(windData, { displayBounds: [130, 40, 140, 50] })).toBeNull();
    expect(warn).toHaveBeenCalled();

    warn.mockClear();
    const region = createDisplayRegion(windData, {
      displayPolygon: [
        [
          [130, 40],
          [131, 40],
          [131, 41],
        ],
      ],
    });
    expect(region).not.toBeNull(); // 有掩膜，但全 0
    expect(region.mask.insideCount).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("displayMaskResolution 生效", () => {
    const region = createDisplayRegion(windData, {
      displayPolygon: [
        [
          [117, 31],
          [119, 31],
          [119, 33],
        ],
      ],
      displayMaskResolution: 256,
    });
    expect(region.mask.width).toBe(256);
    expect(region.mask.height).toBe(256);
  });
});

describe("createRandomParticleData", () => {
  const size = 32;

  it("无范围时按数据范围均匀播种", () => {
    const data = createRandomParticleData(size, DATA_BOUNDS, null);
    expect(data.length).toBe(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      expect(data[i * 4]).toBeGreaterThanOrEqual(DATA_BOUNDS.west);
      expect(data[i * 4]).toBeLessThanOrEqual(DATA_BOUNDS.east);
      expect(data[i * 4 + 1]).toBeGreaterThanOrEqual(DATA_BOUNDS.south);
      expect(data[i * 4 + 1]).toBeLessThanOrEqual(DATA_BOUNDS.north);
      expect(data[i * 4 + 2]).toBeGreaterThanOrEqual(0);
      expect(data[i * 4 + 2]).toBeLessThanOrEqual(1);
      expect(data[i * 4 + 3]).toBe(1);
    }
  });

  it("矩形范围：所有粒子落在范围内", () => {
    const bounds = { west: 118, south: 32, east: 119, north: 33 };
    const data = createRandomParticleData(size, DATA_BOUNDS, { bounds, mask: null });
    for (let i = 0; i < size * size; i++) {
      expect(data[i * 4]).toBeGreaterThanOrEqual(118);
      expect(data[i * 4]).toBeLessThanOrEqual(119);
      expect(data[i * 4 + 1]).toBeGreaterThanOrEqual(32);
      expect(data[i * 4 + 1]).toBeLessThanOrEqual(33);
    }
  });

  it("多边形范围：粒子几乎全部落在掩膜内（只有贴边抖动会略微溢出）", () => {
    const region = createDisplayRegion(
      { bounds: DATA_BOUNDS },
      {
        displayPolygon: [
          [
            [118, 32],
            [119, 32],
            [119, 33],
            [118, 33],
          ],
        ],
      }
    );
    const data = createRandomParticleData(size, DATA_BOUNDS, region);

    let inside = 0;
    for (let i = 0; i < size * size; i++) {
      if (sampleMask(region.mask, region.maskBounds, data[i * 4], data[i * 4 + 1])) inside++;
    }
    expect(inside / (size * size)).toBeGreaterThan(0.95);
  });

  it("小多边形（占数据范围 0.3%）播种命中率依然接近 100%", () => {
    // 6° × 6° 的数据范围里放一个 0.4° × 0.4° 的小多边形：
    // 这是「省内某个区县」的典型尺度，拒绝采样在这里会大量落空
    const region = createDisplayRegion(
      { bounds: DATA_BOUNDS },
      {
        displayPolygon: [
          [
            [118.0, 32.0],
            [118.4, 32.0],
            [118.4, 32.4],
            [118.0, 32.4],
          ],
        ],
      }
    );
    const data = createRandomParticleData(64, DATA_BOUNDS, region);

    let inside = 0;
    for (let i = 0; i < 64 * 64; i++) {
      if (sampleMask(region.mask, region.maskBounds, data[i * 4], data[i * 4 + 1])) inside++;
    }
    expect(inside / (64 * 64)).toBeGreaterThan(0.95);

    // 且不是所有粒子挤在同几个点上（抖动生效）
    const unique = new Set();
    for (let i = 0; i < 64 * 64; i++) {
      unique.add(`${data[i * 4].toFixed(4)},${data[i * 4 + 1].toFixed(4)}`);
    }
    expect(unique.size).toBeGreaterThan(100);
  });
});

describe("createSpawnData / pickSpawnPoint", () => {
  const mask = rasterizePolygon(
    [
      [
        [117, 31],
        [119, 31],
        [119, 33],
        [117, 33],
      ],
    ],
    DATA_BOUNDS,
    256
  );

  it("每个随机点都落在多边形内", () => {
    const spawn = createSpawnData(mask, DATA_BOUNDS, 64);
    expect(spawn.width).toBe(64);
    expect(spawn.height).toBe(64);
    expect(spawn.data.length).toBe(64 * 64 * 4);

    for (let s = 0; s < 64 * 64; s++) {
      const lon = spawn.data[s * 4];
      const lat = spawn.data[s * 4 + 1];
      expect(lon).toBeGreaterThan(116.99);
      expect(lon).toBeLessThan(119.01);
      expect(lat).toBeGreaterThan(30.99);
      expect(lat).toBeLessThan(33.01);
      expect(spawn.data[s * 4 + 3]).toBe(1);
    }

    const [lon, lat] = pickSpawnPoint(spawn);
    expect(sampleMask(mask, DATA_BOUNDS, lon, lat)).toBe(true);
  });

  it("空掩膜返回 null", () => {
    const empty = { width: 2, height: 2, data: new Uint8Array(4), insideCount: 0 };
    expect(createSpawnData(empty, DATA_BOUNDS, 8)).toBeNull();
  });
});
