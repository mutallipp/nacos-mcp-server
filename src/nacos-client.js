import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getMessages, message } from "./i18n.js";

const DEFAULTS = Object.freeze({
  serverAddr: "127.0.0.1:8848",
  contextPath: "/nacos",
  namespace: "",
  group: "DEFAULT_GROUP",
  username: "nacos",
  password: "nacos",
  apiVersion: "v1",
  authMode: "login",
  timeoutMs: 10_000,
});

const MAX_LIST_PAGES = 10_000;

const ENVIRONMENT_FIELDS = Object.freeze({
  serverAddr: "NACOS_SERVER_ADDR",
  contextPath: "NACOS_CONTEXT_PATH",
  namespace: "NACOS_NAMESPACE",
  group: "NACOS_GROUP",
  username: "NACOS_USERNAME",
  password: "NACOS_PASSWORD",
  apiVersion: "NACOS_API_VERSION",
  authMode: "NACOS_AUTH_MODE",
  timeoutMs: "NACOS_TIMEOUT_MS",
});

export class NacosError extends Error {}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function configFromEnvironment(env) {
  return Object.fromEntries(
    Object.entries(ENVIRONMENT_FIELDS)
      .filter(([field, environmentName]) => env[environmentName] !== undefined && (field === "contextPath" || env[environmentName] !== ""))
      .map(([field, environmentName]) => [field, env[environmentName]])
  );
}

function readConfigFile(configPath, exists, readFile, messages) {
  if (!exists(configPath)) return {};
  try {
    const parsed = JSON.parse(readFile(configPath, "utf8"));
    if (!isRecord(parsed)) throw new NacosError(message(messages, "configFileInvalid"));
    return parsed;
  } catch {
    throw new NacosError(message(messages, "configFileInvalid"));
  }
}

function hasOwnContext(config) {
  return Object.hasOwn(config, "contextPath");
}

/** 按项目文件、用户文件、环境变量、默认值的顺序加载配置。 */
export function loadConfig({
  cwd = process.cwd(),
  homeDir = homedir(),
  env = process.env,
  exists = existsSync,
  readFile = readFileSync,
  messages = getMessages(),
} = {}) {
  const globalConfig = readConfigFile(join(homeDir, ".nacos-mcp.json"), exists, readFile, messages);
  const projectConfig = readConfigFile(join(cwd, ".nacos-mcp.json"), exists, readFile, messages);
  const environmentConfig = configFromEnvironment(env);
  return {
    ...DEFAULTS,
    ...environmentConfig,
    ...globalConfig,
    ...projectConfig,
    contextPathExplicit: hasOwnContext(environmentConfig) || hasOwnContext(globalConfig) || hasOwnContext(projectConfig),
  };
}

function hasScheme(value) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function normalizeContextPath(value, messages) {
  const contextPath = String(value ?? "").trim();
  if (!contextPath || contextPath === "/") return "";
  if (contextPath.includes("?") || contextPath.includes("#")) {
    throw new NacosError(message(messages, "contextPathInvalid"));
  }
  return `/${contextPath.replace(/^\/+|\/+$/g, "")}`;
}

/** 将裸 host:port 或标准 HTTP(S) 地址规范为 API 根地址。 */
export function normalizeBaseUrl(serverAddr, contextPath, contextPathExplicit, messages = getMessages()) {
  const source = String(serverAddr ?? "").trim();
  const resolvedContextPath = contextPath ?? "/nacos";
  const explicitContext = contextPathExplicit ?? contextPath !== undefined;
  if (!source) throw new NacosError(message(messages, "serverAddressRequired"));
  if (hasScheme(source) && !/^https?:\/\//i.test(source)) {
    throw new NacosError(message(messages, "serverAddressScheme"));
  }
  if (!hasScheme(source) && /[/?#]/.test(source)) {
    throw new NacosError(message(messages, "bareAddressInvalid"));
  }

  let url;
  try {
    url = new URL(hasScheme(source) ? source : `http://${source}`);
  } catch {
    throw new NacosError(message(messages, "serverAddressInvalid"));
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new NacosError(message(messages, "serverAddressUnsafe"));
  }

  const urlContext = url.pathname.replace(/\/+$/, "");
  const configuredContext = normalizeContextPath(resolvedContextPath, messages);
  const resolvedContext = explicitContext || !urlContext || urlContext === "/"
    ? configuredContext
    : normalizeContextPath(urlContext, messages);
  return `${url.protocol}//${url.host}${resolvedContext}`;
}

function normalizeApiVersion(value, messages) {
  const apiVersion = String(value ?? "v1").toLowerCase();
  if (apiVersion === "v1" || apiVersion === "v3") return apiVersion;
  throw new NacosError(message(messages, "apiVersionInvalid"));
}

function normalizeAuthMode(value, messages) {
  const authMode = String(value ?? "login").toLowerCase();
  if (authMode === "login" || authMode === "required") return "login";
  if (authMode === "disabled" || authMode === "none") return "disabled";
  throw new NacosError(message(messages, "authModeInvalid"));
}

function normalizeTimeout(value, messages) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new NacosError(message(messages, "timeoutInvalid"));
  }
  return timeoutMs;
}

function configType(dataId) {
  const lowerDataId = dataId.toLowerCase();
  if (lowerDataId.endsWith(".yaml") || lowerDataId.endsWith(".yml")) return "yaml";
  if (lowerDataId.endsWith(".properties")) return "properties";
  if (lowerDataId.endsWith(".json")) return "json";
  return "text";
}

function parseTotalCount(value, fail) {
  const isNumber = typeof value === "number";
  const isDecimalString = typeof value === "string" && /^\d+$/.test(value);
  if (!isNumber && !isDecimalString) throw fail("listTotalInvalid");
  const totalCount = Number(value);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw fail("listTotalInvalid");
  return totalCount;
}

function safeCode(value) {
  return Number.isSafeInteger(value) ? value : "unknown";
}

export class NacosClient {
  constructor({ config, fetchImpl = globalThis.fetch, logger = () => {}, messages = getMessages() } = {}) {
    if (typeof fetchImpl !== "function") throw new NacosError(message(messages, "fetchRequired"));
    this.messages = messages;
    this.config = config ?? loadConfig({ messages });
    const contextPathExplicit = this.config.contextPathExplicit ?? hasOwnContext(this.config);
    this.baseUrl = normalizeBaseUrl(this.config.serverAddr, this.config.contextPath, contextPathExplicit, messages);
    this.apiVersion = normalizeApiVersion(this.config.apiVersion, messages);
    this.authMode = normalizeAuthMode(this.config.authMode, messages);
    this.timeoutMs = normalizeTimeout(this.config.timeoutMs, messages);
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.defaultNamespace = this.config.namespace ?? "";
    this.defaultGroup = this.config.group || "DEFAULT_GROUP";
    this.username = this.config.username;
    this.password = this.config.password;
    this.accessToken = null;
    this.tokenExpireTime = 0;
  }

  fail(key, values) {
    return new NacosError(message(this.messages, key, values));
  }

  async request(url, options, operation, consume) {
    const controller = new AbortController();
    let timeout;
    const request = Promise.resolve()
      .then(() => this.fetchImpl(url, { ...options, signal: controller.signal }))
      .then((response) => consume(response));
    const timeoutResult = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(this.fail("requestTimeout", { operation, timeoutMs: this.timeoutMs }));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([request, timeoutResult]);
    } catch (error) {
      if (error instanceof NacosError) throw error;
      if (controller.signal.aborted) throw this.fail("requestTimeout", { operation, timeoutMs: this.timeoutMs });
      throw this.fail("requestFailed", { operation });
    } finally {
      clearTimeout(timeout);
    }
  }

  async login() {
    if (this.authMode === "disabled") return null;
    if (this.accessToken && Date.now() < this.tokenExpireTime) return this.accessToken;

    const body = new URLSearchParams({ username: String(this.username ?? ""), password: String(this.password ?? "") });
    const loginPath = this.apiVersion === "v3" ? "/v3/auth/user/login" : "/v1/auth/login";
    return this.request(`${this.baseUrl}${loginPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, this.messages.login, async (response) => {
      if (!response.ok) {
        await response.text();
        throw this.fail("requestHttpFailed", { operation: this.messages.login, status: response.status });
      }
      const payload = await this.readJson(response, this.messages.login);
      if (typeof payload?.accessToken !== "string" || !payload.accessToken) throw this.fail("accessTokenMissing");
      const tokenTtl = Number(payload.tokenTtl ?? 18_000);
      const usableTtl = Number.isFinite(tokenTtl) && tokenTtl > 30 ? tokenTtl - 30 : 1;
      this.accessToken = payload.accessToken;
      this.tokenExpireTime = Date.now() + usableTtl * 1_000;
      this.logger(this.messages.authSucceeded);
      return this.accessToken;
    });
  }

  async authenticatedParams(params) {
    const result = new URLSearchParams(params);
    const token = await this.login();
    if (token) result.set("accessToken", token);
    return result;
  }

  resolveScope(namespace, group) {
    return { namespace: namespace ?? this.defaultNamespace, group: group ?? this.defaultGroup };
  }

  configPath() {
    return this.apiVersion === "v3" ? "/v3/console/cs/config" : "/v1/cs/configs";
  }

  listPath() {
    return this.apiVersion === "v3" ? "/v3/console/cs/config/list" : "/v1/cs/configs";
  }

  scopedParams({ dataId, namespace, group, pageNo, pageSize } = {}) {
    const params = this.apiVersion === "v3" ? { namespaceId: namespace, groupName: group } : { tenant: namespace, group };
    if (dataId !== undefined) params.dataId = dataId;
    if (pageNo !== undefined) params.pageNo = String(pageNo);
    if (pageSize !== undefined) params.pageSize = String(pageSize);
    return params;
  }

  async getConfig(dataId, namespace, group) {
    const scope = this.resolveScope(namespace, group);
    const params = await this.authenticatedParams(this.scopedParams({ dataId, ...scope }));
    return this.request(`${this.baseUrl}${this.configPath()}?${params.toString()}`, {}, this.messages.getConfig, async (response) => {
      if (!response.ok) {
        await response.text();
        throw this.fail("requestHttpFailed", { operation: this.messages.getConfig, status: response.status });
      }
      if (this.apiVersion === "v1") return response.text();
      const payload = await this.readJson(response, this.messages.getConfig);
      const data = this.unwrapV3(payload, this.messages.getConfig);
      if (typeof data.content !== "string") throw this.fail("contentMissing");
      return data.content;
    });
  }

  async listConfigs(namespace, group) {
    const scope = this.resolveScope(namespace, group);
    const items = [];
    let pageNo = 1;
    let expectedTotal;
    do {
      if (pageNo > MAX_LIST_PAGES) throw this.fail("listPageLimit");
      const page = await this.listConfigPage(scope, pageNo, 200);
      if (expectedTotal === undefined) expectedTotal = page.totalCount;
      if (expectedTotal !== page.totalCount) throw this.fail("listTotalChanged");
      if (items.length + page.pageItems.length > expectedTotal) throw this.fail("listResponseInvalid");
      items.push(...page.pageItems);
      if (items.length === expectedTotal) return { totalCount: expectedTotal, pageItems: items };
      if (page.pageItems.length === 0) throw this.fail("listPageIncomplete");
      pageNo += 1;
    } while (true);
  }

  async listConfigPage(scope, pageNo, pageSize) {
    const baseParams = this.scopedParams({ ...scope, pageNo, pageSize });
    baseParams.search = "accurate";
    baseParams.dataId = "";
    const params = await this.authenticatedParams(baseParams);
    return this.request(`${this.baseUrl}${this.listPath()}?${params.toString()}`, {}, this.messages.listConfigs, async (response) => {
      if (!response.ok) {
        await response.text();
        throw this.fail("requestHttpFailed", { operation: this.messages.listConfigs, status: response.status });
      }
      const payload = await this.readJson(response, this.messages.listConfigs);
      const result = this.apiVersion === "v3" ? this.unwrapV3(payload, this.messages.listConfigs) : payload;
      return this.parseListPage(result);
    });
  }

  parseListPage(result) {
    if (!isRecord(result) || !Object.hasOwn(result, "totalCount") || !Object.hasOwn(result, "pageItems") || !Array.isArray(result.pageItems)) {
      throw this.fail("listResponseInvalid");
    }
    const pageItems = result.pageItems;
    if (pageItems.some((item) => !isRecord(item) || typeof item.dataId !== "string" || !item.dataId)) {
      throw this.fail("listItemInvalid");
    }
    return { totalCount: parseTotalCount(result.totalCount, (key) => this.fail(key)), pageItems };
  }

  async publishConfig(dataId, content, namespace, group) {
    const scope = this.resolveScope(namespace, group);
    const params = await this.authenticatedParams({
      ...this.scopedParams({ dataId, ...scope }),
      content,
      type: configType(dataId),
    });
    return this.request(`${this.baseUrl}${this.configPath()}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }, this.messages.publishConfig, async (response) => {
      const responseBody = await response.text();
      if (!response.ok) throw this.fail("requestHttpFailed", { operation: this.messages.publishConfig, status: response.status });
      return this.readPublishResult(responseBody);
    });
  }

  readPublishResult(responseBody) {
    if (this.apiVersion === "v1") {
      if (responseBody.trim() !== "true") throw this.fail("publishRejected");
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      throw this.fail("invalidJson", { operation: this.messages.publishConfig });
    }
    this.unwrapV3(payload, this.messages.publishConfig);
    if (payload.data !== true) throw this.fail("publishRejected");
    return true;
  }

  async getAllConfigs(namespace, group) {
    const scope = this.resolveScope(namespace, group);
    const listResult = await this.listConfigs(scope.namespace, scope.group);
    const configs = [];
    for (const item of listResult.pageItems) {
      const itemGroup = item.groupName ?? item.group ?? scope.group;
      const itemNamespace = item.namespaceId ?? item.tenant ?? scope.namespace;
      try {
        const content = await this.getConfig(item.dataId, itemNamespace, itemGroup);
        configs.push({ dataId: item.dataId, group: itemGroup, content });
      } catch (error) {
        configs.push({ dataId: item.dataId, group: itemGroup, error: this.safeError(error) });
      }
    }
    return configs;
  }

  async readJson(response, operation) {
    try {
      return await response.json();
    } catch {
      throw this.fail("invalidJson", { operation });
    }
  }

  unwrapV3(payload, operation) {
    if (!isRecord(payload) || payload.code !== 0) {
      throw this.fail("responseRejected", { operation, code: safeCode(payload?.code) });
    }
    if (!Object.hasOwn(payload, "data")) throw this.fail("responseRejected", { operation, code: 0 });
    return payload.data;
  }

  safeError(error) {
    return error instanceof NacosError ? error.message : message(this.messages, "requestFailed", { operation: this.messages.getConfig });
  }
}
