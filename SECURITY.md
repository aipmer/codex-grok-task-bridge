# Security Policy

## Reporting a vulnerability

请不要在公开 Issue 中发布 Token、Cookie、OAuth 授权码、任务正文或可利用细节。请通过 GitHub Security Advisories 或维护者的私下渠道报告，并提供复现步骤、影响范围和建议修复方式。

## Deployment guidance

- 每个环境使用独立的 Bearer Token、OAuth 登录码和签名密钥；
- 不要公开共享 Worker 实例；
- 附件只上传无敏感信息的小文件；
- Grok Bot 不应获得知识库、飞书或生产系统写权限；
- 发现凭据泄露时，先吊销并轮换，再清理 Git 历史。
