export const renderParticlesVertexShader = `#version 300 es
precision highp float;

in vec2 st;
in vec3 normal;

uniform sampler2D previousParticlesPosition;
uniform sampler2D currentParticlesPosition;
uniform sampler2D postProcessingPosition;
uniform sampler2D particlesSpeed;

uniform float frameRateAdjustment;
uniform float minHeight;
uniform float maxHeight;
uniform float heightScale;
uniform float aspect;
uniform float pixelSize;
uniform vec2 lineWidth;
uniform vec2 lineLength;
uniform vec2 domain;
uniform bool is3D;

out vec4 speed;
out float v_segmentPosition;
out vec2 textureCoordinate;
// 线段上的经纬度（两端分别取起点/终点，插值后即片元在线段上的位置），
// 片元着色器用它做显示范围裁剪
out vec3 v_lonLatZ;

struct adjacentPoints {
  vec4 previous;
  vec4 current;
  vec4 next;
};

vec3 convertCoordinate(vec3 lonLatZ) {
  // WGS84 (lon, lat, height) -> ECEF (x, y, z)
  float a = 6378137.0; // semi-major axis
  float b = 6356752.3142; // semi-minor axis
  float e2 = 6.69437999014e-3; // first eccentricity squared

  float latitude = radians(lonLatZ.y);
  float longitude = radians(lonLatZ.x);
  float h = mix(minHeight, maxHeight, lonLatZ.z) * heightScale;

  float cosLat = cos(latitude);
  float sinLat = sin(latitude);
  float N = a / sqrt(1.0 - e2 * sinLat * sinLat);
  return vec3(
    (N + h) * cosLat * cos(longitude),
    (N + h) * cosLat * sin(longitude),
    ((b * b) / (a * a) * N + h) * sinLat
  );
}

vec4 calculateProjectedCoordinate(vec3 lonLatZ) {
  if (is3D) {
    vec3 p = convertCoordinate(lonLatZ);
    return czm_modelViewProjection * vec4(p, 1.0);
  } else {
    vec3 p2d = vec3(radians(lonLatZ.x), radians(lonLatZ.y), 0.0);
    return czm_modelViewProjection * vec4(p2d, 1.0);
  }
}

vec4 calculateOffsetOnNormalDirection(vec4 pointA, vec4 pointB, float offsetSign, float widthFactor) {
  vec2 aspectVec2 = vec2(aspect, 1.0);
  vec2 pointA_XY = (pointA.xy / pointA.w) * aspectVec2;
  vec2 pointB_XY = (pointB.xy / pointB.w) * aspectVec2;
  vec2 direction = normalize(pointB_XY - pointA_XY);
  vec2 normalVector = vec2(-direction.y, direction.x);
  normalVector.x = normalVector.x / aspect;
  // 线宽：像素 → NDC（NDC 全高 = 2，对应 czm_viewport.w 个像素）
  float offsetLength = (widthFactor * lineWidth.y) / (czm_viewport.w * 0.5);
  normalVector = offsetLength * normalVector;
  return vec4(offsetSign * normalVector, 0.0, 0.0);
}

void main() {
  vec2 flippedIndex = vec2(st.x, 1.0 - st.y);
  vec2 particleIndex = flippedIndex;
  speed = texture(particlesSpeed, particleIndex);

  vec3 previousPosition = texture(previousParticlesPosition, particleIndex).rgb;
  vec3 currentPosition = texture(currentParticlesPosition, particleIndex).rgb;
  vec3 nextPosition = texture(postProcessingPosition, particleIndex).rgb;

  float isAnyRandomPointUsed = texture(postProcessingPosition, particleIndex).a
    + texture(currentParticlesPosition, particleIndex).a
    + texture(previousParticlesPosition, particleIndex).a;

  adjacentPoints projectedCoordinates;
  if (isAnyRandomPointUsed > 0.0) {
    projectedCoordinates.previous = calculateProjectedCoordinate(previousPosition);
    projectedCoordinates.current = projectedCoordinates.previous;
    projectedCoordinates.next = projectedCoordinates.previous;
  } else {
    projectedCoordinates.previous = calculateProjectedCoordinate(previousPosition);
    projectedCoordinates.current = calculateProjectedCoordinate(currentPosition);
    projectedCoordinates.next = calculateProjectedCoordinate(nextPosition);
  }

  int pointToUse = int(normal.x);
  float offsetSign = normal.y;
  vec4 offset = vec4(0.0);

  // speed.a stores speed magnitude (m/s); derive normalized speed for width/length
  float magnitude = clamp(speed.a, domain.x, domain.y);
  float normalizedSpeed = (magnitude - domain.x) / (domain.y - domain.x);

  float widthFactor = mix(lineWidth.x, lineWidth.y, normalizedSpeed);
  widthFactor *= (pointToUse < 0 ? 1.0 : 0.5);

  float lengthFactor = mix(lineLength.x, lineLength.y, normalizedSpeed) * pixelSize;

  // 线段两端的经纬度，供片元着色器做显示范围裁剪。
  // 线尾是按屏幕长度延伸出去的（见下面 extendedPosition），所以经纬度要按粒子
  // 自身一步的方向外推同样的倍数，否则伸到范围外的那一截会被漏掉。
  // 刚重播种的粒子只画一个点，两端取同一点，避免插值跨到旧位置。
  vec3 segmentStartLonLatZ = previousPosition;
  vec3 segmentEndLonLatZ = previousPosition;
  if (isAnyRandomPointUsed <= 0.0) {
    vec2 currentNdc = projectedCoordinates.current.xy / projectedCoordinates.current.w;
    vec2 nextNdc = projectedCoordinates.next.xy / projectedCoordinates.next.w;
    float stepScreen = length((nextNdc - currentNdc) * vec2(aspect, 1.0));
    float extendScreen = lengthFactor / max(projectedCoordinates.current.w, 1.0);
    float extendRatio = stepScreen > 1e-6 ? clamp(extendScreen / stepScreen, 0.0, 512.0) : 0.0;
    segmentEndLonLatZ = currentPosition + (nextPosition - currentPosition) * extendRatio;
  }

  if (pointToUse == 1) {
    offset = calculateOffsetOnNormalDirection(
      projectedCoordinates.previous, projectedCoordinates.current, offsetSign, widthFactor);
    // NDC 偏移 × w 转回裁剪空间，抵消透视除法，得到与缩放无关的像素线宽
    gl_Position = projectedCoordinates.previous + projectedCoordinates.previous.w * offset;
    v_segmentPosition = 0.0;
    v_lonLatZ = segmentStartLonLatZ;
  } else if (pointToUse == -1) {
    vec4 direction = normalize(projectedCoordinates.next - projectedCoordinates.current);
    vec4 extendedPosition = projectedCoordinates.current + direction * lengthFactor;
    offset = calculateOffsetOnNormalDirection(
      projectedCoordinates.current, extendedPosition, offsetSign, widthFactor);
    gl_Position = extendedPosition + extendedPosition.w * offset;
    v_segmentPosition = 1.0;
    v_lonLatZ = segmentEndLonLatZ;
  }

  textureCoordinate = st;
}
`;

export const renderParticlesFragmentShader = `#version 300 es
precision highp float;

in vec4 speed;
in float v_segmentPosition;
in vec2 textureCoordinate;
in vec3 v_lonLatZ;

uniform vec2 domain;
uniform vec2 displayRange;
uniform sampler2D colorTable;
uniform sampler2D segmentsDepthTexture;

// —— 显示范围（只显示范围内的粒子）——
// 未设置范围时 clipLonRange/clipLatRange 等于数据范围，判定恒为 true。
uniform vec2 clipLonRange; // (west, east)
uniform vec2 clipLatRange; // (south, north)
uniform vec2 dataLonRange; // (west, east)
uniform vec2 dataLatRange; // (south, north)
uniform sampler2D regionMask; // 多边形掩膜，覆盖整个数据范围，行序 南→北
uniform bool useRegionMask;

out vec4 fragColor;

// 掩膜纹理坐标：与风场 3D 纹理一致，把经纬度映射到数据范围上的 [0,1]
vec2 maskCoordinates(vec2 lonLat) {
  return vec2(
    (lonLat.x - dataLonRange.x) / (dataLonRange.y - dataLonRange.x),
    (lonLat.y - dataLatRange.x) / (dataLatRange.y - dataLatRange.x)
  );
}

bool insideRegion(vec2 lonLat) {
  if (lonLat.x < clipLonRange.x || lonLat.x > clipLonRange.y ||
      lonLat.y < clipLatRange.x || lonLat.y > clipLatRange.y) {
    return false;
  }
  if (useRegionMask) {
    vec2 uv = maskCoordinates(lonLat);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      return false;
    }
    return texture(regionMask, uv).r > 0.5;
  }
  return true;
}

void main() {
  const float zero = 0.0;
  fragColor = vec4(zero);

  if (speed.a > zero && speed.a > displayRange.x && speed.a < displayRange.y) {
    float magnitude = clamp(speed.a, domain.x, domain.y);
    float normalizedSpeed = (magnitude - domain.x) / (domain.y - domain.x);
    vec4 baseColor = texture(colorTable, vec2(normalizedSpeed, zero));

    float alpha = smoothstep(0.0, 1.0, v_segmentPosition);
    alpha = pow(alpha, 1.5);
    float speedAlpha = mix(0.3, 1.0, normalizedSpeed);
    fragColor = vec4(baseColor.rgb, baseColor.a * alpha * speedAlpha);
  }

  float segmentsDepth = texture(segmentsDepthTexture, textureCoordinate).r;
  float globeDepth = czm_unpackDepth(texture(czm_globeDepthTexture, textureCoordinate));
  if (segmentsDepth < globeDepth) {
    fragColor = vec4(zero);
  }

  // 只显示范围内的粒子。线段跨越范围边界时，v_lonLatZ 逐片元插值，
  // 于是线段会在边界处被切断，而不是整条消失。
  if (!insideRegion(v_lonLatZ.xy)) {
    fragColor = vec4(zero);
  }
}
`;
