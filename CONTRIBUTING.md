# Contributing

感谢参与。请先阅读 README 和 SECURITY.md，再提交 Issue 或 Pull Request。

## 开发流程

```bash
npm ci
npm run check
npm test
```

提交前请确认没有加入 Token、Cookie、`.env`、Cloudflare 资源 ID、真实任务数据或个人工作区内容。功能变更应补充测试和文档。

## Pull Request

- 说明问题、方案和安全影响；
- 保持变更聚焦，避免把个人 Hermes/VPS/飞书配置带入项目；
- 不提交真实 OAuth 回调、生产域名或第三方私有接口；
- 新增代码默认以 Apache-2.0 许可证贡献。
