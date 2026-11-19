import { describe, it, expect } from "vitest";
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  IntersectionTests,
  Ray,
  SceneMode,
} from "cesium";
import { computeViewportParameters } from "../src/viewportParameters.js";

const GLOBE_BOUNDS = { west: -180, south: -90, east: 180, north: 90 };
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 450;
const FOV = Math.PI / 3;
const ASPECT = CANVAS_WIDTH / CANVAS_HEIGHT;
const ellipsoid = Ellipsoid.WGS84;

// 用真实的 Cesium 数学构造一个只实现本模块所需接口的相机：
// positionWC / pickEllipsoid / getPickRay，射线方向与透视视锥一致。
function createCamera({ longitude = 118, latitude = 32, height = 100e3, tilt = 0 } = {}) {
  const lon = (longitude * Math.PI) / 180;
  const lat = (latitude * Math.PI) / 180;
  const tiltRad = (tilt * Math.PI) / 180;
  const cartographic = new Cartographic(lon, lat, height);
  const positionWC = ellipsoid.cartographicToCartesian(cartographic);
  const normal = ellipsoid.geodeticSurfaceNormalCartographic(cartographic);
  const down = Cartesian3.negate(normal, new Cartesian3());
  const east = new Cartesian3(-Math.sin(lon), Math.cos(lon), 0);
  const north = Cartesian3.cross(normal, east, new Cartesian3());

  const forward = Cartesian3.normalize(
    Cartesian3.add(
      Cartesian3.multiplyByScalar(down, Math.cos(tiltRad), new Cartesian3()),
      Cartesian3.multiplyByScalar(north, Math.sin(tiltRad), new Cartesian3()),
      new Cartesian3()
    ),
    new Cartesian3()
  );
  const right = east;
  const up = Cartesian3.normalize(Cartesian3.cross(right, forward, new Cartesian3()), new Cartesian3());

  const tanH = Math.tan(FOV / 2);
  const tanV = tanH / ASPECT;

  const camera = {
    positionWC,
    getPickRay(windowPosition) {
      const ndcX = (2 * windowPosition.x) / CANVAS_WIDTH - 1;
      const ndcY = 1 - (2 * windowPosition.y) / CANVAS_HEIGHT;
      const direction = Cartesian3.clone(forward);
      Cartesian3.add(direction, Cartesian3.multiplyByScalar(right, ndcX * tanH, new Cartesian3()), direction);
      Cartesian3.add(direction, Cartesian3.multiplyByScalar(up, ndcY * tanV, new Cartesian3()), direction);
      Cartesian3.normalize(direction, direction);
      return new Ray(positionWC, direction);
    },
    pickEllipsoid(windowPosition, targetEllipsoid = ellipsoid) {
      const ray = this.getPickRay(windowPosition);
      const hit = IntersectionTests.rayEllipsoid(ray, targetEllipsoid);
      if (!hit || hit.start < 0) return undefined;
      return Cartesian3.add(
        ray.origin,
        Cartesian3.multiplyByScalar(ray.direction, hit.start, new Cartesian3()),
        new Cartesian3()
      );
    },
  };
  return camera;
}

function compute(cameraOptions, sceneMode = SceneMode.SCENE3D) {
  return computeViewportParameters({
    camera: createCamera(cameraOptions),
    ellipsoid,
    canvasWidth: CANVAS_WIDTH,
    canvasHeight: CANVAS_HEIGHT,
    sceneMode,
    bounds: GLOBE_BOUNDS,
  });
}

describe("computeViewportParameters", () => {
  it("角点全部命中时返回视口范围和有效的 pixelSize", () => {
    const params = compute({ height: 100e3, tilt: 0 });

    expect(params).not.toBeNull();
    expect(params.pixelSize).toBeGreaterThan(0);
    expect(params.pixelSize).toBeLessThan(20);
    expect(params.lonRange.x).toBeLessThan(params.lonRange.y);
    expect(params.latRange.x).toBeLessThan(params.latRange.y);
    expect(params.lonRange.x).toBeGreaterThanOrEqual(GLOBE_BOUNDS.west);
    expect(params.lonRange.y).toBeLessThanOrEqual(GLOBE_BOUNDS.east);
  });

  it("角点看到天空时用地平线切点补全，不再返回 null（旧逻辑会整段跳过）", () => {
    // 3 万公里高度、地球只占屏幕一部分，四个角点都看不到地面
    const skyCamera = createCamera({ height: 30e6, tilt: 0 });
    for (const corner of [
      [0, 0],
      [0, CANVAS_HEIGHT],
      [CANVAS_WIDTH, 0],
      [CANVAS_WIDTH, CANVAS_HEIGHT],
    ]) {
      expect(skyCamera.pickEllipsoid(new Cartesian2(corner[0], corner[1]))).toBeUndefined();
    }

    const params = compute({ height: 30e6, tilt: 0 });
    expect(params).not.toBeNull();
    expect(params.pixelSize).toBeGreaterThan(200);
  });

  it("缩小地图时 pixelSize 持续变化，不会冻结在最后一个命中值上", () => {
    // 约 6,700km 以上旧逻辑角点开始落空并冻结；修复后应继续随高度增大
    const at6700km = compute({ height: 6.7e6, tilt: 0 });
    const at30000km = compute({ height: 30e6, tilt: 0 });

    expect(at30000km.pixelSize).toBeGreaterThan(at6700km.pixelSize + 10);
    expect(at30000km.pixelSize).not.toBe(at6700km.pixelSize);
  });

  it("“地球铺满屏幕 → 看到天际线”切换处 pixelSize 连续变化", () => {
    // 45° 俯仰下，约 570km 附近角点从落空变为命中；逐 1km 下降不应出现跳变
    let previous = null;
    let maxRelativeChange = 0;
    for (let h = 700e3; h >= 450e3; h -= 1e3) {
      const { pixelSize } = compute({ height: h, tilt: 45 });
      if (previous !== null && previous > 0) {
        maxRelativeChange = Math.max(maxRelativeChange, Math.abs(pixelSize - previous) / previous);
      }
      previous = pixelSize;
    }
    expect(maxRelativeChange).toBeLessThan(0.1);
  });

  it("2D / 哥伦布视图下不套用地平线回退（保持原有行为）", () => {
    const params = compute({ height: 30e6, tilt: 0 }, SceneMode.SCENE2D);
    expect(params).toBeNull();
  });
});