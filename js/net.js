// net.js · 网络层: PeerJS P2P(主, 优先) + WebSocket 中继(并行备用·保联机房)
// 设计原则: P2P 直连优先(同 WiFi/局域网 10~30ms, 跨网经 TURN 真·P2P 亦远低于境外 broker 中继);
//   中继仅作"保联机房"兜底——P2P 宽限(20s)内未连上才并行启用中继且不放弃 P2P, P2P 迟到自动接管.
// 改进点:
//   1. 多 STUN + 免费 TURN(openrelay.metered.ca) 提升 NAT 穿透成功率(对称 NAT 也能真·P2P)
//   2. 信令断线自动重连(peer.disconnected -> reconnect)
//   3. 连接超时检测 + 详细错误类型回调
//   4. P2P 优先 / 中继并行备用: send() 永远 P2P 优先, 双通道同发同序号, 接收端去重防回跳

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
  // [v121 修复] 握手完成标记: 只有真正收到对端 hello/world 才算"对上了".
  // 旧代码用 conn.open 判断是否需要启用中继备用 —— 但 PeerJS 的 'connection' 事件在
  // 收到 offer 时就触发(ICE 还没通), 那里 clearTimeout 掉了中继兜底定时器; 若随后 ICE 失败,
  // host 就永远不会订阅中继 topic, 而 client 已回落中继, hello 发进了没人听的频道
  // => "客户端进去了, 主机毫无反应"。改为一律以握手是否完成为准。
  let handshaked = false;
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
    reset: [], rematchReady: [],
    aimode: [], aipick: [], aistart: [], aipickstart: [], aicancel: []
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
      handshaked = false;
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
      // [P2P 优先·并行备用] 不放弃 P2P, 仅并行启动中继作为"保联机房"兜底;
      // P2P 后续连入会自动接管(send 优先 P2P), 故中继延迟尖刺只在 P2P 真正不可达时出现
      const toRelayBackup = () => {
        if (relayStarted) return;
        relayStarted = true;
        _startRelayBackup(roomCode, () => finish(roomCode));
      };
      try {
        peer = new Peer(PEER_PREFIX + roomCode, { debug: 1, config: ICE_SERVERS });
      } catch (e) { reject(e); return; }

      peer.on('open', () => {
        progress('信令已就绪, 等待对手...');
        finish(roomCode);
        // [v133 修复] 主机信令就绪后即并行订阅中继通道(被动监听), 不再等 20s 兜底才订阅:
        // client 走中继进房时主机早已在监听, 立刻收到 hello 并刷新"对手已加入"界面,
        // 根治「客户端以中继连接进入房间后主机不检测/刷新 + 客户端在 20s 不稳定窗口反复断重连」。
        // 中继仅承载控制消息(state 仍走 P2P, 见 send()), 早订阅不引入任何延迟, 纯保联机房。
        _startRelayBackup(roomCode, () => {});
        // [P2P 优先·长宽限] 用户明确要求"宁等多几秒也要 P2P", 给 P2P(含 TURN)充足建连时间,
        // 20s 内握手仍未完成才并行启动中继备用(不放弃 P2P); 内置免费 TURN 后对称 NAT 1~3s 即建连
        // [v121] 判据从 conn.open 改为 handshaked, 且此定时器不再被任何地方 clear ——
        // 只要没真正握上手, 中继备用一定会起来, 杜绝"主机永不订阅中继"的死角
        connectDeadline = setTimeout(() => { if (!handshaked) toRelayBackup(); }, 20000);
        // 二次保险: 40s 仍未握手(P2P 慢 + 首个中继 broker 挂掉), 再催一次
        setTimeout(() => { if (!handshaked) { relayStarted = false; toRelayBackup(); } }, 40000);
      });

      peer.on('connection', (c) => {
        // [v121] 这里绝不能 clearTimeout(connectDeadline): 'connection' 只代表收到了 offer,
        // ICE 可能随后失败。旧代码在此清掉兜底定时器, 是"客户端进来了主机没反应"的根因。
        if (conn && conn.open && conn !== c) { c.close(); return; } // 已有直连, 丢弃重复
        // [P2P 优先] 即便已并行启用中继备用通道, 只要 P2P 直连连入就优先接管
        // (用户诉求: 中继延迟 800ms 没法玩, 能走 P2P 一律走 P2P, 中继仅"保联机房")
        conn = c;
        mode = 'p2p';
        progress('P2P 直连已建立, 优先使用低延迟通道');
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
        // 其他错误(含信令服务器被墙/不可达): 并行启用中继备用(保留 P2P 重试)
        progress('信令错误: ' + err.type + ', 启用中继备用...');
        if (!resolved) toRelayBackup();
      });

      // 兜底: 4 秒内信令仍未就绪(如 peerjs 云被墙), 并行启用中继备用, 避免无限等待
      setTimeout(() => { if (!resolved) toRelayBackup(); }, 4000);
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
      handshaked = false;
      progress('正在连接信令服务器...');
      let resolved = false;
      const finish = (c) => { if (resolved) return; resolved = true; clearTimeout(joinTimeout); _startKeepAlive(); resolve(c); };
      try {
        peer = new Peer({ debug: 1, config: ICE_SERVERS });
      } catch (e) { reject(e); return; }

      // [v134 修复] 整体兜底: 双通道(P2P + 中继)都连不上(极端弱网 / 信令与所有 broker 全挂)时,
      // 25s 后明确报错, 不再无限转圈(避免用户误以为卡死)
      const joinTimeout = setTimeout(() => {
        if (!resolved) { progress('连接超时'); reject(new Error('连接超时, 请检查网络后重试')); }
      }, 25000);

      peer.on('open', () => {
        progress('信令已就绪, 正在连接主机(P2P 直连优先)...');
        // [稳定性修复] reliable:true(有序可靠通道): 旧版不可靠通道会静默丢失 start/reset
        // 等关键控制消息, 导致"主机点了开始/重开, 客户端没反应"; 状态包小且 30Hz, 可靠通道足够流畅
        conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
        bindConn(conn);
        // [P2P 优先] P2P 直连一就绪立即 resolve(不等中继), 直连优先接管
        conn.on('open', () => {
          if (!resolved) finish(code);
          mode = 'p2p';
          progress('P2P 直连已建立, 优先使用低延迟通道');
        });

        // [v134 修复] 客户端进房即并行启动中继备用(不等 20s 宽限): 主机建房时已并行订阅中继(v133),
        // P2P 瞬态 peer-unavailable / 首次点击偶发失败时, 中继会在 1~3s 内兜底连上并 resolve,
        // 根治「分享到世界后客户端首次点击加入失败、需二次点击」。P2P 仍优先(先连上先 resolve),
        // 中继仅保联机房(见 send() 路由, state 只走 P2P, 不影响手感)。
        _startRelayBackup(code, () => finish(code));
      });

      peer.on('disconnected', () => {
        progress('信令断开,重连中...');
        try { peer.reconnect(); } catch(e){}
      });

      peer.on('error', (err) => {
        // [v136] peer-unavailable 多为瞬态(主机信令尚未就绪 / 未传播到 broker), 不再立即判失败:
        // 中继已并行启动会兜底连上; 仅其它致命错误才提示, 且中继也会继续保联
        if (err.type === 'peer-unavailable') {
          progress('主机暂时不可达, 中继通道保联中...');
          return;
        }
        progress('信令错误: ' + err.type + ', 中继通道保联中...');
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
  // 握手成功统一出口(置位 handshaked, 供中继兜底判定)
  function _emitConnected(payload) {
    handshaked = true;
    // [v129] P2P 一旦真正握上手, 立即并行拉起中继备用通道(双通道冗余):
    // 之前中继只在「20s 未握手」才启动, 导致 P2P 连上后 client→host 控制消息
    // (aipick / rmt / aistart 等) 在 P2P 单向掉线时没有任何兜底, 表现为
    // 「客户端已确认 / 点再来一局 主机收不到」。中继仅承载控制消息(state 仍走 P2P,
    // 见 send()), 不影响手感, 纯保联机房。_startRelayBackup 对已连中继是 no-op, 可重复调用。
    if (mode === 'p2p' && roomCode) {
      try { _startRelayBackup(roomCode, () => {}); } catch (e) {}
    }
    emit('connected', payload || { name: '' });
  }
  // 通用消息路由(P2P 与中继共用)
  function _routeMsg(msg) {
    if (msg.t === 'state')       emit('state', msg.s);
    else if (msg.t === 'input')  emit('input', msg.c);
    else if (msg.t === 'bye')    emit('close');
    else if (msg.t === 'reset')  emit('reset');
    else if (msg.t === 'start')  emit('start');
    else if (msg.t === 'rmt')    emit('rematchReady');
    else if (msg.t === 'aimode') emit('aimode');                                 // host 通知 client: 本房是 AI 对战, 去选风格
    else if (msg.t === 'aipick') emit('aipick', msg.id);                         // client 把自己选的风格 id 发给 host
    else if (msg.t === 'aistart') emit('aistart', msg.cfg);                      // host 把双方风格下发给 client 并开打
    else if (msg.t === 'aips')   emit('aipickstart');                            // host 点「进入选风格」: 双方一起进选风格屏
    else if (msg.t === 'aicxl')  emit('aicancel');                               // host 从选风格屏退回等待大厅
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
      if (msg.t === 'hello') _emitConnected({ name: msg.n || '' });
      else _routeMsg(msg);
    });
    c.on('close', () => {
      lastP2pRecv = 0; // P2P 断开
      // [P2P 优先·并行备用] 若中继已连(并行备用场景)则静默回落中继; 否则懒启动中继兜底
      if (mqttClient && mqttClient.connected) {
        mode = 'relay';
        progress('P2P 断开, 自动回落中继备用通道(保联机房)');
        return;
      }
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

  // [P2P 优先·并行备用] 不销毁 P2P, 仅并行启动中继作为"保联机房"兜底.
  // 与 _fallbackToRelay(彻底放弃 P2P) 不同: 此函数保留 P2P 握手, P2P 后续连入会自动接管
  // (send 优先 P2P), 故中继延迟尖刺只在 P2P 真正不可达时才出现. 双方都连上后中继变空闲备份,
  // P2P 断开瞬间无缝回落中继(双通道同发同序号, 接收端去重防回跳/重复出招).
  function _startRelayBackup(code, resolve) {
    if (mqttClient && mqttClient.connected) { if (resolve) resolve(code); return; }
    mode = (conn && conn.open) ? 'p2p' : 'relay';
    relayTopic = 'pma26/' + code;
    progress('P2P 直连建立中, 已并行启用中继备用通道');
    _relayConnect(code, resolve, () => {
      // 中继备用也连不上: 退回纯 P2P, P2P 后续断开时会再尝试兜底
      progress('中继备用不可用, 仅保留 P2P 直连');
      mode = (conn && conn.open) ? 'p2p' : 'relay';
    });
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
            _emitConnected({ name: '' });
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
              _emitConnected({ name: msg.n || '' });
            }
            // host 每次收到 hello 都回 world 带名字, 确保 client 能收到
            if (role === 'host') _relaySend({ t: 'world', n: playerName });
          } else if (msg.t === 'world') {
            // client 收到 host 确认
            if (!peerReady) {
              peerReady = true;
              if (helloRetryTimer) { clearTimeout(helloRetryTimer); helloRetryTimer = null; }
              progress('已连接主机');
              _emitConnected({ name: msg.n || '' });
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
    const viaP2P = !!(conn && conn.open);
    const viaRelay = !!(mqttClient && mqttClient.connected);
    // [v122 修复] 双通道冗余发送(原设计意图见 _startRelayBackup 注释"双通道同发同序号"):
    // 控制消息 P2P 与中继各发一份, 任一侧通道"假死"(发送端 conn.open 但对端已断)也能送达;
    // 接收端 _acceptSeq 用同序号去重, 不会重复处理。
    // 仅当"两条都通"时冗余 —— 这正是"非对称断链"场景(host→client 的 state 走活着的通道,
    // 而 client→host 的 rmt 只走了已死的 P2P 被丢弃)的根因: 表现为对局正常, 但客户端点
    // "再来一局"主机收不到。状态包(state)只走 P2P, 省中继带宽、保留 v119 中继降码率成果。
    if (viaP2P && viaRelay) {
      if (obj.t === 'state') {
        try { conn.send(obj); } catch (e) {}
      } else {
        try { conn.send(obj); } catch (e) {}
        _relaySend(obj);
      }
      return;
    }
    // 仅单通道可用时走唯一可用通道
    if (viaP2P) { try { conn.send(obj); } catch (e) {} return; }
    if (viaRelay) _relaySend(obj);
  }
  function sendState(s) { send({ t: 'state', s }); }
  function sendInput(c) { send({ t: 'input', c }); }
  function sendReset()  { send({ t: 'reset' }); }
  function sendBye()    { send({ t: 'bye' }); }
  function sendStart() { send({ t: 'start' }); }
  function sendRematchReady() { send({ t: 'rmt' }); }
  // ===== AI 对战观战模式专用消息 =====
  function sendAiMode() { send({ t: 'aimode' }); }
  function sendAiPick(id) { send({ t: 'aipick', id }); }
  function sendAiStart(cfg) { send({ t: 'aistart', cfg }); }
  function sendAiPickStart() { send({ t: 'aips' }); }
  function sendAiCancel() { send({ t: 'aicxl' }); }

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
    handshaked = false;
    clearTimeout(connectDeadline); connectDeadline = null;
    sendSeq = 0; lastRecvSeq = 0; lastP2pRecv = 0; rtt = 0; // 新会话重置去重/路由状态
    _stopPingMonitor();
  }

  return {
    on, hostRoom, joinRoom, hostRelay, joinRelay,
    sendState, sendInput, sendReset, sendBye, sendStart, sendRematchReady,
    sendAiMode, sendAiPick, sendAiStart, sendAiPickStart, sendAiCancel,
    setName, getRole, isConnected, getRoomCode, getMode, getRtt, close
  };
})();
