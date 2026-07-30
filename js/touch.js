// touch.js · 虚拟按键绑定
// 行为:
//   - left/right/defend: 按住生效(持续移动/防御) -> touchDown / touchUp
//   - jump/atkL/atkH/reset: 单次点击 -> touchTap
// 支持多点触控(同时按方向+动作)

(function () {
  const CONTROLS_ID = 'touchControls';
  const container = document.getElementById(CONTROLS_ID);
  if (!container) return;

  // 按下/抬起标识,支持 pointer 与 touch 双轨
  const HOLD = new Set(['left', 'right', 'defend']);
  const TAP  = new Set(['jump', 'atkL', 'atkH', 'reset']);

  // 当前活跃指针: pointerId -> { act, hold }
  const active = new Map();

  function btnFor(act) {
    return container.querySelector(`[data-act="${act}"]`);
  }

  function start(act, ptrId) {
    if (active.has(ptrId)) return; // 同一指针不重复
    const btn = btnFor(act);
    if (btn) btn.classList.add('pressed');
    active.set(ptrId, { act });
    if (HOLD.has(act)) Input.touchDown(act);
    else if (TAP.has(act)) Input.touchTap(act);
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
    // 一次性释放所有活跃指针(如触控取消)
    [...active.keys()].forEach(end);
  }

  // 使用 Pointer Events 统一鼠标/触摸/笔
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

  // 指针抬起/取消: 用捕获元素的 pointercancel/pointerup 一起处理
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
    container.addEventListener(ev, (e) => {
      // 仅处理当前活跃指针
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
      if (e.target.closest && e.target.closest('.tbtn, .stage-wrap, #game')) {
        e.preventDefault();
      }
    }, { passive: false });
  });

  // 阻止页面上下滚动
  document.addEventListener('gesturechange', (e) => e.preventDefault());

  // 标记为已初始化(便于调试)
  container.dataset.ready = '1';
})();
