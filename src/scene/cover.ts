// 覆盖率栅格化 —— HUD 里"绿地率 / 道路面积率 / 建筑密度"的算法底座。
//
// 为什么不直接把多边形面积加起来
// ------------------------------
// 场景是**分层叠出来的**：每个街区先铺一整块底（ground / grass），
// 再把铺装、建筑基底压上去。所以同一个位置可能有 2~3 个多边形互相覆盖。
// 直接求和会得到 190% 的绿地率（实测数据：草地多边形加起来 117 ha，
// 而整个建成区只有 62.8 ha）—— 这个数不但没用，还会让人以为规则坏了。
//
// 求并集呢？`polygon-clipping` 逐个累积并集是 O(n²)：城市场景有近千个
// 铺装多边形，实测 6.3 秒，不可能放进"拖一次滑杆就刷一次"的路径。
//
// 所以改成**扫描线栅格化**：和 2D 画布完全相同的绘制顺序（按 `y` 从低到高），
// 把每层刷进一张 Uint8 网格，后刷的盖掉先刷的。最后数格子。
//   · 天然处理重叠：一格只有一个归属
//   · 天然处理覆盖关系：谁在上面就是谁
//   · 快：每个多边形只按行做交线，不涉及全局布尔运算
// 精度取 1 世界单位（≈ 7 m）一格，对"绿地率 26% 还是 31%"这种判断绰绰有余。

import { Pt } from '../core/geom';
import type { Scene } from './types';
import { layerOfSurface } from './layers';

/** 一个格子最后被谁盖住 */
export enum Cover {
  None = 0,
  Green = 1,
  Water = 2,
  Soil = 3,
  Hard = 4,
  Road = 5,
  Walk = 6,
  Building = 7,
}

export interface CoverResult {
  /** 每类各占多少格 */
  cells: Record<Cover, number>;
  /** 被任何要素盖住的格数（= 城市化范围） */
  urban: number;
  /** 一格代表多少 m² */
  cellM2: number;
  /** 网格边长（格数） */
  gw: number;
  gh: number;
  /** 网格原点（世界坐标）与格宽（世界单位） */
  ox: number;
  oy: number;
  cell: number;
}

function layerCover(id: string): Cover {
  switch (id) {
    case 'surface:ground':
      // 街区底：默认是夯土/混凝土色，不算绿地也不算硬质铺装
      return Cover.None;
    case 'pave:grass':
      return Cover.Green;
    case 'pave:water':
      return Cover.Water;
    case 'pave:soil':
      return Cover.Soil;
    case 'pave:hard':
    case 'pave:asphalt':
      return Cover.Hard;
    case 'road:asphalt':
    case 'road:junction':
      return Cover.Road;
    case 'road:walk':
    case 'road:verge':
      return Cover.Walk;
    case 'road:mark':
    case 'road:parkmark':
      // 标线是画在路面上的，不该改变路面归属
      return Cover.Road;
    default:
      return Cover.Hard;
  }
}

/**
 * 把一个环按扫描线刷进网格。
 *
 * 只在多边形自己的 bbox 内逐行求交，不去碰整张网格 —— 一条 200 单位的
 * 路侧绿带只占几行，按整图遍历就废了。
 */
function fillRing(
  grid: Uint8Array,
  gw: number,
  gh: number,
  ox: number,
  oy: number,
  cell: number,
  ring: Pt[],
  code: number
): void {
  if (ring.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of ring) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  let j0 = Math.floor((minY - oy) / cell);
  let j1 = Math.ceil((maxY - oy) / cell);
  if (j0 < 0) j0 = 0;
  if (j1 > gh - 1) j1 = gh - 1;
  if (j0 > j1) return;

  const n = ring.length;
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = oy + (j + 0.5) * cell;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a.y === b.y) continue;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      // 半开区间，避免顶点被数两次
      if (y < lo || y >= hi) continue;
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = j * gw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let c0 = Math.ceil((xs[k] - ox) / cell - 0.5);
      let c1 = Math.floor((xs[k + 1] - ox) / cell - 0.5);
      if (c0 < 0) c0 = 0;
      if (c1 > gw - 1) c1 = gw - 1;
      for (let c = c0; c <= c1; c++) grid[row + c] = code;
    }
  }
}

/**
 * 把一条折线按线宽刷进网格。
 *
 * 路径要素存的是**折线 + width**，不是闭合环，直接丢给 fillRing 会画出乱七八糟的形状。
 * 所以按段展开成矩形（沿法线各偏移半个线宽），逐段刷。
 * 相邻段的矩形在拐角处会重叠 —— 同一代码，重叠无害；尖角外侧的缺口对
 * 「一格 ≈ 7 m」的统计精度没有影响。
 */
function strokePath(
  grid: Uint8Array,
  gw: number,
  gh: number,
  ox: number,
  oy: number,
  cell: number,
  pts: Pt[],
  width: number,
  code: number
): void {
  if (pts.length < 2) return;
  const hw = Math.max(width, cell * 0.5) / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const nx = (-dy / L) * hw;
    const ny = (dx / L) * hw;
    fillRing(
      grid,
      gw,
      gh,
      ox,
      oy,
      cell,
      [
        new Pt(a.x + nx, a.y + ny),
        new Pt(b.x + nx, b.y + ny),
        new Pt(b.x - nx, b.y - ny),
        new Pt(a.x - nx, a.y - ny),
      ],
      code
    );
  }
}

/**
 * 刷一遍场景，返回各类覆盖格数。
 *
 * 顺序就是画布的顺序：地面（按 y 升序）→ 贴地路径 → 建筑基底。
 * 建筑基底最后刷，因为楼确实压在铺地上，把楼底下算成"绿地"没意义。
 */
export function measureCover(scene: Scene, cellWanted = 1): CoverResult {
  // ---- 先求总 bbox
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (ring: Pt[]) => {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  };
  for (const s of scene.surfaces) grow(s.ring);
  for (const s of scene.solids) grow(s.ring);
  for (const p of scene.paths) grow(p.pts);

  const empty: CoverResult = {
    cells: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } as Record<Cover, number>,
    urban: 0,
    cellM2: cellWanted * cellWanted * 49,
    gw: 0,
    gh: 0,
    ox: 0,
    oy: 0,
    cell: cellWanted,
  };
  if (!isFinite(minX) || maxX <= minX || maxY <= minY) return empty;

  // 特大城（n=120）bbox 可能到 3000 单位，限制网格总量在 ~400 万格以内
  const span = Math.max(maxX - minX, maxY - minY);
  const cell = Math.max(cellWanted, span / 2000);

  const ox = minX;
  const oy = minY;
  const gw = Math.min(2000, Math.ceil((maxX - minX) / cell) + 1);
  const gh = Math.min(2000, Math.ceil((maxY - minY) / cell) + 1);
  const grid = new Uint8Array(gw * gh);

  // 面：按 y 升序（= 画布的绘制顺序），后刷的盖掉先刷的
  const surfaces = scene.surfaces.slice().sort((a, b) => a.y - b.y);
  for (const s of surfaces) {
    const code = layerCover(layerOfSurface(s));
    if (code === Cover.None) continue;
    fillRing(grid, gw, gh, ox, oy, cell, s.ring, code);
    // 标线不该把路面"升级"成路面（本来就是），但也不该盖掉人行道 —— 已经统一归 Road
  }

  // 贴地路径：地块内部路 / 园路 / 建筑入口路。算硬质铺装，**不算市政道路** ——
  // 「道路面积率」这个指标的口径是城市道路网，地块里自己铺的路不属于它。
  for (const p of scene.paths) {
    if (p.height && p.height > 0.05) continue; // 围栏是竖的，不占地面
    strokePath(grid, gw, gh, ox, oy, cell, p.pts, p.width, Cover.Hard);
  }

  // 建筑基底最后刷：楼底下不是绿地
  for (const s of scene.solids) {
    fillRing(grid, gw, gh, ox, oy, cell, s.ring, Cover.Building);
  }

  const cells = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } as Record<Cover, number>;
  let urban = 0;
  for (let i = 0; i < grid.length; i++) {
    const c = grid[i] as Cover;
    if (c === Cover.None) continue;
    cells[c]++;
    urban++;
  }

  return { cells, urban, cellM2: cell * cell * 49, gw, gh, ox, oy, cell };
}
