# Nacos MCP Server

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

MCP Server for [Nacos](https://nacos.io/) Config Center, allowing AI assistants (like Claude Code) to read and write Nacos configurations directly.

It defaults to the Nacos 1.x compatible Open API and supports Nacos 3 console APIs when explicitly configured. Authentication uses a cached `accessToken`; login failures do not downgrade to anonymous access.

### Features

- **Read configs** - Get single or all configurations from Nacos
- **List configs** - List all config dataIds in a namespace/group, including every result page
- **Publish configs** - Update configs with auto format detection (yaml/properties/json/text)
- **Auth support** - Required login by default, token refresh, and explicit no-auth mode only
- **Nacos versions** - Nacos v1/v2 compatible APIs by default and Nacos 3 console APIs with `NACOS_API_VERSION=v3`
- **Languages** - MCP text in `zh-CN` (default) or `en-US`

### Installation

Clone the maintained fork:

```bash
git clone https://github.com/mutallipp/nacos-mcp-server.git
cd nacos-mcp-server
npm install
```

For one-off package execution, pin a verified commit SHA before use; replace `<verified-commit-sha>` with the commit you reviewed and tested:

```bash
npx -y --package=github:mutallipp/nacos-mcp-server#<verified-commit-sha> nacos-mcp-server
```

### Configuration

#### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NACOS_SERVER_ADDR` | `127.0.0.1:8848` | Bare Nacos host:port or complete HTTP(S) URL |
| `NACOS_CONTEXT_PATH` | `/nacos` | Nacos context path; set to an empty string for the root context |
| `NACOS_NAMESPACE` | `` | Default namespace ID |
| `NACOS_GROUP` | `DEFAULT_GROUP` | Default config group |
| `NACOS_USERNAME` | `nacos` | Login username |
| `NACOS_PASSWORD` | `nacos` | Login password; never emitted in diagnostics |
| `NACOS_API_VERSION` | `v1` | `v1` (default) or `v3` |
| `NACOS_AUTH_MODE` | `login` | `login`/`required` (same required-login behavior), or `disabled`; legacy `none` remains supported |
| `NACOS_TIMEOUT_MS` | `10000` | Per-request timeout in milliseconds, including response-body consumption |
| `NACOS_LANGUAGE` | `zh-CN` | MCP text language: `zh-CN` or `en-US` |

Address and context rules:

- A bare address such as `nacos.example:8848` uses HTTP and the configured context path.
- A root URL such as `https://nacos.example` uses the configured context path.
- A URL path such as `https://nacos.example/nacos` is used as the context only when `contextPath`/`NACOS_CONTEXT_PATH` was not explicitly set.
- An explicitly configured context path has priority over a URL path. For example, `https://nacos.example/from-url` plus `NACOS_CONTEXT_PATH=/configured` uses `/configured`; `NACOS_CONTEXT_PATH=` uses the root context.
- Only HTTP and HTTPS are accepted. Server addresses containing credentials, query strings, or fragments are rejected.

Nacos v1/v2 compatibility uses `/v1/auth/login` and `/v1/cs/configs`. Nacos 3 uses `/v3/auth/user/login`, `/v3/console/cs/config`, and `/v3/console/cs/config/list`.

#### Claude Code Configuration

Add the local `index.js` path to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "nacos": {
      "command": "node",
      "args": ["/path/to/nacos-mcp-server/src/index.js"]
    }
  }
}
```

> **Windows users**: Use `cmd` as command:
> ```json
> {
>   "command": "cmd",
>   "args": ["/c", "node", "D:/path/to/nacos-mcp-server/src/index.js"]
> }
> ```

Nacos connection parameters support two configuration methods:

**Method 1: Environment Variables (via env in mcpServers)**

```json
{
  "mcpServers": {
    "nacos": {
      "command": "node",
      "args": ["/path/to/nacos-mcp-server/src/index.js"],
      "env": {
        "NACOS_SERVER_ADDR": "https://nacos.example/nacos",
        "NACOS_NAMESPACE": "example-namespace",
        "NACOS_GROUP": "DEFAULT_GROUP",
        "NACOS_USERNAME": "example-user",
        "NACOS_PASSWORD": "set-through-your-secret-manager",
        "NACOS_CONTEXT_PATH": "/nacos",
        "NACOS_API_VERSION": "v3",
        "NACOS_AUTH_MODE": "login",
        "NACOS_TIMEOUT_MS": "10000",
        "NACOS_LANGUAGE": "en-US"
      }
    }
  }
}
```

**Method 2: Config File (Recommended)**

Create `.nacos-mcp.json` in the project directory or `~/.nacos-mcp.json` in the user home directory:

```json
{
  "serverAddr": "https://nacos.example/nacos",
  "contextPath": "/nacos",
  "namespace": "example-namespace",
  "group": "DEFAULT_GROUP",
  "username": "example-user",
  "password": "set-through-your-secret-manager",
  "apiVersion": "v3",
  "authMode": "login",
  "timeoutMs": 10000
}
```

Config priority: Project `.nacos-mcp.json` > User home `~/.nacos-mcp.json` > Environment variables > Defaults. A configuration file must be a JSON object; malformed files fail explicitly. Use a secret manager or environment injection for real credentials and do not commit credentials.

### MCP Tools

#### `nacos_get_config`

Get a single config by dataId.

**Parameters:**
- `dataId` (required) - Config dataId, e.g. `re-gateway.yaml`
- `namespace` (optional) - Namespace ID, defaults to configured `NACOS_NAMESPACE`
- `group` (optional) - Config group, defaults to configured `NACOS_GROUP`

#### `nacos_list_configs`

List all configs in a namespace/group.

**Parameters:**
- `namespace` (optional) - Namespace ID
- `group` (optional) - Config group

All pages are collected. Invalid, incomplete, or inconsistent pagination is reported as an error rather than returned as a partial success.

#### `nacos_get_all_configs`

Get full content of all configs in a namespace/group. Each listed item is fetched using its own returned namespace and group; individual read errors are shown next to that item.

**Parameters:**
- `namespace` (optional) - Namespace ID
- `group` (optional) - Config group

#### `nacos_publish_config`

Publish (update) a config. Content is saved as-is, preserving original format (indentation, comments, blank lines).

**Parameters:**
- `dataId` (required) - Config dataId
- `content` (required) - Full config content (must preserve original format)
- `namespace` (optional) - Namespace ID
- `group` (optional) - Config group

**Important:** Always `nacos_get_config` first, modify the original content, then publish. Format type is auto-detected from the dataId extension: `.yaml`/`.yml` → `yaml`, `.properties` → `properties`, `.json` → `json`, otherwise `text`. A publish is successful only when Nacos returns v1 `true` or v3 `{ "code": 0, "data": true }`.

### Production safety

Production acceptance is **read-only**: only use `nacos_list_configs`, `nacos_get_config`, or `nacos_get_all_configs`. Production publishing is not verified and must not be used for acceptance. Validate publishing with a mock or non-production Nacos instance, and always get the existing config before any intended publish.

### Requirements

- Node.js >= 18.0.0 (built-in `fetch`)
- Nacos 1.x or 2.x through the v1-compatible API, or Nacos 3.x with `NACOS_API_VERSION=v3`

### License

MIT

---

<a id="中文"></a>

## 中文

[Nacos](https://nacos.io/) 配置中心的 MCP Server，让 AI 助手（如 Claude Code）可以直接读写 Nacos 配置。

默认使用 Nacos 1.x 兼容 Open API；显式配置后支持 Nacos 3 控制台 API。认证使用缓存的 `accessToken`，登录失败不会降级为匿名访问。

### 功能特性

- **读取配置** - 获取单个或全部 Nacos 配置
- **列出配置** - 列出指定命名空间/分组下的所有配置 dataId，并获取所有结果页
- **发布配置** - 更新配置，自动识别格式（yaml/properties/json/text）
- **认证支持** - 默认必须登录并自动刷新 Token；仅显式配置时才关闭认证
- **Nacos 版本** - 默认支持 Nacos v1/v2 兼容 API；设置 `NACOS_API_VERSION=v3` 支持 Nacos 3
- **语言** - MCP 文案支持中文（默认 `zh-CN`）和英文（`en-US`）

### 安装

使用维护中的 fork：

```bash
git clone https://github.com/mutallipp/nacos-mcp-server.git
cd nacos-mcp-server
npm install
```

一次性运行包时必须固定到已验证的 commit SHA；请将 `<verified-commit-sha>` 替换为已评审和测试的提交：

```bash
npx -y --package=github:mutallipp/nacos-mcp-server#<verified-commit-sha> nacos-mcp-server
```

### 配置

#### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NACOS_SERVER_ADDR` | `127.0.0.1:8848` | 裸 Nacos host:port 或完整 HTTP(S) URL |
| `NACOS_CONTEXT_PATH` | `/nacos` | Nacos context path；设为空字符串时使用根 context |
| `NACOS_NAMESPACE` | `` | 默认命名空间 ID |
| `NACOS_GROUP` | `DEFAULT_GROUP` | 默认配置分组 |
| `NACOS_USERNAME` | `nacos` | 登录用户名 |
| `NACOS_PASSWORD` | `nacos` | 登录密码；诊断信息不会输出该值 |
| `NACOS_API_VERSION` | `v1` | `v1`（默认）或 `v3` |
| `NACOS_AUTH_MODE` | `login` | `login`/`required`（等价，均要求认证），或 `disabled`；兼容旧值 `none` |
| `NACOS_TIMEOUT_MS` | `10000` | 单请求超时毫秒数，包含响应 body 消费 |
| `NACOS_LANGUAGE` | `zh-CN` | MCP 文案语言：`zh-CN` 或 `en-US` |

地址与 context 规则：

- 裸地址，例如 `nacos.example:8848`，使用 HTTP 和已配置的 context path。
- 根 URL，例如 `https://nacos.example`，使用已配置的 context path。
- URL 自带路径，例如 `https://nacos.example/nacos`，仅在未显式设置 `contextPath`/`NACOS_CONTEXT_PATH` 时作为 context。
- 显式 context path 的优先级高于 URL 路径。例如 `https://nacos.example/from-url` 加 `NACOS_CONTEXT_PATH=/configured` 使用 `/configured`；`NACOS_CONTEXT_PATH=` 使用根 context。
- 仅接受 HTTP/HTTPS；服务器地址中包含凭据、query string 或 fragment 会被拒绝。

Nacos v1/v2 兼容模式使用 `/v1/auth/login` 和 `/v1/cs/configs`。Nacos 3 使用 `/v3/auth/user/login`、`/v3/console/cs/config` 和 `/v3/console/cs/config/list`。

#### Claude Code 配置

将本地 `index.js` 路径配置到 `~/.claude.json` 的 `mcpServers` 下：

```json
{
  "mcpServers": {
    "nacos": {
      "command": "node",
      "args": ["/path/to/nacos-mcp-server/src/index.js"]
    }
  }
}
```

> **Windows 用户**：使用 `cmd` 作为 command：
> ```json
> {
>   "command": "cmd",
>   "args": ["/c", "node", "D:/path/to/nacos-mcp-server/src/index.js"]
> }
> ```

Nacos 连接参数支持两种配置方式：

**方式一：环境变量（在 mcpServers 中配置 env）**

```json
{
  "mcpServers": {
    "nacos": {
      "command": "node",
      "args": ["/path/to/nacos-mcp-server/src/index.js"],
      "env": {
        "NACOS_SERVER_ADDR": "https://nacos.example/nacos",
        "NACOS_NAMESPACE": "example-namespace",
        "NACOS_GROUP": "DEFAULT_GROUP",
        "NACOS_USERNAME": "example-user",
        "NACOS_PASSWORD": "set-through-your-secret-manager",
        "NACOS_CONTEXT_PATH": "/nacos",
        "NACOS_API_VERSION": "v3",
        "NACOS_AUTH_MODE": "login",
        "NACOS_TIMEOUT_MS": "10000",
        "NACOS_LANGUAGE": "zh-CN"
      }
    }
  }
}
```

**方式二：配置文件（推荐）**

在项目目录创建 `.nacos-mcp.json`，或在用户目录创建 `~/.nacos-mcp.json`：

```json
{
  "serverAddr": "https://nacos.example/nacos",
  "contextPath": "/nacos",
  "namespace": "example-namespace",
  "group": "DEFAULT_GROUP",
  "username": "example-user",
  "password": "set-through-your-secret-manager",
  "apiVersion": "v3",
  "authMode": "login",
  "timeoutMs": 10000
}
```

配置优先级：项目 `.nacos-mcp.json` > 用户目录 `~/.nacos-mcp.json` > 环境变量 > 默认值。配置文件必须是 JSON 对象；格式错误会明确失败，不会被静默忽略。真实凭据应通过密钥管理或环境变量注入，禁止提交凭据。

### MCP 工具

#### `nacos_get_config`

获取单个配置的内容。

**参数：**
- `dataId`（必填）- 配置的 dataId，如 `re-gateway.yaml`
- `namespace`（可选）- 命名空间 ID，默认使用配置的 `NACOS_NAMESPACE`
- `group`（可选）- 配置分组，默认使用配置的 `NACOS_GROUP`

#### `nacos_list_configs`

列出指定命名空间/分组下的所有配置项。

**参数：**
- `namespace`（可选）- 命名空间 ID
- `group`（可选）- 配置分组

会读取所有分页。分页无效、不完整或 totalCount 不一致时明确报错，不会返回部分成功结果。

#### `nacos_get_all_configs`

获取指定命名空间/分组下的全部配置内容。每个条目会按其返回的命名空间和分组读取；单项读取错误会显示在该条目旁。

**参数：**
- `namespace`（可选）- 命名空间 ID
- `group`（可选）- 配置分组

#### `nacos_publish_config`

发布（更新）配置。原样保存配置内容，不修改任何格式（缩进、注释、空行等）。

**参数：**
- `dataId`（必填）- 配置的 dataId
- `content`（必填）- 完整的配置内容，必须保持原始格式
- `namespace`（可选）- 命名空间 ID
- `group`（可选）- 配置分组

**重要：** 必须先通过 `nacos_get_config` 获取当前内容，在原始内容基础上修改后再发布。格式按 dataId 扩展名自动识别：`.yaml`/`.yml` → `yaml`，`.properties` → `properties`，`.json` → `json`，其余为 `text`。只有 Nacos 返回 v1 `true` 或 v3 `{ "code": 0, "data": true }` 才视为发布成功。

### 生产安全限制

生产验收仅限**只读**：只能使用 `nacos_list_configs`、`nacos_get_config` 或 `nacos_get_all_configs`。生产发布尚未验证，禁止将其作为验收手段。请在 mock 或非生产 Nacos 中验证发布，并且任何计划发布前都必须先调用 `nacos_get_config`。

### 环境要求

- Node.js >= 18.0.0（内置 `fetch`）
- Nacos 1.x 或 2.x（使用 v1 兼容 API），或设置 `NACOS_API_VERSION=v3` 的 Nacos 3.x

### 许可证

MIT
