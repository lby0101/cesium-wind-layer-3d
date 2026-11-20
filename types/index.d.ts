import type { Cartesian3, Cartographic, PolygonHierarchy, Rectangle, Viewer } from "cesium";

export interface WindBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface WindComponent {
  array: Float32Array;
}

export interface WindSpeed {
  array: Float32Array;
  min: number;
  max: number;
}

export interface WindData3D {
  u: WindComponent;
  v: WindComponent;
  w: WindComponent;
  speed?: WindSpeed;
  nx: number;
  ny: number;
  nz: number;
  bounds: WindBounds;
  levels: number[];
}

export interface NumberRange {
  min: number;
  max: number;
}

/** 经纬度点：[lon, lat]（度）、{lon, lat}、Cartographic（弧度）或 Cartesian3（ECEF） */
export type DisplayPoint = [number, number] | { lon: number; lat: number } | Cartographic | Cartesian3;

/** 单个环（闭合或不闭合都可以，首尾不重复时自动按闭合处理） */
export type DisplayRing = DisplayPoint[];

/** 多边形：单环、环数组（第一个是外环，其余是洞）、GeoJSON 或 Cesium.PolygonHierarchy */
export type DisplayPolygon =
  | DisplayRing
  | DisplayRing[]
  | { type: "Polygon" | "MultiPolygon"; coordinates: unknown }
  | { type: "Feature"; geometry: unknown }
  | PolygonHierarchy;

export interface WindLayerOptions {
  particlesTextureSize: number;
  dropRate: number;
  dropRateBump: number;
  speedFactor: number;
  lineWidth: NumberRange;
  lineLength: NumberRange;
  heightScale: number;
  colors: string[];
  flipY: boolean;
  useViewerBounds: boolean;
  /** 色带/线长/透明度的归一化域，缺省为数据速度的 [min, p95] */
  domain?: NumberRange;
  displayRange?: NumberRange;
  dynamic: boolean;
  /** 只显示该矩形范围内的粒子（与 displayPolygon 同时给出时取交集） */
  displayBounds?: WindBounds | [number, number, number, number] | Rectangle;
  /** 只显示该多边形内的粒子 */
  displayPolygon?: DisplayPolygon;
  /** 多边形掩膜长边像素数，默认 1024。多边形很小、边界看着粗糙时可以调大 */
  displayMaskResolution?: number;
  /** 「范围内随机点」纹理边长，默认 256。粒子总数远超该值时可以调大 */
  displaySpawnTextureSize?: number;
}

export const DefaultOptions: WindLayerOptions;

export class WindLayer3D {
  constructor(
    viewer: Viewer,
    windData: WindData3D,
    options?: Partial<WindLayerOptions>
  );

  show: boolean;
  readonly viewer: Viewer;
  readonly scene: import("cesium").Scene;
  /** 当前生效的显示范围，null 表示未裁剪 */
  readonly region: {
    bounds: WindBounds;
    rings: number[][][] | null;
    mask: { width: number; height: number; data: Uint8Array; insideCount: number } | null;
    maskBounds: WindBounds;
  } | null;

  updateWindData(data: WindData3D): void;
  updateOptions(options: Partial<WindLayerOptions>): void;
  /** 设置/清除显示范围；传 null 清除对应范围 */
  setDisplayRegion(region?: { displayBounds?: WindLayerOptions["displayBounds"]; displayPolygon?: DisplayPolygon }): void;
  zoomTo(duration?: number): void;
  isDestroyed(): boolean;
  destroy(): void;
}

export default WindLayer3D;