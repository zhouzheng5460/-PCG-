// 移植自 Source/com/watabou/utils/ArrayExtender.hx
// Haxe 的 Array 扩展函数在 TS 里显式调用，避免污染原型。

import { Rng } from './rng';

export const A = {
  shuffle<T>(a: T[]): T[] {
    const result: T[] = [];
    for (const e of a) result.splice(Math.floor(Rng.float() * (result.length + 1)), 0, e);
    return result;
  },

  random<T>(a: T[]): T {
    return a[Math.floor(Rng.float() * a.length)];
  },

  weighted<T>(a: T[], weights: number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    const z = Rng.float() * total;
    let acc = 0;
    for (let i = 0; i < a.length; i++) {
      acc += weights[i];
      if (z <= acc) return a[i];
    }
    return a[0];
  },

  contains<T>(a: T[], v: T): boolean {
    return a.indexOf(v) !== -1;
  },

  last<T>(a: T[]): T {
    return a[a.length - 1];
  },

  min<T>(a: T[], f: (t: T) => number): T {
    let result = a[0];
    let min = f(result);
    for (let i = 1; i < a.length; i++) {
      const el = a[i];
      const m = f(el);
      if (m < min) {
        result = el;
        min = m;
      }
    }
    return result;
  },

  max<T>(a: T[], f: (t: T) => number): T {
    let result = a[0];
    let max = f(result);
    for (let i = 1; i < a.length; i++) {
      const el = a[i];
      const m = f(el);
      if (m > max) {
        result = el;
        max = m;
      }
    }
    return result;
  },

  every<T>(a: T[], test: (t: T) => boolean): boolean {
    for (const e of a) if (!test(e)) return false;
    return true;
  },

  some<T>(a: T[], test: (t: T) => boolean): boolean {
    for (const e of a) if (test(e)) return true;
    return false;
  },

  count<T>(a: T[], test: (t: T) => boolean): number {
    let n = 0;
    for (const e of a) if (test(e)) n++;
    return n;
  },

  /** 原地用 newEls 替换 el 的首次出现 */
  replace<T>(a: T[], el: T, newEls: T[]): void {
    let index = a.indexOf(el);
    a[index++] = newEls[0];
    for (let i = 1; i < newEls.length; i++) a.splice(index++, 0, newEls[i]);
  },

  remove<T>(a: T[], el: T): boolean {
    const i = a.indexOf(el);
    if (i === -1) return false;
    a.splice(i, 1);
    return true;
  },

  difference<T>(a: T[], b: T[]): T[] {
    return a.filter((el) => b.indexOf(el) === -1);
  },

  /** 去重 push */
  add<T>(a: T[], el: T): void {
    if (a.indexOf(el) === -1) a.push(el);
  },

  union<T>(a: T[], b: T[]): T[] {
    return a.concat(b.filter((el) => a.indexOf(el) === -1));
  },

  intersect<T>(a: T[], b: T[]): T[] {
    return a.filter((el) => b.indexOf(el) !== -1);
  },
};
