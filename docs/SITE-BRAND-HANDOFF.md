# 展示站品牌与域名交接清单

Mosaiq 当前仍是产品代号。展示站已经按“后续可能改名”的方式实现，域名注册完成后优先改配置，再改文案和部署。

## 1. 先改展示页配置

入口文件：`_site/index.html`

页面顶部的 `window.SITE_CONFIG` 是品牌和链接的单点配置：

- `productName`：最终产品名
- `finalNamePending`：品牌名确定后改为 `false`
- `primaryDomain`：最终主域名
- `domainCandidates`：域名候选列表
- `githubUrl` / `quickstartUrl` / `docsUrl`：推广入口链接
- `cloudBaseUrl`：公开 Cloud API baseURL
- `waitlistUrl`：有等待名单后再填；为空时不要展示报名入口

## 2. 域名确定后的动作

- 添加托管平台的自定义域名或 `_site/CNAME`
- 给主域名配置 HTTPS，并把其他候选域名做 301 跳转
- 更新 README、QUICKSTART、Pitch Deck、npm package homepage 中的链接
- 统一 Cloud Runtime 的公开 baseURL，避免文档和网站出现多个入口
- 补充 Open Graph 图片、favicon、正式联系邮箱和等待名单链接
- 将 `<title>`、`description`、Open Graph、Twitter Card 等静态 meta 改成最终品牌；页面脚本会在浏览器里同步，但社交爬虫通常只读原始 HTML

## 3. 保持不随品牌变化的部分

- npm 包继续使用 `@runova/*`，避免品牌域名变更影响安装路径
- CLI 命令 `mosaiq` 可等品牌确认后再决定是否新增别名
- Detection Lab 数据必须继续来自真实 baseline，不因推广需要手改数字

## 4. 推广文案

推广用的 30 秒介绍、开发者外联和早期用户外联文案见 `docs/SITE-GTM-COPY.md`。最终品牌名确定后，先同步该文档，再同步展示站。
