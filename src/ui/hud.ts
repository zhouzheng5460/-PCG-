// HUD 分析：把一座城"体检"一遍，给数字 + 结论，而不是让用户自己数。
//
// 为什么要这个
// ------------
// 生成器有二十几个参数，调完之后只看图很难判断"这版规则到底完善了没有"：
// 绿地率是多少？路网密度够不够？有多少断头路？主干道真的占 6/10 吗？
// 这些都不是眼睛能数的，所以做成常驻面板。
//
// 所有指标都是**可以从模型里精确算出来的**，没有一条是拍脑袋的估算：
//   · 长度 / 面积直接累加几何
//   · 断头 / 路口按 RoadNet 的顶点度数统计
//   · 用地构成按 patch 的 use 统计（与图上着色同一份数据）
//
// 判定区间（ok / warn）写在每项的 `range` 里，来源是《城市综合交通体系规划标准》
// 与现代城市设计的常用经验值，本项目自己的目标值（比如绿地率 26%~32%）优先。

import { Pt } from '../core/geom';
import type { Model } from '../town/model';
import { area, pointInPolygon } from '../town/zones';
import { buildRoadNet } from '../road/system';
import { buildScene } from '../scene/build';
import { Cover, measureCover } from '../scene/cover';
import { layerOfPath, layerOfProp, layerOfSolid, layerOfSurface } from '../scene/layers';
import { USE_LABEL } from '../town/landuse';
import { MAT, USE_COLOR } from '../scene/palette';
import type { LandUse } from '../scene/types';

/** 1 世界单位 ≈ 7 m（全项目统一口径，见 road/spec.ts） */
const U = 7;
const M2_PER_U2 = U * U;

export type Level = 'ok' | 'warn' | 'bad' | 'info';

export interface Metric {
  label: string;
  /** 显示值，已带单位 */
  value: string;
  level: Level;
  /** 一句话说明"这个数意味着什么" */
  note?: string;
}

export interface UseShare {
  use: LandUse;
  n: number;
  ratio: number;
  color: string;
  label: string;
}

export interface RoadShare {
  cls: 'arterial' | 'collector' | 'local';
  label: string;
  len: number;
  ratio: number;
  want: number;
}

export interface Diagnostics {
  patches: number;
  blocked: number;
  buildings: number;
  /** 建成区（withinCity）面积，m² */
  areaM2: number;
  radiusM: number;
  edges: number;
  junctions: number;
  deadEnds: number;
  /** 道路总里程，m */
  roadLenM: number;
  /** 车行道面积，m² */
  roadAreaM2: number;
  /** 路网密度 km/km² */
  networkDensity: number;
  /** 交叉口密度 个/km² */
  junctionDensity: number;
  /** 断头率 */
  deadEndRate: number;
  /** 绿地率（草地 + 路侧绿带 + 树冠投影不含，只算草地） */
  greenRatio: number;
  /** 硬质铺装率 */
  hardRatio: number;
  /** 道路面积率（含人行道） */
  roadRatio: number;
  /** 建筑密度：建筑基底 ÷ 建成区 */
  buildCoverage: number;
  /** 街区面积中位数 m² */
  blockMedianM2: number;
  blockMinM2: number;
  blockMaxM2: number;
  /** 每街区建筑数中位数 */
  buildingsPerBlock: number;
  /** 每公顷树木数 */
  treePerHa: number;
  /** 各用途地块数与占比 */
  uses: UseShare[];
  /** 道路分级里程 */
  roads: RoadShare[];
  /** 各类要素数量 */
  counts: { solids: number; props: number; surfaces: number; paths: number };
  /** 树（三种）数量 */
  trees: number;
  lamps: number;
  /** 每个图层有多少个要素（左栏列表上的小数字） */
  layerCounts: Record<string, number>;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = xs.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function level(v: number, lo: number, hi: number, warnLo: number, warnHi: number): Level {
  if (v < warnLo || v > warnHi) return 'bad';
  if (v < lo || v > hi) return 'warn';
  return 'ok';
}

/** 把一座城算一遍。调用点是"重生成 / 重建 / 显隐变化"，不进逐帧循环 */
export function diagnose(model: Model): Diagnostics {
  const scene = buildScene(model);
  const net = buildRoadNet(model);

  // ---- 街区面积（只关心"能建房子"的地块，禁建区不计入中位数）
  const blockAreas: number[] = [];
  for (const p of model.patches) {
    if (!p.withinCity) continue;
    if (!p.blocked) blockAreas.push(area(Array.from(p.shape)));
  }

  // ---- 道路
  let roadLen = 0;
  let roadArea = 0;
  const lenByCls: Record<string, number> = { arterial: 0, collector: 0, local: 0 };
  const deg = new Map<Pt, number>();
  for (const e of net.edges) {
    roadLen += e.len;
    roadArea += e.carriage * e.len;
    lenByCls[e.cls] = (lenByCls[e.cls] ?? 0) + e.len;
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  let deadEnds = 0;
  let junctions = 0;
  for (const [, d] of deg) {
    if (d === 1) deadEnds++;
    else if (d >= 3) junctions++;
  }

  // ---- 地面覆盖率
  //
  // 这里是**栅格法**（scene/cover.ts），不是多边形求和。
  // 场景是分层叠出来的（街区底 → 铺装 → 建筑基底），同一位置有多层覆盖，
  // 直接求和会算出 190% 的绿地率；求并集又要 6 秒。
  // 栅格法按绘制顺序刷一遍，一格一个归属，48ms 出结果。
  const cover = measureCover(scene);
  const urbanCells = Math.max(1, cover.urban);
  const cellOf = (c: Cover) => cover.cells[c] ?? 0;
  const urbanM2 = Math.max(1, urbanCells * cover.cellM2);
  const greenRatio = cellOf(Cover.Green) / urbanCells;
  const hardRatio = (cellOf(Cover.Hard) + cellOf(Cover.Soil)) / urbanCells;
  const roadRatio = (cellOf(Cover.Road) + cellOf(Cover.Walk)) / urbanCells;
  const buildCoverage = cellOf(Cover.Building) / urbanCells;

  // ---- 建筑 / 道具
  const perBlock: number[] = [];
  for (const p of model.patches) {
    if (!p.withinCity || p.blocked) continue;
    const n = p.ward?.geometry.length ?? 0;
    if (n > 0) perBlock.push(n);
  }
  let trees = 0;
  let lamps = 0;
  for (const p of scene.props) {
    const id = layerOfProp(p);
    if (id === 'prop:tree' || id === 'prop:treeSmall' || id === 'prop:conifer') trees++;
    else if (id === 'prop:lamp' || id === 'prop:lampDouble') lamps++;
  }

  // ---- 用地构成
  const byUse = new Map<string, number>();
  for (const p of model.patches) {
    if (!p.withinCity) continue;
    // 用途挂在 ward 上（ModernWard.use），Patch 本身不带 —— 禁建地块单独记 reserved
    const use = p.blocked ? 'reserved' : ((p.ward as { use?: string } | null)?.use ?? 'green');
    byUse.set(use, (byUse.get(use) ?? 0) + 1);
  }
  const totalUse = [...byUse.values()].reduce((a, b) => a + b, 0) || 1;
  const order: LandUse[] = [
    'cbd',
    'commercial',
    'residential',
    'civic',
    'industrial',
    'park',
    'parking',
    'green',
    'reserved',
  ];
  const uses: UseShare[] = order
    .filter((u) => byUse.has(u))
    .map((u) => {
      const c = USE_COLOR[u] ?? [0.5, 0.5, 0.5];
      return {
        use: u,
        n: byUse.get(u) ?? 0,
        ratio: (byUse.get(u) ?? 0) / totalUse,
        color: `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`,
        label: (USE_LABEL as Record<string, string>)[u] ?? u,
      };
    });

  const totalRoadLen = lenByCls.arterial + lenByCls.collector + lenByCls.local || 1;
  const roads: RoadShare[] = (
    [
      ['arterial', '主干路', 0.1],
      ['collector', '次干路', 0.6],
      ['local', '支路', 0.3],
    ] as const
  ).map(([cls, label, want]) => ({
    cls,
    label,
    len: lenByCls[cls],
    ratio: lenByCls[cls] / totalRoadLen,
    want,
  }));

  const layerCounts: Record<string, number> = {};
  const bump = (id: string) => {
    layerCounts[id] = (layerCounts[id] ?? 0) + 1;
  };
  for (const s of scene.surfaces) bump(layerOfSurface(s));
  for (const s of scene.solids) bump(layerOfSolid(s));
  for (const p of scene.props) bump(layerOfProp(p));
  for (const p of scene.paths) bump(layerOfPath(p));

  return {
    patches: model.patches.length,
    blocked: model.patches.filter((p) => p.blocked).length,
    buildings: model.stats().buildings,
    areaM2: urbanM2,
    radiusM: model.cityRadius * U,
    edges: net.edges.length,
    junctions,
    deadEnds,
    roadLenM: roadLen * U,
    roadAreaM2: roadArea * M2_PER_U2,
    networkDensity: (roadLen * U) / 1000 / Math.max(1e-6, urbanM2 / 1e6),
    junctionDensity: junctions / Math.max(1e-6, urbanM2 / 1e6),
    deadEndRate: deadEnds / Math.max(1, junctions + deadEnds),
    greenRatio,
    hardRatio,
    roadRatio,
    buildCoverage,
    blockMedianM2: median(blockAreas) * M2_PER_U2,
    blockMinM2: (blockAreas.length ? Math.min(...blockAreas) : 0) * M2_PER_U2,
    blockMaxM2: (blockAreas.length ? Math.max(...blockAreas) : 0) * M2_PER_U2,
    buildingsPerBlock: median(perBlock),
    treePerHa: trees / Math.max(1e-6, urbanM2 / 1e4),
    uses,
    roads,
    counts: {
      solids: scene.solids.length,
      props: scene.props.length,
      surfaces: scene.surfaces.length,
      paths: scene.paths.length,
    },
    trees,
    lamps,
    layerCounts,
  };
}

// ---------------------------------------------------------------- 渲染

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const num = (v: number, d = 0) =>
  v >= 1000 ? Math.round(v).toLocaleString('zh-CN') : v.toFixed(d);

/** 场景总量 */
export function hudStat(d: Diagnostics): Metric[] {
  return [
    { label: '街区', value: `${d.patches}`, level: 'info', note: d.blocked ? `含 ${d.blocked} 块禁建` : undefined },
    { label: '建筑', value: num(d.buildings), level: 'info' },
    { label: '建成面积', value: `${(d.areaM2 / 1e4).toFixed(1)} 公顷`, level: 'info', note: '含道路的完整城市化范围' },
    { label: '道路里程', value: `${(d.roadLenM / 1000).toFixed(2)} km`, level: 'info' },
    { label: '路口 / 断头', value: `${d.junctions} / ${d.deadEnds}`, level: d.deadEnds > d.junctions * 0.2 ? 'warn' : 'ok' },
    { label: '树木 / 路灯', value: `${d.trees} / ${d.lamps}`, level: 'info' },
  ];
}

/**
 * 生成规则体检。
 *
 * 所有占比都由**栅格覆盖**算出（scene/cover.ts），分母是"城市化范围"（含道路），
 * 不是街区面积之和 —— 后者会把道路面积率算高一大截。
 */
export function hudHealth(d: Diagnostics): Metric[] {
  return [
    {
      label: '绿地率',
      value: pct(d.greenRatio),
      level: level(d.greenRatio, 0.2, 0.36, 0.12, 0.45),
      note: '草地 + 路侧绿带，建筑基底已扣除。目标 20%~36%',
    },
    {
      label: '建筑密度',
      value: pct(d.buildCoverage),
      level: level(d.buildCoverage, 0.12, 0.34, 0.06, 0.45),
      note: '建筑基底 ÷ 建成区。高层区 12%~30% 常见',
    },
    {
      label: '道路面积率',
      value: pct(d.roadRatio),
      level: level(d.roadRatio, 0.12, 0.32, 0.07, 0.42),
      note: '车行道 + 路口 + 人行道 ÷ 建成区。国标 8%~20%，本生成器含内部路偏高',
    },
    {
      label: '路网密度',
      value: `${d.networkDensity.toFixed(1)} km/km²`,
      level: level(d.networkDensity, 8, 22, 5, 30),
      note: '道路里程 ÷ 建成区面积。目标 8~22',
    },
    {
      label: '交叉口密度',
      value: `${d.junctionDensity.toFixed(0)} 个/km²`,
      level: level(d.junctionDensity, 60, 220, 35, 320),
      note: '路口数 ÷ 面积。太稀 = 街区过大、绕行多',
    },
    {
      label: '断头率',
      value: pct(d.deadEndRate),
      level: level(d.deadEndRate, 0, 0.12, 0, 0.22),
      note: '度=1 的顶点 ÷ 全部节点。越低越好',
    },
    {
      label: '街区面积中位数',
      value: `${num(d.blockMedianM2)} m²`,
      level: level(d.blockMedianM2, 2500, 14000, 1200, 22000),
      note: `区间 ${num(d.blockMinM2)}~${num(d.blockMaxM2)} m²。2~14 千为健康`,
    },
    {
      label: '每街区建筑数',
      value: `${d.buildingsPerBlock.toFixed(1)} 栋`,
      level: level(d.buildingsPerBlock, 2, 9, 1, 14),
      note: '中位数。开了「切成小地块」应落在 3~6',
    },
    {
      label: '树木密度',
      value: `${d.treePerHa.toFixed(0)} 棵/公顷`,
      level: level(d.treePerHa, 20, 160, 8, 260),
      note: '行道树 + 地块内绿化',
    },
  ];
}

/** 道路分级里程：6 : 3 : 1 的实测 */
export function hudRoad(d: Diagnostics): Metric[] {
  const want: Record<string, string> = { arterial: '10%', collector: '60%', local: '30%' };
  return d.roads.map((r) => ({
    label: r.label,
    value: `${pct(r.ratio)} · ${(r.len * U / 1000).toFixed(2)} km`,
    level: 'info',
    note: `目标 ${want[r.cls]}`,
  }));
}

/** 用地构成：一条百分比条 + 清单 */
export function hudUseBar(d: Diagnostics): string {
  const segs = d.uses
    .map((u) => `<i style="width:${(u.ratio * 100).toFixed(2)}%;background:${u.color}" title="${u.label} ${pct(u.ratio)}"></i>`)
    .join('');
  const rows = d.uses
    .map(
      (u) =>
        `<div class="hud-row"><span class="sw" style="background:${u.color}"></span><span class="lb">${u.label}</span><span class="vl">${u.n}</span><span class="pc">${pct(u.ratio)}</span></div>`
    )
    .join('');
  return `<div class="hud-bar">${segs}</div><div class="hud-list">${rows}</div>`;
}

/**
 * 一句话结论。
 *
 * 体检有 8 项，摊开看观感是"一堆颜色点"，回答不了"这版规则到底完善了没有"。
 * 所以先在面板顶上给一行：几项正常 / 几项偏差 / 哪几项越界。
 * 越界的直接点名（label），用户就知道下一个该调哪个参数。
 */
export interface HealthSummary {
  ok: number;
  warn: number;
  bad: number;
  total: number;
  /** 0~100，ok 记 1 分、warn 记 0.5 分、bad 记 0 分 */
  score: number;
  /** 越界项的名字，最多 3 个 */
  badNames: string[];
}

export function healthSummary(d: Diagnostics): HealthSummary {
  const ms = hudHealth(d);
  let ok = 0;
  let warn = 0;
  let bad = 0;
  const badNames: string[] = [];
  for (const m of ms) {
    if (m.level === 'ok') ok++;
    else if (m.level === 'warn') warn++;
    else if (m.level === 'bad') {
      bad++;
      if (badNames.length < 3) badNames.push(m.label);
    }
  }
  const total = ok + warn + bad || 1;
  return { ok, warn, bad, total, score: Math.round(((ok + warn * 0.5) / total) * 100), badNames };
}

/** 顶部那条汇总（色带 + 分数 + 点名） */
export function hudVerdict(d: Diagnostics): string {
  const s = healthSummary(d);
  const tone = s.bad > 0 ? 'bad' : s.warn > 0 ? 'warn' : 'ok';
  const word = s.bad > 0 ? '有越界项' : s.warn > 0 ? '基本可用' : '各项达标';
  const list = s.badNames.length ? `<div class="vd-list">越界：${s.badNames.join(' · ')}</div>` : '';
  return `<div class="hud-verdict ${tone}">
      <div class="vd-top"><b>${s.score}</b><span class="vd-w">/100</span><span class="vd-word">${word}</span></div>
      <div class="vd-bar"><i class="ok" style="width:${(s.ok / s.total) * 100}%"></i><i class="warn" style="width:${(s.warn / s.total) * 100}%"></i><i class="bad" style="width:${(s.bad / s.total) * 100}%"></i></div>
      <div class="vd-num">正常 ${s.ok} · 偏差 ${s.warn} · 越界 ${s.bad}</div>
      ${list}
    </div>`;
}

/** 带状态点的指标行 */
export function hudRows(metrics: Metric[]): string {
  return metrics
    .map((m) => {
      const note = m.note ? `<span class="note">${m.note}</span>` : '';
      return `<div class="hud-metric ${m.level}"><span class="dot"></span><span class="lb">${m.label}</span><span class="vl">${m.value}</span>${note}</div>`;
    })
    .join('');
}

/** 小工具：把 CSS 颜色取出（供别处使用） */
export function matCss(k: keyof typeof MAT): string {
  const c = MAT[k];
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}
