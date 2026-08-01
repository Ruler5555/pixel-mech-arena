// net.js · 网络层(方案 X): PeerJS P2P(主) + 中继(仅显式兜底, 非静默 fallback)
// 设计原则:
//   - P2P 直连优先(同 WiFi/局域网 10~30ms; 跨网经 TURN 真·P2P 亦远低于境外 broker 中继)
//   - transport(P2P / 中继) 在「连接那一刻」决定一次, 之后恒定 —— 不再每帧仲裁 / 回落
//   - 中继仅在 P2P 连不上时由用户显式点击「切换中继」启用, 且明确告知≈500ms 几乎不可玩
//   - 对局中断线不再静默翻 mode, 而是弹「连接断开」让用户手动决策
// 相对 v143 的改进(根治"常驻260/两头中继/主机不刷新"三连 bug):
//   1. 删除"活性监测每帧仲裁 + state 双发同序号"三态机(前版 bug 温床)
//   2. 连接阶段 P2P 无限重试(永不放弃), 8s 后弹出「切换中继(高延迟)」按钮作逃生选项(不自动落中继, P2P 持续重试)
//   3. 中继降级为显式兜底: 连上明确告知高延迟、几乎不可玩; 不再静默翻 mode
//   4. 单一 RTT / 单一通道路由, 逻辑复杂度减半
// 说明: 中继经公共 MQTT broker(EMQX/HiveMQ), 实测 RTT≈500ms, 对实时格斗几乎不可玩,
//   故仅作"能连上但卡"的最后手段, 绝不静默接管。

// ⚠️ 跨网能玩的关键: 必须有一个「活的」TURN 服务器做 NAT 穿透。
// v160 起: region=japan 日本节点(实测对国内 TCP 延迟最低 ~220ms, 优于 sg ~300-400 / global ~280-395)
//   v158 曾用 region=global(就近路由), 但实测 global 对国内路由不佳(158.247.200.82), 用户测出 1500+ms。
// v155 关键修正(REST API 实测确认):
//   1. 凭据是账户级, 各区域都能用(global/sg/jp 均 Allocate 实测成功)
//   2. API key 4abe49...(zmrly321456 凭据的 key, 已验证有效)
//   3. TURN 端口: 80(udp/tcp) + 443(udp) + 443(tls); STUN: stun.relay.metered.ca:80
// 动态拉取失败(网络/CORS)时回退到下方 TURN_SERVERS_FALLBACK(jp 优先 + sg/global 兜底, 均已验证可 Allocate)。
const METERED_TURN_API = 'https://zmrly5555.metered.live/api/v1/turn/credentials?apiKey=4abe49e452ba47643a733c4b71c10063eac9&region=japan';
const TURN_SERVERS_FALLBACK = [
  // ⚠️ v176: 移除 v175 帮手的"国内免费 TURN" 43.138.235.180:9002(zhaosonghan.com 博客配置)
  //   实测 UDP/TCP 9002 均无响应(死服务器, turn_verify.py 多次超时) —— ping 通 ≠ TURN 可用。
  //   教训: 第三方博客分享的公共 TURN 大概率已失效, 必须 TURN Allocate 实测通过才能接入。
  // 静态兜底(REST API 不可达时): 日本优先(实测延迟最低) + 新加坡/global 兜底(凭据 5bd3b7... 均 Allocate 实测成功)
  { urls: 'turn:jp.relay.metered.ca:80', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:jp.relay.metered.ca:80?transport=tcp', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:jp.relay.metered.ca:443', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turns:jp.relay.metered.ca:443?transport=tcp', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:sg.relay.metered.ca:80', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:sg.relay.metered.ca:443', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:global.relay.metered.ca:80', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' }
];
const STUN_SERVERS = [
  // [v173] 国内 STUN 优先: STUN 只问"公网映射地址", 海外 STUN 被墙时收集不到 srflx 会降低穿透成功率;
  //   国内 STUN 可达性更稳 → 提到最前(并行请求, 失败自动跳过, 海外兜底)。
  //   部署国内 coturn 后把下面这行加进来(它自带 STUN): { urls: 'stun:你的服务器IP:3478' }
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// 动态构建 ICE 配置: 优先用 Metered REST API 返回的实时 TURN(主机/凭据都由 Metered 给, 不靠猜), 失败回退静态
// 返回 Promise<{iceServers, iceTransportPolicy}>, 始终 resolve(不会阻塞连接)
function buildIceServers() {
  return new Promise((resolve) => {
    let done = false;
    const ok = (ice) => { if (done) return; done = true; resolve(ice); };
    const fallback = () => ok({ iceServers: [...STUN_SERVERS, ...TURN_SERVERS_FALLBACK], iceTransportPolicy: 'all' });
    try {
      fetch(METERED_TURN_API, { cache: 'no-store' })
        .then((r) => r.json())
        .then((servers) => {
          // Metered 在 key 无效/无权限时返回 {error:...} 而非数组 → 立即回退静态, 不卡死
          if (!servers || servers.error || !Array.isArray(servers) || servers.length === 0) {
            console.log('[TURN] 动态获取失败(无有效凭据), 用静态兜底');
            fallback();
            return;
          }
          const turn = servers.filter((s) => s && /turn:/.test(s.urls || ''));
          console.log('[TURN] 服务已获取(' + turn.length + '条)');
          ok({ iceServers: [...STUN_SERVERS, ...servers], iceTransportPolicy: 'all' });
        })
        .catch(() => { console.log('[TURN] 动态获取失败, 用静态兜底'); fallback(); });
    } catch (e) { fallback(); }
    // 兜底超时: 若 API 卡死(无网络), 5s 后用静态兜底, 不阻塞连接
    setTimeout(() => { if (!done) { console.log('[TURN] 获取超时, 用静态兜底'); fallback(); } }, 5000);
  });
}

const PEER_PREFIX = 'pma26-';

const Net = (() => {
  let peer = null;
  let conn = null;
  let role = null;
  let roomCode = null;
  let mode = 'p2p';        // 当前承载通道: 连接阶段决定一次后恒定, 不再每帧翻转
  let handshaked = false;
  let sendSeq = 0;         // 发送序号(单计数器; 握手/测速幂等不参与去重)
  let lastRecvSeq = 0;     // 已处理的最大对端序号(防重复/过期)
  let rtt = 0;             // 单一 RTT(当前通道实测)
  let joining = false;     // 连接阶段标志
  let _joinResolve = null; // client joinRoom 的 resolver
  let _joinReject = null;  // client joinRoom 的 rejector(用户取消时调用)
  // [v179] 中继自动重抽直连: 连接建立后若 ICE 选到 relay(TURN 中继), 说明当次 NAT 穿透失败。
  //  运营商 CGNAT 映射是动态的 —— 等待期销毁重建连接重新协商(重新抽签), 有机会拿到可穿透映射。
  let rejoinPending = false;    // host 侧: client 正在重连(忽略断线弹窗, 允许新连接替换)
  let suppressDisconnect = false; // client 侧: 重建期间不弹「连接断开」
  let rebuilding = false;       // 重建进行中(防重入)
  let autoRetryDirect = 0;      // 本局自动重抽次数(封顶 2 次)
  let _connOpenedAt = 0;        // 连接建立时刻(20s 窗口内才自动重抽, 开战后不打扰)
  let p2pRetryTimer = null;
  let p2pConnectAttempts = 0;
  const P2P_RETRY_GAP = 8000;   // 首轮重试间隔(快场景快速抽签)
  const P2P_RETRY_GAP_SLOW = 20000; // v178: 慢速协商长宽限(对齐 v109"宁等多几秒也要 P2P"哲学)
  // 为什么需要 20s 长轮: 跨网对称 NAT 时 TURN 分配 + 多候选逐对测试可能需 8-20s 才完成协商,
  //   8s 就重开连接会反复打断未完成的协商 → 穿透失败(只能中继)。
  //   前 2 轮 8s 快速尝试(快场景), 之后 20s 长轮给慢速协商充足时间(穿透成功率↑)。
  //   真连不上则 20s 一轮无限重试, 用户可随时返回大厅。
  let keepAliveTimer = null;
  let pingTimer = null;
  let playerName = '';
  let _channelDetail = '';    // v164: 真实 ICE 通道 ''未知 / 'direct'直连 / 'relay'TURN中继
  let _channelTimer = null;   // v164: 轮询 selected candidate pair 的定时器

  const handlers = {
    open: [], connected: [], state: [], input: [], close: [],
    progress: [], error: [], start: [],
    reset: [], rematchReady: [],
    aimode: [], aipick: [], aipickack: [], aistart: [], aipickstart: [], aicancel: [],

  };
  function on(ev, fn) { (handlers[ev] || []).push(fn); }
  function emit(ev, arg) { (handlers[ev] || []).forEach(fn => { try { fn(arg); } catch (e) {} }); }
  function progress(msg) { emit('progress', msg); }
  function setName(n) { playerName = n || ''; }
  function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

  // ============ 握手出口(连接那一刻锁定通道) ============
  function _emitConnected(payload, ch) {
    handshaked = true;
    if (ch) mode = ch;                 // 锁定 / 更新传输通道(一次性决策)
    clearTimeout(p2pRetryTimer); p2pRetryTimer = null;
    joining = false;
    _startPingMonitor();
    if (role === 'client' && _joinResolve) {
      const r = _joinResolve; _joinResolve = null; _joinReject = null; r(roomCode);
    }
    emit('connected', payload || { name: '' });
  }

  // ============ P2P 主机 ============
  function hostRoom() { return _p2pHost(); }
  function _p2pHost() {
    return new Promise((resolve, reject) => {
      role = 'host'; roomCode = genCode(); handshaked = false; mode = 'p2p';

      progress('正在获取 TURN 穿透服务...');
      buildIceServers().then((ice) => {
      let resolved = false;
      const finish = (code) => {
        if (resolved) return;
        resolved = true; _startKeepAlive(); resolve(code);
      };
      try { peer = new Peer(PEER_PREFIX + roomCode, { debug: 1, config: ice }); }
      catch (e) { reject(e); return; }

      peer.on('open', () => {
        progress('信令已就绪, 等待对手(P2P 直连优先)...');
        finish(roomCode);
      });

      peer.on('connection', (c) => {
        // v162: 收到新连接时, 若旧连接未完成协商则先清理(避免并发 ICE 协商混乱, 恢复 v109 单连接穿透)
        if (conn && conn !== c) {
          // v179: client 自动重抽直连(rejoinPending)时允许新连接替换旧连接(重新协商=重新抽签)
          if (conn.open && !rejoinPending) { c.close(); return; } // 已有可用直连, 丢弃新的
          try { conn.close(); } catch (e) {}
        }
        conn = c; mode = 'p2p';
        progress('P2P 直连已建立');
        bindConn(c);
      });

      peer.on('disconnected', () => { progress('信令断开, 重连中...'); try { peer.reconnect(); } catch (e) {} });

      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          progress('房号冲突, 换号重试...');
          try { peer.destroy(); } catch (e) {}
          roomCode = genCode();
          setTimeout(() => _p2pHost().then(resolve, reject), 200);
          return;
        }
        progress('信令错误: ' + err.type);
      });
      }).catch((e) => reject(e));
    });
  }

  // ============ P2P 客户端 ============
  function joinRoom(code) { return _p2pJoin(code); }
  function _p2pJoin(code) {
    return new Promise((resolve, reject) => {
      role = 'client'; roomCode = code; handshaked = false; mode = 'p2p';

      progress('正在获取 TURN 穿透服务...');
      _joinResolve = (c) => { resolve(c); };
      _joinReject = (e) => { reject(e); };
      buildIceServers().then((ice) => {
        try { peer = new Peer({ debug: 1, config: ice }); }
        catch (e) { reject(e); return; }

        peer.on('open', () => {
          progress('信令已就绪, 正在尝试 P2P 直连...');
          _tryP2pConnect();
        });

        peer.on('disconnected', () => { progress('信令断开, 重连中...'); try { peer.reconnect(); } catch (e) {} });

        peer.on('error', (err) => {
          // peer-unavailable 多为瞬态(主机信令尚未就绪), 重试由 _tryP2pConnect 的超时驱动
          if (err.type === 'peer-unavailable') { progress('主机暂时不可达, 重试 P2P...'); return; }
          progress('信令错误: ' + err.type);
        });
      }).catch((e) => reject(e));
    });
  }
  // P2P 无限重试: 每次间隔 P2P_RETRY_GAP, 永不放弃(用户可手动点「切换中继」或「返回大厅」)
  // v162: 重试前清理旧未完成连接 —— 保持"单连接 ICE 协商"(对齐 v109), 避免多个并发 DataConnection
  // 同时收集候选/互相干扰, 那会降低 NAT 穿透成功率(穿透成功才走真 P2P 低延迟, 失败只能中继高延迟)
  function _tryP2pConnect() {
    if (handshaked) return;
    if (!peer || peer.destroyed) return;
    // 清理上一个未完成的连接(若已 open 说明协商完成, 不会走到这; 未 open 的旧连接是残留, 关闭)
    if (conn && !conn.open) { try { conn.close(); } catch (e) {} }
    conn = null;
    p2pConnectAttempts++;
    progress('P2P 直连尝试 ' + p2pConnectAttempts + ' 次...');
    const c = peer.connect(PEER_PREFIX + roomCode, { reliable: true, serialization: 'json' });
    conn = c; bindConn(c);
    p2pRetryTimer = setTimeout(() => {
      if (handshaked) return;
      _tryP2pConnect();   // 永不放弃, 持续重试 P2P
    }, p2pConnectAttempts <= 2 ? P2P_RETRY_GAP : P2P_RETRY_GAP_SLOW);
  }

  // 用户取消连接(返回大厅): 解阻塞 joinRoom
  function abortJoin() {
    if (_joinReject) { const r = _joinReject; _joinReject = null; _joinResolve = null; r(new Error('已取消')); }
  }

  // ============ 保活 / 测速 ============
  function _startKeepAlive() {
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      if (peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) {} }
    }, 25000);
  }
  function _stopKeepAlive() { clearInterval(keepAliveTimer); keepAliveTimer = null; }

  function _sendPing() { if (isConnected()) send({ t: 'ping', ts: Date.now() }); }
  function _startPingMonitor() { clearInterval(pingTimer); pingTimer = setInterval(_sendPing, 1000); }
  function _stopPingMonitor() { clearInterval(pingTimer); pingTimer = null; }

  // ============ 握手消息处理 ============
  // 收到任一握手消息(hello/world)即认为该通道对手可达 → 锁定通道并通知上层(幂等安全)
  function _handleHello(msg, ch) {
    if (role === 'host') {
      _emitConnected({ name: msg.n || '' }, ch);
    } else {
      _emitConnected({ name: msg.n || '' }, ch);
    }
  }
  function _handleWorld(msg, ch) {
    if (role !== 'client') return;
    _emitConnected({ name: msg.n || '' }, ch);
  }

  // 序号去重: 仅对游戏消息生效; 握手/测速幂等不参与(否则各自独立计数器会把 pong 当过期丢)
  function _acceptSeq(msg) {
    if (msg.t === 'ping' || msg.t === 'pong' || msg.t === 'hello' || msg.t === 'world') return true;
    if (msg.q === undefined) return true;
    if (msg.q > lastRecvSeq) { lastRecvSeq = msg.q; return true; }
    if (lastRecvSeq - msg.q > 5000) { lastRecvSeq = msg.q; return true; } // 对端重启
    return false;
  }

  // 通用消息路由(P2P 与中继共用)
  function _routeMsg(msg, ch) {
    ch = ch || 'p2p';
    if (msg.t === 'state') emit('state', msg.s);
    else if (msg.t === 'input') emit('input', msg.c);
    else if (msg.t === 'bye') emit('close');
    else if (msg.t === 'reset') emit('reset');
    else if (msg.t === 'start') emit('start');
    else if (msg.t === 'rmt') emit('rematchReady');
    else if (msg.t === 'aimode') emit('aimode');
    else if (msg.t === 'aipick') emit('aipick', msg.id);
    else if (msg.t === 'aipickack') emit('aipickack');   // v174: host 已收到 client 风格确认(应用层确认)
    else if (msg.t === 'aistart') emit('aistart', msg.cfg);
    else if (msg.t === 'aips') emit('aipickstart');
    else if (msg.t === 'aicxl') emit('aicancel');
    else if (msg.t === 'ping') send({ t: 'pong', ts: msg.ts });
    else if (msg.t === 'pong') { const r = Date.now() - (msg.ts || 0); if (r >= 0 && r < 10000) rtt = r; }
    else if (msg.t === 'rejoin') { // v179: client 正在自动重抽直连, 25s 窗口内忽略断线/接受新连接替换
      rejoinPending = true;
      setTimeout(() => { rejoinPending = false; }, 25000);
    }
  }

  function bindConn(c) {
    _watchSelectedPair(c);  // v164: 检测真实 ICE 通道(直连/TURN中继)
    c.on('open', () => {
      suppressDisconnect = false; // v179: 新连接建立, 恢复断线提示能力
      _connOpenedAt = Date.now(); // v179: 记录连接建立时刻(自动重抽直连的窗口起点)
      progress('P2P 已建立');
      _startPingMonitor();
      try { c.send({ t: 'hello', n: playerName, q: ++sendSeq }); } catch (e) {}
    });
    // ICE 状态诊断: 跨网连不上时据此判断是 NAT 穿透失败还是 TURN 不可用
    if (c.on) {
      try { c.on('iceStateChanged', (s) => { if (s === 'failed' || s === 'disconnected') progress('NAT 穿透失败, 需 TURN/中继'); else progress('网络状态: ' + s); }); } catch (e) {}
    }
    c.on('data', (msg) => {
      if (!msg || !msg.t) return;
      if (msg.t === 'hello') { _handleHello(msg, 'p2p'); return; }
      if (msg.t === 'world') { _handleWorld(msg, 'p2p'); return; }
      if (!_acceptSeq(msg)) return;
      _routeMsg(msg, 'p2p');
    });
    c.on('close', () => {
      // 通道断开: 不再静默翻 mode, 通知上层让用户决策(弹「连接断开」)
      // v179: client 重建连接期间(rejoinPending/suppressDisconnect)不弹, 避免干扰自动重抽
      if (handshaked && !suppressDisconnect && !rejoinPending) emit('disconnected');
    });
    c.on('error', () => { if (handshaked && !suppressDisconnect && !rejoinPending) emit('disconnected'); });
  }

  // ============ v164: 真实 ICE 通道检测 ============
  // 右上角"P2P"标签只代表走 WebRTC DataChannel, 不代表物理直连!
  // 对称 NAT 时 ICE 只能选 relay 候选对 → 数据实际经 TURN 服务器中继(几百ms)但标签仍显示 P2P。
  // 通过 pc.getStats() 轮询 selected candidate pair, 识别候选对类型:
  //   v165: 同时检查 local+remote —— 任一侧是 relay 即整体走 TURN 中继(两端显示一致),
  //   只有两侧都是 host/srflx 才是真 P2P 直连(几十ms)
  function _watchSelectedPair(c) {
    try {
      const pc = c._pc || c.peerConnection;
      if (!pc || typeof pc.getStats !== 'function') return;
      clearInterval(_channelTimer);
      const poll = async () => {
        try {
          const stats = await pc.getStats();
          let sel = null;
          stats.forEach((r) => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && !sel) sel = r;
          });
          if (sel && sel.localCandidateId) {
            const local = stats.get(sel.localCandidateId);
            const remote = stats.get(sel.remoteCandidateId);
            const lt = local ? (local.candidateType || '') : '';
            const rt = remote ? (remote.candidateType || '') : '';
            // 任一侧 relay = 数据经 TURN 中继; 两侧均非 relay = 真直连
            _channelDetail = (lt === 'relay' || rt === 'relay') ? 'relay' : 'direct';
            // v179: 检测到中继且是 client 等待期 → 自动重抽直连(销毁重建重新协商)
            if (_channelDetail === 'relay') _maybeAutoRetryDirect();
          }
        } catch (e) {}
      };
      poll();
      _channelTimer = setInterval(poll, 2000);
    } catch (e) {}
  }
  function getChannelDetail() { return _channelDetail; }

  // [v179] 中继自动重抽直连(client 等待期, 每局最多 2 次)
  // 连接建立后若 ICE 选到 relay(TURN 中继), 说明当次 NAT 穿透失败。
  // 运营商 CGNAT 映射是动态的 —— 销毁重建连接重新协商(重新抽签), 有机会拿到可穿透映射直连。
  // 守卫: 仅 client / 已握手 / 连接建立后 20s 内(等待大厅阶段, 开战后不打扰) / 不重入 / 封顶 2 次。
  function _maybeAutoRetryDirect() {
    if (role !== 'client' || rebuilding || autoRetryDirect >= 2) return;
    if (!handshaked) return;
    if (!_connOpenedAt || Date.now() - _connOpenedAt > 20000) return;
    autoRetryDirect++;
    rebuilding = true;
    suppressDisconnect = true;
    progress('检测到 TURN 中继, 自动重试直连(' + autoRetryDirect + '/2)...');
    // 通知 host: 正在重连, 期间忽略断线提示并接受新连接替换
    try { if (conn && conn.open) conn.send({ t: 'rejoin' }); } catch (e) {}
    setTimeout(() => {
      if (!peer || peer.destroyed) { rebuilding = false; suppressDisconnect = false; return; }
      try { peer.destroy(); } catch (e) {}
      conn = null;
      p2pConnectAttempts = 0; // 重建后重新快轮抽签(前 2 轮 8s)
      buildIceServers().then((ice) => {
        try { peer = new Peer({ debug: 1, config: ice }); }
        catch (e) { rebuilding = false; suppressDisconnect = false; return; }
        peer.on('open', () => {
          progress('重连信令就绪, 尝试直连...');
          rebuilding = false;
          _tryP2pConnect();
        });
        peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
        peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') { progress('主机暂时不可达, 重试 P2P...'); return; }
          progress('信令错误: ' + err.type);
        });
      });
      // 重建若迟迟未成功(如信令断), 30s 后恢复断线提示能力
      setTimeout(() => { if (rebuilding) { rebuilding = false; suppressDisconnect = false; } }, 30000);
    }, 2500);
  }

  // ============ 通用接口 ============
  // 单通道发送(v167: 已删 MQTT 中继, 仅 P2P 通道):
  //   P2P 通道(conn)可用就发 P2P(低延迟); P2P 断开时宁可丢帧等重连,
  //   绝不走任何中继(500ms+ 延迟尖刺的根源已彻底移除)
  function send(obj) {
    obj.q = ++sendSeq;
    if (conn && conn.open) { try { conn.send(obj); } catch (e) {} return; }
  }
  // [v172→v177] 状态包限速: 根治中继延迟滚雪球(220ms→5000ms→1000ms)。
  //   v172 的两个保护在移动端实测失效:
  //   ① bufferedAmount 只统计"未进网络栈"的字节, 一旦数据进 SCTP 重传队列就归零
  //      → 检测不到真正的在途堆积(这就是"仍然1000ms"的原因);
  //   ② getChannelDetail 依赖 pc.getStats() 轮询, 部分浏览器(vivo)不返回/慢 → 恒 ''。
  //   v177: 改用 RTT 驱动(ping/pong 实测, 走同一通道, 一定准) —— 高 RTT=中继/丢包特征
  //   → 自动限 15Hz; 自我修正闭环: rtt 高→降频→队列清→rtt 回落→频率恢复。
  let _lastStateTs = 0;
  function _stateBufferedHigh() {
    try {
      const dc = conn && (conn.dataChannel || conn._dc);
      if (dc && typeof dc.bufferedAmount === 'number' && dc.bufferedAmount > 8000) return true;
    } catch (e) {}
    return false;
  }
  function sendState(s) {
    const now = Date.now();
    const minGap = (rtt > 150) ? 66 : 33;   // 15Hz / 30Hz(v177: 高RTT自动降频)
    if (now - _lastStateTs < minGap) return;
    _lastStateTs = now;
    if (_stateBufferedHigh()) return;        // 兜底(双重保险)
    send({ t: 'state', s });
  }
  function sendInput(c) { send({ t: 'input', c }); }
  function sendReset() { send({ t: 'reset' }); }
  function sendBye() { send({ t: 'bye' }); }
  function sendStart() { send({ t: 'start' }); }
  function sendRematchReady() { send({ t: 'rmt' }); }
  // ===== AI 对战观战模式专用消息 =====
  function sendAiMode() { send({ t: 'aimode' }); }
  function sendAiPick(id) { send({ t: 'aipick', id }); }
  function sendAiPickAck() { send({ t: 'aipickack' }); }   // v174: host 回执, client 据此停止重发
  function sendAiStart(cfg) { send({ t: 'aistart', cfg }); }
  function sendAiPickStart() { send({ t: 'aips' }); }
  function sendAiCancel() { send({ t: 'aicxl' }); }

  function getRole() { return role; }
  function isConnected() { return !!(conn && conn.open); }
  function getRoomCode() { return roomCode; }
  function getMode() { return mode; }
  function getStateChannel() { return mode; } // 当前实际承载通道(单值, 不再有"谁先到谁赢"竞态)
  function getRtt() { return rtt; }

  function _cleanupP2P() {
    _stopKeepAlive();
    try { if (conn && conn.open) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    conn = null; peer = null;
  }
  function close() {
    _cleanupP2P();
    role = null; roomCode = null; mode = 'p2p';
    handshaked = false; joining = false;
    _joinResolve = null; _joinReject = null;
    sendSeq = 0; lastRecvSeq = 0; rtt = 0;
    clearTimeout(p2pRetryTimer); p2pRetryTimer = null;
    _stopPingMonitor();
    clearInterval(_channelTimer); _channelTimer = null; _channelDetail = '';
    // v179 复位
    rejoinPending = false; suppressDisconnect = false; rebuilding = false;
    autoRetryDirect = 0; _connOpenedAt = 0;
  }

  return {
    on, hostRoom, joinRoom, abortJoin,
    sendState, sendInput, sendReset, sendBye, sendStart, sendRematchReady,
    sendAiMode, sendAiPick, sendAiPickAck, sendAiStart, sendAiPickStart, sendAiCancel,
    setName, getRole, isConnected, getRoomCode, getMode, getRtt, getStateChannel, getChannelDetail, close
  };
})();
