# 安全策略

## 报告漏洞

请通过 GitHub 私有漏洞报告提交：
https://github.com/f12-wwt/spore-factory-web/security/advisories/new

不要通过公开 Issue 提交未修复漏洞的细节。

## 支持范围

| 版本 | 安全更新 |
|------|----------|
| `main`（当前网页验证版） | 支持 |

## 已启用的防护

- 生产构建注入内容安全策略（CSP），禁止内联脚本与行内事件处理器；`no-referrer` 引用策略。
- 生产包不暴露开发调试桥 `window.SFW`。
- `localStorage` 存档按数据表白名单、字段类型、数量与版本上限校验。
- 发布流水线固定 Actions 提交 SHA，并执行静态检查、单元测试、生产构建门禁。
- 仓库开启密钥扫描、推送保护、Dependabot 安全更新与 `main` 分支保护。

## 平台限制

GitHub Pages 不支持自定义响应头。`X-Content-Type-Options`、`X-Frame-Options`、
`Permissions-Policy` 无法通过 meta 标签下发；仓库已提供 `public/_headers` 配置，
迁移到支持自定义响应头的托管平台（Cloudflare Pages / Netlify）后即时生效。
当前站点 `Strict-Transport-Security` 由 GitHub Pages 提供。
