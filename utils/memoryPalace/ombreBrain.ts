/**
 * Ombre Brain 适配层 — SullyOS × ombre-brain 双向同步
 *
 * 功能：
 *  1. 写入：SullyOS 聊天后自动把新记忆 also 存到 ombre-brain
 *  2. 检索：记忆宫殿搜索时额外查 ombre-brain，结果合并进上下文
 *
 * 认证机制（两套独立系统）：
 *  - Dashboard: Cookie session（/auth/login），cookie 存 localStorage
 *  - MCP: mcp-session-id，从 initialize 响应 header 拿到，后续请求传 header
 */

import type { RemoteVectorConfig } from './types';

// ─────────────────────────────────────────
// 类型
// ─────────────────────────────────────────

export interface OmbreBrainConfig {
  endpoint: string;          // "https://brain.xiao-shu.top"
  charId: string;           // 当前角色 ID
  password?: string;        // Dashboard 密码（只临时使用，不持久化）
}

export interface StoredOmbreConfig extends OmbreBrainConfig {
  configured: boolean;
}

// ─────────────────────────────────────────
// MCP JSON-RPC 类型
// ─────────────────────────────────────────

interface McpRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  structuredContent?: unknown;
}

// ─────────────────────────────────────────
// Session 持久化（两套独立 token）
// ─────────────────────────────────────────

const SESSION_KEY = "sullyos_ombre_session";     // Dashboard cookie
const CONFIG_KEY = "sullyos_ombre_config";
const MCP_SID_KEY = "sullyos_ombre_mcp_sid";     // mcp-session-id

export function saveOmbreSession(cookie: string): void {
  try { localStorage.setItem(SESSION_KEY, cookie); } catch {}
}

export function loadOmbreSession(): string | null {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}

export function clearOmbreSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(MCP_SID_KEY);
  } catch {}
}

function saveMcpSid(sid: string): void {
  try { localStorage.setItem(MCP_SID_KEY, sid); } catch {}
}

function loadMcpSid(): string | null {
  try { return localStorage.getItem(MCP_SID_KEY); } catch { return null; }
}

export function saveOmbreConfig(config: OmbreBrainConfig): void {
  try {
    const stored: StoredOmbreConfig = { ...config, configured: true };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(stored));
  } catch {}
}

export function loadOmbreConfig(): StoredOmbreConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ─────────────────────────────────────────
// 认证
// ─────────────────────────────────────────

/** 登录获取 Dashboard session cookie */
export async function ombreLogin(
  endpoint: string,
  password: string,
): Promise<{ cookie: string; error?: string }> {
  const resp = await fetch(`${endpoint}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ password }),
  });

  const setCookie = resp.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/ombre_session=([^;]+)/);
  const cookie = match ? `ombre_session=${match[1]}` : "";

  if (!resp.ok || !cookie) {
    const body = await resp.json().catch(() => ({}));
    return { cookie: "", error: (body as { error?: string }).error ?? `HTTP ${resp.status}` };
  }

  return { cookie };
}

// ─────────────────────────────────────────
// MCP 工具调用
// ─────────────────────────────────────────

/**
 * 向 ombre-brain MCP 端点发送 JSON-RPC 请求
 *
 * 关键：mcp-session-id 从 initialize 响应 header 获得，存 localStorage。
 * 后续请求通过 MCP-Session-Id header 传递（不是 cookie）。
 */
async function mcpRpc(
  endpoint: string,
  request: McpRequest,
  cookie: string,
  mcpSid: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Cookie": cookie,
    "MCP-Session-Id": mcpSid,
  };

  const resp = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  if (!resp.ok) {
    // 可能是 session 过期，尝试重新 initialize
    if (resp.status === 400) {
      const body = await resp.json().catch(() => ({}));
      if ((body as { message?: string }).message?.includes("session")) {
        throw new Error("SESSION_EXPIRED");
      }
    }
    throw new Error(`MCP HTTP ${resp.status}`);
  }

  // SSE 流：收集 targetId 对应的 result
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const targetId = request.id;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      if (raw.startsWith("event:")) continue;

      try {
        const msg = JSON.parse(raw) as McpResponse;
        if (msg.id === targetId && msg.result !== undefined) {
          return msg.result;
        }
      } catch {
        // skip invalid JSON
      }
    }
  }

  throw new Error(`MCP: no result for id ${targetId}`);
}

/**
 * 初始化 MCP session（幂等）
 * @returns mcp-session-id
 */
async function ensureMcpSession(
  endpoint: string,
  cookie: string,
): Promise<string> {
  // 先试试已保存的 sid
  const cachedSid = loadMcpSid();
  if (cachedSid) {
    try {
      await mcpRpc(endpoint, {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "pulse", arguments: {} },
        id: "ping",
      }, cookie, cachedSid);
      return cachedSid; // sid 仍然有效
    } catch (e) {
      // sid 无效或过期，重新 initialize
    }
  }

  // 第一次或 sid 失效：initialize 并从 header 提取新的 sid
  // 注意：需要先发请求才能拿到 header，所以分两步
  // Step 1: 发送 initialize 请求
  const resp = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Cookie": cookie,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sullyos-ombre-bridge", version: "1.0" },
      },
      id: 1,
    }),
  });

  if (!resp.ok) throw new Error(`initialize failed: ${resp.status}`);

  // 关键：从响应 header 提取 mcp-session-id
  const mcpSid = resp.headers.get("mcp-session-id") ?? "";
  if (!mcpSid) throw new Error("mcp-session-id header missing");

  // 提取完成，先缓存
  saveMcpSid(mcpSid);

  // 发送 initialized notification（fire-and-forget）
  fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Cookie": cookie,
      "MCP-Session-Id": mcpSid,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
      id: 0,
    }),
  }).catch(() => {});

  return mcpSid;
}

/**
 * 调用 ombre-brain MCP 工具
 */
export async function ombreCallTool(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown>,
  cookie: string,
): Promise<string> {
  const mcpSid = await ensureMcpSession(endpoint, cookie);

  const raw = await mcpRpc(endpoint, {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id: Math.random().toString(36).slice(2),
  }, cookie, mcpSid) as ToolResult;

  if (raw.content?.[0]?.text) return raw.content[0].text;
  return JSON.stringify(raw);
}

// ─────────────────────────────────────────
// 写入（SullyOS → ombre-brain）
// ─────────────────────────────────────────

/**
 * 把 SullyOS 的记忆写入 ombre-brain（调用 MCP hold 工具）
 *
 * @param endpoint ombre-brain 地址
 * @param memoryNode 只需要 content 字段，其他可选
 * @param cookie 认证 cookie
 */
export async function ombreHoldMemory(
  endpoint: string,
  memoryNode: {
    content: string;
    room?: string;
    importance?: number;
    mood?: string;
    tags?: string[];
    createdAt?: number;
    sourceId?: string;
  },
  cookie: string,
): Promise<string> {
  const args: Record<string, unknown> = { content: memoryNode.content };
  if (memoryNode.room) args["room"] = memoryNode.room;
  if (memoryNode.importance !== undefined) args["importance"] = memoryNode.importance;
  if (memoryNode.mood) args["mood"] = memoryNode.mood;
  if (memoryNode.tags?.length) args["tags"] = memoryNode.tags.join(",");
  if (memoryNode.createdAt) args["created_at"] = new Date(memoryNode.createdAt).toISOString();
  if (memoryNode.sourceId) args["source_id"] = memoryNode.sourceId;

  return ombreCallTool(endpoint, "hold", args, cookie);
}

/**
 * 批量写入（SullyOS 缓冲攒够后批量 hold）
 */
export async function ombreHoldBatch(
  endpoint: string,
  memoryNodes: Array<{
    content: string;
    room?: string;
    importance?: number;
    mood?: string;
    tags?: string[];
    createdAt?: number;
    sourceId?: string;
  }>,
  cookie: string,
): Promise<string[]> {
  return Promise.all(
    memoryNodes.map((node) =>
      ombreHoldMemory(endpoint, node, cookie).catch((e) => `ERROR: ${e.message}`)
    )
  );
}

// ─────────────────────────────────────────
// 检索（ombre-brain → SullyOS）
// ─────────────────────────────────────────

/**
 * 从 ombre-brain 检索记忆（调用 MCP breath 工具）
 */
export async function ombreBreath(
  endpoint: string,
  query: string,
  maxTokens = 8000,
  maxResults = 10,
  cookie?: string,
): Promise<string> {
  if (!cookie) return "[ombre-brain] 未登录，无法检索";

  try {
    return await ombreCallTool(endpoint, "breath", {
      query,
      max_tokens: maxTokens,
      max_results: maxResults,
    }, cookie);
  } catch (e) {
    if (e instanceof Error && e.message === "SESSION_EXPIRED") {
      // session 过期，清掉重新来
      try { localStorage.removeItem(MCP_SID_KEY); } catch {}
      return "[ombre-brain] session 过期，正在重新登录...";
    }
    return `[ombre-brain] 检索失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 解析 breath 返回的文本为结构化记忆列表
 * 格式：
 *   📌 [核心准则] [bucket_id:xxx] 内容...
 *   ---
 *   [权重:0.85] [bucket_id:xxx] 内容...
 */
export function parseBreathResult(text: string): Array<{
  type: "pinned" | "dynamic";
  bucketId?: string;
  weight?: number;
  importance?: number;
  content: string;
}> {
  if (!text || text.startsWith("[ombre-brain]")) return [];

  const results: Array<{
    type: "pinned" | "dynamic";
    bucketId?: string;
    weight?: number;
    importance?: number;
    content: string;
  }> = [];

  const blocks = text.split(/---\n?/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("📌")) {
      const idMatch = trimmed.match(/\[bucket_id:([^\]]+)\]/);
      const content = trimmed.replace(/📌.*?\] \[bucket_id:[^\]]+\] /, "");
      results.push({ type: "pinned", bucketId: idMatch?.[1], content });
    } else {
      const idMatch = trimmed.match(/\[bucket_id:([^\]]+)\]/);
      const weightMatch = trimmed.match(/\[权重:([^\]]+)\]/);
      const impMatch = trimmed.match(/\[importance:([^\]]+)\]/);
      const content = trimmed
        .replace(/\[权重:[^\]]+\]/g, "")
        .replace(/\[importance:[^\]]+\]/g, "")
        .replace(/\[bucket_id:[^\]]+\] /g, "")
        .trim();
      results.push({
        type: "dynamic",
        bucketId: idMatch?.[1],
        weight: weightMatch ? parseFloat(weightMatch[1]) : undefined,
        importance: impMatch ? parseInt(impMatch[1]) : undefined,
        content,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────
// 系统状态
// ─────────────────────────────────────────

export async function ombrePulse(
  endpoint: string,
  cookie: string,
): Promise<string> {
  return ombreCallTool(endpoint, "pulse", {}, cookie);
}

// ─────────────────────────────────────────
// REST API 搜索（备用）
// ─────────────────────────────────────────

export interface OmbreSearchResult {
  id: string;
  name: string;
  score: number;
  domain: string[];
  valence: number;
  arousal: number;
  content_preview: string;
}

export async function ombreSearch(
  endpoint: string,
  query: string,
  limit = 10,
  cookie?: string,
): Promise<OmbreSearchResult[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cookie) headers["Cookie"] = cookie;

  const resp = await fetch(
    `${endpoint}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers }
  );
  if (!resp.ok) return [];
  return resp.json() as Promise<OmbreSearchResult[]>;
}

// ─────────────────────────────────────────
// 一键登录（密码 → 获取 cookie + 初始化 MCP）
// ─────────────────────────────────────────

/**
 * 用密码登录并初始化 MCP session
 * @returns cookie（已保存到 localStorage）
 */
export async function ombreLoginAndInit(
  endpoint: string,
  password: string,
): Promise<{ cookie: string; error?: string }> {
  const { cookie, error } = await ombreLogin(endpoint, password);
  if (error || !cookie) return { cookie: "", error };

  // 初始化 MCP session（这会触发 sid 的获取和保存）
  try {
    await ensureMcpSession(endpoint, cookie);
  } catch (e) {
    // 即使 MCP init 失败，cookie 仍然有效（dashboard 可用）
    // MCP session 可以下次使用时重新初始化
  }

  saveOmbreSession(cookie);
  return { cookie };
}

// ─────────────────────────────────────────
// 快捷验证：检查 ombre-brain 是否可用
// ─────────────────────────────────────────

export async function ombreHealthCheck(
  endpoint: string,
  cookie?: string,
): Promise<{ ok: boolean; buckets?: number; error?: string }> {
  try {
    const resp = await fetch(`${endpoint}/health`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as { status?: string; buckets?: number };
    return { ok: data.status === "ok", buckets: data.buckets };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
