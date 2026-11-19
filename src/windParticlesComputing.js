import {
  PixelDatatype,
  PixelFormat,
  Sampler,
  Texture,
  Texture3D,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  TextureWrap,
  Cartesian2,
  FrameRateMonitor,
} from "cesium";
import { ShaderManager } from "./shaderManager";
import CustomPrimitive from "./customPrimitive";
import { deepMerge } from "./utils";
import { createRandomParticleData } from "./displayRegion";

export class WindParticlesComputing {
  constructor(context, windData, options, viewerParameters, scene, region) {
    this.context = context;
    this.options = options;
    this.viewerParameters = viewerParameters;
    this.windData = windData;
    this.region = region ?? null;

    // frameRate / frameRateAdjustment 必须在首帧前有有效值，
    // 否则 calculateSpeed 里 speed * undefined 会得到 NaN 位置，粒子全部不可见
    this.frameRate = 60;
    this.frameRateAdjustment = 1;

    this.frameRateMonitor = new FrameRateMonitor({
      scene,
      samplingWindow: 1.0,
      quietPeriod: 0.0,
    });
    this.initFrameRate();
    this.createWindTexture();
    this.createRegionTextures();
    this.createParticlesTextures();
    this.createComputingPrimitives();
  }

  initFrameRate() {
    const updateFrameRate = () => {
      if (this.frameRateMonitor.lastFramesPerSecond > 20) {
        this.frameRate = this.frameRateMonitor.lastFramesPerSecond;
        this.frameRateAdjustment = 60 / Math.max(this.frameRate, 1);
      }
    };

    updateFrameRate();

    const intervalId = setInterval(updateFrameRate, 1000);

    const originalDestroy = this.destroy.bind(this);
    this.destroy = () => {
      clearInterval(intervalId);
      originalDestroy();
    };
  }

  // 把 (u, v, w) 三张数组拼成一张 RGBA 的 3D 纹理数据 (u, v, w, 0)
  createWindTexture() {
    const { nx, ny, nz, u, v, w } = this.windData;
    const total = nx * ny * nz;
    const data = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) {
      data[i * 4 + 0] = u.array[i];
      data[i * 4 + 1] = v.array[i];
      data[i * 4 + 2] = w.array[i];
      data[i * 4 + 3] = 0.0;
    }

    this.windTexture = new Texture3D({
      context: this.context,
      width: nx,
      height: ny,
      depth: nz,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: this.options.flipY ?? false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.LINEAR,
        magnificationFilter: TextureMagnificationFilter.LINEAR,
        wrapS: TextureWrap.CLAMP_TO_EDGE,
        wrapT: TextureWrap.CLAMP_TO_EDGE,
        wrapR: TextureWrap.CLAMP_TO_EDGE,
      }),
      source: {
        width: nx,
        height: ny,
        depth: nz,
        arrayBufferView: data,
      },
    });
  }

  // 显示范围用到的两张纹理：
  //   regionMaskTexture       多边形掩膜（0/255），覆盖整个数据范围
  //   regionSpawnTexture      范围内随机点 (lon, lat, 0, 1)，供重播种采样
  // 没有多边形范围时用 1x1 占位纹理 —— 着色器里这两个 sampler 是静态引用的，
  // 属于 active uniform，uniformMap 必须给出有效纹理。
  createRegionTextures() {
    const mask = this.region?.mask ?? null;
    const spawn = this.region?.spawn ?? null;

    this.regionMaskTexture = mask ? this.createMaskTexture(mask) : this.createDummyTexture([1, 1, 1, 1]);
    this.regionSpawnTexture = spawn
      ? this.createSpawnTexture(spawn)
      : this.createDummyTexture([0, 0, 0, 1]);
  }

  createMaskTexture(mask) {
    const { width, height, data } = mask;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const value = data[i];
      rgba[i * 4 + 0] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = 255;
    }

    return new Texture({
      context: this.context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.LINEAR,
        magnificationFilter: TextureMagnificationFilter.LINEAR,
        wrapS: TextureWrap.CLAMP_TO_EDGE,
        wrapT: TextureWrap.CLAMP_TO_EDGE,
      }),
      source: { width, height, arrayBufferView: rgba },
    });
  }

  createSpawnTexture(spawn) {
    return new Texture({
      context: this.context,
      width: spawn.width,
      height: spawn.height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.NEAREST,
        magnificationFilter: TextureMagnificationFilter.NEAREST,
        wrapS: TextureWrap.CLAMP_TO_EDGE,
        wrapT: TextureWrap.CLAMP_TO_EDGE,
      }),
      source: {
        width: spawn.width,
        height: spawn.height,
        arrayBufferView: spawn.data,
      },
    });
  }

  createDummyTexture(rgba) {
    return new Texture({
      context: this.context,
      width: 1,
      height: 1,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.NEAREST,
        magnificationFilter: TextureMagnificationFilter.NEAREST,
      }),
      source: { width: 1, height: 1, arrayBufferView: new Float32Array(rgba) },
    });
  }

  createParticlesTextures() {
    const size = this.options.particlesTextureSize;
    const total = size * size;

    const baseOptions = {
      context: this.context,
      width: size,
      height: size,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.NEAREST,
        magnificationFilter: TextureMagnificationFilter.NEAREST,
      }),
    };

    // 初始粒子随机分布：若全为 0，所有粒子从 (lon=0,lat=0,z=0) 出发（相机视角外），
    // 只能靠 dropRate 缓慢重新播种，导致首屏长时间看不到风场。
    const randomData = this.createRandomParticlesData();
    const zeroData = new Float32Array(total * 4);

    this.particlesTextures = {
      previousParticlesPosition: new Texture({ ...baseOptions, source: { arrayBufferView: randomData } }),
      currentParticlesPosition: new Texture({ ...baseOptions, source: { arrayBufferView: randomData } }),
      nextParticlesPosition: new Texture({ ...baseOptions, source: { arrayBufferView: zeroData } }),
      postProcessingPosition: new Texture({ ...baseOptions, source: { arrayBufferView: randomData } }),
      particlesSpeed: new Texture({ ...baseOptions, source: { arrayBufferView: zeroData } }),
    };
  }

  createRandomParticlesData() {
    return createRandomParticleData(
      this.options.particlesTextureSize,
      this.windData.bounds,
      this.region
    );
  }

  destroyParticlesTextures() {
    Object.values(this.particlesTextures).forEach((texture) => texture.destroy());
  }

  // 范围变化后重新播种：否则旧粒子要等 dropRate 慢慢淘汰，期间范围外/内密度都不对
  resetParticles() {
    this.destroyParticlesTextures();
    this.createParticlesTextures();
  }

  // —— 显示范围在着色器里的入参 ——

  getClipLonRange() {
    const bounds = this.region?.bounds ?? this.windData.bounds;
    return new Cartesian2(bounds.west, bounds.east);
  }

  getClipLatRange() {
    const bounds = this.region?.bounds ?? this.windData.bounds;
    return new Cartesian2(bounds.south, bounds.north);
  }

  getUseRegionMask() {
    return Boolean(this.region?.mask);
  }

  createComputingPrimitives() {
    this.primitives = {
      calculateSpeed: new CustomPrimitive({
        commandType: "Compute",
        uniformMap: {
          windTexture: () => this.windTexture,
          currentParticlesPosition: () => this.particlesTextures.currentParticlesPosition,
          minimum: () => new Cartesian2(this.windData.bounds.west, this.windData.bounds.south),
          maximum: () => new Cartesian2(this.windData.bounds.east, this.windData.bounds.north),
          minHeight: () => this.windData.levels[0],
          maxHeight: () => this.windData.levels[this.windData.levels.length - 1],
          speedRange: () => new Cartesian2(this.windData.speed.min, this.windData.speed.max),
          speedScaleFactor: () => (this.viewerParameters.pixelSize + 50) * this.options.speedFactor,
          frameRateAdjustment: () => this.frameRateAdjustment,
        },
        fragmentShaderSource: ShaderManager.getCalculateSpeedShader(),
        outputTexture: this.particlesTextures.particlesSpeed,
        preExecute: () => {
          const temp = this.particlesTextures.previousParticlesPosition;
          this.particlesTextures.previousParticlesPosition = this.particlesTextures.currentParticlesPosition;
          this.particlesTextures.currentParticlesPosition = this.particlesTextures.postProcessingPosition;
          this.particlesTextures.postProcessingPosition = temp;
          if (this.primitives.calculateSpeed.commandToExecute) {
            this.primitives.calculateSpeed.commandToExecute.outputTexture = this.particlesTextures.particlesSpeed;
          }
        },
        isDynamic: () => this.options.dynamic,
      }),

      updatePosition: new CustomPrimitive({
        commandType: "Compute",
        uniformMap: {
          currentParticlesPosition: () => this.particlesTextures.currentParticlesPosition,
          particlesSpeed: () => this.particlesTextures.particlesSpeed,
        },
        fragmentShaderSource: ShaderManager.getUpdatePositionShader(),
        outputTexture: this.particlesTextures.nextParticlesPosition,
        preExecute: () => {
          if (this.primitives.updatePosition.commandToExecute) {
            this.primitives.updatePosition.commandToExecute.outputTexture = this.particlesTextures.nextParticlesPosition;
          }
        },
        isDynamic: () => this.options.dynamic,
      }),

      postProcessingPosition: new CustomPrimitive({
        commandType: "Compute",
        uniformMap: {
          nextParticlesPosition: () => this.particlesTextures.nextParticlesPosition,
          particlesSpeed: () => this.particlesTextures.particlesSpeed,
          lonRange: () => this.viewerParameters.lonRange,
          latRange: () => this.viewerParameters.latRange,
          dataLonRange: () => new Cartesian2(this.windData.bounds.west, this.windData.bounds.east),
          dataLatRange: () => new Cartesian2(this.windData.bounds.south, this.windData.bounds.north),
          speedRange: () => new Cartesian2(this.windData.speed.min, this.windData.speed.max),
          randomCoefficient: () => Math.random(),
          dropRate: () => this.options.dropRate,
          dropRateBump: () => this.options.dropRateBump,
          useViewerBounds: () => this.options.useViewerBounds,
          clipLonRange: () => this.getClipLonRange(),
          clipLatRange: () => this.getClipLatRange(),
          regionMask: () => this.regionMaskTexture,
          regionSpawnTexture: () => this.regionSpawnTexture,
          useRegionMask: () => this.getUseRegionMask(),
        },
        fragmentShaderSource: ShaderManager.getPostProcessingPositionShader(),
        outputTexture: this.particlesTextures.postProcessingPosition,
        preExecute: () => {
          if (this.primitives.postProcessingPosition.commandToExecute) {
            this.primitives.postProcessingPosition.commandToExecute.outputTexture = this.particlesTextures.postProcessingPosition;
          }
        },
        isDynamic: () => this.options.dynamic,
      }),
    };
  }

  reCreateWindTexture() {
    this.windTexture.destroy();
    this.createWindTexture();
  }

  reCreateRegionTextures() {
    this.regionMaskTexture?.destroy();
    this.regionSpawnTexture?.destroy();
    this.createRegionTextures();
  }

  updateWindData(data, region) {
    const regionChanged = region !== this.region;
    this.windData = data;
    this.reCreateWindTexture();
    if (regionChanged) {
      // 数据范围可能变了，掩膜与随机点纹理都要跟着重建，并重新播种
      this.region = region ?? null;
      this.reCreateRegionTextures();
      this.resetParticles();
    }
  }

  setRegion(region) {
    this.region = region ?? null;
    this.reCreateRegionTextures();
    this.resetParticles();
  }

  updateOptions(options) {
    const needUpdateWindTexture = options.flipY !== undefined && options.flipY !== this.options.flipY;
    this.options = deepMerge(options, this.options);
    if (needUpdateWindTexture) {
      this.reCreateWindTexture();
    }
  }

  destroy() {
    if (this.windTexture) this.windTexture.destroy();
    this.regionMaskTexture?.destroy();
    this.regionSpawnTexture?.destroy();
    Object.values(this.particlesTextures).forEach((texture) => texture.destroy());
    Object.values(this.primitives).forEach((primitive) => primitive.destroy());
    this.frameRateMonitor.destroy();
  }
}
