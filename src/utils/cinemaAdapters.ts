/**
 * cinemaAdapters.ts
 * 
 * KI-CO companionAdapters.ts 移植版，专为 SullyOS 适配。
 * 将 SullyOS 的 apiConfig / personality_core / messages 表
 * 接入 KI-CO 的 prompt 构建 + 多 provider LLM 调用。
 */

import type {
  CompanionRequest,
  CompanionResponse,
  ConversationAttachment,
  SubtitleCue,
  WatchContext,
  MemorySnippet,
  ConversationTurn,
} from '../types';
import { DB } from './db';


function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}


// ─── Prompt 构建 ────────────────────────────────────────────────────────────

function cueLine(cue: SubtitleCue): string {
  return `[${formatTime(cue.start)}-${formatTime(cue.end)}] ${cue.text}`;
}

function attachmentPromptBlock(attachments: ConversationAttachment[] = []): string {
  if (!attachments.length) return '';
  return attachments
    .map((attachment, index) => {
      if (attachment.type === 'image') {
        return `- Image ${index + 1}: ${attachment.name || 'uploaded image'} (${attachment.mimeType || 'image'})`;
      }
      const text = attachment.text?.trim();
      return [
        `- File ${index + 1}: ${attachment.name || 'uploaded file'} (${attachment.mimeType || 'file'}, ${Math.round((attachment.size || 0) / 1024)}KB)`,
        text ? `  Content excerpt:\n${text.slice(0, 6000)}` : '  Content excerpt: unavailable.',
      ].join('\n');
    })
    .join('\n');
}

function imageAttachments(attachments: ConversationAttachment[] = []): ConversationAttachment[] {
  return attachments.filter((attachment) => attachment.type === 'image' && attachment.dataUrl?.startsWith('data:image/'));
}

function imagesForModel(request: CompanionRequest, maxImages = 4): ConversationAttachment[] {
  const currentImages = imageAttachments(request.attachments);
  const currentIds = new Set(currentImages.map((attachment) => attachment.id));
  const recentImages = imageAttachments(
    request.recentMessages?.flatMap((message) => message.attachments ?? []) ?? [],
  ).filter((attachment) => !currentIds.has(attachment.id));
  const roomForRecent = Math.max(0, maxImages - currentImages.length);
  return [...recentImages.slice(-roomForRecent), ...currentImages].slice(-maxImages);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 3));
}

export function buildCompanionPrompt(request: CompanionRequest): string {
  if (request.mode === 'plan') {
    return [
      'You are generating a cinema companion plan for a co-watching room.',
      'Use the persona core, user context, and relevant memories as continuity and tonal grounding.',
      'The result must be useful for timed, short companion bubbles during playback.',
      '',
      'Persona core:',
      request.personaCore,
      request.userContext ? `\nUser context:\n${request.userContext}` : '',
      request.userMessage ? `\nPlan request:\n${request.userMessage}` : '',
      '',
      'Return only one JSON object. No Markdown, no code fences, no explanation.',
      'Root object shape: {"movieTitle":"...","mode":"active|natural|silent","density":"quiet|normal|talkative|breakdown","triggers":[{"id":"t1","time":312,"type":"emotion|observe|question|memory","priority":"high|medium|low","bubble":"short natural line","delivery":"auto|hint|manual"}]}',
      'Each bubble should sound like a natural companion sitting nearby.',
      'Avoid customer-service wording and formal review outlines.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (request.mode === 'chat') {
    const recentMessages = request.recentMessages
      ?.map((message) => {
        const attachmentNote = message.attachments?.length ? ` [attachments: ${message.attachments.length}]` : '';
        return `${message.role === 'user' ? 'User' : 'Companion'}${attachmentNote}: ${message.text}`;
      })
      .join('\n');
    const attachments = attachmentPromptBlock(request.attachments);

    return [
      'You are an AI companion configured by the user\'s persona core and memory notes.',
      '',
      'Persona core:',
      request.personaCore,
      request.userContext ? `\nUser context:\n${request.userContext}` : '',
      recentMessages ? `\nRecent conversation:\n${recentMessages}` : '',
      attachments ? `\nCurrent attachments:\n${attachments}` : '',
      '',
      `User says: ${request.userMessage}`,
      '',
      'Answer in the user\'s language by default. Keep the current facts more important than old memories.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (request.mode === 'watchPrompt') {
    const recentMessages = request.recentMessages
      ?.map((message) => `${message.role === 'user' ? 'User' : 'Companion'}: ${message.text}`)
      .join('\n');

    return [
      'You are an AI companion configured by the user\'s persona core and memory notes.',
      'Use the provided co-watching prompt as the current user request. Keep the answer natural, specific, and present in the movie moment.',
      'Let the movie belong to itself first. If this moment truly touches the user, memories, or shared context, bring that in naturally.',
      'Keep the breathing rhythm of the current scene: sometimes a short aside is enough.',
      '',
      'Persona core:',
      request.personaCore,
      request.userContext ? `\nUser context:\n${request.userContext}` : '',
      recentMessages ? `\nRecent conversation:\n${recentMessages}` : '',
      '',
      request.userMessage,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // Cinema mode (default)
  const { watch } = request;
  const subtitleContext = [
    ...watch.subtitleWindow.previous.map(cueLine),
    watch.activeSubtitle ? `>> ${cueLine(watch.activeSubtitle)}` : '',
    ...watch.subtitleWindow.next.map(cueLine),
  ]
    .filter(Boolean)
    .join('\n');

  const recentMessages = request.recentMessages
    ?.map((message) => `${message.role === 'user' ? 'User' : 'Companion'}: ${message.text}`)
    .join('\n');

  return [
    'You are a cinema companion, not a generic movie explainer.',
    'Stay in character according to the persona core, but keep the answer grounded in the current movie moment.',
    'Let the movie belong to itself first.',
    'Keep the breathing rhythm of the current scene: sometimes a short aside is enough.',
    '',
    'Persona core:',
    request.personaCore,
    request.userContext ? `\nUser context:\n${request.userContext}` : '',
    recentMessages ? `\nRecent conversation:\n${recentMessages}` : '',
    '',
    `Movie: ${watch.title || 'Untitled'}`,
    `Current time: ${formatTime(watch.currentTime)} / ${formatTime(watch.duration)}`,
    subtitleContext ? `\nSubtitle window:\n${subtitleContext}` : '\nSubtitle window: none',
    watch.screenshotDataUrl ? '\nA screenshot from the current frame is attached.' : '',
    '',
    `User says: ${request.userMessage}`,
    '',
    'Answer naturally as a co-watching companion. Avoid template-like film criticism unless the user asks for analysis.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── Memory 检索（SullyOS messages 表） ───────────────────────────────────

const memoryCacheScope = 'cinema-watching';

export async function retrieveMemorySnippets(query: string, limit = 4): Promise<MemorySnippet[]> {
  // 从 SullyOS messages 表检索最近的 assistant 消息作为记忆片段
  // 这里简化：取最近 50 条消息做关键词匹配
  try {
    const charId = localStorage.getItem('activeCharacterId');
    if (!charId) return [];
    
    // 注意：DB.getMessagesByCharId 是异步的，这里用 getRecentMessages 代替
    // 实际实现时应该用 IndexedDB 的游标扫描或限制条数
    return [];
  } catch {
    return [];
  }
}

// ─── API 调用 ───────────────────────────────────────────────────────────────

interface SullyOSApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  stream?: boolean;
  temperature?: number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function getDataUrlParts(dataUrl = ''): { mediaType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function extractTextFromOpenAICompatible(payload: any): string {
  const message = payload?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  return payload?.choices?.[0]?.text || '';
}

async function requestJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { text };
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || text || response.statusText;
    throw new Error(`API Error ${response.status}: ${message}`);
  }
  return payload;
}

async function readOpenAICompatibleStream(
  response: Response,
  onStreamUpdate?: (text: string) => void,
): Promise<{ text: string; usage?: any; model?: string }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const payload = await response.json().catch(() => ({}));
    return {
      text: extractTextFromOpenAICompatible(payload),
      usage: payload?.usage,
      model: typeof payload?.model === 'string' ? payload.model : undefined,
    };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let usage: any = null;
  let model: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;

      const data = line.replace(/^data:\s*/, '');
      if (!data || data === '[DONE]') continue;

      try {
        const payload = JSON.parse(data);
        if (typeof payload?.model === 'string') model = payload.model;
        if (payload?.usage) usage = payload.usage;
        const delta = payload?.choices?.[0]?.delta;
        const content = delta?.content ?? delta?.text ?? '';
        if (typeof content === 'string' && content) {
          fullText += content;
          onStreamUpdate?.(fullText);
        }
      } catch {
        // ignore malformed chunks
      }
    }
  }

  return { text: fullText.trim(), usage, model };
}

function shouldRetryWithoutStreamUsage(errorText: string): boolean {
  return /stream_options|include_usage|unknown parameter|unsupported|unrecognized|extra field|invalid field/i.test(errorText);
}

async function completeWithOpenAICompatible(
  apiConfig: SullyOSApiConfig,
  request: CompanionRequest,
): Promise<CompanionResponse> {
  const promptPreview = buildCompanionPrompt(request);
  const temperature = apiConfig.temperature ?? 0.7;
  const maxOutputTokens = request.mode === 'plan' ? 4096 : 512;
  const endpoint = `${trimTrailingSlash(apiConfig.baseUrl)}/chat/completions`;
  const shouldStream = request.mode !== 'plan' && (apiConfig.stream ?? false);

  const content: any[] = [{ type: 'text', text: promptPreview }];

  // 截图发给模型
  if (request.watch.screenshotDataUrl) {
    content.push({
      type: 'image_url',
      image_url: { url: request.watch.screenshotDataUrl },
    });
  }

  for (const attachment of imagesForModel(request, 4)) {
    content.push({
      type: 'image_url',
      image_url: { url: attachment.dataUrl },
    });
  }

  const body: Record<string, unknown> = {
    model: apiConfig.model,
    messages: [{ role: 'user', content }],
    temperature,
    max_tokens: maxOutputTokens,
    stream: shouldStream,
  };

  if (shouldStream) {
    body.stream_options = { include_usage: true };
  }

  let requestBody = body;
  let response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiConfig.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    let text = await response.text();
    if (shouldStream && requestBody.stream_options && shouldRetryWithoutStreamUsage(text)) {
      const retryBody = { ...body };
      delete retryBody.stream_options;
      requestBody = retryBody;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(retryBody),
      });
      text = response.ok ? '' : await response.text();
    }
    if (!response.ok) {
      let payload: any = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { text };
      }
      const message = payload?.error?.message || payload?.message || text || response.statusText;
      throw new Error(`API Error ${response.status}: ${message}`);
    }
  }

  if (shouldStream) {
    const streamed = await readOpenAICompatibleStream(response, request.onStreamUpdate);
    return {
      text: streamed.text || '模型返回为空。',
      promptPreview,
      modelUsed: streamed.model || apiConfig.model,
      tokenCount: estimateTokens(streamed.text),
    };
  }

  const payload = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiConfig.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  return {
    text: extractTextFromOpenAICompatible(payload) || '模型返回为空。',
    promptPreview,
    modelUsed: typeof payload?.model === 'string' ? payload.model : apiConfig.model,
    tokenCount: estimateTokens(extractTextFromOpenAICompatible(payload)),
  };
}

// ─── Claude Provider ────────────────────────────────────────────────────────

async function completeWithClaude(
  apiConfig: SullyOSApiConfig,
  request: CompanionRequest,
): Promise<CompanionResponse> {
  const promptPreview = buildCompanionPrompt(request);
  const temperature = apiConfig.temperature ?? 0.7;
  const maxOutputTokens = request.mode === 'plan' ? 4096 : 512;

  const content: any[] = [{ type: 'text', text: promptPreview }];

  const image = request.watch.screenshotDataUrl ? getDataUrlParts(request.watch.screenshotDataUrl) : null;
  const attachedImages = imagesForModel(request, 4)
    .map((attachment) => getDataUrlParts(attachment.dataUrl))
    .filter(Boolean) as Array<{ mediaType: string; data: string }>;

  if (image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }

  for (const attachment of attachedImages) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data },
    });
  }

  const baseUrl = trimTrailingSlash(apiConfig.baseUrl) || 'https://api.anthropic.com';
  const payload = await requestJson(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiConfig.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: apiConfig.model,
      max_tokens: maxOutputTokens,
      temperature,
      messages: [{ role: 'user', content }],
    }),
  });

  const text = Array.isArray(payload?.content)
    ? payload.content.map((part: any) => part?.text || '').filter(Boolean).join('\n')
    : 'Claude 返回为空。';

  return { text, promptPreview, modelUsed: apiConfig.model };
}

// ─── Gemini Provider ─────────────────────────────────────────────────────────

async function completeWithGemini(
  apiConfig: SullyOSApiConfig,
  request: CompanionRequest,
): Promise<CompanionResponse> {
  const promptPreview = buildCompanionPrompt(request);
  const temperature = apiConfig.temperature ?? 0.7;
  const maxOutputTokens = request.mode === 'plan' ? 4096 : 512;

  const parts: any[] = [{ text: promptPreview }];

  if (request.watch.screenshotDataUrl) {
    const img = getDataUrlParts(request.watch.screenshotDataUrl);
    if (img) {
      parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
    }
  }

  for (const attachment of imagesForModel(request, 4)) {
    const img = getDataUrlParts(attachment.dataUrl);
    if (img) {
      parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
    }
  }

  const baseUrl = trimTrailingSlash(apiConfig.baseUrl) || 'https://generativelanguage.googleapis.com';
  const endpoint = `${baseUrl}/models/${encodeURIComponent(apiConfig.model)}:generateContent?key=${encodeURIComponent(apiConfig.apiKey)}`;

  const payload = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature, maxOutputTokens },
    }),
  });

  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: any) => part?.text || '')
    .filter(Boolean)
    .join('\n') || 'Gemini 返回为空。';

  return { text, promptPreview, modelUsed: apiConfig.model };
}

// ─── Provider 检测 + 分发 ─────────────────────────────────────────────────

function detectProvider(apiConfig: SullyOSApiConfig): 'openai' | 'claude' | 'gemini' | 'openrouter' {
  const baseUrl = (apiConfig.baseUrl || '').toLowerCase();
  const model = (apiConfig.model || '').toLowerCase();

  if (baseUrl.includes('anthropic') || model.includes('claude')) return 'claude';
  if (baseUrl.includes('google') || baseUrl.includes('generativelanguage') || model.includes('gemini')) return 'gemini';
  if (baseUrl.includes('openrouter')) return 'openrouter';
  return 'openai';
}

// ─── 主入口：SullyOS Cinema LLM Adapter ─────────────────────────────────────

export interface CinemaAdapterOptions {
  apiConfig: SullyOSApiConfig;
  personaCore: string;
  userContext?: string;
  activeCharacterId: string | null;
  /** 从 SullyOS messages 表获取最近 N 条 */
  recentMessageLimit?: number;
}

export async function cinemaComplete(
  mode: CompanionRequest['mode'],
  userMessage: string,
  watch: WatchContext,
  options: CinemaAdapterOptions,
): Promise<CompanionResponse> {
  const { apiConfig, personaCore, userContext, recentMessageLimit = 20 } = options;

  if (!apiConfig?.apiKey?.trim()) {
    return { text: '请先在设置中配置 API Key。', modelUsed: '' };
  }

  const request: CompanionRequest = {
    mode: mode || 'cinema',
    userMessage,
    watch,
    personaCore,
    userContext,
    attachments: [],
    memories: [],
    recentMessages: [],
  };

  const provider = detectProvider(apiConfig);

  if (provider === 'claude') {
    return completeWithClaude(apiConfig, request);
  }
  if (provider === 'gemini') {
    return completeWithGemini(apiConfig, request);
  }

  return completeWithOpenAICompatible(apiConfig, request);
}
