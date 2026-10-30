// 街道设施：行道树、路灯、垃圾桶、公交亭。
//
// 布点规则跟"路"绑在一起，不跟地块绑：沿人行道的绿化带按规范间距走，
// 因此改路宽、拖顶点之后树和灯会跟着路走，而不是留在原地。
//
// 间距取 road/spec.ts 的规范值：行道树 8 m（1.14 单位）、路灯 28~32 m
// （4~4.6 单位），三档等级都布、两侧都布 —— 之前只布主干道、间距 2.5/5.0 单位，
// 支路上一棵树一盏灯都没有，跟"城市道路"读起来不是一回事。
//
// 位置也按横断面来：红线 → 绿化带 → 人行道 → 车行道。
// 所以树站在**绿化带中线**上，灯站在**人行道靠路缘那一侧**（灯臂朝路面）。
// 之前树站在人行道正中、灯贴着红线，正好都错了一格。

import { Pt } from '../core/geom';
import { Rng } from '../core/rng';
import type { Model } from '../town/model';
import { pointInPolygon } from '../town/zones';
import type { PropFeature } from '../scene/types';
import { DROPPED_PROPS } from '../scene/types';
import type { RoadNet } from '../road/system';
import { visibleSpan } from '../road/system';
import { specOf, u } from '../road/spec';

/** 总量兜底：这个尺度的城市铺满规范间距会到四五千棵，超了就按比例抽稀 */
const MAX_TREES = 5200;
const MAX_LAMPS = 1500;

const BIN_EVERY = 6;

/**
 * 路灯间距（米）——由**安装高度**推出来，不是一个拍脑袋的固定数。
 *
 * 规则抄自 site-studio 的 `lighting.standard_spacing`：街道照明的经验间距约为
 * 灯高的 3.2 倍，取 5 m 模数，落在 20~40 m 之间。好处是"改灯高 → 整条街重排"，
 * 而不是把旧的 28 m 节奏留在原地。三档灯高按道路等级给（主干路 10 m、
 * 次干路 8 m、支路 6 m），于是间距分别是 30 / 25 / 20 m。
 */
const LAMP_HEIGHT_M: Record<string, number> = { arterial: 10, collector: 8, local: 6 };

function lampPitch(cls: string): number {
  const h = LAMP_HEIGHT_M[cls] ?? 8;
  return Math.max(20, Math.min(40, Math.round((h * 3.2) / 5) * 5));
}

/**
 * 灯型：**只保留单头灯**。
 *
 * 用户核对意见（图 2）："不要这种双头灯了，只保留一个灯头的样式"。
 * 原来双头灯是"横杆两头各一个灯头"（改过一次是同臂串两个），但一杆两灯
 * 在俯视图里读起来就是"路灯顶上一横一竖两个白块"，反而不如单头干净，
 * 而且两个灯头总有一个不在车道上方。统一成单头：杆 + 一条朝道路中线的臂 + 一个灯头。
 */

export interface FurnitureResult {
  props: PropFeature[];
  trees: number;
  lamps: number;
}

export function streetFurniture(model: Model, net: RoadNet): FurnitureResult {
  const props: PropFeature[] = [];
  let trees = 0;
  let lamps = 0;

  const blocked = (p: Pt) => model.zonePolys.some((z) => pointInPolygon(p, z));

  // ---- 车行道占位网格 ----------------------------------------------------
  // 家具按"沿人行道走"布点，但路口附近的条带被邻路车行道切掉了
  // （road/system.ts 的端头切裁），这些点上原本的人行道已经不存在，
  // 灯和树就会孤零零立在沥青中间。这里把每条路的**整段**车行道
  // （a→b，不按收口截断，所以也覆盖路口）建成一个粗网格，
  // 布点前查一下，落在路面上就跳过。
  const CELL = 2;
  const grid = new Map<string, Pt[][]>();
  const ck = (ix: number, iy: number) => `${ix}:${iy}`;
  const halfW = (e: (typeof net.edges)[number]) => Math.max(e.carL, e.carR) + 0.05;
  for (const e of net.edges) {
    if (e.len < 1e-6) continue;
    const nx = -e.dir.y;
    const ny = e.dir.x;
    const w = halfW(e);
    const quad = [
      new Pt(e.a.x + nx * w, e.a.y + ny * w),
      new Pt(e.b.x + nx * w, e.b.y + ny * w),
      new Pt(e.b.x - nx * w, e.b.y - ny * w),
      new Pt(e.a.x - nx * w, e.a.y - ny * w),
    ];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of quad) {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iy = Math.floor(y0 / CELL); iy <= Math.floor(y1 / CELL); iy++) {
        const k = ck(ix, iy);
        const arr = grid.get(k);
        if (arr) arr.push(quad);
        else grid.set(k, [quad]);
      }
    }
  }

  const onCarriageway = (p: Pt): boolean => {
    const arr = grid.get(ck(Math.floor(p.x / CELL), Math.floor(p.y / CELL)));
    if (!arr) return false;
    for (const q of arr) if (pointInPolygon(p, q)) return true;
    return false;
  };

  const add = (kind: PropFeature['kind'], at: Pt, rot: number, scale: number, group: string) => {
    if (DROPPED_PROPS.has(kind)) return;
    props.push({
      name: `${kind}_${props.length}`,
      group: `street/${group}`,
      kind,
      at,
      rot,
      scale,
      seed: Rng.int(0, 9999),
    });
  };

  // 先算总需求，再决定抽稀比例 —— 硬截断会让城市一半有树一半没有
  const spans: { e: (typeof net.edges)[number]; s0: number; s1: number; tree: number; lamp: number }[] = [];
  let needTrees = 0;
  let needLamps = 0;
  for (const e of net.edges) {
    if (e.standalone || e.len < 1.2) continue;
    const spec = specOf(e.cls);
    if (!spec.streetFurniture) continue;
    const [t0, t1] = visibleSpan(e);
    const s0 = t0 * e.len + 0.4;
    const s1 = t1 * e.len - 0.4;
    if (s1 - s0 < 0.5) continue;
    const walkable = e.swL > 0.1 || e.swR > 0.1;
    if (!walkable) continue;
    const tree = u(spec.treeSpacing);
    const lamp = u(lampPitch(e.cls));
    spans.push({ e, s0, s1, tree, lamp });
    needTrees += Math.floor((s1 - s0) / tree + 1) * (e.swL > 0.1 && e.swR > 0.1 ? 2 : 1);
    needLamps += Math.floor((s1 - s0) / lamp + 1);
  }
  const treeStep = needTrees > MAX_TREES ? Math.ceil(needTrees / MAX_TREES) : 1;
  const lampStep = needLamps > MAX_LAMPS ? Math.ceil(needLamps / MAX_LAMPS) : 1;

  for (const { e, s0, s1, tree: treeGap, lamp: lampGap } of spans) {
    const nx = -e.dir.y;
    const ny = e.dir.x;
    const at = (s: number, d: number) => new Pt(e.a.x + e.dir.x * s + nx * d, e.a.y + e.dir.y * s + ny * d);

    // 绿化带中线（树）/ 人行道靠路缘（灯）。没有绿化带的支路把树挪到人行道外侧。
    const treeL = e.vgL > 0.05 ? e.insetL - e.vgL * 0.5 : e.insetL - e.swL * 0.5;
    const treeR = e.vgR > 0.05 ? -(e.insetR - e.vgR * 0.5) : -(e.insetR - e.swR * 0.5);
    const kerbL = e.insetL - e.vgL - e.swL + Math.min(0.12, e.swL * 0.25);
    const kerbR = -(e.insetR - e.vgR - e.swR + Math.min(0.12, e.swR * 0.25));

    // 树：绿化带里各一排，两侧错开半个间距
    if (e.swL > 0.1) {
      let k = 0;
      for (let s = s0; s <= s1; s += treeGap, k++) {
        if (k % treeStep !== 0) continue;
        const p = at(s, treeL);
        if (blocked(p) || onCarriageway(p)) continue;
        add(k % 7 === 3 ? 'treeSmall' : 'tree', p, Rng.float() * Math.PI * 2, 0.9 + Rng.float() * 0.35, 'avenue');
        trees++;
      }
    }
    if (e.swR > 0.1) {
      let k = 0;
      for (let s = s0 + treeGap * 0.5; s <= s1; s += treeGap, k++) {
        if (k % treeStep !== 0) continue;
        const p = at(s, treeR);
        if (blocked(p) || onCarriageway(p)) continue;
        add(Rng.bool(0.14) ? 'conifer' : 'tree', p, Rng.float() * Math.PI * 2, 0.9 + Rng.float() * 0.35, 'avenue');
        trees++;
      }
    }

    // 路灯：立在**人行道靠路缘**那一侧，灯臂朝道路中线；道路两侧对称布置。
    //
    // 三条口径（按用户核对意见改）：
    //   · 灯位从**路缘**起算（不是路中心、也不是红线），路缘后退 0.6 m ——
    //     改路宽时灯跟着路缘走，不会站进车行道里；
    //   · **两侧对称**：同一个里程左右各一盏。早先两侧交错（lk % 2 分左右），
    //     从空中看就是"这条街灯都在左边"，用户明确要求对称；
    //   · 灯型统一为单头，灯臂朝道路中线。
    let lk = 0;
    for (let s = s0; s <= s1; s += lampGap, lk++) {
      if (lk % lampStep !== 0) continue;
      const sides: boolean[] = e.swL > 0.1 && e.swR > 0.1 ? [true, false] : e.swL > 0.1 ? [true] : e.swR > 0.1 ? [false] : [];
      for (const left of sides) {
        // 灯位：人行道靠路缘；该侧人行道太窄就退到绿化带靠**路**的一侧，
        // 总之不能站进人行道中间、也不能站到绿化带深处（图里那种"灯立在树丛里"的读法）。
        const walkW = left ? e.swL : e.swR;
        const vg = left ? e.vgL : e.vgR;
        const inset = left ? e.insetL : e.insetR;
        const kerb = inset - vg - walkW;
        const d = kerb + (walkW >= u(2.0) ? u(0.6) : Math.min(vg * 0.5, u(0.6)));
        const dd = left ? d : -d;
        const p = at(s, dd);
        if (blocked(p) || onCarriageway(p)) continue;
        // 灯臂朝道路中线：左臂指向 -n，右臂指向 +n
        add('lamp', p, left ? Math.atan2(-ny, -nx) : Math.atan2(ny, nx), 1, 'lighting');
        lamps++;
      }
    }

    // 垃圾桶：人行道上，隔一段一个
    if (lk > 0 && e.swL > 0.12) {
      let k = 0;
      for (let s = s0 + lampGap * 0.4; s <= s1; s += lampGap * BIN_EVERY * 0.5, k++) {
        const p = at(s, kerbL);
        if (blocked(p) || onCarriageway(p)) continue;
        add('bin', p, 0, 1, 'furniture');
      }
    }

    // 公交亭：干路上稀疏布置
    if (e.len > 5 && (e.arterial || e.cls === 'collector') && Rng.bool(0.3) && e.swR > 0.16) {
      const s = s0 + (s1 - s0) * (0.25 + Rng.float() * 0.5);
      const p = at(s, kerbR - 0.12);
      if (!blocked(p) && !onCarriageway(p)) add('shelter', p, Math.atan2(ny, nx), 1, 'furniture');
    }
  }

  return { props, trees, lamps };
}
