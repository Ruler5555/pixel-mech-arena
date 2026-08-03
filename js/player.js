// player.js · 机甲实体(状态机 + 物理 + 攻击判定)
//
// 状态: idle / walk / jump / atkL / atkH / defend / hurt / ko
//
// 控制接口 ctrl: { left, right, jump, atkL, atkH, defend } 都是 bool(是否按下)
//   tapL/tapH/tapJump 表示"刚按下"(用于触发)

const PALETTES = {
  blue: { primary:'#4ad6ff', secondary:'#2a7fb5', dark:'#123a55', visor:'#ffcc33', accent:'#ffffff', weapon:'#aab4c8', shield:'#4ad6ff' },
  red:  { primary:'#ff5a6a', secondary:'#a8263a', dark:'#5a1525', visor:'#ffcc33', accent:'#ffffff', weapon:'#aab4c8', shield:'#ff5a6a' }
};

class Mech {
  constructor(opts) {
    this.x = opts.x;
    this.y = opts.groundY;     // 脚底 y
    this.groundY = opts.groundY;
    this.facing = opts.facing; // 1 / -1
    this.pal = PALETTES[opts.color];
    this.name = opts.name;
    this.color = opts.color;

    this.maxHP = opts.maxHP || 100; // [v141] 联机 AI 对战模式由 Game 传入 120, 其余模式默认 100
    this.hp = this.maxHP;

    // 物理
    this.vx = 0;
    this.vy = 0;
    this.onGround = true;

    // 状态机
    this.state = 'idle';
    this.stateTime = 0;
    this.frame = 0;
    this.jumpSeq = 0; // 跳跃事件计数(联机同步用)
    this.jumpCount = 0; // 当前跳跃次数: 0=地面, 1=一段跳, 2=二段跳
    this.jumpCD = 0; // 跳跃冷却计时(秒), 防止快速连按吞动画

    // 攻击参数
    this.atk = null; // { type:'L'|'H', time, hit:Set, dmg, reach, height, activeStart, activeEnd, duration }
    this.flash = 0;  // 受击白闪

    // 防御
    this.defending = false;
    this.defendCD = 0;   // 再防冷却: 松手后 0.5s 内不能再次举盾

    // 攻击冷却(避免连点)
    this.cooldown = 0;

    // 用于判定是否已触发"命中"事件
    this.hitApplied = false;
  }

  get width() { return 30; }
  get height() { return 90; }

  setState(s) {
    if (this.state !== s) {
      this.state = s;
      this.stateTime = 0;
      this.hitApplied = false;
    }
  }

  // 发动攻击
  startAttack(type) {
    if (this.state === 'ko' || this.state === 'hurt') return false;
    if (this.cooldown > 0) return false;
    if (!this.onGround) return false; // 空中不能攻击
    if (this.defending) return false;

    if (type === 'L') {
      this.atk = { type, duration: 0.34, activeStart: 0.08, activeEnd: 0.18, dmg: 8,  reach: 50, height: 50, cd: 0.14 };
    } else {
      this.atk = { type, duration: 0.86, activeStart: 0.26, activeEnd: 0.40, dmg: 18, reach: 64, height: 60, cd: 0.40 };
    }
    this.setState('atk' + type);
    this._hitDone = false; // 每次新攻击重新武装, 保证"一次攻击只命中一次"
    this.cooldown = this.atk.duration + this.atk.cd;
    return true;
  }

  takeHit(dmg, fromX, flanked) {
    if (this.state === 'ko') return 0;
    // [v206] 绕后背刺(机动流 vs 铁壁): 无视防御全额伤害 + 不触发反弹(偷屁股没有反弹)
    if (flanked) {
      this.hp = Math.max(0, this.hp - dmg);
      this.flash = 0.18;
      this.vx += (this.x >= fromX ? 1 : -1) * 2.2;
      if (this.onGround && this.state !== 'atkL' && this.state !== 'atkH') {
        this.setState('hurt');
      }
      if (this.hp <= 0) {
        this.setState('ko');
        this.vy = 3;
        this.vx = (this.x >= fromX ? 1 : -1) * 3;
      }
      return dmg;
    }
    // 防御减伤
    if (this.defending && this.state === 'defend') {
      const taken = dmg * 0.1; // 盾牌减伤 90%, 仅承受 10%(内部保留小数, 显示时四舍五入)
      this.hp = Math.max(0, this.hp - taken);
      this.flash = 0.12;
      // 防御时仍受小幅击退但不进入 hurt
      this.vx += (this.x >= fromX ? 1 : -1) * 0.6;
      return -taken; // 负值表示被防御
    }
    this.hp = Math.max(0, this.hp - dmg);
    this.flash = 0.18;
    // 击退
    this.vx += (this.x >= fromX ? 1 : -1) * 2.2;
    if (this.onGround && this.state !== 'atkL' && this.state !== 'atkH') {
      this.setState('hurt');
    }
    if (this.hp <= 0) {
      this.setState('ko');
      this.vy = 3;
      this.vx = (this.x >= fromX ? 1 : -1) * 3;
    }
    return dmg;
  }

  // 判定当前攻击是否处于"可命中"窗口
  // 必须同时满足: 有攻击数据 + 当前确实处于对应攻击状态(防止状态被打断后残留 atk 产生幻影命中盒)
  attackActive() {
    if (!this.atk) return false;
    if (this.state !== 'atk' + this.atk.type) return false;
    const t = this.stateTime;
    return t >= this.atk.activeStart && t <= this.atk.activeEnd;
  }

  // 攻击命中盒(相对于自身脚底)
  attackHitbox() {
    if (!this.attackActive()) return null;
    const a = this.atk;
    const cx = this.x + this.facing * (a.reach * 0.5);
    const w = a.reach;
    const h = a.height;
    return { x: cx - w / 2, y: this.y - h * 0.7, w, h, dmg: a.dmg, fromX: this.x };
  }

  // 自身受击盒
  bodyBox() {
    const w = 36, h = 78;
    return { x: this.x - w / 2, y: this.y - h, w, h };
  }

  update(dt, ctrl, opponent, world) {
    this.frame++;
    this.stateTime += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.defendCD > 0) this.defendCD -= dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.jumpCD > 0) this.jumpCD -= dt;

    const dead = this.state === 'ko';
    const hurt = this.state === 'hurt';
    let attacking = this.state === 'atkL' || this.state === 'atkH';

    // ---- 输入 ----
    const wasDefending = this.defending;
    let wantDefend = false;
    if (!dead && !hurt) {
      // 攻击触发
      // 关键: startAttack 成功后必须刷新 attacking, 否则本帧后续的
      // "状态切换"仍按旧值 false 把状态改回 idle/walk, 留下永不清除的
      // 孤儿 this.atk —— 之后每次状态切换 stateTime 归零都会重新穿过
      // 命中窗口, 造成"点过一次攻击后靠近就自动出伤害"的幻影伤害 bug
      if (ctrl.tapL && this.onGround && !attacking) { if (this.startAttack('L')) attacking = true; }
      else if (ctrl.tapH && this.onGround && !attacking) { if (this.startAttack('H')) attacking = true; }

      // 防御(按住) — 攻击中不能切防御; 松手后进入 0.5s 再防冷却
      wantDefend = ctrl.defend && !attacking && this.onGround && this.defendCD <= 0;

      // 移动(防御/攻击中不能移动)
      const moveLocked = wantDefend || attacking;
      let dir = 0;
      if (!moveLocked) {
        if (ctrl.left)  dir -= 1;
        if (ctrl.right) dir += 1;
      }
      this.vx = dir * 3.6; // [TUNE] 移速 2.2→3.0→3.6, 持续提升手感(不过分)

      // 跳跃(含二段跳 + 冷却CD)
      if (ctrl.tapJump && !attacking && !this.defending && this.jumpCD <= 0) {
        if (this.onGround) {
          // 一段跳
          this.vy = -7.2;
          this.onGround = false;
          this.jumpCount = 1;
          this.jumpSeq++;
          this.jumpCD = 0.18;
          this.setState('jump');
        } else if (this.jumpCount < 2) {
          // 二段跳: 比一段跳更强, 明显跳得更高
          this.vy = -8.5;
          this.jumpCount = 2;
          this.jumpSeq++;
          this.jumpCD = 0.25;
          this.setState('jump');
          this.stateTime = 0; // 重置动画, 保证二段跳起跳可见
        }
      }

      // 状态切换
      if (!attacking && !this.defending) {
        if (!this.onGround) this.setState('jump');
        else if (dir !== 0) {
          this.setState('walk');
          this.facing = dir > 0 ? 1 : -1;
        } else this.setState('idle');
      }
    }

    // 防御结果落地: 松开(本次未保持)→ 记 0.5s 再防冷却, 防无限举盾
    if (wasDefending && !wantDefend && this.defendCD <= 0) this.defendCD = 0.5;
    this.defending = wantDefend;
    if (this.defending) this.setState('defend');

    // 朝向: 始终面向对手(非攻击/移动时)
    if (!attacking && !hurt && !dead && this.onGround && !this.defending) {
      if (opponent) {
        this.facing = (opponent.x >= this.x) ? 1 : -1;
      }
    }

    // 攻击过程中朝向锁定(已设)

    // ---- 攻击状态结束 ----
    if (attacking && this.atk && this.stateTime >= this.atk.duration) {
      this.atk = null;
      this._hitDone = false;
      this.setState(this.onGround ? 'idle' : 'jump');
    }
    // 兜底: 状态已不是攻击态却残留 atk 数据(被 hurt/ko/任何打断), 立即清除
    // 防止孤儿 atk 在之后的状态切换中重新产生命中盒
    if (!attacking && this.atk && this.state !== 'atkL' && this.state !== 'atkH') {
      this.atk = null;
      this._hitDone = false;
    }
    if (hurt && this.stateTime >= 0.3) {
      this.setState(this.onGround ? 'idle' : 'jump');
    }

    // ---- 物理 ----
    this.x += this.vx;
    this.y += this.vy;

    if (!this.onGround) {
      this.vy += 0.42; // 重力
    }
    // 摩擦(地面)
    if (this.onGround && !attacking && !this.defending && hurt === false) {
      this.vx *= 0.6;
    }

    // 地面碰撞
    if (this.y >= this.groundY) {
      this.y = this.groundY;
      this.vy = 0;
      if (!this.onGround) {
        this.onGround = true;
        this.jumpCount = 0;
        this.jumpCD = 0.1; // 落地短暂冷却, 避免落地瞬间误触发
        if (this.state === 'jump' && !attacking) this.setState('idle');
      }
    }

    // 边界
    const margin = 30;
    if (this.x < margin) { this.x = margin; this.vx = 0; }
    if (this.x > world.W - margin) { this.x = world.W - margin; this.vx = 0; }

    // 倒地后落地静止
    if (dead && this.onGround) {
      this.vx *= 0.8;
      if (Math.abs(this.vx) < 0.05) this.vx = 0;
    }
  }

  draw(ctx, isLocal) {
    const pose = {
      state: this.state,
      stateTime: this.stateTime,
      frame: this.frame,
      flash: this.flash > 0
    };
    // 己方机甲: 沿像素轮廓描一圈金色线条(离屏剪影 8 方向偏移 1px, 不放大本体)
    if (isLocal) this._drawGoldOutline(ctx, pose);
    Sprite.drawMech(ctx, this.x, this.y, this.facing, pose, this.pal);
  }

  _drawGoldOutline(ctx, pose) {
    // 离屏画布懒初始化(全体 Mech 共享, 每帧只有己方一台使用)
    if (!Mech._olA) {
      Mech._olA = document.createElement('canvas');
      Mech._olA.width = 200; Mech._olA.height = 200;
      Mech._olB = document.createElement('canvas');
      Mech._olB.width = 200; Mech._olB.height = 200;
    }
    const A = Mech._olA, B = Mech._olB;
    const ax = A.getContext('2d'), bx = B.getContext('2d');
    // 1) 把机甲画进离屏画布 A(脚底锚点定在 100,160)
    ax.clearRect(0, 0, 200, 200);
    ax.imageSmoothingEnabled = false;
    Sprite.drawMech(ax, 100, 160, this.facing, pose, this.pal);
    // 2) B = A 的金色剪影
    bx.clearRect(0, 0, 200, 200);
    bx.globalCompositeOperation = 'source-over';
    bx.drawImage(A, 0, 0);
    bx.globalCompositeOperation = 'source-in';
    bx.fillStyle = '#ffd700';
    bx.fillRect(0, 0, 200, 200);
    // 3) 主画布上沿 8 方向各偏移 1px 画剪影 → 形成 1px 金色轮廓(随后本体覆盖中间)
    const o = 1;
    const offs = [[-o,0],[o,0],[0,-o],[0,o],[-o,-o],[o,-o],[-o,o],[o,o]];
    ctx.save();
    ctx.globalAlpha = 0.9;
    for (let i = 0; i < offs.length; i++) {
      ctx.drawImage(B, this.x - 100 + offs[i][0], this.y - 160 + offs[i][1]);
    }
    ctx.restore();
  }
}

// AABB 相交
function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
