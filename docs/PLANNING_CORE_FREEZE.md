# Site Planning Core Freeze

**状态：STABLE**（五套语法验证完毕，Core 结构零改动）
**冻结节点：Industrial Rear-Load + MF Courtyard 两条 Golden Pipeline 完成后**

> 这份文档是**契约**，不是说明书。字段以 `src/town/planning/core/types.ts` 为准，
> 并由 `test/planning-freeze.test.ts` 机器校验 —— 往 Core 加字段会让测试变红。
> 改契约必须先过 §11 的四问。

---

## 1. 冻结原因

Core 已经支撑了两套**方向相反**的规划语法，且两者都没有要求修改 `SiteContext` / `SitePlanCandidate`：

```
Industrial Rear-Load           MF Courtyard
建筑先行                        核心空间先行
  Building                       Courtyard
  → Loading                      → Building Enclosure
  → Truck Court                  → Pedestrian Access
  → Service Access               → Parking
  → Ground                       → Ground
```

一栋大盒子从中间往外长地面，和一圈楼围着一个院子，是同一个 Core 能覆盖的两个极端。
所以判定：**契约成立，冻结**。

后续 Retail / Hotel / Data Center / Single-Family 原则上只能增加
Typology Grammar、Archetype、Scoring Weight，不再因单一类型需求改 Core。

---

## 2. `PlanSurface`（冻结）

```ts
interface PlanSurface {
  outer: Pt[];
  holes: Pt[][];
}
```

所有规划几何必须走这个结构。**禁止**在 planning 层重新出现只有 `ring: Pt[]` 的面
（那会让中庭 / 环路 / 停车岛 / 中央绿地重新退化成"叠一块面"）。

---

## 3. `SiteContext`（冻结）

职责只有一句：**这是什么地块，以及它和周围环境的关系。**

必填字段（实际 16 个键，见 `context.ts` 的 `buildSiteContext` 返回值）：

```
parcelId            typology           parcel            use
roadEdges
primaryFrontage     secondaryFrontage  serviceFrontage
orientation
buildableArea
pedestrianAccessCandidates  vehicleAccessCandidates
serviceAccessCandidates     truckAccessCandidates
neighbors
notes
```

**禁止**加入任何 typology 私有字段：

```
courtyard  truckCourt  hotelDropoff  driveThru  dataHall  pool  retailPlaza
```

这些属于 Archetype 的产出（Ground Program / Building），不属于"读懂地块"。

一条经验：`SiteContext` 的每个字段都应该能只用地块几何 + 路网回答。
凡是需要"先想好怎么摆建筑"才能填的，一律不许进来。

---

## 4. `SitePlanCandidate`（冻结）

职责：**一个完整但尚未 Realize 的方案。**

```
id  typology  archetype
buildings  ground  access  parkingRequests  circulation
score?  diagnostics?  notes
```

子结构（字段固定，语义可扩展）：

| 结构 | 字段 |
|---|---|
| `PlannedBuilding` | `role` `footprint` `height` `frontSide?` `loadingSide?` `notes?` |
| `PlannedRegion` | `program` `surface` `area` `notes?` |
| `PlannedAccess` | `kind` `at` `normal` `role` `frontage` `notes?` |

`role` 的取值在 Hotel 阶段扩了 `main_lobby` —— 它不是"一个入口"，而是**到达序列的终点锚点**
（有它才能量"落客 → 大堂"的距离、判这条步行线有没有被停车或后勤切开）。
这是**值层面的语义扩展**，字段结构没动。
| `ParkingRequest` | `role` `region` `preferredEntry?` `targetDensity` `notes?` |

硬约束：

- 不创建 Scene、不创建 three 对象、不生成停车位 Mesh、不碰 DOM；
- 必须 **Pure Data / Serializable / Deterministic / Headless**（`planning-freeze` 测试会扫 import）。

---

## 5. Ground Program（可扩展）

Ground 是**功能语义**，不是材质。程序 → 材质的映射在渲染层做，不在规划层。

当前枚举（`candidate.ts` 的 `GroundProgram`）：

```
工业：office_forecourt  employee_parking  landscape_buffer
      loading_apron     truck_court       service_lane  utility_yard
住宅/零售/酒店：courtyard  amenity  entrance_forecourt
               pedestrian  parking  landscape  service
酒店专有（Freeze 后新增）：arrival_court  dropoff
数据中心专有（Freeze 后新增，共 3 个上限）：mechanical_yard  electrical_yard  security_buffer
兜底：residual
```

允许新增枚举值（例如 `phase_reserve` / `private_terrace` / `drive_thru_lane`），
但**不得**因此修改 `SiteContext`。

---

## 6. `LayoutDiagnostics`（冻结，字段可选）

必填的下限（所有 typology 都要给）：

```
accessClarity  frontageQuality  buildingRegularity  groundUsability
circulationQuality
deadSpacePenalty  fragmentationPenalty  accessConflictPenalty
```

按 typology 填的通用项（**可选**，但语义已在 Contract 里定义）：

```
typologyFit  parkingQuality  openSpaceQuality
spatialCoreQuality  pedestrianClarity  enclosureRatio
serviceSeparation  narrowResidualPenalty
```

实测数据可以说明"可选"是必要的：工业只填了 12 项（不含 `spatialCoreQuality` 等），
住宅填了 16 项。Core 不强制统一，只强制**语义一致**。

**新 Typology 优先复用现有项**：Retail 的"可见性"第一选择是 `frontageQuality`，
不是新开 `retailVisibility`。

只有同时满足下面两条才允许新增通用诊断：

1. 至少两个不同 Typology 都需要；
2. 无法合理映射到已有诊断。

---

## 7. Evaluator（冻结）

```
Candidate + Typology Weights + Archetype Targets
                    ↓
              LayoutEvaluation
```

- Evaluator 不知道方案怎么生成；
- Archetype **不允许**改 Evaluator 内部；
- typology 差异只能用 `weights` / `targets` / `penalties` 表达；
- 正分项归一化到 0~10，惩罚项直接扣（否则 8 个 0~1 的正分项相加到 16+，
  3 分制的惩罚永远赢不了，"差方案"也像好方案）。

---

## 8. Core 允许的扩展点

| 扩展 | 方式 | 调用方是否变 |
|---|---|---|
| A 新 Ground Program | 加枚举值 | 否 |
| B 新通用 Diagnostics | 过 §6 两条门槛 | Evaluator 加权重 |
| C 几何后端 | 换 `surface.ts` 内部实现（如 clipper2-ts） | **否** |
| D 空间索引 | 换 `queryNeighbors()` 内部（如 RBush） | **否** |
| E 路径求解 | 换 AccessGraph 内部（如 graphology） | **否** |

C / D / E 是这份冻结最大的价值：**接口不动，实现随便换**。

---

## 9. 禁止事项

```
✗ 为单个 Archetype 修改 SiteContext
✗ 把 typology 私有状态塞进 Candidate 核心字段
✗ 让 Generator 直接写 Scene
✗ 把 GroundProgram 直接当材质用
✗ 因为 Retail / Hotel / DC 的特殊需求把逻辑堆回 modern.ts
```

---

## 10. 技术债

### TECH-01 · Frontage Tolerance（不阻塞）

`resolveFrontages` 里用"地块边到道路中心线 ≤ 3 单位"匹配临街面。
应改为 `halfWidth + sidewalk + curbOffset + ε`，或按 `RoadClass` 给默认值。
现状能跑（真城 99/99 匹配成功），但 arterial / local / 工业服务路宽度差异大时会误配。

### TECH-02 · Candidate Diversity（不阻塞）

工业的 `centered` 与 `side-biased` 分数不同但**视觉差异偏弱**。
需要 `candidateSimilarity`（比较建筑质心 / 覆盖率 / ground 分布 / 朝向），
过于相似的候选不进最终集合。

### TECH-03 · Geometry Backend（不阻塞）

`surfaceInset` / `surfaceOffset` 用自研 miter 偏移，已验证：
凸 / 凹 / 带洞 / 常见城市地块。遇到
`self-intersection` / `offset collapse` / `hole topology failure` 再换 Clipper2。
**禁止为了"理论上更成熟"提前重写。**

---

## 11. Core Freeze Gate

任何想改 Core 的提案，按顺序回答：

| # | 问题 | 若 Yes |
|---|---|---|
| Q1 | 能否放进 Typology Grammar？ | 不改 Core |
| Q2 | 能否放进 Archetype Candidate Generator？ | 不改 Core |
| Q3 | 能否通过 Weight / Target 解决？ | 不改 Core |
| Q4 | 是否**至少两个**不同 Typology 都需要这个新概念？ | 只有 Q1~Q3 全 No 且 Q4 Yes 才允许改 |

---

## 12. 冻结后的顺序

```
Industrial Rear-Load   PASS   （35 断言，真城 9 块工业地 7 块成功）
MF Courtyard           PASS   （31 断言，真城 25 块住宅地 10 块成功）
──────── CORE FREEZE ────────
Retail Strip           PASS   （23 断言，真城 31 块商业地 31 块成功）
                            ← 冻结后第一套，零 Core 契约改动
Hotel Gurban           PASS   （41 断言，真城 31 块候选地 27 块成功）
                            ← 冻结后第二套，只新增 2 个 Ground Program + 1 个 access role 值
Data Center Single Hall PASS   （40 断言，真城 9 块候选地 6 块成功）
                            ← 冻结后第三套，只新增 3 个 Ground Program
Single-Family Detached Grid PASS  （24 断言，真城 25 块住宅地 23 块细分成功）
```

**Retail 的冻结验证结论**：新增 `typologies/retail.ts` + `archetypes/retail/strip.ts` + 23 条 Golden 断言，
`SiteContext` / `SitePlanCandidate` / `PlanSurface` / `Evaluator Contract` **零改动**，
`planning-freeze.test.ts` 19 项契约校验仍然全绿 —— 说明 §13 的判定标准第一次真被满足。

**Data Center 的第三次验证 · 升级为 STABLE**：五套语法走完——
物流（工业）/ 围合（住宅）/ 停车+店面（零售）/ 到达序列（酒店）/ 设施邻接+安防（DC），
`SiteContext` / `SitePlanCandidate` / `PlanSurface` / `Evaluator Contract` **结构零改动**。
DC 只加了 3 个 Ground Program（Freeze §5 的上限），
"设备邻接 / 后勤可达 / 安防纵深"三个新评分**全部是内部计算的辅助函数**，
结果折算进 `typologyFit` / `circulationQuality` / `groundUsability`，没有新增诊断字段。
§13 的成功判定成立：**Core 从 FROZEN 升级为 STABLE。**

**Single-Family 的最后一验证 · 层级式 subdivision**：前五种都是「一个地块 → 一个方案」，
独栋第一次是「地块 → 内部路 → 多个宅地 → 多栋住宅」。做法是**在 Archetype 内部**加一层
私有 DTO `SubdivisionPlan { roads, lots, openSpace }`，Core 完全不知道 `ResidentialLot` 是什么，
最终仍翻译成冻结的 `SitePlanCandidate`（`buildings` 本来就是数组）。
`SiteContext` / `SitePlanCandidate` / `PlanSurface` / `Evaluator Contract` 仍然零结构改动 —— 
STABLE 不只覆盖"六种场地语法"，也覆盖"层级式细分"。只新增 4 个 Ground Program
（`front_yard` / `rear_yard` / `driveway` / `community_green`），**内部路不进 Ground，走 circulation**。

**Hotel 的第二次验证**：四套语法（前后勤 / 围合核心 / 停车+店面 / 到达序列）走完，
Core 结构仍然零改动。Hotel 只做了两件 Freeze 明确允许的事：
①新增 `arrival_court` / `dropoff` 两个 Ground Program；②`access.role` 增加 `main_lobby` 值。
"到达感"没有新开诊断字段，而是拆进 `accessClarity`（序列成立）+ `spatialCoreQuality`（到达院质量）
+ `pedestrianClarity`（落客→大堂）——正是 §6 要求的复用方式。

---

## 13. 冻结是否成功的判定

如果 Retail / Hotel / Data Center 能只靠
**新增 Grammar + 新增 Archetype + 新增 Weight + 新增 Golden Tests**
完成，而不修改

```
SiteContext   SitePlanCandidate   PlanSurface   Evaluator Contract
```

则 Planning Core 架构正式验证通过。

---

## 附录 · 当前实现位置

```
planning/core/surface.ts     PlanSurface / 布尔 / inset / anchor
planning/core/types.ts       SiteContext / Diagnostics / Weights 类型
planning/core/context.ts     SiteContext 构建（frontage / access / buildable / neighbor / archetype 筛选）
planning/core/candidate.ts   SitePlanCandidate + validateCandidate
planning/core/evaluator.ts   权重 + evaluateLayout
planning/typologies/*        每类的地面白名单 + diagnostics
planning/archetypes/*        每类的候选生成器
planning/adapters/model.ts   Model/Patch/RoadNet → SiteContext
```
