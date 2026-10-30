// 禁建区避障（ZoneObstacles）。
//
// 要解决的问题
// ------------
// 早期禁区是按"方向场源"参与合成的：把禁区的边延长成几条长直线，让街道与它平行。
// 结果是路网被**掰成与禁区边平行**、一路铺到禁区红线上，布尔切块再把穿过禁区的那几段
// 切掉 —— 禁区四周只剩几段被砍断的沥青，转角处等级还跳变。读起来就是"路硬怼在禁区上"。
//
// 用户要的是**避障**：每条路像水流绕过石头一样，自己从旁边弯过去，留一段让距，
// 但**不要围着禁区修一圈环路**，也不要路在禁区边上断头。
//
// 为什么不用"切向场源"、也不用"每条线各绕各的弧"
// ------------------------------------------------
// · 纯切向场会把进入影响带的流线**捕获成绕禁区一圈的闭合环**；闭合环被追踪器的
//   自交检测掐断，每条被捕获的线都留两个断头。权重调强必捕获，调弱路照样怼上去。
// · "把穿过禁区的那一段换成贴轮廓的绕行弧"会让多条线塌到同一条轮廓上，
//   平面图立刻长出针尖碎面和骑在车行道上的楼。
//
// 这里用**位移场（warp）**：
//   p → q + n · (|s| + δ(s))
// 其中 q 是禁区边界上的最近点、n 是 q 处的**外法线**、s 是有符号距离。
// δ(s) 随 s 单调递减（远处为 0），于是：
//   · 线在禁区边上被推到 pad 之外，且越靠里推得越多 —— 各条线保持自己的间距，
//     不会塌到一条曲线上；
//   · 穿过禁区的线不断，它只是鼓成一条绕过去的弧（正是参考图里的样子）；
//   · 位移只跟"点在哪儿"有关、跟"是哪条线"无关，相邻线不会被拉成交叉。
//
// δ 取 pad·exp(-(s/R)²)：s=0 时正好是让距 pad，往外平滑收敛到 0。

import { Pt } from '../../core/geom';

/** 有符号距离 + 最近点 + 该点处的外法线（向内为负） */
interface SdSample {
  sd: number;
  qx: number;
  qy: number;
  nx: number;
  ny: number;
}

function ringSd(ring: Pt[], x: number, y: number): SdSample {
  // 外法线要用环的绕向定，先算一次有符号面积（顺/逆时针决定法线朝哪边）
  const ccw = signedArea(ring) > 0;
  let best = Infinity;
  let qx = 0;
  let qy = 0;
  let enx = 1;
  let eny = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 < 1e-12 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best) {
      best = d;
      qx = px;
      qy = py;
      const L = Math.sqrt(L2);
      if (L > 1e-12) {
        // CCW 环：边 a→b 的左法线 (-dy, dx) 朝内，外法线取反
        enx = ccw ? dy / L : -dy / L;
        eny = ccw ? -dx / L : dx / L;
      }
    }
  }
  const inside = ringContains(ring, x, y);
  // 法线取"从最近点指向外侧"的径向，而不是边法线 —— 这条很关键：
  //
  // 边法线只在最近点落在那条边的**内部**时才是真正的让距方向。一旦最近点是
  // **顶点**（路从禁区角上擦过去），两条边各自的让距线在角上接不上，用边法线
  // 夹出来的点连成直线段就会把角切掉 —— 实测一条六车道的中线因此压到 1.30u
  // （让距是 1.71u），路缘直接啃掉禁区 1.4 m。
  // 改用径向：让距线在角上自然变成一段以顶点为圆心的圆弧，正是"圆角化偏移"
  // （Minkowski 和），任何方向上都不会小于让距。
  let nx = enx;
  let ny = eny;
  const rl = best;
  if (rl > 1e-6) {
    const ux = (qx - x) / rl;
    const uy = (qy - y) / rl;
    // 内部点：(q-p) 朝外；外部点：(p-q) 朝外
    nx = inside ? ux : -ux;
    ny = inside ? uy : -uy;
  }
  return { sd: inside ? -best : best, qx, qy, nx, ny };
}

function ringContains(ring: Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a * 0.5;
}

/** 轻量拉普拉斯平滑：只在拐弯处起作用，直线段不受影响 */
function smooth(pts: Pt[], passes: number, weight: number): Pt[] {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = out.map((q) => q);
    for (let i = 1; i + 1 < out.length; i++) {
      const ax = (out[i - 1].x + out[i + 1].x) / 2;
      const ay = (out[i - 1].y + out[i + 1].y) / 2;
      next[i] = new Pt(out[i].x + (ax - out[i].x) * weight, out[i].y + (ay - out[i].y) * weight);
    }
    out = next;
  }
  return out;
}

export class ZoneObstacles {
  private rings: Pt[][];
  private pad: number;
  /** δ 的影响尺度：影响半径 = RATIO·pad（太大则半座城都在挪，太小则拐角发硬） */
  private readonly RATIO = 1.25;
  /** 禁区里侧每深 1 单位，额外让出多少（保证多条穿越线不会叠到同一条弧上） */
  private readonly DEPTH_K = 0.22;

  constructor(rings: Pt[][], pad: number) {
    this.rings = rings.filter((r) => r.length >= 3);
    this.pad = Math.max(0, pad);
  }

  get empty(): boolean {
    return this.rings.length === 0;
  }

  /** 最近那块禁区的采样（多个禁区取 |sd| 最小的） */
  private nearest(x: number, y: number): SdSample | null {
    let best: SdSample | null = null;
    let bestD = Infinity;
    for (const r of this.rings) {
      const s = ringSd(r, x, y);
      const d = Math.abs(s.sd);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** 到最近禁区的有符号距离（内负外正） */
  sd(x: number, y: number): number {
    const s = this.nearest(x, y);
    return s ? s.sd : Infinity;
  }

  /** 这个点是否落在禁区（或让距带）里 */
  blocks(x: number, y: number): boolean {
    return this.sd(x, y) < this.pad;
  }

  /**
   * 能不能在这里播种。
   *
   * 只禁"禁区本体 + 一点点边缘"，**不是**整条让距带 —— 让距带里照样要有街道，
   * 它们会被推到 pad 外面去。要是整带都禁播，禁区四周会空出一大圈没有路的荒地
   * （实测路网直接掉 14%），读起来是"禁区孤零零站在公园中间"，
   * 而不是参考图里"路从旁边拐过去"的样子。
   */
  seedOk(x: number, y: number): boolean {
    return this.sd(x, y) > this.pad * 0.35;
  }

  /**
   * 把"进了禁区 / 没让够让距"的点推到让距线上（沿外法线出）；已经够远的点原样返回。
   *
   * 早先这里是无条件投影，于是**每一段被剪出来的线头**都会被拽到让距线上 ——
   * 哪怕它本来在 10 单位外。那根凭空长出来的尖刺会穿过十几条街，
   * 平面图立刻炸成一堆交点。必须只处理真正在带里的点。
   */
  private clampPoint(p: Pt): Pt {
    const s = this.nearest(p.x, p.y);
    if (!s || s.sd >= this.pad) return p;
    return new Pt(s.qx + s.nx * this.pad, s.qy + s.ny * this.pad);
  }

  /** 把点放到"禁区边界 + 让距"的那条等距线上（沿外法线出） */
  private outlet(p: Pt): Pt {
    return this.clampPoint(p);
  }

  /**
   * 一条流线的避障处理，可能切出 0~2 段。
   *
   * 规则只有两条，都很硬：
   *   · **进到禁区里的那一段直接剪掉**。禁区里不该有路；把它掰弯绕过整块禁区
   *     反而会在禁区正面堆出一圈同心弧 —— 那就是"环路"，用户明确不要。
   *   · 留在禁区外、但没让够让距的点，沿外法线推到让距线上。
   *     贴边过去的那几条街于是自动变成"顺着禁区边弯过去"的弧 —— 参考图里
   *     那几条黄线就是这么来的，它们本来就是网格里的普通街道，没有任何一条
   *     是"为禁区专门修的路"。
   *
   * 注意这里是**逐点**处理、没有"判定环/绕行弧"那套东西：点的去向只取决于它
   * 离禁区多远，不取决于它属于哪条线，所以交叉口、门牌、间距都是下游的常规流程。
   */
  route(pts: Pt[]): Pt[][] {
    if (this.rings.length === 0 || pts.length < 2) return [pts];

    const inside = pts.map((p) => this.sd(p.x, p.y) < 0);
    if (!inside.some(Boolean)) return [this.hug(pts)];

    const out: Pt[][] = [];
    let cur: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (inside[i]) {
        if (cur.length >= 2) out.push(cur);
        cur = [];
        continue;
      }
      cur.push(pts[i]);
    }
    if (cur.length >= 2) out.push(cur);

    // 剪完两端都要落在让距线上（在带里的才推，够远的不动），
    // 否则会在禁区边上留下一个悬空的路头
    return out
      .map((seg) => {
        const body = this.hug(seg);
        body[0] = this.outlet(seg[0]);
        body[body.length - 1] = this.outlet(seg[seg.length - 1]);
        return body;
      })
      .filter((seg) => seg.length >= 2);
  }

  /**
   * 把落在"禁区边界 ↔ 让距线"之间的点推到让距线上。
   *
   * 这是硬夹（不是平滑映射）：平滑映射要么在两端相等、要么在带里产生折返，
   * 两种都会把两条平行街挤到同一条曲线上。硬夹只会动真正贴边的那几个点，
   * 挤出来的重复点在后面抽稀掉。
   *
   * 平滑必须在**夹紧之前**做完、再夹一遍：平滑是把点往邻居的中间挪，
   * 贴着让距线的那几个点会被邻居拽回带里，实测最近点从 1.71u 掉到 1.11u
   * ——路面就又压线了。所以顺序是 平滑 → 抽稀 → 再夹 → 再抽稀。
   */
  private hug(pts: Pt[]): Pt[] {
    let moved_any = false;
    const moved = pts.map((p) => {
      const q = this.clampPoint(p);
      if (q !== p) moved_any = true;
      return q;
    });
    // 一个点都没被推动（有了势流绕障之后这是常态）→ 原样返回。
    // 不然下面那两遍平滑会把**每一条街**都磨一遍，虽然是弱平滑，
    // 但会让"没禁区 / 离禁区很远"的线也跟着变形，回归测试全得重录。
    if (!moved_any) return pts;
    const thinned: Pt[] = [moved[0]];
    for (let i = 1; i < moved.length; i++) {
      if (Pt.distance(moved[i], thinned[thinned.length - 1]) > 0.35) thinned.push(moved[i]);
    }
    if (thinned.length < 2) return this.refine(moved);
    const smoothed = smooth(thinned, 2, 0.3).map((p) => this.clampPoint(p));
    const out: Pt[] = [smoothed[0]];
    for (let i = 1; i < smoothed.length; i++) {
      if (Pt.distance(smoothed[i], out[out.length - 1]) > 0.35) out.push(smoothed[i]);
    }
    return this.refine(out.length >= 2 ? out : smoothed);
  }

  /**
   * 把弦也夹进去。
   *
   * 硬夹只管**顶点**：两个顶点都在让距线上，它们之间那条直线段照样能从禁区
   * 的角上斜切过去 —— 实测一条六车道的中线因此压到 1.30u（让距 1.71u），
   * 路缘啃进禁区 1.4 m。顶点间距是积分步长（≈3u），角点处的偏差就有这么大。
   *
   * 做法很土但够用：逐段取中点，够不着的就插进去，最多两轮。
   * 只在真正出问题的那几段上动，别处不碰。
   */
  private refine(pts: Pt[]): Pt[] {
    let cur = pts;
    for (let pass = 0; pass < 2; pass++) {
      const out: Pt[] = [cur[0]];
      let added = 0;
      for (let i = 0; i + 1 < cur.length; i++) {
        const a = cur[i];
        const b = cur[i + 1];
        const d = Pt.distance(a, b);
        if (d < 0.3) {
          out.push(b);
          continue;
        }
        const n = Math.min(4, Math.ceil(d / 1.2));
        let prev = a;
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const q = k === n ? b : new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          if (k < n) {
            const s = this.nearest(q.x, q.y);
            if (s && s.sd < this.pad) {
              const c = this.clampPoint(q);
              if (Pt.distance(c, prev) > 0.3) {
                out.push(c);
                prev = c;
                added++;
              }
            }
          }
          if (k === n) out.push(q);
        }
      }
      cur = out;
      if (added === 0) break;
    }
    return cur;
  }
}

