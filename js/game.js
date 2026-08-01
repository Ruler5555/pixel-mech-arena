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

// 机甲 AI 战斗风格预设(联机「AI 对战观战」模式用)
// 每个 preset 是一组决策参数, 决定 AI 的"性格"; 玩家在赛前为自家机甲 AI 选一个
const AI_PRESETS = {
  balanced:   { id:'balanced',   name:'均衡', emoji:'⚖️', desc:'攻防节奏均衡, 全面稳定',
    reactMin:0.28, reactMax:0.55, defendProb:0.55, approachDist:130, closeDist:60,
    closeL:0.48, closeH:0.18, closeBack:0.34, midApproach:0.55, midL:0.25, midDef:0.20,
    jumpProb:0.12, airJumpProb:0.25, evadeProb:0.10 },
  berserker:  { id:'berserker',  name:'猛攻', emoji:'🔥', desc:'贴脸重击, 压制猛打',
    reactMin:0.14, reactMax:0.32, defendProb:0.20, approachDist:160, closeDist:48,
    closeL:0.30, closeH:0.50, closeBack:0.20, midApproach:0.75, midL:0.25, midDef:0.05,
    jumpProb:0.18, airJumpProb:0.30, evadeProb:0.02 },
  bulwark:    { id:'bulwark',    name:'铁壁', emoji:'🛡️', desc:'高防反击, 龟缩消耗',
    reactMin:0.22, reactMax:0.42, defendProb:0.90, approachDist:115, closeDist:72,
    closeL:0.25, closeH:0.08, closeBack:0.25, midApproach:0.35, midL:0.15, midDef:0.50,
    jumpProb:0.02, airJumpProb:0.05, evadeProb:0.03 },
  skirmisher: { id:'skirmisher', name:'游击', emoji:'🏹', desc:'打了就跑, 风筝走位',
    reactMin:0.18, reactMax:0.42, defendProb:0.35, approachDist:145, closeDist:58,
    closeL:0.45, closeH:0.15, closeBack:0.40, midApproach:0.45, midL:0.40, midDef:0.15,
    jumpProb:0.22, airJumpProb:0.45, evadeProb:0.30 },
  gale:       { id:'gale',       name:'疾风', emoji:'🌪️', desc:'高频跳跃, 灵动机动',
    reactMin:0.14, reactMax:0.34, defendProb:0.25, approachDist:155, closeDist:60,
    closeL:0.55, closeH:0.20, closeBack:0.25, midApproach:0.70, midL:0.30, midDef:0.05,
    jumpProb:0.45, airJumpProb:0.60, evadeProb:0.25 },
  precision:  { id:'precision',  name:'精准', emoji:'🎯', desc:'反应极快, 抓帧惩罚',
    reactMin:0.08, reactMax:0.22, defendProb:0.78, approachDist:130, closeDist:65,
    closeL:0.55, closeH:0.25, closeBack:0.20, midApproach:0.50, midL:0.30, midDef:0.20,
    jumpProb:0.12, airJumpProb:0.30, evadeProb:0.15 }
};
const AI_PRESET_LIST = ['balanced','berserker','bulwark','skirmisher','gale','precision'];

// 简单 AI 控器: 接受 preset(决策参数), 每 reactTimer 秒重掷一次决策(加权随机状态机)
function makeAI(cfg) {
  cfg = cfg || AI_PRESETS.balanced;
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
        this.reactTimer = cfg.reactMin + Math.random() * (cfg.reactMax - cfg.reactMin);
        const foeActive = foe.attackActive();
        if (foeActive && dist < 95) {
          // 对手正在攻击且贴近: 优先防御, 其次风格化跳跃闪避
          if (Math.random() < cfg.defendProb) this.decision = 'defend';
          else if (cfg.evadeProb > 0 && Math.random() < cfg.evadeProb) this.decision = 'evade';
          else this.decision = 'approach';
        } else if (dist > cfg.approachDist) {
          this.decision = 'approach';
        } else if (dist < cfg.closeDist) {
          const r = Math.random();
          const s = cfg.closeL + cfg.closeH + cfg.closeBack;
          if (r < cfg.closeL / s) this.decision = 'atkL';
          else if (r < (cfg.closeL + cfg.closeH) / s) this.decision = 'atkH';
          else this.decision = 'back';
        } else {
          const r = Math.random();
          const s = cfg.midApproach + cfg.midL + cfg.midDef;
          if (r < cfg.midApproach / s) this.decision = 'approach';
          else if (r < (cfg.midApproach + cfg.midL) / s) this.decision = 'atkL';
          else this.decision = 'defend';
        }
        // 地面起跳(风格化): 拉近距离 / 制造立体进攻
        if (cfg.jumpProb > 0 && self.onGround && Math.random() < cfg.jumpProb) this.decision = 'jump';
      }

      // 空中二段跳: 所有会跳的风格在一段跳后按 airJumpProb 补跳, 立体机动更明显
      // [v133] 触发概率从 *0.12 提到 *0.55(原压制过狠导致二段跳极少发生),
      // 且真正触发时几乎必带水平位移(见下方 airJump 分支), 不再"纯垂直呆跳"
      if (!self.onGround && self.jumpCount === 1 && cfg.airJumpProb > 0 && !this._last.jump
          && Math.random() < cfg.airJumpProb * 0.55) {
        this.decision = 'airJump';
      }

      switch (this.decision) {
        case 'approach': if (dir > 0) ctrl.right = true; else ctrl.left = true; break;
        case 'back':     if (dir > 0) ctrl.left = true; else ctrl.right = true; break;
        case 'atkL':
          if (!this._last.atkL && self.onGround && self.cooldown <= 0) { ctrl.tapL = true; this.decision = 'idle'; }
          break;
        case 'atkH':
          if (!this._last.atkH && self.onGround && self.cooldown <= 0) { ctrl.tapH = true; this.decision = 'idle'; }
          break;
        case 'defend': ctrl.defend = true; break; // 持续按住, 直到下次重掷
        case 'jump':
          if (!this._last.jump && self.onGround && self.jumpCount < 2) {
            ctrl.tapJump = true; this.decision = 'idle';
            // 起跳带水平位移: 多数风格朝对手扑(进攻跳), 游击/铁壁偏后撤, 让跳跃更自然不呆板
            const jdir = (cfg.id === 'skirmisher' || cfg.id === 'bulwark') ? -dir : dir;
            if (Math.random() < 0.85) { if (jdir > 0) ctrl.right = true; else ctrl.left = true; }
          }
          break;
        case 'airJump':
          if (!self.onGround && self.jumpCount < 2) {
            ctrl.tapJump = true; this.decision = 'idle';
            // 二段跳几乎必带水平位移, 且按风格决定扑/撤 —— 杜绝"纯垂直呆跳"
            const adir = (cfg.id === 'skirmisher') ? -dir
                       : (cfg.id === 'berserker' || cfg.id === 'gale') ? dir
                       : (Math.random() < 0.5 ? dir : -dir);
            if (Math.random() < 0.92) { if (adir > 0) ctrl.right = true; else ctrl.left = true; }
          }
          break;
        case 'evade':
          // 后跳逃离: 地面先起跳, 空中补二段跳
          if (dir > 0) ctrl.left = true; else ctrl.right = true;
          if (self.onGround && !this._last.jump) { ctrl.tapJump = true; this.decision = 'idle'; }
          else if (!self.onGround && self.jumpCount < 2) { ctrl.tapJump = true; this.decision = 'idle'; }
          break;
      }
      this._last.atkL = ctrl.tapL;
      this._last.atkH = ctrl.tapH;
      this._last.jump = ctrl.tapJump;
      return ctrl;
    }
  };
}

function emptyCtrl() {
  return { left:false, right:false, jump:false, atkL:false, atkH:false, defend:false,
           tapL:false, tapH:false, tapJump:false };
}

const STATES = { READY:'ready', FIGHT:'fight', ROUND_END:'roundEnd', MATCH_END:'matchEnd' };
const MODES  = { OFFLINE:'offline', HOST:'host', CLIENT:'client', AI_HOST:'aiHost', AI_CLIENT:'aiClient' };

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
    this.ai = null;       // 离线模式 P2 AI
    this.ai1 = null;      // AI 对战模式 P1(蓝) AI
    this.ai2 = null;      // AI 对战模式 P2(红) AI
    this.aiPresetP1 = null; // 玩家为 P1 机甲 AI 选的风格
    this.aiPresetP2 = null; // 玩家为 P2 机甲 AI 选的风格
    this.particles = [];
    this.shake = 0;

    this.round = 1;
    this.winsP1 = 0;
    this.winsP2 = 0;
    this.maxHP = 100;      // [v141] 血量上限(默认 100; 联机 AI 对战模式 120)
    this.roundTime = 60;   // [v141] 每回合时长(s, 默认 60; 联机 AI 对战模式 30)
    this.timer = this.roundTime;
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
    // 客户端插值: 对手机甲走「渲染延迟缓冲」——所有状态(位置/动画/受伤)都从按时间排序的
    // 缓冲里以固定延迟回放, 保证动画与位移永远来自同一帧(彻底消除跳跃动画与身体不同步)
    this.interp = {
      buffer: [],          // [{ t: 收包时间(s), d: 序列化机甲 }]
      delay: 0.10,         // 渲染延迟 100ms(与 30Hz 广播配合, 约缓冲 3 帧)
      prevFoeHp: undefined // 上一帧回放的对手血量, 用于对齐受伤 FX
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
    this.localPlayer = (mode === MODES.CLIENT || mode === MODES.AI_CLIENT) ? 2 : 1;
    // [v141] 联机 AI 对战模式专属数值: 血量上限 120、每回合 30s; 其余模式维持 100/60
    if (mode === MODES.AI_HOST || mode === MODES.AI_CLIENT) {
      this.maxHP = 120;
      this.roundTime = 30;
    } else {
      this.maxHP = 100;
      this.roundTime = 60;
    }
  }

  // 设置 AI 对战模式的双方机甲 AI 风格(id 对应 AI_PRESETS)
  setAIPresets(p1Id, p2Id) {
    this.aiPresetP1 = AI_PRESETS[p1Id] || AI_PRESETS.balanced;
    this.aiPresetP2 = AI_PRESETS[p2Id] || AI_PRESETS.balanced;
  }

  _resetMechs() {
    this.p1 = new Mech({ x: 180, groundY: this.groundY, facing: 1, color: 'blue', name: 'BLUE-01', maxHP: this.maxHP });
    this.p2 = new Mech({ x: 460, groundY: this.groundY, facing: -1, color: 'red', name: 'RED-X', maxHP: this.maxHP });
    this.ai = makeAI();
    this.ai1 = makeAI(this.aiPresetP1 || AI_PRESETS.balanced);
    this.ai2 = makeAI(this.aiPresetP2 || AI_PRESETS.balanced);
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
    this.interp.buffer.length = 0;
    this.interp.prevFoeHp = undefined;
    this.timer = this.roundTime;
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

    // ===== 观战客户端模式(AI 对战): 纯镜像, 不跑本地物理, 不发送输入 =====
    // 两台机甲都由 host 广播, 由 applySpectateState 直接套用(见 net 'state' 回调)
    if (this.mode === MODES.AI_CLIENT) {
      // [观战插值] 位置不硬套快照, 而是逐帧逼近权威目标 —— 中继 15Hz 下若直接硬套会
      // 一格一格顿, 插值后视觉接近 60fps。偏差过大(回合重置/传送)则直接拉回不做插值。
      const k = Math.min(1, dt * 18);
      [this.p1, this.p2].forEach((m) => {
        if (!m || m._tx === undefined) return;
        if (Math.abs(m._tx - m.x) > 120 || Math.abs(m._ty - m.y) > 120) {
          m.x = m._tx; m.y = m._ty;
        } else {
          m.x += (m._tx - m.x) * k;
          m.y += (m._ty - m.y) * k;
        }
        m.onGround = (m.y >= this.groundY - 0.5);
      });
      this.particles = this.particles.filter(p => { p.update(dt); return p.life > 0; });
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

      const c1 = (this.mode === MODES.AI_HOST) ? this.ai1.compute(this.p1, this.p2, dt) : this._localCtrl();
      let c2;
      if (this.mode === MODES.HOST) {
        c2 = this.remoteCtrl; // 来自 client
      } else if (this.mode === MODES.AI_HOST) {
        c2 = this.ai2.compute(this.p2, this.p1, dt);
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
          else {
            winner = 0; // 血量相同 -> 平局(已移除「同受伤判负」机制)
          }
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

    // ===== host / aiHost: 定时广播 state =====
    if ((this.mode === MODES.HOST || this.mode === MODES.AI_HOST) && Net.isConnected()) {
      this.syncAcc += dt;
      // [v172] 中继降频改用真实通道检测(v167 删 MQTT 后 getMode() 恒 'p2p', 原判断失效致中继也 30Hz 满速
      // → 配合可靠通道丢包重传, 发送缓冲无限堆积, 延迟滚雪球到 5000ms+)。
      // getChannelDetail()==='relay'(ICE 实际走 TURN 中继)时降 15Hz, 队列不堆积, 延迟回落。
      const hz = (Net.getChannelDetail() === 'relay') ? 15 : 30;
      if (this.syncAcc >= 1 / hz) {
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
    // 本地玩家: 权威软纠偏(位置保留预测, 关键字段即时修正) + 本地受伤 FX 即时
    // 对手机甲: 压入渲染延迟缓冲, 由 _interpFoe 回放(动画/位置/受伤 FX 同帧, 消除不同步)
    if (this.localPlayer === 2) {
      const localPrevHp = this.p2.hp;
      this._setFoeTarget(this.p1, s.p1);          // 对手 P1 -> 缓冲
      this._applyMechSoft(this.p2, s.p2);         // 本地 P2
      if (localPrevHp - this.p2.hp >= 4) {
        this._spawnHitFX(this.p2.x + (this.p1.x > this.p2.x ? 20 : -20), this.p2.y - 40, false, (localPrevHp - this.p2.hp) >= 15);
      }
    } else {
      const localPrevHp = this.p1.hp;
      this._applyMechSoft(this.p1, s.p1);         // 本地 P1
      this._setFoeTarget(this.p2, s.p2);          // 对手 P2 -> 缓冲
      if (localPrevHp - this.p1.hp >= 4) {
        this._spawnHitFX(this.p1.x + (this.p2.x > this.p1.x ? 20 : -20), this.p1.y - 40, false, (localPrevHp - this.p1.hp) >= 15);
      }
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
  // 观战模式(AI 对战): 两台机甲都来自 host 广播, 直接硬套(客户端无本地预测, 30Hz 镜像)
  applySpectateState(s) {
    if (!s) return;
    // 丢弃过期/重复快照(与 applyRemoteState 同样的去重逻辑)
    if (s.frame !== undefined) {
      if (this._lastStateFrame && s.frame <= this._lastStateFrame &&
          this._lastStateFrame - s.frame < 3600) return;
      this._lastStateFrame = s.frame;
    }
    this._applyMechSpectate(this.p1, s.p1);
    this._applyMechSpectate(this.p2, s.p2);
    this.round = s.round;
    this.winsP1 = s.winsP1;
    this.winsP2 = s.winsP2;
    this.timer = s.timer;
    this.roundWinner = s.rw;
    this.shake = s.shake;
    if (s.gs !== this.state) this.setState(s.gs);
    this.stateTime = s.gst;
  }
  // 观战端专用: 权威字段照常硬套(血量/状态/动画), 但位置只记录目标, 由 update() 平滑逼近
  _applyMechSpectate(m, d) {
    if (!d) return;
    const keepX = m.x, keepY = m.y;
    this._applyMech(m, d);
    m._tx = m.x; m._ty = m.y;                          // 权威目标位置
    if (m._specInit) { m.x = keepX; m.y = keepY; }     // 保留当前渲染位, 交给插值逼近
    else m._specInit = true;                           // 首帧直接落位, 避免从初始点飞过来
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
  // 对手机甲: 仅把快照压入渲染延迟缓冲, 真正的应用(位置/动画/受伤)在 _interpFoe 回放
  // 这样动画与位移来自同一帧, 跳跃/击退等动作两端完全同步
  _setFoeTarget(m, d) {
    if (!d) return;
    this.interp.buffer.push({ t: performance.now() / 1000, d });
    if (this.interp.buffer.length > 30) this.interp.buffer.shift();
  }
  // 对手机甲回放: 从渲染延迟缓冲中取「当前渲染时刻」两侧快照插值
  // - 位置: 在两侧快照间线性插值(平滑)
  // - 状态/动画: 取自较近一侧快照; 跳跃事件(jumpSeq 递增)在回放时触发一次, 与位移同帧
  // - 受伤 FX: 与可见血量同步生成
  // 渲染延迟缓冲是业界标准做法(如 Source/Overwatch), 用「恒定延迟」换取「动画+位移永远一致」;
  // 本作改为按真实 RTT 自适应: 低延迟本地对战缓冲仅 40ms, 高延迟走中继时才放大到 100ms 保同步
  _interpFoe(dt) {
    // 自适应渲染延迟: 按真实 RTT 动态调节缓冲大小(北京本地/同 WiFi 对战 RTT 仅 10~30ms,
    // 硬撑 100ms 缓冲是纯加难受; 高延迟(走中继)时才放大缓冲保「动画+位移永远一致」)
    const rttMs = (typeof Net !== 'undefined' && Net.getRtt) ? Net.getRtt() : 0;
    this.interp.delay = rttMs <= 0 ? 0.07 : Math.max(0.03, Math.min(0.10, (rttMs / 1000) * 1.2));
    const buf = this.interp.buffer;
    if (buf.length === 0) return;
    const now = performance.now() / 1000;
    const renderT = now - this.interp.delay;
    // 丢弃已远超渲染时刻的旧快照(保留至少 2 个用于插值)
    while (buf.length > 2 && buf[0].t < renderT - 0.05) buf.shift();

    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderT && buf[i + 1].t >= renderT) { a = buf[i]; b = buf[i + 1]; break; }
    }
    const span = b.t - a.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 0;

    const foe = this.localPlayer === 1 ? this.p2 : this.p1;
    const tx = a.d.x + (b.d.x - a.d.x) * f;
    const ty = a.d.y + (b.d.y - a.d.y) * f;
    const dx = tx - foe.x, dy = ty - foe.y;
    // 偏差过大(被击退/击飞瞬移)直接 snap, 避免 lerp 看起来像慢动作
    if (Math.abs(dx) > 60 || Math.abs(dy) > 60) {
      foe.x = tx; foe.y = ty;
    } else {
      const k = 1 - Math.exp(-dt * 26);
      foe.x += dx * k;
      foe.y += dy * k;
    }

    // 取较近一侧快照作为离散状态来源
    const sd = (f >= 0.5) ? b.d : a.d;

    // 状态切换检测: 仅在 state 实际变化或跳跃事件(jumpSeq 递增)时才「重置」本地动画时钟,
    // 平时让对手动画以本机 60fps 速率推进(stateTime/frame 本地累加), 不再每帧被 30Hz
    // 快照钉死 —— 修复「对手二段跳整体慢/跳帧」: 原逻辑每帧 foe.stateTime = sd.stt 把
    // 动画锁在延迟后的量化值, 二段跳起跳本应 stateTime=0 重置, 却被立刻覆盖成 host 中途
    // 的 stateTime, 相位错乱 → 视觉变慢。现改为与本地玩家同机制的「事件触发+本地推进」。
    const jumpEvt = (sd.js !== undefined && sd.js > foe.jumpSeq);
    const stateEvt = (sd.st !== foe.state);
    if (jumpEvt) {
      // 跳跃事件(一段/二段跳): 触发起跳动画 + 物理, 本地动画时钟归零重新播放
      foe.jumpSeq = sd.js;
      const isDouble = sd.jc !== undefined && sd.jc >= 2;
      foe.vy = isDouble ? -8.5 : -7.2;
      foe.onGround = false;
      if (foe.state !== 'jump') { foe.state = 'jump'; foe.hitApplied = false; }
      foe.stateTime = 0; foe.frame = 0;
    } else if (stateEvt) {
      // 普通状态切换(攻击/受击/落地/idle 等): 切换 state 并让本地动画从 0 正常播放
      foe.state = sd.st; foe.hitApplied = false;
      foe.stateTime = 0; foe.frame = 0;
    }
    // 本地推进对手动画时钟(替代原每帧覆盖快照值, 解决对手动画慢/跳帧)
    foe.stateTime += dt; foe.frame += 1;

    // 受伤 FX 与可见血量同步(用回放后的 hp 比较)
    if (this.interp.prevFoeHp !== undefined && this.interp.prevFoeHp - sd.hp >= 4) {
      const otherX = this.localPlayer === 1 ? this.p1.x : this.p2.x;
      this._spawnHitFX(foe.x + (otherX > foe.x ? 20 : -20), foe.y - 40, false, (this.interp.prevFoeHp - sd.hp) >= 15);
    }
    this.interp.prevFoeHp = sd.hp;

    foe.facing = sd.f;
    foe.hp = sd.hp;
    foe.flash = sd.fl ? 0.18 : 0;
    foe.cooldown = sd.cd;
    foe.defending = sd.df;
    foe.vx = sd.vx; foe.vy = sd.vy;
    if (sd.jc !== undefined) foe.jumpCount = sd.jc;
    foe.onGround = (foe.y >= this.groundY);
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
      // 防御反伤: 减伤90% + 反伤60% 给攻击者
      if (result < 0) {
        const reflected = Math.round(hb.dmg * 0.6); // 反伤 60%, 攻击方承担
        attacker.hp = Math.max(0, attacker.hp - reflected);
        attacker.flash = 0.15;
        attacker.vx += (attacker.x >= defender.x ? 1 : -1) * 0.5;
        if (attacker.hp <= 0) { attacker.setState('ko'); attacker.vy = 3; }
        this._spawnHitFX(attacker.x, attacker.y - 40, true, false);
      }
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

    // 己方机甲金色描边: offline/host/aiHost 本地是 P1, client/aiClient 本地是 P2(你的 AI)
    const localMech = (this.mode === MODES.CLIENT || this.mode === MODES.AI_CLIENT) ? this.p2 : this.p1;
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
