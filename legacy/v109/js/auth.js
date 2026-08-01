// auth.js · 纯前端账号系统(localStorage 存储)
//
// 功能: 注册 / 登录 / 登出 / 会话持久化 / 获取当前用户
//
// 存储结构:
//   pma_accounts: JSON 数组 [{id, name, pass(编码后), createdAt}]
//   pma_session  : 当前登录用户 ID
//
// 密码仅用 btoa/atob 简单编码, 非安全用途, 仅防肉眼可见
//
// 接口:
//   Auth.register(name, pass) -> {ok, data, err}
//   Auth.login(name, pass)    -> {ok, data, err}
//   Auth.logout()
//   Auth.currentUser()        -> {id, name, createdAt} | null
//   Auth.isLoggedIn()         -> bool

(function (global) {
  'use strict';

  // localStorage 键名
  var KEY_ACCOUNTS = 'pma_accounts';
  var KEY_SESSION = 'pma_session';

  // 玩家 ID 配置: 前缀 "PMA-" + 6 位随机字符, 形如 PMA-3F8K2X
  var ID_PREFIX = 'PMA-';
  var ID_RAND_LEN = 6;
  var ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  // ---------- 内部工具 ----------

  // 读取全部账号
  function readAccounts() {
    var raw = localStorage.getItem(KEY_ACCOUNTS);
    if (!raw) return [];
    try {
      var data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }

  // 写入全部账号
  function writeAccounts(accounts) {
    localStorage.setItem(KEY_ACCOUNTS, JSON.stringify(accounts));
  }

  // 密码简单编码(兼容中文等非 ASCII 字符)
  function encodePass(pass) {
    try {
      return btoa(unescape(encodeURIComponent(pass)));
    } catch (e) {
      return btoa(pass);
    }
  }

  // 密码简单解码
  function decodePass(code) {
    try {
      return decodeURIComponent(escape(atob(code)));
    } catch (e) {
      try { return atob(code); } catch (e2) { return ''; }
    }
  }

  // 生成一个随机玩家 ID
  function makeRandomId() {
    var s = '';
    for (var i = 0; i < ID_RAND_LEN; i++) {
      s += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    }
    return ID_PREFIX + s;
  }

  // 生成不重复的玩家 ID(避免碰撞)
  function generateUniqueId() {
    var accounts = readAccounts();
    var id;
    do {
      id = makeRandomId();
    } while (accounts.some(function (a) { return a.id === id; }));
    return id;
  }

  // 参数校验, 返回错误信息字符串或 null
  function validate(name, pass) {
    if (typeof name !== 'string' || typeof pass !== 'string') {
      return '用户名和密码必须为字符串';
    }
    if (name.length < 3 || name.length > 12) {
      return '用户名长度需为 3-12 字符';
    }
    if (pass.length < 4 || pass.length > 20) {
      return '密码长度需为 4-20 字符';
    }
    return null;
  }

  // 规范化为字符串(防止传入非字符串)
  function toStr(v) {
    return v == null ? '' : String(v);
  }

  // ---------- 对外接口 ----------

  // 注册: 用户名(3-12) + 密码(4-20), 自动生成玩家 ID
  function register(name, pass) {
    name = toStr(name).trim();
    pass = toStr(pass);

    var err = validate(name, pass);
    if (err) return { ok: false, data: null, err: err };

    var accounts = readAccounts();
    // 用户名唯一性检查
    var exists = accounts.some(function (a) { return a.name === name; });
    if (exists) {
      return { ok: false, data: null, err: '用户名已被占用' };
    }

    var account = {
      id: generateUniqueId(),
      name: name,
      pass: encodePass(pass),
      createdAt: new Date().toISOString()
    };
    accounts.push(account);
    writeAccounts(accounts);

    return {
      ok: true,
      data: { id: account.id, name: account.name, createdAt: account.createdAt },
      err: null
    };
  }

  // 登录: 校验用户名 + 密码, 成功后写入会话
  function login(name, pass) {
    name = toStr(name).trim();
    pass = toStr(pass);

    if (!name || !pass) {
      return { ok: false, data: null, err: '用户名和密码不能为空' };
    }

    var accounts = readAccounts();
    var account = null;
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].name === name) {
        account = accounts[i];
        break;
      }
    }
    if (!account) {
      return { ok: false, data: null, err: '用户名或密码错误' };
    }

    // 校验密码(解码后明文比对)
    if (decodePass(account.pass) !== pass) {
      return { ok: false, data: null, err: '用户名或密码错误' };
    }

    // 写入会话, 持久化登录状态
    localStorage.setItem(KEY_SESSION, account.id);

    return {
      ok: true,
      data: { id: account.id, name: account.name, createdAt: account.createdAt },
      err: null
    };
  }

  // 登出: 清除会话
  function logout() {
    localStorage.removeItem(KEY_SESSION);
  }

  // 获取当前登录用户, 未登录返回 null
  function currentUser() {
    var sessionId = localStorage.getItem(KEY_SESSION);
    if (!sessionId) return null;

    var accounts = readAccounts();
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id === sessionId) {
        return { id: accounts[i].id, name: accounts[i].name, createdAt: accounts[i].createdAt };
      }
    }
    // 会话对应的账号已不存在, 清理无效会话
    localStorage.removeItem(KEY_SESSION);
    return null;
  }

  // 是否已登录
  function isLoggedIn() {
    return currentUser() !== null;
  }

  // 暴露全局对象
  global.Auth = {
    register: register,
    login: login,
    logout: logout,
    currentUser: currentUser,
    isLoggedIn: isLoggedIn
  };
})(typeof window !== 'undefined' ? window : this);
