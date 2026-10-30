// 流线 → 平面图 → 封闭面（Block）。
//
// 步骤：
//   1. 所有流线拆成线段，连同城市轮廓一起塞进均匀网格哈希；
//   2. 网格内两两求交，记录每条线段上的断开参数 t；
//   3. 按 t 切开，端点量化到 1e-3 的共享顶点池 —— 这一步是关键：
//      相邻两个面拿到的是同一个 Pt 对象，下游 buildRoadNet 靠对象身份配对两侧地块，
//      所以不需要再焊接，也不会出现半条路"只有一侧"的断头；
//   4. 半边结构 + 每点按角度排序，next = 反向边的顺时针邻居，
//      走出来的环就是最小面（内部面 CCW、外部面 CW，用带符号面积区分）；
//   5. 面积 / 质心过滤，留下可用的街区。
//
// 这就是 symbios-tensor 里 graph → polygons、procedural-citygraph 里 road graph → block
// 那两步的最小实现。

import { Pt } from '../../core/geom';
import { type EdgeClass, edgeKey } from '../edgeclass';
import { pointInPolygon, signedArea } from '../zones';

export interface ArrLine {
  pts: Pt[];
  cls: EdgeClass;
}

export interface FaceOut {
  ring: Pt[];
  area: number;
  centroid: Pt;
}

export interface ArrangementResult {
  faces: FaceOut[];
  edgeClass: Map<string, EdgeClass>;
  segments: number;
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cls: EdgeClass;
  splits: number[];
}

// 两个可开关的降级开关：排查路网断连时逐个关掉看影响
const SPLIT_COLLINEAR = true;
const PAIR_DANGLING = true;

export interface ArrangementOptions {
  minArea: number;
  maxArea: number;
  /** 空间哈希的格子尺寸，默认按 minArea 反推 */
  cell?: number;
  /** 打印切面诊断 */
  debug?: boolean;
  /** 端点吸附半径：把线头投到邻近线段上，避免悬挂节点断网 */
  snapTol?: number;
}

function bucketKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

/**
 * 端点吸附（snap）。
 *
 * 流线的收尾点往往停在另一条流线旁边差 1~3 个单位的地方（积分到边界 / 一致性不足就断了）。
 * 这类"差一点没接上"的端点在平面图里是度数为 1 的悬挂节点，路网会因此断开
 * （BFS 覆盖不到它）。把端点投到邻近线段上，下游就能当成 T 型连接切成共享顶点。
 */
function snapEndpoints(lines: ArrLine[], ring: Pt[], tol: number): void {
  if (tol <= 0) return;
  interface Seg2 {
    ax: number;
    ay: number;
    bx: number;
    by: number;
  }
  const segs: Seg2[] = [];
  const addLine = (pts: Pt[]) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      segs.push({ ax: pts[i].x, ay: pts[i].y, bx: pts[i + 1].x, by: pts[i + 1].y });
    }
  };
  for (const l of lines) addLine(l.pts);
  // 轮廓也是吸附目标：否则贴着边界收尾的流线会留下悬挂节点
  if (ring.length > 2) addLine(ring.concat([ring[0]]));

  const project = (p: Pt): { x: number; y: number; d: number } => {
    let best = { x: p.x, y: p.y, d: Infinity };
    for (const s of segs) {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const L = dx * dx + dy * dy;
      if (L < 1e-12) continue;
      let t = ((p.x - s.ax) * dx + (p.y - s.ay) * dy) / L;
      if (t <= 0.02 || t >= 0.98) continue; // 端点自己的线段不要
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s.ax + dx * t;
      const py = s.ay + dy * t;
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < best.d) best = { x: px, y: py, d };
    }
    return best;
  };

  for (const l of lines) {
    if (l.pts.length < 2) continue;
    for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
      const hit = project(p);
      if (hit.d < tol) {
        p.x = hit.x;
        p.y = hit.y;
      }
    }
  }
}

export function buildArrangement(
  lines: ArrLine[],
  ring: Pt[],
  opts: ArrangementOptions
): ArrangementResult {
  // 先吸附端点，再拆线段 —— 顺序不能反，否则吸附出来的交点不参与求交
  snapEndpoints(lines, ring, opts.snapTol ?? 0);

  // ---------------- 1. 线段
  const segs: Seg[] = [];
  const pushSeg = (a: Pt, b: Pt, cls: EdgeClass) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx * dx + dy * dy < 1e-8) return;
    segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, cls, splits: [] });
  };
  for (const line of lines) {
    for (let i = 0; i + 1 < line.pts.length; i++) pushSeg(line.pts[i], line.pts[i + 1], line.cls);
  }
  // 轮廓自身也要进去，否则边缘那圈面永远闭不上
  for (let i = 0; i < ring.length; i++) pushSeg(ring[i], ring[(i + 1) % ring.length], 'local');

  // ---------------- 2. 空间哈希 + 求交
  const cell = opts.cell ?? Math.max(3, Math.sqrt(opts.minArea) * 2.2);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ix0 = Math.floor(Math.min(s.ax, s.bx) / cell);
    const ix1 = Math.floor(Math.max(s.ax, s.bx) / cell);
    const iy0 = Math.floor(Math.min(s.ay, s.by) / cell);
    const iy1 = Math.floor(Math.max(s.ay, s.by) / cell);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const k = bucketKey(ix, iy);
        const list = buckets.get(k);
        if (list) list.push(i);
        else buckets.set(k, [i]);
      }
    }
  }

  const EPS = 1e-4;
  const tested = new Set<number>();
  for (const list of buckets.values()) {
    for (let m = 0; m < list.length; m++) {
      for (let n = m + 1; n < list.length; n++) {
        const i = list[m];
        const j = list[n];
        // 配对去重（同一对可能落在多个桶里）
        const pk = i < j ? i * 0x100000 + j : j * 0x100000 + i;
        if (tested.has(pk)) continue;
        tested.add(pk);

        const s = segs[i];
        const t = segs[j];
        const rx = s.bx - s.ax;
        const ry = s.by - s.ay;
        const qx = t.bx - t.ax;
        const qy = t.by - t.ay;
        const den = rx * qy - ry * qx;
        const wx = t.ax - s.ax;
        const wy = t.ay - s.ay;

        if (Math.abs(den) < 1e-12) {
          if (!SPLIT_COLLINEAR) continue;
          // 平行。可能是"两条流线贴在一起走了一段"（共线重叠）——
          // 这种情况不求交就会留下互相重叠的边，半边配对会乱，切出来的面会缺。
          // 处理办法：把彼此的端点投影到对方参数上，在重叠区的两端都切开，
          // 重叠段就变成同一条共享边。
          const l2 = rx * rx + ry * ry;
          if (l2 < 1e-18) continue;
          if (Math.abs(wx * ry - wy * rx) / Math.sqrt(l2) > 1e-3) continue;

          for (const [px, py] of [
            [t.ax, t.ay],
            [t.bx, t.by],
          ]) {
            const u = ((px - s.ax) * rx + (py - s.ay) * ry) / l2;
            if (u > EPS && u < 1 - EPS) s.splits.push(u);
          }
          const l2t = qx * qx + qy * qy;
          if (l2t < 1e-18) continue;
          for (const [px, py] of [
            [s.ax, s.ay],
            [s.bx, s.by],
          ]) {
            const v = ((px - t.ax) * qx + (py - t.ay) * qy) / l2t;
            if (v > EPS && v < 1 - EPS) t.splits.push(v);
          }
          continue;
        }
        const a = (wx * qy - wy * qx) / den;
        const b = (wx * ry - wy * rx) / den;
        if (a < -EPS || a > 1 + EPS || b < -EPS || b > 1 + EPS) continue;
        if (a > EPS && a < 1 - EPS) s.splits.push(a);
        if (b > EPS && b < 1 - EPS) t.splits.push(b);
      }
    }
  }

  // ---------------- 3. 切开 + 共享顶点池
  const verts: Pt[] = [];
  const vidOf = new Map<string, number>();
  const vert = (x: number, y: number): number => {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    const hit = vidOf.get(k);
    if (hit !== undefined) return hit;
    const id = verts.length;
    verts.push(new Pt(x, y));
    vidOf.set(k, id);
    return id;
  };

  const edgesU: number[] = [];
  const edgesV: number[] = [];
  const edgesC: EdgeClass[] = [];
  const edgeKeyOf = new Map<string, number>();

  for (const s of segs) {
    const ts = [0, ...s.splits.sort((p, q) => p - q), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      // 参数空间里太短的片段不要（两条几乎平行的线擦一下会切出针尖）
      if (t1 - t0 < 1e-4) continue;
      const u = vert(s.ax + (s.bx - s.ax) * t0, s.ay + (s.by - s.ay) * t0);
      const v = vert(s.ax + (s.bx - s.ax) * t1, s.ay + (s.by - s.ay) * t1);
      if (u === v) continue;
      const dik = u < v ? `${u}|${v}` : `${v}|${u}`;
      const dup = edgeKeyOf.get(dik);
      if (dup !== undefined) continue;
      edgeKeyOf.set(dik, edgesU.length);
      edgesU.push(u);
      edgesV.push(v);
      edgesC.push(s.cls);
    }
  }

  // ---------------- 4. 半边结构
  const E = edgesU.length;
  const out: number[][] = Array.from({ length: verts.length }, () => []);
  for (let i = 0; i < E; i++) {
    out[edgesU[i]].push(2 * i);
    out[edgesV[i]].push(2 * i + 1);
  }
  const from = (h: number) => (h % 2 === 0 ? edgesU[h >> 1] : edgesV[h >> 1]);
  const to = (h: number) => (h % 2 === 0 ? edgesV[h >> 1] : edgesU[h >> 1]);
  const distanceOf = (h: number) =>
    Math.hypot(verts[to(h)].x - verts[from(h)].x, verts[to(h)].y - verts[from(h)].y);

  for (const list of out) {
    if (list.length < 2) continue;
    list.sort((h1, h2) => {
      const a1 = Math.atan2(verts[to(h1)].y - verts[from(h1)].y, verts[to(h1)].x - verts[from(h1)].x);
      const a2 = Math.atan2(verts[to(h2)].y - verts[from(h2)].y, verts[to(h2)].x - verts[from(h2)].x);
      if (Math.abs(a1 - a2) > 1e-9) return a1 - a2;
      // 同角度（共线重叠的收尾）用长度兜底，保证顺序稳定
      return distanceOf(h1) - distanceOf(h2);
    });
  }

  // 每个顶点上"半边 → 角度序位置"的索引
  const posOf: Map<number, number>[] = out.map((list) => {
    const m = new Map<number, number>();
    for (let k = 0; k < list.length; k++) m.set(list[k], k);
    return m;
  });

  const next = new Int32Array(2 * E).fill(-1);
  for (let h = 0; h < 2 * E; h++) {
    // 走到 to(h) 之后，从 to(h) 的出边里挑：反向边（h^1）的顺时针邻居
    const v = to(h);
    const list = out[v];
    if (list.length < 2) continue;
    const pi = posOf[v].get(h ^ 1);
    if (pi === undefined) continue;
    // 顺时针方向的下一条：走出来的就是最小面
    next[h] = list[(pi - 1 + list.length) % list.length];
  }

  // 悬挂边（度数为 1 的线头）：进得去出不来。按"原路退回"配对，
  // 让它变成环上的一个零面积尖刺，后面再把尖刺剪掉。
  // 不这样处理的话，凡是经过这个线头的面都会因为走不通而被丢掉 —— 城里就是一个洞。
  for (let v = 0; v < verts.length; v++) {
    if (!PAIR_DANGLING) break;
    const list = out[v];
    if (list.length !== 1) continue;
    next[list[0]] = list[0] ^ 1;
  }

  // ---------------- 5. 走环
  const ringArea = ring.length >= 3 ? Math.abs(signedArea(ring)) : 0;
  const visited = new Uint8Array(2 * E);
  const faces: FaceOut[] = [];
  let cycles = 0;
  let closed = 0;
  let flipped = 0;
  for (let h0 = 0; h0 < 2 * E; h0++) {
    if (visited[h0] || next[h0] < 0) continue;
    const cycle: number[] = [];
    let cur = h0;
    let guard = 0;
    while (!visited[cur] && guard++ <= 2 * E) {
      visited[cur] = 1;
      cycle.push(cur);
      cur = next[cur];
      if (cur < 0) break;
    }
    // 必须回到起点才是闭合面
    if (cur !== h0 || cycle.length < 3) continue;
    closed++;

    let ringOut: Pt[] = cycle.map((h) => verts[from(h)]);
    // 剪掉悬挂边留下的尖刺：环上出现 A→B→A 时把 B 摘掉
    if (ringOut.length >= 3) {
      const clean: Pt[] = [];
      for (const p of ringOut) {
        if (clean.length >= 2 && clean[clean.length - 2] === p) clean.pop();
        else clean.push(p);
      }
      while (clean.length >= 2 && clean[0] === clean[clean.length - 1]) clean.pop();
      if (clean.length >= 3) ringOut = clean;
    }
    let sa = signedArea(ringOut);

    // 正常情况下面内部是逆时针。个别顶点上出现重复边时，环会被反向走一圈，
    // 面积就变成负的 —— 这类环如果不大、质心又在城内，就把它翻回来当街区用，
    // 否则会在城里留下一个洞口。真正的外部面面积≈整个轮廓，体积上排除掉。
    if (sa < 0) {
      if (ringArea > 0 && -sa < ringArea * 0.5) {
        ringOut = ringOut.slice().reverse();
        sa = -sa;
        flipped++;
      } else {
        continue;
      }
    }

    cycles++;
    if (opts.debug && cycles <= 6) {
      console.log(`  cycle ${cycles}: len ${cycle.length} area ${sa.toFixed(2)}`);
    }
    if (sa <= opts.minArea || sa > opts.maxArea) continue;

    let cx = 0;
    let cy = 0;
    for (const p of ringOut) {
      cx += p.x;
      cy += p.y;
    }
    const centroid = new Pt(cx / ringOut.length, cy / ringOut.length);
    if (ring.length >= 3 && !pointInPolygon(centroid, ring)) continue;

    faces.push({ ring: ringOut, area: sa, centroid });
  }

  const edgeClass = new Map<string, EdgeClass>();
  for (let i = 0; i < E; i++) {
    edgeClass.set(edgeKey(verts[edgesU[i]], verts[edgesV[i]]), edgesC[i]);
  }

  if (opts.debug)
    console.log(`  arrangement: ${E} 边 / ${closed} 闭合 / 翻转 ${flipped} / ${faces.length} 面`);

  return { faces, edgeClass, segments: E };
}
