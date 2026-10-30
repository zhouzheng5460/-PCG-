// 二维值噪声（hash-based）。只为"低频调制"服务 —— 树群的疏密、后面地形的高程都用它。
//
// 不用 Perlin/Simplex：这里要的是"给定坐标 + 种子，稳定返回一个连续的量"，
// 值噪声就够，而且没有梯度表要维护。代价是四角插值会有一点棋盘感，
// 做一次 fbm 叠加就看不出。

function hash2(x: number, y: number, seed: number): number {
  // 整数混合（Wang hash 的简化版）：输入相同 → 输出相同，且分布均匀
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** 值噪声，返回 [0, 1] */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}

/** 多倍频叠加，返回 [0, 1] */
export function fbm(x: number, y: number, seed = 0, octaves = 3, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / (norm || 1);
}
