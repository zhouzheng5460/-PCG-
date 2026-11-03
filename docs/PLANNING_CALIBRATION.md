# Planning 强度校准（R7.6 ~ R7.8）

> 这份文档记录的不是"怎么调参"，而是**每一条带子从哪来、为什么这么定**，
> 以及中途哪些尝试被证伪。下一轮要改带子，先来这儿看理由。

---

## 0. 一句话结论

**Shadow 的强度闸门原来拿 Legacy 当基准，是错的。**

三类 typology 校准完之后，`intensityRatio`（planner 覆盖 / legacy 覆盖）全部 > 1.25，
看起来像"Planner 系统性地建得过密"。但逐类核到绝对强度带之后，情况正好反过来：

| typology | legacy 覆盖 | planner 覆盖 | legacy 在带内 | planner 在带内 |
|---|---|---|---|---|
| industrial | 17% | 20% | 4/6 | 5/6 |
| retail | 13% | 21% | 19/27 | **27/27** |
| multi_family (FAR) | 0.77 | 1.84 | **0/26** | **20/26** |

Legacy 是郊区化的低密度产物，Planner 是按"近郊 strip / 多层围合住宅"的常规容积率在盖。
把 Legacy 当基准 = 用"更稀"当标准。**R7.8 因此把强度闸门改成绝对带判定**，Legacy 降级为旁证。

---

## 1. R7.6 · Industrial

### 1.1 带子

| 项 | 值 | 理由 |
|---|---|---|
| min | 0.16 | 单层高标库的容积率下沿；低于此说明货场撑不起来 |
| preferredMin | 0.18 | |
| preferredMax | 0.24 | |
| max | 0.28 | 高于此就不该做单层 |

### 1.2 `coverageFit(actual)`（`typologies/industrial.ts`）

带内满分但偏好靠中间（贴上限只给 0.88），带外两侧都扣，折算进 `typologyFit`。

### 1.3 `circulationQuality` 的三段饱和

审计发现：四个候选的 `courtRatio` 在 24%~34% 之间，而旧口径 `min(ratio/0.18, 1)` 让它们**全是 1.00** ——
这一项完全失去区分度，"货场越大越好"变成了默认前提。改成三段式：

```
< lo 明显不足（最多 0.35）
lo~knee 快速加分（0.35 → 0.90）
knee~hi 缓慢加分（0.90 → 1.00）
> hi 不再加分，也**不处罚**（大物流项目本来就需要更大货场）
```

### 1.4 遗留问题

- **winner 仍偏 high（4/6 = 67%）**。根因不是单一评分偏置，而是"高强度同时改善其它项"
  （货场大 → circulation 高、front-back 关系好 → typologyFit 高）。
  按既定 PASS 条件（"high winner rate 不是接近 100%"）判 **PASS**，标记 `INDUSTRIAL = CUTOVER_CANDIDATE`，不再继续磨。

---

## 2. R7.7 · Retail

### 2.1 带子

单层商业 → 覆盖率 ≈ FAR。

| 项 | 值 | 理由 |
|---|---|---|
| min | 0.12 | 低于此是"停车场配一间店" |
| preferredMin | 0.16 | 近郊 strip 的容积率常态 |
| preferredMax | 0.26 | |
| max | 0.34 | 高于此的 strip 要上楼 / 做停车楼，那是 PAD / 城市商业 |

### 2.2 三个诊断项原来在退化

审计（27 块真城商业地）发现：

| 诊断项 | 旧口径 | 实测分布 | 问题 |
|---|---|---|---|
| `frontageQuality` 的可见性 | `shopLen / (lotLen*0.75)` 后 clamp | 25/27 是 1.00，2 个 0.94 | 恒为常数，零区分度 |
| `typologyFit` | `0.4*可见性 + 0.3*停车 + 0.3*动线` | 27/27 是 1.00 | 同上 |
| `parkingQuality` | `parkRatio / 0.32` 后 clamp | 12% ~ 61% 全给满分 | "停车场配一间店"被判成最优 |

改法：

- 可见性 → 三段饱和（占临街 65% 就满分，占满不额外奖励）
- 停车 → `retailParkingFit()`：26%~42% 满分区，50% 起轻微扣（60% → 0.70，65% → 0.55）
- `typologyFit` → 四条腿：临街界面 / 停车 / 顾客动线 / **开发强度**（`coverageFit`）
- `spatialCoreQuality` 的店前广场比例也换成饱和曲线（旧口径 6% 就封顶）

### 2.3 失败的尝试（负面结论，保留记录）

试过给 retail 加**进深档**（18 / 23 / 28 m × 三种停车位置 = 9 个候选）当作强度轴。**不成立**：

- 大地块上三档覆盖率全部落进 16%~26% 的目标带，`coverageFit` 都是 0.97~1.00；
- 九选一的 margin 中位数只有 **0.03**，27 块地里 23 块退化成 `LOW_SELECTION_CONFIDENCE`。

那是把分数噪声当成候选多样性。**结论：strip 零售的强度不是自由参数**，它由地块面宽 × 进深决定；
真正的设计选择只有"停车摆哪儿"（winner：rear-park 21 / front-park 6）。
要做出零售的强度轴，得走结构性差异（liner + pad outparcel），那是独立特性。

### 2.4 遗留问题

- `side-park` 变体系统性地垫底（停车占比只有 12%~23%，而零售停车是刚需）。
  这是**合理淘汰**，不是 bug，但它让"三档候选"实际只有两档在竞争。

---

## 3. R7.8 · 绝对强度带 + Multi-Family

### 3.1 闸门改造

新增 `src/town/shadow/intensity.ts`：

```ts
export const INTENSITY_TARGETS: Partial<Record<SiteTypology, IntensityTarget>> = { ... }
export function intensityValue(coverage, t)  // coverage 口径 或 coverage × 层数（≈容积率）
export function bandState(v, t)              // below | in_hard | in_preferred | above
export function complianceOf(p, l)           // both_in_band / planner_in_band_only / ...
```

- **声明过的 typology 一律用带子判强度**，Legacy 只作旁证；
- 没声明的（hotel / data_center / single_family，目前没有 Shadow 样本）继续走旧的相对比，不假装已校准；
- `verdict` 仍然是几何质量判据（blocker / major），强度只决定"能不能比"（`density_mismatch`）；
  强度合规性单列在 `comparison.intensityBand.compliance`，不直接改写胜负。

### 3.2 Multi-Family 带子

6 层 × 3 m = 18 m，容积率口径：

| 项 | FAR | 覆盖率 |
|---|---|---|
| min | 1.2 | 0.20 |
| preferredMin | 1.4 | 0.233 |
| preferredMax | 2.2 | 0.367 |
| max | 2.6 | 0.433 |

### 3.3 校准过程中挖出的三个真问题

**① 建筑高度单位错了（最严重）**

`multifamily/courtyard.ts` 里写的是 `barHeight = U(6.5); // 6 层左右` ——
`U()` 是"米 → 世界单位"，6.5 变成 **6.5 米（≈2 层）**，整片 MF 在 3D 里是两层高的棚子。

Shadow 的体量代理直接暴露了它：基地面积 2.68× legacy，**体积却只有 0.74×**。
改成 `U(18)`（6 层 × 3 m）之后，MF 平均高度 2.6 单位 vs legacy 2.7，对齐了。

**② `fragmentationPenalty` 把"有意为之的小面"当成碎片**

旧口径 `area / lotArea < 0.012 就计一次`，把前场、服务带、端头绿化全算成碎片：

| 地块 | 形态 | 建筑覆盖率 | 碎片惩罚 | 得分 |
|---|---|---|---|---|
| -312:429 | asymmetric | 13% | 0.00 | **5.59** |
| -312:429 | balanced | 22% | 1.00 | 5.50 |

Evaluator 反而选了稀疏方案。改成**只统计短边 < 3 m 的窄缝**，并同时修生成器：
沿街两端的绿化带宽度给下限 4 m（原 14% 面宽在 20 m 宽地块上只有 2.8 m 的细缝），
院子收窄时若只能留出 < 4 m 的绿缝就**不收窄**。

**③ 纸片楼**

`asymmetric` 形态把西侧 bar 只做 62% 长，在院子短的一侧会切出 6.4 m × 14 m 的"纸片"。
处理：西侧段不足 12 m 就做满；`pushBar` 统一过滤短边 < 7 m 的 bar。
真城纸片楼数量 **4 → 1**（剩下的 1 条在边界地块上，无害）。

### 3.4 `mfCoverageFit` 为什么和工业 / 零售形状不同

工业和零售的候选几乎都落在带内，曲线在带外那段基本不触发。
住宅不行：大地块上围合式方案天然给不出高覆盖率，用工业那条"带外一路扣到 0"的陡曲线会把所有方案一起压成 0，
毫无区分度。所以住宅换成四段缓坡：

```
< min            0.62 → 0
min..prefMin     0.62 → 1.0
prefMin..prefMax ≈1（偏好靠中间）
prefMax..max     1.0 → 0.12
> max            0
```

### 3.5 现状

- MF winner 覆盖度 P10 17% / P50 32% / max 38%，**带内 24/29**；
- 形态分布 rear-open 10 / principal 10 / balanced 7 / front-open 2 —— 候选多样性是真的。

> 3.5 之后的形状问题由 **TECH-04** 解决，见 §6。

---

## 4. 现在的 Shadow 结论

```
| Typology      | N  | Legacy cov | Planner cov | 强度闸门 | Verdict |
|---------------|----|------------|-------------|----------|---------|
| multi_family  | 26 | 13%        | 29%         | 带内 20/26 | Equivalent (P0/E20/D6) |
| industrial    |  6 | 17%        | 20%         | 带内 5/6   | Equivalent (P0/E5/D1)  |
| retail        | 27 | 13%        | 21%         | 带内 27/27 | Equivalent (P0/E27/D0) |

> 这张表是 **TECH-04 之前**的快照；TECH-04 之后的最新数字见 §6.5 / §7。
```

- blocker：legacy 0 / planner 0（两边都干净）；
- 归一化违规：legacy 1.14~1.58 / 千 m²，planner **0.00**；
- `LOW_SELECTION_CONFIDENCE` 21/60（MF 9 / industrial 5 / retail 7）—— 见 §5。

## 5. 已知待办

| 编号 | 内容 | 优先级 |
|---|---|---|
| TECH-02 | 候选多样性：industrial 5/6、retail 7/27 选优 margin < 0.15 | 中 |
| TECH-04 | MF 形态鲁棒性：按可建区主轴旋转的围合方案（解决 6 块人字形地块） | 高 |
| TECH-05 | hotel / data_center / single_family 没有 Shadow 样本，带子未声明 | 中 |
| R8 | 视觉复核（palette / 宅地边界 / parking lines / curb 层级） | 待办 |


---

## 6. TECH-04 · MF 主轴围合 fallback

### 6.1 触发条件（archetype 私有，不进 Core）

```ts
// src/town/planning/archetypes/multifamily/principal-court.ts
export const PRINCIPAL_TRIGGER = {
  frontageRatio: 0.22,   // 临街长度 / 地块主轴展向
  frontageLengthM: 30,   // 且临街本身短于 30 m
};
```

只在"临街面撑不起一个院子"时追加**一个**候选 `mf-court-principal`。
主轴计算（OBB 长轴）放在 `archetypes/multifamily/principal-axis.ts`，
**不进 SiteContext / SitePlanCandidate / LayoutDiagnostics**（Freeze §2 / §3 的键集合不变）。

### 6.2 语义：Massing orientation ≠ Arrival orientation

围合框架转到主轴，但**到达序列不动**：行人开口仍然开在 primary frontage 上，
仍然从街 → 前场 → 院子。建筑朝哪边围，和人从哪儿进来，是两件事。

### 6.3 关键实现细节（踩过的坑）

| 坑 | 现象 | 修法 |
|---|---|---|
| OBB 范围 ≠ 可建区范围 | "临街带"整条落在可建区外，入口前场和停车全丢 | 轴向取自 OBB，**范围取可建区自己的投影** |
| 相邻重复顶点 | polygon-clipping 抛 "not a valid Polygon"，`surfaceUnion` 静默走兜底分支 | `surface.ts` 新增 `cleanRing()`，`surface()` / `fromNest()` 统一清洗 |
| 配套 / 后勤带与院子**边界相切** | 同上，并集抛错 → Fidelity Gate 的 groundCoverage 从 1.00 掉到 0.95 | 配套 / 后勤内缩 1.5 m，边界不相切 |
| 碎缝（前场 9 m²、入口轴 5 m²） | 被"碎片"惩罚算成切碎，候选白丢 0.6 分 | 短边 < 3 m 的地面区域直接不认领 |
| 停车压在建筑上 | 地面互相重叠 | 停车从"已扣除建筑后的剩余地"里取 |

### 6.4 验收（固定 Golden fixtures）

6 块 fixture：`-312:429` / `544:-100` / `206:451` / `573:3` / `-255:-434` / `-14:-496`

| Gate | 结果 |
|---|---|
| 6/6 生成 principal 候选 | ✅ |
| 建筑 / 院子 0 越出可建区 | ✅ |
| 0 纸片楼（短边 ≥ 7 m） | ✅ |
| 人行口接在主临街面上 | ✅ |
| 6/6 由主轴方案胜出 | ✅ |
| 正常地块 winner 不变 ≥18/20 | ✅ 19/20（另有 3 块原本无方案的地块现在有了方案） |

覆盖率变化：12%→15%、16%→22%、16%→18%、19%→16%、17%→25%、45%→32%。
MF 有方案的地块 26 → **29**，带内 20/26 → **24/29**。

### 6.5 效果

| Typology | N | Legacy cov | Planner cov | 带内 | Verdict | LOW 置信 |
|---|---|---|---|---|---|---|
| multi_family | 29 | 13% | 29% | 24/29 | E24/D5 | 7 |
| industrial | 6 | 17% | 20% | 5/6 | E5/D1 | 5 |
| retail | 27 | 13% | 21% | 27/27 | E27/D0 | 8 |

---

## 7. R8 前的状态小结

| 项 | 状态 |
|---|---|
| Industrial | 5/6 带内，CUTOVER_CANDIDATE |
| Retail | 27/27 带内 |
| Multi-Family | 24/29 带内，形状问题已由 TECH-04 兜住 |
| blocker | legacy 0 / planner 0 |
| 归一化违规 | legacy 1.14~1.58 / 千 m²，planner 0.00 |
| LOW_SELECTION_CONFIDENCE | 20/64（MF 7 / industrial 5 / retail 8）→ TECH-02 |
| 未校准 | hotel / data_center / single_family（无 Shadow 样本，带子未声明） |
