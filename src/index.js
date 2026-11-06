#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { getMessages, message } from "./i18n.js";
import { NacosClient, NacosError } from "./nacos-client.js";

export const TOOL_CONTRACT = Object.freeze({
  nacos_get_config: Object.freeze(["dataId", "namespace", "group"]),
  nacos_list_configs: Object.freeze(["namespace", "group"]),
  nacos_get_all_configs: Object.freeze(["namespace", "group"]),
  nacos_publish_config: Object.freeze(["dataId", "content", "namespace", "group"]),
});

function toolSchemas(messages) {
  const scope = {
    namespace: z.string().optional().describe(messages.namespace),
    group: z.string().optional().describe(messages.group),
  };
  return {
    get: { dataId: z.string().describe(messages.dataId), ...scope },
    list: scope,
    publish: {
      dataId: z.string().describe(messages.dataId),
      content: z.string().describe(messages.content),
      ...scope,
    },
  };
}

/** 创建可注入客户端的 MCP server，导入模块时不启动 stdio。 */
export function createServer({ nacos, language = process.env.NACOS_LANGUAGE } = {}) {
  const messages = getMessages(language);
  const client = nacos ?? createDefaultClient(messages);
  const schemas = toolSchemas(messages);
  const server = new McpServer({ name: "nacos-mcp-server", version: "1.0.0" });
  registerReadTools(server, client, messages, schemas);
  registerPublishTool(server, client, messages, schemas);
  return server;
}

function createDefaultClient(messages) {
  return new NacosClient({
    messages,
    logger: (logMessage) => console.error(message(messages, "runtimeLog", { message: logMessage })),
  });
}

function registerReadTools(server, client, messages, schemas) {
  server.tool("nacos_get_config", messages.toolGetConfig, schemas.get, getConfigHandler(client, messages));
  server.tool("nacos_list_configs", messages.toolListConfigs, schemas.list, listConfigsHandler(client, messages));
  server.tool("nacos_get_all_configs", messages.toolGetAllConfigs, schemas.list, getAllConfigsHandler(client, messages));
}

function getConfigHandler(client, messages) {
  return async ({ dataId, namespace, group }) => {
    try {
      const content = await client.getConfig(dataId, namespace, group);
      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      return toolError(messages, "getFailed", error);
    }
  };
}

function listConfigsHandler(client, messages) {
  return async ({ namespace, group }) => {
    try {
      const result = await client.listConfigs(namespace, group);
      const items = (Array.isArray(result?.pageItems) ? result.pageItems : []).filter(isRecord);
      const lines = [message(messages, "listTitle", { total: result?.totalCount ?? items.length }), "", ...items.map((item) => `- ${String(item.dataId ?? "")}`)];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return toolError(messages, "listFailed", error);
    }
  };
}

function getAllConfigsHandler(client, messages) {
  return async ({ namespace, group }) => {
    try {
      const configs = await client.getAllConfigs(namespace, group);
      const parts = (Array.isArray(configs) ? configs : []).filter(isRecord).map((config) => formatConfig(config, messages));
      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    } catch (error) {
      return toolError(messages, "getAllFailed", error);
    }
  };
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function formatConfig(config, messages) {
  if (config.error) return `===== ${String(config.dataId ?? "")} =====\n${message(messages, "itemError", { message: config.error })}`;
  return `===== ${String(config.dataId ?? "")} =====\n${String(config.content ?? "")}`;
}

function registerPublishTool(server, client, messages, schemas) {
  server.tool("nacos_publish_config", messages.toolPublishConfig, schemas.publish, publishConfigHandler(client, messages));
}

function publishConfigHandler(client, messages) {
  return async ({ dataId, content, namespace, group }) => {
    try {
      await client.publishConfig(dataId, content, namespace, group);
      return { content: [{ type: "text", text: message(messages, "publishSuccess", { dataId }) }] };
    } catch (error) {
      return toolError(messages, "publishFailed", error);
    }
  };
}

function toolError(messages, key, error) {
  const detail = error instanceof NacosError ? error.message : messages.toolUnexpectedError;
  return {
    content: [{ type: "text", text: message(messages, key, { message: detail }) }],
    isError: true,
  };
}

export async function start() {
  const messages = getMessages(process.env.NACOS_LANGUAGE);
  try {
    const server = createServer({ language: process.env.NACOS_LANGUAGE });
    await server.connect(new StdioServerTransport());
    console.error(message(messages, "runtimeLog", { message: messages.started }));
  } catch (error) {
    const detail = error instanceof NacosError ? error.message : messages.startupFailed;
    console.error(message(messages, "runtimeLog", { message: detail }));
    process.exitCode = 1;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  await start();
}
