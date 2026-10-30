// 张量场：把若干个"方向来源"叠成每一点的主/次方向。
//
// 为什么必须是张量而不是矢量场：
//   街道方向是"无向"的 —— 0° 和 180° 是同一个方向。直接对角度做加权平均，
//   0° 和 90° 会平均成 45°（错），0° 和 180° 会平均成 90°（更错）。
//   用二阶对称张量 T = [[A, B], [B, -A]]（无迹部分）表示方向，
//   累加后再求主特征向量，θ 与 θ+π 天然等价，正交方向自动成为次特征向量。
//
// 参考 RogueCities_UrbanSpatialDesigner / symbios-tensor / urbe-atlas 的场定义，
// 但这里只保留"城市布局"需要的那一小部分：无迹二阶张量 + 高斯衰减 + 单位化求和。

import { Pt } from '../../core/geom';

/** 场的来源类型。UI 里用户看到的是"方向控制"，不用理解张量。 */
export type SourceKind = 'grid' | 'radial' | 'path' | 'boundary' | 'building' | 'vortex';

export interface FieldSource {
  id: string;
  type: SourceKind;
  /** radial / vortex / building 的中心 */
  position?: Pt;
  /** grid / building 的方向（会被归一化；长度无所谓） */
  direction?: Pt;
  /** path 的折线 */
  path?: Pt[];
  /** 影响半径 */
  radius: number;
  /** 强度（相对权重） */
  strength: number;
  /** 衰减指数，默认 2：w = strength·exp(-(d/r)^falloff) */
  falloff?: number;
  /**
   * path 源的作用侧。'outside' = 只在闭合轮廓外生效（轮廓内权重归零）。
   *
   * 为什么需要它：禁建区轮廓作为场源时，轮廓内侧的街道反正会被布尔切掉，
   * 让场在那儿继续发力只会把"将要被切掉的部分"掰弯，而被切掉的部分掰弯了
   * 也没用 —— 但它的邻居（轮廓外侧的街道）是被同一条流线积分出来的，
   * 于是两侧残留的街道端头横向错开 1~2 m，形成错台。
   * 关掉内侧影响，流线就不会为了"绕过一块马上要消失的地"而整体横移。
   */
  only?: 'outside';
  /** only='outside' 时，轮廓外的渐变带宽（世界单位）。默认 1（≈7 m） */
  fade?: number;
  /**
   * only='outside' 用的**判定轮廓**，默认取 `path` 自己。
   *
   * 需要单列的理由：禁建区的"边延长线"型场源，path 是一条穿过禁区的长直线，
   * 它自己围不出任何区域，内外判定必须拿原来的轮廓环。
   */
  mask?: Pt[];
}

/** 射线法判定点是否落在环内（不自交环有效）。tensor.ts 保持零依赖，复制一份十行的实现。 */
function ringContains(ring: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface FieldSample {
  /** 主方向角 */
  a: number;
  /** 一致性 0~1：1 = 所有来源同向，0 = 完全冲突（此处方向不可信） */
  coherence: number;
}

export type Family = 'major' | 'minor';

function nearestOnPolyline(
  x: number,
  y: number,
  path: Pt[]
): { d: number; ang: number } {
  let bd = Infinity;
  let bang = 0;
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k];
    const b = path[k + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L < 1e-12 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < bd) {
      bd = d;
      bang = Math.atan2(dy, dx);
    }
  }
  return { d: bd, ang: bang };
}

export class TensorField {
  private sources: FieldSource[];
  private ring: Pt[];

  constructor(sources: FieldSource[], ring: Pt[] = []) {
    this.sources = sources;
    this.ring = ring;
  }

  /** 某点的主方向与一致性 */
  sample(x: number, y: number): FieldSample {
    let sc = 0;
    let ss = 0;
    let sw = 0;

    for (const s of this.sources) {
      const f = s.falloff ?? 2;
      let w = 0;
      let ang: number | null = null;

      switch (s.type) {
        case 'grid':
        case 'building': {
          const d = s.direction;
          if (!d) break;
          ang = Math.atan2(d.y, d.x);
          if (s.type === 'grid') {
            w = s.strength;
          } else if (s.position) {
            const dist = Math.hypot(x - s.position.x, y - s.position.y);
            w = s.strength * Math.exp(-Math.pow(dist / s.radius, f));
          }
          break;
        }
        case 'radial':
        case 'vortex': {
          if (!s.position) break;
          const dx = x - s.position.x;
          const dy = y - s.position.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 1e-6) break;
          ang = Math.atan2(dy, dx) + (s.type === 'vortex' ? Math.PI / 2 : 0);
          w = s.strength * Math.exp(-Math.pow(dist / s.radius, f));
          break;
        }
        case 'path': {
          if (!s.path || s.path.length < 2) break;
          const near = nearestOnPolyline(x, y, s.path);
          if (!isFinite(near.d)) break;
          ang = near.ang;
          w = s.strength * Math.exp(-Math.pow(near.d / s.radius, f));
          if (s.only === 'outside') {
            // 轮廓内归零；轮廓外 fade 带宽内用 smoothstep 爬升，
            // 避免场在切缝正中留下一个台阶（积分到那儿会打一个折）。
            const mask = s.mask ?? s.path;
            if (ringContains(mask, x, y)) break;
            const fade = s.fade ?? 1;
            // 渐变按**到轮廓**的距离算，不是到 path 的距离 ——
            // 边延长线型场源的 path 就压在轮廓上，用它量永远是 0。
            const fd = s.mask ? nearestOnPolyline(x, y, mask).d : near.d;
            if (fade > 1e-6 && fd < fade) {
              const t = fd / fade;
              w *= t * t * (3 - 2 * t);
            }
          }
          break;
        }
        case 'boundary': {
          if (this.ring.length < 3) break;
          const near = nearestOnPolyline(x, y, this.ring);
          if (!isFinite(near.d)) break;
          ang = near.ang;
          w = s.strength * Math.exp(-Math.pow(near.d / s.radius, f));
          break;
        }
      }

      if (ang === null || w <= 0) continue;
      // 张量投影：cos2θ / sin2θ 是二阶无迹张量的两个独立分量
      sc += Math.cos(2 * ang) * w;
      ss += Math.sin(2 * ang) * w;
      sw += w;
    }

    if (sw < 1e-9) return { a: 0, coherence: 0 };
    return { a: 0.5 * Math.atan2(ss, sc), coherence: Math.hypot(sc, ss) / sw };
  }

  /** 某个族的方向角（major = 主方向，minor = 主方向 + 90°） */
  angleAt(x: number, y: number, family: Family): { a: number; coherence: number } {
    const s = this.sample(x, y);
    return { a: family === 'minor' ? s.a + Math.PI / 2 : s.a, coherence: s.coherence };
  }

  /** 单位方向向量（RK4 的被积函数） */
  unit(x: number, y: number, family: Family): Pt {
    const { a } = this.angleAt(x, y, family);
    return new Pt(Math.cos(a), Math.sin(a));
  }
}
