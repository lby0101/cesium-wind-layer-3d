import { Cartesian2, Rectangle } from "cesium";
import { WindParticleSystem } from "./windParticleSystem";
import { deepMerge, computeSpeedFromComponents } from "./utils";
import { createDisplayRegion } from "./displayRegion";
import { computeViewportParameters } from "./viewportParameters";

export const DefaultOptions = {
  particlesTextureSize: 128,
  dropRate: 0.003,
  dropRateBump: 0.01,
  speedFactor: 1.0,
  lineWidth: { min: 1, max: 2 },
  lineLength: { min: 20, max: 100 },
  heightScale: 1,
  colors: ["white"],
  flipY: false,
  useViewerBounds: false,
  domain: undefined,
  displayRange: undefined,
  dynamic: true,
  // 显示范围：只显示范围内的粒子，两者可同时给（取交集），缺省不裁剪
  displayBounds: undefined,
  displayPolygon: undefined,
  displayMaskResolution: undefined,
  displaySpawnTextureSize: undefined,
};

// 这些选项变化会改变「显示范围」，需要重建掩膜纹理并重新播种粒子
const REGION_OPTION_KEYS = [
  "displayBounds",
  "displayPolygon",
  "displayMaskResolution",
  "displaySpawnTextureSize",
];

export class WindLayer3D {
  constructor(viewer, windData, options) {
    this._show = true;
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.options = { ...DefaultOptions, ...options };
    this.windData = this.processWindData(windData);
    this.region = createDisplayRegion(this.windData, this.options);

    this.viewerParameters = {
      lonRange: new Cartesian2(-180, 180),
      latRange: new Cartesian2(-90, 90),
      pixelSize: 1000.0,
      sceneMode: this.scene.mode,
    };
    this.updateViewerParameters();

    this.particleSystem = new WindParticleSystem(
      this.scene.context,
      this.windData,
      this.options,
      this.viewerParameters,
      this.scene,
      this.region
    );
    this.add();

    this._updateViewerParametersBound = this.updateViewerParameters.bind(this);
    this.setupEventListeners();
  }

  get show() {
    return this._show;
  }

  set show(value) {
    if (this._show !== value) {
      this._show = value;
      this.updatePrimitivesVisibility(value);
    }
  }

  setupEventListeners() {
    this.viewer.camera.percentageChanged = 0.01;
    this.viewer.camera.changed.addEventListener(this._updateViewerParametersBound);
    this.scene.morphComplete.addEventListener(this._updateViewerParametersBound);
    window.addEventListener("resize", this._updateViewerParametersBound);
  }

  removeEventListeners() {
    this.viewer.camera.changed.removeEventListener(this._updateViewerParametersBound);
    this.scene.morphComplete.removeEventListener(this._updateViewerParametersBound);
    window.removeEventListener("resize", this._updateViewerParametersBound);
  }

  processWindData(windData) {
    if (!windData.speed?.array) {
      const { array, min, max } = computeSpeedFromComponents(
        windData.u.array,
        windData.v.array,
        windData.w.array
      );
      windData = { ...windData, speed: { array, min, max } };
    }
    return windData;
  }

  updateViewerParameters() {
    const scene = this.viewer.scene;
    const canvas = scene.canvas;

    // 角点射线打空（看到天空）时用该方位的地平线切点代替，
    // 保证 pixelSize 随缩放连续变化，不会冻结在旧值上
    const parameters = computeViewportParameters({
      camera: scene.camera,
      ellipsoid: scene.globe.ellipsoid,
      canvasWidth: canvas.clientWidth,
      canvasHeight: canvas.clientHeight,
      sceneMode: scene.mode,
      bounds: this.windData.bounds,
    });

    if (parameters) {
      this.viewerParameters.lonRange = parameters.lonRange;
      this.viewerParameters.latRange = parameters.latRange;
      if (parameters.pixelSize > 0) {
        this.viewerParameters.pixelSize = parameters.pixelSize;
      }
    }

    this.viewerParameters.sceneMode = this.scene.mode;
    this.particleSystem?.applyViewerParameters(this.viewerParameters);
  }

  updateWindData(data) {
    if (this._isDestroyed) return;
    this.windData = this.processWindData(data);
    // 数据范围可能变了，显示范围要跟着重算（掩膜覆盖的是数据范围）
    this.region = createDisplayRegion(this.windData, this.options);
    this.particleSystem.updateWindData(this.windData, this.region);
    this.viewer.scene.requestRender();
  }

  updateOptions(options) {
    if (this._isDestroyed) return;
    const regionChanged = REGION_OPTION_KEYS.some((key) => key in options);
    this.options = deepMerge(options, this.options);
    this.particleSystem.changeOptions(options);
    if (regionChanged) {
      this.region = createDisplayRegion(this.windData, this.options);
      this.particleSystem.setRegion(this.region);
    }
    this.viewer.scene.requestRender();
  }

  /**
   * 设置/清除显示范围（只显示范围内的粒子）。
   * @param {{displayBounds?: *, displayPolygon?: *}} region
   *   displayBounds  —— 矩形，{west,south,east,north} | Cesium.Rectangle | [w,s,e,n]
   *   displayPolygon —— 多边形，[[lon,lat],...] | [[[lon,lat],...],...] |
   *                     GeoJSON Polygon/MultiPolygon/Feature | Cesium.PolygonHierarchy
   *   传 null / undefined 表示清除对应范围。
   */
  setDisplayRegion({ displayBounds, displayPolygon } = {}) {
    this.updateOptions({ displayBounds, displayPolygon });
  }

  zoomTo(duration = 0) {
    // 设置了显示范围时，飞到范围而不是整个数据范围
    const bounds = this.region?.bounds ?? this.windData.bounds;
    if (bounds) {
      const rectangle = Rectangle.fromDegrees(
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north
      );
      this.viewer.camera.flyTo({ destination: rectangle, duration });
    }
  }

  add() {
    this.primitives = this.particleSystem.getPrimitives();
    this.primitives.forEach((primitive) => {
      this.scene.primitives.add(primitive);
    });
  }

  remove() {
    this.primitives.forEach((primitive) => {
      this.scene.primitives.remove(primitive);
    });
    this.primitives = [];
  }

  isDestroyed() {
    return this._isDestroyed;
  }

  destroy() {
    this.remove();
    this.removeEventListeners();
    this.particleSystem.destroy();
    this._isDestroyed = true;
  }

  updatePrimitivesVisibility(visibility) {
    const show = visibility !== undefined ? visibility : this._show;
    this.primitives.forEach((primitive) => {
      primitive.show = show;
    });
  }
}

export default WindLayer3D;
