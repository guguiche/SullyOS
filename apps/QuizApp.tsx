import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import Modal from '../components/os/Modal';

type QuizQuestion = {
  id: string;
  type: 'choice' | 'true_false' | 'fill_blank';
  question: string;
  options?: { label: string; isCorrect: boolean }[];
  answer?: string;       // for fill_blank
  explanation?: string;
};

type QuizSession = {
  id: string;
  createdAt: number;
  questions: QuizQuestion[];
  userAnswers: Record<string, string | number>;
  submitted: boolean;
  score: number;
};

// Demo question bank
const DEMO_QUESTIONS: QuizQuestion[] = [
  {
    id: '1', type: 'choice',
    question: 'Python中，用于定义函数的关键字是？',
    options: [
      { label: 'function', isCorrect: false },
      { label: 'def', isCorrect: true },
      { label: 'func', isCorrect: false },
      { label: 'define', isCorrect: false },
    ],
    explanation: 'Python使用 def 关键字来定义函数，例如：def my_func():',
  },
  {
    id: '2', type: 'true_false',
    question: 'JavaScript是一种弱类型语言。',
    options: [
      { label: '正确', isCorrect: true },
      { label: '错误', isCorrect: false },
    ],
    explanation: 'JavaScript是弱类型语言，变量类型可以自动转换，例如 "5" + 2 会得到 "52"。',
  },
  {
    id: '3', type: 'choice',
    question: '下列哪个数据结构具有先进后出（FILO）的特性？',
    options: [
      { label: '队列（Queue）', isCorrect: false },
      { label: '栈（Stack）', isCorrect: true },
      { label: '链表（Linked List）', isCorrect: false },
      { label: '哈希表（Hash Table）', isCorrect: false },
    ],
    explanation: '栈（Stack）是一种后进先出（LIFO）的数据结构，像叠盘子一样。',
  },
  {
    id: '4', type: 'fill_blank',
    question: '在HTTP请求方法中，通常用于提交表单数据的方法是。',
    answer: 'POST',
    explanation: 'GET用于获取资源，POST用于提交数据，PUT用于更新，DELETE用于删除。',
  },
  {
    id: '5', type: 'choice',
    question: 'Git中，将暂存区的内容提交到本地仓库的命令是？',
    options: [
      { label: 'git add', isCorrect: false },
      { label: 'git commit', isCorrect: true },
      { label: 'git push', isCorrect: false },
      { label: 'git pull', isCorrect: false },
    ],
    explanation: 'git add 将文件添加到暂存区，git commit 将暂存区内容提交到本地仓库。',
  },
  {
    id: '6', type: 'true_false',
    question: 'React是一个用于构建用户界面的JavaScript库。',
    options: [
      { label: '正确', isCorrect: true },
      { label: '错误', isCorrect: false },
    ],
    explanation: 'React是Facebook开发的开源JavaScript库，主要用于构建单页应用的前端视图层。',
  },
  {
    id: '7', type: 'choice',
    question: '数据库事务的ACID特性中，"I"代表什么？',
    options: [
      { label: '独立性（Isolation）', isCorrect: true },
      { label: '集成性（Integration）', isCorrect: false },
      { label: '索引（Index）', isCorrect: false },
      { label: '完整性（Integrity）', isCorrect: false },
    ],
    explanation: 'ACID = Atomicity（原子性）、Consistency（一致性）、Isolation（隔离性）、Durability（持久性）。',
  },
  {
    id: '8', type: 'fill_blank',
    question: 'CSS中用于实现Flex容器水平垂直居中的属性组合是：display: flex; justify-content: center; 。',
    answer: 'align-items',
    explanation: 'align-items: center 配合 justify-content: center 可以实现Flex容器中的完全居中。',
  },
  {
    id: '9', type: 'choice',
    question: 'TCP协议和UDP协议的主要区别是什么？',
    options: [
      { label: 'TCP更快速', isCorrect: false },
      { label: 'TCP面向连接，UDP无连接', isCorrect: true },
      { label: 'UDP可靠性更高', isCorrect: false },
      { label: '两者没有区别', isCorrect: false },
    ],
    explanation: 'TCP提供可靠连接（三次握手），UDP无连接但效率更高，适用于实时场景。',
  },
  {
    id: '10', type: 'true_false',
    question: '在Linux中，rm -rf / 命令是安全的，不会造成系统损坏。',
    options: [
      { label: '正确', isCorrect: false },
      { label: '错误', isCorrect: true },
    ],
    explanation: 'rm -rf / 会递归强制删除根目录下所有文件，会完全摧毁系统！绝不要执行！',
  },
];

const LETTERS = ['A', 'B', 'C', 'D'];

const QuizApp: React.FC = () => {
  const { closeApp } = useOS();
  const [mode, setMode] = useState<'home' | 'quiz' | 'result'>('home');
  const [selectedTypes, setSelectedTypes] = useState<QuizQuestion['type'][]>(['choice', 'true_false', 'fill_blank']);
  const [count, setCount] = useState(5);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [savedSessions, setSavedSessions] = useState<QuizSession[]>([]);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      const sessions = await DB.getAllQuizSessions();
      setSavedSessions(sessions.sort((a, b) => b.createdAt - a.createdAt));
    } catch (e) { /* ignore */ }
  };

  const shuffle = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);

  const startQuiz = () => {
    const filtered = DEMO_QUESTIONS.filter(q => selectedTypes.includes(q.type));
    const shuffled = shuffle(filtered);
    const picked = shuffled.slice(0, Math.min(count, shuffled.length)).map(q => {
      if (q.type === 'choice' || q.type === 'true_false') {
        return { ...q, options: shuffle(q.options!) };
      }
      return q;
    });
    setQuestions(picked);
    setAnswers({});
    setSubmitted(false);
    setCurrentIndex(0);
    setMode('quiz');
  };

  const selectOption = (qId: string, optIdx: number) => {
    if (submitted) return;
    setAnswers(prev => ({ ...prev, [qId]: optIdx }));
  };

  const fillAnswer = (qId: string, val: string) => {
    if (submitted) return;
    setAnswers(prev => ({ ...prev, [qId]: val }));
  };

  const submitCurrent = () => {
    setSubmitted(true);
  };

  const nextQ = () => {
    if (currentIndex < questions.length - 1) {
      setCurrentIndex(i => i + 1);
      setSubmitted(false);
    }
  };

  const prevQ = () => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1);
      setSubmitted(false);
    }
  };

  const finishQuiz = async () => {
    let score = 0;
    for (const q of questions) {
      const ans = answers[q.id];
      if (q.type === 'fill_blank') {
        if (ans?.toString().toLowerCase().trim() === q.answer?.toLowerCase().trim()) score++;
      } else {
        if (q.options?.[ans as number]?.isCorrect) score++;
      }
    }
    const session: QuizSession = {
      id: Date.now().toString(),
      createdAt: Date.now(),
      questions,
      userAnswers: answers,
      submitted: true,
      score,
    };
    await DB.saveQuizSession(session);
    await loadSessions();
    setMode('result');
  };

  const isCorrect = (q: QuizQuestion) => {
    const ans = answers[q.id];
    if (q.type === 'fill_blank') {
      return ans?.toString().toLowerCase().trim() === q.answer?.toLowerCase().trim();
    }
    return q.options?.[ans as number]?.isCorrect ?? false;
  };

  const answeredCount = Object.keys(answers).length;
  const q = questions[currentIndex];
  const pct = questions.length > 0 ? Math.round((Object.keys(answers).filter(id => isCorrect(questions.find(qq => qq.id === id)!)).length / questions.length) * 100) : 0;

  const toggleType = (t: QuizQuestion['type']) => {
    setSelectedTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  };

  const tagStyle = (t: QuizQuestion['type']) => {
    if (t === 'choice') return 'bg-purple-100 text-purple-700';
    if (t === 'true_false') return 'bg-green-100 text-green-700';
    return 'bg-amber-100 text-amber-700';
  };
  const tagText = (t: QuizQuestion['type']) => {
    if (t === 'choice') return '选择';
    if (t === 'true_false') return '判断';
    return '填空';
  };

  // ========== HOME ==========
  if (mode === 'home') {
    return (
      <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans">
        {/* Header */}
        <div className="h-[68px] bg-gradient-to-r from-pink-400 to-purple-500 flex items-end pb-3 px-5 shrink-0">
          <div className="flex justify-between items-center w-full">
            <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-white/20 active:scale-90 transition-transform">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="white" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
            </button>
            <span className="font-bold text-white text-lg tracking-wide">刷题</span>
            <div className="w-9" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* Quiz Setup Card */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-pink-100">
            <div className="text-sm font-bold text-slate-500 mb-4">题型</div>
            <div className="flex gap-2 flex-wrap mb-4">
              {(['choice', 'true_false', 'fill_blank'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${selectedTypes.includes(t) ? 'bg-gradient-to-r from-pink-400 to-purple-500 text-white shadow-md' : 'bg-slate-100 text-slate-500'}`}
                >
                  {t === 'choice' ? '📝 选择' : t === 'true_false' ? '✓✗ 判断' : '✏️ 填空'}
                </button>
              ))}
            </div>
            <div className="text-sm font-bold text-slate-500 mb-2">题目数量：{count} 题</div>
            <input
              type="range" min={3} max={10} value={count}
              onChange={e => setCount(Number(e.target.value))}
              className="w-full accent-pink-400"
            />
            <div className="flex justify-between text-xs text-slate-400 mt-1 mb-4">
              <span>3题</span><span>10题</span>
            </div>
            <button
              onClick={startQuiz}
              disabled={selectedTypes.length === 0}
              className="w-full py-3 bg-gradient-to-r from-pink-400 to-purple-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-200 active:scale-95 transition-all disabled:opacity-40"
            >
              开始答题 🎯
            </button>
          </div>

          {/* Past Sessions */}
          {savedSessions.length > 0 && (
            <div>
              <div className="text-sm font-bold text-slate-400 mb-3 uppercase tracking-widest">历史记录</div>
              <div className="space-y-2">
                {savedSessions.slice(0, 5).map(s => (
                  <div key={s.id} className="bg-white rounded-xl p-4 shadow-sm border border-slate-100 flex items-center gap-3">
                    <div className="text-2xl">
                      {s.score === s.questions.length ? '🎉' : s.score / s.questions.length >= 0.6 ? '😊' : '📚'}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-bold text-slate-700">
                        {s.score}/{s.questions.length} 正确
                      </div>
                      <div className="text-xs text-slate-400">
                        {new Date(s.createdAt).toLocaleDateString('zh-CN')}
                      </div>
                    </div>
                    <div className="text-sm font-bold text-pink-500">
                      {Math.round((s.score / s.questions.length) * 100)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ========== QUIZ ==========
  if (mode === 'quiz') {
    return (
      <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
        {/* Header */}
        <div className="h-[68px] bg-gradient-to-r from-pink-400 to-purple-500 flex items-end pb-3 px-5 shrink-0">
          <div className="flex justify-between items-center w-full">
            <button onClick={() => setMode('home')} className="p-2 -ml-2 rounded-full hover:bg-white/20 active:scale-90 transition-transform">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="white" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
            </button>
            <span className="font-bold text-white text-base">{currentIndex + 1} / {questions.length}</span>
            <button onClick={finishQuiz} disabled={answeredCount < questions.length} className="px-3 py-1 bg-white/20 hover:bg-white/30 text-white text-xs font-bold rounded-full disabled:opacity-40">
              交卷
            </button>
          </div>
          {/* Progress bar */}
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
            <div className="h-full bg-white transition-all" style={{ width: `${((currentIndex + 1) / questions.length) * 100}%` }} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-pink-100 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-xs font-bold px-2 py-1 rounded-full ${tagStyle(q.type)}`}>{tagText(q.type)}</span>
            </div>
            <div className="text-base font-medium text-slate-800 leading-relaxed">{q.question}</div>

            {/* Options */}
            {q.type !== 'fill_blank' && q.options && (
              <div className="mt-4 space-y-2">
                {q.options.map((opt, i) => {
                  const selected = answers[q.id] === i;
                  let cls = 'flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all';
                  if (submitted) {
                    if (opt.isCorrect) cls += ' border-green-400 bg-green-50';
                    else if (selected) cls += ' border-red-400 bg-red-50';
                    else cls += ' border-slate-100 bg-slate-50 opacity-60';
                  } else {
                    cls += selected ? ' border-pink-400 bg-pink-50' : ' border-slate-100 hover:border-pink-300';
                  }
                  return (
                    <div key={i} onClick={() => !submitted && selectOption(q.id, i)} className={cls}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${selected ? 'bg-pink-400 text-white' : 'bg-slate-100 text-slate-500'} ${submitted && opt.isCorrect ? 'bg-green-400 text-white' : ''} ${submitted && selected && !opt.isCorrect ? 'bg-red-400 text-white' : ''}`}>
                        {LETTERS[i]}
                      </div>
                      <div className="flex-1 text-sm font-medium text-slate-700">{opt.label}</div>
                      {submitted && opt.isCorrect && <span className="text-green-500 text-sm">✅</span>}
                      {submitted && selected && !opt.isCorrect && <span className="text-red-500 text-sm">❌</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Fill blank */}
            {q.type === 'fill_blank' && (
              <div className="mt-4">
                <input
                  value={(answers[q.id] as string) || ''}
                  onChange={e => fillAnswer(q.id, e.target.value)}
                  disabled={submitted}
                  placeholder="输入你的答案..."
                  className={`w-full p-3 rounded-xl border-2 text-sm outline-none transition-all ${submitted ? (answers[q.id]?.toString().toLowerCase().trim() === q.answer?.toLowerCase().trim() ? 'border-green-400 bg-green-50' : 'border-red-400 bg-red-50') : 'border-pink-200 focus:border-pink-400 bg-white'}`}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !submitted) submitCurrent();
                  }}
                />
                {submitted && (
                  <div className={`mt-2 p-3 rounded-xl text-sm ${answers[q.id]?.toString().toLowerCase().trim() === q.answer?.toLowerCase().trim() ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                    {answers[q.id]?.toString().toLowerCase().trim() === q.answer?.toLowerCase().trim() ? '✅ 正确！' : `❌ 正确答案：${q.answer}`}
                  </div>
                )}
              </div>
            )}

            {/* Explanation */}
            {submitted && q.explanation && (
              <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
                📖 {q.explanation}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Nav */}
        <div className="shrink-0 bg-white border-t border-slate-100 p-4 flex gap-3">
          {currentIndex > 0 ? (
            <button onClick={prevQ} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-all">
              ← 上一题
            </button>
          ) : <div className="flex-1" />}
          {!submitted ? (
            <button onClick={submitCurrent} disabled={answers[q.id] === undefined} className="flex-1 py-3 bg-gradient-to-r from-pink-400 to-purple-500 text-white font-bold rounded-2xl shadow-md disabled:opacity-40 active:scale-95 transition-all">
              确认答案
            </button>
          ) : currentIndex < questions.length - 1 ? (
            <button onClick={nextQ} className="flex-1 py-3 bg-gradient-to-r from-pink-400 to-purple-500 text-white font-bold rounded-2xl shadow-md active:scale-95 transition-all">
              下一题 →
            </button>
          ) : (
            <button onClick={finishQuiz} disabled={answeredCount < questions.length} className="flex-1 py-3 bg-gradient-to-r from-pink-400 to-purple-500 text-white font-bold rounded-2xl shadow-md disabled:opacity-40 active:scale-95 transition-all">
              交卷 ({answeredCount}/{questions.length})
            </button>
          )}
        </div>
      </div>
    );
  }

  // ========== RESULT ==========
  const score = questions.filter(q => isCorrect(q)).length;
  const pctScore = Math.round((score / questions.length) * 100);

  return (
    <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans">
      <div className="h-[68px] bg-gradient-to-r from-pink-400 to-purple-500 flex items-end pb-3 px-5 shrink-0">
        <div className="flex justify-between items-center w-full">
          <button onClick={() => setMode('home')} className="p-2 -ml-2 rounded-full hover:bg-white/20 active:scale-90 transition-transform">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="white" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
          </button>
          <span className="font-bold text-white text-lg tracking-wide">答题结果</span>
          <div className="w-9" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="text-center mb-6">
          <div className="text-6xl mb-3">
            {pctScore === 100 ? '🎉' : pctScore >= 80 ? '🥳' : pctScore >= 60 ? '😊' : '📚'}
          </div>
          <div className="text-4xl font-extrabold text-slate-800 mb-1">{score}/{questions.length}</div>
          <div className="text-lg font-bold text-pink-500">{pctScore}% 正确率</div>
          <div className="text-2xl mt-2">{pctScore === 100 ? '⭐⭐⭐' : pctScore >= 80 ? '⭐⭐' : pctScore >= 60 ? '⭐' : ''}</div>
        </div>

        <div className="space-y-3">
          {questions.map((qq, i) => (
            <div key={qq.id} className={`bg-white rounded-xl p-4 shadow-sm border-2 ${isCorrect(qq) ? 'border-green-200' : 'border-red-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-bold text-slate-400">第{i + 1}题</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${tagStyle(qq.type)}`}>{tagText(qq.type)}</span>
                <span className="ml-auto text-lg">{isCorrect(qq) ? '✅' : '❌'}</span>
              </div>
              <div className="text-sm font-medium text-slate-700 mb-1">{qq.question}</div>
              {qq.type === 'fill_blank' && !isCorrect(qq) && (
                <div className="text-xs text-slate-400 mt-1">正确答案：{qq.answer}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 bg-white border-t border-slate-100 p-4 flex gap-3">
        <button onClick={() => setMode('home')} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-all">
          返回首页
        </button>
        <button onClick={startQuiz} className="flex-1 py-3 bg-gradient-to-r from-pink-400 to-purple-500 text-white font-bold rounded-2xl shadow-md active:scale-95 transition-all">
          再来一轮 🔄
        </button>
      </div>
    </div>
  );
};

export default QuizApp;
