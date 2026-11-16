#!/bin/sh
# P2-7: 負荷をかける側の回線に、遅延とパケット損失を加える（Linux。root で実行）【提案値: 遅延100ms・損失2%】
#   sudo tools/netem.sh on eth0      … 加える
#   sudo tools/netem.sh off eth0     … 元に戻す
# 負荷をかける側のマシン（サーバーとは別のマシン）で実行すること。サーバー自身にかけると、SSH も遅くなる。
set -eu
DEV="${2:-eth0}"
case "${1:-}" in
  on)  tc qdisc replace dev "$DEV" root netem delay "${DELAY:-100ms}" loss "${LOSS:-2%}" ; tc qdisc show dev "$DEV" ;;
  off) tc qdisc del dev "$DEV" root || true ; tc qdisc show dev "$DEV" ;;
  *)   echo "usage: $0 on|off [device]" >&2 ; exit 1 ;;
esac
