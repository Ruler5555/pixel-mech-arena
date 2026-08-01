// input.js · 输入管理(键盘 + 触控,多源合并)
// 触控源由 touch.js 通过 press/release/tap 注入
const Input = (() => {
  // 键盘按下状态
  const kbDown = Object.create(null);
  // 触控按下状态
  const tcDown = Object.create(null);
  // 单次按下(键盘+触控合并,用于攻击/跳跃等)
  const tapped = Object.create(null);

  const MAP = {
    'a': 'left', 'arrowleft': 'left',
    'd': 'right', 'arrowright': 'right',
    'w': 'jump', 'arrowup': 'jump',
    'j': 'atkL',
    'k': 'atkH',
    'l': 'defend',
    'r': 'rematch',
    'escape': 'reset'
  };

  function key(e) { return (e.key || '').toLowerCase(); }

  window.addEventListener('keydown', (e) => {
    const act = MAP[key(e)];
    if (!act) return;
    e.preventDefault();
    if (!kbDown[act] && !tcDown[act]) tapped[act] = true; // 首次按下(任一源)
    kbDown[act] = true;
  });

  window.addEventListener('keyup', (e) => {
    const act = MAP[key(e)];
    if (act) kbDown[act] = false;
  });

  window.addEventListener('blur', () => {
    for (const k in kbDown) kbDown[k] = false;
    for (const k in tcDown) tcDown[k] = false;
  });

  return {
    // 某动作是否处于按下状态(键盘或触控任一)
    down: (act) => !!(kbDown[act] || tcDown[act]),
    // 消费"本次按下",仅按下那帧返回true
    tapped: (act) => {
      if (tapped[act]) { tapped[act] = false; return true; }
      return false;
    },
    clear: () => {
      for (const k in kbDown) kbDown[k] = false;
      for (const k in tcDown) tcDown[k] = false;
      for (const k in tapped) tapped[k] = false;
    },

    // ===== 触控注入接口(供 touch.js 调用) =====
    // 持续按住(移动/防御)
    touchDown(act) {
      if (!tcDown[act] && !kbDown[act]) tapped[act] = true;
      tcDown[act] = true;
    },
    touchUp(act) {
      tcDown[act] = false;
    },
    // 单次点击(攻击/跳跃/重置)
    touchTap(act) {
      tapped[act] = true;
    }
  };
})();
