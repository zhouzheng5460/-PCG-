import { Pt } from '../../../../core/geom';
import { type PlanSurface, surface, surfaceArea, insideSurface, bboxOf } from '../../core/surface';

/**
 * 矩形分解：把一个不规则面切成若干**轴对齐矩形**。
 *
 * ## 为什么要它
 *
 * 所有 archetype 原来都是 `矩形 ∩ 可建区`。在矩形地块上没问题，但在斜边 /
 * 不规则地块上，交出来的是梯形、五边形、带斜边的多边形 —— 3D 里拉起来
 * 就是"被挤出来的怪形状"，和"直角立方体盒子组合"完全是两回事。
 *
 * 真实城市在斜街上的做法就是**阶梯退台**：一栋楼由几个直角盒子错落拼起来。
 * 这个函数产出的正是那组盒子。
 *
 * ## 算法
 *
 * 网格法（不是多边形布尔）：
 *   1. 在面的 bbox 里铺 `step` 见方的网格；
 *   2. 一个格子被标记为"可用"，当且仅当它的**四角与中心都落在面内**
 *      （多测中心是为了排掉细长的越界条带）；
 *   3. 贪心合并：逐格向右扩到最长，再整行向上扩到最高，产出一个矩形；
 *   4. 重复到没有未用格子。
 *
 * 取"完全落在面内"而不是"中心在面内"：建筑不许探出可建区，
 * 边缘那一圈锯齿宁可丢掉（丢掉的正是斜边上三角形的那些格子）。
 *
 * ## 已知取舍
 *
 * - 结果是**锯齿边**，不是最优矩形覆盖（最优是 O(n^1.5) 的精确覆盖，
 *   这里用贪心，差几个百分点，对建筑体量完全够用）；
 * - 边缘会被啃掉一圈（详见上一条），覆盖率因此略降；
 * - 短边不足 `minSide` 的矩形丢弃 —— 那是纸片楼，不是体量。
 */
export interface RectOpts {
  /** 网格边长（世界单位）。0.5 ≈ 3.5 m，0.7 ≈ 5 m */
  step?: number;
  /** 矩形短边下限（世界单位），低于它的丢弃 */
  minSide?: number;
  /** 丢掉面积小于这个值的矩形（世界单位²） */
  minArea?: number;
}

export function rectsInArea(area: PlanSurface, opts: RectOpts = {}): PlanSurface[] {
  const step = opts.step ?? 0.4;
  const minSide = opts.minSide ?? step * 1.5;
  const minArea = opts.minArea ?? step * step;

  const b = bboxOf(area.outer);
  const nx = Math.max(1, Math.floor((b.maxX - b.minX) / step));
  const ny = Math.max(1, Math.floor((b.maxY - b.minY) / step));
  // 网格太细就退化成"整块"，避免在大地块上算出几万个格子
  if (nx * ny > 40000) return [area];

  // ---- ① 标记可用格子
  const ok: boolean[][] = [];
  const at = (x: number, y: number) => insideSurface(new Pt(x, y), area);
  for (let i = 0; i < nx; i++) {
    ok[i] = [];
    const x0 = b.minX + i * step;
    const x1 = x0 + step;
    const xm = (x0 + x1) / 2;
    for (let j = 0; j < ny; j++) {
      const y0 = b.minY + j * step;
      const y1 = y0 + step;
      const ym = (y0 + y1) / 2;
      ok[i][j] = at(x0, y0) && at(x1, y0) && at(x1, y1) && at(x0, y1) && at(xm, ym);
    }
  }

  // ---- ② 贪心合并
  const used: boolean[][] = ok.map((col) => col.map(() => false));
  const out: PlanSurface[] = [];

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!ok[i][j] || used[i][j]) continue;

      // 向右扩到最长
      let w = 1;
      while (i + w < nx && ok[i + w][j] && !used[i + w][j]) w++;

      // 整行向上扩到最高
      let h = 1;
      const rowFree = (jj: number) => {
        for (let k = 0; k < w; k++) if (!ok[i + k][jj] || used[i + k][jj]) return false;
        return true;
      };
      while (j + h < ny && rowFree(j + h)) h++;

      for (let a = 0; a < w; a++) for (let bb = 0; bb < h; bb++) used[i + a][j + bb] = true;

      const x0 = b.minX + i * step;
      const y0 = b.minY + j * step;
      const x1 = x0 + w * step;
      const y1 = y0 + h * step;
      if (Math.min(x1 - x0, y1 - y0) < minSide) continue;
      const r = surface([
        new Pt(x0, y0),
        new Pt(x1, y0),
        new Pt(x1, y1),
        new Pt(x0, y1),
      ]);
      if (surfaceArea(r) < minArea) continue;
      out.push(r);
    }
  }

  return out;
}

/**
 * 把一个面变成"矩形组"：如果它本来就方正，原样返回；否则分解。
 *
 * 判据是**矩形度**（面积 / 外接矩形面积）。>= 0.94 直接放过 —— 这时候
 * 分解只会把好好的一个盒切成几段，反而变差。
 */
export function asRects(area: PlanSurface, opts: RectOpts = {}): PlanSurface[] {
  const b = bboxOf(area.outer);
  const bboxArea = (b.maxX - b.minX) * (b.maxY - b.minY);
  const rectness = bboxArea > 1e-9 ? surfaceArea(area) / bboxArea : 0;
  if (rectness >= 0.94 && area.holes.length === 0) return [area];
  const rects = rectsInArea(area, opts);
  return rects.length > 0 ? rects : [area];
}
