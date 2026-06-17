import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FilmReel, PlayCircle, Pause, SkipBack, SkipForward,
  Playlist, MagnifyingGlass, GearSix, Upload,
  X, Export, ClosedCaptioning, Trash, Clock, CheckCircle,
  ChatCircle, Video, PaperPlaneRight, CaretLeft, CaretRight,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import {
  WatchRecord, SubtitleCue, SubtitleWindow, CompanionPlanPoint,
  CompanionRequest, CompanionResponse, ConversationTurn,
  SourceType,
} from '../types';

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
  if (fileName.toLowerCase().endsWith('.ass') || fileName.toLowerCase().endsWith('.ssa')) {
    return parseASS(text);
  }
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

const STORAGE_KEY = 'sully_cinema_watch_records_v1';

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

function saveWatchRecord(record: Omit<WatchRecord, 'id' | 'updatedAt'>): WatchRecord {
  const records = readRecords();
  const id = slugifyTitle(record.title);
  const previous = records.find(r => r.id === id);
  const next: WatchRecord = {
    ...previous, ...record,
    thumbnailDataUrl: record.thumbnailDataUrl || previous?.thumbnailDataUrl,
    subtitleFileName: record.subtitleFileName || previous?.subtitleFileName,
    subtitleCount: record.subtitleCount || previous?.subtitleCount,
    subtitleOffsetSeconds: record.subtitleOffsetSeconds ?? previous?.subtitleOffsetSeconds,
    companionPlan: record.companionPlan ?? previous?.companionPlan,
    companionMode: record.companionMode || previous?.companionMode || 'natural',
    companionDensity: record.companionDensity || previous?.companionDensity || 'normal',
    triggeredPlanIds: record.triggeredPlanIds ?? previous?.triggeredPlanIds ?? [],
    id,
    updatedAt: new Date().toISOString(),
  };
  writeRecords([next, ...records.filter(r => r.id !== id)]);
  return next;
}

function removeWatchRecord(id: string): void {
  writeRecords(readRecords().filter(r => r.id !== id));
}

const COMPANION_DENSITY_LABELS: Record<string, string> = {
  quiet: '安静', normal: '普通', talkative: '话多', breakdown: '拉片',
};
const COMPANION_MODE_LABELS: Record<string, string> = {
  active: '主动', natural: '自然', silent: '沉默',
};

function generateCompanionPlan(cues: SubtitleCue[], density: string, duration: number): CompanionPlanPoint[] {
  const countByDensity: Record<string, number> = { quiet: 8, normal: 14, talkative: 22, breakdown: 18 };
  const targetCount = countByDensity[density] || 14;
  if (cues.length === 0) return [];
  const interval = Math.max(1, Math.floor(cues.length / targetCount));
  return cues.filter((_, i) => i % interval === 0).slice(0, targetCount).map((cue, i) => ({
    id: `plan-${i}`, time: cue.start, subtitle: cue.text,
    companionHint: cue.text.length > 40 ? '这里可以停一下，聊聊情绪和关系变化。' : '可以给一个短陪看气泡。',
    type: density === 'breakdown' ? 'observe' : 'emotion',
    priority: i % 5 === 0 ? 'high' : 'medium', delivery: 'auto',
  }));
}

async function callCompanionLLM(
  mode: 'cinema' | 'chat' | 'plan', userMessage: string,
  watchCtx: { title: string; currentTime: number; subtitleWindow: SubtitleWindow },
  apiConfig: any, activeCharacterId: string | null, personaCore: string,
): Promise<string> {
  if (!activeCharacterId || !apiConfig) return '';
  const sub = watchCtx.subtitleWindow.active
    ? `[${formatTime(watchCtx.subtitleWindow.active.start)}] ${watchCtx.subtitleWindow.active.text}`
    : '';
  const systemPrompt = mode === 'plan'
    ? `你是一个影视陪看助手。根据字幕生成陪看触发点，包含：时间、字幕、评论。要求简短自然。`
    : `你正在和用户一起看电影《${watchCtx.title}》，进度 ${formatTime(watchCtx.currentTime)}。${sub ? `当前字幕：${sub}` : ''}\n\n以简短自然的方式评论，保持角色人格。`;
  try {
    const resp = await fetch(apiConfig.endpoint || 'https://api.minimaxi.chat/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify({
        model: apiConfig.model || 'minimax-medium',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7, max_tokens: 256,
      }),
    });
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch { return ''; }
}

async function syncToSullyOS(role: 'user' | 'assistant', content: string, charId: string | null, videoTitle: string): Promise<void> {
  if (!charId) return;
  try {
    await DB.saveMessage({
      charId, role, type: 'text',
      content: role === 'assistant' ? `【观影室】${videoTitle}：${content}` : content,
    });
  } catch (e) { console.warn('syncToSullyOS failed:', e); }
}

interface BiliResult { bvid: string; title: string; author: string; pic: string; duration: string; arcurl: string; }

async function searchBilibili(keyword: string): Promise<BiliResult[]> {
  try {
    const resp = await fetch(
      `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=1`
    );
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

type ViewMode = 'home' | 'player';
interface ChatBubble { id: string; role: 'user' | 'companion'; text: string; timestamp: number; }

const CinemaApp: React.FC = () => {
  const { closeApp, characters, activeCharacterId, apiConfig } = useOS();
  const [view, setView] = useState<ViewMode>('home');
  const [records, setRecords] = useState<WatchRecord[]>([]);
  const [currentRecord, setCurrentRecord] = useState<WatchRecord | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoTitle, setVideoTitle] = useState<string>('');
  const [videoSourceType, setVideoSourceType] = useState<SourceType>('web-url');
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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<BiliResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const userInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeChar = characters.find(c => c.id === activeCharacterId);

  useEffect(() => { setRecords(listWatchRecords()); }, []);

  // Video timer tick
  useEffect(() => {
    if (view !== 'player') {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    timerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      setCurrentTime(v.currentTime);
      checkCompanionTriggers(v.currentTime);
    }, 500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [view, isPlaying, companionPlan, triggeredPlanIds, companionMode]);

  useEffect(() => {
    setSubtitleWindow(getSubtitleWindow(subtitles, currentTime + subtitleOffset));
  }, [currentTime, subtitles, subtitleOffset]);

  const checkCompanionTriggers = useCallback(async (time: number) => {
    if (companionMode === 'silent') return;
    for (const point of companionPlan) {
      if (triggeredPlanIds.includes(point.id)) continue;
      if (Math.abs(time - point.time) < 3) {
        setTriggeredPlanIds(prev => [...prev, point.id]);
        const bubbleText = point.companionHint || `这里... ${point.subtitle || ''}`;
        const newBubble: ChatBubble = { id: `bubble-${Date.now()}`, role: 'companion', text: bubbleText, timestamp: Date.now() };
        setChatBubbles(prev => [...prev, newBubble]);
        await syncToSullyOS('assistant', bubbleText, activeCharacterId, videoTitle);
        break;
      }
    }
  }, [companionPlan, triggeredPlanIds, companionMode, activeCharacterId, videoTitle]);

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
    } else {
      setVideoUrl('');
    }
    setVideoSourceType(record.sourceType);
    setChatBubbles([]);
    setView('player');
    setShowPlaylist(false);
    if (record.currentTime > 0) {
      setTimeout(() => { if (videoRef.current) videoRef.current.currentTime = record.currentTime; }, 500);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const title = file.name.replace(/\.[^.]+$/, '');
    setVideoUrl(url);
    setVideoTitle(title);
    setVideoSourceType('local-file');
    const record = saveWatchRecord({ title, sourceType: 'local-file', sourceLabel: file.name, currentTime: 0, duration: 0 });
    setCurrentRecord(record);
    setCompanionPlan([]); setTriggeredPlanIds([]); setSubtitles([]); setChatBubbles([]);
    setView('player'); setShowPlaylist(false);
  };

  const handleUrlSubmit = () => {
    if (!searchQuery.trim()) return;
    let embedUrl: string;
    const isUrl = isHttpUrl(searchQuery);
    if (isUrl) {
      embedUrl = getBilibiliEmbedUrl(searchQuery);
    } else {
      embedUrl = buildBilibiliSearchUrl(searchQuery);
    }
    const title = isUrl ? `B站视频` : `B站 · ${searchQuery}`;
    const record = saveWatchRecord({
      title, sourceType: 'web-url', sourceLabel: searchQuery,
      webUrl: isUrl ? searchQuery : undefined,
      webEmbedUrl: isUrl ? embedUrl : undefined,
      webPlatform: 'bilibili', webMode: isUrl ? 'embed' : 'page',
      currentTime: 0, duration: 0,
    });
    setCurrentRecord(record);
    setVideoUrl(embedUrl);
    setVideoTitle(title);
    setVideoSourceType('web-url');
    setCompanionPlan([]); setTriggeredPlanIds([]); setSubtitles([]); setChatBubbles([]);
    setView('player'); setShowPlaylist(false);
    setSearchQuery('');
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    const results = await searchBilibili(searchQuery);
    setSearchResults(results);
    setSearching(false);
  };

  const handleSelectResult = (result: BiliResult) => {
    const embedUrl = `https://player.bilibili.com/player.html?bvid=${result.bvid}&autoplay=0&danmaku=0`;
    const record = saveWatchRecord({
      title: result.title, sourceType: 'web-url', sourceLabel: result.title,
      webUrl: result.arcurl, webEmbedUrl: embedUrl,
      webPlatform: 'bilibili', webMode: 'embed', currentTime: 0, duration: 0,
    });
    setCurrentRecord(record);
    setVideoUrl(embedUrl);
    setVideoTitle(result.title);
    setVideoSourceType('web-url');
    setCompanionPlan([]); setTriggeredPlanIds([]); setSubtitles([]); setChatBubbles([]);
    setView('player'); setShowPlaylist(false);
    setSearchResults([]); setSearchQuery('');
  };

  const handleSubtitleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const cues = parseSubtitles(text, file.name);
    setSubtitles(cues);
    if (currentRecord) {
      const updated = { ...currentRecord, subtitleFileName: file.name, subtitleCount: cues.length };
      const saved = saveWatchRecord(updated);
      setCurrentRecord(saved);
    }
  };

  const handleGeneratePlan = () => {
    if (subtitles.length === 0) return;
    const plan = generateCompanionPlan(subtitles, companionDensity, duration);
    setCompanionPlan(plan);
    setTriggeredPlanIds([]);
    if (currentRecord) {
      const updated = saveWatchRecord({ ...currentRecord, companionPlan: plan, companionDensity, companionMode, triggeredPlanIds: [] });
      setCurrentRecord(updated);
    }
  };

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
      saveWatchRecord({ ...currentRecord, currentTime: 0, duration: videoRef.current.duration || duration });
    }
  };

  const handleSendMessage = async () => {
    if (!userInput.trim() || companionLoading) return;
    const text = userInput.trim();
    const bubble: ChatBubble = { id: `bubble-${Date.now()}`, role: 'user', text, timestamp: Date.now() };
    setChatBubbles(prev => [...prev, bubble]);
    setUserInput('');
    await syncToSullyOS('user', text, activeCharacterId, videoTitle);
    setCompanionLoading(true);
    try {
      const reply = await callCompanionLLM('chat', text, { title: videoTitle, currentTime, subtitleWindow }, apiConfig, activeCharacterId, activeChar?.personality_core || '');
      if (reply) {
        const cb: ChatBubble = { id: `bubble-${Date.now()}`, role: 'companion', text: reply, timestamp: Date.now() };
        setChatBubbles(prev => [...prev, cb]);
        await syncToSullyOS('assistant', reply, activeCharacterId, videoTitle);
      }
    } finally { setCompanionLoading(false); }
  };

  const handleCompanionModeChange = (mode: typeof companionMode) => {
    setCompanionMode(mode);
    if (currentRecord) saveWatchRecord({ ...currentRecord, companionMode: mode });
  };

  const handleDeleteRecord = (id: string) => {
    removeWatchRecord(id);
    setRecords(listWatchRecords());
    if (currentRecord?.id === id) { setCurrentRecord(null); setView('home'); }
  };

  // ── HOME VIEW ──
  if (view === 'home') {
    return (
      <div className="flex flex-col h-full bg-[#0f0f1a]">
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

        <div className="px-4 py-3 flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center bg-white/10 rounded-2xl px-3 py-2.5">
              <MagnifyingGlass size={16} className="text-white/50 mr-2 shrink-0" />
              <input className="flex-1 bg-transparent text-white text-sm outline-none placeholder-white/40"
                placeholder="B站链接或关键词" value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { if (isHttpUrl(searchQuery)) handleUrlSubmit(); else handleSearch(); } }} />
            </div>
            <button onClick={() => isHttpUrl(searchQuery) ? handleUrlSubmit() : handleSearch()}
              className="px-4 py-2.5 rounded-2xl bg-rose-500 text-white text-sm font-bold shrink-0 active:bg-rose-600" disabled={searching}>
              {searching ? '搜索中...' : '播放'}
            </button>
          </div>

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

          <label className="flex items-center justify-center gap-2 py-3 rounded-2xl border border-dashed border-white/20 text-white/50 text-sm cursor-pointer hover:bg-white/5 active:bg-white/10">
            <Upload size={16} /><span>上传本地视频</span>
            <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
          </label>
        </div>

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
                      {record.thumbnailDataUrl ? (
                        <img src={record.thumbnailDataUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        record.sourceType === 'web-url'
                          ? <Export size={18} className="text-rose-300" />
                          : <Video size={18} className="text-rose-300" />
                      )}
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

  // ── PLAYER VIEW ──
  return (
    <div className="flex flex-col h-full bg-black text-white overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent absolute top-0 left-0 right-0 z-10">
        <button onClick={() => setView('home')} className="p-2 rounded-full bg-white/10 active:bg-white/20">
          <CaretLeft size={20} />
        </button>
        <span className="text-white text-sm font-medium flex-1 text-center truncate mx-2">{videoTitle}</span>
        <button onClick={() => setShowSettings(true)} className="p-2 rounded-full bg-white/10 active:bg-white/20">
          <GearSix size={18} />
        </button>
      </div>

      <div className="flex-1 relative flex items-center justify-center bg-black min-h-0">
        {videoSourceType === 'web-url' && videoUrl ? (
          <iframe src={videoUrl} className="w-full h-full" allow="autoplay; fullscreen" frameBorder={0} allowFullScreen scrolling="no" />
        ) : videoSourceType === 'local-file' && videoUrl ? (
          <video ref={videoRef} src={videoUrl} className="max-w-full max-h-full" onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={() => { if (videoRef.current) setDuration(videoRef.current.duration); }}
            onEnded={handleVideoEnded} onClick={togglePlay} />
        ) : (
          <div className="flex flex-col items-center text-white/30">
            <Video size={48} /><p className="mt-2 text-sm">暂无视频</p>
          </div>
        )}

        <div className="absolute bottom-16 left-0 right-0 flex flex-col gap-1.5 px-4 pointer-events-none">
          {chatBubbles.slice(-5).map(bubble => (
            <div key={bubble.id}
              className={`max-w-[78%] px-3 py-2 rounded-2xl text-sm pointer-events-auto backdrop-blur-md ${
                bubble.role === 'companion'
                  ? 'bg-rose-500/85 text-white self-start rounded-bl-md'
                  : 'bg-white/15 text-white/90 self-end rounded-br-md'
              }`}>
              {bubble.text}
            </div>
          ))}
        </div>

        {videoSourceType === 'local-file' && videoUrl && !isPlaying && (
          <button onClick={togglePlay} className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-16 h-16 rounded-full bg-white/15 backdrop-blur flex items-center justify-center">
              <PlayCircle size={40} className="text-white" />
            </div>
          </button>
        )}
      </div>

      <div className="bg-gradient-to-t from-black/90 to-transparent px-4 pt-4 pb-4 space-y-2">
        {subtitleEnabled && subtitleWindow.active && (
          <div className="text-center text-sm text-white/90 leading-relaxed px-4">
            {subtitleWindow.previous.map(c => <p key={c.id} className="text-white/35 text-xs">{c.text}</p>)}
            <p className="text-white font-medium">{subtitleWindow.active.text}</p>
            {subtitleWindow.next.map(c => <p key={c.id} className="text-white/35 text-xs">{c.text}</p>)}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-white/40 text-xs w-10 text-right">{formatTime(currentTime)}</span>
          <input type="range" min={0} max={duration || 100} value={currentTime}
            onChange={handleSeek} className="flex-1 accent-rose-500 h-1" />
          <span className="text-white/40 text-xs w-10">{formatTime(duration)}</span>
        </div>

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

        <div className="flex items-center gap-2 text-xs">
          <span className="text-white/30">陪看:</span>
          {(['active', 'natural', 'silent'] as const).map(m => (
            <button key={m} onClick={() => handleCompanionModeChange(m)}
              className={`px-2 py-0.5 rounded-full text-xs ${companionMode === m ? 'bg-rose-500 text-white' : 'bg-white/10 text-white/50'}`}>
              {COMPANION_MODE_LABELS[m]}
            </button>
          ))}
          <span className="text-white/25">|</span>
          <span className="text-white/40">{chatBubbles.filter(b => b.role === 'companion').length} 条</span>
        </div>
      </div>

      <div className="px-4 pb-4 bg-black/90">
        <div className="flex items-center gap-2 bg-white/10 rounded-2xl px-3 py-2">
          <ChatCircle size={15} className="text-white/40 shrink-0" />
          <input ref={userInputRef} className="flex-1 bg-transparent text-white text-sm outline-none placeholder-white/40"
            placeholder={`跟萧漱聊 ${videoTitle}…`} value={userInput}
            onChange={e => setUserInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSendMessage()} />
          <button onClick={handleSendMessage} disabled={!userInput.trim() || companionLoading}
            className="text-rose-400 disabled:text-white/30">
            {companionLoading ? (
              <div className="w-4 h-4 border border-rose-400 border-t-transparent rounded-full animate-spin" />
            ) : <PaperPlaneRight size={16} />}
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-20 flex items-end">
          <div className="w-full bg-[#1a1a2e] rounded-t-3xl p-4 pb-8 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-white font-bold">观影设置</span>
              <button onClick={() => setShowSettings(false)} className="text-white/60"><X size={20} /></button>
            </div>
            <div className="space-y-1">
              <label className="text-white/50 text-xs">字幕偏移 (秒)</label>
              <div className="flex gap-2">
                <input type="number" step="0.1" value={subtitleOffset}
                  onChange={e => setSubtitleOffset(Number(e.target.value))}
                  className="flex-1 bg-white/10 rounded-xl px-3 py-2 text-white text-sm outline-none" />
                <button onClick={() => { if (currentRecord) { const r = saveWatchRecord({ ...currentRecord, subtitleOffsetSeconds: subtitleOffset }); setCurrentRecord(r); } }}
                  className="px-3 py-2 bg-rose-500 rounded-xl text-white text-xs font-bold">保存</button>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-white/50 text-xs">陪看密度</label>
              <div className="flex gap-2">
                {(['quiet', 'normal', 'talkative', 'breakdown'] as const).map(d => (
                  <button key={d} onClick={() => setCompanionDensity(d)}
                    className={`flex-1 py-2 rounded-xl text-xs font-medium ${companionDensity === d ? 'bg-rose-500 text-white' : 'bg-white/10 text-white/60'}`}>
                    {COMPANION_DENSITY_LABELS[d]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-white/50 text-xs">字幕文件 (SRT / ASS)</label>
              <label className="flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-white/20 text-white/50 text-xs cursor-pointer hover:bg-white/5">
                <Upload size={14} /><span>上传字幕</span>
                <input type="file" accept=".srt,.ass,.ssa" className="hidden" onChange={handleSubtitleUpload} />
              </label>
              {subtitles.length > 0 && (
                <div className="flex items-center justify-between bg-white/5 rounded-xl px-3 py-2">
                  <span className="text-white/50 text-xs">{subtitles.length} 条字幕已加载</span>
                  <button onClick={handleGeneratePlan} className="px-3 py-1.5 bg-rose-500 rounded-xl text-white text-xs font-bold">
                    生成陪看计划
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
