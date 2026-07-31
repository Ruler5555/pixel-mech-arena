// sprite.js · 程序化像素机甲绘制(无外部素材)
// 在 Canvas 上用网格矩形拼出机甲,支持动画状态
//
// drawMech(ctx, x, y, facing, anim, pal)
//   x,y   = 脚底中心锚点
//   facing= 1 朝右 / -1 朝左
//   anim  = { state, stateTime, frame, flash }
//   pal   = { primary, secondary, dark, visor, accent, weapon, shield }

const Sprite = (() => {
  const S = 3; // 1 网格 = 3 像素

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  // 取攻击动作阶段: windup(起手) -> active(命中) -> recover(收招)
  function atkPhase(t, wind, act) {
    if (t < wind) return { phase: 'wind', p: t / wind };
    if (t < act)  return { phase: 'active', p: (t - wind) / (act - wind) };
    return { phase: 'recover', p: clamp01((t - act) / (1 - act)) };
  }

  function drawMech(ctx, x, y, facing, anim, pal) {
    const { state, stateTime: st, frame, flash } = anim;
    const c = flash
      ? { ...pal, primary: '#ffffff', secondary: '#ffe0e0', dark: '#ff8888', visor: '#ffffff', weapon: '#ffffff' }
      : pal;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(facing, 1); // 朝左时整体镜像

    // r: 网格坐标绘制 (gx 向右, gy 向上)
    const r = (gx, gy, gw, gh, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(gx * S), Math.round(-gy * S), Math.round(gw * S), Math.round(gh * S));
    };

    // ===== 默认姿态参数 =====
    let bob = 0;            // 整体上下浮动
    let legPhase = 0;       // 行走腿部相位 0..1
    let armThrust = 0;      // 前臂前伸量 0..1
    let armRaise = 0;       // 前臂上抬
    let lean = 0;           // 身体前倾
    let shieldOn = 0;       // 防御盾显现 0..1
    let lying = false;      // 倒地
    let muzzle = 0;         // 枪口火光 0..1

    // ===== 各状态动画 =====
    if (state === 'idle') {
      bob = Math.sin(frame * 0.06) > 0 ? 1 : 0;
    } else if (state === 'walk') {
      bob = (Math.floor(frame * 0.18) % 2 === 0) ? 1 : 0;
      legPhase = Math.sin(frame * 0.36);
    } else if (state === 'jump') {
      legPhase = 0.5; bob = 0; lean = 0.5;
    } else if (state === 'atkL') {
      const p = atkPhase(st, 0.10, 0.20);
      if (p.phase === 'wind')  { armRaise = p.p * 0.5; lean = p.p * 0.3; }
      else if (p.phase === 'active') { armThrust = 1; muzzle = 1 - p.p; lean = 1; }
      else { armThrust = 1 - p.p * 0.6; lean = 1 - p.p; }
    } else if (state === 'atkH') {
      const p = atkPhase(st, 0.30, 0.42);
      if (p.phase === 'wind')  { armRaise = p.p; lean = p.p * 0.6; bob = -Math.floor(p.p * 2); }
      else if (p.phase === 'active') { armThrust = 1; muzzle = 1 - p.p; lean = 1; }
      else { armThrust = 1 - p.p * 0.7; lean = 1 - p.p; }
    } else if (state === 'defend') {
      shieldOn = Math.min(1, st * 8);
      bob = Math.sin(frame * 0.1) > 0 ? 1 : 0;
    } else if (state === 'hurt') {
      bob = (Math.floor(st * 30) % 2 === 0) ? 2 : -2;
    } else if (state === 'ko') {
      lying = true;
    }

    if (lying) {
      ctx.rotate(-Math.PI / 2 * 0.95);
      ctx.translate(-2 * S, -10 * S);
    }

    const oy = bob; // 整体 y 偏移

    // ===== 腿部 =====
    const legY = 0 + oy, legH = 8;
    const lShift = legPhase > 0 ? legPhase * 1.5 : 0;
    const rShift = legPhase < 0 ? -legPhase * 1.5 : 0;
    // 左腿(后)
    r(-4 + lShift, legY, 3, legH, c.dark);
    r(-3.5 + lShift, legY + 1, 2, legH - 2, c.secondary);
    // 右腿(前)
    r(1 - rShift, legY, 3, legH, c.dark);
    r(1.5 - rShift, legY + 1, 2, legH - 2, c.primary);
    // 脚(更宽)
    r(-5 + lShift, legY - 1, 4, 2, c.dark);
    r(1 - rShift, legY - 1, 4, 2, c.dark);

    // ===== 躯干 =====
    const torsoY = 9 + oy;
    r(-5, torsoY, 10, 9, c.dark);          // 外框
    r(-4.5, torsoY + 0.5, 9, 8, c.primary); // 主体
    r(-4.5, torsoY + 0.5, 9, 2, c.secondary); // 上胸暗部
    r(-4, torsoY + 3, 8, 1, c.accent);     // 装饰带
    // 驾驶舱
    r(-2, torsoY + 3, 4, 4, c.dark);
    r(-1.5, torsoY + 3.5, 3, 3, c.visor);
    // 腰带
    r(-4.5, torsoY + 7, 9, 1, c.dark);

    // ===== 肩部 =====
    const shY = 17 + oy + lean;
    r(-7, shY, 3, 3, c.dark);
    r(-6.5, shY + 0.5, 2, 2, c.secondary);
    r(4, shY, 3, 3, c.dark);
    r(4.5, shY + 0.5, 2, 2, c.primary);

    // ===== 头部 =====
    const headY = 20 + oy + lean;
    r(-3, headY, 6, 5, c.dark);
    r(-2.5, headY + 0.5, 5, 4, c.primary);
    r(-2, headY + 1.5, 4, 2, c.visor);    // 面罩
    r(0.5, headY + 1.8, 1.5, 1, c.accent); // 高光
    r(-1, headY + 5, 2, 1, c.secondary);  // 下颌
    // 天线
    r(-0.5, headY + 5, 1, 3, c.secondary);
    r(-0.5, headY + 8, 1, 1, c.visor);

    // ===== 后臂(固定) =====
    const armBaseY = 12 + oy + lean;
    r(-6, armBaseY, 2, 5, c.secondary);

    // ===== 前臂 + 武器(随动画) =====
    const thrustX = armThrust * 4;
    const raiseY = armRaise * -1.5;
    // 前臂
    r(4 + thrustX, armBaseY + raiseY, 2.5, 5, c.dark);
    r(4.3 + thrustX, armBaseY + 0.5 + raiseY, 2, 4, c.primary);
    // 武器(炮管)
    const wY = armBaseY + 1.5 + raiseY;
    r(6 + thrustX, wY, 5, 2.5, c.weapon);
    r(6 + thrustX, wY + 0.3, 5, 0.6, c.accent);
    r(11 + thrustX, wY - 0.5, 1.5, 3.5, c.dark); // 枪口

    // 枪口火光
    if (muzzle > 0) {
      const fx = 12.5 + thrustX, fy = wY + 0.7;
      r(fx, fy, 3, 1.5, '#fff3a0');
      r(fx + 1, fy - 1, 2, 3.5, '#ffcc33');
      r(fx + 2, fy - 0.5, 2, 2.5, '#ff6a3a');
      if (muzzle > 0.5) {
        r(fx + 4, fy + 0.5, 1.5, 1, '#ffffff');
      }
    }

    // ===== 防御盾 =====
    if (shieldOn > 0) {
      ctx.save();
      ctx.globalAlpha = shieldOn * 0.85;
      const sx = 7, sy = 8 + oy;
      r(sx, sy, 3, 12, c.visor);
      r(sx + 0.5, sy + 0.5, 2, 11, c.accent);
      r(sx + 1, sy + 1, 1, 10, c.primary);
      // 边缘高光
      ctx.globalAlpha = shieldOn * 0.5;
      r(sx, sy, 3, 1, '#ffffff');
      r(sx, sy + 11, 3, 1, '#ffffff');
      ctx.restore();
    }

    // ===== 攻击命中波纹(在身前) =====
    if ((state === 'atkL' || state === 'atkH')) {
      const p = atkPhase(st, state === 'atkL' ? 0.10 : 0.30,
                              state === 'atkL' ? 0.20 : 0.42);
      if (p.phase === 'active') {
        const rad = 2 + p.p * (state === 'atkL' ? 4 : 7);
        ctx.save();
        ctx.globalAlpha = 1 - p.p;
        ctx.strokeStyle = state === 'atkH' ? '#ffcc33' : '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc((12.5 + thrustX) * S, -(wY + 0.7) * S, rad * S, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  // 像素化场景: 远景星空 + 中景城市 + 地面
  function drawBackground(ctx, W, H, frame) {
    // 天空渐变
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1a0f3a');
    g.addColorStop(0.5, '#3a1f5a');
    g.addColorStop(1, '#5a2a4a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 星星
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 60; i++) {
      const sx = (i * 137) % W;
      const sy = (i * 53) % (H * 0.5);
      const tw = (Math.sin(frame * 0.05 + i) > 0.6) ? 2 : 1;
      ctx.fillRect(sx, sy, tw, tw);
    }

    // 远山(紫色)
    ctx.fillStyle = '#2a1a4a';
    drawHills(ctx, W, H, H * 0.62, 30, 0.5);
    // 中景城市剪影
    ctx.fillStyle = '#1a1230';
    drawCity(ctx, W, H, H * 0.7, 12);
    // 窗户灯
    ctx.fillStyle = '#ffcc33';
    for (let i = 0; i < 40; i++) {
      const bx = (i * 53) % W;
      const by = H * 0.7 + (i * 17) % 40;
      if ((frame + i) % 80 < 70) ctx.fillRect(bx, by, 2, 2);
    }

    // 地面
    const groundY = H - 50;
    ctx.fillStyle = '#2a1818';
    ctx.fillRect(0, groundY, W, 50);
    ctx.fillStyle = '#3a2222';
    ctx.fillRect(0, groundY, W, 4);
    // 地面网格(透视)
    ctx.strokeStyle = '#5a3030';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const y = groundY + 4 + t * 46;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (let i = -6; i <= 6; i++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + i * 30, groundY + 4);
      ctx.lineTo(W / 2 + i * 120, H);
      ctx.stroke();
    }
  }

  function drawHills(ctx, W, H, baseY, amp, freq) {
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    for (let x = 0; x <= W; x += 8) {
      const y = baseY - Math.abs(Math.sin(x * 0.02 * freq)) * amp - Math.sin(x * 0.005) * 10;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
  }

  function drawCity(ctx, W, H, baseY, cols) {
    const bw = W / cols;
    for (let i = 0; i < cols; i++) {
      const h = 20 + ((i * 37) % 50);
      const x = i * bw;
      ctx.fillRect(x, baseY - h, bw - 2, h);
      // 顶部天线
      if (i % 3 === 0) ctx.fillRect(x + bw / 2 - 1, baseY - h - 6, 2, 6);
    }
  }

  return { drawMech, drawBackground };
})();
