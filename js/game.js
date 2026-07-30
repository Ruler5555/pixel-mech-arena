// game.js · 游戏核心: 状态管理 + 回合/胜负 + 粒子 + 三种模式
// 模式:
//   offline: 本地 vs AI(原有逻辑)
//   host:    主机权威,跑完整逻辑,广播 state 给 client
//   client:  远端,只渲染 host 发来的 state,把本地 input 发给 host
//
// 本地玩家身份:
//   offline/host  -> P1 (蓝)
//   client        -> P2 (红), 输入需镜像(left/right 互换)

class Particle {
  constructor(x, y, vx, vy, color, life, size = 3) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.color = color; this.life = life; this.maxLife = life; this.size = size;
  }
  update(dt) {
    this.x += this.vx; this.y += this.vy;
    this.vy += 0.2; this.vx *= 0.96;
    this.life -= dt;
  }
  draw(ctx) {
    if (this.life <= 0) return;
    ctx.globalAlpha = Math.min(1, this.life / this.maxLife);
    ctx.fillStyle = this.color;
    ctx.fillRect(this.x, this.y, this.size, this.size);
    ctx.globalAlpha = 1;
  }
}

// 简单 AI 控器(仅离线模式使用)
function makeAI() {
  return {
    reactTimer: 0,
    decision: 'idle',
    _last: {},
    compute(self, foe, dt) {
      const dist = Math.abs(foe.x - self.x);
      const dir = foe.x > self.x ? 1 : -1;
      const ctrl = emptyCtrl();

      if (self.state === 'ko' || self.state === 'hurt') return ctrl;

      this.reactTimer -= dt;
      if (this.reactTimer <= 0) {
        this.reactTimer = 0.25 + Math.random() * 0.3;
        const foeActive = foe.attackActive();
        if (foeActive && dist < 90 && Math.random() < 0.6) this.decision = 'defend';
        else if (dist > 130) this.decision = 'approach';
        else if (dist < 60) {
          const r = Math.random();
          if (r < 0.5) this.decision = 'atkL';
          else if (r < 0.7) this.decision = 'atkH';
          else this.decision = 'back';
        } else {
          const r = Math.random();
          if (r < 0.6) this.decision = 'approach';
          else if (r < 0.85) this.decision = 'atkL';
          else this.decision = 'defend';
        }
      }
      switch (this.decision) {
        case 'approach': if (dir > 0) ctrl.right = true; else ctrl.left = true; break;
        case 'back': if (dir > 0) ctrl.left = true; else ctrl.right = true; break;
        case 'atkL': if (!this._last.atkL && self.onGround && self.cooldown <= 0) ctrl.tapL = true; break;
        case 'atkH': if (!this._last.atkH && self.onGround && self.cooldown <= 0) ctrl.tapH = true; break;
        case 'defend': ctrl.defend = true; break;
      }
      this._last.atkL = ctrl.tapL;
      this._last.atkH = ctrl.tapH;
      return ctrl;
    }
  };
}

function emptyCtrl() {
  return { left:false, right:false, jump:false, atkL:false, atkH:false, defend:false,
           tapL:false, tapH:false, tapJump:false };
}

const STATES = { READY:'ready', FIGHT:'fight', ROUND_END:'roundEnd', MATCH_END:'matchEnd' };
const MODES  = { OFFLINE:'offline', HOST:'host', CLIENT:'client' };

// 触屏设备检测(移动端不显示 R/ESC 等键盘提示)
const IS_TOUCH_UI = (typeof window !== 'undefined') &&
  ((window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window);

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.W = canvas.width;
    this.H = canvas.height;
    this.groundY = this.H - 50;

    this.p1 = null;
    this.p2 = null;
    this.ai = null;
    this.particles = [];
    this.shake = 0;

    this.round = 1;
    this.winsP1 = 0;
    this.winsP2 = 0;
    this.timer = 60;
    this.timerAcc = 0;
    this.roundWinner = 0;

    this.state = STATES.READY;
    this.stateTime = 0;
    this.frame = 0;
    this.lastTime = 0;
    this.running = false;
    this._accumulator = 0; // 固定步长累积器

    this.mode = MODES.OFFLINE; // 默认离线
    this.localPlayer = 1;      // 1=P1, 2=P2(客户端)

    // 联机: 远端输入缓存(host 接收 client 的 input)
    this.remoteCtrl = emptyCtrl();
    // 联机: 客户端最近一次收到的 state
    this.lastRemoteState = null;
    // 联机: 同步计时器(主机 30Hz 广播, 配合插值足够流畅)
    this.syncAcc = 0;
    this.netLatency = 0; // 估算
    // 客户端插值: 对手机甲位置走 lerp, 避免网络抖动导致画面跳跃
    this.interp = {
      foeTargetX: 0, foeTargetY: 0,
      foeHasTarget: false
    };
    // 输入变化检测(减少带宽: 只在输入变化时发送)
    this._lastSentInput = null;
    this._inputSendAcc = 0;

    this.onStateChange = null;
    this.onNetEvent = null; // 联机事件回调(hostReady/leave等)
    this._resetMechs();
  }

  // ===== 模式设置 =====
  setMode(mode) {
    this.mode = mode;
    this.localPlayer = (mode === MODES.CLIENT) ? 2 : 1;
  }

  _resetMechs() {
    this.p1 = new Mech({ x: 180, groundY: this.groundY, facing: 1, color: 'blue', name: 'BLUE-01' });
    this.p2 = new Mech({ x: 460, groundY: this.groundY, facing: -1, color: 'red', name: 'RED-X' });
    this.ai = makeAI();
    this.remoteCtrl = emptyCtrl();
  }

  resetMatch() {
    this.round = 1;
    this.winsP1 = 0;
    this.winsP2 = 0;
    this._lastStateFrame = 0; // 新对局重置快照序号(允许主机重启后的小 frame)
    this.startRound();
  }

  startRound() {
    this._resetMechs();
    this.timer = 60;
    this.timerAcc = 0;
    this.particles = [];
    this.shake = 0;
    this.setState(STATES.READY);
  }

  setState(s) {
    this.state = s;
    this.stateTime = 0;
    if (this.onStateChange) this.onStateChange(s);
  }

  startFight() { this.setState(STATES.FIGHT); }

  // ===== 本地输入采集 =====
  // 客户端控制 P2: left/right 需镜像(因为 P2 朝左)
  _localCtrl() {
    const c = {
      left: Input.down('left'),
      right: Input.down('right'),
      jump: Input.down('jump'),
      defend: Input.down('defend'),
      tapJump: Input.tapped('jump'),
      tapL: Input.tapped('atkL'),
      tapH: Input.tapped('atkH'),
      atkL: false, atkH: false
    };
    if (this.localPlayer === 2) {
      // 镜像: 玩家按"右"对 P2 来说是朝对手(向左),即 P2 的 right
      // 但我们保留语义"按右屏幕右移",所以对 P2 而言 right 仍是向屏幕右
      // 实际上 Mech 的 facing 由 update 自动朝向对手,dir 决定 vx
      // 所以不需要镜像,直接传即可
    }
    return c;
  }

  update(dt) {
    this.frame++;
    this.stateTime += dt;
    if (this.shake > 0) this.shake -= dt;

    // ESC 离开(任何模式)
    if (Input.tapped('reset')) {
      if (this.onNetEvent) this.onNetEvent('leave');
      return;
    }
    // R 重开当前对局(不断开连接, 离线/联机均可)
    if (Input.tapped('rematch')) {
      if (this.onNetEvent) this.onNetEvent('rematch');
      return;
    }

    // ===== 客户端模式: 本地预测 + 对手插值 =====
    if (this.mode === MODES.CLIENT) {
      // 输入上报: 每 50ms 或变化时发, 减少带宽
      this._inputSendAcc += dt;
      const curInput = this._localCtrl();
      if (this._inputSendAcc >= 0.05 || this._inputChanged(curInput, this._lastSentInput)) {
        this._inputSendAcc = 0;
        Net.sendInput(curInput);
        this._lastSentInput = { ...curInput };
      }
      // 本地预测: 立即应用本地输入跑本地玩家物理(手感零延迟)
      // 只在 FIGHT 状态下预测, READY/ROUND_END 不动
      if (this.state === STATES.FIGHT) {
        const localMech = this.localPlayer === 1 ? this.p1 : this.p2;
        const foeMech = this.localPlayer === 1 ? this.p2 : this.p1;
        localMech.update(dt, curInput, foeMech, this);
      }
      // 对手机甲: 插值平滑(向 host 发来的目标位置过渡)
      this._interpFoe(dt);
      // 粒子更新
      this.particles = this.particles.filter(p => { p.update(dt); return p.life > 0; });
      return;
    }

    // ===== offline / host 模式: 跑完整逻辑 =====
    if (this.state === STATES.READY) {
      if (this.stateTime > 1.2) this.startFight();
      this.p1.update(dt, emptyCtrl(), this.p2, this);
      this.p2.update(dt, emptyCtrl(), this.p1, this);
    }
    else if (this.state === STATES.FIGHT) {
      this.timerAcc += dt;
      if (this.timerAcc >= 1) { this.timerAcc -= 1; this.timer = Math.max(0, this.timer - 1); }

      const c1 = this._localCtrl();
      let c2;
      if (this.mode === MODES.HOST) {
        c2 = this.remoteCtrl; // 来自 client
      } else {
        c2 = this.ai.compute(this.p2, this.p1, dt);
      }

      this.p1.update(dt, c1, this.p2, this);
      this.p2.update(dt, c2, this.p1, this);

      // 消费 client 边沿输入: 每帧至多触发一次攻击/跳跃, 杜绝"边沿卡住"导致的靠近自动出伤害
      if (this.remoteCtrl) { this.remoteCtrl.tapL = false; this.remoteCtrl.tapH = false; this.remoteCtrl.tapJump = false; }

      this._resolveCombat(this.p1, this.p2);
      this._resolveCombat(this.p2, this.p1);

      this.particles = this.particles.filter(p => { p.update(dt); return p.life > 0; });

      const p1Dead = this.p1.state === 'ko' || this.p1.hp <= 0;
      const p2Dead = this.p2.state === 'ko' || this.p2.hp <= 0;
      if (p1Dead || p2Dead || this.timer <= 0) {
        let winner = 0;
        if (p1Dead && !p2Dead) winner = 2;
        else if (p2Dead && !p1Dead) winner = 1;
        else {
          if (this.p1.hp > this.p2.hp) winner = 1;
          else if (this.p2.hp > this.p1.hp) winner = 2;
          else winner = 0;
        }
        if (winner === 1) this.winsP1++;
        else if (winner === 2) this.winsP2++;
        this.roundWinner = winner;
        this.setState(STATES.ROUND_END);
      }
    }
    else if (this.state === STATES.ROUND_END) {
      this.p1.update(dt, emptyCtrl(), this.p2, this);
      this.p2.update(dt, emptyCtrl(), this.p1, this);
      this.particles = this.particles.filter(p => { p.update(dt); return p.life > 0; });
      if (this.stateTime > 2.2) {
        if (this.winsP1 >= 2 || this.winsP2 >= 2) this.setState(STATES.MATCH_END);
        else { this.round++; this.startRound(); }
      }
    }
    else if (this.state === STATES.MATCH_END) {
      this.p1.update(dt, emptyCtrl(), this.p2, this);
      this.p2.update(dt, emptyCtrl(), this.p1, this);
    }

    // ===== host: 定时广播 state =====
    if (this.mode === MODES.HOST && Net.isConnected()) {
      this.syncAcc += dt;
      if (this.syncAcc >= 1 / 30) { // 30Hz
        this.syncAcc = 0;
        Net.sendState(this._serializeState());
      }
    }
  }

  // ===== 序列化(主机广播) =====
  _serializeState() {
    return {
      p1: this._serMech(this.p1),
      p2: this._serMech(this.p2),
      round: this.round,
      winsP1: this.winsP1,
      winsP2: this.winsP2,
      timer: this.timer,
      gs: this.state,
      gst: this.stateTime,
      rw: this.roundWinner,
      shake: this.shake,
      frame: this.frame
    };
  }
  _serMech(m) {
    return {
      x: Math.round(m.x), y: Math.round(m.y), vx: +m.vx.toFixed(2), vy: +m.vy.toFixed(2),
      f: m.facing, hp: m.hp, st: m.state, stt: +m.stateTime.toFixed(3),
      fr: m.frame, fl: m.flash > 0, cd: +m.cooldown.toFixed(2), df: m.defending,
      js: m.jumpSeq, jc: m.jumpCount
    };
  }

  // ===== 反序列化(客户端应用) =====
  applyRemoteState(s) {
    if (!s) return;
    // [同步修复] 丢弃过期/重复快照: 双通道或网络抖动下, 旧快照晚到会把画面拉回过去
    // (机甲回跳/血量倒流)。frame 单调递增, 只接受更新的快照; 差距悬殊视为主机重启, 放行
    if (s.frame !== undefined) {
      if (this._lastStateFrame && s.frame <= this._lastStateFrame &&
          this._lastStateFrame - s.frame < 3600) return;
      this._lastStateFrame = s.frame;
    }
    // 客户端检测 hit: hp 下降时本地生成粒子(近似攻击者武器位置)
    const prevHp1 = this.p1.hp, prevHp2 = this.p2.hp;
    // 对手机甲: 仅记录插值目标位置(由 _interpFoe 每帧 lerp 逼近)
    // 本地玩家: 权威修正 —— 只修正关键状态, 位置做软纠偏避免硬拉
    if (this.localPlayer === 2) {
      // 本地=P2, 对手=P1
      this._setFoeTarget(this.p1, s.p1);
      this._applyMechSoft(this.p2, s.p2); // 本地软纠偏
    } else {
      // 本地=P1, 对手=P2
      this._applyMechSoft(this.p1, s.p1);
      this._setFoeTarget(this.p2, s.p2);
    }
    if (prevHp1 - s.p1.hp >= 4) {
      this._spawnHitFX(s.p1.x + (s.p2.x > s.p1.x ? -20 : 20), s.p1.y - 40, false, (prevHp1 - s.p1.hp) >= 15);
    }
    if (prevHp2 - s.p2.hp >= 4) {
      this._spawnHitFX(s.p2.x + (s.p1.x > s.p2.x ? -20 : 20), s.p2.y - 40, false, (prevHp2 - s.p2.hp) >= 15);
    }
    this.round = s.round;
    this.winsP1 = s.winsP1;
    this.winsP2 = s.winsP2;
    this.timer = s.timer;
    this.roundWinner = s.rw;
    this.shake = s.shake;
    if (s.gs !== this.state) this.setState(s.gs);
    this.stateTime = s.gst;
  }
  _applyMech(m, d) {
    if (!d) return;
    // 跳跃事件检测: jumpSeq 变化时强制触发跳跃动画(避免 state 同步延迟吞动画)
    if (d.js !== undefined && d.js > m.jumpSeq) {
      m.jumpSeq = d.js;
      // 用 jumpCount 判断一段/二段跳, 给对应速度
      const isDouble = d.jc !== undefined && d.jc >= 2;
      m.vy = isDouble ? -8.5 : -7.2;
      m.onGround = false;
      m.jumpCount = d.jc !== undefined ? d.jc : 1;
      if (m.state !== 'jump') { m.state = 'jump'; m.hitApplied = false; }
      m.stateTime = 0; // 重置动画, 保证起跳帧可见
    }
    m.x = d.x; m.y = d.y; m.vx = d.vx; m.vy = d.vy;
    m.facing = d.f; m.hp = d.hp;
    if (m.state !== d.st) { m.state = d.st; m.hitApplied = false; }
    m.stateTime = d.stt;
    m.frame = d.fr;
    m.flash = d.fl ? 0.18 : 0;
    m.cooldown = d.cd;
    m.defending = d.df;
    m.onGround = (m.y >= this.groundY);
  }
  // 本地玩家软纠偏: 权威字段(hp/state)直接应用, 位置只记录目标, 由 _interpFoe 平滑
  // 这里先直接应用权威字段, 位置偏差在预测更新中自然消除
  _applyMechSoft(m, d) {
    if (!d) return;
    m.facing = d.f; m.hp = d.hp;
    if (m.state !== d.st) { m.state = d.st; m.hitApplied = false; }
    m.stateTime = d.stt;
    m.frame = d.fr;
    m.flash = d.fl ? 0.18 : 0;
    m.cooldown = d.cd;
    m.defending = d.df;
    // jumpCount 同步: 防止本地预测与权威不一致导致二段跳失效
    if (d.jc !== undefined) m.jumpCount = d.jc;
    if (d.js !== undefined) m.jumpSeq = d.js;
    // 位置: 若偏差过大(>30px,可能是被击退/击飞)直接修正, 否则保留本地预测
    const dx = Math.abs(m.x - d.x);
    if (dx > 30) { m.x = d.x; m.y = d.y; m.vx = d.vx; m.vy = d.vy; }
    m.onGround = (m.y >= this.groundY);
  }
  // 对手机甲: 仅记录插值目标(位置由 _interpFoe 每帧 lerp 逼近)
  // 非位置字段(hp/state/frame/cooldown 等)直接应用, 保证状态及时同步
  _setFoeTarget(m, d) {
    if (!d) return;
    // 先记录是否检测到跳跃事件(后面字段同步后再应用, 避免被覆盖)
    const jumpTriggered = (d.js !== undefined && d.js > m.jumpSeq);

    this.interp.foeTargetX = d.x;
    this.interp.foeTargetY = d.y;
    this.interp.foeHasTarget = true;
    m.facing = d.f; m.hp = d.hp;
    if (m.state !== d.st) { m.state = d.st; m.hitApplied = false; }
    m.stateTime = d.stt;
    m.frame = d.fr;
    m.flash = d.fl ? 0.18 : 0;
    m.cooldown = d.cd;
    m.defending = d.df;
    m.vx = d.vx; m.vy = d.vy; // 用于动画/朝向, 但不再直接覆盖位置
    if (d.jc !== undefined) m.jumpCount = d.jc;

    // 跳跃事件检测: jumpSeq 变化时强制触发跳跃动画(一段/二段跳都触发)
    // 放在最后, 覆盖前面的 state/stateTime, 保证起跳动画从头播放
    if (jumpTriggered) {
      m.jumpSeq = d.js;
      const isDouble = d.jc !== undefined && d.jc >= 2;
      m.vy = isDouble ? -8.5 : -7.2;
      m.onGround = false;
      m.state = 'jump';
      m.hitApplied = false;
      m.stateTime = 0;
    }
  }
  // 对手机甲插值: 纯指数 lerp 向 host 最新目标位置收敛
  // host 30Hz 发状态, 客户端 60Hz 渲染, 中间帧用 lerp 平滑
  // 注: 曾试过速度外推但弱网下会超前/抖动, 回退到纯 lerp 更稳定
  _interpFoe(dt) {
    if (!this.interp.foeHasTarget) return;
    const foeMech = this.localPlayer === 1 ? this.p2 : this.p1;
    const tx = this.interp.foeTargetX;
    const ty = this.interp.foeTargetY;
    const dx = tx - foeMech.x;
    const dy = ty - foeMech.y;
    // 偏差过大(被击退/击飞瞬移)直接 snap, 避免 lerp 看起来像慢动作
    if (Math.abs(dx) > 60 || Math.abs(dy) > 60) {
      foeMech.x = tx; foeMech.y = ty;
    } else {
      // 纯指数 lerp: ~70ms 收敛, 稳定不漂移
      const k = 1 - Math.exp(-dt * 16);
      foeMech.x += dx * k;
      foeMech.y += dy * k;
    }
    foeMech.onGround = (foeMech.y >= this.groundY);
  }
  // 检测输入是否变化
  _inputChanged(cur, prev) {
    if (!prev) return true;
    return cur.left !== prev.left || cur.right !== prev.right ||
           cur.jump !== prev.jump || cur.defend !== prev.defend ||
           cur.tapL !== prev.tapL || cur.tapH !== prev.tapH ||
           cur.tapJump !== prev.tapJump;
  }

  // host 收到 client input
  // 边沿动作(tapL/tapH/tapJump)用 OR 累加, 避免两帧之间到达的"点击"被覆盖丢失;
  // 持续动作(left/right/jump/defend)取最新值。host 每帧消费后清零(见 update 战斗分支)
  applyRemoteInput(c) {
    if (!c) { this.remoteCtrl = emptyCtrl(); return; }
    if (!this.remoteCtrl) this.remoteCtrl = emptyCtrl();
    const r = this.remoteCtrl;
    r.tapL    = !!(r.tapL    || c.tapL);
    r.tapH    = !!(r.tapH    || c.tapH);
    r.tapJump = !!(r.tapJump || c.tapJump);
    r.left = !!c.left; r.right = !!c.right; r.jump = !!c.jump; r.defend = !!c.defend;
  }

  // 客户端检测到 hit 事件(由 host 发的 state 中 hp 下降推算),本地生成粒子
  _clientDetectHit(prevP1, prevP2) {
    // 简化: 当某方 hp 突降时在对方武器位置生成粒子
    // 这里仅做粗略检测, 实际 host 也可在 state 里带 hit 标志
  }

  _resolveCombat(attacker, defender) {
    if (!attacker.attackActive() || attacker._hitDone) {
      if (!attacker.attackActive()) attacker._hitDone = false;
      return;
    }
    const hb = attacker.attackHitbox();
    const bb = defender.bodyBox();
    if (aabb(hb, bb)) {
      const result = defender.takeHit(hb.dmg, hb.fromX);
      attacker._hitDone = true;
      this.shake = result < 0 ? 0.12 : (attacker.atk && attacker.atk.type === 'H' ? 0.35 : 0.18);
      this._spawnHitFX(hb.x + hb.w / 2, hb.y + hb.h / 2, result < 0, attacker.atk && attacker.atk.type === 'H');
      // 受击触觉反馈: 仅本地玩家被命中(非防御)时震动 30ms, 避免对手挨打也震玩家
      const localIsDefender = (this.localPlayer === 1 && defender === this.p1)
                           || (this.localPlayer === 2 && defender === this.p2);
      if (localIsDefender && result >= 0 && navigator.vibrate) {
        try { navigator.vibrate(30); } catch (_) {}
      }
    }
  }

  _spawnHitFX(x, y, blocked, heavy) {
    const n = heavy ? 16 : 9;
    const colors = blocked ? ['#4ad6ff', '#ffffff'] : ['#ffcc33', '#ff6a3a', '#ffffff'];
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3;
      this.particles.push(new Particle(
        x, y, Math.cos(ang) * sp, Math.sin(ang) * sp - 1,
        colors[i % colors.length], 0.4 + Math.random() * 0.3, heavy ? 4 : 3
      ));
    }
  }

  draw() {
    const ctx = this.ctx;
    let sx = 0, sy = 0;
    if (this.shake > 0) {
      sx = (Math.random() - 0.5) * 6 * this.shake * 4;
      sy = (Math.random() - 0.5) * 6 * this.shake * 4;
    }
    ctx.save();
    ctx.translate(sx, sy);

    Sprite.drawBackground(ctx, this.W, this.H, this.frame);

    // 己方机甲金色描边: offline/host 本地是 P1, client 本地是 P2
    const localMech = (this.mode === MODES.CLIENT) ? this.p2 : this.p1;
    const list = [this.p1, this.p2].sort((a, b) => a.y - b.y);
    list.forEach(m => m.draw(ctx, m === localMech));

    this.particles.forEach(p => p.draw(ctx));

    if (this.state === STATES.READY) {
      this._drawCenterText(this.stateTime < 0.6 ? 'READY?' : 'FIGHT!', this.stateTime < 0.6 ? '#ffcc33' : '#ff5a6a');
    } else if (this.state === STATES.ROUND_END) {
      const txt = this.roundWinner === 1 ? 'BLUE WINS ROUND'
                : this.roundWinner === 2 ? 'RED WINS ROUND' : 'DRAW';
      this._drawCenterText(txt, this.roundWinner === 1 ? '#4ad6ff' : this.roundWinner === 2 ? '#ff5a6a' : '#ffcc33');
    } else if (this.state === STATES.MATCH_END) {
      const champ = this.winsP1 >= 2 ? 'BLUE-01' : 'RED-X';
      this._drawCenterText(champ + '\nCHAMPION!', '#ffcc33', 22);
      // 移动端没有键盘, 不显示 R/ESC 提示
      if (!IS_TOUCH_UI) {
        ctx.fillStyle = '#e8e8ff';
        ctx.font = '8px "Press Start 2P"';
        ctx.textAlign = 'center';
        ctx.fillText('按 ESC 离开 / R 重开', this.W / 2, this.H / 2 + 50);
      }
    }

    // 客户端断线/等待提示
    if (this.mode !== MODES.OFFLINE && !Net.isConnected()) {
      this._drawCenterText('连接中断...', '#ff5a6a', 18);
    }

    ctx.restore();
  }

  _drawCenterText(text, color, size = 26) {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `${size}px "Press Start 2P", monospace`;
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
      ctx.fillStyle = '#000';
      ctx.fillText(ln, this.W / 2 + 3, this.H / 2 + 3 + i * (size + 6));
      ctx.fillStyle = color;
      ctx.fillText(ln, this.W / 2, this.H / 2 + i * (size + 6));
    });
    ctx.restore();
  }

  loop = (ts) => {
    if (!this.running) return;
    if (!this.lastTime) this.lastTime = ts;
    let realDt = (ts - this.lastTime) / 1000;
    this.lastTime = ts;
    if (realDt > 0.1) realDt = 0.1; // 防止切后台后大跳

    // 固定时间步长: 累积真实时间, 每满 1/60 秒执行一次逻辑更新
    // 物理用固定步长, 在所有刷新率(60/120/144Hz)下表现一致
    this._accumulator += realDt;
    const FIXED_DT = 1 / 60;
    let steps = 0;
    while (this._accumulator >= FIXED_DT && steps < 5) {
      this.update(FIXED_DT);
      this._accumulator -= FIXED_DT;
      steps++;
    }
    // 若累积过多(切后台很久), 丢弃多余避免卡顿
    if (steps >= 5) this._accumulator = 0;

    this.draw();
    requestAnimationFrame(this.loop);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = 0;
    this._accumulator = 0;
    requestAnimationFrame(this.loop);
  }

  stop() { this.running = false; }
}
