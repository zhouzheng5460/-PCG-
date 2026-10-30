// 浮动工具条的交互自测（只在 ?selftest=1 时动态载入，正常使用完全不加载）。
//
// 为什么要在浏览器里测：拖拽逻辑全部挂在画布的 PointerEvent 上
// （拾取 → 拖动 → 松开提交），node 里根本跑不到。
// 这里用合成 PointerEvent 打一遍真实事件链路，再把结果写进页面上的报告面板，
// 用无头浏览器截图就能看结论。
//
// 合成指针没有真实 pointerId，setPointerCapture 会抛错 —— View2D 里已经 try/catch。

import { Pt } from '../core/geom';
import { buildRoadNet } from '../road/system';
import { zoneToPolygon, area } from '../town/zones';
import { centerOf, rotateAbout } from './zoneedit';
import type { Zone } from '../town/zones';
import type { FieldGuide } from '../town/guide';
import type { View2D } from './view2d';

export interface SelfTestHost {
  view: View2D;
  canvas: HTMLCanvasElement;
  zones: () => Zone[];
  guides: () => FieldGuide[];
}

const PTR = 99;

export function runSelfTest(host: SelfTestHost): void {
  const { view, canvas, zones, guides } = host;
  const rect = canvas.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:absolute;left:12px;top:12px;z-index:50;background:rgba(16,18,22,.94);border:1px solid #2e333a;' +
    'border-radius:6px;padding:10px 12px;font:11px/1.6 ui-monospace,monospace;color:#dfe3e8;max-width:540px;white-space:pre';
  (canvas.parentElement ?? document.body).appendChild(panel);

  const lines: string[] = [];
  let fail = 0;
  const log = (name: string, pass: boolean, extra = '') => {
    if (!pass) fail++;
    lines.push(`${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
    panel.textContent = lines.join('\n');
  };

  const privateView = view as unknown as {
    worldToScreen: (q: Pt) => { x: number; y: number };
    sel: { kind: string; id: string } | null;
  };
  const screenOf = (p: Pt) => privateView.worldToScreen(p);
  const ev = (type: string, sx: number, sy: number) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        clientX: rect.left + sx,
        clientY: rect.top + sy,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: PTR,
        bubbles: true,
      })
    );

  const clickTool = (tool: string) => {
    const btn = document.querySelector<HTMLButtonElement>(`.float-bar button[data-tool="${tool}"]`);
    if (btn) btn.click();
    return !!btn;
  };

  const cur = (): Zone | null => {
    const sel = privateView.sel;
    if (!sel || sel.kind !== 'zone') return null;
    return zones().find((z) => z.id === sel.id) ?? null;
  };

  /** 当前选中禁绘区的中心 + 半宽半高（世界单位），用来构造"一定在内部"的按下点 */
  const frame = (): { c: Pt; hw: number; hh: number } | null => {
    const z = cur() ?? zones()[0];
    if (!z) return null;
    const ring = zoneToPolygon(z);
    if (ring.length < 3) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of ring) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return { c: new Pt((x0 + x1) / 2, (y0 + y1) / 2), hw: (x1 - x0) / 2, hh: (y1 - y0) / 2 };
  };

  if (zones().length === 0) {
    log('需要一个禁绘区（用 ?zone=1 打开）', false);
    return;
  }

  /** 诊断行：把当前选中对象的形状参数与面积原样打出来，出问题时好定位 */
  const shapeLine = (tag: string) => {
    const z = cur() ?? zones()[0];
    if (!z) return;
    const s = z.shape;
    const brief =
      s.kind === 'rect'
        ? `rect a=(${s.a.x.toFixed(1)},${s.a.y.toFixed(1)}) b=(${s.b.x.toFixed(1)},${s.b.y.toFixed(1)})`
        : s.kind === 'circle'
          ? `circle c=(${s.c.x.toFixed(1)},${s.c.y.toFixed(1)}) r=${s.r.toFixed(1)}`
          : `poly ${s.pts.length}pt`;
    lines.push(`· ${tag}: ${brief} A=${area(zoneToPolygon(z)).toFixed(1)}`);
    panel.textContent = lines.join('\n');
  };
  lines.push(`· 禁绘区 ${zones().length} 个：${zones().map((z) => z.id).join(',')}`);
  shapeLine('初始');

  // ① 点选
  {
    const f = frame()!;
    const s = screenOf(f.c);
    ev('pointerdown', s.x, s.y);
    ev('pointerup', s.x, s.y);
    shapeLine('点击后');
    log('点击禁绘区内部能选中', !!privateView.sel, privateView.sel ? JSON.stringify(privateView.sel) : '未选中');
    log('浮动工具条已出现', !!document.querySelector('.float-bar button[data-tool="move"]'));
  }

  // ② 移动
  {
    const f0 = frame()!;
    const s = screenOf(f0.c);
    ev('pointerdown', s.x, s.y);
    ev('pointermove', s.x + 80, s.y + 40);
    const mid = frame()!;
    log('拖动过程中轮廓实时跟随', Math.abs(mid.c.x - f0.c.x) > 0.5 || Math.abs(mid.c.y - f0.c.y) > 0.5,
      `Δ=(${(mid.c.x - f0.c.x).toFixed(2)}, ${(mid.c.y - f0.c.y).toFixed(2)})`);
    ev('pointerup', s.x + 80, s.y + 40);
    shapeLine('移动后');
    const f1 = frame()!;
    const same = Math.abs(f1.c.x - mid.c.x) < 0.01 && Math.abs(f1.c.y - mid.c.y) < 0.01;
    log('松开后位置已提交（不再回弹）', same && (Math.abs(f1.c.x - f0.c.x) > 0.5),
      `落点=(${f1.c.x.toFixed(1)}, ${f1.c.y.toFixed(1)})`);
  }

  // ③ 旋转 90°：轴对齐矩形仍应是矩形
  {
    log('切到旋转工具', clickTool('rotate'));
    const f = frame()!;
    const z0 = cur();
    const a0 = z0 ? area(zoneToPolygon(z0)) : 0;
    const p0 = new Pt(f.c.x + f.hw * 0.5, f.c.y);
    const p1 = new Pt(f.c.x, f.c.y + f.hh * 0.5);
    const s0 = screenOf(p0);
    const s1 = screenOf(p1);
    ev('pointerdown', s0.x, s0.y);
    ev('pointermove', s1.x, s1.y);
    ev('pointerup', s1.x, s1.y);
    const z1 = cur();
    const a1 = z1 ? area(zoneToPolygon(z1)) : 0;
    log('旋转后面积不变', Math.abs(a1 - a0) < Math.max(0.5, a0 * 0.02), `${a0.toFixed(1)} → ${a1.toFixed(1)}`);
    log('轴对齐矩形转 90° 仍是矩形', z1?.shape.kind === 'rect', String(z1?.shape.kind));
  }

  // ④ 缩放 2×：面积应 ×4
  {
    log('切到缩放工具', clickTool('scale'));
    const f = frame()!;
    const z0 = cur();
    const a0 = z0 ? area(zoneToPolygon(z0)) : 0;
    const p0 = new Pt(f.c.x + f.hw * 0.5, f.c.y);
    const p1 = new Pt(f.c.x + f.hw * 0.98, f.c.y);
    const s0 = screenOf(p0);
    const s1 = screenOf(p1);
    ev('pointerdown', s0.x, s0.y);
    ev('pointermove', s1.x, s1.y);
    ev('pointerup', s1.x, s1.y);
    const z1 = cur();
    const a1 = z1 ? area(zoneToPolygon(z1)) : 0;
    const k = a0 > 0 ? Math.sqrt(a1 / a0) : 0;
    log('放大后面积按边长平方增长', Math.abs(k - 2) < 0.2, `面积 ${a0.toFixed(1)} → ${a1.toFixed(1)}（边长 ×${k.toFixed(2)}）`);
  }

  // ⑤ 改形状：拖一个角
  {
    log('切到改形状工具', clickTool('shape'));
    const z0 = cur();
    const ring0 = z0 ? zoneToPolygon(z0) : [];
    shapeLine('改形状前');
    if (ring0.length >= 3) {
      const s = screenOf(ring0[0]);
      lines.push(
        `· 抓取把手 0 于屏幕 (${s.x.toFixed(0)},${s.y.toFixed(0)})，角点世界 (${ring0[0].x.toFixed(1)},${ring0[0].y.toFixed(1)})`
      );
      ev('pointerdown', s.x, s.y);
      ev('pointermove', s.x - 30, s.y - 30);
      ev('pointerup', s.x - 30, s.y - 30);
      const z1 = cur();
      shapeLine('改形状后');
      const ring1 = z1 ? zoneToPolygon(z1) : [];
      log('改形状后仍是合法多边形', ring1.length >= 3, `${ring0.length} → ${ring1.length} 点`);
      log('把手拖动确实改变了轮廓', Math.abs(area(ring1) - area(ring0)) > 0.01,
        `${area(ring0).toFixed(1)} → ${area(ring1).toFixed(1)}`);
    } else {
      log('改形状前能拿到轮廓', false);
    }
  }

  // ⑥ 禁用 / 启用按钮
  {
    const before = cur()?.enabled;
    const btn = document.querySelector<HTMLButtonElement>('.float-bar button[data-act="toggle"]');
    btn?.click();
    const after = cur()?.enabled;
    log('禁用按钮能切换状态', before !== after, `${before} → ${after}`);
    btn?.click();
  }

  // ⑦ 方向线：选中 + 旋转 90°（另一种对象类型，走 mapGuide 分支）
  {
    const gs = guides();
    if (gs.length === 0) {
      lines.push('· 没有方向线，跳过方向线用例（可用 ?guides=1 一起测）');
    } else {
      const g0 = gs[0];
      view.selectById('guide', g0.id);
      log('方向线能被选中', privateView.sel?.kind === 'guide', String(privateView.sel?.kind));
      log('切到旋转工具', clickTool('rotate'));
      const c = centerOf(g0.pts);
      const p0 = g0.pts[0];
      const p1 = rotateAbout(p0, c, Math.PI / 2);
      const s0 = screenOf(p0);
      const s1 = screenOf(p1);
      ev('pointerdown', s0.x, s0.y);
      ev('pointermove', s1.x, s1.y);
      ev('pointerup', s1.x, s1.y);
      const g1 = guides().find((g) => g.id === g0.id);
      const seg = (g: FieldGuide) => Math.hypot(g.pts[1].x - g.pts[0].x, g.pts[1].y - g.pts[0].y);
      log('方向线旋转后首段长度不变', !!g1 && Math.abs(seg(g1) - seg(g0)) < 0.05,
        g1 ? `${seg(g0).toFixed(2)} → ${seg(g1).toFixed(2)}` : '未找到');
      log('方向线旋转后确实动了', !!g1 && Math.hypot(g1.pts[0].x - g0.pts[0].x, g1.pts[0].y - g0.pts[0].y) > 1,
        g1 ? `首点 (${g0.pts[0].x.toFixed(1)},${g0.pts[0].y.toFixed(1)}) → (${g1.pts[0].x.toFixed(1)},${g1.pts[0].y.toFixed(1)})` : '');
    }
  }

  // ⑧ 选路 + 单条调宽（侧栏「选中路」滑杆）
  {
    interface NetLike {
      edges: { a: Pt; b: Pt; cls: string; carriage: number }[];
    }
    const mdl = (view as unknown as { model: { revision: number } }).model;
    const net = buildRoadNet(mdl as never) as unknown as NetLike;
    // 取离画面中心最近的一条路（避开通往画布外的）
    const rectC = canvas.getBoundingClientRect();
    const center = { x: rectC.width / 2, y: rectC.height / 2 };
    let target: NetLike['edges'][number] | null = null;
    let bestD = Infinity;
    for (const e of net.edges) {
      const m = new Pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
      const s0 = screenOf(m);
      const d = Math.hypot(s0.x - center.x, s0.y - center.y);
      if (d < bestD) {
        bestD = d;
        target = e;
      }
    }
    if (!target) {
      log('找到一条可选的路', false);
    } else {
      const mid = new Pt((target.a.x + target.b.x) / 2, (target.a.y + target.b.y) / 2);
      const s0 = screenOf(mid);
      ev('pointerdown', s0.x, s0.y);
      ev('pointerup', s0.x, s0.y);
      const input = document.querySelector<HTMLInputElement>('#rng-artery');
      log('点路后侧栏「选中路」可用', !!input && !input.disabled, input ? `min=${input.min} max=${input.max} 值=${input.value}` : '找不到滑杆');
      const bar = document.querySelector<HTMLElement>('.float-bar');
      log('选路时对象工具条已收起', !bar || bar.style.display === 'none', bar ? `display=${bar.style.display || '(空)'}` : '无工具条');
      if (input) {
        const w0 = Number(input.value);
        input.value = String(Math.min(Number(input.max), w0 + 1.5));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // 改完宽度看滑杆数值有没有同步回来
        const after = document.querySelector<HTMLInputElement>('#rng-artery');
        const val = document.getElementById('val-artery')?.textContent ?? '';
        log('改宽后滑杆数值已回填', !!after && Math.abs(Number(after.value) - (w0 + 1.5)) < 0.11,
          `${w0.toFixed(1)} → ${after?.value}（${val}）`);
        // 复位
        document.querySelector<HTMLButtonElement>('#btn-artery-reset')?.click();
        const back = document.querySelector<HTMLInputElement>('#rng-artery');
        log('复位按钮恢复默认宽', !!back && Math.abs(Number(back.value) - w0) < 0.11, back?.value ?? '-');
      }
    }
  }

  // 收尾：工具切回"移动"，让截图里的工具条处于默认态
  clickTool('move');
  lines.push(`# ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
  panel.textContent = lines.join('\n');
  console.log(lines.join('\n'));
}
