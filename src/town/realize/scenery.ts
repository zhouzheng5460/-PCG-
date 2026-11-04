// Planning Realization · R8 配景（地块内的树）
//
// ## 为什么放在 Realizer 而不是场景层
//
// legacy 链里树来自两处：`town/furniture.ts`（沿街行道树）和 `town/modern.ts`
// （地块内部配景）。Planner 接管的地块走的是另一条链，`modern.ts` 那部分不会跑，
// 于是这些地块**一棵树都没有** —— 院子是空的、货场是光的，
// 俯视图上一眼就看出"这不是同一个世界的产物"。
//
// 所以这里补上"地块内部配景"这一步。它仍然是**纯转译**：
// 读 Candidate 已经定好的 Ground Program，按程序撒对应的配景。
// 不决定"哪儿该有树"——那是 Planner 的事（它已经用 landscape / courtyard
// 这些程序把位置标出来了），这里只把这些程序翻译成看得见的树。
//
// ## 三条红线仍然成立
//
//   ① 不移动 / 不旋转 / 不缩放任何 footprint —— 树只落在空白地面上；
//   ② 不扩大停车区域 —— 车位上不长树；
//   ③ 不重新决定"哪里放什么" —— 只在 Planner 指定的 program 里加树。
//
// ## 确定性
//
// 撒点用「固定网格 + 抖动」，抖动量由 candidate.id 的哈希决定。
// 同一个方案重建一次，树的分布一模一样（换种子才有变化）。

import { Pt } from '../../core/geom';
import type { PropFeature, PropKind } from '../../scene/types';
import type { SitePlanCandidate } from '../planning/core/candidate';
import { pointInRing, surfaceArea } from '../planning/core/surface';

const U = (m: number) => m / 7;

/** 哪些地面程序可以种树 */
const PLANTABLE: Record<string, { perM2: number; kinds: PropKind[] }> = {
  // 院子：树不多，但要有 —— 围合式住宅的院子没有树就是一片空地
  courtyard: { perM2: 1 / 260, kinds: ['tree', 'tree', 'treeSmall', 'conifer'] },
  // 绿地：正常密度
  landscape: { perM2: 1 / 150, kinds: ['tree', 'tree', 'treeSmall', 'treeSmall', 'conifer'] },
  landscape_buffer: { perM2: 1 / 110, kinds: ['tree', 'treeSmall', 'conifer', 'conifer'] },
  // 会客场地：稀一点，别挡活动面
  amenity: { perM2: 1 / 320, kinds: ['treeSmall', 'tree', 'conifer'] },
  community_green: { perM2: 1 / 170, kinds: ['tree', 'tree', 'treeSmall'] },
  front_yard: { perM2: 1 / 200, kinds: ['treeSmall', 'tree'] },
  rear_yard: { perM2: 1 / 190, kinds: ['tree', 'treeSmall'] },
  // 工业的绿化带：成排的树，是工业地块的标志
  office_forecourt: { perM2: 1 / 260, kinds: ['treeSmall', 'tree'] },
  security_buffer: { perM2: 1 / 150, kinds: ['conifer', 'conifer', 'tree'] },
};

/** 字符串 → 稳定的 32 位种子 */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** 确定性伪随机（同一个 seed 永远同一串数） */
function rng(seed: number): () => number {
  let s = (seed * 4294967296) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * R8 · 地块内配景 → Props
 *
 * 树只落在「Planner 标出来的绿地类 program」上，并且避开建筑与车位。
 */
export function realizeScenery(
  c: SitePlanCandidate,
  part: { props: PropFeature[] },
  group: string,
  enabled = true
): number {
  if (!enabled) return 0;
  let count = 0;

  // 障碍：建筑 footprint + 停车区（车位上不长树）
  const blockers = [
    ...c.buildings.map((b) => b.footprint.outer),
    ...c.ground.filter((g) => g.program === 'parking' || g.program === 'employee_parking').map((g) => g.surface.outer),
    ...c.ground.filter((g) => g.program === 'truck_court' || g.program === 'loading_apron').map((g) => g.surface.outer),
  ];
  const blocked = (p: Pt) => blockers.some((r) => pointInRing(p, r));

  for (const g of c.ground) {
    const rule = PLANTABLE[g.program];
    if (!rule) continue;
    const areaM2 = surfaceArea(g.surface) * 49;
    const n = Math.round(areaM2 * rule.perM2);
    if (n <= 0) continue;

    const ring = g.surface.outer;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    // 网格步长：按想要的棵数反推（步长越小树越密）
    const cell = Math.sqrt((areaM2 / Math.max(1, n)) / 49);
    const rand = rng(hashSeed(`${c.id}:${g.program}:${count}`));

    for (let y = minY; y <= maxY; y += cell) {
      for (let x = minX; x <= maxX; x += cell) {
        const p = new Pt(x + (rand() - 0.5) * cell * 0.8, y + (rand() - 0.5) * cell * 0.8);
        if (!pointInRing(p, ring)) continue;
        if (blocked(p)) continue;
        const kind = rule.kinds[Math.floor(rand() * rule.kinds.length) % rule.kinds.length];
        part.props.push({
          name: `${c.id}_tree_${count}`,
          group,
          kind,
          at: p,
          rot: rand() * Math.PI * 2,
          scale: 0.85 + rand() * 0.4,
          seed: rand(),
        });
        count++;
      }
    }
  }

  // 停车场的树岛**不在这里撒** —— 现在由 `realizeParking` 按车位排的真实位置种
  //（每个车位的布局只有 Solver 知道，scenery 只能瞎猜位置）。
  // 见 realize/parking.ts 的 `layout.islands`。

  return count;
}

/** 供 UI 报告用：这类配景在场景里的"树冠半径"（世界单位） */
export const SCENERY_TREE_R = U(1.6);
