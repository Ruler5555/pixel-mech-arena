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
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.qq.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' }
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
  let relayOffered = false;// 是否已向用户呈现「切换中继」(避免重复弹)
  let joining = false;     // 连接阶段标志
  let _joinResolve = null; // client joinRoom 的 resolver
  let _joinReject = null;  // client joinRoom 的 rejector(用户取消时调用)
  let p2pRetryTimer = null;
  let p2pConnectAttempts = 0;
  const P2P_RETRY_GAP = 8000;  // v163: 8s 重试间隔(对齐 v109 单连接协商哲学: ICE 收集TURN/STUN候选+穿透检查需2-6s, 1.5s 太短会放弃未完成的协商 → 进不去房间)
  let keepAliveTimer = null;
  let pingTimer = null;
  let mqttClient = null;
  let relayTopic = null;
  let playerName = '';
  let _channelDetail = '';    // v164: 真实 ICE 通道 ''未知 / 'direct'直连 / 'relay'TURN中继
  let _channelTimer = null;   // v164: 轮询 selected candidate pair 的定时器

  const handlers = {
    open: [], connected: [], state: [], input: [], close: [],
    progress: [], error: [], start: [],
    reset: [], rematchReady: [],
    aimode: [], aipick: [], aistart: [], aipickstart: [], aicancel: [],
    relayOffered: [], disconnected: []
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
      joining = false; relayOffered = false;
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
        // 主机同时监听中继通道(仅订阅, 不主动用): client 点「切换中继」可立即连上,
        // 中继延迟尖刺只在 client 真正走中继时才出现, 不影响 P2P 手感
        _startRelayListen(roomCode);
      });

      peer.on('connection', (c) => {
        // v162: 收到新连接时, 若旧连接未完成协商则先清理(避免并发 ICE 协商混乱, 恢复 v109 单连接穿透)
        if (conn && conn !== c) {
          if (conn.open) { c.close(); return; } // 已有可用直连, 丢弃新的
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
      joining = true; relayOffered = false; p2pConnectAttempts = 0;
      progress('正在获取 TURN 穿透服务...');
      _joinResolve = (c) => { resolve(c); };
      _joinReject = (e) => { reject(e); };
      // 安全网: 8s 内信令/首连都没成 → 提供中继选项(不静默接管)
      setTimeout(() => { if (!handshaked && !relayOffered) offerRelay(); }, 8000);
      buildIceServers().then((ice) => {
        try { peer = new Peer({ debug: 1, config: ice }); }
        catch (e) { reject(e); return; }

        peer.on('open', () => {
          progress('信令已就绪, 正在尝试 P2P 直连...');
          _tryP2pConnect();
          _startRelayListen(code); // 预订阅中继: 用户点「切换中继」可秒连
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
    }, P2P_RETRY_GAP);
  }

  // 连接阶段: 仅通知上层弹出「切换中继(高延迟)」按钮(逃生选项), 绝不停止 P2P 重试; 用户不点则 P2P 一直试
  function offerRelay() {
    if (relayOffered) return;
    relayOffered = true;
    emit('relayOffered');
  }

  // 用户显式切换中继(初始失败 / 对局中断线均可调用)
  function switchToRelay() {
    relayOffered = true;
    mode = 'relay';
    if (mqttClient && mqttClient.connected) { _relaySend({ t: 'hello', n: playerName }); return; }
    _relayConnect(roomCode, () => { /* role==='client'&&mode==='relay' 会自动发 hello */ },
      () => progress('中继也连不上'));
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
      if (ch === 'relay') _relaySend({ t: 'world', n: playerName }); // 中继下 client 需 world 确认
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
    else if (msg.t === 'aistart') emit('aistart', msg.cfg);
    else if (msg.t === 'aips') emit('aipickstart');
    else if (msg.t === 'aicxl') emit('aicancel');
    else if (msg.t === 'ping') send({ t: 'pong', ts: msg.ts });
    else if (msg.t === 'pong') { const r = Date.now() - (msg.ts || 0); if (r >= 0 && r < 10000) rtt = r; }
  }

  function bindConn(c) {
    _watchSelectedPair(c);  // v164: 检测真实 ICE 通道(直连/TURN中继)
    c.on('open', () => {
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
      if (handshaked) emit('disconnected');
    });
    c.on('error', () => { if (handshaked) emit('disconnected'); });
  }

  // ============ v164: 真实 ICE 通道检测 ============
  // 右上角"P2P"标签只代表走 WebRTC DataChannel, 不代表物理直连!
  // 对称 NAT 时 ICE 只能选 relay 候选对 → 数据实际经 TURN 服务器中继(几百ms)但标签仍显示 P2P。
  // 通过 pc.getStats() 轮询 selected candidate pair, 识别 local candidate 类型:
  //   host/srflx = 真直连(几十ms)  relay = TURN 中继(几百ms)
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
            if (local && local.candidateType) {
              _channelDetail = (local.candidateType === 'relay') ? 'relay' : 'direct';
            }
          }
        } catch (e) {}
      };
      poll();
      _channelTimer = setInterval(poll, 2000);
    } catch (e) {}
  }
  function getChannelDetail() { return _channelDetail; }

  // ============ 中继模式(MQTT over WebSocket) ============
  // 用 EMQX 公共 broker(broker.emqx.io),国内可达,对 WebSocket 友好
  // 每个房间用 topic: pma26/<code>,双方都订阅同一 topic
  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  // 主机/客户端监听中继(订阅 topic, 不主动发游戏消息; 仅 client 显式 switchToRelay 后才发 hello)
  function _startRelayListen(code) { _relayConnect(code, () => {}, () => {}); }
  function _relayConnect(code, onBroker, onFail) {
    if (typeof mqtt === 'undefined') { if (onFail) onFail(new Error('MQTT 库未加载')); return; }
    if (mqttClient && mqttClient.connected) { if (onBroker) onBroker(code); return; }
    relayTopic = 'pma26/' + code;
    const tryBroker = (idx) => {
      if (idx >= MQTT_BROKERS.length) { if (onFail) onFail(new Error('中继连接失败: 所有 broker 均不可用')); return; }
      try { if (mqttClient) mqttClient.end(true); } catch (e) {} // 切 broker 前结束上一个
      mqttClient = null;
      let resolved = false;
      let peerReady = false;
      let helloRetryTimer = null;
      const tag = idx === 0 ? 'EMQX' : 'HiveMQ';

      try {
        const clientId = 'pma26-' + role + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6);
        mqttClient = mqtt.connect(MQTT_BROKERS[idx], {
          clientId, clean: true, keepalive: 30,
          reconnectPeriod: 2000, connectTimeout: 10000
        });
      } catch (e) { tryBroker(idx + 1); return; }

      mqttClient.on('connect', () => {
        if (!resolved) {
          resolved = true;
          progress('中继已连接(' + tag + '), 等待对手...');
          mqttClient.subscribe(relayTopic, { qos: 0 });
          _startPingMonitor();
        } else {
          progress('中继已重连');
          try { mqttClient.subscribe(relayTopic, { qos: 0 }); } catch (e) {}
          if (peerReady) { _relaySend({ t: 'hello', n: playerName }); _emitConnected({ name: '' }, 'relay'); }
        }
        // client 且仅在已显式选中继(mode==='relay')时主动发 hello(重试直到收到 world)
        if (role === 'client' && mode === 'relay') {
          const sendHello = () => {
            if (peerReady) return;
            _relaySend({ t: 'hello', n: playerName });
            helloRetryTimer = setTimeout(sendHello, 1500);
          };
          setTimeout(sendHello, 300);
        }
        if (onBroker) onBroker(code);
      });

      mqttClient.on('message', (topic, payload) => {
        try {
          const msg = JSON.parse(payload.toString());
          if (!msg || !msg.t) return;
          if (msg.r === role) return; // 忽略自己发的
          if (msg.t === 'hello') {
            if (!peerReady) { peerReady = true; if (helloRetryTimer) { clearTimeout(helloRetryTimer); helloRetryTimer = null; } }
            _handleHello(msg, 'relay');
          } else if (msg.t === 'world') {
            if (!peerReady) { peerReady = true; if (helloRetryTimer) { clearTimeout(helloRetryTimer); helloRetryTimer = null; } }
            _handleWorld(msg, 'relay');
          } else {
            if (!_acceptSeq(msg)) return;
            _routeMsg(msg, 'relay');
          }
        } catch (e) {}
      });

      mqttClient.on('error', (err) => {
        if (!resolved) {
          progress('中继 ' + tag + ' 不可用, 尝试备用...');
          tryBroker(idx + 1);
        } else {
          emit('error', new Error('中继连接错误'));
        }
      });

      mqttClient.on('offline', () => { if (peerReady) progress('中继重连中...'); });
      mqttClient.on('reconnect', () => { if (peerReady) progress('中继重连中...'); });
    };
    tryBroker(0);
  }

  function _relaySend(obj) {
    if (!mqttClient || !mqttClient.connected) return;
    obj.r = role;
    if (obj.q === undefined) obj.q = ++sendSeq;
    try { mqttClient.publish(relayTopic, JSON.stringify(obj), { qos: 0 }); } catch (e) {}
  }

  // 显式中继建房/加入(备用的手动入口, 常规流程走 hostRoom/joinRoom + switchToRelay)
  function hostRelay() {
    mode = 'relay'; role = 'host'; roomCode = genCode();
    return new Promise((resolve, reject) => { _relayConnect(roomCode, resolve, reject); });
  }
  function joinRelay(code) {
    mode = 'relay'; role = 'client'; roomCode = code;
    return new Promise((resolve, reject) => { _relayConnect(code, resolve, reject); });
  }

  // ============ 通用接口 ============
  // 单通道发送, 恢复 v109 的「P2P 优先」:
  //   P2P 通道(conn)可用就发 P2P(低延迟); P2P 短暂停滞时宁可丢帧等重连,
  //   绝不悄悄切境外 MQTT 中继(500ms+ 延迟尖刺 —— v109 明确修复过的根因, v145 重构时误丢)。
  //   仅当用户显式切换中继(mode==='relay')才走 MQTT。
  function send(obj) {
    obj.q = ++sendSeq;
    if (conn && conn.open) { try { conn.send(obj); } catch (e) {} return; }
    if (mode === 'relay' && mqttClient && mqttClient.connected) { _relaySend(obj); return; }
  }
  function sendState(s) { send({ t: 'state', s }); }
  function sendInput(c) { send({ t: 'input', c }); }
  function sendReset() { send({ t: 'reset' }); }
  function sendBye() { send({ t: 'bye' }); }
  function sendStart() { send({ t: 'start' }); }
  function sendRematchReady() { send({ t: 'rmt' }); }
  // ===== AI 对战观战模式专用消息 =====
  function sendAiMode() { send({ t: 'aimode' }); }
  function sendAiPick(id) { send({ t: 'aipick', id }); }
  function sendAiStart(cfg) { send({ t: 'aistart', cfg }); }
  function sendAiPickStart() { send({ t: 'aips' }); }
  function sendAiCancel() { send({ t: 'aicxl' }); }

  function getRole() { return role; }
  function isConnected() { return !!(conn && conn.open) || !!(mqttClient && mqttClient.connected); }
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
    try { if (mqttClient) mqttClient.end(true); } catch (e) {}
    mqttClient = null; relayTopic = null;
    role = null; roomCode = null; mode = 'p2p';
    handshaked = false; relayOffered = false; joining = false;
    _joinResolve = null; _joinReject = null;
    sendSeq = 0; lastRecvSeq = 0; rtt = 0;
    clearTimeout(p2pRetryTimer); p2pRetryTimer = null;
    _stopPingMonitor();
    clearInterval(_channelTimer); _channelTimer = null; _channelDetail = '';
  }

  return {
    on, hostRoom, joinRoom, hostRelay, joinRelay, switchToRelay, abortJoin,
    sendState, sendInput, sendReset, sendBye, sendStart, sendRematchReady,
    sendAiMode, sendAiPick, sendAiStart, sendAiPickStart, sendAiCancel,
    setName, getRole, isConnected, getRoomCode, getMode, getRtt, getStateChannel, getChannelDetail, close
  };
})();
