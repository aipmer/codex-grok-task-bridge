# 公开 X 账号调研案例：Codex × Grok Bot

2026-09-13，Codex 通过任务桥向 Grok Bot 提交了一个只读网页调研任务：抓取 [@Khazix0918](https://x.com/Khazix0918) 当日公开发文，并整理关键内容。

## 结果

- Grok Bot 在云端浏览器中完成抓取，任务成功回传结构化结果。
- 按 X 页面显示日期，发现 1 条原帖，未发现其他同日公开发文。
- 主题为 AIHOT 的「Tibo 重置监控」：重置日历、群通知和无需 API Key 的 JSON API。
- 结果包含原帖地址、相关产品链接和时间/可见性限制说明。

原帖：[x.com/Khazix0918/status/2099030353549594906](https://x.com/Khazix0918/status/2099030353549594906)

相关链接：[Tibo 重置日历](https://aihot.news/codex-reset) · [API 接口](https://aihot.news/api/v1/codex-resets) · [接入说明](https://aihot.news/agent?tab=api)

## 交接链路

```text
Codex create_task
  → Grok Bot claim_next_task
  → 云端浏览器读取公开 X 页面
  → progress / complete_task
  → Codex get_task 获取摘要与证据
```

本案例没有登录 X、点赞、评论、转发、关注、发私信或写入外部系统。时间判断依据 X 页面显示日期；由于页面未提供可直接读取的绝对 UTC 时间，结果保留了相应限制说明。该案例是手动触发的 Bot 对话验证，不代表已验证 Routine 的无人值守触发能力。
