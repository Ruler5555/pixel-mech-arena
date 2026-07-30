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

    this.maxHP = 100;
    this.hp = 100;

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
      this.atk = { type, duration: 0.40, activeStart: 0.10, activeEnd: 0.20, dmg: 8,  reach: 50, height: 50, cd: 0.25 };
    } else {
      this.atk = { type, duration: 1.00, activeStart: 0.30, activeEnd: 0.42, dmg: 14, reach: 64, height: 60, cd: 0.60 };
    }
    this.setState('atk' + type);
    this.cooldown = this.atk.duration + this.atk.cd;
    return true;
  }

  takeHit(dmg, fromX) {
    if (this.state === 'ko') return 0;
    // 防御减伤
    if (this.defending && this.state === 'defend') {
      const reduced = Math.round(dmg * 0.4);
      this.hp = Math.max(0, this.hp - reduced);
      this.flash = 0.12;
      // 防御时仍受小幅击退但不进入 hurt
      this.vx += (this.x >= fromX ? 1 : -1) * 0.6;
      return -reduced; // 负值表示被防御
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
  attackActive() {
    if (!this.atk) return false;
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
    if (this.flash > 0) this.flash -= dt;
    if (this.jumpCD > 0) this.jumpCD -= dt;

    const dead = this.state === 'ko';
    const hurt = this.state === 'hurt';
    const attacking = this.state === 'atkL' || this.state === 'atkH';

    // ---- 输入 ----
    this.defending = false;
    if (!dead && !hurt) {
      // 攻击触发
      if (ctrl.tapL && this.onGround && !attacking) this.startAttack('L');
      else if (ctrl.tapH && this.onGround && !attacking) this.startAttack('H');

      // 防御(按住) — 攻击中不能切防御
      if (ctrl.defend && !attacking && this.onGround) {
        this.defending = true;
        this.setState('defend');
      }

      // 移动(防御/攻击中不能移动)
      const moveLocked = this.defending || attacking;
      let dir = 0;
      if (!moveLocked) {
        if (ctrl.left)  dir -= 1;
        if (ctrl.right) dir += 1;
      }
      this.vx = dir * 3.0; // [TUNE] 原 2.2, 玩家反馈偏慢, 提升至 3.0 (~+36%)

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
      this.setState(this.onGround ? 'idle' : 'jump');
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

  draw(ctx) {
    Sprite.drawMech(ctx, this.x, this.y, this.facing, {
      state: this.state,
      stateTime: this.stateTime,
      frame: this.frame,
      flash: this.flash > 0
    }, this.pal);
  }
}

// AABB 相交
function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
