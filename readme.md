# cesium-wind-layer-3d

基于 WebGL2 的 CesiumJS 三维风场图层，使用 3D 纹理 + GPU 粒子平流（GPGPU）实现高性能动态风场可视化。

> 注意：这是 **3D 风场** 独立包，在 2D 风场包 [`cesium-wind-layer`](https://www.npmjs.com/package/cesium-wind-layer) 基础上增加了垂直 `w` 分量，实现真正的三维风场。本包数据为 `(u, v, w)` 三分量三维网格，粒子在三维空间平流。


## 效果

<table>
  <tr>
    <td><img src="assets/三维风场.gif" alt="3D Wind Field Visualization 1" /></td>
    <td><img src="assets/三维风场1.gif" alt="3D Wind Field Visualization 2" /></td>
  </tr>
</table>


## 特性

- WebGL2 原生 3D 纹理（`sampler3D`）存储风场，硬件三线性插值采样
- GPU 粒子平流（Runge-Kutta 2），数百万粒子实时流动
- 速度自适应线宽/线长，色带映射
- 运行时动态替换数据、调参、显隐
- 支持传入矩形/多边形范围，只显示范围内的粒子
- 2D / 3D 场景模式均支持

## 安装

```bash
npm install cesium-wind-layer-3d
```

`cesium` 为 peer dependency，请确保已安装 CesiumJS（^1.142.0）。

## 快速开始

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
  levels: [500, 1500, 3000, 5500], // 每层高度(米)，升序
};

const layer = new WindLayer3D(viewer, windData, {
  colors: ["rgb(175,240,91)", "rgb(110,64,170)"],
  particlesTextureSize: 256,
});

layer.zoomTo(2);
```

## 数据契约

### WindData3D

| 字段 | 类型 | 说明 |
|------|------|------|
| `u` / `v` / `w` | `{ array: Float32Array }` | 东/北/垂直风速分量 (m/s)，长度 `nx*ny*nz` |
| `speed` | `{ array, min, max }` | 可选，缺省由 u/v/w 自动合成 |
| `nx` / `ny` / `nz` | `number` | 经度/纬度/垂直层网格数 |
| `bounds` | `{ west, south, east, north }` | 数据范围（度） |
| `levels` | `number[]` | 每层高度(米)，升序，长度 `nz` |

数组布局：`index = (z * ny + y) * nx + x`，x=经度(西→东)，y=纬度(南→北)，z=层(低→高)。

## 选项 WindLayerOptions

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `particlesTextureSize` | `128` | 粒子纹理尺寸，粒子总数 = size² |
| `dropRate` | `0.003` | 基础丢弃率 |
| `dropRateBump` | `0.01` | 速度相关丢弃增量 |
| `speedFactor` | `1.0` | 速度缩放 |
| `lineWidth` | `{ min: 1, max: 2 }` | 线宽范围（像素） |
| `lineLength` | `{ min: 20, max: 100 }` | 线长范围 |
| `heightScale` | `1` | 高度拉伸 |
| `colors` | `["white"]` | 色带 CSS 颜色数组 |
| `flipY` | `false` | 翻转 Y 轴 |
| `useViewerBounds` | `false` | 在视口范围播种粒子 |
| `domain` | `undefined` | 色带映射域 |
| `displayRange` | `undefined` | 显示范围 |
| `displayBounds` | `undefined` | **只显示该矩形范围内的粒子**（见下） |
| `displayPolygon` | `undefined` | **只显示该多边形内的粒子**（见下） |
| `displayMaskResolution` | `1024` | 多边形掩膜长边像素数 |
| `displaySpawnTextureSize` | `256` | 「范围内随机点」纹理边长 |
| `dynamic` | `true` | 是否动态更新 |

## 只显示范围内的粒子

`displayBounds`（矩形）和 `displayPolygon`（多边形）用来把粒子限制在指定范围内：
范围内的粒子正常流动，流出范围的会被回收并重新播种回范围内，范围外的粒子不渲染。
两者可以同时给，取交集。

```js
const layer = new WindLayer3D(viewer, windData, {
  // 矩形：{west, south, east, north} | Cesium.Rectangle | [w, s, e, n]
  displayBounds: { west: 118.2, south: 31.2, east: 120.2, north: 32.6 },
});

// 多边形：[[lon, lat], ...]（单环）、环数组（第一个是外环，其余是洞）、
//        GeoJSON Polygon/MultiPolygon/Feature、Cesium.PolygonHierarchy 都支持
layer.setDisplayRegion({
  displayPolygon: [
    [[117.9, 32.45], [118.9, 32.8], [119.75, 32.35], [119.6, 31.35], [118.6, 31.05]],
  ],
});

layer.setDisplayRegion({ displayPolygon: null }); // 清除范围，恢复全数据范围
```

- 范围与数据范围求交，超出部分无效；两者无交集时只在 console 里告警。
- 点坐标支持 `[lon, lat]`、`{lon, lat}` / `{lng, lat}`、`Cartographic`（弧度）、
  `Cartesian3`（ECEF）。
- 设置范围后 `zoomTo()` 飞到范围而不是整个数据范围。
- 范围是**竖直棱柱**：粒子在范围内的经纬度上流动，高度不受限制。粒子有高度
  （`levels` × `heightScale`），斜视角下这些粒子投影到屏幕上会略微越过范围的
  平面轮廓，这是透视关系，不是裁剪失效。
- 流线（线尾）同样按范围裁剪：线尾按屏幕长度延伸出去，其经纬度会按粒子自身
  一步的方向外推后再判定，所以长线长不会把线尾甩到范围外。
- 多边形内部播种用一张预生成的「范围内随机点」纹理，GPU 一次采样即可命中，
  所以范围很小（例如省内一个区县）也不会出现粒子稀疏。
- 范围变化会重建掩膜纹理并重新播种粒子；`displayMaskResolution` 调大可以让边界
  更贴合，代价是初始化时多花几十毫秒。

## API

| 方法 | 说明 |
|------|------|
| `show` | 读写属性，控制显隐 |
| `updateWindData(data)` | 运行时替换风场数据 |
| `updateOptions(options)` | 运行时更新参数 |
| `setDisplayRegion({ displayBounds, displayPolygon })` | 运行时设置/清除显示范围 |
| `zoomTo(duration?)` | 飞到显示范围（未设置范围时为数据范围） |
| `destroy()` | 销毁全部资源 |
| `isDestroyed()` | 是否已销毁 |

## 示例

```bash
git clone https://github.com/lby0102/cesium-wind-layer-3d.git
cd cesium-wind-layer-3d
npm install
npm run build
npm run dev
```

浏览器打开 http://localhost:3000 可见 3D 风场粒子动画（示例使用印尼区域风场数据）。

## 浏览器要求

- WebGL2（CesiumJS 1.104+ 默认启用）
- 需要 `EXT_color_buffer_float`（浮点纹理渲染）与原生 3D 纹理支持

## License

MIT
