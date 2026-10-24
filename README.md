# Exomem

自托管的跨对话记忆库。通过私有 MCP Plugin 为 ChatGPT 提供 timeline 和 notes；通过 WebUI 管理空间、凭据和记忆。

## 功能

- 多个独立 spaces；每个 space 可创建多个 UUID `token.txt`，可暂停、恢复、永久废止。
- 每次 MCP 调用显式提交 token，权限不依赖 MCP session。支持只读和读写凭据。
- Timeline：UTC 精确时刻或纯日期。Space 不设时区。
- Notes：标题、自由 tags、Markdown 内容。WebUI 使用现成的 Milkdown Crepe 所见即所得编辑器。
- CJK / Unicode 字面子串检索；NFC 规范化与 Unicode case folding；短关键词同样可检索。无向量数据库。
- 幂等请求、乐观并发控制、修改历史、软删除和版本恢复。
- JSON 导入导出，Markdown 原文导入为笔记；SQLite 一致性备份。
- 没有 curl、任意网络访问、shell 或自动摘要服务。

## 本地运行

需要 Node.js 24 LTS 与 pnpm 11.25.0。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

- WebUI：`http://127.0.0.1:5173`
- 管理 API：`http://127.0.0.1:3210/api`
- MCP Streamable HTTP：`http://127.0.0.1:3211/mcp`
- 默认数据库：`data/exomem.sqlite`（不进入 Git）

```sh
pnpm check
pnpm test
pnpm build
pnpm start
pnpm backup
```

环境变量见 `.env.example`。直接运行时请通过 shell 或服务管理器注入环境变量，应用不会自动加载 `.env`。

## ChatGPT 使用

1. 在 WebUI 创建 space 和凭据，下载 `token.txt`。凭据原文只在创建时提供，数据库仅存 SHA-256 摘要。
2. 将文件上传到希望参与该 space 的 ChatGPT 对话，启用 Exomem 插件。
3. 告诉模型读取文件并调用 `memory_bootstrap`，需要时检索，及时保存有长期价值的信息。
4. 如果文件无法读取，在 WebUI 创建新凭据。多个凭据可以共用同一个 space。

MCP 提供 `memory_bootstrap`，以及 `notes_*`、`timeline_*` 的 search/get/create/update/delete。每次调用必须带 token。模型可自由组织笔记和 tags；Exomem 不自动读取聊天记录，也不会在工具调用以外自动保存内容。

写入提供 `request_id`；同一操作重试使用相同 ID 和相同参数。修改和删除提供 `expected_revision`，冲突后重新读取合并。查询结果带摘要与游标；长正文通过 get 的 `nextOffset` 分段读取。删除在 WebUI 回收站恢复。

## 时间与检索

精确时刻输入必须包含 UTC 标志或偏移量，统一存为 ISO UTC。纯日期保存为 `YYYY-MM-DD`，不转换为午夜。WebUI 的具体时刻使用浏览器时区；日期不变。时间线按存储的 UTC 时间/日期倒序，纯日期事件与具体时刻之间没有虚构的准确先后关系。

检索原文保持不变，搜索副本使用 NFC → Unicode case folding → NFC。FTS5 trigram 只加速至少三个 Unicode code point 的查询，最终用字面子串检查；更短查询扫描当前 space，保证不会漏掉短关键词。默认不做简繁转换、同义词或拼写模糊匹配。tag 筛选为精确匹配。

## 部署约定

**只在本地修改源代码，commit、push 后在服务器 Git pull。禁止服务器修改源码。**

应用使用 Podman + Quadlet，监听发布到宿主回环的 3210（WebUI/API）和 3211（MCP）。源代码在 `/opt/exomem/source`，数据在 `/var/lib/exomem`，运行配置在 `/etc/exomem`。MicroOS 宿主不需要安装 Node.js 或 Git，固定的构建镜像同时提供 Git。

首次部署：使用 `Containerfile` 中固定的 Node 镜像运行 Git，将此仓库 clone 到 `/opt/exomem/source`；随后运行已提交的 `deploy/update.sh`。后续运行同一脚本，它会先检查工作树、`git pull --ff-only`，构建带 Git SHA 的镜像，备份并更新服务。每个 SHA 的镜像保留，可重新打 `current` 标签并重启回滚。数据库架构更改时需配合备份恢复；不要让旧程序打开较新 schema。

WebUI **没有登录系统**。生产域名应先配置 Cloudflare Access，再通过现有 cloudflared 转发到 `http://127.0.0.1:3210`。管理 API 与 WebUI 一并受 Access 保护。MCP 3211 不通过此域名发布。

`deploy/exomem-tunnel.service` 是独立的 OpenAI Secure MCP Tunnel 服务模板。使用官方 `tunnel-client`，运行凭据放 `/etc/exomem/tunnel.env`（0600），不要提交到 Git：

```text
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=...
```

实际安装时以该版本的 `tunnel-client help quickstart` / `doctor` 核对 CLI。控制面显式经 mihomo 的 `http://127.0.0.1:17890` 出站；本地 MCP 直连。服务的出站 IP 限制只允许回环，防止代理失效后直接出网。凭据必须关联目标 Platform organization 和 ChatGPT workspace。

官方文档：[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。完成配置后，必须从 ChatGPT 做一次真实工具调用才算完成端到端接入。

## 备份和数据迁移

每日 systemd timer 通过 SQLite backup API 创建一致性快照，保存在 `/var/lib/exomem/backups`；每次应用更新前也备份。快照包含历史、token 摘要和幂等记录。当前不自动清理快照，需根据容量安排保留策略。应另行将备份加密复制到另一台设备；本机备份不覆盖整机故障。

JSON 导出用于迁移当前有效记忆，不包含回收站、历史或凭据。导入会生成本地记录 ID，并以来源 ID + 内容摘要记录导入批次条目；完全相同的重复导入跳过。导回原空间遇到同 ID 不同内容时整批回滚，避免静默覆盖；导入不是自动双向同步。

## 验证范围

测试仅覆盖较复杂的 Unicode/索引/分页、幂等与多连接版本冲突、日期边界、导入事务。普通 CRUD 使用功能检查，不建仪式化测试矩阵。不通过攻击或探测服务器验证安全性。
