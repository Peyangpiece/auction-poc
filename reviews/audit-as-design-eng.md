# Design Engineering Audit: 装飾を外し、Apple の水準に整える

**Perspective**: Design Engineer（audit-as-design-eng）＋ make-interfaces-feel-better の点検表 ＋ AI チェッカー（impeccable）＋ アクセシビリティ（axe）
**Date**: 2026-11-18
**Plan**: 作業中の変更（web/app.css・bidder.css・bidder.js・bidder.html・site.css・console.css・monitor.css・monitor.html・login.html）

## Plan Summary

紺の大きな面・金の線と印・影・光と紙吹雪の演出・回るコイン・大きなエンブレムを外し、白と Apple の灰色の面に、紺を「押せるもの」にだけ使う配色へ変えた。

## Files Reviewed
| File | Visual Role | Risk |
|------|-------------|------|
| web/app.css | 色・影・ボタン・表示板の共通の決まり | 高（全画面に効く） |
| web/bidder.css / bidder.js / bidder.html | 入札画面、演出 | 高 |
| web/site.css | 会員の画面・管理画面 | 中 |
| web/monitor.css / monitor.html | 会場モニター | 中 |
| web/console.css | 進行コンソール | 低 |

## Verdict: APPROVE WITH CHANGES（見つけた3件は直した）

## Critical Issues (Must Fix)
| # | Issue | File(s) | Impact | Fix |
|---|-------|---------|--------|-----|
| 1 | トップページの「本日の開催」の板が、灰色の地の上で灰色の面になり、地と区別がつかない | site.css | 当日のいちばん大事な案内が、背景に埋もれる | 灰色の地の上では白い面（暗い配色では濃い灰色）にした【直した】 |
| 2 | 管理画面の表で、行ごとに紺の塗りのボタンが並ぶ | site.css | 紺の面が画面中に散らばり、「ブランドの色は少しだけ」の方針に反する | 表の中の操作は、うすい塗りのボタンにした（ダイアログと画面の主な操作だけが紺）【直した】 |
| 3 | 落札の知らせの札が、出入りの途中（半透明）で文字の色の検査に掛かる | tools/e2e/a11y.mjs | 検査の誤検出（画面の欠陥ではない） | 札が消えてから板を検査する。札そのものは、白い面に濃い文字（十分なコントラスト）【直した】 |

## Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | 参加のしかたの選択が、太い枠と紺の大きな文字 | bidder.css | 装飾が多く、選ぶ行に見えない | Apple の設定画面の行（灰色の面・名前と説明・右に ›）にした【直した】 |
| 2 | 入場の画面のロゴが、画面の幅いっぱい | bidder.css | ロゴが主役になり、選ぶことが後ろに下がる | 220px に抑えた【直した】 |
| 3 | カレンダーの月の文字が赤 | site.css | 意味のない色 | 灰色にした【直した】 |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | 映像のない間の面（#1c1c1e）とモニターの灰色を、色の変数にまとめる | 今は数か所に同じ値を書いている。値は Apple の暗い配色の灰色で、両方の配色で同じ |
| 2 | 管理画面の行の操作が2行に折り返す（「送付済みにする」） | はみ出しを防ぐための折り返し（前回の見直し）。列の幅を見直すときに一緒に |

## Design System Compliance
色は app.css の変数だけで決まる（紺 `--action`、灰色の面 `--ground-alt`、表示板 `--board` は灰色の面に変えた）。金（`--gold`）は変数ごと消した（ロゴの画像の中にだけ残る）。影は、浮いて出るもの（ダイアログ・知らせの帯・落札の札）にだけ。

## Visual State Coverage
| Component/Element | Hover | Focus | Active | Disabled | Loading | Empty | Error | Dark Mode |
|-------------------|-------|-------|--------|----------|---------|-------|-------|-----------|
| 入札ボタン（紺） | ✓ | ✓ | ✓（縮む） | ✓（状態の文字） | ✓（送信中） | – | ✓（板の赤字） | ✓ |
| 金額の欄 | ✓ | ✓（紺の縁と輪） | – | – | – | ✓ | ✓ | ✓ |
| 参加のしかたの行 | ✓ | ✓ | ✓（縮む） | – | – | – | – | ✓ |
| 表示板 | – | – | – | – | – | ✓（待機中） | ✓（上回られた: 赤い縁） | ✓ |
| 落札の知らせの札 | – | – | – | – | – | – | – | ✓ |
| 会場モニター | – | – | – | – | ✓（接続中） | ✓（待機） | – | 暗い配色のみ（会場の画面） |

## Verdict Details
- Design Token Fidelity: PASS
- Visual State Coverage: PASS
- Dark Mode Parity: PASS（明るい・暗い配色の両方で、画面を撮って確かめ、アクセシビリティの検査も両方で通った）
- Animation Quality: PASS（入札は 0.3 秒の小さな弾み、落札は 0.25 秒で出て 0.25 秒で消える札。transform と opacity だけ。「動きを減らす」設定では動かさない）
- Visual Consistency: PASS
