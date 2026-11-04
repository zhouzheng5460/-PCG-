// 绿地分块 · 把一大片绿地切成"一组小块 + 一套园路"
//
// 用它的有两处：Planner 接管的地块（realize/adapters.ts）和 legacy 地块
// （modern.ts 的 orphan_ground）。所以放在 town/ 这一层而不是 realize/ ——
// 两边都要用，不能挂在其中一边的目录下。
//
// ## 为什么要它
//
// 用户的原话：**"大片的绿地没有分块规划"**。
//
// 现状是 Planner 给出一块 `landscape` 程序，Realizer 就把这块面**整片**刷成
// 一个 grassDark —— 于是城市里每一片绿地都是同一块纯色、同一种绿、一条边到底。
// 俯视图上看不出"这是公园 / 这是保留地 / 这是厂区绿带"，只看见一片绿补丁。
//
// 真实的总图里，绿地是**被园路切开的一组小块**：修剪草坪、草甸、密林，
// 每块 20~40 m 见方，块与块之间是园路，外圈还有一条环路。
// 这种"看起来有规划"的质感，大半来自**块的边界**，不是来自颜色。
//
// ## 为什么放在 Realizer
//
// 它不决定"这块地是绿地"（那是 Planner 的 program），只在**已经定为绿地**的
// 面内部把 20~40 m 的块画出来。Program 不变、面积不变、边界不变 ——
// 只改"长什么样"。
//
// ## 算法：先定园路，剩下的都是块
//
//   1. 外圈环 = 面 − 内缩(pathW)           → 一条环路（与城市人行道接上）
//   2. 网格线 = 内缩面里每隔 blockM 的若干条**带子**（宽 pathW）
//   3. 块   = 内缩面 − 所有带子
//
// 反过来（先切块、再求"面 − 块 = 路"）不行：`rectsInArea` 只收**完全落在面内**
// 的格子，边界那一圈会被整圈丢掉，于是绿地外围会出现一条 30 m 宽的空白 ——
// 比原来更难看。所以这里以"路"为主角，块是被路切出来的余料，边界天然贴合。
//
// 三块拼起来**恰好铺满原面**（环 + 带 + 块互不重叠、并集 = 原面），
// 所以不存在缝隙和 z-fighting。
//
// ## 红线
//
//   ① 不越出原面 —— 所有输出都是原面的子集；
//   ② 不改 program、不改面积（块之外全算园路，园路仍属这块绿地）；
//   ③ 块数上限（默认 40）—— 一块绿地切出上百格只会变噪点，不是规划；
//   ④ 布尔退化就**整块放弃分块**（返回 null 走整片铺），绝不输出破面。

import type { MatKey } from '../scene/palette';
import { Pt } from '../core/geom';import {
  type PlanSurface,
  surface,
  surfaceArea,
  surfaceInset,
  surfaceSubtract,
  surfaceIntersect,
  geometryFailures,
} from './planning/core/surface';

const U = (m: number) => m / 7;

/** 一块切出来的绿地 */
export interface GreenPlot {
  surface: PlanSurface;
  mat: MatKey;
  /** 语义标签，写进面名字里，方便图层里单独选 */
  kind: 'lawn' | 'meadow' | 'grove';
}

export interface GreenSubdivision {
  /** 园路（环路 + 内部路网），拼起来是"原面 − 块" */
  paths: PlanSurface[];
  plots: GreenPlot[];
}

/** 这些 program 才做分块 —— 车位、货场、步行街不切 */
const SUBDIVIDABLE = new Set(['landscape', 'community_green', 'security_buffer', 'front_yard', 'rear_yard']);

/**
 * 三种绿的分配。
 *
 * 读法：靠近边缘（临街）是**修剪草坪**（人待的地方），越往深处越"野"：
 * 草甸 → 密林。规则很朴素，但它让每一片绿有**方向上的层次**；
 * 随机撒三种颜色只会更乱，那是噪点不是规划。
 */
const MAT_OF: Record<GreenPlot['kind'], MatKey> = {
  lawn: 'lawn',
  meadow: 'grass',
  grove: 'grassDark',
};

/** 稳定的 0~1 哈希，做确定性的"手抖" */
function h2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function centroid(ring: ReadonlyArray<{ x: number; y: number }>) {
  let x = 0, y = 0;
  for (const p of ring) { x += p.x; y += p.y; }
  return { x: x / ring.length, y: y / ring.length };
}

/**
 * 等分 + 逐条错动，返回网格线的坐标。
 *
 * `jitter` 是一格的比例：0 = 完全等距（表格感），0.22 = 误差约 ±1/5 格。
 * 错动量受**相邻线间距**约束（不超过半格），保证线不会交叉、块不会消失。
 */
function spread(lo: number, len: number, step: number, jitter: number, salt: number): number[] {
  const n = Math.floor(len / step);
  if (n < 1) return [];
  const out: number[] = [];
  for (let k = 1; k <= n; k++) {
    const base = lo + (k * len) / (n + 1);
    const j = (h2(base * 0.71 + salt, k * 13.7) - 0.5) * 2 * jitter * step;
    // 夹在相邻等分点之间，留 25% 余量，块不会被挤成零宽
    const loK = lo + ((k - 0.75) * len) / (n + 1);
    const hiK = lo + ((k + 0.75) * len) / (n + 1);
    out.push(Math.max(loK, Math.min(hiK, base + j)));
  }
  return out;
}

export interface GreenOpts {
  /** 每块的目标边长（m）。不给就在 22~46 m 之间按地块位置取一个 —— 全城同一个模数最假 */
  blockM?: number;
  /** 园路宽（m）。不给就在 2.5~4.5 m 之间取 */
  pathM?: number;
  /** 最多切几块 */
  maxPlots?: number;
  /** 小于这个面积不分块（m²） */
  minAreaM2?: number;
  /** 网格线的错动量（占一格的比例，0 = 完全等距）。默认 0.22 */
  jitter?: number;
}

/**
 * 把一块绿地切成"一组小块 + 一套园路"。
 *
 * 返回 null 表示这块不值得切（太小 / 太窄 / 切不出两块 / 布尔退化），
 * 调用方按原来的方式整片铺。
 */
export function subdivideGreen(area: PlanSurface, program: string, opts: GreenOpts = {}): GreenSubdivision | null {
  if (!SUBDIVIDABLE.has(program)) return null;

  const maxPlots = opts.maxPlots ?? 40;
  const minAreaM2 = opts.minAreaM2 ?? 900;
  const jitter = opts.jitter ?? 0.22;

  const a2 = surfaceArea(area);
  if (a2 * 49 < minAreaM2) return null;

  const c0 = centroid(area.outer);
  // 每个地块一个稳定的"性格"：模数、路宽都不一样。
  // 全城用同一个 32 m 模数时，俯视图会读成一张表格 —— 规整到失真。
  const r1 = h2(c0.x * 0.37 + 11.3, c0.y * 0.41 - 5.7);
  const r2 = h2(c0.y * 0.53 - 3.1, c0.x * 0.29 + 7.9);
  const blockM = opts.blockM ?? 22 + 24 * r1;
  const pathM = opts.pathM ?? 2.5 + 2.0 * r2;

  const pathW = U(pathM);
  // 内缩出一个"可切区"：外围那一圈就是环路
  const insetPieces = surfaceInset(area, pathW).filter((p) => surfaceArea(p) > U(6) * U(6));
  if (!insetPieces.length) return null;
  const inner = insetPieces.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
  const innerA = surfaceArea(inner);
  if (innerA < U(14) * U(14)) return null;

  // bbox
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of inner.outer) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  // 模数不能只看"想要多大一块"：城市外圈那种四万平米的绿地，按 25 m 铺网格
  // 会切出上百格，超过 maxPlots 就被整块放弃（于是最大的那几块反而没切）。
  // 所以取"想要的模数"和"块数预算反推的模数"里较大的那个。
  const step = Math.max(U(blockM), Math.sqrt(innerA / (maxPlots * 0.7)));

  // 网格线：先等分，再逐条错动 —— 错动后路网间距不均，读起来才像"顺着地形画的"
  // 而不是"先铺了一张表格再把绿地塞进去"。
  const lineXs = spread(x0, w, step, jitter, c0.x);
  const lineYs = spread(y0, h, step, jitter, c0.y);

  const strips: PlanSurface[] = [];
  const halfW = pathW / 2;
  for (const x of lineXs) {
    const strip = surface([
      new Pt(x - halfW, y0 - pathW),
      new Pt(x + halfW, y0 - pathW),
      new Pt(x + halfW, y1 + pathW),
      new Pt(x - halfW, y1 + pathW),
    ]);
    strips.push(...surfaceIntersect([strip], [inner]).filter((p) => surfaceArea(p) > 1e-6));
  }
  for (const y of lineYs) {
    const strip = surface([
      new Pt(x0 - pathW, y - halfW),
      new Pt(x1 + pathW, y - halfW),
      new Pt(x1 + pathW, y + halfW),
      new Pt(x0 - pathW, y + halfW),
    ]);
    strips.push(...surfaceIntersect([strip], [inner]).filter((p) => surfaceArea(p) > 1e-6));
  }

  const fail0 = geometryFailures.subtract + geometryFailures.intersect;
  // 块 = 内缩面 − 所有带子
  const cells = strips.length ? surfaceSubtract([inner], strips).filter((p) => surfaceArea(p) > 0.5) : [inner];
  // 环路 = 原面 − 内缩面
  const ring = surfaceSubtract([area], [inner]).filter((p) => surfaceArea(p) > 1e-6);
  if (geometryFailures.subtract + geometryFailures.intersect > fail0) return null; // 布尔退化：整块放弃分块
  if (cells.length < 2 || cells.length > maxPlots) return null;

  let rMax = 1e-9;
  for (const p of area.outer) rMax = Math.max(rMax, Math.hypot(p.x - c0.x, p.y - c0.y));

  const plots: GreenPlot[] = [];
  for (const cell of cells) {
    if (cell.outer.length < 3) continue;
    const c = centroid(cell.outer);
    const t = Math.min(1, Math.hypot(c.x - c0.x, c.y - c0.y) / rMax);
    const jit = (h2(c.x, c.y) - 0.5) * 0.18; // 手抖：免得同一圈全同色又变成色带
    const score = t + jit;
    const kind: GreenPlot['kind'] = score < 0.42 ? 'lawn' : score < 0.74 ? 'meadow' : 'grove';
    plots.push({ surface: cell, mat: MAT_OF[kind], kind });
  }
  if (!plots.length) return null;

  return { paths: [...ring, ...strips], plots };
}
