// world.js · 世界频道: 通过 MQTT 分享房间号, 让其他玩家可以看到并加入
// 使用 EMQX 公共 broker(broker.emqx.io), topic: pma26/world
// 玩家可将自己的房间号分享到世界频道, 也可看到其他玩家分享的房间
// 依赖: MQTT 库(CDN 全局变量 mqtt), 与 net.js 共用同一 broker

const World = (() => {
  const MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
  const WORLD_TOPIC = 'pma26/world';
  const MAX_ROOMS = 20;                   // 房间列表最大容量
  const EXPIRE_MS = 5 * 60 * 1000;        // 房间过期时间 5 分钟
  const CLEAN_INTERVAL = 30 * 1000;       // 清理过期房间间隔 30 秒
  const REBROADCAST_INTERVAL = 60 * 1000; // 重新广播自己房间间隔 60 秒

  let client = null;           // MQTT 客户端
  let connected = false;       // 是否已连接
  let selfPlayerId = null;     // 自己的 playerId, 用于防抖(忽略自己发出的消息)
  let rooms = [];              // 世界频道房间列表(来自其他玩家)
  let myShares = {};           // 自己正在分享的房间 { roomCode: {roomCode, playerName, playerId, mode, ts} }
  let cleanTimer = null;       // 清理过期房间定时器
  let rebroadcastTimer = null; // 重新广播自己房间定时器
  let updateCallbacks = [];    // 房间列表更新回调

  // ============ 回调管理 ============
  // 去重注册: 同一函数只保留一份, 避免多次进入大厅导致重复渲染
  function onUpdate(fn) {
    if (typeof fn !== 'function') return;
    if (!updateCallbacks.includes(fn)) updateCallbacks.push(fn);
  }
  // 清空所有回调(供 close/destroy 调用, 防止旧引用泄漏)
  function clearCallbacks() {
    updateCallbacks.length = 0;
  }
  // 触发所有更新回调, 传入房间列表副本
  function emitUpdate() {
    const snapshot = rooms.slice();
    updateCallbacks.forEach(fn => { try { fn(snapshot); } catch (e) {} });
  }

  // ============ 房间列表维护 ============
  // 更新或新增房间到列表(按 roomCode 去重)
  function _upsertRoom(room) {
    const idx = rooms.findIndex(r => r.roomCode === room.roomCode);
    if (idx >= 0) rooms[idx] = room;
    else rooms.push(room);
    // 按时间倒序(新的在前)
    rooms.sort((a, b) => b.ts - a.ts);
    // 超过最大容量, 截断
    if (rooms.length > MAX_ROOMS) rooms.length = MAX_ROOMS;
  }

  // 从列表移除指定房间号, 返回是否有变化
  function _removeRoom(roomCode) {
    const before = rooms.length;
    rooms = rooms.filter(r => r.roomCode !== roomCode);
    return rooms.length !== before;
  }

  // 清理过期房间(超过 5 分钟未更新)
  function _cleanExpired() {
    const now = Date.now();
    const before = rooms.length;
    rooms = rooms.filter(r => (now - r.ts) < EXPIRE_MS);
    if (rooms.length !== before) emitUpdate();
  }

  // ============ 消息处理 ============
  function _handleMessage(topic, payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch (e) { return; }
    if (!msg || !msg.type) return;

    // 防抖: 忽略自己发出的分享消息(用 playerId 判断)
    if (selfPlayerId && msg.playerId === selfPlayerId) return;

    if (msg.type === 'share') {
      // 收到其他玩家的房间分享
      if (!msg.roomCode || !msg.playerId) return;
      _upsertRoom({
        roomCode: msg.roomCode,
        playerName: msg.playerName || '玩家',
        playerId: msg.playerId,
        mode: msg.mode || 'P2P',
        ts: msg.ts || Date.now()
      });
      emitUpdate();
    } else if (msg.type === 'remove') {
      // 收到移除房间通知(其他玩家停止分享)
      if (!msg.roomCode) return;
      if (_removeRoom(msg.roomCode)) emitUpdate();
    }
  }

  // ============ 发送消息 ============
  function _publish(obj) {
    if (!client || !client.connected) return;
    try {
      client.publish(WORLD_TOPIC, JSON.stringify(obj), { qos: 0 });
    } catch (e) {}
  }

  // 重新广播自己正在分享的所有房间(刷新时间戳, 防止被过期清理)
  function _rebroadcastAll() {
    const now = Date.now();
    Object.values(myShares).forEach(room => {
      room.ts = now;
      _publish({
        type: 'share',
        roomCode: room.roomCode,
        playerName: room.playerName,
        playerId: room.playerId,
        mode: room.mode,
        ts: room.ts
      });
    });
  }

  // ============ 心跳定时器 ============
  function _startTimers() {
    _stopTimers();
    // 每 30 秒清理过期房间
    cleanTimer = setInterval(_cleanExpired, CLEAN_INTERVAL);
    // 每 60 秒重新广播自己正在分享的房间
    rebroadcastTimer = setInterval(_rebroadcastAll, REBROADCAST_INTERVAL);
  }
  function _stopTimers() {
    if (cleanTimer) { clearInterval(cleanTimer); cleanTimer = null; }
    if (rebroadcastTimer) { clearInterval(rebroadcastTimer); rebroadcastTimer = null; }
  }

  // ============ 对外接口 ============

  // 连接 MQTT 世界频道
  function init() {
    if (client) return; // 防止重复连接
    if (typeof mqtt === 'undefined') {
      console.error('[World] MQTT 库未加载');
      return;
    }
    const clientId = 'pma26-world-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6);
    try {
      client = mqtt.connect(MQTT_URL, {
        clientId, clean: true, keepalive: 30,
        reconnectPeriod: 2000, connectTimeout: 10000
      });
    } catch (e) {
      console.error('[World] 连接失败:', e);
      return;
    }

    client.on('connect', () => {
      connected = true;
      try { client.subscribe(WORLD_TOPIC, { qos: 0 }); } catch (e) {}
      _startTimers();
      _cleanExpired();
      // (重)连接后重新广播自己正在分享的房间, 确保其他玩家能看到
      _rebroadcastAll();
    });

    client.on('message', _handleMessage);

    client.on('error', (err) => { console.error('[World] MQTT 错误:', err); });
    client.on('offline', () => { connected = false; });
    client.on('reconnect', () => { /* 自动重连中, 连上后会自动重新订阅 */ });
  }

  // 分享房间到世界频道
  function shareRoom(roomCode, playerName, playerId, mode) {
    if (!roomCode || !playerId) return;
    // 记录自己的 playerId, 用于防抖(忽略自己发出的消息回环)
    selfPlayerId = playerId;
    const room = {
      roomCode: roomCode,
      playerName: playerName || '玩家',
      playerId: playerId,
      mode: mode || 'P2P',
      ts: Date.now()
    };
    // 记录到自己正在分享的列表(供心跳重广播使用)
    myShares[roomCode] = room;
    // 立即发送分享消息
    _publish({
      type: 'share',
      roomCode: room.roomCode,
      playerName: room.playerName,
      playerId: room.playerId,
      mode: room.mode,
      ts: room.ts
    });
  }

  // 停止分享房间(通知世界频道移除自己的房间)
  function stopShare(roomCode) {
    if (!roomCode) return;
    // 从自己分享列表移除
    delete myShares[roomCode];
    // 通知世界频道移除该房间
    _publish({ type: 'remove', roomCode: roomCode });
    // 同步从本地列表移除(若存在)
    if (_removeRoom(roomCode)) emitUpdate();
  }

  // 获取当前世界频道房间列表(返回副本)
  function getRooms() {
    return rooms.slice();
  }

  // 断开世界频道连接
  function close() {
    _stopTimers();
    // 通知世界频道移除自己所有正在分享的房间
    Object.keys(myShares).forEach(code => {
      _publish({ type: 'remove', roomCode: code });
    });
    myShares = {};
    try { if (client) client.end(true); } catch (e) {}
    client = null;
    connected = false;
    rooms = [];
    selfPlayerId = null;
    // 通知 UI 列表已清空
    emitUpdate();
    // 清空回调, 防止下次进入大厅时旧回调残留
    clearCallbacks();
  }

  return {
    init, shareRoom, stopShare, getRooms, onUpdate, close
  };
})();
