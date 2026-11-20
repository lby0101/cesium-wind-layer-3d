export function deepMerge(from, to) {
  if (!from) return to;
  if (!to) return from;

  const result = { ...to };

  for (const key in from) {
    if (Object.prototype.hasOwnProperty.call(from, key)) {
      const fromValue = from[key];
      const toValue = to[key];

      if (Array.isArray(fromValue)) {
        result[key] = fromValue.slice();
        continue;
      }

      if (fromValue && typeof fromValue === "object") {
        result[key] = deepMerge(fromValue, toValue || {});
        continue;
      }

      if (fromValue !== undefined) {
        result[key] = fromValue;
      }
    }
  }

  return result;
}

// 由 u/v/w 三分量合成速度幅值数组，并返回非零区间 [min, max]
export function computeSpeedFromComponents(u, v, w) {
  const array = new Float32Array(u.length);
  let min = Number.MAX_VALUE;
  let max = Number.MIN_VALUE;
  for (let i = 0; i < u.length; i++) {
    const s = Math.sqrt(u[i] * u[i] + v[i] * v[i] + w[i] * w[i]);
    array[i] = s;
    if (s !== 0) {
      min = Math.min(min, s);
      max = Math.max(max, s);
    }
  }
  return { array, min, max };
}

// 速度分布的高分位值（默认 p95），用作默认归一化域的上界。
// 直接用全局 max 做上界时，个别极端值（如急流）会把整个色带/线长映射
// 压到区间低端，低风速区域线长接近 0、几乎不可见，表现为“区域缺失”。
export function computeSpeedPercentile(array, p = 0.95) {
  if (!array || array.length === 0) return 0;
  const sorted = Float32Array.from(array).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}
