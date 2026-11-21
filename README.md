# Prompt Vault · 本地提示词收藏夹

WorkBuddy 的提示词收藏工具。新建、编辑、删除、打标签、按标签筛选、全文搜索，
存好之后在对话里说「用我的 XX 提示词」即可直接调用执行。

**所有数据只存在本机**，路径固定为 `~/.workbuddy/prompt-vault/data/prompts.json`，
不联网、不上云、无遥测。

## 1、为什么不是侧边栏单独菜单

WorkBuddy 个人版的左侧导航栏不支持第三方新增顶级菜单——官方「自定义菜单栏」只允许
调整已有入口的顺序与归入「更多」，这一扩展点不存在。因此本工具由两部分组成：

| 部分 | 入口位置 | 作用 |
|---|---|---|
| 技能 + MCP | 左侧边栏「专家 · 技能 · 连接器」→ 技能 | 对话里直接调用提示词并执行 |
| 本地 Web 页 | 浏览器 `http://127.0.0.1:7788` | 图形化管理：增删改、标签、搜索、复制 |

## 2、技术栈

| 项 | 版本 / 说明 |
|---|---|
| Node.js | v22.22.2（需 ≥ 18，用到内置 `fetch`） |
| @modelcontextprotocol/sdk | 1.32.2（与本机 mysql-mcp 对齐） |
| zod | ^3.25.76 |
| HTTP 服务 | `node:http`，零框架零依赖 |
| 存储 | 单 JSON 文件 + 原子写 + 跨进程锁 |

## 3、快速开始

### 3.1 启动 Web 管理页

```bash
node ~/.workbuddy/prompt-vault/web/serve.mjs --open
```

`--open` 表示服务就绪后自动打开浏览器；不加则只打印地址。Windows 下直接双击项目根目录的
`start-web.bat` 即可，它等价于上面这条命令。

服务只监听 `127.0.0.1`，7788 被占用时自动尝试 +1（最多 12 次）。
**重复启动不会产生第二个实例**：`serve.mjs` 会先判断该端口上是否已有自己的实例，
是则只打开浏览器并退出，不再监听。

### 3.2 首次导入示例提示词（可选）

```bash
node ~/.workbuddy/prompt-vault/scripts/seed-examples.mjs 7788
```

已存在的同标题同正文条目会被跳过，重复执行不会产生副本。

### 3.3 在对话中使用

前提：`~/.workbuddy/mcp.json` 已注册 `prompt-vault`（本项目已写入）。
实测本机 WorkBuddy 会在运行中自动加载新注册的 MCP Server，**无需重启**；
若对话里调不到 `prompt_vault_*` 工具，再重启客户端兜底。

重启后在对话里直接说：

- 「用我的周报提示词，这周做了 A、B、C」→ 自动取正文并按它执行
- 「我有哪几个提示词」/「看看写作类的」
- 「把这段存成提示词，标题叫 XX，标签写作」

## 4、工程结构

```
prompt-vault/
├── package.json
├── server.mjs              # MCP Server（stdio）
├── lib/store.mjs           # 存储层：CRUD、搜索、标签、原子写、跨进程锁
├── web/
│   ├── serve.mjs           # 本地 HTTP + REST API
│   └── index.html          # 单页管理界面
├── scripts/seed-examples.mjs
├── data/prompts.json       # 数据（首次写入时自动生成）
├── test.mjs                # 存储层测试 35 项
├── test-mcp.mjs            # MCP 协议级测试 28 项
├── test-web.mjs            # Web 端到端测试 28 项
└── start-web.bat
```

## 5、关键配置

### 5.1 MCP 注册（`~/.workbuddy/mcp.json`）

```json
"prompt-vault": {
  "command": "node",
  "args": ["C:/Users/<你的用户名>/.workbuddy/prompt-vault/server.mjs"]
}
```

### 5.2 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `PROMPT_VAULT_DIR` | 覆盖数据目录（测试用） | `~/.workbuddy/prompt-vault/data` |
| `PORT` | Web 服务端口 | `7788` |

### 5.3 数据格式

```json
{
  "version": 1,
  "updatedAt": "2026-11-21T05:26:24.016Z",
  "prompts": [
    {
      "id": "uuid",
      "title": "周报生成",
      "content": "……",
      "tags": ["汇报", "周报"],
      "description": "每周五用",
      "usageCount": 0,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

## 6、功能清单

### 6.1 MCP 工具（7 个）

| 工具 | 说明 |
|---|---|
| `prompt_list` | 列表 / 标签筛选 / 关键词搜索（多词 AND，覆盖标题正文说明标签） |
| `prompt_get` | 按 id 或标题取完整正文，支持模糊匹配，累计使用次数 |
| `prompt_create` | 新建，同标题同正文会拒绝重复 |
| `prompt_update` | 局部更新，`tags` 整体替换，传 `[]` 清空 |
| `prompt_delete` | 删除，不可恢复 |
| `prompt_tags` | 所有标签及条目数 |
| `prompt_stats` | 条目数、标签数、数据文件路径 |

### 6.2 Web 管理页

新建 / 编辑 / 删除、多标签、按标签筛选、关键词搜索（防抖 180ms）、
点击卡片复制正文、键盘快捷键（`Ctrl/Cmd+N` 新建、`Esc` 关闭、`Ctrl/Cmd+Enter` 保存）。

### 6.3 REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/prompts?tag=&q=&limit=` | 列表 |
| GET | `/api/prompts/:id` | 单条完整内容 |
| POST | `/api/prompts` | 新建 |
| PUT | `/api/prompts/:id` | 更新 |
| DELETE | `/api/prompts/:id` | 删除 |
| GET | `/api/tags` | 标签统计 |
| GET | `/api/stats` | 汇总信息 |

## 7、验证情况

三套自动化测试，共 91 项断言全部通过：

```bash
node test.mjs       # 35 项：CRUD、搜索、标签、校验、10 并发写、文件完整性
node test-mcp.mjs   # 28 项：真实 stdio 子进程跑 initialize/tools-list/tools-call、错误路径、stdout 纯净
node test-web.mjs   # 28 项：REST 全端点、404/400/415/403、跨站写入拦截
```

浏览器实测（WorkBuddy 内置浏览器）：页面可打开、3 条数据正确渲染、
标签筛选生效、关键词搜索生效、点击卡片复制并提示「已复制」、新建表单可弹出并自动聚焦。

## 8、踩坑备忘

1. **MCP 的 stdout 只能是 JSON-RPC**。任何 `console.log` 都会破坏协议帧，诊断信息必须走 `console.error`。
2. **MCP 和 Web 是两个进程，会同时写同一个文件**。进程内互斥锁不够，必须用锁文件；写入前在锁内重新读盘，否则并发写丢数据。
3. **网页无法写入宿主应用的输入框**。浏览器安全模型不允许，`navigator.clipboard` 只能写剪贴板。要免粘贴必须走 MCP 的「调用即执行」路径。
4. **`navigator.clipboard` 需要安全上下文**，`127.0.0.1` 与 `localhost` 算安全上下文，用 `file://` 直接打开页面则不行——必须通过 HTTP 服务访问。
5. **Windows 端口占用**：`serve.mjs` 会依次尝试 +1，最多 12 次。
6. **MCP 配置改动的加载时机**：实测新增 Server 会自动加载、无需重启；但若改了已有 Server 的
   `command`/`args`，老进程可能仍在跑，此时重启客户端最稳妥。
7. **批处理必须 CRLF 换行**：用 LF 写的 `.bat`，cmd.exe 会解析失败并静默退出，表现就是
   "双击后窗口一闪而过"。`start-web.bat` 必须保持 CRLF；同时避免 `if (...)` 括号块，
   用 `if errorlevel 1 goto label` 更稳。
8. **不要用 curl 探测本地端口来判断服务是否启动**：cmd 子进程带有 `HTTP_PROXY`，
   curl 会走代理，连 `127.0.0.1` 直接返回 7（连接失败），从而误判"服务没起"。
   这个代理值**不是用户自己的代理端口**——WorkBuddy 会读取系统代理
   （`WORKBUDDY_PROXY_SOURCE=system`）后为子进程注入一个本地转发端口，
   该端口每次会话可能变化，所以写死端口或依赖 `NO_PROXY` 都不可靠。
   端口与实例探测统一放在 Node 里，用 `net` 试监听、用 `fetch` 识别自身实例。
9. **`timeout.exe` 在 stdin 被重定向时会拒绝运行**（报"不支持输入重定向"）。
   需要延时就改用 `ping -n 3 127.0.0.1 >nul`，或把延时逻辑移进 Node。

## 9、安全边界

- 服务只绑定 `127.0.0.1`，局域网与公网不可达。
- 写请求要求 `content-type: application/json`，且携带的 `Origin` 必须是同源，否则 403、415。
- 无多用户、无鉴权设计——它是单机个人工具，不要改为监听 `0.0.0.0`。

## 10、生产化建议

- **开机自启**：把 `start-web.bat` 的快捷方式放进 `shell:startup`，或改用 Windows 计划任务。
- **备份**：定期复制 `data/prompts.json`；写入是原子替换，中途断电不会产生半截文件。
- **迁移**：把整个 `prompt-vault` 目录复制到新机器，再重新在 `mcp.json` 注册即可。
