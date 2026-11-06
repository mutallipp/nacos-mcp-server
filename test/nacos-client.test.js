import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { getMessages, message } from "../src/i18n.js";
import { loadConfig, NacosClient, normalizeBaseUrl } from "../src/nacos-client.js";

function response(body, { status = 200, headers } = {}) {
  return new Response(body, { status, headers });
}

function json(value, options) {
  return response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...options });
}

function clientConfig(overrides = {}) {
  return {
    serverAddr: "nacos.example:8848",
    contextPath: "/nacos",
    contextPathExplicit: true,
    namespace: "default-ns",
    group: "DEFAULT_GROUP",
    username: "test-user",
    password: "test-password",
    apiVersion: "v1",
    authMode: "disabled",
    timeoutMs: 100,
    ...overrides,
  };
}

function queuedFetch(responses, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
}

test("normalizes bare hosts, HTTP(S) URLs, and explicit contexts", () => {
  assert.equal(normalizeBaseUrl("nacos.example:8848", "/nacos"), "http://nacos.example:8848/nacos");
  assert.equal(normalizeBaseUrl("http://nacos.example:8848", "/nacos"), "http://nacos.example:8848/nacos");
  assert.equal(normalizeBaseUrl("https://nacos.example/root"), "https://nacos.example/root");
  assert.equal(normalizeBaseUrl("https://nacos.example/from-url", "/configured", true), "https://nacos.example/configured");
  assert.equal(normalizeBaseUrl("https://nacos.example/from-url", "", true), "https://nacos.example");
  assert.throws(() => normalizeBaseUrl("ftp://nacos.example"), /HTTP 或 HTTPS/);
  assert.throws(() => normalizeBaseUrl("nacos.example/nacos"), /裸 Nacos/);
});

test("loads explicit empty context from environment and rejects unsafe JSON errors", () => {
  const files = new Map([
    ["/home/.nacos-mcp.json", '{"serverAddr":"home.example:8848","group":"HOME"}'],
    ["/project/.nacos-mcp.json", '{"serverAddr":"project.example:8848","apiVersion":"v3"}'],
  ]);
  const config = loadConfig({
    cwd: "/project",
    homeDir: "/home",
    env: { NACOS_SERVER_ADDR: "env.example:8848", NACOS_GROUP: "ENV", NACOS_CONTEXT_PATH: "" },
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path),
  });
  assert.equal(config.serverAddr, "project.example:8848");
  assert.equal(config.group, "HOME");
  assert.equal(config.contextPath, "");
  assert.equal(config.contextPathExplicit, true);
  assert.throws(() => loadConfig({ cwd: "/bad", homeDir: "/home", exists: (path) => path === "/bad/.nacos-mcp.json", readFile: () => '{"password":"super-secret"' }), (error) => {
    assert.equal(error.message, "Nacos 配置文件无效");
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
});

test("supports disabled authentication and legacy none alias", async () => {
  const disabled = new NacosClient({ config: clientConfig(), fetchImpl: queuedFetch([response("content")]) });
  assert.equal(await disabled.getConfig("a.yaml"), "content");
  const legacyNone = new NacosClient({ config: clientConfig({ authMode: "none" }), fetchImpl: queuedFetch([response("content")]) });
  assert.equal(await legacyNone.getConfig("a.yaml"), "content");
});

test("uses Nacos v3 login and config endpoints with encoded parameters", async () => {
  const calls = [];
  const client = new NacosClient({
    config: clientConfig({ apiVersion: "v3", authMode: "login" }),
    fetchImpl: queuedFetch([
      json({ accessToken: "token value", tokenTtl: 300 }),
      json({ code: 0, data: { content: "你好\n\nvalue" } }),
    ], calls),
  });
  assert.equal(await client.getConfig("应用.yaml", "name space", "group/a"), "你好\n\nvalue");
  assert.match(calls[0].url, /\/v3\/auth\/user\/login$/);
  assert.match(calls[1].url, /\/v3\/console\/cs\/config\?/);
  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get("namespaceId"), "name space");
  assert.equal(query.get("groupName"), "group/a");
  assert.equal(query.get("accessToken"), "token value");
});

test("never falls back to anonymous access and never leaks response secrets", async () => {
  const client = new NacosClient({
    config: clientConfig({ authMode: "login", password: "super-secret" }),
    fetchImpl: queuedFetch([response("password=super-secret&accessToken=token-value\nfull-config-content", { status: 401 })]),
  });
  await assert.rejects(client.getConfig("a.yaml"), (error) => {
    assert.match(error.message, /登录.*HTTP 401/);
    assert.doesNotMatch(error.message, /super-secret|token-value|full-config-content/);
    return true;
  });
  const malformed = new NacosClient({
    config: clientConfig({ authMode: "login" }),
    fetchImpl: queuedFetch([response('{"accessToken":"super-secret"')]),
  });
  await assert.rejects(malformed.login(), (error) => {
    assert.match(error.message, /无效 JSON/);
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
  const serverFailure = new NacosClient({
    config: clientConfig({ authMode: "login" }),
    fetchImpl: queuedFetch([response("server configuration body", { status: 500 })]),
  });
  await assert.rejects(serverFailure.login(), /登录.*HTTP 500/);
  const missingToken = new NacosClient({
    config: clientConfig({ authMode: "login" }),
    fetchImpl: queuedFetch([json({ tokenTtl: 300 })]),
  });
  await assert.rejects(missingToken.login(), /缺少 accessToken/);
});

test("applies timeout while response bodies are still stalled", async () => {
  const stalledBody = new ReadableStream({ start() {} });
  const client = new NacosClient({
    config: clientConfig({ timeoutMs: 5 }),
    fetchImpl: queuedFetch([new Response(stalledBody)]),
  });
  await assert.rejects(client.getConfig("a.yaml"), /读取配置.*5ms.*超时/);
});

test("collects every list page and reads each item using its own group", async () => {
  const calls = [];
  const client = new NacosClient({
    config: clientConfig({ apiVersion: "v3" }),
    fetchImpl: queuedFetch([
      json({ code: 0, data: { totalCount: 2, pageItems: [{ dataId: "one", groupName: "A", namespaceId: "ns-a" }] } }),
      json({ code: 0, data: { totalCount: 2, pageItems: [{ dataId: "two", groupName: "B", namespaceId: "ns-b" }] } }),
      json({ code: 0, data: { content: "first" } }),
      json({ code: 0, data: { content: "second" } }),
    ], calls),
  });
  const configs = await client.getAllConfigs();
  assert.deepEqual(configs, [
    { dataId: "one", group: "A", content: "first" },
    { dataId: "two", group: "B", content: "second" },
  ]);
  assert.equal(new URL(calls[1].url).searchParams.get("pageNo"), "2");
  assert.equal(new URL(calls[2].url).searchParams.get("groupName"), "A");
  assert.equal(new URL(calls[3].url).searchParams.get("groupName"), "B");
});

test("rejects malformed and incomplete pagination instead of returning partial results", async () => {
  const missingFields = new NacosClient({
    config: clientConfig(),
    fetchImpl: queuedFetch([json({ pageItems: [] })]),
  });
  await assert.rejects(missingFields.listConfigs(), /响应格式无效/);

  const incomplete = new NacosClient({
    config: clientConfig(),
    fetchImpl: queuedFetch([
      json({ totalCount: 2, pageItems: [{ dataId: "one" }] }),
      json({ totalCount: 2, pageItems: [] }),
    ]),
  });
  await assert.rejects(incomplete.listConfigs(), /提前结束/);
});

test("accepts only numeric totalCount values with non-negative decimal semantics", async () => {
  const invalidValues = [undefined, null, false, true, [], {}, "", " ", "1e2", "1.5", -1, -1.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const totalCount of invalidValues) {
    const client = new NacosClient({
      config: clientConfig(),
      fetchImpl: queuedFetch([{ ok: true, json: async () => ({ totalCount, pageItems: [] }) }]),
    });
    await assert.rejects(client.listConfigs(), /totalCount 无效/);
  }

  for (const [totalCount, itemCount] of [[0, 0], ["0", 0], [1, 1], ["1", 1]]) {
    const client = new NacosClient({
      config: clientConfig(),
      fetchImpl: queuedFetch([{
        ok: true,
        json: async () => ({
          totalCount,
          pageItems: Array.from({ length: itemCount }, (_, index) => ({ dataId: `config-${index}` })),
        }),
      }]),
    });
    const result = await client.listConfigs();
    assert.equal(result.totalCount, Number(totalCount));
    assert.equal(result.pageItems.length, itemCount);
  }
});

test("keeps Unicode and blank lines byte-for-byte in publish bodies and accepts only true", async () => {
  const calls = [];
  const content = "你好\n\n# keep this line\n";
  const client = new NacosClient({ config: clientConfig(), fetchImpl: queuedFetch([response("true")], calls) });
  assert.equal(await client.publishConfig("demo.yaml", content), true);
  const form = new URLSearchParams(calls[0].options.body);
  assert.equal(form.get("content"), content);
  assert.equal(form.get("type"), "yaml");

  const rejected = new NacosClient({ config: clientConfig(), fetchImpl: queuedFetch([response("false")]) });
  await assert.rejects(rejected.publishConfig("demo.txt", "x"), /拒绝发布/);
});

test("requires v3 success code and boolean data for publish", async () => {
  const nonZero = new NacosClient({
    config: clientConfig({ apiVersion: "v3" }),
    fetchImpl: queuedFetch([json({ code: 1, message: "full config content", data: true })]),
  });
  await assert.rejects(nonZero.publishConfig("demo.txt", "x"), (error) => {
    assert.match(error.message, /错误码 1/);
    assert.doesNotMatch(error.message, /full config content/);
    return true;
  });

  const falseData = new NacosClient({
    config: clientConfig({ apiVersion: "v3" }),
    fetchImpl: queuedFetch([json({ code: 0, data: false })]),
  });
  await assert.rejects(falseData.publishConfig("demo.txt", "x"), /拒绝发布/);
});

test("provides bilingual detailed errors and exposes four tools through MCP listTools", async () => {
  assert.equal(message(getMessages("zh-CN"), "authModeInvalid"), "NACOS_AUTH_MODE 必须是 login、required、disabled 或 none");
  assert.equal(message(getMessages("en-US"), "authModeInvalid"), "NACOS_AUTH_MODE must be login, required, disabled, or none");
  assert.equal(getMessages("toString").toolGetConfig, getMessages("zh-CN").toolGetConfig);

  const server = createServer({ nacos: {} });
  const client = new Client({ name: "nacos-contract-test", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name), [
      "nacos_get_config",
      "nacos_list_configs",
      "nacos_get_all_configs",
      "nacos_publish_config",
    ]);
    assert.deepEqual(result.tools.find((tool) => tool.name === "nacos_publish_config").inputSchema.required, ["dataId", "content"]);
  } finally {
    await client.close();
    await server.close();
  }
});
