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

  // ===== DOM: 房间等待大厅 =====
  const roomLobby = document.getElementById('roomLobby');
  const roomLobbyCode = document.getElementById('roomLobbyCode');
  const slotP1Name = document.getElementById('slotP1Name');
  const slotP2Name = document.getElementById('slotP2Name');
  const slotP2Status = document.getElementById('slotP2Status');
  const btnShareWorld = document.getElementById('btnShareWorld');
  const btnRoomStart = document.getElementById('btnRoomStart');
  const btnRoomCancel = document.getElementById('btnRoomCancel');
  const roomLobbyStatus = document.getElementById('roomLobbyStatus');

  // ===== DOM: 游戏区 =====
  const gameWrap = document.getElementById('gameWrap');
  const elHpP1 = document.getElementById('hpP1');
  const elHpP2 = document.getElementById('hpP2');
  const elWinsP1 = document.getElementById('winsP1');
  const elWinsP2 = document.getElementById('winsP2');
  const elRound = document.getElementById('roundNum');
  const elTimer = document.getElementById('timer');
  const elNet = document.getElementById('netStatus');
  const roleP1 = document.getElementById('roleP1');
  const roleP2 = document.getElementById('roleP2');
  const hudP1Name = document.getElementById('hudP1Name');
  const hudP2Name = document.getElementById('hudP2Name');
  const overlay = document.getElementById('overlay');
  const ovTitle = document.getElementById('overlayTitle');
  const ovText = document.getElementById('overlayText');
  const startBtn = document.getElementById('startBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const resyncBtn = document.getElementById('resyncBtn');
  const modeTag = document.getElementById('gameModeTag');

  let exitConfirmMode = false;
  let currentPlayer = null; // {id, name}
  let isGuest = false;
  let sharedToWorld = false;

  function pct(hp) { return Math.max(0, Math.min(100, hp)) + '%'; }
  function fmtWins(w) {
    return '<span class="' + (w > 0 ? 'got' : '') + '">●</span> <span class="' + (w > 1 ? 'got' : '') + '">●</span>';
  }

  function updateHUD() {
    if (!game.p1 || !game.p2) return; // [BUG-FIX] 比赛开始前 p1/p2 为 null, 跳过避免每帧 TypeError
    elHpP1.style.width = pct(game.p1.hp);
    elHpP2.style.width = pct(game.p2.hp);
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
    if (game.mode === 'offline') {
      modeTag.textContent = '离线 vs AI';
    } else if (game.mode === 'host') {
      const m = Net.getMode() === 'relay' ? '中继' : 'P2P';
      modeTag.textContent = Net.isConnected() ? '主机 · ' + m : '主机 · 等待中';
    } else if (game.mode === 'client') {
      const m = Net.getMode() === 'relay' ? '中继' : 'P2P';
      modeTag.textContent = Net.isConnected() ? '客户端 · ' + m : '客户端 · 重连中';
    }
    resyncBtn.classList.toggle('visible', game.mode !== 'offline');
  }

  // ===== 登录界面逻辑 =====
  function showAuthScreen() {
    authScreen.classList.remove('hidden');
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
  }
  function showLobby() {
    authScreen.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    lobby.classList.remove('hidden');
    if (currentPlayer) {
      lobbyPlayerName.textContent = currentPlayer.name;
      lobbyPlayerId.textContent = currentPlayer.id;
    }
    // 初始化世界频道
    World.init();
    World.onUpdate(renderWorldList);
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
  function showRoomLobby(code) {
    lobby.classList.add('hidden');
    gameWrap.classList.add('hidden');
    roomLobby.classList.remove('hidden');
    roomLobbyCode.textContent = code;
    slotP1Name.textContent = currentPlayer ? currentPlayer.name : '玩家';
    slotP2Name.textContent = '等待中...';
    slotP2Status.textContent = '等待加入';
    slotP2Status.className = 'slot-status';
    btnRoomStart.classList.add('hidden');
    sharedToWorld = false;
    btnShareWorld.classList.remove('shared');
    btnShareWorld.textContent = '分享到世界';
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
    // 首次分享显示"已分享", 之后再次分享显示"已再次分享"以区分
    btnShareWorld.textContent = btnShareWorld.dataset.sharedBefore ? '已再次分享 ✓' : '已分享 ✓';
    btnShareWorld.dataset.sharedBefore = '1';
    roomLobbyStatus.textContent = '房间已分享到世界频道';
    shareCooldown = true;
    btnShareWorld.disabled = true;
    setTimeout(() => {
      shareCooldown = false;
      btnShareWorld.disabled = false;
      btnShareWorld.classList.remove('shared');
      btnShareWorld.textContent = '分享到世界';
    }, 2000);
  });

  // 房间开始/取消
  btnRoomStart.addEventListener('click', () => {
    Net.sendStart(); // 通知 client 开始
    showGame();
    game.resetMatch();
    game.start();
  });
  btnRoomCancel.addEventListener('click', () => {
    hideRoomLobby();
    btnShareWorld.dataset.sharedBefore = ''; // 离开房间后, 下次分享重新从"已分享"开始
    Net.close();
    // 关键修复: 返回大厅时必须解除创建/加入按钮的禁用, 否则 btnHost 会一直被锁死(创建房间后无法再次创建)
    btnHost.disabled = false;
    btnJoin.disabled = false;
    showLobby();
    setStatus('');
  });

  // ===== 游戏区显示/隐藏 =====
  function showGame() {
    lobby.classList.add('hidden');
    roomLobby.classList.add('hidden');
    gameWrap.classList.remove('hidden');
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
    game.stop();
    Net.close();
    hideRoomLobby();
    gameWrap.classList.add('hidden');
    lobby.classList.remove('hidden');
    Input.clear();
    btnHost.disabled = false;
    btnJoin.disabled = false;
    if (currentPlayer) {
      lobbyPlayerName.textContent = currentPlayer.name;
      lobbyPlayerId.textContent = currentPlayer.id;
    }
  }
  function setStatus(msg, isErr) {
    lobbyStatus.textContent = msg || '';
    lobbyStatus.className = 'lobby-status' + (isErr ? ' err' : '');
    roomLobbyStatus.textContent = msg || '';
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
    if (game.mode === 'host') {
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
        // 移动端没有键盘, 不显示 R/ESC 提示
        const hint = IS_TOUCH_UI ? '' : '\n\n按 R 重开对局\n按 ESC 返回大厅';
        showOverlay('比赛结束', champ + hint, '再来一局');
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
        Net.sendResync();
        showOverlay('重开对局', '已请求主机重开\n等待响应...', '', { cancelable: true, cancelLabel: '继续' });
        setTimeout(() => { if (!overlay.classList.contains('hidden')) hideOverlay(); }, 3000);
      }
    }
  };

  // 开始/再来一局按钮
  let _btnHandled = false;
  const onStart = (e) => {
    e.preventDefault();
    if (_btnHandled) return;
    _btnHandled = true;
    setTimeout(() => { _btnHandled = false; }, 300);
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
  startBtn.addEventListener('pointerdown', onStart);

  // 退出按钮
  const onExit = (e) => {
    e.preventDefault();
    if (exitConfirmMode) return;
    exitConfirmMode = true;
    if (game.mode === 'offline') game.stop();
    showOverlay('退出游戏', '确定要离开当前房间?\n\n将返回大厅,对手会断开', '确认退出',
      { cancelable: true, cancelLabel: '继续游戏' });
  };

  // 移动端独立退出按钮(复用 onExit 逻辑, 弹确认对话框并暂停游戏)
  const exitMobileBtn = document.getElementById('exitMobileBtn');
  if (exitMobileBtn) {
    exitMobileBtn.addEventListener('click', onExit);
    exitMobileBtn.addEventListener('pointerdown', onExit);
  }

  // 刷新对局: 单方面刷新(仅刷新本机视图/要求对手推送最新快照, 绝不重置对局)
  const onResync = (e) => {
    e.preventDefault();
    if (_btnHandled) return;
    _btnHandled = true;
    setTimeout(() => { _btnHandled = false; }, 400);
    if (game.mode === 'host') {
      // 主机点刷新: 立即向对手(客户端)推送最新权威快照; 本机对局继续, 不重置
      Net.sendState(game._serializeState());
      showOverlay('刷新', '已向对手推送最新状态\n(本机对局未重置)', '', { cancelable: true, cancelLabel: '继续' });
      setTimeout(hideOverlay, 1200);
    } else if (game.mode === 'client') {
      // 客户端点刷新: 清空本地插值缓冲, 请求主机推送最新快照; 仅本机视图刷新, 不影响对手
      if (game.interp) game.interp.foeHasTarget = false;
      Net.sendResync();
      showOverlay('刷新', '已请求主机推送最新状态\n正在重新同步(仅本机视图)', '', { cancelable: true, cancelLabel: '继续' });
      setTimeout(() => { if (!overlay.classList.contains('hidden')) hideOverlay(); }, 3000);
    }
  };
  resyncBtn.addEventListener('click', onResync);
  resyncBtn.addEventListener('pointerdown', onResync);

  // ===== 大厅按钮 =====
  btnOffline.addEventListener('click', () => {
    setStatus('加载中...');
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

  btnHost.addEventListener('click', () => startHost());

  async function startHost() {
    setStatus('正在创建房间...');
    btnHost.disabled = true;
    Net.setName(currentPlayer ? currentPlayer.name : '玩家');
    bindNetEvents(); // 先绑定事件, 再连接
    try {
      const code = await Net.hostRoom();
      game.setMode('host');
      roleP1.textContent = '你';
      roleP2.textContent = '对手';
      hudP1Name.textContent = currentPlayer ? currentPlayer.name : 'BLUE-01';
      showRoomLobby(code);
      const mode = Net.getMode() === 'relay' ? '中继' : 'P2P';
      setStatus('房号: ' + code + ' (' + mode + ')\n等待对手加入...');
    } catch (e) {
      setStatus('创建失败: ' + (e.message || e), true);
      btnHost.disabled = false;
    }
  }

  // 返回大厅/取消
  const onCancel = (e) => {
    e.preventDefault();
    if (_btnHandled) return;
    _btnHandled = true;
    setTimeout(() => { _btnHandled = false; }, 300);
    if (exitConfirmMode) {
      exitConfirmMode = false;
      hideOverlay();
      if (game.mode === 'offline') game.start();
      return;
    }
    backToLobby();
    setStatus('');
  };
  cancelBtn.addEventListener('click', onCancel);
  cancelBtn.addEventListener('pointerdown', onCancel);

  btnJoin.addEventListener('click', async () => {
    const code = (roomInput.value || '').trim();
    if (!/^\d{6}$/.test(code)) { setStatus('请输入 6 位数字房号', true); return; }
    setStatus('正在连接 ' + code + '...');
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
      game.resetMatch();
      game.start();
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
        if (game.mode === 'host') { game.resetMatch(); game.start(); }
        return;
      }
      // host: 对手已加入, 显示开始按钮
      if (game.mode === 'host') {
        slotP2Name.textContent = oppName;
        slotP2Status.textContent = '已就绪';
        slotP2Status.className = 'slot-status ready';
        btnRoomStart.classList.remove('hidden');
        roomLobbyStatus.textContent = '对手 ' + oppName + ' 已加入! 点击开始对战';
        hudP2Name.textContent = oppName;
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
    Net.on('state', (s) => {
      if (game.mode === 'client') game.applyRemoteState(s);
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
    Net.on('resync', () => {
      // 对手请求刷新: 仅向对手推送最新权威快照, 不重置本机对局(单方面刷新)
      if (game.mode === 'host' && Net.isConnected()) {
        Net.sendState(game._serializeState());
        showOverlay('刷新', '对手请求刷新\n已向其推送最新状态(本机未重置)', '', { cancelable: true, cancelLabel: '继续' });
        setTimeout(hideOverlay, 1200);
      }
    });
    Net.on('reset', () => {
      if (game.mode === 'client') {
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

  // ===== 更新公告: 点击右下角版本号显示近五次更新 =====
  const CHANGELOG = [
    ['v51', '联机稳定性大修'],
    ['v44', '修复幻影伤害'],
    ['v43', '游客账号固定'],
    ['v41', '建房按钮修复'],
    ['v39', '刷新键移右上']
  ];
  const versionTag = document.getElementById('versionTag');
  const changelogPop = document.getElementById('changelogPop');
  if (versionTag && changelogPop) {
    changelogPop.innerHTML = '<div class="cl-title">更新公告</div>' +
      CHANGELOG.map(c => '<div class="cl-item"><span class="cl-ver">' + c[0] + '</span>' + c[1] + '</div>').join('');
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

  // ===== 启动 =====
  setStatus('');
  setInterval(updateHUD, 60);
})();
