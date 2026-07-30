// net.js · 网络层: PeerJS P2P(主) + WebSocket 中继(备选)
// 改进点:
//   1. 多 STUN 服务器,提升 NAT 穿透成功率
//   2. 信令断线自动重连(peer.disconnected -> reconnect)
//   3. 连接超时检测 + 详细错误类型回调
//   4. 提供 relay 模式(ntfy.sh 免费 pub/sub),P2P 失败时备选

// TURN 配置槽: 用于"对称 NAT"兜底——无 TURN 时这类网络会退回公共 broker 中继(200ms+ 高延迟)
// 根治方案: 部署自托管 coturn(见仓库 deploy/turn/ 目录的 docker-compose 与说明),
//   启动后把下面的 TURN 凭据填进本数组即生效, 无需改其它代码
// [免费即用] 已内置 Metered 公共 TURN(openrelay.metered.ca, 20GB/月免费, 跑在 80/443 端口能穿透多数防火墙),
//   对称 NAT 也能走真·P2P 中继(延迟远低于海外 MQTT broker), 不再被迫走公共 broker
const TURN_SERVERS = [
  // 免费公共 TURN(开箱即用, 无需账号): 对称 NAT 下经它中继实现真·P2P
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  // 自托管 TURN 填这里(生产更稳, 把上面两条删掉换成你自己的):
  // { urls: 'turn:turn.your-domain.com:3478?transport=tcp', username: 'pma', credential: 'YOUR_SECRET' },
  // { urls: 'turn:turn.your-domain.com:3478?transport=udp', username: 'pma', credential: 'YOUR_SECRET' }
];
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    ...TURN_SERVERS
  ],
  // 提高穿透概率
  iceTransportPolicy: 'all'
};

const PEER_PREFIX = 'pma26-';

const Net = (() => {
  let peer = null;
  let conn = null;
  let role = null;
  let roomCode = null;
  let mode = 'p2p'; // 'p2p' | 'relay'
  let keepAliveTimer = null;
  let connectDeadline = null;
  let playerName = ''; // 本地玩家名, 连接时发给对方
  // [同步修复] 双通道去重序号: P2P 与中继同发同一条消息, 慢通道晚到的旧拷贝
  // 会覆盖新状态(画面回跳)/重复触发攻击(重复出招), 用单调序号 q 丢弃重复与过期包
  let sendSeq = 0;     // 发送序号
  let lastRecvSeq = 0; // 已处理的最大对端序号
  let lastP2pRecv = 0; // 最近一次收到 P2P 包的时间(ms), 用于判断 P2P 是否停滞
  let rtt = 0;          // 最近一次往返时延(ms), 由 ping/pong 测量
  let pingTimer = null; // 周期性 ping 定时器

  // [致命修复] 旧版事件表漏了 reset/resync 键: on('reset')/on('resync') 注册进的是
  // 临时数组, 回调被静默丢弃 —— 主机重开对局客户端永远收不到、客户端请求刷新主机
  // 永远收不到, 这是"两端画面各玩各的"的核心根因之一
  const handlers = {
    open: [], connected: [], state: [], input: [], close: [],
    progress: [], error: [], start: [],
    reset: [], resync: [], rematchReady: []
  };
  function on(ev, fn) { (handlers[ev] || []).push(fn); }
  function emit(ev, arg) { (handlers[ev] || []).forEach(fn => { try { fn(arg); } catch(e){} }); }
  function progress(msg) { emit('progress', msg); }
  function setName(n) { playerName = n || ''; }

  function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

  // ============ P2P 模式 ============
  function hostRoom() {
    mode = 'p2p';
    return _p2pHost();
  }

  function _p2pHost() {
    return new Promise((resolve, reject) => {
      role = 'host';
      roomCode = genCode();
      progress('正在连接信令服务器...');
      let resolved = false;
      // 统一出口: 无论 P2P 还是中继连上, 都 resolve hostRoom, 否则建房会永远卡住
      const finish = (code) => {
        if (resolved) return;
        resolved = true;
        _startKeepAlive();
        resolve(code);
      };
      let relayStarted = false;
      const toRelay = () => {
        if (relayStarted) return;
        relayStarted = true;
        progress('P2P 信令不可用, 切换中继模式...');
        mode = 'relay';
        relayTopic = 'pma26/' + roomCode;
        _relayConnect(roomCode, () => finish(roomCode), () => {
          progress('中继连接失败, 请检查网络后重试');
          reject(new Error('中继连接失败'));
        });
      };
      try {
        peer = new Peer(PEER_PREFIX + roomCode, { debug: 1, config: ICE_SERVERS });
      } catch (e) { reject(e); return; }

      peer.on('open', () => {
        progress('信令已就绪, 等待对手...');
        finish(roomCode);
        // [跨网兜底] 信令就绪后给 P2P(含 TURN 中继)充足时间建连, 15s 内无对手经 P2P 连入才转中继
        // 内置免费 TURN(openrelay.metered.ca)后, 对称 NAT 也能在 1~3s 走 TURN 真·P2P 建连, 定时器极少触发;
        // 同网/可直连更在 1s 内连上 → 不再像 v80 那样 6s 盲转中继把同网 P2P 杀掉
        connectDeadline = setTimeout(() => { if (!conn || !conn.open) toRelay(); }, 15000);
      });

      peer.on('connection', (c) => {
        clearTimeout(connectDeadline); // P2P 连入即取消中继兜底定时器
        if (conn && conn.open) { c.close(); return; }
        // 若已切到中继且中继已连, 忽略 P2P 连接(以中继为准)
        if (mode === 'relay' && mqttClient && mqttClient.connected) { c.close(); return; }
        conn = c;
        bindConn(c);
      });

      peer.on('disconnected', () => {
        progress('信令断开, 尝试重连...');
        try { peer.reconnect(); } catch(e){}
      });

      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          progress('房号冲突, 换号重试...');
          peer.destroy(); roomCode = genCode();
          setTimeout(() => _p2pHost().then(resolve, reject), 200);
          return;
        }
        // 其他错误(含信令服务器被墙/不可达): 自动切中继
        progress('信令错误: ' + err.type + ', 切换中继...');
        if (!resolved) toRelay();
      });

      // 兜底: 4 秒内信令仍未就绪(如 peerjs 云被墙), 直接切中继, 避免无限等待
      setTimeout(() => { if (!resolved) toRelay(); }, 4000);
    });
  }

  function joinRoom(code) {
    mode = 'p2p';
    return _p2pJoin(code);
  }

  function _p2pJoin(code) {
    return new Promise((resolve, reject) => {
      role = 'client';
      roomCode = code;
      progress('正在连接信令服务器...');
      try {
        peer = new Peer({ debug: 1, config: ICE_SERVERS });
      } catch (e) { reject(e); return; }

      peer.on('open', () => {
        progress('信令已就绪,正在连接主机...');
        _startKeepAlive();
        // [稳定性修复] reliable:true(有序可靠通道): 旧版不可靠通道会静默丢失 start/reset
        // 等关键控制消息, 导致"主机点了开始/重开, 客户端没反应"; 状态包小且 30Hz, 可靠通道足够流畅
        conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        bindConn(conn);

        // P2P 建立超时检测: 给 TURN/STUN 充足握手时间(10s), 内置免费 TURN 后多数跨网 1~3s 即建连
        clearTimeout(connectDeadline);
        connectDeadline = setTimeout(() => {
          if (!conn || !conn.open) {
            progress('P2P 连接超时(可能 NAT 穿透失败),尝试中继模式...');
            _fallbackToRelay(code, resolve, reject);
          }
        }, 10000);

        conn.on('open', () => {
          clearTimeout(connectDeadline);
          resolve(code);
        });
      });

      peer.on('disconnected', () => {
        progress('信令断开,重连中...');
        try { peer.reconnect(); } catch(e){}
      });

      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          reject(new Error('房间不存在或已关闭'));
        } else {
          progress('错误: ' + err.type + ',尝试中继...');
          _fallbackToRelay(code, resolve, reject);
        }
      });
    });
  }

  // 信令保活: 每 25s 发个 ping
  function _startKeepAlive() {
    clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      if (peer && !peer.destroyed && peer.disconnected) {
        try { peer.reconnect(); } catch(e){}
      }
    }, 25000);
  }
  function _stopKeepAlive() { clearInterval(keepAliveTimer); keepAliveTimer = null; }

  // 实时 RTT/ping 测量: 每秒发一次 ping, 对方回 pong, 用时间戳差算往返时延
  // 走 send() 现有路由(P2P 优先/中继兜底), 故测到的是当前实际活跃通道的延迟
  function _sendPing() { if (isConnected()) send({ t: 'ping', ts: Date.now() }); }
  function _startPingMonitor() { clearInterval(pingTimer); pingTimer = setInterval(_sendPing, 1000); }
  function _stopPingMonitor() { clearInterval(pingTimer); pingTimer = null; }
  function getRtt() { return rtt; }

  // 序号判定: 只接受比已见更新的消息; 对端刷新页面后序号会从头开始, 差距悬殊时视为新会话
  function _acceptSeq(msg) {
    // 控制/握手消息(ping/pong/hello/world)幂等, 不参与去重 —— 否则会因两台机器
    // 各自独立的 sendSeq 计数器, 导致对端回的 pong 序号偏小被当「过期包」丢弃,
    // RTT 永远测不出(右上角一直显示 …)
    if (msg.t === 'ping' || msg.t === 'pong' || msg.t === 'hello' || msg.t === 'world') return true;
    if (msg.q === undefined) return true; // 兼容无序号的旧客户端
    if (msg.q > lastRecvSeq) { lastRecvSeq = msg.q; return true; }
    if (lastRecvSeq - msg.q > 5000) { lastRecvSeq = msg.q; return true; } // 对端重启
    return false; // 重复/过期拷贝, 丢弃
  }
  // 通用消息路由(P2P 与中继共用)
  function _routeMsg(msg) {
    if (msg.t === 'state')       emit('state', msg.s);
    else if (msg.t === 'input')  emit('input', msg.c);
    else if (msg.t === 'bye')    emit('close');
    else if (msg.t === 'reset')  emit('reset');
    else if (msg.t === 'resync') emit('resync');
    else if (msg.t === 'start')  emit('start');
    else if (msg.t === 'rmt')    emit('rematchReady');
    else if (msg.t === 'ping')  { send({ t: 'pong', ts: msg.ts }); } // 收到 ping 立即回 pong
    else if (msg.t === 'pong')  { const r = Date.now() - (msg.ts || 0); if (r >= 0 && r < 10000) rtt = r; } // 计算 RTT
  }

  function bindConn(c) {
    c.on('open', () => {
      progress('P2P 已建立');
      _startPingMonitor(); // 连接就绪后启动 RTT 测量
      // 连接建立后发送 hello 带自己的名字
      try { c.send({ t: 'hello', n: playerName, q: ++sendSeq }); } catch(e){}
    });
    c.on('data', (msg) => {
      if (!msg || !msg.t) return;
      if (!_acceptSeq(msg)) return;
      lastP2pRecv = Date.now(); // 标记 P2P 活跃, 用于自适应路由判定
      if (msg.t === 'hello') emit('connected', { name: msg.n || '' });
      else _routeMsg(msg);
    });
    c.on('close', () => {
      lastP2pRecv = 0; // P2P 断开
      // [v77 修正] 仅在 P2P 真正断开时懒启动中继兜底(平时不常驻境外通道, 避免延迟尖刺)
      // 若中继已连(初始失败回退场景)则静默切换; 否则懒启动中继, 失败才报连接中断
      if (mqttClient && mqttClient.connected) { progress('P2P 断开, 已自动切至中继通道'); return; }
      if (roomCode) { progress('P2P 断开, 尝试中继兜底...'); _fallbackToRelay(roomCode, () => {}, () => emit('close')); return; }
      emit('close');
    });
    c.on('error', () => {
      if (mqttClient && mqttClient.connected) { progress('P2P 通道错误, 使用中继通道'); return; }
      emit('error', new Error('P2P 连接错误'));
    });
  }

  // ============ 中继模式(MQTT over WebSocket) ============
  // 用 EMQX 公共 broker(broker.emqx.io),国内可达,对 WebSocket 友好
  // 每个房间用 topic: pma26/<code>,双方都订阅同一 topic
  let mqttClient = null;
  let relayTopic = null;

  // 中继 broker 列表(按顺序回退): 公共 broker 偶发不可用, 自动切下一个, 减少"连接中断"
  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  function _fallbackToRelay(code, resolve, reject) {
    progress('切换到中继模式...');
    _cleanupP2P();
    mode = 'relay';
    relayTopic = 'pma26/' + code;
    _relayConnect(code, resolve, reject);
  }

  function _relayConnect(code, resolve, reject) {
    if (typeof mqtt === 'undefined') {
      reject(new Error('MQTT 库未加载,请检查网络后重试'));
      return;
    }
    // 按顺序尝试 broker 列表, 当前不可用自动切下一个
    const tryBroker = (idx) => {
      if (idx >= MQTT_BROKERS.length) {
        reject(new Error('中继连接失败: 所有 broker 均不可用'));
        return;
      }
      try { if (mqttClient) mqttClient.end(true); } catch (e) {} // 切 broker 前结束上一个
      mqttClient = null;
      let resolved = false;
      let peerReady = false;
      let helloRetryTimer = null;
      const tag = idx === 0 ? 'EMQX' : 'HiveMQ';

      try {
        const clientId = 'pma26-' + role + '-' + Date.now() + '-' + Math.random().toString(16).slice(2,6);
        mqttClient = mqtt.connect(MQTT_BROKERS[idx], {
          clientId, clean: true, keepalive: 30,
          reconnectPeriod: 2000, connectTimeout: 10000
        });
      } catch (e) {
        tryBroker(idx + 1); return;
      }

      mqttClient.on('connect', () => {
        if (!resolved) {
          resolved = true;
          progress('中继已连接(' + tag + '),等待对手...');
          mqttClient.subscribe(relayTopic, { qos: 0 });
          _startPingMonitor(); // 中继就绪后也启动 RTT 测量
          resolve(code); // 连上 broker 即 resolve,不等对手
          // client 主动发 hello 带名字, 并重发直到收到 world
          if (role === 'client') {
            const sendHello = () => {
              if (peerReady) return;
              _relaySend({ t: 'hello', n: playerName });
              helloRetryTimer = setTimeout(sendHello, 1500);
            };
            setTimeout(sendHello, 300);
          }
        } else {
          progress('中继已重连');
          try { mqttClient.subscribe(relayTopic, { qos: 0 }); } catch(e){}
          // 重连后若已就绪, 重新握手并通知上层恢复(让宽限期清除)
          if (peerReady) {
            if (role === 'client') _relaySend({ t: 'hello', n: playerName });
            // host 收到 hello 会自动回 world
            emit('connected', { name: '' });
          }
        }
      });

      mqttClient.on('message', (topic, payload) => {
        try {
          const msg = JSON.parse(payload.toString());
          if (!msg || !msg.t) return;
          if (msg.r === role) return;
          if (msg.t === 'hello') {
            if (!peerReady) {
              peerReady = true;
              progress('对手已加入');
              emit('connected', { name: msg.n || '' });
            }
            // host 每次收到 hello 都回 world 带名字, 确保 client 能收到
            if (role === 'host') _relaySend({ t: 'world', n: playerName });
          } else if (msg.t === 'world') {
            // client 收到 host 确认
            if (!peerReady) {
              peerReady = true;
              if (helloRetryTimer) { clearTimeout(helloRetryTimer); helloRetryTimer = null; }
              progress('已连接主机');
              emit('connected', { name: msg.n || '' });
            }
          } else {
            // 游戏消息统一走去重(hello/world 握手消息不去重, 允许重发)
            if (!_acceptSeq(msg)) return;
            _routeMsg(msg);
          }
        } catch (e) {}
      });

      mqttClient.on('error', (err) => {
        if (!resolved) {
          // 当前 broker 不可用, 顺序尝试下一个
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
    if (obj.q === undefined) obj.q = ++sendSeq; // 直发中继的消息也带序号
    try {
      mqttClient.publish(relayTopic, JSON.stringify(obj), { qos: 0 });
    } catch (e) {}
  }

  // 主动用中继模式建房/加入
  function hostRelay() {
    mode = 'relay';
    role = 'host';
    roomCode = genCode();
    relayTopic = 'pma26/' + roomCode;
    return new Promise((resolve, reject) => {
      progress('正在连接中继服务器...');
      _relayConnect(roomCode, resolve, reject);
    });
  }
  function joinRelay(code) {
    mode = 'relay';
    role = 'client';
    roomCode = code;
    relayTopic = 'pma26/' + code;
    return new Promise((resolve, reject) => {
      progress('正在连接中继服务器...');
      _relayConnect(code, resolve, reject);
    });
  }

  // ============ 通用接口 ============
  function send(obj) {
    obj.q = ++sendSeq;
    // P2P 优先: 直连可用时一律走 P2P(同 WiFi/局域网延迟极低, 北京本地约 10~30ms)
    // 仅当 P2P 彻底断开(conn 未 open)才退回中继 —— 不再因「P2P 短暂停滞」就切到境外
    // 公共 broker.emqx.io, 那会引入 200ms+ 延迟尖刺(正是此前「加房延迟变大/掉线」的根因)
    if (conn && conn.open) {
      try { conn.send(obj); } catch (e) {}
      return;
    }
    if (mqttClient && mqttClient.connected) _relaySend(obj);
  }
  function sendState(s) { send({ t: 'state', s }); }
  function sendInput(c) { send({ t: 'input', c }); }
  function sendReset()  { send({ t: 'reset' }); }
  function sendResync() { send({ t: 'resync' }); }
  function sendBye()    { send({ t: 'bye' }); }
  function sendStart() { send({ t: 'start' }); }
  function sendRematchReady() { send({ t: 'rmt' }); }

  function getRole() { return role; }
  function isConnected() {
    return !!(conn && conn.open) || !!(mqttClient && mqttClient.connected);
  }
  function getRoomCode() { return roomCode; }
  function getMode() {
    if (conn && conn.open) return 'p2p';
    if (mqttClient && mqttClient.connected) return 'relay';
    return 'p2p';
  }

  function _cleanupP2P() {
    _stopKeepAlive();
    clearTimeout(connectDeadline);
    try { if (conn && conn.open) conn.close(); } catch(e){}
    try { if (peer) peer.destroy(); } catch(e){}
    conn = null; peer = null;
  }
  function close() {
    _cleanupP2P();
    try { if (mqttClient) mqttClient.end(true); } catch(e){}
    mqttClient = null; relayTopic = null;
    role = null; roomCode = null; mode = 'p2p';
    sendSeq = 0; lastRecvSeq = 0; lastP2pRecv = 0; rtt = 0; // 新会话重置去重/路由状态
    _stopPingMonitor();
  }

  return {
    on, hostRoom, joinRoom, hostRelay, joinRelay,
    sendState, sendInput, sendReset, sendResync, sendBye, sendStart, sendRematchReady,
    setName, getRole, isConnected, getRoomCode, getMode, getRtt, close
  };
})();
