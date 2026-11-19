import { Cartesian2, Cartesian3, Math as CesiumMath, SceneMode } from "cesium";

/**
 * 计算视口在地球表面覆盖的经纬度范围，以及粒子缩放系数 pixelSize。
 *
 * 四个屏幕角点的射线若与椭球相交，直接取交点；若射线落空（角点看到的是天空），
 * 取该方位上的地平线切点 —— 它是这个方向上实际可见的最远地面点。
 * 地平线切点与「射线刚好擦过椭球」时的交点重合，因此在
 * 「地球铺满屏幕 / 看到天际线」两种状态之间切换时结果是连续的，
 * 不会因为角点从命中变成落空就把 pixelSize 冻结在某个旧值上。
 *
 * @param {object} params
 * @param {object} params.camera     Cesium Camera
 * @param {object} params.ellipsoid  Cesium Ellipsoid
 * @param {number} params.canvasWidth
 * @param {number} params.canvasHeight
 * @param {number} params.sceneMode  Cesium SceneMode
 * @param {{west:number,south:number,east:number,north:number}} params.bounds 数据范围（度）
 * @returns {{lonRange: Cartesian2, latRange: Cartesian2, pixelSize: number}|null}
 *          没有任何角点可用时返回 null
 */
export function computeViewportParameters({
  camera,
  ellipsoid,
  canvasWidth,
  canvasHeight,
  sceneMode,
  bounds,
}) {
  const corners = [
    { x: 0, y: 0 },
    { x: 0, y: canvasHeight },
    { x: canvasWidth, y: 0 },
    { x: canvasWidth, y: canvasHeight },
  ];

  const cameraCartographic = ellipsoid.cartesianToCartographic(camera.positionWC);
  const useHorizonFallback =
    sceneMode === SceneMode.SCENE3D &&
    cameraCartographic !== undefined &&
    Number.isFinite(cameraCartographic.height) &&
    cameraCartographic.height > 0;

  let horizonAngle = 0;
  let east;
  let north;
  if (useHorizonFallback) {
    const radius = ellipsoid.maximumRadius;
    // 从相机位置能看到的地平线与星下点之间的地心夹角
    horizonAngle = Math.acos(Math.min(1, radius / (radius + cameraCartographic.height)));
    const lon = cameraCartographic.longitude;
    const lat = cameraCartographic.latitude;
    east = new Cartesian3(-Math.sin(lon), Math.cos(lon), 0);
    north = new Cartesian3(
      -Math.sin(lat) * Math.cos(lon),
      -Math.sin(lat) * Math.sin(lon),
      Math.cos(lat)
    );
  }

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let pointCount = 0;

  for (const corner of corners) {
    const windowPosition = new Cartesian2(corner.x, corner.y);
    const picked = camera.pickEllipsoid(windowPosition, ellipsoid);

    let lon;
    let lat;
    if (picked) {
      const cartographic = ellipsoid.cartesianToCartographic(picked);
      if (!cartographic) continue;
      lon = cartographic.longitude;
      lat = cartographic.latitude;
    } else if (useHorizonFallback) {
      const ray = camera.getPickRay(windowPosition);
      const horizon = horizonLonLat(ray, cameraCartographic, horizonAngle, east, north);
      if (!horizon) continue;
      lon = horizon.lon;
      lat = horizon.lat;
    } else {
      continue;
    }

    pointCount++;
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  if (pointCount === 0) return null;

  const degreesPerRadian = 180 / Math.PI;
  const lonRange = new Cartesian2(
    Math.max(bounds.west, minLon * degreesPerRadian),
    Math.min(bounds.east, maxLon * degreesPerRadian)
  );
  const latRange = new Cartesian2(
    Math.max(bounds.south, minLat * degreesPerRadian),
    Math.min(bounds.north, maxLat * degreesPerRadian)
  );

  const lonBuffer = (lonRange.y - lonRange.x) * 0.05;
  const latBuffer = (latRange.y - latRange.x) * 0.05;
  lonRange.x = Math.max(bounds.west, lonRange.x - lonBuffer);
  lonRange.y = Math.min(bounds.east, lonRange.y + lonBuffer);
  latRange.x = Math.max(bounds.south, latRange.x - latBuffer);
  latRange.y = Math.min(bounds.north, latRange.y + latBuffer);

  const dataLonRange = bounds.east - bounds.west;
  const dataLatRange = bounds.north - bounds.south;
  const visibleRatioLon = (lonRange.y - lonRange.x) / dataLonRange;
  const visibleRatioLat = (latRange.y - latRange.x) / dataLatRange;
  const visibleRatio = Math.min(visibleRatioLon, visibleRatioLat);

  return {
    lonRange,
    latRange,
    pixelSize: Math.max(0, Math.min(1000, 1000 * visibleRatio)),
  };
}

// 射线打空时，求该方位上地平线切点的经纬度（球面目的地公式）。
// 相机位置、星下点和切线点共面，所以射线水平投影的方位角就是切点的方位角。
function horizonLonLat(ray, cameraCartographic, horizonAngle, east, north) {
  if (!ray) return undefined;

  const eastComponent = Cartesian3.dot(ray.direction, east);
  const northComponent = Cartesian3.dot(ray.direction, north);
  if (Math.hypot(eastComponent, northComponent) < 1e-12) return undefined;

  const azimuth = Math.atan2(eastComponent, northComponent);
  const lat1 = cameraCartographic.latitude;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngle = Math.sin(horizonAngle);
  const cosAngle = Math.cos(horizonAngle);

  const sinLat2 = sinLat1 * cosAngle + cosLat1 * sinAngle * Math.cos(azimuth);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const deltaLon = Math.atan2(
    sinAngle * Math.sin(azimuth) * cosLat1,
    cosAngle - sinLat1 * sinLat2
  );

  return {
    lon: CesiumMath.negativePiToPi(cameraCartographic.longitude + deltaLon),
    lat: lat2,
  };
}