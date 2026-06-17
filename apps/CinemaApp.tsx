/**
 * CinemaApp.tsx — SullyOS 观影室（KI-CO 适配版）
 * 
 * 改动：
 * - callCompanionLLM → cinemaComplete（多provider、流式）
 * - 加入截图 captureVideoFrame
 * - 陪看气泡流式输出
 * - 智能陪看计划生成（LLM 生成 JSON）
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FilmReel, PlayCircle, Pause, SkipBack, SkipForward,
  Playlist, MagnifyingGlass, GearSix, Upload,
  X, Export, ClosedCaptioning, Trash, Clock,
  ChatCircle, Video, PaperPlaneRight, CaretLeft,
  Camera, Sparkle,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import {
  WatchRecord, SubtitleCue, SubtitleWindow, CompanionPlanPoint,
  WatchContext, ConversationTurn,
} from '../types';
import { cinemaComplete } from '../src/utils/cinemaAdapters';

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function slugifyTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseSRTTime(t: string): number | null {
  const parts = t.replace(',', '.').split(':');
  if (parts.length !== 3) return null;
  const h = Number(parts[0]), m = Number(parts[1]), s = Number(parts[2]);
  if ([h, m, s].some(Number.isNaN)) return null;
  return h * 3600 + m * 60 + s;
}

function parseSRT(text: string): SubtitleCue[] {
  const blocks = text.trim().split(/\n\n+/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeLine = lines.find(l => l.includes(' --> '));
    if (!timeLine) continue;
    const idx = lines.indexOf(timeLine);
    const [startStr, endStr] = timeLine.split(' --> ').map(t => t.trim());
    const start = parseSRTTime(startStr);
    const end = parseSRTTime(endStr);
    const textContent = lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (start !== null && end !== null && textContent) {
      cues.push({ id: `cue-${cues.length}`, start, end, text: textContent });
    }
  }
  return cues;
}

function parseASS(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/Dialogue: \d+,(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),[^,]*,[^,]*,[^,]*,[^,]*,(.+)/);
    if (!match) continue;
    const startStr = match[1].replace(',', '.');
    const endStr = match[2].replace(',', '.');
    const parseTime = (t: string) => {
      const p = t.split(':');
      if (p.length !== 3) return null;
      return Number(p[0]) * 3600 + Number(p[1]) * 60 + Number(p[2]);
    };
    const start = parseTime(startStr);
    const end = parseTime(endStr);
    const text = match[3].replace(/\{[^}]+\}/g, '').replace(/\\N/g, '\n').replace(/\\h/g, ' ').trim();
    if (start !== null && end !== null && text) {
      cues.push({ id: `cue-${cues.length}`, start, end, text });
    }
  }
  return cues;
}

function parseSubtitles(text: string, fileName: string): SubtitleCue[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return parseASS(text);
  return parseSRT(text);
}

function getSubtitleWindow(cues: SubtitleCue[], currentTime: number): SubtitleWindow {
  const active = cues.find(c => currentTime >= c.start && currentTime <= c.end);
  const idx = cues.indexOf(active as SubtitleCue);
  return {
    active: active || undefined,
    previous: cues.slice(Math.max(0, idx - 2), idx),
    next: cues.slice(idx + 1, idx + 3),
  };
}

function getBilibiliEmbedUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const videoMatch = parsed.pathname.match(/\/video\/(BV[a-zA-Z0-9]+|av\d+)/i);
    if (!videoMatch) return rawUrl;
    const embed = new URL('https://player.bilibili.com/player.html');
    const vid = videoMatch[1];
    if (/^BV/i.test(vid)) embed.searchParams.set('bvid', vid);
    else embed.searchParams.set('aid', vid.replace(/^av/i, ''));
    embed.searchParams.set('page', parsed.searchParams.get('p') || '1');
    embed.searchParams.set('autoplay', '0');
    embed.searchParams.set('danmaku', '0');
    return embed.toString();
  } catch { return rawUrl; }
}

function buildBilibiliSearchUrl(keyword: string): string {
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

// ─── 截图 ────────────────────────────────────────────────────────────────

async function captureVideoFrame(video: HTMLVideoElement): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}

// ─── 存储 ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'sully_cinema_watch_records_v2';

function readRecords(): WatchRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch { return []; }
}

function writeRecords(records: WatchRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, 80)));
}

function listWatchRecords(): WatchRecord[] {
  return readRecords().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function saveWatchRecord(record: Partial<WatchRecord> & { title: string; sourceType: WatchRecord['sourceType']; sourceLabel: string; currentTime: number; duration: number }): WatchRecord {
  const records = readRecords();
  const id = slugifyTitle(record.title);
  const previous = records.find(r => r.id === id);
  const next: WatchRecord = {
    id,
    title: record.title,
    sourceType: record.sourceType,
    sourceLabel: record.sourceLabel,
    currentTime: record.currentTime ?? 0,
    duration: record.duration ?? 0,
    updatedAt: new Date().toISOString(),
    thumbnailDataUrl: record.thumbnailDataUrl ?? previous?.thumbnailDataUrl,
    subtitleFileName: record.subtitleFileName ?? previous?.subtitleFileName,
    subtitleCount: record.subtitleCount ?? previous?.subtitleCount,
    subtitleOffsetSeconds: record.subtitleOffsetSeconds ?? previous?.subtitleOffsetSeconds ?? 0,
    companionPlan: record.companionPlan ?? previous?.companionPlan,
    companionMode: record.companionMode || previous?.companionMode || 'natural',
    companionDensity: record.companionDensity || previous?.companionDensity || 'normal',
    triggeredPlanIds: record.triggeredPlanIds ?? previous?.triggeredPlanIds ?? [],
    ...record,
  };
  writeRecords([next, ...records.filter(r => r.id !== id)]);
  return next;
}

function removeWatchRecord(id: string): void {
  writeRecords(readRecords().filter(r => r.id !== id));
}

// ─── B站搜索 ────────────────────────────────────────────────────────────

interface BiliResult { bvid: string; title: string; author: string; pic: string; duration: string; arcurl: string; }

async function searchBilibili(keyword: string): Promise<BiliResult[]> {
  try {
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=1`);
    const data = await resp.json();
    const videoData = data?.data?.result?.find((r: any) => r.result_type === 'video');
    if (videoData?.video_list) {
      return videoData.video_list.slice(0, 12).map((v: any) => ({
        bvid: v.bvid,
        title: v.title.replace(/<[^>]+>/g, ''),
        author: v.author,
        pic: v.pic.startsWith('//') ? 'https:' + v.pic : v.pic,
        duration: v.duration,
        arcurl: v.arcurl,
      }));
    }
    return [];
  } catch { return []; }
}

// ─── 常量 ────────────────────────────────────────────────────────────────

const COMPANION_DENSITY_LABELS: Record<string, string> = {
  quiet: '安静', normal: '普通', talkative: '话多', breakdown: '拉片',
};
const COMPANION_MODE_LABELS: Record<string, string> = {
  active: '主动', natural: '自然', silent: '沉默',
};

// ─── 陪看计划生成（LLM） ───────────────────────────────────────────────

async function generateCompanionPlanLLM(
  cues: SubtitleCue[],
  density: string,
  duration: number,
  apiConfig: any,
  personaCore: string,
): Promise<CompanionPlanPoint[]> {
  if (!apiConfig?.apiKey || cues.length === 0) return [];

  // 把字幕切成每段最多 200 条，避免 prompt 过长
  const MAX_CUES = 200;
  const subtitleDigest = cues.slice(0, MAX_CUES)
    .map((c, i) => `${i + 1}. [${formatTime(c.start)}] ${c.text}`)
    .join('\n');

  const densityMap: Record<string, string> = {
    quiet: 'quiet — 极简，只在最关键的地方出声',
    normal: 'normal — 自然分布，关键段落出声',
    talkative: 'talkative — 活跃，常见面聊',
    breakdown: 'breakdown — 拆解模式，侧重镜头语言分析',
  };

  const request: CompanionRequest = {
    mode: 'plan',
    userMessage: `片长 ${Math.round(duration / 60)} 分钟，共 ${cues.length} 条字幕。\n\n字幕片段：\n${subtitleDigest}\n\n生成 ${densityMap[density] || 'normal'} 的陪看计划。`,
    watch: {
      title: '',
      currentTime: 0,
      duration,
      sourceType: 'local-file',
      subtitleWindow: { previous: [], next: [] },
    },
    personaCore,
  };

  try {
    const response = await cinemaComplete(
      'plan',
      request.userMessage,
      request.watch,
      { apiConfig, personaCore },
    );
    const text = response.text;

    // 解析 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const payload = JSON.parse(jsonMatch[0]);
    const triggers = payload?.triggers || [];
    return (Array.isArray(triggers) ? triggers : []).map((t: any, i: number) => ({
      id: t.id || `plan-${i}`,
      time: Number(t.time) || 0,
      subtitle: t.subtitle || '',
      companionHint: (t.bubble || t.companionHint || '').slice(0, 120),
      type: t.type || 'emotion',
      priority: t.priority || 'medium',
      delivery: t.delivery || 'auto',
    }));
  } catch {
    return [];
  }
}

// ─── 同步到 SullyOS 消息 ───────────────────────────────────────────────

async function syncToSullyOS(role: 'user' | 'assistant', content: string, charId: string | null, videoTitle: string): Promise<void> {
  if (!charId) return;
  try {
    await DB.saveMessage({
      charId,
      role,
      type: 'text',
      content: role === 'assistant' ? `【观影室】${videoTitle}：${content}` : content,
    });
  } catch (e) {
    console.warn('syncToSullyOS failed:', e);
  }
}

// ─── CompanionRequest type (local) ──────────────────────────────────────
interface CompanionRequest {
  mode?: 'cinema' | 'chat' | 'plan' | 'watchPrompt';
  userMessage: string;
  watch: WatchContext;
  personaCore: string;
}

// ─── 主组件 ──────────────────────────────────────────────────────────────

type ViewMode = 'home' | 'player';

interface ChatBubble {
  id: string;
  role: 'user' | 'companion';
  text: string;
  timestamp: number;
}

const CinemaApp: React.FC = () => {
  const { closeApp, characters, activeCharacterId, apiConfig } = useOS();
  const [view, setView] = useState<ViewMode>('home');
  const [records, setRecords] = useState<WatchRecord[]>([]);
  const [currentRecord, setCurrentRecord] = useState<WatchRecord | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoTitle, setVideoTitle] = useState<string>('');
  const [videoSourceType, setVideoSourceType] = useState<'local-file' | 'web-url'>('web-url');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [subtitleWindow, setSubtitleWindow] = useState<SubtitleWindow>({ previous: [], next: [] });
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  const [subtitleEnabled, setSubtitleEnabled] = useState(true);
  const [companionMode, setCompanionMode] = useState<'active' | 'natural' | 'silent'>('natural');
  const [companionDensity, setCompanionDensity] = useState<'quiet' | 'normal' | 'talkative' | 'breakdown'>('normal');
  const [companionPlan, setCompanionPlan] = useState<CompanionPlanPoint[]>([]);
  const [triggeredPlanIds, setTriggeredPlanIds] = useState<string[]>([]);
  const [chatBubbles, setChatBubbles] = useState<ChatBubble[]>([]);
  const [userInput, setUserInput] = useState('');
  const [companionLoading, setCompanionLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<BiliResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const userInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeChar = characters.find(c => c.id === activeCharacterId);
  const personaCore = activeChar?.personality_core || '你是萧漱，一个温柔活泼的AI伙伴。';

  // 加载记录
  useEffect(() => {
    setRecords(listWatchRecords());
  }, []);

  // 计时器
  useEffect(() => {
    if (view !== 'player') {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    timerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      setCurrentTime(v.currentTime);
    }, 500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [view]);

  // 字幕窗口更新
  useEffect(() => {
    setSubtitleWindow(getSubtitleWindow(subtitles, currentTime + subtitleOffset));
  }, [currentTime, subtitles, subtitleOffset]);

  // 自动陪看触发检查
  const checkCompanionTriggers = useCallback(async (time: number) => {
    if (companionMode === 'silent' || companionPlan.length === 0) return;
    for (const point of companionPlan) {
      if (triggeredPlanIds.includes(point.id)) continue;
      if (Math.abs(time - point.time) < 3) {
        setTriggeredPlanIds(prev => [...prev, point.id]);
        const bubbleText = point.companionHint || `这里... ${point.subtitle || ''}`;
        const newBubble: ChatBubble = { id: `bubble-${Date.now()}-${Math.random()}`, role: 'companion', text: bubbleText, timestamp: Date.now() };
        setChatBubbles(prev => [...prev, newBubble]);
        await syncToSullyOS('assistant', bubbleText, activeCharacterId, videoTitle);
        break;
      }
    }
  }, [companionPlan, triggeredPlanIds, companionMode, activeCharacterId, videoTitle]);

  // 计时器里加触发检查
  useEffect(() => {
    if (view !== 'player') return;
    const interval = setInterval(() => {
      checkCompanionTriggers(currentTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [view, currentTime, checkCompanionTriggers]);

  // ── 加载记录 ──
  const handleLoadRecord = (record: WatchRecord) => {
    setCurrentRecord(record);
    setVideoTitle(record.title);
    setCompanionMode((record.companionMode || 'natural') as any);
    setCompanionDensity((record.companionDensity || 'normal') as any);
    setCompanionPlan(record.companionPlan || []);
    setTriggeredPlanIds(record.triggeredPlanIds || []);
    setSubtitles([]);
    setSubtitleOffset(record.subtitleOffsetSeconds || 0);
    if (record.sourceType === 'web-url' && record.webEmbedUrl) {
      setVideoUrl(record.webEmbedUrl);
    } else if (record.sourceType === 'web-url' && record.webUrl) {
      setVideoUrl(getBilibiliEmbedUrl(record.webUrl));
    } else if (record.sourceType === 'local-file' && record.sourceLabel) {
      setVideoUrl('');
    }
    setVideoSourceType(record.sourceType);
    setChatBubbles([]);
    setView('player');
    setShowPlaylist(false);
    setTimeout(() => {
      if (record.currentTime > 0 && videoRef.current) {
        videoRef.current.currentTime = record.currentTime;
      }
    }, 500);
  };

  // ── 加载视频 ──
  const loadVideo = (title: string, embedUrl: string, sourceType: 'web-url' | 'local-file', extra: Partial<WatchRecord> = {}) => {
    const record = saveWatchRecord({
      title, sourceType, sourceLabel: title, currentTime: 0, duration: 0, ...extra,
    } as any);
    setCurrentRecord(record);
    setVideoUrl(embedUrl);
    setVideoTitle(title);
    setVideoSourceType(sourceType);
    setCompanionPlan([]); setTriggeredPlanIds([]); setSubtitles([]); setChatBubbles([]);
    setView('player'); setShowPlaylist(false);
  };

  // ── 上传本地视频 ──
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const title = file.name.replace(/\.[^.]+$/, '');
    loadVideo(title, url, 'local-file');
  };

  // ── B站链接/搜索 ──
  const handleUrlSubmit = () => {
    if (!searchQuery.trim()) return;
    const isUrl = isHttpUrl(searchQuery);
    const embedUrl = isUrl ? getBilibiliEmbedUrl(searchQuery) : buildBilibiliSearchUrl(searchQuery);
    const title = isUrl ? 'B站视频' : `B站 · ${searchQuery}`;
    loadVideo(title, embedUrl, 'web-url', {
      webUrl: isUrl ? searchQuery : undefined,
      webEmbedUrl: isUrl ? embedUrl : undefined,
      webPlatform: 'bilibili',
      webMode: isUrl ? 'embed' : 'page',
    });
    setSearchQuery('');
  };

  // ── B站搜索 ──
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    const results = await searchBilibili(searchQuery);
    setSearchResults(results);
    setSearching(false);
  };

  // ── 选择搜索结果 ──
  const handleSelectResult = (result: BiliResult) => {
    const embedUrl = `https://player.bilibili.com/player.html?bvid=${result.bvid}&autoplay=0&danmaku=0`;
    loadVideo(result.title, embedUrl, 'web-url', {
      webUrl: result.arcurl,
      webEmbedUrl: embedUrl,
      webPlatform: 'bilibili',
      webMode: 'embed',
    });
    setSearchResults([]); setSearchQuery('');
  };

  // ── 上传字幕 ──
  const handleSubtitleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const cues = parseSubtitles(text, file.name);
    setSubtitles(cues);
    if (currentRecord) {
      const updated = { ...currentRecord, subtitleFileName: file.name, subtitleCount: cues.length };
      const saved = saveWatchRecord(updated as any);
      setCurrentRecord(saved);
    }
  };

  // ── 生成陪看计划 ──
  const handleGeneratePlan = async () => {
    if (subtitles.length === 0 || !apiConfig) return;
    setGeneratingPlan(true);
    try {
      const plan = await generateCompanionPlanLLM(subtitles, companionDensity, duration, apiConfig, personaCore);
      if (plan.length > 0) {
        setCompanionPlan(plan);
        setTriggeredPlanIds([]);
        if (currentRecord) {
          const updated = saveWatchRecord({ ...currentRecord, companionPlan: plan, companionDensity, companionMode } as any);
          setCurrentRecord(updated);
        }
      }
    } finally {
      setGeneratingPlan(false);
    }
  };

  // ── 截图发给AI ──
  const handleCaptureAndAsk = async (question?: string) => {
    if (!activeCharacterId || !apiConfig) return;
    const video = videoRef.current;
    if (!video) return;
    const screenshotDataUrl = await captureVideoFrame(video);
    if (!screenshotDataUrl) return;

    const watchCtx: WatchContext = {
      title: videoTitle,
      currentTime,
      duration,
      sourceType: videoSourceType,
      activeSubtitle: subtitleWindow.active,
      subtitleWindow,
      screenshotDataUrl,
    };

    const msg = question || '这个画面你在想什么？';
    setChatBubbles(prev => [...prev, { id: `bubble-${Date.now()}`, role: 'user', text: msg, timestamp: Date.now() }]);
    setCompanionLoading(true);
    setStreamingText('');

    try {
      const response = await cinemaComplete('cinema', msg, watchCtx, {
        apiConfig,
        personaCore,
        activeCharacterId,
      });

      // 流式输出
      if (response.text) {
        const replyBubble: ChatBubble = { id: `bubble-${Date.now()}`, role: 'companion', text: response.text, timestamp: Date.now() };
        setChatBubbles(prev => [...prev, replyBubble]);
        await syncToSullyOS('assistant', response.text, activeCharacterId, videoTitle);
      }
    } catch (e: any) {
      const errBubble: ChatBubble = { id: `bubble-${Date.now()}`, role: 'companion', text: `出错：${e.message}`, timestamp: Date.now() };
      setChatBubbles(prev => [...prev, errBubble]);
    } finally {
      setCompanionLoading(false);
      setStreamingText('');
    }
  };

  // ── 发送消息 ──
  const handleSendMessage = async () => {
    if (!userInput.trim() || companionLoading) return;
    const text = userInput.trim();
    const bubble: ChatBubble = { id: `bubble-${Date.now()}`, role: 'user', text, timestamp: Date.now() };
    setChatBubbles(prev => [...prev, bubble]);
    setUserInput('');
    await syncToSullyOS('user', text, activeCharacterId, videoTitle);

    // 截图
    const video = videoRef.current;
    let screenshotDataUrl: string | null = null;
    if (video) {
      screenshotDataUrl = await captureVideoFrame(video);
    }

    const watchCtx: WatchContext = {
      title: videoTitle,
      currentTime,
      duration,
      sourceType: videoSourceType,
      activeSubtitle: subtitleWindow.active,
      subtitleWindow,
      screenshotDataUrl: screenshotDataUrl || undefined,
    };

    setCompanionLoading(true);
    setStreamingText('');

    try {
      const response = await cinemaComplete('chat', text, watchCtx, {
        apiConfig,
        personaCore,
        activeCharacterId,
      });

      if (response.text) {
        const cb: ChatBubble = { id: `bubble-${Date.now()}`, role: 'companion', text: response.text, timestamp: Date.now() };
        setChatBubbles(prev => [...prev, cb]);
        await syncToSullyOS('assistant', response.text, activeCharacterId, videoTitle);
      }
    } catch (e: any) {
      const errBubble: ChatBubble = { id: `bubble-${Date.now()}`, role: 'companion', text: `出错：${e.message}`, timestamp: Date.now() };
      setChatBubbles(prev => [...prev, errBubble]);
    } finally {
      setCompanionLoading(false);
      setStreamingText('');
    }
  };

  // ── 播放器控制 ──
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (isPlaying) { v.pause(); setIsPlaying(false); }
    else { v.play().then(() => setIsPlaying(true)).catch(() => {}); }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (v.duration && duration === 0) setDuration(v.duration);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    setCurrentTime(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  };

  const handleVideoEnded = () => {
    setIsPlaying(false);
    if (currentRecord && videoRef.current) {
      const updated = saveWatchRecord({ ...currentRecord, currentTime: 0, duration: videoRef.current.duration || duration } as any);
      setCurrentRecord(updated);
    }
  };

  const handleCompanionModeChange = (mode: typeof companionMode) => {
    setCompanionMode(mode);
    if (currentRecord) saveWatchRecord({ ...currentRecord, companionMode: mode } as any);
  };

  const handleCompanionDensityChange = (density: typeof companionDensity) => {
    setCompanionDensity(density);
    if (currentRecord) saveWatchRecord({ ...currentRecord, companionDensity: density } as any);
  };

  const handleDeleteRecord = (id: string) => {
    removeWatchRecord(id);
    setRecords(listWatchRecords());
    if (currentRecord?.id === id) { setCurrentRecord(null); setView('home'); }
  };

  const handleSaveSubtitleOffset = () => {
    if (currentRecord) {
      const updated = saveWatchRecord({ ...currentRecord, subtitleOffsetSeconds: subtitleOffset } as any);
      setCurrentRecord(updated);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // HOME VIEW
  // ─────────────────────────────────────────────────────────────────────────
  if (view === 'home') {
    return (
      <div className="flex flex-col h-full bg-[#0f0f1a]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <FilmReel size={22} className="text-rose-400" />
            <span className="text-white font-bold text-lg">观影室</span>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowPlaylist(true)} className="p-2 rounded-full bg-white/10 text-white active:bg-white/20">
              <Playlist size={20} />
            </button>
            <button onClick={closeApp} className="p-2 rounded-full bg-white/10 text-white active:bg-white/20">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div className="px-4 py-3 flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center bg-white/10 rounded-2xl px-3 py-2.5">
              <MagnifyingGlass size={16} className="text-white/50 mr-2 shrink-0" />
              <input
                className="flex-1 bg-transparent text-white text-sm outline-none placeholder-white/40"
                placeholder="B站链接或关键词"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    if (isHttpUrl(searchQuery)) handleUrlSubmit();
                    else handleSearch();
                  }
                }}
              />
            </div>
            <button
              onClick={() => isHttpUrl(searchQuery) ? handleUrlSubmit() : handleSearch()}
              className="px-4 py-2.5 rounded-2xl bg-rose-500 text-white text-sm font-bold shrink-0 active:bg-rose-600"
              disabled={searching}
            >
              {searching ? '搜索中...' : '播放'}
            </button>
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div className="bg-white/5 rounded-2xl overflow-hidden">
              {searchResults.map(r => (
                <button key={r.bvid} onClick={() => handleSelectResult(r)}
                  className="w-full flex items-center gap-3 p-3 border-b border-white/5 hover:bg-white/10 text-left">
                  <img src={r.pic} alt={r.title} className="w-16 h-10 rounded-lg object-cover shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-xs font-medium line-clamp-2">{r.title}</p>
                    <p className="text-white/40 text-xs mt-0.5">{r.author} · {r.duration}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Upload local */}
          <label className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-dashed border-white/20 text-white/50 text-sm cursor-pointer hover:bg-white/5 active:bg-white/10">
            <Upload size={16} /><span>上传本地视频</span>
            <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>

        {/* Record list */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-white/50 text-xs font-medium uppercase tracking-wider">观影记录</span>
            <span className="text-white/30 text-xs">{records.length} 部</span>
          </div>
          {records.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-white/25">
              <FilmReel size={48} />
              <p className="mt-3 text-sm">还没有看过任何视频</p>
              <p className="text-xs mt-1 text-white/20">搜索B站或上传本地视频开始吧</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {records.map(record => {
                const progress = record.duration > 0 ? Math.min(100, (record.currentTime / record.duration) * 100) : 0;
                return (
                  <div key={record.id}
                    className="flex items-center gap-3 p-3 rounded-2xl bg-white/5 hover:bg-white/10 cursor-pointer active:bg-white/15"
                    onClick={() => handleLoadRecord(record)}>
                    <div className="w-14 h-10 rounded-lg bg-rose-500/20 flex items-center justify-center shrink-0 overflow-hidden">
                      {record.thumbnailDataUrl
                        ? <img src={record.thumbnailDataUrl} alt="" className="w-full h-full object-cover" />
                        : record.sourceType === 'web-url'
                          ? <Export size={18} className="text-rose-300" />
                          : <Video size={18} className="text-rose-300" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{record.title}</p>
                      <p className="text-white/40 text-xs mt-0.5">
                        {formatTime(record.currentTime)} / {formatTime(record.duration) || '--:--'}
                        {record.companionPlan?.length ? ` · ${record.companionPlan.length}个陪看点` : ''}
                      </p>
                      <div className="mt-1 h-0.5 bg-white/10 rounded-full">
                        <div className="h-full bg-rose-500 rounded-full" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); handleDeleteRecord(record.id); }}
                      className="p-1.5 rounded-full text-white/25 hover:text-red-400 hover:bg-red-400/10 shrink-0">
                      <Trash size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Playlist modal */}
        {showPlaylist && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-20 flex items-end">
            <div className="w-full bg-[#1a1a2e] rounded-t-3xl p-4 pb-8 max-h-[70vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                <span className="text-white font-bold">观影记录 ({records.length})</span>
                <button onClick={() => setShowPlaylist(false)} className="text-white/60"><X size={20} /></button>
              </div>
              {records.length === 0 ? (
                <p className="text-white/30 text-center py-8 text-sm">还没有记录</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {records.map(record => (
                    <button key={record.id}
                      onClick={() => { handleLoadRecord(record); setShowPlaylist(false); }}
                      className="flex items-center gap-3 p-3 rounded-2xl bg-white/5 hover:bg-white/10 text-left w-full">
                      <Video size={20} className="text-rose-300 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm truncate">{record.title}</p>
                        <p className="text-white/40 text-xs">{new Date(record.updatedAt).toLocaleDateString()}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PLAYER VIEW
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-black text-white overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 right-0 z-10">
        <button onClick={() => setView('home')} className="p-2 rounded-full bg-white/10 active:bg-white/20">
          <CaretLeft size={20} />
        </button>
        <span className="text-white text-sm font-medium flex-1 text-center truncate mx-2">{videoTitle}</span>
        <button onClick={() => setShowSettings(true)} className="p-2 rounded-full bg-white/10 active:bg-white/20">
          <GearSix size={18} />
        </button>
      </div>

      {/* Video area */}
      <div className="flex-1 relative flex items-center justify-center bg-black min-h-0">
        {videoSourceType === 'web-url' && videoUrl ? (
          <iframe ref={iframeRef} src={videoUrl} className="w-full h-full" allow="autoplay; fullscreen" frameBorder={0} allowFullScreen scrolling="no" />
        ) : videoSourceType === 'local-file' && videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            className="max-w-full max-h-full"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={() => { if (videoRef.current) setDuration(videoRef.current.duration); }}
            onEnded={handleVideoEnded}
            onClick={togglePlay}
          />
        ) : (
          <div className="flex flex-col items-center text-white/30">
            <Video size={48} /><p className="mt-2 text-sm">暂无视频</p>
          </div>
        )}

        {/* Chat bubbles */}
        <div className="absolute bottom-16 left-0 right-0 flex flex-col gap-1.5 px-4 pointer-events-none">
          {chatBubbles.slice(-5).map(bubble => (
            <div key={bubble.id}
              className={`max-w-[78%] px-3 py-2 rounded-2xl text-sm pointer-events-auto backdrop-blur-md ${
                bubble.role === 'companion'
                  ? 'bg-rose-500/85 text-white self-start rounded-bl-md'
                  : 'bg-white/15 text-white/90 self-end rounded-br-md'
              }`}>
              {bubble.text}
              {bubble.id === streamingText && companionLoading && <span className="ml-1 animate-pulse">▌</span>}
            </div>
          ))}
        </div>

        {/* Play button overlay for local video */}
        {videoSourceType === 'local-file' && videoUrl && !isPlaying && (
          <button onClick={togglePlay} className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-16 h-16 rounded-full bg-white/15 backdrop-blur flex items-center justify-center">
              <PlayCircle size={40} className="text-white" />
            </div>
          </button>
        )}

        {/* Capture button */}
        {videoSourceType === 'local-file' && (
          <button
            onClick={() => handleCaptureAndAsk()}
            className="absolute top-12 right-4 p-2 rounded-full bg-black/50 backdrop-blur text-white/70 hover:text-white active:bg-black/70"
            title="截取当前画面问萧漱"
          >
            <Camera size={18} />
          </button>
        )}
      </div>

      {/* Bottom controls */}
      <div className="bg-gradient-to-t from-black/90 to-transparent px-4 pt-4 pb-4 space-y-2">
        {/* Subtitles */}
        {subtitleEnabled && subtitleWindow.active && (
          <div className="text-center text-sm text-white/90 leading-relaxed px-4">
            {subtitleWindow.previous.map(c => <p key={c.id} className="text-white/35 text-xs">{c.text}</p>)}
            <p className="text-white font-medium">{subtitleWindow.active.text}</p>
            {subtitleWindow.next.map(c => <p key={c.id} className="text-white/35 text-xs">{c.text}</p>)}
          </div>
        )}

        {/* Progress bar */}
        <div className="flex items-center gap-2">
          <span className="text-white/40 text-xs w-10 text-right">{formatTime(currentTime)}</span>
          <input type="range" min={0} max={duration || 100} value={currentTime}
            onChange={handleSeek} className="flex-1 accent-rose-500 h-1" />
          <span className="text-white/40 text-xs w-10">{formatTime(duration)}</span>
        </div>

        {/* Control buttons */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - 10); }}
              className="p-2 text-white/60 active:text-white"><SkipBack size={18} /></button>
            {videoSourceType === 'local-file' && (
              <button onClick={togglePlay} className="p-2 text-white/60 active:text-white">
                {isPlaying ? <Pause size={22} /> : <PlayCircle size={22} />}
              </button>
            )}
            <button onClick={() => { const v = videoRef.current; if (v) v.currentTime = v.currentTime + 10; }}
              className="p-2 text-white/60 active:text-white"><SkipForward size={18} /></button>
            <button onClick={() => setSubtitleEnabled(e => !e)}
              className={`p-2 ${subtitleEnabled ? 'text-rose-400' : 'text-white/30'}`}><ClosedCaptioning size={18} /></button>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowPlaylist(true)} className="p-2 text-white/60 active:text-white"><Playlist size={18} /></button>
            <button onClick={() => setShowSettings(true)} className="p-2 text-white/60 active:text-white"><GearSix size={18} /></button>
          </div>
        </div>

        {/* Companion mode pills */}
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-white/30">陪看:</span>
          {(['active', 'natural', 'silent'] as const).map(m => (
            <button key={m} onClick={() => handleCompanionModeChange(m)}
              className={`px-2 py-0.5 rounded-full text-xs ${companionMode === m ? 'bg-rose-500 text-white' : 'bg-white/10 text-white/50'}`}>
              {COMPANION_MODE_LABELS[m]}
            </button>
          ))}
          <span className="text-white/25">|</span>
          <span className="text-white/40">{chatBubbles.filter(b => b.role === 'companion').length} 条</span>
          {companionPlan.length > 0 && (
            <>
              <span className="text-white/25">|</span>
              <span className="flex items-center gap-1 text-rose-400">
                <Sparkle size={10} />{companionPlan.length}个计划点
              </span>
            </>
          )}
        </div>
      </div>

      {/* Message input */}
      <div className="px-4 pb-4 bg-black/90">
        <div className="flex items-center gap-2 bg-white/10 rounded-2xl px-3 py-2">
          <ChatCircle size={15} className="text-white/40 shrink-0" />
          <input
            ref={userInputRef}
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder-white/40"
            placeholder={`跟萧漱聊 ${videoTitle}…`}
            value={userInput}
            onChange={e => setUserInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
          />
          <button onClick={handleSendMessage} disabled={!userInput.trim() || companionLoading}
            className="text-rose-400 disabled:text-white/30">
            {companionLoading ? (
              <div className="w-4 h-4 border border-rose-400 border-t-transparent rounded-full animate-spin" />
            ) : <PaperPlaneRight size={16} />}
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-20 flex items-end">
          <div className="w-full bg-[#1a1a2e] rounded-t-3xl p-4 pb-8 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <span className="text-white font-bold">观影设置</span>
              <button onClick={() => setShowSettings(false)} className="text-white/60"><X size={20} /></button>
            </div>

            {/* Subtitle offset */}
            <div className="space-y-1">
              <label className="text-white/50 text-xs">字幕偏移 (秒)</label>
              <div className="flex gap-2">
                <input type="number" step="0.1" value={subtitleOffset}
                  onChange={e => setSubtitleOffset(Number(e.target.value))}
                  className="flex-1 bg-white/10 rounded-xl px-3 py-2 text-white text-sm outline-none" />
                <button onClick={handleSaveSubtitleOffset}
                  className="px-3 py-2 bg-rose-500 rounded-xl text-white text-xs font-bold">保存</button>
              </div>
            </div>

            {/* Companion density */}
            <div className="space-y-1">
              <label className="text-white/50 text-xs">陪看密度</label>
              <div className="flex gap-2">
                {(['quiet', 'normal', 'talkative', 'breakdown'] as const).map(d => (
                  <button key={d} onClick={() => handleCompanionDensityChange(d)}
                    className={`flex-1 py-2 rounded-xl text-xs font-medium ${companionDensity === d ? 'bg-rose-500 text-white' : 'bg-white/10 text-white/60'}`}>
                    {COMPANION_DENSITY_LABELS[d]}
                  </button>
                ))}
              </div>
            </div>

            {/* Subtitle upload */}
            <div className="space-y-1">
              <label className="text-white/50 text-xs">字幕文件 (SRT / ASS)</label>
              <label className="flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-white/20 text-white/50 text-xs cursor-pointer hover:bg-white/5">
                <Upload size={14} /><span>上传字幕</span>
                <input type="file" accept=".srt,.ass,.ssa" className="hidden" onChange={handleSubtitleUpload} />
              </label>
              {subtitles.length > 0 && (
                <div className="flex items-center justify-between bg-white/5 rounded-xl px-3 py-2">
                  <span className="text-white/50 text-xs">{subtitles.length} 条字幕已加载</span>
                  <button
                    onClick={handleGeneratePlan}
                    disabled={generatingPlan}
                    className="px-3 py-1.5 bg-rose-500 rounded-xl text-white text-xs font-bold flex items-center gap-1"
                  >
                    {generatingPlan ? (
                      <><div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" /> 生成中...</>
                    ) : <><Sparkle size={10} /> 生成陪看计划</>}
                  </button>
                </div>
              )}
            </div>

            {/* Plan points */}
            {companionPlan.length > 0 && (
              <div className="space-y-1">
                <label className="text-white/50 text-xs">陪看计划 ({companionPlan.length}点)</label>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {companionPlan.map(point => (
                    <div key={point.id} className="flex items-start gap-2 bg-white/5 rounded-xl px-3 py-2">
                      <span className="text-rose-400 text-xs shrink-0 w-12">{formatTime(point.time)}</span>
                      <span className="text-white/70 text-xs flex-1 line-clamp-1">{point.companionHint}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Playlist modal in player */}
      {showPlaylist && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-20 flex items-end">
          <div className="w-full bg-[#1a1a2e] rounded-t-3xl p-4 pb-8 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <span className="text-white font-bold">观影记录</span>
              <button onClick={() => setShowPlaylist(false)} className="text-white/60"><X size={20} /></button>
            </div>
            <div className="space-y-2">
              {records.map(record => (
                <div key={record.id}
                  className={`flex items-center gap-3 p-3 rounded-2xl cursor-pointer ${
                    record.id === currentRecord?.id ? 'bg-rose-500/20' : 'bg-white/5 hover:bg-white/10'
                  }`}
                  onClick={() => { handleLoadRecord(record); setShowPlaylist(false); }}>
                  <Video size={20} className="text-rose-300 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm truncate">{record.title}</p>
                    <p className="text-white/40 text-xs">
                      {record.companionPlan?.length ? `${record.companionPlan.length}个陪看点 · ` : ''}
                      {new Date(record.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button onClick={e => { e.stopPropagation(); handleDeleteRecord(record.id); }}
                    className="p-1 text-white/30 hover:text-red-400"><Trash size={14} /></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CinemaApp;
