// 人行道护栏。
//
// 规则来源是 site-studio 的 `core/solvers/barrier.py`：护栏不是"沿整条路画一道栏杆"，
// 而是**按节奏分段的 runs** —— 一段栏杆、一段开口，长度是算出来的而不是画出来的。
// 那份实现里写得很清楚：
//   · 周期由 pitch（1.8 m）和 module（1.5 m）决定，覆盖率达到 30/30/40 才算对；
//   · 段与段之间必须留开口，否则"最关键的出入口"也被封死了；
//   · 线本身是**推导**出来的（人行道后缘外偏），不是手写坐标 —— 改路宽，栏杆跟着走。
//
// 搬到城市街道上，只保留"分段 + 开口 + 从路缘推导"这三条，参数改成街道尺度：
//   · 只给车行道够宽的路（主干路 / 宽次干路）。窄支路本来就没护栏，设了反而挡人；
//   · 一段 9 m、开口 3.5 m —— 约等于"两个店面 + 一个出入口"，是最小可读的节奏；
//   · 路口两侧各留 2.5 m 净距，否则栏杆会横在转角半径上；
//   · 立在**地块边缘**（人行道外沿 / 绿化带靠地块的一侧）——
//     原来立在路缘内侧 0.45 m，等于把人行道切成一条一米宽的窄道，
//     用户核对后改成"围栏应该在地块边缘，不应该在人行道上"。
//
// 构件形态见 `rails.ts`：两根悬空横杆 + 一排立柱。原来是一堵 1.1 m 高的实心矮墙，
// 俯视没问题，进三维就露馅（参考图里的栏杆是通透的）。

import { Pt } from '../core/geom';
import type { PathFeature, PropFeature } from '../scene/types';
import type { RoadEdge, RoadNet } from '../road/system';
import { visibleSpan } from '../road/system';
import { u } from '../road/spec';
import { RAIL_WALK, addHedgeRun, addRail } from './rails';

/**
 * 混排节奏（本轮按用户意见改）：
 *
 * 用户核对意见（图 1）："绿篱应该和围栏在同一个路径上被克隆，按间距混合间隔
 * 摆放，这里路径是指地块的绿地与人行道之间的地面围线"。
 *
 * 旧做法是"9 m 栏杆 + 3.5 m 空口"循环，而绿篱在别处 —— 它是地块里种植池
 * 沿边内缩的那一圈，跟这条围线根本不是同一条线。于是从空中看：围栏一条线、
 * 绿篱另一条线，两条线一错开，就读成"绿篱没跟上围栏"。
 *
 * 现在改成**一条线、两种构件交替**：
 *   · 路径仍然是推导出来的那条（人行道外沿 / 绿化带靠地块的一侧），零横向偏移；
 *   · 沿这条线按 `MODULE_M` 切模块，模块内交替「一段栏杆 / 一段绿篱」，
 *     每 5 个模块留 1 个空口（4 段栏杆 : 4 段绿篱 : 2 个空口的比例感还在，
 *     但不再是"一长溜栏杆 + 一长溜绿篱"，而是逐段混合）；
 *   · 空口是必须的：不开口等于把沿街店面全封死。
 */
const MODULE_M = 6;
/** 每 N 个模块留一个空口（≈20%） */
const OPEN_EVERY = 5;
/** 路口净距（米）。site-studio 的 JUNCTION_CLEAR 是 1.5 m，那是人行尺度；
    车行路口要留出缘石转角，这里取 2.5 m */
const JUNCTION_CLEAR_M = 2.5;
/**
 * 护栏离**地块边缘**的距离（米）。
 *
 * 原来立在"路缘石内侧 0.45 m"—— 也就是**人行道上**，把整条人行道切成一米宽的
 * 窄条（用户指出的问题：围栏应该在地块边缘，不应该在人行道上）。
 * 现在改成立在**人行道外沿**：有绿化带就立在绿化带靠地块的一侧，
 * 没有绿化带就立在人行道靠地块的一侧 —— 也就是地块的边界线。
 */
const EDGE_SETBACK_M = 0.3;
/** 总量兜底：按等级优先排，排满就停 —— 截断会让远处的路一段栏杆都没有 */
const MAX_RUNS = 900;

/** 这个断面的车行道够宽，值得设人行护栏 */
function needsRail(e: RoadEdge): boolean {
  if (e.standalone || e.len < 1.2) return false;
  const carW = e.carL + e.carR;
  // 主干路一律设；次干路只有被加宽到 15 m 以上（比标准四车道还宽）才设 ——
  // 标准的 14 m 次干路在参考城市里是靠行道树分界的，不设栏杆。
  if (e.cls === 'arterial') return true;
  if (e.cls === 'collector') return carW >= u(15);
  return false;
}

/** 这个断面这条边有没有人行道可以立杆 */
function walkOn(e: RoadEdge, left: boolean): boolean {
  return (left ? e.swL : e.swR) > u(1.0);
}

export interface RailingsResult {
  paths: PathFeature[];
  props: PropFeature[];
}

/**
 * 沿路生成护栏段。
 *
 * 每段拆成「两根横杆 + 立柱」：横杆是竖起来的 path、立柱是 post 道具，
 * 两者一起并进 scene（详见 rails.ts 的说明）。
 */
export function roadsideRailings(net: RoadNet): RailingsResult {
  const paths: PathFeature[] = [];
  const props: PropFeature[] = [];

  // 按等级优先排：主干路先排满，剩余额度给加宽的次干路。
  const plan: { e: RoadEdge; left: boolean; s0: number; s1: number; d: number }[] = [];
  const edges = net.edges
    .filter((e) => needsRail(e))
    .sort((a, b) => (a.cls === 'arterial' ? 0 : 1) - (b.cls === 'arterial' ? 0 : 1));
  for (const e of edges) {
    const [t0, t1] = visibleSpan(e);
    const clear = u(JUNCTION_CLEAR_M);
    const s0 = t0 * e.len + clear;
    const s1 = t1 * e.len - clear;
    if (s1 - s0 < u(MODULE_M) * 0.55) continue;
    // 护栏立地块边缘（人行道外沿 / 绿化带靠地块的一侧），不在人行道上
    const back = u(EDGE_SETBACK_M);
    const edgeL = e.vgL > 0.05 ? e.insetL - e.vgL : e.insetL - e.swL;
    const edgeR = e.vgR > 0.05 ? e.insetR - e.vgR : e.insetR - e.swR;
    const dL = edgeL - back;
    const dR = -(edgeR - back);
    if (walkOn(e, true)) plan.push({ e, left: true, s0, s1, d: dL });
    if (walkOn(e, false)) plan.push({ e, left: false, s0, s1, d: dR });
  }

  const runLen = u(MODULE_M);
  let n = 0;
  let moduleIdx = 0;

  for (const { e, s0, s1, d } of plan) {
    if (n >= MAX_RUNS) break;
    const nx = -e.dir.y;
    const ny = e.dir.x;
    const at = (s: number) => new Pt(e.a.x + e.dir.x * s + nx * d, e.a.y + e.dir.y * s + ny * d);
    for (let s = s0; s + u(MODULE_M * 0.55) <= s1; s += runLen) {
      // 最后一段可能放不满，就按剩下的长度收短 —— 留一个缺口比伸进路口强
      const len = Math.min(runLen, s1 - s);
      const m = moduleIdx % OPEN_EVERY;
      // 4 段栏杆 / 4 段绿篱 / 2 段空口 的节奏，落在 **同一条围线** 上
      if (m === OPEN_EVERY - 1) {
        // 空口：沿街店面的出入口，不摆
      } else if (m % 2 === 0) {
        addRail({
          pts: [at(s), at(s + len)],
          namePrefix: `rail_${e.cls}_${n}`,
          group: 'street/guardrail',
          y: 0.05,
          spec: RAIL_WALK,
          paths,
          props,
        });
        n++;
      } else {
        // 绿篱：和栏杆同一个游标、同一条偏移线 —— 这只是"同一道边界换了种构件"，
        // 不是另起一条绿带。块高 0.45 m，栏杆 1.1 m，两者前后读得出层次。
        addHedgeRun({
          pts: [at(s), at(s + len)],
          namePrefix: `railhedge_${n}`,
          group: 'street/guardrail',
          props,
        });
      }
      moduleIdx++;
      if (n >= MAX_RUNS) break;
    }
  }
  return { paths, props };
}
