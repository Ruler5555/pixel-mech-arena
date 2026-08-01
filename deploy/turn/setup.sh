#!/bin/bash
# ============================================================
# PIXEL MECH ARENA · 一键部署 coturn TURN 服务器 (Ubuntu)
# 用法: bash setup.sh <公网IP> [TURN密码]
#   公网IP 必填; TURN密码 缺省自动生成
# 部署后: 云控制台防火墙放行 3478/udp+tcp, 49152-65535/udp
# ============================================================
set -e
IP="${1:?用法: bash setup.sh <公网IP> [TURN密码]}"
PWD="${2:-$(openssl rand -hex 8)}"

echo "==> 1/4 安装 Docker (约1分钟)"
curl -fsSL https://get.docker.com | sh

echo "==> 2/4 写 coturn.conf"
mkdir -p /opt/turn
cat > /opt/turn/coturn.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
external-ip=${IP}
min-port=49152
max-port=65535
fingerprint
lt-cred-mech
user=pma:${PWD}
realm=pixel-mech-arena
EOF

echo "==> 3/4 启动 coturn 容器"
docker rm -f pma-turn 2>/dev/null || true
docker run -d --name pma-turn --network host \
  -v /opt/turn/coturn.conf:/etc/coturn/turnserver.conf:ro \
  coturn/coturn:latest -c /etc/coturn/turnserver.conf

echo "==> 4/4 验证监听"
sleep 2
docker logs pma-turn 2>&1 | grep -iE "listening|RFC" | head -3 || echo "(日志未匹配, 可手动: docker logs pma-turn)"

echo ""
echo "================================================"
echo "  部署完成! TURN 配置如下(发给开发接入):"
echo "    urls:       turn:${IP}:3478"
echo "    username:   pma"
echo "    credential: ${PWD}"
echo "================================================"
echo "  云控制台防火墙放行: 3478/udp, 3478/tcp, 49152-65535/udp"
