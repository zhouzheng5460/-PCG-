// 统一地面采样（Phase G0）
//
// **这是唯一一份"某个坐标点归谁"的实现。** `auditCoverage`、G1/G2/G3 的原因标签、
// 以及以后任何"这块地有没有被认领"的判断，都必须走这里。
//
// 多份实现的代价是踩过的：G1 的第一版探测脚本自己写了一遍"有没有底板"，
// 没判断"底板**上方**还有没有别的东西"，于是把所有地块内的点都算成未覆盖
// （32089 个点 vs 审计的 4200 个）—— 两个口径的数字放在一起比，等于没测。
//
// 三条铁律：
//   ① 可见性（top）与功能归属（ground）**分开判断**，不能靠"命中底板"就判 B；
//   ② holes 必须减（环状的绿化带把整片内部算成自己，会让重叠虚高 37%）；
//   ③ `withinCity=false` 不是缺口，根本不进采样。
//
// 采样只产出**事实**（这个点被谁盖住、最上面是谁）。"为什么是 B"属于 G1/G2/G3
// 的解释层，放在 `b-labels.ts`，不污染这里。

import type { Model } from '../town/model';
import type { SurfaceFeature } from '../scene/types';
import { pointInRing } from '../town/planning/core/surface';
import { Pt } from '../core/geom';
import { buildScene } from '../scene/build';

/** 与 `auditCoverage` 完全一致的分类口径（等价提取，不改规则） */
export type CoverClass = 'A-road' | 'A-building' | 'A-planned' | 'B-plate' | 'C-hole';

export interface SampleFact {
  x: number;
  y: number;
  /** 是否落在某个 withinCity 的 block 里；否 = 城外，不参与任何统计 */
  inCity: boolean;
  /** 归属 block 的稳定 ID（patchKey 同源口径）；城外为 null */
  block: string | null;
  /** 落在建筑体块里（建筑压在所有地面之上） */
  inBuilding: boolean;
  /** 覆盖该点的所有面（含 overlay），按 y 从高到低 */
  hits: SurfaceFeature[];
  /** 最上层可见面 */
  top: SurfaceFeature | null;
  /** 最上层**唯一的功能面**（role !== overlay）；叠层不算功能归属 */
  ground: SurfaceFeature | null;
  /** 分类 */
  cover: CoverClass;
  /** 最上层只是底板 = 有颜色但没有功能语义 */
  plateOnly: boolean;
  /** 最上层是城市道路 */
  onRoad: boolean;
}

export interface SamplerOpts {
  /** 采样步长（世界单位）。0.5 ≈ 3.5 m */
  stepU?: number;
  /** AABB 索引格边长（世界单位） */
  cellU?: number;
}

const isOverlay = (s: { role?: string }) => s.role === 'overlay';
const isRoadGroup = (g: string) => g.startsWith('road');

export class SurfaceSampler {
  readonly scene: ReturnType<typeof buildScene>;
  readonly stepU: number;
  readonly cellU: number;
  /** 采样范围（所有 patch 的包围盒） */
  readonly bounds: { x0: number; y0: number; x1: number; y1: number };

  private grid = new Map<string, SurfaceFeature[]>();
  private recOf = new Map<number, string>();
  private patches: { shape: Pt[]; withinCity: boolean; blocked: boolean; block: string }[] = [];

  constructor(readonly model: Model, opts: SamplerOpts = {}) {
    this.stepU = opts.stepU ?? 0.5;
    this.cellU = opts.cellU ?? 8;
    this.scene = buildScene(model, { planningMode: 'planner', furniture: false, markings: false });

    // AABB 索引
    for (const s of this.scene.surfaces) {
      if (s.ring.length < 3) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of s.ring) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      for (let cx = Math.floor(x0 / this.cellU); cx <= Math.floor(x1 / this.cellU); cx++) {
        for (let cy = Math.floor(y0 / this.cellU); cy <= Math.floor(y1 / this.cellU); cy++) {
          const k = `${cx},${cy}`;
          const arr = this.grid.get(k);
          if (arr) arr.push(s);
          else this.grid.set(k, [s]);
        }
      }
    }

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    model.patches.forEach((p, i) => {
      const shape = Array.from(p.shape) as Pt[];
      for (const q of shape) {
        x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
        x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
      }
      if (p.blocked || !p.withinCity) return;
      const cx = shape.reduce((a, q) => a + q.x, 0) / shape.length;
      const cy = shape.reduce((a, q) => a + q.y, 0) / shape.length;
      const block = `${Math.round(cx)}:${Math.round(cy)}`;
      this.recOf.set(i, block);
      this.patches.push({ shape, withinCity: true, blocked: false, block });
    });
    this.bounds = { x0, y0, x1, y1 };
  }

  /** 点是否落在面里 —— **必须减洞**。环状的绿化带忽略洞就会把整片内部算成自己。 */
  covers(s: SurfaceFeature, x: number, y: number): boolean {
    const q = new Pt(x, y);
    if (!pointInRing(q, s.ring)) return false;
    for (const h of s.holes ?? []) if (pointInRing(q, h)) return false;
    return true;
  }

  /** 取一个采样点的全部事实 */
  sample(x: number, y: number): SampleFact {
    const q = new Pt(x, y);
    let block: string | null = null;
    for (let i = 0; i < this.model.patches.length; i++) {
      const b = this.recOf.get(i);
      if (!b) continue;
      const p = this.model.patches[i];
      if (!pointInRing(q, Array.from(p.shape) as Pt[])) continue;
      block = b;
      break;
    }
    if (!block) {
      return { x, y, inCity: false, block: null, inBuilding: false, hits: [], top: null, ground: null, cover: 'C-hole', plateOnly: false, onRoad: false };
    }

    let inBuilding = false;
    for (const s of this.scene.solids) if (pointInRing(q, s.ring)) { inBuilding = true; break; }

    const cands = this.grid.get(`${Math.floor(x / this.cellU)},${Math.floor(y / this.cellU)}`) ?? [];
    const hits = cands.filter((s) => this.covers(s, x, y)).sort((a, b) => b.y - a.y);
    const top = hits[0] ?? null;
    const ground = hits.find((s) => !isOverlay(s)) ?? null;
    const onRoad = !!top && (top.role === 'road' || isRoadGroup(top.group));
    const plateOnly = !!top && top.group === 'ground';

    let cover: CoverClass;
    if (inBuilding) cover = 'A-building';
    else if (hits.length === 0) cover = 'C-hole';
    else if (onRoad) cover = 'A-road';
    else if (plateOnly) cover = 'B-plate';
    else cover = 'A-planned';

    return { x, y, inCity: true, block, inBuilding, hits, top, ground, cover, plateOnly, onRoad };
  }

  /** 遍历采样网格（与 auditCoverage 的网格完全一致） */
  *walk(): Generator<SampleFact> {
    const b = this.bounds;
    for (let x = b.x0; x <= b.x1; x += this.stepU) {
      for (let y = b.y0; y <= b.y1; y += this.stepU) {
        yield this.sample(x, y);
      }
    }
  }

  /** 每个采样格的面积（m²） */
  get cellM2(): number {
    return this.stepU * this.stepU * 49;
  }
}
