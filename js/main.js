// main.js · 入口: 登录 + 大厅 + 房间等待 + 联机/离线模式切换 + HUD 同步
(function () {
  const canvas = document.getElementById('game');
  const game = new Game(canvas);

  // ===== DOM: 登录界面 =====
  const authScreen = document.getElementById('authScreen');
  const authLogin = document.getElementById('authLogin');
  const authRegister = document.getElementById('authRegister');
  const authStatusEl = document.getElementById('authStatus');
  const btnLogin = document.getElementById('btnLogin');
  const btnRegister = document.getElementById('btnRegister');
  const btnGuest = document.getElementById('btnGuest');
  const loginName = document.getElementById('loginName');
  const loginPass = document.getElementById('loginPass');
  const regName = document.getElementById('regName');
  const regPass = document.getElementById('regPass');
  const regPass2 = document.getElementById('regPass2');

  // ===== DOM: 大厅 =====
  const lobby = document.getElementById('lobby');
  const lobbyPlayerName = document.getElementById('lobbyPlayerName');
  const lobbyPlayerId = document.getElementById('lobbyPlayerId');
  const btnLogout = document.getElementById('btnLogout');
  const btnHost = document.getElementById('btnHost');
  const btnJoin = document.getElementById('btnJoin');
  const btnOffline = document.getElementById('btnOffline');
  const roomInput = document.getElementById('roomInput');
  const lobbyStatus = document.getElementById('lobbyStatus');
  const worldList = document.getElementById('worldList');
  const worldCount = document.getElementById('worldCount');
  const onlineHub = document.getElementById('onlineHub');
  const btnOpenOnline = document.getElementById('btnOpenOnline');
  const btnBackHub = document.getElementById('btnBackHub');
  const rulesBtn = document.getElementById('rulesBtn');
  const rulesPop = document.getElementById('rulesPop');
  const helpPop = document.getElementById('helpPop');

  // ===== DOM: 房间等待大厅 =====
  const roomLobby = document.getElementById('roomLobby');
  const roomLobbyCode = document.getElementById('roomLobbyCode');
  const roomModeTag = document.getElementById('roomModeTag');
  const slotP1Name = document.getElementById('slotP1Name');
  const slotP2Name = document.getElementById('slotP2Name');
  const slotP2Status = document.getElementById('slotP2Status');
  const btnShareWorld = document.getElementById('btnShareWorld');
  const btnRoomStart = document.getElementById('btnRoomStart');
  const btnRoomCancel = document.getElementById('btnRoomCancel');
  const roomLobbyStatus = document.getElementById('roomLobbyStatus');

  // ===== DOM: 玩法选择屏(早期声明, 避免下方启动时分派 showLobby/showAuthScreen 触发 TDZ) =====
  const modeSelect = document.getElementById('modeSelect');
  const btnModeBack = document.getElementById('btnModeBack');
  const btnModeAI = document.getElementById('btnModeAI');

  // ===== DOM: 联机玩法选择屏(早期声明, 避免切屏时 TDZ) =====
  const onlineModeSelect = document.getElementById('onlineModeSelect');
  const btnOnlineModeBack = document.getElementById('btnOnlineModeBack');
  const btnOnlineModePvP = document.getElementById('btnOnlineModePvP');
  const btnOnlineModeAIvAI = document.getElementById('btnOnlineModeAIvAI');

  // ===== DOM: AI 对战选风格屏(早期声明, 避免切屏时 TDZ) =====
  const aiPickScreen = document.getElementById('aiPickScreen');
  // [v136] 选风格屏顶部改用与对局相同的 top-cluster(延迟+模式+退出), 取代原 v130 的左上返回键
  const aiPickRtt = document.getElementById('aiPickRtt');
  const aiPickModeTag = document.getElementById('aiPickModeTag');
  const aiPickExitBtn = document.getElementById('aiPickExitBtn');
  const aiPresetGrid = document.getElementById('aiPresetGrid');
  const aiPickStatus = document.getElementById('aiPickStatus');
  const btnAIStart = document.getElementById('btnAIStart');
  let aiPickUiTimer = null; // 选风格屏顶栏(延迟/模式)的轻量刷新定时器, 离开时清理

  // ===== DOM: 游戏区 =====
  const gameWrap = document.getElementById('gameWrap');
  const elHpP1 = document.getElementById('hpP1');
  const elHpP2 = document.getElementById('hpP2');
  const elHpNumP1 = document.getElementById('hpNumP1');
  const elHpNumP2 = document.getElementById('hpNumP2');
  const elWinsP1 = document.getElementById('winsP1');
  const elWinsP2 = document.getElementById('winsP2');
  const elRound = document.getElementById('roundNum');
  const elTimer = document.getElementById('timer');
  const elNet = document.getElementById('netStatus');
  const rttTag = document.getElementById('rttTag');
  const roleP1 = document.getElementById('roleP1');
  const roleP2 = document.getElementById('roleP2');
  const hudP1Name = document.getElementById('hudP1Name');
  const hudP2Name = document.getElementById('hudP2Name');
  const overlay = document.getElementById('overlay');
  const ovTitle = document.getElementById('overlayTitle');
  const ovText = document.getElementById('overlayText');
  const startBtn = document.getElementById('startBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const modeTag = document.getElementById('gameModeTag');

  let exitConfirmMode = false;
  let currentPlayer = null; // {id, name}
  let isGuest = false;
  let sharedToWorld = false;
  // AI 对战观战模式状态
  let roomMode = 'pvp';      // 'pvp' | 'ai'
  let hostPickId = null;     // host 自己选的机甲 AI 风格
  let clientPickId = null;   // client 选的机甲 AI 风格(host 侧收集)
  let aiLocalPickId = null;  // 当前玩家(无论 host/client)选的风格
  let aiConfirmed = false;   // client 是否已把风格发给房主(用于按钮文案/可重选)
  let currentRoomCode = '';  // 当前房号(选风格屏返回等待大厅时需要)
  let peerName = '';         // 对手昵称(从选风格屏返回等待大厅时恢复 slot 显示)
  // [关键] 本机角色标记, 在发起建房/加入的【同一个同步语句块】里就置位。
  // 不能再用 game.mode 判断角色 —— btnJoin 里 game.setMode('client') 发生在 await 之后,
  // 而 Net 的 connected / aimode / aips 事件可能在 await 未 resolve 时就已触发,
  // 那一刻 game.mode 还是上一局的值, 导致 AI 消息被 `game.mode !== 'client'` 直接丢弃
  // (这正是「客户端始终进不去选风格屏」的根因)。
  let myRole = null;         // 'host' | 'client' | null

  function pct(hp) { return Math.max(0, Math.min(100, hp)) + '%'; }
  function fmtWins(w) {
    return '<span class="' + (w > 0 ? 'got' : '') + '">●</span> <span class="' + (w > 1 ? 'got' : '') + '">●</span>';
  }
  // 血量数字变动微小动画: 重启动画需先移除 class 并强制重排
  function pulseHp(el) {
    if (!el) return;
    el.classList.remove('hp-pulse');
    void el.offsetWidth;
    el.classList.add('hp-pulse');
  }
  let prevHpNum1 = -1, prevHpNum2 = -1;

  function updateHUD() {
    if (!game.p1 || !game.p2) return; // [BUG-FIX] 比赛开始前 p1/p2 为 null, 跳过避免每帧 TypeError
    elHpP1.style.width = pct(game.p1.hp);
    elHpP2.style.width = pct(game.p2.hp);
    // 血条下方 HP 数字: 四舍五入只保留整数(内部 HP 可为小数, 受击时显示整数)
    const hpNum1 = Math.round(game.p1.hp);
    const hpNum2 = Math.round(game.p2.hp);
    if (elHpNumP1) { elHpNumP1.textContent = hpNum1; if (hpNum1 !== prevHpNum1) { pulseHp(elHpNumP1); prevHpNum1 = hpNum1; } }
    if (elHpNumP2) { elHpNumP2.textContent = hpNum2; if (hpNum2 !== prevHpNum2) { pulseHp(elHpNumP2); prevHpNum2 = hpNum2; } }
    elWinsP1.innerHTML = fmtWins(game.winsP1);
    elWinsP2.innerHTML = fmtWins(game.winsP2);
    elRound.textContent = game.round;
    elTimer.textContent = game.timer;
    if (game.mode === 'offline') {
      elNet.textContent = ''; elNet.className = 'net-status';
    } else if (Net.isConnected()) {
      elNet.textContent = '●'; elNet.className = 'net-status on';
    } else {
      elNet.textContent = '●'; elNet.className = 'net-status off';
    }
    updateNetTags();
  }

  // [v136] 模式/延迟标签: 对局顶栏(#topCluster)与 AI 选风格屏顶栏(aiPickRtt/aiPickModeTag)共用同一套显示逻辑
  function updateNetTags() {
    const setMode = (el) => {
      if (!el) return;
      if (game.mode === 'offline') {
        el.textContent = '离线 vs AI';
      } else if (game.mode === 'host' || game.mode === 'aiHost') {
        const m = Net.getMode() === 'relay' ? '中继' : 'P2P';
        el.textContent = (game.mode === 'aiHost' ? 'AI房主 · ' : '主机 · ') + (Net.isConnected() ? m : m + ' 等待中');
      } else if (game.mode === 'client' || game.mode === 'aiClient') {
        const m = Net.getMode() === 'relay' ? '中继' : 'P2P';
        el.textContent = (game.mode === 'aiClient' ? 'AI观战 · ' : '客户端 · ') + (Net.isConnected() ? m : m + ' 重连中');
      }
    };
    setMode(modeTag);
    setMode(aiPickModeTag);
    const setRtt = (el) => {
      if (!el) return;
      if (game.mode === 'offline') { el.textContent = '本地'; el.className = 'rtt-tag'; return; }
      const r = Net.getRtt();
      if (r > 0) { el.textContent = '延迟 ' + r + 'ms'; el.className = 'rtt-tag ' + (r < 80 ? 'good' : r < 150 ? 'ok' : 'bad'); }
      else { el.textContent = '测速中…'; el.className = 'rtt-tag'; }
    };
    setRtt(rttTag);
    setRtt(aiPickRtt);
  }

  // ===== 登录界面逻辑 =====
  function showAuthScreen() {
    authScreen.classList.remove('hidden');
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    onlineHub.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.add('hidden');
    leaveGame();
  }
  function showLobby() {
    authScreen.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    onlineHub.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.add('hidden');
    leaveGame();
    lobby.classList.remove('hidden');
    if (currentPlayer) {
      lobbyPlayerName.textContent = currentPlayer.name;
      lobbyPlayerId.textContent = currentPlayer.id;
    }
    // 初始化世界频道
    World.init();
    World.onUpdate(renderWorldList);
  }
  function showOnlineHub() {
    authScreen.classList.add('hidden');
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.add('hidden');
    onlineHub.classList.remove('hidden');
    leaveGame();
  }

  function showModeSelect() {
    authScreen.classList.add('hidden');
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    onlineHub.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.add('hidden');
    modeSelect.classList.remove('hidden');
    leaveGame();
  }

  function showOnlineModeSelect() {
    authScreen.classList.add('hidden');
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    onlineHub.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.remove('hidden');
    leaveGame();
  }

  // AI 对战选风格屏: host 与 client 都会进这个屏, 各自选自家机甲 AI 风格
  function showAIPickScreen() {
    authScreen.classList.add('hidden');
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    onlineHub.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.remove('hidden');
    document.body.classList.add('ai-pick');   // [v136] 隐藏常驻边缘条, 顶栏切换为与对局相同的布局
    document.body.classList.add('ai-spectate'); // AI 观战(含选风格阶段): 隐藏触控操作键
    leaveGame();
    hideOverlay();
    renderAIPresets();
    aiLocalPickId = null;
    aiConfirmed = false;
    // [v136] 选风格屏顶栏(延迟/模式)实时刷新, 离开时清理定时器
    clearInterval(aiPickUiTimer);
    aiPickUiTimer = setInterval(updateNetTags, 1000);
    updateNetTags();
    updateAIPickStatus(); // 文案与可点状态统一由此函数决定, 不再在这里写死
  }

  function authErr(msg) {
    authStatusEl.textContent = msg;
    authStatusEl.className = 'auth-status';
  }
  function authOk(msg) {
    authStatusEl.textContent = msg;
    authStatusEl.className = 'auth-status ok';
  }

  // 登录/注册标签切换
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      authLogin.classList.toggle('hidden', !isLogin);
      authRegister.classList.toggle('hidden', isLogin);
      authErr('');
    });
  });

  btnLogin.addEventListener('click', () => {
    const name = loginName.value.trim();
    const pass = loginPass.value;
    if (!name || !pass) { authErr('请填写用户名和密码'); return; }
    const r = Auth.login(name, pass);
    if (r.ok) {
      currentPlayer = r.data;
      authOk('登录成功!');
      setTimeout(showLobby, 500);
    } else {
      authErr(r.err);
    }
  });
  loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnLogin.click(); });

  btnRegister.addEventListener('click', () => {
    const name = regName.value.trim();
    const pass = regPass.value;
    const pass2 = regPass2.value;
    if (!name || !pass) { authErr('请填写用户名和密码'); return; }
    if (pass !== pass2) { authErr('两次密码不一致'); return; }
    const r = Auth.register(name, pass);
    if (r.ok) {
      currentPlayer = r.data;
      authOk('注册成功! ID: ' + r.data.id);
      Auth.login(name, pass); // 自动登录
      setTimeout(showLobby, 800);
    } else {
      authErr(r.err);
    }
  });
  regPass2.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnRegister.click(); });

  // 游客模式: 同一设备(同一浏览器)固定一个游客账号, 不每次随机
  const KEY_GUEST_ID = 'pma_guest_id';
  btnGuest.addEventListener('click', () => {
    isGuest = true;
    let gid = null;
    try { gid = localStorage.getItem(KEY_GUEST_ID); } catch (e) {}
    if (!gid) {
      gid = 'GUEST-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      try { localStorage.setItem(KEY_GUEST_ID, gid); } catch (e) {}
    }
    currentPlayer = { id: gid, name: '游客' };
    showLobby();
  });

  btnLogout.addEventListener('click', () => {
    Auth.logout();
    currentPlayer = null;
    isGuest = false;
    World.close();
    showAuthScreen();
    loginName.value = ''; loginPass.value = '';
    regName.value = ''; regPass.value = ''; regPass2.value = '';
    authErr('');
  });

  // 启动时检查已登录会话
  const savedUser = Auth.currentUser();
  if (savedUser) {
    currentPlayer = savedUser;
    showLobby();
  } else {
    showAuthScreen();
  }

  // ===== 世界频道渲染 =====
  function renderWorldList(rooms) {
    if (!rooms || rooms.length === 0) {
      worldList.innerHTML = '<div class="world-empty">暂无公开房间<br>创建房间后可分享到世界</div>';
      worldCount.textContent = '0 个房间';
      return;
    }
    worldCount.textContent = rooms.length + ' 个房间';
    worldList.innerHTML = rooms.map(r => {
      const ago = Math.floor((Date.now() - r.ts) / 1000);
      const timeStr = ago < 60 ? ago + 's前' : Math.floor(ago / 60) + 'm前';
      return '<div class="world-item" data-code="' + r.roomCode + '">' +
        '<div class="world-item-top">' +
          '<span class="world-item-code">' + r.roomCode + '</span>' +
          '<span class="world-item-mode">' + (r.mode || 'P2P') + '</span>' +
        '</div>' +
        '<div class="world-item-name">' + (r.playerName || '玩家') + '</div>' +
        '<div class="world-item-time">' + timeStr + '</div>' +
      '</div>';
    }).join('');
    // 绑定点击加入
    worldList.querySelectorAll('.world-item').forEach(el => {
      el.addEventListener('click', () => {
        const code = el.dataset.code;
        roomInput.value = code;
        btnJoin.click();
      });
    });
  }

  // ===== 房间等待大厅 =====
  // opts.keepState=true 时不重置对手槽位/分享状态(用于从选风格屏返回, 此时连接与对手都还在)
  function showRoomLobby(code, opts) {
    opts = opts || {};
    currentRoomCode = code;
    document.body.classList.remove('ai-pick');      // 退出 AI 选风格屏: 恢复常驻边缘条与对局顶栏布局
    document.body.classList.remove('ai-spectate'); // 退出 AI 选风格屏返回等待大厅: 恢复触控键
    clearInterval(aiPickUiTimer); aiPickUiTimer = null;
    lobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    onlineHub.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.add('hidden');
    roomLobby.classList.remove('hidden');
    leaveGame();
    roomLobbyCode.textContent = code;
    slotP1Name.textContent = currentPlayer ? currentPlayer.name : '玩家';
    // 等待大厅标明本房玩法, 避免创建后不知道自己开的是哪种房
    if (roomModeTag) {
      roomModeTag.textContent = roomMode === 'ai' ? '🤖 AI 对战 · 观战 BO3' : '⚔️ 双人对战 · 1v1';
      roomModeTag.className = 'room-mode-tag' + (roomMode === 'ai' ? ' ai' : '');
    }
    // 开始键文案: AI 对战房点了先进选风格屏, 而不是直接开打
    btnRoomStart.textContent = roomMode === 'ai' ? '进入选风格' : '开始对战';
    if (opts.keepState) {
      // 从选风格屏返回: 对手仍在房内, 恢复"已就绪"并保留开始键
      markPeerJoined(peerName || '对手');
      return;
    }
    slotP2Name.innerHTML = '等待中' + loadingDots();
    slotP2Status.textContent = '等待加入';
    slotP2Status.className = 'slot-status';
    btnRoomStart.classList.add('hidden');
    sharedToWorld = false;
    btnShareWorld.classList.remove('shared');
    btnShareWorld.textContent = '分享到世界';
  }
  // 对手加入后的等待大厅状态(connected 事件与"从选风格屏返回"共用)
  function markPeerJoined(oppName) {
    peerName = oppName;
    slotP2Name.textContent = oppName;
    slotP2Status.textContent = '已就绪';
    slotP2Status.className = 'slot-status ready';
    btnRoomStart.classList.remove('hidden');
    roomLobbyStatus.textContent = roomMode === 'ai'
      ? '对手 ' + oppName + ' 已加入! 点击进入选风格'
      : '对手 ' + oppName + ' 已加入! 点击开始对战';
    hudP2Name.textContent = oppName;
  }
  function hideRoomLobby() {
    roomLobby.classList.add('hidden');
    // 停止世界分享
    if (sharedToWorld) {
      const code = roomLobbyCode.textContent;
      World.stopShare(code);
      sharedToWorld = false;
    }
  }

  // 分享到世界: 点击即分享(重复点击=刷新分享时间), 2 秒后按钮自动恢复默认状态可再次点击
  let shareCooldown = false;
  btnShareWorld.addEventListener('click', () => {
    if (shareCooldown) return; // 冷却期内直接忽略
    const code = roomLobbyCode.textContent;
    World.shareRoom(code, currentPlayer ? currentPlayer.name : '玩家', currentPlayer ? currentPlayer.id : '', Net.getMode() === 'relay' ? '中继' : 'P2P');
    sharedToWorld = true; // 退出房间时据此 stopShare
    btnShareWorld.classList.add('shared');
    // 点击反馈统一显示"已分享", 恢复后的空闲文案按是否已分享过区分: 首次=分享到世界, 之后=再次分享到世界
    btnShareWorld.textContent = '已分享 ✓';
    roomLobbyStatus.textContent = '房间已分享到世界频道';
    shareCooldown = true;
    btnShareWorld.disabled = true;
    setTimeout(() => {
      shareCooldown = false;
      btnShareWorld.disabled = false;
      btnShareWorld.classList.remove('shared');
      btnShareWorld.textContent = sharedToWorld ? '再次分享到世界' : '分享到世界';
    }, 2000);
  });

  // 房间开始/取消
  btnRoomStart.addEventListener('click', () => {
    // AI 对战房: 这一步不是开打, 而是双方一起进选风格屏
    if (roomMode === 'ai') {
      hostPickId = null; clientPickId = null;
      // 中继通道偶发丢包/晚到, 单发一次 aips 有概率对方收不到就永远卡在等待。
      // 消息本身幂等(client 已在选风格屏则忽略), 故补发两次做冗余。
      Net.sendAiPickStart();
      setTimeout(() => { if (Net.isConnected()) Net.sendAiPickStart(); }, 500);
      setTimeout(() => { if (Net.isConnected()) Net.sendAiPickStart(); }, 1500);
      showAIPickScreen();
      return;
    }
    Net.sendStart(); // 通知 client 开始
    showGame();
    game.resetMatch();
    game.start();
  });
  btnRoomCancel.addEventListener('click', () => {
    roomMode = 'pvp'; // 复位玩法, 否则下次开 PvP 房仍显示 AI 标签
    hostPickId = null; clientPickId = null; aiLocalPickId = null; aiConfirmed = false;
    myRole = null;
    hideRoomLobby();
    btnShareWorld.textContent = '分享到世界'; // 离开房间后, 下次分享重新从"分享到世界"开始
    btnShareWorld.classList.remove('shared');
    Net.close();
    // 关键修复: 返回大厅时必须解除创建/加入按钮的禁用, 否则 btnHost 会一直被锁死(创建房间后无法再次创建)
    btnHost.disabled = false;
    btnJoin.disabled = false;
    showLobby();
    setStatus('');
  });

  // ===== 游戏区显示/隐藏 =====
  function showGame() {
    document.body.classList.remove('ai-pick');
    clearInterval(aiPickUiTimer); aiPickUiTimer = null;
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    onlineHub.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.add('hidden');
    gameWrap.classList.remove('hidden');
    document.body.classList.add('in-game'); // CSS 切换: 隐藏 persistEdge, topCluster 升为顶栏
  }
  function leaveGame() {
    document.body.classList.remove('in-game');
  }
  function showOverlay(title, text, btn, opts) {
    opts = opts || {};
    overlay.classList.remove('hidden');
    ovTitle.textContent = title;
    ovText.textContent = text || '';
    startBtn.textContent = btn || '开始';
    startBtn.style.display = btn ? 'inline-block' : 'none';
    cancelBtn.classList.toggle('hidden', !opts.cancelable);
    cancelBtn.textContent = opts.cancelLabel || '返回大厅';
  }
  function hideOverlay() { overlay.classList.add('hidden'); }

  function backToLobby() {
    resetRematchState();
    document.body.classList.remove('ai-pick');      // 退出 AI 观战: 恢复常驻边缘条与对局顶栏布局
    document.body.classList.remove('ai-spectate'); // 退出 AI 观战: 恢复触控操作键
    clearInterval(aiPickUiTimer); aiPickUiTimer = null;
    roomMode = 'pvp'; // 复位玩法与 AI 选择, 防止状态泄漏到下一个房间
    hostPickId = null; clientPickId = null; aiLocalPickId = null; aiConfirmed = false;
    myRole = null;
    exitConfirmMode = false; // 复位, 防止退出确认状态泄漏导致退出键失效
    game.stop();
    Net.close();
    hideRoomLobby();
    gameWrap.classList.add('hidden');
    modeSelect.classList.add('hidden');
    onlineModeSelect.classList.add('hidden');
    aiPickScreen.classList.add('hidden');
    leaveGame();
    lobby.classList.remove('hidden');
    Input.clear();
    btnHost.disabled = false;
    btnJoin.disabled = false;
    if (currentPlayer) {
      lobbyPlayerName.textContent = currentPlayer.name;
      lobbyPlayerId.textContent = currentPlayer.id;
    }
  }
  // 加载中动画省略号: 3 个圆点依次跳起, 加载完成/失败时元素被替换即停
  function loadingDots() {
    return '<span class="loading-dots"><span></span><span></span><span></span></span>';
  }
  function setStatus(msg, isErr) {
    // 用 innerHTML 以支持 loadingDots() 等内嵌 HTML; 内容来自内部固定字符串或错误对象, 安全
    const html = msg || '';
    lobbyStatus.innerHTML = html;
    lobbyStatus.className = 'lobby-status' + (isErr ? ' err' : '');
    roomLobbyStatus.innerHTML = html;
  }

  // ===== 联机"再来一局": 双方确认 + 超时自动回大厅 =====
  const REMATCH_TIMEOUT = 15; // 秒
  let rmLocal = false, rmRemote = false, rmTimer = null, rmDeadline = 0, rmChamp = '';
  function resetRematchState() {
    rmLocal = false; rmRemote = false;
    if (rmTimer) { clearInterval(rmTimer); rmTimer = null; }
  }
  function renderRematchOverlay() {
    const n = (rmLocal ? 1 : 0) + (rmRemote ? 1 : 0);
    const secs = Math.max(0, Math.ceil((rmDeadline - Date.now()) / 1000));
    let txt = rmChamp + '\n\n再来一局 ' + n + '/2';
    if (rmLocal && !rmRemote) txt += '\n已确认, 等待对方...';
    if (!rmLocal && rmRemote) txt += '\n对方想再来一局!';
    txt += '\n' + secs + ' 秒后自动返回大厅';
    showOverlay('比赛结束', txt, rmLocal ? '' : '再来一局');
  }
  function startRematchFlow(champ) {
    // 只重置本地确认与计时; rmRemote 保留(对方的确认可能比本机进入结算画面更早到达)
    rmLocal = false;
    if (rmTimer) clearInterval(rmTimer);
    rmChamp = champ;
    rmDeadline = Date.now() + REMATCH_TIMEOUT * 1000;
    renderRematchOverlay();
    rmTimer = setInterval(() => {
      if (game.state !== 'matchEnd') { resetRematchState(); return; }
      if (Date.now() >= rmDeadline) {
        resetRematchState();
        Net.sendBye();
        backToLobby();
        setStatus('等待超时, 已自动返回大厅');
        return;
      }
      renderRematchOverlay();
    }, 300);
  }
  function rematchVote() {
    if (rmLocal) return;
    rmLocal = true;
    Net.sendRematchReady();
    renderRematchOverlay();
    checkRematchGo();
  }
  function checkRematchGo() {
    if (!(rmLocal && rmRemote)) return;
    resetRematchState();
    if (game.mode === 'host' || game.mode === 'aiHost') {
      Net.sendReset(); // 通知客户端同步重开
      game.resetMatch();
      game.start();
      hideOverlay();
    } else {
      showOverlay('再来一局', '双方已确认\n等待主机开局...', '');
    }
  }

  // ===== 游戏状态回调 =====
  game.onStateChange = (s) => {
    if (s === 'ready' || s === 'fight') { hideOverlay(); resetRematchState(); }
    else if (s === 'matchEnd') {
      const champ = game.winsP1 >= 2 ? (hudP1Name.textContent + ' 获胜') : (hudP2Name.textContent + ' 获胜');
      if (game.mode === 'offline') {
        // 移动端没有键盘, 不显示 R/ESC 提示; 加返回大厅按钮(移动端无 ESC)
        const hint = IS_TOUCH_UI ? '' : '\n\n按 R 重开对局\n按 ESC 返回大厅';
        showOverlay('比赛结束', champ + hint, '再来一局', { cancelable: true, cancelLabel: '返回大厅' });
      } else {
        // 联机: 双方确认后才重开, 超时自动回大厅
        startRematchFlow(champ);
      }
    }
  };

  game.onNetEvent = (ev) => {
    if (ev === 'leave') {
      Net.sendBye();
      backToLobby();
      setStatus('已返回大厅');
    } else if (ev === 'rematch') {
      if (game.mode === 'offline') {
        game.resetMatch(); game.start();
        showOverlay('重开对局', '已重新开始', '', { cancelable: true, cancelLabel: '继续' });
        setTimeout(hideOverlay, 1000);
      } else if (game.state === 'matchEnd') {
        // 联机结算画面按 R = 投一票"再来一局"(需双方确认)
        rematchVote();
      } else if (game.mode === 'host') {
        Net.sendReset(); game.resetMatch(); game.start();
        showOverlay('重开对局', '已重新开始\n双方状态已同步', '', { cancelable: true, cancelLabel: '继续' });
        setTimeout(hideOverlay, 1200);
      } else if (game.mode === 'client') {
        Net.sendReset();
        showOverlay('重开对局', '已请求主机重开\n等待响应...', '', { cancelable: true, cancelLabel: '继续' });
        setTimeout(() => { if (!overlay.classList.contains('hidden')) hideOverlay(); }, 3000);
      }
    }
  };

  // 开始/再来一局按钮(只绑 click: 移动端无 300ms 延迟, 且保证 :active 反馈与单次触发)
  const onStart = (e) => {
    e.preventDefault();
    if (exitConfirmMode) {
      exitConfirmMode = false;
      if (game.onNetEvent) game.onNetEvent('leave');
      return;
    }
    // 联机模式结算画面: "再来一局"改为双方确认制
    if (game.state === 'matchEnd' && game.mode !== 'offline') { rematchVote(); return; }
    if (game.state === 'matchEnd' || game.state === 'ready') game.resetMatch();
  };
  startBtn.addEventListener('click', onStart);

  // 退出按钮
  const onExit = (e) => {
    e.preventDefault();
    if (exitConfirmMode) return;
    exitConfirmMode = true;
    game.stop(); // 所有模式暂停对局, 防止确认期间被攻击(硬约束)
    showOverlay('退出游戏', '确定要离开当前房间?\n\n将返回大厅,对手会断开', '确认退出',
      { cancelable: true, cancelLabel: '继续游戏' });
  };

  // 移动端独立退出按钮(复用 onExit 逻辑, 弹确认对话框并暂停游戏)
  const exitMobileBtn = document.getElementById('exitMobileBtn');
  if (exitMobileBtn) exitMobileBtn.addEventListener('click', onExit);

  // ===== 大厅按钮 =====
  // 单人模式入口 → 改为进入「选择玩法」屏, 由屏内按钮再决定具体模式
  btnOffline.addEventListener('click', () => {
    showModeSelect();
  });

  // 玩法选择屏: 返回 / 人机模式
  if (btnModeBack) btnModeBack.addEventListener('click', () => { showLobby(); });
  if (btnModeAI) btnModeAI.addEventListener('click', () => {
    setStatus('加载中' + loadingDots());
    game.setMode('offline');
    roleP1.textContent = '玩家';
    roleP2.textContent = 'AI';
    hudP1Name.textContent = currentPlayer ? currentPlayer.name : 'BLUE-01';
    hudP2Name.textContent = 'RED-X';
    showGame();
    game.resetMatch();
    game.start();
    setStatus('');
  });

  // Hub → 联机大厅 / 返回 Hub
  if (btnOpenOnline) btnOpenOnline.addEventListener('click', () => { showOnlineHub(); });
  if (btnBackHub) btnBackHub.addEventListener('click', () => { showLobby(); });

  btnHost.addEventListener('click', () => showOnlineModeSelect());

  if (btnOnlineModeBack) btnOnlineModeBack.addEventListener('click', () => { showOnlineHub(); });
  if (btnOnlineModePvP) btnOnlineModePvP.addEventListener('click', () => {
    btnOnlineModePvP.disabled = true;
    roomMode = 'pvp';
    startHost('pvp').finally(() => { btnOnlineModePvP.disabled = false; });
  });
  if (btnOnlineModeAIvAI) btnOnlineModeAIvAI.addEventListener('click', () => {
    btnOnlineModeAIvAI.disabled = true;
    roomMode = 'ai';
    startHost('ai').finally(() => { btnOnlineModeAIvAI.disabled = false; });
  });
  if (aiPickExitBtn) aiPickExitBtn.addEventListener('click', () => {
    // host: 返回 = 退回等待大厅(房间与连接都保留, 可以反悔重选), 并通知 client 一起退回等待
    if (myRole === 'host' && Net.isConnected()) {
      hostPickId = null; clientPickId = null; aiLocalPickId = null; aiConfirmed = false;
      Net.sendAiCancel();
      showRoomLobby(currentRoomCode, { keepState: true });
      roomLobbyStatus.textContent = '已返回等待大厅, 可重新进入选风格';
      return;
    }
    // client: 返回 = 退回等待大厅(保留连接, 不退出房间, 与等待大厅「返回大厅」一致)
    // 这样 client 在 AI 选风格屏卡住时也能像等待大厅一样「返回大厅」, 等房主重新进入选风格
    if (Net.isConnected()) {
      hostPickId = null; clientPickId = null; aiLocalPickId = null; aiConfirmed = false;
      Net.sendAiCancel(); // 通知房主: 我退回等待大厅了(房主侧同步退回选风格屏)
      showRoomLobby(Net.getRoomCode(), { keepState: true });
      roomLobbyStatus.textContent = '已返回等待大厅, 等待房主重新进入选风格';
      return;
    }
    // 完全断线(极少): 退到联机大厅
    Net.close();
    btnHost.disabled = false; btnJoin.disabled = false;
    hostPickId = null; clientPickId = null; aiLocalPickId = null; aiConfirmed = false;
    roomMode = 'pvp'; myRole = null;
    showOnlineHub();
  });
  if (btnAIStart) btnAIStart.addEventListener('click', () => {
    if (myRole === 'host') {
      // 房主还没选自己的风格 -> 先提示, 不再是"点了没反应"
      if (!hostPickId) { aiPickStatus.textContent = '请先选一个你的机甲风格'; return; }
      if (!clientPickId) { aiPickStatus.textContent = '还在等对手确认风格...'; return; }
      startAIMatch();
      return;
    }
    // client: 确认 / 重选(允许反复改, 房主以最后一次为准)
    if (!aiLocalPickId) { aiPickStatus.textContent = '请先选一个你的机甲风格'; return; }
    Net.sendAiPick(aiLocalPickId);
    aiConfirmed = true;
    updateAIPickStatus();
  });

  // ===== AI 对战: 选风格逻辑 =====
  // 渲染 6 个风格卡片(由全局 AI_PRESETS 生成, 与游戏内定义保持单一来源)
  function renderAIPresets() {
    if (!aiPresetGrid) return;
    aiPresetGrid.innerHTML = '';
    AI_PRESET_LIST.forEach((id) => {
      const p = AI_PRESETS[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-preset-card';
      btn.dataset.id = id;
      btn.innerHTML = '<div class="ai-preset-emoji">' + p.emoji + '</div>' +
                      '<div class="ai-preset-name">' + p.name + '</div>' +
                      '<div class="ai-preset-desc">' + p.desc + '</div>';
      btn.addEventListener('click', () => selectAIPreset(id));
      aiPresetGrid.appendChild(btn);
    });
  }
  function selectAIPreset(id) {
    aiLocalPickId = id;
    aiConfirmed = false; // 改选后需要重新确认
    if (aiPresetGrid) {
      Array.prototype.forEach.call(aiPresetGrid.children, (c) => {
        c.classList.toggle('selected', c.dataset.id === id);
      });
    }
    if (myRole === 'host') hostPickId = id;
    updateAIPickStatus();
  }
  // 按钮永远可点(不再用 disabled 静默吞点击, 那正是"点了没反应"的观感来源),
  // 点击后按当前缺什么给出明确文字提示。
  function updateAIPickStatus() {
    if (!aiPickStatus || !btnAIStart) return;
    const myName = (aiLocalPickId && AI_PRESETS[aiLocalPickId]) ? AI_PRESETS[aiLocalPickId].name : '未选';
    btnAIStart.disabled = false;
    if (myRole === 'host') {
      const opp = (clientPickId && AI_PRESETS[clientPickId]) ? AI_PRESETS[clientPickId].name : '等待对手确认...';
      aiPickStatus.textContent = '你的AI: ' + myName + ' ｜ 对手AI: ' + opp;
      btnAIStart.textContent = (hostPickId && clientPickId) ? '开始对战' : '等待双方选定';
      btnAIStart.classList.toggle('waiting', !(hostPickId && clientPickId));
    } else {
      aiPickStatus.textContent = '你的AI: ' + myName +
        (aiConfirmed ? ' ｜ 已确认, 等待房主开打' : (aiLocalPickId ? ' ｜ 点下方确认' : ' ｜ 请选择一个风格'));
      btnAIStart.textContent = aiConfirmed ? '已确认 ✓ 点击可重发' : '确认风格';
      btnAIStart.classList.toggle('waiting', !aiLocalPickId);
    }
  }
  function startAIMatch() {
    game.setMode('aiHost');
    document.body.classList.add('ai-spectate'); // AI 观战: 隐藏触控操作键
    game.setAIPresets(hostPickId, clientPickId);
    roleP1.textContent = '你的AI';
    roleP2.textContent = '对手AI';
    const hp1 = (AI_PRESETS[hostPickId] || AI_PRESETS.balanced).name;
    const hp2 = (AI_PRESETS[clientPickId] || AI_PRESETS.balanced).name;
    hudP1Name.textContent = '你的AI·' + hp1;
    hudP2Name.textContent = '对手AI·' + hp2;
    Net.sendAiStart({ p1: hostPickId, p2: clientPickId });
    showGame();
    game.resetMatch();
    game.start();
  }

  async function startHost(modeArg) {
    setStatus('正在创建房间' + loadingDots());
    myRole = 'host'; // 同步置位: 必须早于任何 await, 否则连上瞬间的事件判不出角色
    aiConfirmed = false;
    btnHost.disabled = true;
    Net.setName(currentPlayer ? currentPlayer.name : '玩家');
    bindNetEvents(); // 先绑定事件, 再连接
    try {
      const code = await Net.hostRoom();
      game.setMode('host');
      // [v115 修正] 两种玩法都先进等待大厅显示房号 —— AI 对战原先直接跳选风格屏,
      // 导致房号根本不露面, 对手无从加入(用户实测"根本没法联机"的根因)
      roleP1.textContent = roomMode === 'ai' ? '你的AI' : '你';
      roleP2.textContent = roomMode === 'ai' ? '对手AI' : '对手';
      hudP1Name.textContent = currentPlayer ? currentPlayer.name : 'BLUE-01';
      showRoomLobby(code);
      const mode = Net.getMode() === 'relay' ? '中继' : 'P2P';
      setStatus('房号: ' + code + ' (' + mode + ')<br>等待对手加入' + loadingDots());
    } catch (e) {
      setStatus('创建失败: ' + (e.message || e), true);
      btnHost.disabled = false;
    }
  }

  // 返回大厅/取消(只绑 click)
  const onCancel = (e) => {
    e.preventDefault();
    if (exitConfirmMode) {
      exitConfirmMode = false;
      hideOverlay();
      game.start(); // 所有模式恢复对局
      return;
    }
    backToLobby();
    setStatus('');
  };
  cancelBtn.addEventListener('click', onCancel);

  btnJoin.addEventListener('click', async () => {
    const code = (roomInput.value || '').trim();
    if (!/^\d{6}$/.test(code)) { setStatus('请输入 6 位数字房号', true); return; }
    setStatus('正在连接 ' + code + loadingDots());
    myRole = 'client'; // 同步置位: game.setMode('client') 在 await 之后才执行, 太晚了
    aiConfirmed = false;
    btnJoin.disabled = true;
    Net.setName(currentPlayer ? currentPlayer.name : '玩家');
    bindNetEvents(); // 先绑定事件, 再连接
    try {
      await Net.joinRoom(code);
      game.setMode('client');
      roleP1.textContent = '对手';
      roleP2.textContent = '你';
      hudP2Name.textContent = currentPlayer ? currentPlayer.name : 'RED-X';
      showGame();
      // [修复] 客户端加入后【不】立即开局: 只摆好初始阵型渲染一帧静态竞技场,
      // 真正开始必须等房主点「开始对战」后发来的 start 信号 —— 否则会出现
      // 「客户端自己直接进地图、房主却卡在等待大厅」的错位(原代码这里 game.start() 是元凶)
      game.resetMatch();
      game.state = 'fight'; // 等待期间静态渲染, 不显示 READY?/倒计时
      game.draw();
      const mode = Net.getMode() === 'relay' ? '中继' : 'P2P';
      setStatus('已加入房间 ' + code + ' (' + mode + ')');
      showOverlay('已连接', '模式: ' + mode + '\n等待主机开始...', '');
    } catch (e) {
      setStatus('加入失败: ' + (e.message || e), true);
      btnJoin.disabled = false;
    }
  });

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });

  // ===== 联机事件绑定 =====
  let netBound = false;
  let reconnectDeadline = null;
  let reconnecting = false;
  function clearReconnect() {
    if (reconnectDeadline) { clearTimeout(reconnectDeadline); reconnectDeadline = null; }
    reconnecting = false;
  }
  function bindNetEvents() {
    if (netBound) return;
    netBound = true;
    Net.on('connected', (data) => {
      // data.name 是对方发来的名字
      const oppName = (data && data.name) ? data.name : '对手';
      if (reconnecting) {
        clearReconnect();
        hideOverlay();
        if (game.mode === 'host' && game.running) { game.resetMatch(); game.start(); }
        return;
      }
      // host: 对手已加入, 显示开始按钮
      if (myRole === 'host') {
        // AI 对战房: 先告知 client 房间玩法(client 仅更新等待提示, 真正进选风格屏要等 host 点「进入选风格」)
        // 补发一次: client 的 showOverlay('已连接'...) 在 await 之后执行, 会盖掉先到的 AI 房提示
        if (roomMode === 'ai' && !game.running) {
          Net.sendAiMode();
          setTimeout(() => { if (Net.isConnected() && roomMode === 'ai' && !game.running) Net.sendAiMode(); }, 900);
        }
        markPeerJoined(oppName);
      } else {
        // client: 显示对手名字, 等待 host 发 start 信号
        hudP1Name.textContent = oppName;
        slotP1Name.textContent = oppName;
      }
    });
    // host 发来 start 信号: client 开始对战
    Net.on('start', () => {
      if (game.mode === 'client') {
        hideOverlay();
        showGame();
        game.resetMatch();
        game.start();
      }
    });
    // ===== AI 对战专用事件 =====
    Net.on('aimode', () => {
      // client 收到: 本房是 AI 对战房 —— 仅更新等待提示, 真正进选风格屏要等 host 发 aipickstart
      if (myRole !== 'client') return;
      roomMode = 'ai';
      document.body.classList.add('ai-spectate'); // [v136] 等待房主选风格阶段即隐藏触控操作键(观战前奏)
      if (game.running) return; // 已在局内(已选风格开打), 不再弹"等待房主选风格"遮罩
      if (!aiPickScreen.classList.contains('hidden')) return; // 已在选风格屏则不打断
      showOverlay('已连接', '🤖 AI 对战房\n等待房主开始选风格...', '');
    });
    Net.on('aipickstart', () => {
      // host 已点「进入选风格」: client 同步进选风格屏。房主会补发 2 次做冗余, 这里保持幂等
      if (myRole !== 'client') return;
      roomMode = 'ai';
      if (!aiPickScreen.classList.contains('hidden')) return; // 已进屏, 忽略重复的 aips
      showAIPickScreen();
    });
    Net.on('aicancel', () => {
      // host 从选风格屏返回了等待大厅: client 也退回等待状态
      if (myRole !== 'client') return;
      if (game.running) return; // 已在局内, 房主反悔不应打断对局
      aiLocalPickId = null; aiConfirmed = false;
      showGame();
      showOverlay('已连接', '🤖 AI 对战房\n房主返回了等待大厅...', '');
    });
    Net.on('aipick', (id) => {
      // host 收到 client 选的风格(client 可重选, 以最后一次为准)
      if (myRole !== 'host' || roomMode !== 'ai') return;
      clientPickId = id || 'balanced';
      updateAIPickStatus();
    });
    Net.on('aistart', (cfg) => {
      // client 收到: 双方风格下发, 开始观战对打
      if (myRole !== 'client' || roomMode !== 'ai') return;
      game.setMode('aiClient');
      document.body.classList.add('ai-spectate'); // AI 观战: 隐藏触控操作键
      game.setAIPresets(cfg.p1, cfg.p2);
      roleP1.textContent = '对手AI';
      roleP2.textContent = '你的AI';
      const hp1 = (AI_PRESETS[cfg.p1] || AI_PRESETS.balanced).name;
      const hp2 = (AI_PRESETS[cfg.p2] || AI_PRESETS.balanced).name;
      hudP1Name.textContent = '对手AI·' + hp1;
      hudP2Name.textContent = '你的AI·' + hp2;
      hideOverlay();
      showGame();
      game.resetMatch();
      game.start();
    });
    Net.on('state', (s) => {
      if (game.mode === 'client') game.applyRemoteState(s);
      else if (game.mode === 'aiClient') game.applySpectateState(s);
    });
    Net.on('input', (c) => {
      if (game.mode === 'host') game.applyRemoteInput(c);
    });
    Net.on('progress', (msg) => {
      const cur = ovText.textContent || '';
      const lines = cur.split('\n').filter(l => !l.startsWith('['));
      ovText.textContent = lines.join('\n') + '\n[' + msg + ']';
    });
    Net.on('close', () => {
      if (reconnecting) return;
      reconnecting = true;
      exitConfirmMode = false;
      showOverlay('重连中', '网络短暂中断,正在自动恢复...\n\n若 6 秒内未恢复请返回大厅', '',
        { cancelable: true, cancelLabel: '返回大厅' });
      reconnectDeadline = setTimeout(() => {
        showOverlay('连接断开', '对手已离开或网络持续中断\n\n点下方返回大厅', '',
          { cancelable: true, cancelLabel: '返回大厅' });
      }, 6000);
    });
    Net.on('error', () => { setStatus('网络错误,请重试', true); });

    Net.on('reset', () => {
      if (game.mode === 'client' || game.mode === 'aiClient') {
        resetRematchState();
        game.interp.foeHasTarget = false;
        game.resetMatch(); game.start();
        showOverlay('对局开始', '双方状态已同步', '', { cancelable: true, cancelLabel: '继续' });
        setTimeout(hideOverlay, 1000);
      }
    });
    // 对方点了"再来一局"(双方确认制)
    Net.on('rematchReady', () => {
      rmRemote = true;
      if (game.state === 'matchEnd') {
        renderRematchOverlay();
        checkRematchGo();
      }
    });
  }

  // ===== 更新公告: 点击版本号显示近三次更新(倒序: 最新在前; 每条用短句概括改动, 一点一换行; 每次发版须 prepend 一条真实版本) =====
  // 文案规则: 每条不超过 30 字, 一条一个圆点, 折行不再出点(见 .cl-pt 悬挂缩进)
  const CHANGELOG = [
    ['v136', [
      '修分享到世界后客户端首次加入偶发失败',
      'AI观战等待阶段即隐藏触控操作键',
      '选风格屏顶栏改与对局相同(延迟/模式/退出)'
    ]],
    ['v133', [
      '修中继进房主机不刷新+客户端断重连',
      'AI选风格屏即隐藏触控操作键',
      'AI二段跳带水平位移且频率更高'
    ]],
    ['v130', [
      '修AI选风格客户端确认主机收不到',
      '选风格屏新增返回大厅键(同等待大厅)'
    ]],
    ['v128', [
      '盾牌减伤90%反伤60%加0.5秒再防冷却',
      'AI观战模式隐藏全部触控操作键',
      'AI全风格支持二段跳并强化个性'
    ]],
    ['v125', [
      '攻击波纹圈改以拳口为中心并下移'
    ]],
    ['v124', [
      '修局内反复弹等待房主选风格遮罩',
      '修攻击波纹错画到地面的坐标 bug'
    ]],
    ['v122', [
      '修复客户端点再来一局主机收不到'
    ]],
    ['v121', [
      'AI 对战「再来一局」正常重开',
      '修复客户端进房主机偶尔无反应'
    ]],
    ['v119', [
      '中继模式降码率, 延迟大幅回落',
      '观战画面加插值, 不再一格格顿',
      '修复客户端进不去选风格屏',
      '修复开始对战/确认风格键点不动',
      '更新公告改短句, 移动端不再超屏'
    ]],
    ['v116', [
      'AI 对战改为先进等待大厅显示房号',
      '选风格屏保留返回键, 房主可反悔'
    ]],
    ['v114', [
      '联机新增「AI 对战」观战玩法',
      '赛前各选 AI 风格, 观战 BO3'
    ]],
    ['v113', [
      '首页「副本」更名为「单人模式」',
      '玩法屏标题同步改名'
    ]],
    ['v112', [
      '联机玩法屏顶栏对齐联机大厅',
      '两页返回键位置与颜色一致'
    ]],
    ['v111', [
      '修复联机玩法屏返回键被顶栏遮挡',
      '未建房也能退回联机大厅'
    ]],
    ['v110', [
      '创建房间新增选择联机玩法屏',
      '暂仅双人对战, 预留扩展入口'
    ]],
    ['v109', [
      'P2P 直连优先, 中继降为并行备用',
      'P2P 宽限延至 20s, 直连迟到接管',
      '双通道同序号去重, 防画面回跳'
    ]],
    ['v108', [
      '移动端房间号金框不再超出大框',
      '等待大厅整体上移, 避开连不上键'
    ]],
    ['v107', [
      '移动端联机大厅输入与加入键堆叠'
    ]],
    ['v106', [
      '副本新增选择玩法屏',
      '修复连不上?按钮位置漂移'
    ]],
    ['v104', [
      '登录界面上移',
      '修复首页卡死与点击无响应',
      '加载省略号动态可视化'
    ]]
  ];
  const versionTag = document.getElementById('versionTag');
  const changelogPop = document.getElementById('changelogPop');
  if (versionTag && changelogPop) {
    changelogPop.innerHTML = '<div class="cl-title">更新公告</div>' +
      CHANGELOG.slice(0, 3).map(c => '<div class="cl-item"><span class="cl-ver">' + c[0] + '</span><div class="cl-points">' +
        c[1].map(p => '<div class="cl-pt">· ' + p + '</div>').join('') +
        '</div></div>').join('');
    versionTag.addEventListener('click', (e) => {
      e.stopPropagation();
      changelogPop.classList.toggle('hidden');
    });
    document.addEventListener('click', (ev) => {
      if (!changelogPop.classList.contains('hidden') && !changelogPop.contains(ev.target) && ev.target !== versionTag) {
        changelogPop.classList.add('hidden');
      }
    });
  }

  // 规则 / 连不上 弹层(常驻边缘按钮触发)
  if (rulesBtn && rulesPop) {
    rulesBtn.addEventListener('click', (e) => { e.stopPropagation(); rulesPop.classList.toggle('hidden'); });
  }
  if (helpPop) {
    document.querySelectorAll('.help-btn').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      helpPop.classList.toggle('hidden');
    }));
  }
  [rulesPop, helpPop].forEach(pop => {
    if (!pop) return;
    pop.addEventListener('click', (e) => { if (e.target === pop) pop.classList.add('hidden'); });
    pop.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => pop.classList.add('hidden')));
  });

  // ===== 启动 =====
  setStatus('');
  setInterval(updateHUD, 60);
})();
