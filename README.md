# 税智中枢费用审核知识图谱网站

该服务将 Neo4j 4.4 数据转换为浏览器可用的知识图谱 API，并通过仓库内置的费用审核 HTML 页面进行交互展示。

仓库已经包含网页、服务端代理和环境变量模板，不包含任何真实数据库密码或生产数据。

## 启动

```bash
NEO4J_PASSWORD='你的Neo4j密码' npm start
```

默认访问地址：`http://127.0.0.1:4174/`

## 接口

- `GET /api/health`：Neo4j 连接和数据规模。
- `GET /api/graph`：本体模式、600/500 实例以及 INSTANCE_OF 关系。
- `POST /api/audit`：执行并回写业务招待费限额审核。

浏览器不会获得 Neo4j 账号或密码，所有查询都由本地服务代理完成。

## 目录

- `expense-audit-knowledge-graph.html`：知识图谱前端页面。
- `server.mjs`：Neo4j 查询、审核 API 与静态页面服务。
- `.env.example`：可安全提交的本地配置模板。
