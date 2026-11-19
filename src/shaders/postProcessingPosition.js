export const postProcessingPositionFragmentShader = `#version 300 es
precision highp float;

uniform sampler2D nextParticlesPosition;
uniform sampler2D particlesSpeed; // (dLon, dLat, dzNorm, magnitude)

uniform vec2 lonRange;
uniform vec2 latRange;
uniform vec2 dataLonRange;
uniform vec2 dataLatRange;
uniform vec2 speedRange;

// —— 显示范围（只显示范围内的粒子）——
// clipLonRange/clipLatRange 是矩形范围，已与数据范围求过交；
// 未设置范围时它们等于数据范围，下面的逻辑自然退化成原行为。
uniform vec2 clipLonRange; // (west, east)
uniform vec2 clipLatRange; // (south, north)
uniform sampler2D regionMask;         // 多边形掩膜，覆盖整个数据范围，行序 南→北
uniform sampler2D regionSpawnTexture; // 范围内随机点 (lon, lat, 0, 1)
uniform bool useRegionMask;

uniform float randomCoefficient;
uniform float dropRate;
uniform float dropRateBump;
uniform bool useViewerBounds;

in vec2 v_textureCoordinates;
out vec4 fragColor;

const vec3 randomConstants = vec3(12.9898, 78.233, 4375.85453);
const vec2 normalRange = vec2(0.0, 1.0);

float rand(vec2 seed, vec2 range) {
  vec2 randomSeed = randomCoefficient * seed;
  float temp = dot(randomConstants.xy, randomSeed);
  temp = fract(sin(temp) * (randomConstants.z + temp));
  return temp * (range.y - range.x) + range.x;
}

// 掩膜纹理坐标：与风场 3D 纹理一致，把经纬度映射到数据范围上的 [0,1]
vec2 maskCoordinates(vec2 lonLat) {
  return vec2(
    (lonLat.x - dataLonRange.x) / (dataLonRange.y - dataLonRange.x),
    (lonLat.y - dataLatRange.x) / (dataLatRange.y - dataLatRange.x)
  );
}

// 粒子是否落在显示范围内
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

vec3 generateRandomParticle(vec2 seed) {
  float randomLon, randomLat, randomZ;

  if (useRegionMask) {
    // 一次采样拿到多边形内部的随机位置。这里不做拒绝采样：
    // 小多边形（例如省内某个区县）用拒绝采样命中率极低，
    // 会让大量粒子长期卡在范围外、范围内看着很稀疏。
    vec2 spawnUV = vec2(rand(seed, normalRange), rand(seed.yx + 7.31, normalRange));
    vec2 lonLat = texture(regionSpawnTexture, spawnUV).xy;
    randomLon = lonLat.x;
    randomLat = lonLat.y;
  } else {
    // 视口范围与显示范围求交；无交集时退回显示范围，避免在空区间里取随机数
    vec2 spawnLonRange = useViewerBounds
      ? vec2(max(lonRange.x, clipLonRange.x), min(lonRange.y, clipLonRange.y))
      : clipLonRange;
    vec2 spawnLatRange = useViewerBounds
      ? vec2(max(latRange.x, clipLatRange.x), min(latRange.y, clipLatRange.y))
      : clipLatRange;
    if (spawnLonRange.x >= spawnLonRange.y) spawnLonRange = clipLonRange;
    if (spawnLatRange.x >= spawnLatRange.y) spawnLatRange = clipLatRange;

    randomLon = rand(seed, spawnLonRange);
    randomLat = rand(-seed, spawnLatRange);
  }

  randomZ = rand(seed.yx, normalRange);
  return vec3(randomLon, randomLat, randomZ);
}

bool particleOutbound(vec3 particle) {
  return !insideRegion(particle.xy) || particle.z < 0.0 || particle.z > 1.0;
}

void main() {
  vec3 nextParticle = texture(nextParticlesPosition, v_textureCoordinates).rgb;
  vec4 nextSpeed = texture(particlesSpeed, v_textureCoordinates);
  float magnitude = nextSpeed.a;
  float speedNorm = clamp((magnitude - speedRange.x) / (speedRange.y - speedRange.x), 0.0, 1.0);
  float particleDropRate = dropRate + dropRateBump * speedNorm;

  vec2 seed1 = nextParticle.xy + v_textureCoordinates;
  vec2 seed2 = nextSpeed.rg + v_textureCoordinates;
  vec3 randomParticle = generateRandomParticle(seed1);
  float randomNumber = rand(seed2, normalRange);

  if (randomNumber < particleDropRate || particleOutbound(nextParticle)) {
    fragColor = vec4(randomParticle, 1.0);
  } else {
    fragColor = vec4(nextParticle, 0.0);
  }
}
`;
