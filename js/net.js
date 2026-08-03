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

// [v196] 等效强制中继(根治 P2P 家宽路径抖动): iceServers 只给 TURN(无 STUN) + iceTransportPolicy:'all'。
//   ⚠️ 为什么不用 iceTransportPolicy:'relay': PeerJS 的 DataConnection 层对 relay 策略有 bug
//   (无头 Chrome 实测: relay 策略候选收集 0 个, ICE 直接 disconnected; 原生 RTCPeerConnection 同配置正常)。
//   workaround: policy 'all' + 无 STUN → 没有 host/srflx 候选来源 → ICE 只能收集 relay 候选 = 等效强制中继,
//   且 PeerJS 完全兼容(无头 Edge 实测 CONN OPEN ✅)。
//   自建北京 TURN 优先(固定节点链路 40-50ms 零波动) + Metered jp/sg/global 兜底(服务器挂时保连接)。
//   ⚠️ 单点: 自建服务器 2026-09-01 到期未续费 → 自动走 Metered 兜底(海外高延迟但可连)。
const TURN_SERVERS = [
  { urls: 'turn:59.110.237.91:3478?transport=udp', username: 'pma', credential: '94e0013bacd62748' },
  { urls: 'turn:59.110.237.91:3478?transport=tcp', username: 'pma', credential: '94e0013bacd62748' },
  // Metered 兜底(账户级凭据, 各区域 Allocate 实测成功)
  { urls: 'turn:jp.relay.metered.ca:80', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:jp.relay.metered.ca:443', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:sg.relay.metered.ca:80', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:sg.relay.metered.ca:443', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' },
  { urls: 'turn:global.relay.metered.ca:80', username: '5bd3b785c789d8a13597e5bf', credential: 'VI7kyJaVnLrlIcLU' }
];

// [v196] 恒定返回 TURN-only 配置(等效强制中继), 不再动态拉取/不配 STUN(无直连候选)
function buildIceServers() {
  return Promise.resolve({ iceServers: TURN_SERVERS, iceTransportPolicy: 'all' });
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
  // [v181] MQTT 仅保进房: P2P 20s 未握手才启动 MQTT 兜底(只承载握手+低频控制消息,
  //   对局数据 state/input 永不走 MQTT)。P2P/TURN 连上即正常对局(对齐 v110 的"保联节点"设计)。
  let mqttClient = null;      // MQTT 兜底客户端(EMQX/HiveMQ 公共 broker)
  let relayTopic = null;      // MQTT 房间 topic: pma26/<code>
  let relayDeadline = null;   // 20s 未握手 → 启动 MQTT 兜底的定时器

  const handlers = {
    open: [], connected: [], state: [], input: [], close: [],
    progress: [], error: [], start: [],
    reset: [], rematchReady: [],
    aimode: [], aipick: [], aipickack: [], aistart: [], aipickstart: [], aicancel: [],
    // [v206] AI 新赛制·局间决策消息(低频控制消息, 与 aipick 系同模式)
    intermission: [], interpick: [], interpickack: [], intergo: [], interwarn: [],
  };
  function on(ev, fn) { (handlers[ev] || []).push(fn); }
  function emit(ev, arg) { (handlers[ev] || []).forEach(fn => { try { fn(arg); } catch (e) {} }); }
  // [v199] progress 带可选百分比(0-100): 加入/建房进度可视化。pct 不传时 null(阶段无进度含义, UI 保持当前值)
  function progress(msg, pct) { emit('progress', { text: msg, pct: (pct === undefined ? null : pct) }); }
  let signalFailTimer = null; // v199: 信令超时定时器提为模块级(供 abortJoin 清理)
  function setName(n) { playerName = n || ''; }
  function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

  // ============ 握手出口(连接那一刻锁定通道) ============
  function _emitConnected(payload, ch) {
    if (handshaked) return; // v181: 幂等 —— P2P/MQTT 双通道 hello 只会触发一次 connected
    handshaked = true;
    if (ch) mode = ch;                 // 锁定 / 更新传输通道(一次性决策)
    clearTimeout(p2pRetryTimer); p2pRetryTimer = null;
    clearTimeout(relayDeadline); relayDeadline = null; // v181: 握手完成, MQTT 兜底不再需要
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

      progress('正在获取 TURN 穿透服务...', 5);
      buildIceServers().then((ice) => {
      let resolved = false;
      const finish = (code) => {
        if (resolved) return;
        resolved = true; _startKeepAlive(); resolve(code);
      };
      try { peer = new Peer(PEER_PREFIX + roomCode, { debug: 1, config: ice }); }
      catch (e) { reject(e); return; }

      // v182: 信令超时兜底 —— 信令服务器(0.peerjs.com)偶发慢/失败时 peer.on('open') 永不触发,
      //   建房会永久卡住(概率性"点击 AI 对战卡死"根因)。15s 未 open → reconnect 重试提示;
      //   30s 仍失败 → reject 让上层提示重试(建房永不永久卡)。
      const signalRetryTimer = setTimeout(() => {
        if (peer && !peer.destroyed && !peer.open && !resolved) {
          progress('信令连接慢, 正在重试...', 8);
          try { peer.reconnect(); } catch (e) {}
        }
      }, 15000);
      signalFailTimer = setTimeout(() => {
        if (resolved) return;
        try { clearTimeout(signalRetryTimer); } catch (e) {}
        try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) {}
        peer = null; signalFailTimer = null;
        reject(new Error('信令连接超时, 请重试'));
      }, 30000);

      peer.on('open', () => {
        clearTimeout(signalRetryTimer); clearTimeout(signalFailTimer); signalFailTimer = null;
        progress('信令已就绪, 等待对手(P2P 直连优先)...', 20);
        finish(roomCode);
        // v181: 20s 未握手 → 启动 MQTT 兜底(仅保进房, 不承载对局数据)
        relayDeadline = setTimeout(() => { if (!handshaked) _startRelayListen(roomCode); }, 20000);
      });

      peer.on('connection', (c) => {
        // v162: 收到新连接时, 若旧连接未完成协商则先清理(避免并发 ICE 协商混乱, 恢复 v109 单连接穿透)
        if (conn && conn !== c) {
          if (conn.open) { c.close(); return; } // 已有可用直连, 丢弃新的
          try { conn.close(); } catch (e) {}
        }
        conn = c; mode = 'p2p';
        progress('P2P 直连已建立', 100);
        bindConn(c);
      });

      peer.on('disconnected', () => { progress('信令断开, 重连中...'); try { peer.reconnect(); } catch (e) {} });

      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          progress('房号冲突, 换号重试...', 8);
          clearTimeout(signalRetryTimer); clearTimeout(signalFailTimer);
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

      progress('正在获取 TURN 穿透服务...', 5);
      _joinResolve = (c) => { resolve(c); };
      _joinReject = (e) => { reject(e); };
      buildIceServers().then((ice) => {
        try { peer = new Peer({ debug: 1, config: ice }); }
        catch (e) { reject(e); return; }

        // v182: 信令超时兜底(client 侧, 与 host 对称) —— 信令偶发慢时 joinRoom 不永久卡
        signalFailTimer = setTimeout(() => {
          if (peer && !peer.open && _joinReject) {
            try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) {}
            peer = null; signalFailTimer = null;
            _joinReject(new Error('信令连接超时, 请重试'));
          }
        }, 30000);

        peer.on('open', () => {
          clearTimeout(signalFailTimer); signalFailTimer = null;
          progress('信令已就绪, 正在尝试 P2P 直连...', 20);
          _tryP2pConnect();
          // v181: 20s 未握手 → 启动 MQTT 兜底(仅保进房, 不承载对局数据)
          relayDeadline = setTimeout(() => { if (!handshaked) _startRelayListen(code); }, 20000);
        });

        peer.on('disconnected', () => { progress('信令断开, 重连中...'); try { peer.reconnect(); } catch (e) {} });

        peer.on('error', (err) => {
          // peer-unavailable 多为瞬态(主机信令尚未就绪), 重试由 _tryP2pConnect 的超时驱动
          if (err.type === 'peer-unavailable') { progress('主机暂时不可达, 重试 P2P...', 80); return; }
          progress('信令错误: ' + err.type, 80);
        });
      }).catch((e) => reject(e));
    });
  }
  // P2P 无限重试: 每次间隔 P2P_RETRY_GAP, 永不放弃(用户可手动点「切换中继」或「返回大厅」)
  // v162: 重试前清理旧未完成连接 —— 保持"单连接 ICE 协商"(对齐 v109), 避免多个并发 DataConnection
  // 同时收集候选/互相干扰, 那会降低 NAT 穿透成功率(穿透成功才走真 P2P 低延迟, 失败只能中继高延迟)
  // [v193] reliable: false —— 状态/输入改不可靠通道(丢帧不重传): 根治"家宽丢包→SCTP重传堆积→延迟滚雪球上千"振荡。
  //   30Hz 状态每帧覆盖, 丢一帧被下一帧顶掉视觉无感; 控制消息(start/reset/rmt/选风格等)靠 v181 双通道
  //   (P2P+MQTT)冗余兜底, 不受影响。坏网体验: 丢帧(偶发瞬移) 而非 卡顿上千。
  function _tryP2pConnect() {
    if (handshaked) return;
    if (!peer || peer.destroyed) return;
    // 清理上一个未完成的连接(若已 open 说明协商完成, 不会走到这; 未 open 的旧连接是残留, 关闭)
    if (conn && !conn.open) { try { conn.close(); } catch (e) {} }
    conn = null;
    p2pConnectAttempts++;
    progress('P2P 直连尝试 ' + p2pConnectAttempts + ' 次...', Math.min(80, 20 + p2pConnectAttempts * 10));
    const c = peer.connect(PEER_PREFIX + roomCode, { reliable: false, serialization: 'json' });
    conn = c; bindConn(c);
    p2pRetryTimer = setTimeout(() => {
      if (handshaked) return;
      _tryP2pConnect();   // 永不放弃, 持续重试 P2P
    }, p2pConnectAttempts <= 2 ? P2P_RETRY_GAP : P2P_RETRY_GAP_SLOW);
  }

  // 用户取消连接(返回大厅): 解阻塞 joinRoom
  // [v199] 取消加入(用户主动): 立即 reject + 销毁 peer + 清全部 timers, 防止后台泄漏/握手成功后强行进对局
  function abortJoin() {
    if (!_joinResolve && !_joinReject) return false;
    try { if (conn && !conn.open) conn.close(); } catch (e) {}
    try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) {}
    peer = null; conn = null;
    clearTimeout(p2pRetryTimer); p2pRetryTimer = null;
    clearTimeout(relayDeadline); relayDeadline = null;
    if (signalFailTimer) { clearTimeout(signalFailTimer); signalFailTimer = null; }
    if (mqttClient) { try { mqttClient.end(true); } catch (e) {} mqttClient = null; }
    _stopPingMonitor();
    const rj = _joinReject; _joinReject = null; _joinResolve = null;
    if (rj) rj(new Error('已取消加入'));
    return true;
  }

  // ============ [v181] MQTT 仅保进房兜底 ============
  // 用 EMQX 公共 broker(broker.emqx.io, 国内可达), 每个房间 topic: pma26/<code>
  // 职责边界: 只在 P2P 20s 未握手时启动, 仅承载 hello/world 握手 + 低频控制消息;
  //   state/input(对局数据)在 message 回调里直接丢弃 —— 对局通道永远只有 P2P/TURN。
  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  function _startRelayListen(code) { _relayConnect(code); }
  function _relayConnect(code) {
    if (typeof mqtt === 'undefined') return; // MQTT 库未加载(理论上 world.js 已加载)
    if (mqttClient && mqttClient.connected) return;
    relayTopic = 'pma26/' + code;
    const tryBroker = (idx) => {
      if (idx >= MQTT_BROKERS.length) return;
      try { if (mqttClient) mqttClient.end(true); } catch (e) {}
      mqttClient = null;
      const tag = idx === 0 ? 'EMQX' : 'HiveMQ';
      try {
        const clientId = 'pma26-' + role + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6);
        mqttClient = mqtt.connect(MQTT_BROKERS[idx], {
          clientId, clean: true, keepalive: 30,
          reconnectPeriod: 2000, connectTimeout: 10000
        });
      } catch (e) { tryBroker(idx + 1); return; }
      let helloRetryTimer = null;
      mqttClient.on('connect', () => {
        progress('中继兜底已连接(' + tag + '), 正在走通进房流程...', 85);
        try { mqttClient.subscribe(relayTopic, { qos: 0 }); } catch (e) {}
        // client 且尚未握手: 通过 MQTT 发 hello 兜底握手(重试直到握手完成)
        if (role === 'client' && !handshaked) {
          const sendHello = () => {
            if (handshaked) return;
            _relaySend({ t: 'hello', n: playerName });
            helloRetryTimer = setTimeout(sendHello, 1500);
          };
          setTimeout(sendHello, 300);
        }
      });
      mqttClient.on('message', (topic, payload) => {
        try {
          const msg = JSON.parse(payload.toString());
          if (!msg || !msg.t) return;
          if (msg.r === role) return; // 忽略自己发的
          if (msg.t === 'state' || msg.t === 'input') return; // 对局数据仅 P2P/TURN, MQTT 丢弃
          if (msg.t === 'hello') { _handleHello(msg, 'relay'); return; }
          if (msg.t === 'world') { _handleWorld(msg, 'relay'); return; }
          if (!_acceptSeq(msg)) return;
          _routeMsg(msg, 'relay');
        } catch (e) {}
      });
      mqttClient.on('error', () => {});
      mqttClient.on('offline', () => {});
      mqttClient.on('close', () => {});
    };
    tryBroker(0);
  }
  function _relaySend(obj) {
    try {
      if (!mqttClient || !mqttClient.connected) return;
      const m = Object.assign({}, obj, { r: role });
      mqttClient.publish(relayTopic, JSON.stringify(m), { qos: 0 });
    } catch (e) {}
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
    // [v206] AI 新赛制·局间决策消息
    else if (msg.t === 'intermission') emit('intermission', msg.p);   // host→client: 进决策(带牌池/血量)
    else if (msg.t === 'interpick') emit('interpick', msg);           // client→host: 选牌(带 ack 重发)
    else if (msg.t === 'interpickack') { emit('interpickack'); stopInterPickRetry(); }  // host 已收到, client 停止重发
    else if (msg.t === 'intergo') emit('intergo', msg.p);             // host→client: 揭晓+继续
    else if (msg.t === 'interwarn') emit('interwarn');              // host→client: 5s 预警
    else if (msg.t === 'ping') send({ t: 'pong', ts: msg.ts });
    else if (msg.t === 'pong') { const r = Date.now() - (msg.ts || 0); if (r >= 0 && r < 10000) rtt = r; }
  }

  function bindConn(c) {
    _watchSelectedPair(c);  // v164: 检测真实 ICE 通道(直连/TURN中继)
    c.on('open', () => {
      progress('P2P 已建立', 100);
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
          // [v188] 优先 nominated(真正被选中的对); 老浏览器不标 nominated 时退回任意 succeeded
          stats.forEach((r) => {
            if (r.type !== 'candidate-pair' || r.state !== 'succeeded') return;
            if (!sel || (r.nominated && !sel.nominated)) sel = r;
          });
          if (sel && sel.localCandidateId) {
            const local = stats.get(sel.localCandidateId);
            const remote = stats.get(sel.remoteCandidateId);
            const lt = local ? (local.candidateType || '') : '';
            const rt = remote ? (remote.candidateType || '') : '';
            // 任一侧 relay = 数据经 TURN 中继; 两侧均非 relay = 真直连
            _channelDetail = (lt === 'relay' || rt === 'relay') ? 'relay' : 'direct';
          }
        } catch (e) {}
      };
      poll();
      _channelTimer = setInterval(poll, 2000);
    } catch (e) {}
  }
  function getChannelDetail() { return _channelDetail; }

  // ============ 通用接口 ============
  // [v181] 单通道数据 + 控制消息双通道:
  //   - state/input(高频对局数据): 仅 P2P/TURN 通道(conn), 断开宁丢帧 —— 保持 v167 成果
  //   - 低频控制消息(start/reset/rmt/bye/aimode/aipick/aipickack/aistart/aips/aicxl + [v206] intermission/interpick/interpickack/intergo):
  //     双通道冗余(P2P + MQTT 兜底), 保证选风格确认/开战等关键流程可靠送达(v174 确认机制的上层保险)
  const CTRL_TYPES = ['start','reset','rmt','bye','aimode','aipick','aipickack','aistart','aips','aicxl',
                      'intermission','interpick','interpickack','intergo','interwarn'];
  function send(obj) {
    obj.q = ++sendSeq;
    if (conn && conn.open) { try { conn.send(obj); } catch (e) {} }
    if (CTRL_TYPES.indexOf(obj.t) !== -1 && mqttClient && mqttClient.connected) { _relaySend(obj); }
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
  // ===== [v206] AI 新赛制·局间决策消息 =====
  function sendIntermission(payload) { send({ t: 'intermission', p: payload }); }
  // client 选牌带重发(低频但关键: 丢一条永久丢 → 2s 重发至多 5 次, host 回 ack 停止)
  let _interPickTimer = null, _interPickSeq = 0;
  function sendInterPick(pickId) {
    const payload = { t: 'interpick', pick: pickId, i: ++_interPickSeq };
    let tries = 0;
    const fire = () => { if (tries >= 5) { clearInterval(_interPickTimer); _interPickTimer = null; return; } tries++; send(payload); };
    fire();
    clearInterval(_interPickTimer);
    _interPickTimer = setInterval(fire, 2000);
  }
  function sendInterPickAck() { send({ t: 'interpickack' }); } // host 回执, client 停止重发
  function sendInterGo(picks) { send({ t: 'intergo', p: picks }); }
  function sendInterWarn() { send({ t: 'interwarn' }); } // [v206] 5s 预警(host→client)
  // host 收到 interpickack 后 client 停止重发(由 main.js 的 interpickack 事件触发调用)
  function stopInterPickRetry() { clearInterval(_interPickTimer); _interPickTimer = null; }

  function getRole() { return role; }
  function isConnected() { return !!(conn && conn.open) || !!(mqttClient && mqttClient.connected && handshaked); }
  function isP2PReady() { return !!(conn && conn.open); } // v181: 对局数据通道(P2P/TURN)是否就绪
  function getRoomCode() { return roomCode; }
  function getMode() { return mode; }
  function getStateChannel() {
    // v181: 以真实数据通道为准 —— P2P/TURN 通道(conn)优先, 仅 MQTT 兜底握手时显示'relay'
    if (conn && conn.open) return 'p2p';
    if (mqttClient && mqttClient.connected && handshaked) return 'relay';
    return mode;
  }
  function getRtt() { return rtt; }

  function _cleanupP2P() {
    _stopKeepAlive();
    _channelDetail = '';   // [v188] 重置通道状态, 防跨局残留上一局标签(旧'relay/direct'会误显示)
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
    // v181: 清理 MQTT 兜底
    try { if (mqttClient) { mqttClient.end(true); } } catch (e) {}
    mqttClient = null; relayTopic = null;
    clearTimeout(relayDeadline); relayDeadline = null;
  }

  return {
    on, hostRoom, joinRoom, abortJoin,
    sendState, sendInput, sendReset, sendBye, sendStart, sendRematchReady,
    sendAiMode, sendAiPick, sendAiPickAck, sendAiStart, sendAiPickStart, sendAiCancel,
    // [v206] AI 新赛制·局间决策消息
    sendIntermission, sendInterPick, sendInterPickAck, sendInterGo, sendInterWarn, stopInterPickRetry,
    setName, getRole, isConnected, isP2PReady, getRoomCode, getMode, getRtt, getStateChannel, getChannelDetail, close
  };
})();
