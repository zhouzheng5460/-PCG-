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
  /**
   * 分解基准角（弧度）。给定时网格**沿这个方向**铺，输出的矩形也平行于它。
   *
   * 这是这条算法最关键的参数：不给（=0）就是世界轴对齐，
   * 而城市里的街道是斜的 —— 于是沿街建筑被切成与世界坐标对齐的小块，
   * 和街道成一个角度，看起来就是**锯齿状垂直**。
   * 传 `primaryFrontage` 的方向之后，沿街那一排就是平行于道路的直角盒。
   */
  angle?: number;
}

export function rectsInArea(area: PlanSurface, opts: RectOpts = {}): PlanSurface[] {
  const step = opts.step ?? 0.4;
  const minSide = opts.minSide ?? step * 1.5;
  const minArea = opts.minArea ?? step * step;

  // 先旋转到"沿街坐标系"再分解，最后转回世界。
  const ang = opts.angle ?? 0;
  const cs = Math.cos(-ang);
  const sn = Math.sin(-ang);
  const fwd = (p: Pt) => new Pt(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
  const back = (p: Pt) => {
    const c = Math.cos(ang);
    const s2 = Math.sin(ang);
    return new Pt(p.x * c - p.y * s2, p.x * s2 + p.y * c);
  };
  const work = ang === 0 ? area : surface(area.outer.map(fwd), area.holes.map((h) => h.map(fwd)));

  const b = bboxOf(work.outer);
  const nx = Math.max(1, Math.floor((b.maxX - b.minX) / step));
  const ny = Math.max(1, Math.floor((b.maxY - b.minY) / step));
  // 网格太细就退化成"整块"，避免在大地块上算出几万个格子
  if (nx * ny > 40000) return [area];

  // ---- ① 标记可用格子
  const ok: boolean[][] = [];
  const at = (x: number, y: number) => insideSurface(new Pt(x, y), work);
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
      out.push(ang === 0 ? r : surface(r.outer.map(back)));
    }
  }

  return out;
}

/**
 * 在**给定基准角**下是不是一个真正的矩形（4 顶点 + 每条边都轴向）。
 *
 * 早先用"矩形度 ≥ 0.985"判断，问题是切了一个角的五边形矩形度也能到 0.99 ——
 * 于是它被原样放过，3D 里就是一个**五边形楼**。用户看的"还有很多多边形"
 * 就是这批。这里改成严格判：顶点必须 4 个、每条边在基准坐标系里必须是水平或垂直。
 */
function isAxisRect(ring: Pt[], ang: number): boolean {
  if (ring.length !== 4) return false;
  const cs = Math.cos(-ang);
  const sn = Math.sin(-ang);
  const rot = ring.map((p) => new Pt(p.x * cs - p.y * sn, p.x * sn + p.y * cs));
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const a = rot[i];
    const b = rot[(i + 1) % 4];
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    // 每条边必须几乎纯水平或纯垂直（容差 0.02 单位 ≈ 14 cm）
    if (dx > 0.02 && dy > 0.02) return false;
    area2 += a.x * b.y - b.x * a.y;
  }
  // 退化（面积≈0）不算矩形
  return Math.abs(area2) > 1e-6;
}

/**
 * 把一个面变成"矩形组"：如果它本来就方正，原样返回；否则分解。
 *
 * 判据是**矩形度**（面积 / 外接矩形面积）。>= 0.94 直接放过 —— 这时候
 * 分解只会把好好的一个盒切成几段，反而变差。
 */
export function asRects(area: PlanSurface, opts: RectOpts = {}): PlanSurface[] {
  // 矩形度必须在**同一个基准角**下算。
  //
  // 这是锯齿的第二个来源：一个平行于斜街的矩形，用世界轴对齐的外接框去量，
  // 外接框比它大一圈，矩形度只有 0.7~0.85 → 判成"不方正" → 被反复分解成碎片。
  // 按基准角旋转后再量，它就是 1.00，原样放过。
  if (area.holes.length === 0 && isAxisRect(area.outer, opts.angle ?? 0)) return [area];
  const rects = rectsInArea(area, opts);
  return rects.length > 0 ? rects : [area];
}
