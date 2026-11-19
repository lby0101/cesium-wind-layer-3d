import {
  Geometry,
  GeometryAttribute,
  ComponentDatatype,
  PrimitiveType,
  GeometryAttributes,
  Color,
  Texture,
  Sampler,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  PixelFormat,
  PixelDatatype,
  Framebuffer,
  Appearance,
  SceneMode,
  TextureWrap,
  VertexArray,
  BufferUsage,
  Cartesian2,
} from "cesium";
import { WindParticlesComputing } from "./windParticlesComputing";
import CustomPrimitive from "./customPrimitive";
import { ShaderManager } from "./shaderManager";
import { deepMerge } from "./utils";

export class WindParticlesRendering {
  constructor(context, options, viewerParameters, computing) {
    this.context = context;
    this.options = options;
    this.viewerParameters = viewerParameters;
    this.computing = computing;

    if (typeof this.options.particlesTextureSize !== "number" || this.options.particlesTextureSize <= 0) {
      console.error("Invalid particlesTextureSize. Using default value of 256.");
      this.options.particlesTextureSize = 256;
    }

    this.colorTable = this.createColorTableTexture();
    this.textures = this.createRenderingTextures();
    this.framebuffers = this.createRenderingFramebuffers();
    this.primitives = this.createPrimitives();
  }

  createRenderingTextures() {
    const colorTextureOptions = {
      context: this.context,
      width: this.context.drawingBufferWidth,
      height: this.context.drawingBufferHeight,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    };
    const depthTextureOptions = {
      context: this.context,
      width: this.context.drawingBufferWidth,
      height: this.context.drawingBufferHeight,
      pixelFormat: PixelFormat.DEPTH_COMPONENT,
      pixelDatatype: PixelDatatype.UNSIGNED_INT,
    };

    return {
      segmentsColor: new Texture(colorTextureOptions),
      segmentsDepth: new Texture(depthTextureOptions),
    };
  }

  createRenderingFramebuffers() {
    return {
      segments: new Framebuffer({
        context: this.context,
        colorTextures: [this.textures.segmentsColor],
        depthTexture: this.textures.segmentsDepth,
      }),
    };
  }

  destroyRenderingFramebuffers() {
    Object.values(this.framebuffers).forEach((framebuffer) => framebuffer.destroy());
  }

  createColorTableTexture() {
    const colorTableData = new Float32Array(
      this.options.colors.flatMap((color) => {
        const cesiumColor = Color.fromCssColorString(color);
        return [cesiumColor.red, cesiumColor.green, cesiumColor.blue, cesiumColor.alpha];
      })
    );

    return new Texture({
      context: this.context,
      width: this.options.colors.length,
      height: 1,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.LINEAR,
        magnificationFilter: TextureMagnificationFilter.LINEAR,
        wrapS: TextureWrap.CLAMP_TO_EDGE,
        wrapT: TextureWrap.CLAMP_TO_EDGE,
      }),
      source: {
        width: this.options.colors.length,
        height: 1,
        arrayBufferView: colorTableData,
      },
    });
  }

  createSegmentsGeometry() {
    const repeatVertex = 4;
    const textureSize = this.options.particlesTextureSize;

    let st = [];
    for (let s = 0; s < textureSize; s++) {
      for (let t = 0; t < textureSize; t++) {
        for (let i = 0; i < repeatVertex; i++) {
          st.push(s / textureSize);
          st.push(t / textureSize);
        }
      }
    }
    st = new Float32Array(st);

    const particlesCount = this.options.particlesTextureSize ** 2;

    let normal = [];
    for (let i = 0; i < particlesCount; i++) {
      normal.push(-1, -1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0);
    }
    normal = new Float32Array(normal);

    let vertexIndexes = [];
    for (let i = 0, vertex = 0; i < particlesCount; i++) {
      vertexIndexes.push(vertex + 0, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3);
      vertex += repeatVertex;
    }
    vertexIndexes = new Uint32Array(vertexIndexes);

    return new Geometry({
      attributes: new GeometryAttributes({
        st: new GeometryAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: st,
        }),
        normal: new GeometryAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: normal,
        }),
      }),
      indices: vertexIndexes,
    });
  }

  createRawRenderState(options) {
    return Appearance.getDefaultRenderState(true, false, {
      viewport: undefined,
      depthTest: undefined,
      depthMask: undefined,
      blending: undefined,
      ...options,
    });
  }

  createPrimitives() {
    // 注意：uniformMap 里不要在闭包外缓存 windData —— updateWindData 之后
    // 数据范围/层高/速度区间都可能变，必须每帧从 computing 上读最新的
    const segments = new CustomPrimitive({
      commandType: "Draw",
      attributeLocations: {
        st: 0,
        normal: 1,
      },
      geometry: this.createSegmentsGeometry(),
      primitiveType: PrimitiveType.TRIANGLES,
      uniformMap: {
        previousParticlesPosition: () => this.computing.particlesTextures.previousParticlesPosition,
        currentParticlesPosition: () => this.computing.particlesTextures.currentParticlesPosition,
        postProcessingPosition: () => this.computing.particlesTextures.postProcessingPosition,
        particlesSpeed: () => this.computing.particlesTextures.particlesSpeed,
        frameRateAdjustment: () => this.computing.frameRateAdjustment,
        colorTable: () => this.colorTable,
        domain: () => new Cartesian2(
          this.options.domain?.min ?? this.computing.windData.speed.min,
          this.options.domain?.max ?? this.computing.windData.speed.max
        ),
        displayRange: () => new Cartesian2(
          this.options.displayRange?.min ?? this.computing.windData.speed.min,
          this.options.displayRange?.max ?? this.computing.windData.speed.max
        ),
        minHeight: () => this.computing.windData.levels[0],
        maxHeight: () =>
          this.computing.windData.levels[this.computing.windData.levels.length - 1],
        heightScale: () => this.options.heightScale ?? 1,
        aspect: () => this.context.drawingBufferWidth / this.context.drawingBufferHeight,
        pixelSize: () => this.viewerParameters.pixelSize,
        lineWidth: () => new Cartesian2(
          this.options.lineWidth?.min ?? 1,
          this.options.lineWidth?.max ?? 2
        ),
        lineLength: () => new Cartesian2(
          this.options.lineLength?.min ?? 20,
          this.options.lineLength?.max ?? 100
        ),
        is3D: () => this.viewerParameters.sceneMode === SceneMode.SCENE3D,
        segmentsDepthTexture: () => this.textures.segmentsDepth,
        // 显示范围（只显示范围内的粒子）
        clipLonRange: () => this.computing.getClipLonRange(),
        clipLatRange: () => this.computing.getClipLatRange(),
        dataLonRange: () => new Cartesian2(
          this.computing.windData.bounds.west,
          this.computing.windData.bounds.east
        ),
        dataLatRange: () => new Cartesian2(
          this.computing.windData.bounds.south,
          this.computing.windData.bounds.north
        ),
        regionMask: () => this.computing.regionMaskTexture,
        useRegionMask: () => this.computing.getUseRegionMask(),
      },
      vertexShaderSource: ShaderManager.getSegmentDrawVertexShader(),
      fragmentShaderSource: ShaderManager.getSegmentDrawFragmentShader(),
      rawRenderState: this.createRawRenderState({
        viewport: undefined,
        depthTest: { enabled: true },
        depthMask: true,
        blending: {
          enabled: true,
          blendEquation: WebGLRenderingContext.FUNC_ADD,
          blendFuncSource: WebGLRenderingContext.SRC_ALPHA,
          blendFuncDestination: WebGLRenderingContext.ONE_MINUS_SRC_ALPHA,
        },
      }),
    });

    return { segments };
  }

  onParticlesTextureSizeChange() {
    const geometry = this.createSegmentsGeometry();
    this.primitives.segments.geometry = geometry;
    const vertexArray = VertexArray.fromGeometry({
      context: this.context,
      geometry,
      attributeLocations: this.primitives.segments.attributeLocations,
      bufferUsage: BufferUsage.STATIC_DRAW,
    });
    if (this.primitives.segments.commandToExecute) {
      this.primitives.segments.commandToExecute.vertexArray = vertexArray;
    }
  }

  onColorTableChange() {
    this.colorTable.destroy();
    this.colorTable = this.createColorTableTexture();
  }

  updateOptions(options) {
    const needUpdateColorTable =
      options.colors && JSON.stringify(options.colors) !== JSON.stringify(this.options.colors);

    this.options = deepMerge(options, this.options);

    if (needUpdateColorTable) {
      this.onColorTableChange();
    }
  }

  destroy() {
    Object.values(this.framebuffers).forEach((framebuffer) => framebuffer.destroy());
    Object.values(this.primitives).forEach((primitive) => primitive.destroy());
    this.colorTable.destroy();
  }
}
