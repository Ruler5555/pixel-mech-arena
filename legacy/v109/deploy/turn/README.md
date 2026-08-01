# 自托管 TURN 服务器（根治对称 NAT 高延迟）

## 问题背景
PIXEL MECH ARENA 联机默认走 PeerJS P2P（直连延迟最低）。但部分网络（公司/校园网、部分运营商）是**对称 NAT**，P2P 直连建不起来，会被迫退回公共 broker 中继（`broker.emqx.io`），延迟 200ms+ 且抖动大。

TURN 服务器的作用是：当 P2P 直连失败时，由你的**专属中转服务器**转发数据，延迟远低于公共 broker，且稳定可控。

## 部署步骤（约 5 分钟）

1. 准备一台有**公网 IP** 的服务器（任意云厂商 1C1G 小机即可），装好 Docker。
2. 把本目录（`deploy/turn/`）上传到服务器，或直接 `git clone` 整个仓库后进入该目录。
3. 编辑 `coturn.conf`：
   - `external-ip` 改为服务器公网 IP
   - `relay-ip` 改为服务器内网 IP（单网卡可注释掉此行）
   - `static-auth-secret` 改为随机长字符串：`openssl rand -hex 32`
4. 放行防火墙端口：`3478/udp`、`3478/tcp`、`49152-65535/udp`（按需 5349/tcp）。
5. 启动：`docker compose up -d`
6. 验证：`docker logs pma-turn` 看到 `RFC 5389` 监听即成功。

## 接入游戏客户端
部署成功后，把 `js/net.js` 里的 `TURN_SERVERS` 填上你的凭据：

```js
const TURN_SERVERS = [
  { urls: 'turn:YOUR_PUBLIC_IP:3478?transport=tcp', username: 'pma', credential: '你设的 static-auth-secret' },
  { urls: 'turn:YOUR_PUBLIC_IP:3478?transport=udp', username: 'pma', credential: '你设的 static-auth-secret' }
];
```

改完提交并 `git push`，GitHub Pages 自动重建即可。此后对称 NAT 用户会经由你的 TURN 中转，延迟从 200ms+ 降到几十 ms。

## 在游戏内验证
对局中右上角 `topCluster` 会显示实时 **RTT（ping 延迟）**：
- 绿色 `< 80ms`：优秀（多半已是 P2P 直连或你的 TURN）
- 黄色 `< 150ms`：可用
- 红色 `≥ 150ms`：仍偏慢，检查是否走错通道

## 成本
coturn 极轻量，1C1G 服务器月费通常几元到十几元，可服务成百上千并发对局。相比体验提升，非常划算。
