/*
 * @Author: 码客GISer
 * @Date: 2026-08-18 15:56:31
 * @LastEditors: libingya
 * @LastEditTime: 2026-11-20 09:12:21
 * @Description: 
 */
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { WindLayer3D } from "../dist/cesium-wind-layer-3d.js";

const viewer = new Cesium.Viewer("cesiumContainer", {
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.UrlTemplateImageryProvider({
      // url: "/arcgisonline/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}.png",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}.png",
    }),
  ),
});

viewer.scene.globe.enableLighting = false;
viewer.scene.fog.enabled = true;
viewer.scene.fog.density = 0.00008;

const WIND_COLORS = [
  "rgb(175, 240, 91)", "rgb(150, 243, 87)", "rgb(124, 246, 88)",
  "rgb(100, 247, 95)", "rgb(78, 246, 105)", "rgb(59, 242, 119)",
  "rgb(44, 237, 135)", "rgb(34, 229, 153)", "rgb(27, 218, 170)",
  "rgb(25, 206, 186)", "rgb(27, 192, 201)", "rgb(32, 177, 212)",
  "rgb(41, 161, 221)", "rgb(51, 145, 225)", "rgb(62, 129, 225)",
  "rgb(74, 113, 221)", "rgb(85, 99, 213)", "rgb(95, 86, 201)",
  "rgb(104, 74, 187)", "rgb(110, 64, 170)",
];

const options = {
  colors: WIND_COLORS,
  particlesTextureSize: 256,
  lineWidth: { min: .4, max: 1 },
  lineLength: { min: 20, max: 1200 },
  heightScale: 1,
  speedFactor: 0.3,
  dropRate: 0.003,
  dropRateBump: 0.001,
  useViewerBounds: true,
  dynamic: true,
};

// JSON 里的分量是普通数组，需转成 Float32Array 才符合 WindData3D 契约
function normalizeWindData(raw) {
  return {
    u: { array: new Float32Array(raw.u.array) },
    v: { array: new Float32Array(raw.v.array) },
    w: { array: new Float32Array(raw.w.array) },
    nx: raw.nx,
    ny: raw.ny,
    nz: raw.nz,
    bounds: raw.bounds,
    levels: raw.levels,
  };
}

// 显示范围示例：只显示范围内的粒子
const DISPLAY_REGIONS = {
  none: { displayBounds: null, displayPolygon: null },
  rect: {
    displayBounds: { west: 118.2, south: 31.2, east: 120.2, north: 32.6 },
    displayPolygon: null,
  },
  polygon: {
    // 逆时针外环即可，凹多边形/带洞也支持
    displayPolygon: [
      [
        [117.9, 32.45],
        [118.9, 32.8],
        [119.75, 32.35],
        [119.6, 31.35],
        [118.6, 31.05],
        [117.85, 31.7],
      ],
    ],
    displayBounds: null,
  },
};

let layer = null;

function bindControls() {
  document.getElementById("particles").addEventListener("input", (e) => {
    layer.updateOptions({ particlesTextureSize: Number(e.target.value) });
  });
  document.getElementById("speed").addEventListener("input", (e) => {
    layer.updateOptions({ speedFactor: Number(e.target.value) });
  });
  document.getElementById("height").addEventListener("input", (e) => {
    layer.updateOptions({ heightScale: Number(e.target.value) });
  });
  document.getElementById("length").addEventListener("input", (e) => {
    layer.updateOptions({ lineLength: { min: 2, max: Number(e.target.value) } });
  });
  document.getElementById("dynamic").addEventListener("change", (e) => {
    layer.updateOptions({ dynamic: e.target.checked });
  });
  document.getElementById("clip").addEventListener("change", (e) => {
    // updateOptions 会重建掩膜纹理并重新播种粒子
    layer.updateOptions(DISPLAY_REGIONS[e.target.value]);
    layer.zoomTo(1.5);
  });
  document.getElementById("zoom").addEventListener("click", () => {
    layer.zoomTo(2);
  });
}

async function main() {
  const status = document.getElementById("status");
  try {
    const response = await fetch("data/wind_globe_3d.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const windData = normalizeWindData(await response.json());

    layer = new WindLayer3D(viewer, windData, options);
    window.windLayer3D = layer;

    layer.zoomTo(0);
    bindControls();
    status.remove();
  } catch (error) {
    console.error("风场数据加载失败：", error);
    status.textContent = `风场数据加载失败：${error.message}`;
    status.classList.add("error");
  }
}

main();
