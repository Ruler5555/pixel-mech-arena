// touch.js · 虚拟按键 + 左侧拖动式摇杆
// 行为:
//   - move-zone: 左半区按下并拖动 = 移动(按水平位移符号触发 left/right)
//   - defend: 按住生效(持续防御) -> touchDown / touchUp
//   - jump/atkL/atkH/reset: 单次点击 -> touchTap
// 支持多点触控(摇杆 + 动作按钮可同时操作)

(function () {
  const CONTROLS_ID = 'touchControls';
  const container = document.getElementById(CONTROLS_ID);
  if (!container) return;

  // 按下/抬起标识,支持 pointer 与 touch 双轨
  const HOLD = new Set(['defend']);
  const TAP  = new Set(['jump', 'atkL', 'atkH', 'reset', 'rematch']);

  // 动作按钮的活跃指针: pointerId -> { act }
  const active = new Map();

  function btnFor(act) {
    return container.querySelector(`[data-act="${act}"]`);
  }

  // 触觉反馈: 不同动作不同震动时长(特性检测, iOS Safari 无害忽略)
  const HAPTIC = { jump: 8, atkL: 10, atkH: 20 };
  function haptic(act) {
    const ms = HAPTIC[act];
    if (ms && navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (_) {}
    }
  }

  function start(act, ptrId) {
    if (active.has(ptrId)) return; // 同一指针不重复
    const btn = btnFor(act);
    if (btn) btn.classList.add('pressed');
    active.set(ptrId, { act });
    if (HOLD.has(act)) Input.touchDown(act);
    else if (TAP.has(act)) Input.touchTap(act);
    haptic(act);
  }

  function end(ptrId) {
    const a = active.get(ptrId);
    if (!a) return;
    const btn = btnFor(a.act);
    if (btn) btn.classList.remove('pressed');
    if (HOLD.has(a.act)) Input.touchUp(a.act);
    active.delete(ptrId);
  }

  function endAll() {
    [...active.keys()].forEach(end);
    stickRelease(); // 同时释放摇杆
  }

  // ===== 左侧拖动式虚拟摇杆 =====
  const moveZone = document.getElementById('moveZone');
  const stickKnob = document.getElementById('stickKnob');
  let stickPointerId = null;
  let stickOriginX = 0;        // 按下时的屏幕 X
  let stickOriginY = 0;
  let stickCurDir = null;      // 'left' | 'right' | null
  const DEAD_ZONE = 8;         // 死区 px, 防止微抖动
  let maxTravel = 48;          // 摇杆最大位移 px, 随 move-zone 实际尺寸动态计算

  function stickStart(e) {
    if (stickPointerId !== null) return; // 已有指针
    stickPointerId = e.pointerId;
    stickOriginX = e.clientX;
    stickOriginY = e.clientY;
    stickCurDir = null;
    const rect = moveZone.getBoundingClientRect();
    maxTravel = Math.max(20, rect.width * 0.40);
    moveZone.classList.add('active');
    try { moveZone.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }

  function stickMove(e) {
    if (e.pointerId !== stickPointerId) return;
    const dx = e.clientX - stickOriginX;
    const dy = e.clientY - stickOriginY;
    // 限制 knob 位移
    const dist = Math.hypot(dx, dy);
    const clamped = dist > maxTravel ? maxTravel / dist : 1;
    const kx = dx * clamped;
    const ky = dy * clamped;
    if (stickKnob) {
      stickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    }
    // 计算方向(只取水平)
    let newDir = null;
    if (Math.abs(dx) > DEAD_ZONE) {
      newDir = dx < 0 ? 'left' : 'right';
    }
    if (newDir !== stickCurDir) {
      // 方向变化: 释放旧方向, 按下新方向
      if (stickCurDir) Input.touchUp(stickCurDir);
      if (newDir) Input.touchDown(newDir);
      stickCurDir = newDir;
    }
    e.preventDefault();
  }

  function stickRelease() {
    if (stickCurDir) {
      Input.touchUp(stickCurDir);
      stickCurDir = null;
    }
    if (stickKnob) stickKnob.style.transform = '';
    if (moveZone) moveZone.classList.remove('active');
    stickPointerId = null;
  }

  function stickEnd(e) {
    if (e.pointerId !== stickPointerId) return;
    stickRelease();
    e.preventDefault();
  }

  if (moveZone) {
    moveZone.addEventListener('pointerdown', stickStart);
    moveZone.addEventListener('pointermove', stickMove);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
      moveZone.addEventListener(ev, stickEnd);
    });
  }

  // ===== 动作按钮(右侧扇形集群) =====
  container.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.tbtn');
    if (!btn) return;
    e.preventDefault();
    const act = btn.dataset.act;
    if (!act) return;
    // 捕获指针,确保抬起时仍能收到事件
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    start(act, e.pointerId);
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
    container.addEventListener(ev, (e) => {
      if (active.has(e.pointerId)) {
        e.preventDefault();
        end(e.pointerId);
      }
    });
  });

  // 浏览器失焦/隐藏: 释放全部,防止"按住"卡死
  window.addEventListener('blur', endAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) endAll();
  });

  // 防止 iOS 双击缩放、长按菜单、滑动橡皮筋
  // 注意: 不要阻止 .overlay 内按钮(否则"再来一局"点不了)
  ['touchstart', 'touchmove', 'touchend', 'gesturestart'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      if (e.target.closest && e.target.closest('.tbtn, .move-zone, .exit-mobile-btn, .stage-wrap, #game')) {
        e.preventDefault();
      }
    }, { passive: false });
  });

  // 阻止页面上下滚动
  document.addEventListener('gesturechange', (e) => e.preventDefault());

  // 标记为已初始化(便于调试)
  container.dataset.ready = '1';
})();
