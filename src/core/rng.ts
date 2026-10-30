// 移植自 Source/com/watabou/utils/Random.hx（Park-Miller 最小标准生成器）
// 注意：Haxe 版 seed 为 0 时整个序列会退化为 0，这里做了保护（不影响正常种子的一致性）。

const G = 48271;
const N = 2147483647;

let seed = 1;

export const Rng = {
  reset(s = -1): void {
    seed = s !== -1 ? s : Math.floor(Date.now() % N);
    if (seed <= 0) seed = (seed % N) + 1;
  },

  getSeed(): number {
    return seed;
  },

  next(): number {
    seed = Math.floor((seed * G) % N);
    return seed;
  },

  float(): number {
    return this.next() / N;
  },

  normal(): number {
    return (this.float() + this.float() + this.float()) / 3;
  },

  int(min: number, max: number): number {
    return Math.floor(min + this.next() / N * (max - min));
  },

  bool(chance = 0.5): boolean {
    return this.float() < chance;
  },

  fuzzy(f = 1.0): number {
    return f === 0 ? 0.5 : (1 - f) / 2 + f * this.normal();
  },
};
