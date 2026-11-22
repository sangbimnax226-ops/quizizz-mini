import {
  FIREBASE_DB_URL,
  META_PATH,
  SET_QUESTIONS_PATH,
  REQUESTS_PATH,
  LEGACY_MULTI_PATH,
  LEGACY_SINGLE_PATH,
  OWNER_PIN_CODE as PIN_FROM_FB,
  isOwnerUnlocked,
  setOwnerUnlocked,
  getSavedRequestId,
  setSavedRequestId
} from './firebase.js';

const DB_BASE_URL = FIREBASE_DB_URL || 'https://quizizz-mini-shared-e3865-default-rtdb.asia-southeast1.firebasedatabase.app';
const META_ENDPOINT = META_PATH || '/quizizz_mini/sets_meta.json';
const SET_ENDPOINT = typeof SET_QUESTIONS_PATH === 'function'
  ? SET_QUESTIONS_PATH
  : (setId) => `/quizizz_mini/sets/${encodeURIComponent(setId)}.json`;
const REQUESTS_ENDPOINT = REQUESTS_PATH || '/quizizz_mini/access_requests.json';
const LEGACY_MULTI_ENDPOINT = LEGACY_MULTI_PATH || '/quizizz_mini/quiz_sets.json';
const LEGACY_SINGLE_ENDPOINT = LEGACY_SINGLE_PATH || '/quizizz_mini/shared_questions.json';
const OWNER_PIN_CODE = PIN_FROM_FB || '226';
const REQUEST_TIMEOUT_MS = 8000;

const GEMINI_STORAGE_KEY = 'quizizz_mini_gemini_api_key_v1';
const GEMINI_CONFIG = Object.freeze({
  model: 'gemini-3.8-flash',
  timeoutMs: 15000,
  maxOutputTokens: 520,
  temperature: 0.3
});

function buildFbUrl(path) {
  const clean = String(path || '').replace(/^\/+/, '').replace(/\.json$/i, '');
  return `${DB_BASE_URL}/${clean}.json`;
}

async function fbRequest(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(buildFbUrl(path), {
      ...options,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Kết nối Firebase quá thời gian chờ');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fbGet(path) {
  return await fbRequest(path, { cache: 'no-store' });
}

async function fbPut(path, data) {
  return await fbRequest(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function fbPatch(path, data) {
  return await fbRequest(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function fbPost(path, data) {
  return await fbRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function fbDelete(path) {
  return await fbRequest(path, { method: 'DELETE' });
}

function getGeminiApiKey() {
  try {
    return (localStorage.getItem(GEMINI_STORAGE_KEY) || '').trim();
  } catch (e) {
    return '';
  }
}

function setGeminiApiKey(key) {
  try {
    const clean = String(key || '').trim();
    if (clean) localStorage.setItem(GEMINI_STORAGE_KEY, clean);
    else localStorage.removeItem(GEMINI_STORAGE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

function validateGeminiKeyFormat(rawKey) {
  const trimmed = String(rawKey || '').trim();
  if (!trimmed) {
    return { ok: false, message: 'Hãy dán Gemini API Key trước khi lưu.' };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, message: 'API Key chứa khoảng trắng. Kiểm tra lại trước khi lưu.' };
  }
  if (trimmed.length < 20) {
    return { ok: false, message: 'API Key quá ngắn, có thể bị copy thiếu ký tự.' };
  }
  return { ok: true, value: trimmed };
}

function formatAiPlainText(rawText) {
  const safe = escapeHtml(String(rawText || '').trim());
  return safe
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-extrabold">$1</strong>')
    .replace(/\n{2,}/g, '</p><p class="mt-1.5">')
    .replace(/\n/g, '<br />');
}

function getSharedAiCacheKey(item) {
  const letters = ['A', 'B', 'C', 'D'];
  const options = Array.isArray(item.shuffledOptions)
    ? item.shuffledOptions
    : (item.options || []).map((text, i) => ({ text, isCorrect: i === item.correctIndex }));
  const userLabel = item.timedOut
    ? 'TIMEOUT'
    : (item.userChoiceIndex >= 0 && options[item.userChoiceIndex]
      ? `${letters[item.userChoiceIndex] || item.userChoiceIndex}:${options[item.userChoiceIndex].text}`
      : 'NONE');
  const correctText = options.find(o => o.isCorrect)?.text || '';
  return `${item.question}__${correctText}__${userLabel}`;
}

function buildQuestionContextPrompt(item, setName = '') {
  const letters = ['A', 'B', 'C', 'D'];
  const options = Array.isArray(item.shuffledOptions)
    ? item.shuffledOptions
    : (item.options || []).map((text, i) => ({ text, isCorrect: i === item.correctIndex }));

  const optLines = options.map((o, i) => {
    const tag = o.isCorrect ? ' [Đúng]' : '';
    return `${letters[i] || i + 1}. ${o.text}${tag}`;
  }).join('\n');

  const userLine = item.timedOut
    ? 'Hết giờ'
    : (item.userChoiceIndex >= 0 && options[item.userChoiceIndex]
      ? `${letters[item.userChoiceIndex] || item.userChoiceIndex + 1}. ${options[item.userChoiceIndex].text}`
      : 'Không rõ');

  const noteLine = item.explanation ? `Ghi chú sẵn: ${item.explanation}` : '';

  return [
    'Giải thích ngắn gọn, trọng tâm câu trắc nghiệm này bằng tiếng Việt:',
    setName ? `Đề: ${setName}` : '',
    `Câu: ${item.question}`,
    optLines,
    `Chọn: ${userLine} (${item.isCorrect ? 'Đúng' : 'Chưa đúng'})`,
    noteLine,
    'Nêu ngắn gọn: (1) Vì sao đáp án đúng chuẩn; (2) Điểm mấu chốt/bẫy ở lựa chọn của người học hoặc các đáp án còn lại.'
  ].filter(Boolean).join('\n');
}

function formatGeminiError(status, apiMsg) {
  if (status === 429) {
    const lower = String(apiMsg || '').toLowerCase();
    const isDaily = lower.includes('day') || lower.includes('rpd') || lower.includes('daily');
    if (isDaily) {
      return `Đã chạm hạn mức lượt gọi theo ngày (RPD) của gói miễn phí (${apiMsg}). Vui lòng chờ đến chu kỳ reset ngày.`;
    }
    return `Đã chạm giới hạn tốc độ gọi mỗi phút (RPM/TPM) của gói miễn phí (${apiMsg}). Thử lại sau 30–60 giây.`;
  }
  if (status === 400 || status === 403) {
    return `API Key không hợp lệ hoặc bị từ chối (${apiMsg}). Kiểm tra lại trong nút AI Key.`;
  }
  if (status === 404) {
    return `Model "${GEMINI_CONFIG.model}" không khả dụng trên dự án hiện tại (${apiMsg}).`;
  }
  return `Lỗi gọi Gemini API: ${apiMsg}`;
}

async function requestGeminiExplanation(promptText) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_CONFIG.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_CONFIG.timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: GEMINI_CONFIG.temperature,
          maxOutputTokens: GEMINI_CONFIG.maxOutputTokens
        }
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const apiMsg = data?.error?.message || `HTTP ${res.status}`;
      throw new Error(formatGeminiError(res.status, apiMsg));
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('').trim();
    if (!text) {
      throw new Error('Gemini không trả về nội dung giải thích cho câu hỏi này.');
    }
    return text;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Yêu cầu Gemini quá thời gian chờ. Vui lòng thử lại.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const LOCAL_PREF_KEY = 'quizizz_mini_pref_v3';

const SoundEngine = (() => {
  let audioCtx = null;
  let enabled = true;

  function getContext() {
    if (!enabled) return null;
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function tone(freq, duration, type = 'sine', delay = 0, peak = 0.14) {
    const ctx = getContext();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) {}
  }

  return {
    isEnabled: () => enabled,
    setEnabled: (v) => {
      enabled = Boolean(v);
      if (enabled) getContext();
    },
    click: () => tone(540, 0.06, 'triangle', 0, 0.08),
    tick: (urgent = false) => tone(urgent ? 920 : 660, 0.055, 'sine', 0, urgent ? 0.11 : 0.05),
    correct: (streak = 1) => {
      const lift = Math.min(streak - 1, 6) * 40;
      tone(523.25 + lift, 0.12, 'triangle', 0, 0.15);
      tone(659.25 + lift, 0.12, 'triangle', 0.08, 0.15);
      tone(783.99 + lift, 0.24, 'triangle', 0.16, 0.17);
    },
    wrong: () => {
      tone(240, 0.18, 'sawtooth', 0, 0.11);
      tone(175, 0.28, 'sawtooth', 0.14, 0.11);
    },
    timeout: () => {
      tone(300, 0.15, 'square', 0, 0.08);
      tone(210, 0.24, 'square', 0.14, 0.08);
    },
    victory: () => {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((n, i) => {
        tone(n, i === 4 ? 0.42 : 0.13, 'triangle', i * 0.1, 0.15);
      });
    }
  };
})();

function sanitizeQuestions(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .filter(q => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length === 4)
    .map((q, idx) => ({
      id: q.id || `q-${idx}-${Date.now()}`,
      question: String(q.question).trim(),
      options: q.options.map(o => String(o || '').trim()),
      correctIndex: Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3
        ? q.correctIndex
        : 0,
      timeLimit: Number.isFinite(Number(q.timeLimit))
        ? Math.max(5, Math.min(300, Math.round(Number(q.timeLimit))))
        : 20,
      explanation: String(q.explanation || '').trim()
    }))
    .filter(q => q.question && q.options.every(Boolean));
}

function makeMetaEntry(id, name = 'Đề 1', questionCount = 0, pinned = false, updatedAt = Date.now()) {
  return {
    id: String(id || `set-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
    name: String(name || 'Đề 1').trim() || 'Đề 1',
    questionCount: Math.max(0, Number(questionCount) || 0),
    pinned: Boolean(pinned),
    updatedAt: Number(updatedAt) || Date.now()
  };
}

function sortMetaPinnedFirst(list) {
  return list.slice().sort((a, b) => {
    if (Boolean(a.pinned) === Boolean(b.pinned)) return 0;
    return a.pinned ? -1 : 1;
  });
}

function normalizeMetaList(rawMeta) {
  if (!Array.isArray(rawMeta)) return [];
  const mapped = rawMeta
    .filter(m => m && typeof m === 'object')
    .map((m, idx) => makeMetaEntry(
      m.id || `set-${idx}-${Date.now()}`,
      m.name || `Đề ${idx + 1}`,
      m.questionCount,
      m.pinned,
      m.updatedAt
    ));
  return sortMetaPinnedFirst(mapped);
}

function loadLightweightPref() {
  try {
    const raw = localStorage.getItem(LOCAL_PREF_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveLightweightPref() {
  try {
    const activeMeta = state.setsMeta.find(m => m.id === state.activeSetId);
    const activeQuestions = state.questionsBySetId[state.activeSetId];
    const payload = {
      activeSetId: state.activeSetId,
      setsMeta: state.setsMeta.slice(0, 60),
      activeSetCache: activeMeta && Array.isArray(activeQuestions) && activeQuestions.length <= 250
        ? { id: activeMeta.id, questions: activeQuestions }
        : null
    };
    localStorage.setItem(LOCAL_PREF_KEY, JSON.stringify(payload));
  } catch (e) {}
}

const pref = loadLightweightPref();
const initialDefault = makeMetaEntry(`set-${Date.now()}`, 'Đề 1', 0, false);
const initialMeta = pref?.setsMeta?.length ? normalizeMetaList(pref.setsMeta) : [initialDefault];
const initialActiveId = initialMeta.some(m => m.id === pref?.activeSetId)
  ? pref.activeSetId
  : initialMeta[0].id;

const initialQuestionsMap = {};
if (pref?.activeSetCache?.id && Array.isArray(pref.activeSetCache.questions)) {
  initialQuestionsMap[pref.activeSetCache.id] = sanitizeQuestions(pref.activeSetCache.questions);
}

const state = {
  isOwner: isOwnerUnlocked(),
  guestApproved: false,
  setsMeta: initialMeta,
  activeSetId: initialActiveId,
  setFilterText: '',
  questionFilterText: '',
  questionsBySetId: initialQuestionsMap,
  loadedSetIds: new Set(Object.keys(initialQuestionsMap)),
  accessRequests: [],
  lastDeletedQuestion: null,
  syncStatus: 'loading',
  isBusy: false,
  pendingDeleteSetId: null,
  view: 'lobby',
  deck: [],
  currentIndex: 0,
  score: 0,
  streak: 0,
  maxStreak: 0,
  answeredCurrent: false,
  timeLeft: 20,
  currentTimeLimit: 20,
  noTimeLimit: false,
  timerInterval: null,
  history: [],
  aiCacheBySharedKey: {},
  aiPendingKeys: new Set(),
  drawerTab: 'bulk',
  editingIndex: null
};

const dom = {
  toastContainer: document.getElementById('toastContainer'),
  homeLogoBtn: document.getElementById('homeLogoBtn'),
  refreshCloudBtn: document.getElementById('refreshCloudBtn'),
  aiKeyModalBtn: document.getElementById('aiKeyModalBtn'),
  aiKeyStatusLabel: document.getElementById('aiKeyStatusLabel'),
  aiKeyOverlay: document.getElementById('aiKeyOverlay'),
  closeAiKeyModalBtn: document.getElementById('closeAiKeyModalBtn'),
  toggleGeminiKeyVisibilityBtn: document.getElementById('toggleGeminiKeyVisibilityBtn'),
  geminiApiKeyInput: document.getElementById('geminiApiKeyInput'),
  aiKeySavedHint: document.getElementById('aiKeySavedHint'),
  clearGeminiApiKeyBtn: document.getElementById('clearGeminiApiKeyBtn'),
  saveGeminiApiKeyBtn: document.getElementById('saveGeminiApiKeyBtn'),
  soundToggleBtn: document.getElementById('soundToggleBtn'),
  soundIcon: document.getElementById('soundIcon'),
  soundLabel: document.getElementById('soundLabel'),
  headerPasteBtn: document.getElementById('headerPasteBtn'),
  headerCountPill: document.getElementById('headerCountPill'),
  ownerRoleBadge: document.getElementById('ownerRoleBadge'),
  ownerLoginBox: document.getElementById('ownerLoginBox'),
  ownerPinInput: document.getElementById('ownerPinInput'),
  ownerUnlockBtn: document.getElementById('ownerUnlockBtn'),
  ownerLockBtn: document.getElementById('ownerLockBtn'),
  guestRequestPanel: document.getElementById('guestRequestPanel'),
  guestRequestStatusText: document.getElementById('guestRequestStatusText'),
  guestNameInput: document.getElementById('guestNameInput'),
  guestReasonInput: document.getElementById('guestReasonInput'),
  sendAccessRequestBtn: document.getElementById('sendAccessRequestBtn'),
  ownerRequestsPanel: document.getElementById('ownerRequestsPanel'),
  ownerRequestsList: document.getElementById('ownerRequestsList'),
  lobbyView: document.getElementById('lobbyView'),
  gameView: document.getElementById('gameView'),
  summaryView: document.getElementById('summaryView'),
  lobbyStatusDot: document.getElementById('lobbyStatusDot'),
  lobbyStatusBadge: document.getElementById('lobbyStatusBadge'),
  cloudSyncBadge: document.getElementById('cloudSyncBadge'),
  activeSetTitleDisplay: document.getElementById('activeSetTitleDisplay'),
  pinSetBtn: document.getElementById('pinSetBtn'),
  duplicateSetBtn: document.getElementById('duplicateSetBtn'),
  deleteCurrentSetBtn: document.getElementById('deleteCurrentSetBtn'),
  totalSetsCount: document.getElementById('totalSetsCount'),
  setFilterInput: document.getElementById('setFilterInput'),
  quizSetSelect: document.getElementById('quizSetSelect'),
  quickNewSetBtn: document.getElementById('quickNewSetBtn'),
  renameSetBtn: document.getElementById('renameSetBtn'),
  copySetJsonBtn: document.getElementById('copySetJsonBtn'),
  downloadSetJsonBtn: document.getElementById('downloadSetJsonBtn'),
  renameSetBox: document.getElementById('renameSetBox'),
  renameSetInput: document.getElementById('renameSetInput'),
  confirmRenameSetBtn: document.getElementById('confirmRenameSetBtn'),
  lobbyPasteCodeBtn: document.getElementById('lobbyPasteCodeBtn'),
  lobbyManualCreateBtn: document.getElementById('lobbyManualCreateBtn'),
  playTimeOverrideSelect: document.getElementById('playTimeOverrideSelect'),
  bulkSetTimeInput: document.getElementById('bulkSetTimeInput'),
  applyTimeToAllBtn: document.getElementById('applyTimeToAllBtn'),
  shuffleQuestionsCheckbox: document.getElementById('shuffleQuestionsCheckbox'),
  shuffleOptionsCheckbox: document.getElementById('shuffleOptionsCheckbox'),
  startGameBtn: document.getElementById('startGameBtn'),
  startGameBtnLabel: document.getElementById('startGameBtnLabel'),
  questionSearchInput: document.getElementById('questionSearchInput'),
  undoDeleteBtn: document.getElementById('undoDeleteBtn'),
  lobbyListSummary: document.getElementById('lobbyListSummary'),
  lobbyQuestionsContainer: document.getElementById('lobbyQuestionsContainer'),
  exitGameBtn: document.getElementById('exitGameBtn'),
  currentQNum: document.getElementById('currentQNum'),
  totalQNum: document.getElementById('totalQNum'),
  streakBadge: document.getElementById('streakBadge'),
  streakCount: document.getElementById('streakCount'),
  liveScore: document.getElementById('liveScore'),
  timerPill: document.getElementById('timerPill'),
  timerText: document.getElementById('timerText'),
  timerUnitText: document.getElementById('timerUnitText'),
  timerBar: document.getElementById('timerBar'),
  questionPrompt: document.getElementById('questionPrompt'),
  answersGrid: document.getElementById('answersGrid'),
  feedbackBanner: document.getElementById('feedbackBanner'),
  feedbackTitle: document.getElementById('feedbackTitle'),
  feedbackPointsPill: document.getElementById('feedbackPointsPill'),
  feedbackExplanation: document.getElementById('feedbackExplanation'),
  askAiCurrentBtn: document.getElementById('askAiCurrentBtn'),
  aiFeedbackBox: document.getElementById('aiFeedbackBox'),
  nextQuestionBtn: document.getElementById('nextQuestionBtn'),
  summaryTrophy: document.getElementById('summaryTrophy'),
  summaryHeadline: document.getElementById('summaryHeadline'),
  summarySubtext: document.getElementById('summarySubtext'),
  finalScoreText: document.getElementById('finalScoreText'),
  finalAccuracyText: document.getElementById('finalAccuracyText'),
  finalMaxStreakText: document.getElementById('finalMaxStreakText'),
  finalRightWrongText: document.getElementById('finalRightWrongText'),
  practiceMistakesBtn: document.getElementById('practiceMistakesBtn'),
  playAgainBtn: document.getElementById('playAgainBtn'),
  loadNewCodeBtn: document.getElementById('loadNewCodeBtn'),
  backToLobbyBtn: document.getElementById('backToLobbyBtn'),
  reviewSummaryCount: document.getElementById('reviewSummaryCount'),
  reviewList: document.getElementById('reviewList'),
  builderOverlay: document.getElementById('builderOverlay'),
  builderDrawer: document.getElementById('builderDrawer'),
  closeBuilderBtn: document.getElementById('closeBuilderBtn'),
  tabBulkMode: document.getElementById('tabBulkMode'),
  tabFormMode: document.getElementById('tabFormMode'),
  drawerClearCurrentSetBtn: document.getElementById('drawerClearCurrentSetBtn'),
  bulkModePanel: document.getElementById('bulkModePanel'),
  formModePanel: document.getElementById('formModePanel'),
  targetSetNameInput: document.getElementById('targetSetNameInput'),
  bulkDefaultTimeInput: document.getElementById('bulkDefaultTimeInput'),
  clearTextareaBtn: document.getElementById('clearTextareaBtn'),
  bulkPasteTextarea: document.getElementById('bulkPasteTextarea'),
  saveAsNewSetBtn: document.getElementById('saveAsNewSetBtn'),
  appendImportBtn: document.getElementById('appendImportBtn'),
  bulkLoadedCount: document.getElementById('bulkLoadedCount'),
  bulkLoadedList: document.getElementById('bulkLoadedList'),
  formHeaderTitle: document.getElementById('formHeaderTitle'),
  resetFormFieldsBtn: document.getElementById('resetFormFieldsBtn'),
  qPromptInput: document.getElementById('qPromptInput'),
  qCorrectSelect: document.getElementById('qCorrectSelect'),
  qTimeInput: document.getElementById('qTimeInput'),
  qOpt0: document.getElementById('qOpt0'),
  qOpt1: document.getElementById('qOpt1'),
  qOpt2: document.getElementById('qOpt2'),
  qOpt3: document.getElementById('qOpt3'),
  qExplainInput: document.getElementById('qExplainInput'),
  saveManualQuestionBtn: document.getElementById('saveManualQuestionBtn'),
  formLoadedCount: document.getElementById('formLoadedCount'),
  formLoadedList: document.getElementById('formLoadedList'),
  drawerTotalCount: document.getElementById('drawerTotalCount'),
  playFromDrawerBtn: document.getElementById('playFromDrawerBtn')
};

function setGeminiKeyInputVisibility(visible) {
  if (!dom.geminiApiKeyInput || !dom.toggleGeminiKeyVisibilityBtn) return;
  dom.geminiApiKeyInput.type = visible ? 'text' : 'password';
  dom.toggleGeminiKeyVisibilityBtn.textContent = visible ? '🙈 Ẩn key' : '👁️ Hiện key';
}

function updateAiKeyBadge() {
  const hasKey = Boolean(getGeminiApiKey());
  if (dom.aiKeyStatusLabel) {
    dom.aiKeyStatusLabel.textContent = hasKey ? 'AI Key ✓' : 'AI Key';
  }
  if (dom.aiKeySavedHint) {
    dom.aiKeySavedHint.textContent = hasKey
      ? 'Đang có khóa lưu trên trình duyệt này (ẩn để bảo mật).'
      : 'Chưa có khóa nào được lưu trên trình duyệt này.';
  }
}

function openAiKeyModal() {
  if (!dom.aiKeyOverlay) return;
  if (dom.geminiApiKeyInput) dom.geminiApiKeyInput.value = '';
  setGeminiKeyInputVisibility(false);
  updateAiKeyBadge();
  dom.aiKeyOverlay.classList.remove('hidden');
  setTimeout(() => dom.geminiApiKeyInput?.focus(), 80);
}

function closeAiKeyModal() {
  dom.aiKeyOverlay?.classList.add('hidden');
  if (dom.geminiApiKeyInput) dom.geminiApiKeyInput.value = '';
  setGeminiKeyInputVisibility(false);
}

function renderAiResultHtml(text) {
  return `<div class="text-[11px] font-extrabold text-[#ffd000] uppercase tracking-wider">✨ Giải thích từ Gemini (${escapeHtml(GEMINI_CONFIG.model)})</div><p>${formatAiPlainText(text)}</p>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  if (!dom.toastContainer) return;
  const styles = {
    success: 'bg-emerald-950/95 border-emerald-400/50 text-emerald-100',
    error: 'bg-rose-950/95 border-rose-400/50 text-rose-100',
    info: 'bg-[#2e0f3d]/95 border-[#ff2a85]/50 text-purple-100'
  };
  const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : '✨';
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto rounded-2xl border px-4 py-3 shadow-xl text-xs sm:text-sm font-bold flex items-center gap-2.5 animate-pop-in ${styles[type] || styles.info}`;
  toast.innerHTML = `<span class="text-base shrink-0">${icon}</span><span class="flex-1">${escapeHtml(message)}</span>`;
  dom.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
    toast.style.transition = 'all 0.22s ease';
    setTimeout(() => toast.remove(), 240);
  }, 2600);
}

function shuffleArray(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function canEditContent() {
  return state.isOwner || state.guestApproved;
}

function requireEditor(actionLabel = 'chỉnh sửa/thêm/xóa bộ đề') {
  if (canEditContent()) return true;
  showToast(`Chỉ chủ sở hữu hoặc người được duyệt mới được ${actionLabel}.`, 'error');
  dom.guestRequestPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return false;
}

function requireOwnerOnly(actionLabel = 'thực hiện thao tác quản trị này') {
  if (state.isOwner) return true;
  showToast(`Chỉ chủ sở hữu (PIN) mới được ${actionLabel}.`, 'error');
  return false;
}

function unlockOwnerMode() {
  const pin = dom.ownerPinInput?.value.trim() || '';
  if (pin !== OWNER_PIN_CODE) {
    SoundEngine.wrong();
    showToast('Mã PIN chủ sở hữu chưa đúng.', 'error');
    return;
  }
  setOwnerUnlocked(true, true);
  state.isOwner = true;
  if (dom.ownerPinInput) dom.ownerPinInput.value = '';
  SoundEngine.correct(1);
  showToast('Đã mở quyền Chủ sở hữu!', 'success');
  syncRoleUI();
  loadAccessRequests();
}

function lockOwnerMode() {
  SoundEngine.click();
  setOwnerUnlocked(false, true);
  state.isOwner = false;
  resetDeleteGuard();
  syncRoleUI();
  showToast('Đã khóa về chế độ Xem & Chơi.', 'info');
}

async function submitEditRequest() {
  const requester = dom.guestNameInput?.value.trim() || 'Người dùng ẩn danh';
  const reason = dom.guestReasonInput?.value.trim() || '';
  if (!reason) {
    showToast('Vui lòng nhập nội dung/lý do cần sửa đề.', 'error');
    dom.guestReasonInput?.focus();
    return;
  }

  setBusyState(true);
  try {
    const activeMeta = getActiveMeta();
    const res = await fbPost(REQUESTS_ENDPOINT, {
      requester,
      reason,
      setId: activeMeta.id,
      setName: activeMeta.name,
      status: 'pending',
      createdAt: Date.now()
    });
    if (res && res.name) {
      setSavedRequestId(res.name);
      state.guestApproved = false;
    }
    if (dom.guestReasonInput) dom.guestReasonInput.value = '';
    SoundEngine.correct(1);
    showToast('Đã gửi yêu cầu quyền sửa tới chủ sở hữu!', 'success');
    await checkGuestRequestStatus();
  } catch (err) {
    showToast('Không gửi được yêu cầu lúc này.', 'error');
  } finally {
    setBusyState(false);
  }
}

async function checkGuestRequestStatus() {
  const reqId = getSavedRequestId();
  if (!reqId) {
    state.guestApproved = false;
    if (dom.guestRequestStatusText) dom.guestRequestStatusText.textContent = '';
    syncRoleUI();
    return;
  }
  try {
    const req = await fbGet(`/quizizz_mini/access_requests/${encodeURIComponent(reqId)}.json`);
    if (!req) {
      state.guestApproved = false;
      setSavedRequestId('');
      if (dom.guestRequestStatusText) dom.guestRequestStatusText.textContent = '';
    } else if (req.status === 'approved') {
      state.guestApproved = true;
      if (dom.guestRequestStatusText) {
        dom.guestRequestStatusText.className = 'text-xs font-extrabold text-emerald-300';
        dom.guestRequestStatusText.textContent = '✅ Đã được chủ sở hữu chấp nhận quyền sửa!';
      }
    } else if (req.status === 'rejected') {
      state.guestApproved = false;
      if (dom.guestRequestStatusText) {
        dom.guestRequestStatusText.className = 'text-xs font-extrabold text-rose-300';
        dom.guestRequestStatusText.textContent = '⛔ Yêu cầu của bạn đã bị từ chối.';
      }
    } else {
      state.guestApproved = false;
      if (dom.guestRequestStatusText) {
        dom.guestRequestStatusText.className = 'text-xs font-bold text-amber-200';
        dom.guestRequestStatusText.textContent = '⏳ Đang chờ chủ sở hữu duyệt...';
      }
    }
    syncRoleUI();
  } catch (e) {}
}

async function loadAccessRequests() {
  if (!state.isOwner) return;
  try {
    const raw = await fbGet(REQUESTS_ENDPOINT);
    if (!raw || typeof raw !== 'object') {
      state.accessRequests = [];
    } else {
      state.accessRequests = Object.entries(raw)
        .map(([key, val]) => ({ id: key, ...val }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    renderOwnerRequests();
  } catch (e) {}
}

async function decideAccessRequest(reqId, decision) {
  if (!requireOwnerOnly('duyệt yêu cầu quyền sửa') || !reqId) return;
  try {
    await fbPatch(`/quizizz_mini/access_requests/${encodeURIComponent(reqId)}.json`, {
      status: decision,
      reviewedAt: Date.now()
    });
    state.accessRequests = state.accessRequests.map(r =>
      r.id === reqId ? { ...r, status: decision } : r
    );
    renderOwnerRequests();
    showToast(
      decision === 'approved' ? 'Đã chấp nhận yêu cầu quyền sửa!' : 'Đã từ chối yêu cầu quyền sửa.',
      decision === 'approved' ? 'success' : 'info'
    );
  } catch (e) {
    showToast(`Lỗi khi cập nhật trạng thái yêu cầu (${e.message || 'lỗi mạng'}).`, 'error');
  }
}

async function dismissAccessRequest(reqId) {
  if (!requireOwnerOnly('xóa yêu cầu') || !reqId) return;
  try {
    await fbDelete(`/quizizz_mini/access_requests/${encodeURIComponent(reqId)}.json`);
    state.accessRequests = state.accessRequests.filter(r => r.id !== reqId);
    renderOwnerRequests();
    showToast('Đã xóa yêu cầu khỏi danh sách.', 'info');
  } catch (e) {
    showToast('Lỗi khi xóa yêu cầu.', 'error');
  }
}

function renderOwnerRequests() {
  if (!state.isOwner || !dom.ownerRequestsPanel || !dom.ownerRequestsList) return;
  dom.ownerRequestsPanel.classList.remove('hidden');

  if (state.accessRequests.length === 0) {
    dom.ownerRequestsList.innerHTML = `<p class="text-xs text-purple-200/65">Chưa có yêu cầu xin quyền sửa nào.</p>`;
    return;
  }

  const frag = document.createDocumentFragment();
  state.accessRequests.forEach(req => {
    const row = document.createElement('div');
    row.className = 'rounded-xl bg-black/30 border border-white/10 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5';
    const statusLabel = req.status === 'approved'
      ? '✅ Đã chấp nhận'
      : req.status === 'rejected'
        ? '⛔ Đã từ chối'
        : '⏳ Đang chờ';

    row.innerHTML = `
      <div class="min-w-0 flex-1 space-y-0.5">
        <div class="text-xs font-extrabold text-[#ffd000]">${escapeHtml(req.requester || 'Khách')} • ${escapeHtml(req.setName || 'Bộ đề')} • <span class="text-white">${statusLabel}</span></div>
        <p class="text-xs text-white leading-relaxed">${escapeHtml(req.reason || '')}</p>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 shrink-0">
        <button type="button" data-act="accept" class="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[#092110] text-[11px] font-extrabold cursor-pointer">Chấp nhận</button>
        <button type="button" data-act="reject" class="px-2.5 py-1 rounded-lg bg-rose-500/25 hover:bg-rose-500/40 text-rose-200 text-[11px] font-bold cursor-pointer">Từ chối</button>
        <button type="button" data-act="dismiss" class="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-bold cursor-pointer">Đóng</button>
      </div>
    `;
    row.querySelector('[data-act="accept"]').addEventListener('click', () => decideAccessRequest(req.id, 'approved'));
    row.querySelector('[data-act="reject"]').addEventListener('click', () => decideAccessRequest(req.id, 'rejected'));
    row.querySelector('[data-act="dismiss"]').addEventListener('click', () => dismissAccessRequest(req.id));
    frag.appendChild(row);
  });
  dom.ownerRequestsList.innerHTML = '';
  dom.ownerRequestsList.appendChild(frag);
}

function syncRoleUI() {
  const editable = canEditContent();
  if (!dom.ownerRoleBadge) return;

  if (state.isOwner) {
    dom.ownerRoleBadge.textContent = '👑 Chủ sở hữu (Toàn quyền sửa/xóa)';
    dom.ownerRoleBadge.className = 'text-xs font-extrabold px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-400/40';
    dom.ownerPinInput?.classList.add('hidden');
    dom.ownerUnlockBtn?.classList.add('hidden');
    dom.ownerLockBtn?.classList.remove('hidden');
    dom.guestRequestPanel?.classList.add('hidden');
    renderOwnerRequests();
  } else if (state.guestApproved) {
    dom.ownerRoleBadge.textContent = '✅ Đã được cấp quyền sửa đề';
    dom.ownerRoleBadge.className = 'text-xs font-extrabold px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-400/40';
    dom.ownerPinInput?.classList.remove('hidden');
    dom.ownerUnlockBtn?.classList.remove('hidden');
    dom.ownerLockBtn?.classList.add('hidden');
    dom.guestRequestPanel?.classList.remove('hidden');
    dom.ownerRequestsPanel?.classList.add('hidden');
  } else {
    dom.ownerRoleBadge.textContent = '👀 Chế độ Xem & Chơi (Chỉ chủ mới sửa/xóa)';
    dom.ownerRoleBadge.className = 'text-xs font-extrabold px-3 py-1 rounded-full bg-amber-500/15 text-amber-200 border border-amber-400/35';
    dom.ownerPinInput?.classList.remove('hidden');
    dom.ownerUnlockBtn?.classList.remove('hidden');
    dom.ownerLockBtn?.classList.add('hidden');
    dom.guestRequestPanel?.classList.remove('hidden');
    dom.ownerRequestsPanel?.classList.add('hidden');
  }

  [
    dom.quickNewSetBtn,
    dom.renameSetBtn,
    dom.pinSetBtn,
    dom.duplicateSetBtn,
    dom.deleteCurrentSetBtn,
    dom.applyTimeToAllBtn,
    dom.drawerClearCurrentSetBtn,
    dom.saveAsNewSetBtn,
    dom.appendImportBtn,
    dom.saveManualQuestionBtn
  ].forEach(btn => {
    if (btn) btn.classList.toggle('opacity-50', !editable);
  });
}

function resetDeleteGuard() {
  state.pendingDeleteSetId = null;
  if (dom.deleteCurrentSetBtn) {
    dom.deleteCurrentSetBtn.textContent = '🗑️ Xóa bộ đề hiện tại';
  }
}

function getActiveMeta() {
  let found = state.setsMeta.find(m => m.id === state.activeSetId);
  if (!found) {
    found = state.setsMeta[0] || makeMetaEntry(`set-${Date.now()}`, 'Đề 1', 0, false);
    if (!state.setsMeta.length) state.setsMeta.push(found);
    state.activeSetId = found.id;
  }
  return found;
}

function getActiveQuestions() {
  const list = state.questionsBySetId[state.activeSetId];
  return Array.isArray(list) ? list : [];
}

function getActiveDisplayCount() {
  const loaded = state.questionsBySetId[state.activeSetId];
  if (Array.isArray(loaded)) return loaded.length;
  return getActiveMeta().questionCount || 0;
}

async function ensureSetQuestionsLoaded(setId, forceRefresh = false) {
  if (!setId) return [];
  if (!forceRefresh && state.loadedSetIds.has(setId) && Array.isArray(state.questionsBySetId[setId])) {
    return state.questionsBySetId[setId];
  }
  state.syncStatus = 'loading';
  updateSyncBadge();
  try {
    const raw = await fbGet(SET_ENDPOINT(setId));
    const clean = sanitizeQuestions(
      Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : [])
    );
    state.questionsBySetId[setId] = clean;
    state.loadedSetIds.add(setId);
    state.setsMeta = state.setsMeta.map(m =>
      m.id === setId ? { ...m, questionCount: clean.length } : m
    );
    state.syncStatus = 'synced';
    saveLightweightPref();
    return clean;
  } catch (err) {
    if (!Array.isArray(state.questionsBySetId[setId])) state.questionsBySetId[setId] = [];
    state.syncStatus = 'offline';
    return state.questionsBySetId[setId];
  } finally {
    syncAllUI();
  }
}

async function refreshMetaOnly(reloadActiveSet = false) {
  try {
    const rawMeta = await fbGet(META_ENDPOINT);
    const metaList = normalizeMetaList(
      Array.isArray(rawMeta) ? rawMeta : (rawMeta && typeof rawMeta === 'object' ? Object.values(rawMeta) : [])
    );
    if (metaList.length > 0) {
      const prevActive = state.setsMeta.find(m => m.id === state.activeSetId);
      state.setsMeta = metaList;
      if (!state.setsMeta.some(m => m.id === state.activeSetId)) {
        state.activeSetId = state.setsMeta[0].id;
      }
      const nextActive = state.setsMeta.find(m => m.id === state.activeSetId);
      const changed = !prevActive || !nextActive ||
        prevActive.updatedAt !== nextActive.updatedAt ||
        prevActive.questionCount !== nextActive.questionCount ||
        prevActive.name !== nextActive.name;
      saveLightweightPref();
      syncAllUI();
      if (reloadActiveSet || changed) {
        await ensureSetQuestionsLoaded(state.activeSetId, true);
      }
    }
  } catch (e) {}
}

async function initCloudMetadataAndActiveSet() {
  state.syncStatus = 'loading';
  updateSyncBadge();

  const safetyTimer = setTimeout(() => {
    if (state.syncStatus === 'loading') {
      state.syncStatus = 'offline';
      syncAllUI();
    }
  }, 5500);

  try {
    const rawMeta = await fbGet(META_ENDPOINT);
    let metaList = normalizeMetaList(
      Array.isArray(rawMeta) ? rawMeta : (rawMeta && typeof rawMeta === 'object' ? Object.values(rawMeta) : [])
    );

    if (metaList.length === 0) {
      const legacyMulti = await fbGet(LEGACY_MULTI_ENDPOINT);
      if (Array.isArray(legacyMulti) && legacyMulti.length > 0) {
        const migrated = [];
        for (let i = 0; i < legacyMulti.length; i++) {
          const s = legacyMulti[i];
          const setId = String(s.id || `set-mig-${i}-${Date.now()}`);
          const cleanQs = sanitizeQuestions(s.questions);
          await fbPut(SET_ENDPOINT(setId), cleanQs);
          state.questionsBySetId[setId] = cleanQs;
          state.loadedSetIds.add(setId);
          migrated.push(makeMetaEntry(setId, s.name || `Đề ${i + 1}`, cleanQs.length, false, s.updatedAt));
        }
        metaList = normalizeMetaList(migrated);
        await fbPut(META_ENDPOINT, metaList);
      }
    }

    if (metaList.length === 0) {
      const legacySingle = await fbGet(LEGACY_SINGLE_ENDPOINT);
      const cleanSingle = sanitizeQuestions(
        Array.isArray(legacySingle) ? legacySingle : (legacySingle && typeof legacySingle === 'object' ? Object.values(legacySingle) : [])
      );
      if (cleanSingle.length > 0) {
        const firstId = `set-${Date.now()}`;
        await fbPut(SET_ENDPOINT(firstId), cleanSingle);
        state.questionsBySetId[firstId] = cleanSingle;
        state.loadedSetIds.add(firstId);
        metaList = [makeMetaEntry(firstId, 'Đề 1', cleanSingle.length, false)];
        await fbPut(META_ENDPOINT, metaList);
      }
    }

    if (metaList.length > 0) {
      state.setsMeta = metaList;
      if (!state.setsMeta.some(m => m.id === state.activeSetId)) {
        state.activeSetId = state.setsMeta[0].id;
      }
    }

    state.syncStatus = 'synced';
    saveLightweightPref();
    syncAllUI();
    await ensureSetQuestionsLoaded(state.activeSetId, false);
    if (state.isOwner) await loadAccessRequests();
    else await checkGuestRequestStatus();
  } catch (err) {
    state.syncStatus = 'offline';
    syncAllUI();
    showToast(`Không tải được dữ liệu cloud (${err.message || 'lỗi mạng'}).`, 'error');
  } finally {
    clearTimeout(safetyTimer);
  }
}

async function applyTimeToEntireActiveSet() {
  if (!requireEditor('chỉnh thời gian cho cả bộ đề') || state.isBusy) return;
  const sec = Math.max(5, Math.min(300, parseInt(dom.bulkSetTimeInput?.value, 10) || 20));
  if (dom.bulkSetTimeInput) dom.bulkSetTimeInput.value = String(sec);

  setBusyState(true);
  SoundEngine.click();
  const activeId = state.activeSetId;
  const currentQs = await ensureSetQuestionsLoaded(activeId, false);
  if (currentQs.length === 0) {
    setBusyState(false);
    showToast('Bộ đề hiện tại chưa có câu hỏi nào.', 'error');
    return;
  }

  const updated = currentQs.map(q => ({ ...q, timeLimit: sec }));
  const ok = await writeSetQuestionsAndMeta(activeId, updated);
  setBusyState(false);
  if (ok) {
    showToast(`Đã đặt ${sec} giây/câu cho toàn bộ ${updated.length} câu trong "${getActiveMeta().name}"!`, 'success');
  }
}

async function togglePinActiveSet() {
  if (!requireEditor('ghim bộ đề') || state.isBusy) return;
  setBusyState(true);
  SoundEngine.click();
  const activeId = state.activeSetId;
  state.setsMeta = normalizeMetaList(
    state.setsMeta.map(m => m.id === activeId ? { ...m, pinned: !m.pinned, updatedAt: Date.now() } : m)
  );
  saveLightweightPref();
  syncAllUI();
  try {
    await fbPut(META_ENDPOINT, state.setsMeta);
    const updated = state.setsMeta.find(m => m.id === activeId);
    showToast(updated?.pinned ? `Đã ghim "${updated.name}".` : `Đã bỏ ghim "${updated?.name || 'bộ đề'}".`, 'success');
  } catch (e) {
    showToast('Lỗi cập nhật ghim lên Firebase.', 'error');
  } finally {
    setBusyState(false);
  }
}

async function duplicateActiveSet() {
  if (!requireEditor('nhân bản bộ đề') || state.isBusy) return;
  setBusyState(true);
  SoundEngine.click();
  try {
    const srcMeta = getActiveMeta();
    const srcQs = await ensureSetQuestionsLoaded(srcMeta.id, false);
    const clonedQs = srcQs.map((q, i) => ({
      ...q,
      id: `q-dup-${Date.now()}-${i}`,
      options: q.options.slice()
    }));
    const newId = `set-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newName = `${srcMeta.name} (Bản sao)`;
    const newMeta = makeMetaEntry(newId, newName, clonedQs.length, false);

    state.setsMeta = normalizeMetaList(state.setsMeta.concat(newMeta));
    state.activeSetId = newId;
    state.questionsBySetId[newId] = clonedQs;
    state.loadedSetIds.add(newId);
    saveLightweightPref();
    syncAllUI();

    await fbPut(SET_ENDPOINT(newId), clonedQs);
    await fbPut(META_ENDPOINT, state.setsMeta);
    showToast(`Đã nhân bản thành "${newName}" (${clonedQs.length} câu)!`, 'success');
  } catch (e) {
    showToast('Lỗi khi nhân bản bộ đề.', 'error');
  } finally {
    setBusyState(false);
  }
}

async function createBlankQuizSet(customName = '') {
  if (!requireEditor('tạo bộ đề mới') || state.isBusy) return;
  setBusyState(true);
  resetDeleteGuard();
  SoundEngine.click();

  const chosenName = String(customName || dom.targetSetNameInput?.value || '').trim()
    || `Đề ${state.setsMeta.length + 1}`;
  const newMeta = makeMetaEntry(
    `set-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chosenName,
    0,
    false
  );
  state.setsMeta = normalizeMetaList(state.setsMeta.concat(newMeta));
  state.activeSetId = newMeta.id;
  state.questionsBySetId[newMeta.id] = [];
  state.loadedSetIds.add(newMeta.id);
  if (dom.targetSetNameInput) dom.targetSetNameInput.value = '';
  saveLightweightPref();
  syncAllUI();

  try {
    await fbPut(SET_ENDPOINT(newMeta.id), []);
    await fbPut(META_ENDPOINT, state.setsMeta);
    showToast(`Đã tạo bộ đề "${newMeta.name}".`, 'success');
  } catch (e) {
    showToast('Lỗi tạo bộ đề trên Firebase.', 'error');
  } finally {
    setBusyState(false);
  }
}

async function renameActiveSet() {
  if (!requireEditor('đổi tên bộ đề') || state.isBusy) return;
  const nextName = dom.renameSetInput?.value.trim() || '';
  if (!nextName) {
    showToast('Nhập tên mới cho bộ đề trước khi lưu.', 'error');
    dom.renameSetInput?.focus();
    return;
  }
  setBusyState(true);
  const activeId = state.activeSetId;
  state.setsMeta = normalizeMetaList(
    state.setsMeta.map(m => m.id === activeId ? { ...m, name: nextName, updatedAt: Date.now() } : m)
  );
  dom.renameSetBox?.classList.add('hidden');
  saveLightweightPref();
  syncAllUI();

  try {
    await fbPut(META_ENDPOINT, state.setsMeta);
    showToast(`Đã đổi tên bộ đề thành "${nextName}".`, 'success');
  } catch (e) {
    showToast('Lỗi đổi tên trên Firebase.', 'error');
  } finally {
    setBusyState(false);
  }
}

async function deleteCurrentSet() {
  if (!requireEditor('xóa bộ đề') || state.isBusy) return;
  const activeMeta = getActiveMeta();
  const targetId = activeMeta.id;

  if (state.pendingDeleteSetId !== targetId) {
    SoundEngine.click();
    state.pendingDeleteSetId = targetId;
    if (dom.deleteCurrentSetBtn) dom.deleteCurrentSetBtn.textContent = '⚠️ Bấm lần nữa để xóa đề';
    showToast(`Bấm thêm 1 lần nữa để xác nhận xóa "${activeMeta.name}".`, 'info');
    setTimeout(() => {
      if (state.pendingDeleteSetId === targetId) resetDeleteGuard();
    }, 4000);
    return;
  }

  resetDeleteGuard();
  setBusyState(true);
  const remaining = state.setsMeta.filter(m => m.id !== targetId);

  try {
    await fbDelete(SET_ENDPOINT(targetId));
    delete state.questionsBySetId[targetId];
    state.loadedSetIds.delete(targetId);

    if (remaining.length === 0) {
      const fresh = makeMetaEntry(`set-${Date.now()}`, 'Đề 1', 0, false);
      state.setsMeta = [fresh];
      state.activeSetId = fresh.id;
      state.questionsBySetId[fresh.id] = [];
      state.loadedSetIds.add(fresh.id);
      await fbPut(SET_ENDPOINT(fresh.id), []);
      await fbPut(META_ENDPOINT, state.setsMeta);
    } else {
      state.setsMeta = remaining;
      state.activeSetId = remaining[0].id;
      await fbPut(META_ENDPOINT, state.setsMeta);
    }

    saveLightweightPref();
    syncAllUI();
    await ensureSetQuestionsLoaded(state.activeSetId, false);
    showToast(`Đã xóa "${activeMeta.name}".`, 'info');
  } catch (e) {
    showToast('Lỗi xóa bộ đề trên Firebase.', 'error');
  } finally {
    setBusyState(false);
  }
}

async function writeSetQuestionsAndMeta(setId, questions) {
  const cleanQuestions = sanitizeQuestions(questions);
  state.questionsBySetId[setId] = cleanQuestions;
  state.loadedSetIds.add(setId);
  state.setsMeta = normalizeMetaList(
    state.setsMeta.map(m => m.id === setId ? { ...m, questionCount: cleanQuestions.length, updatedAt: Date.now() } : m)
  );
  saveLightweightPref();
  syncAllUI();

  try {
    await fbPut(SET_ENDPOINT(setId), cleanQuestions);
    await fbPut(META_ENDPOINT, state.setsMeta);
    state.syncStatus = 'synced';
    updateSyncBadge();
    return true;
  } catch (e) {
    state.syncStatus = 'offline';
    updateSyncBadge();
    showToast('Lỗi đồng bộ lên Firebase.', 'error');
    return false;
  }
}

async function clearCurrentSetQuestions() {
  if (!requireEditor('xóa câu hỏi') || state.isBusy) return;
  setBusyState(true);
  SoundEngine.click();
  state.editingIndex = null;
  resetManualFormFields();
  await writeSetQuestionsAndMeta(state.activeSetId, []);
  setBusyState(false);
  showToast('Đã xóa hết câu hỏi trong bộ đề hiện tại.', 'info');
}

async function deleteQuestionAt(idx) {
  if (!requireEditor('xóa câu hỏi') || state.isBusy) return;
  setBusyState(true);
  SoundEngine.click();

  const currentQuestions = await ensureSetQuestionsLoaded(state.activeSetId, false);
  const removed = currentQuestions[idx];
  const updated = currentQuestions.slice();
  updated.splice(idx, 1);

  if (removed) {
    state.lastDeletedQuestion = {
      setId: state.activeSetId,
      question: removed,
      index: idx,
      expiresAt: Date.now() + 12000
    };
  }

  if (state.editingIndex === idx) {
    state.editingIndex = null;
    resetManualFormFields();
  } else if (state.editingIndex !== null && state.editingIndex > idx) {
    state.editingIndex -= 1;
  }

  await writeSetQuestionsAndMeta(state.activeSetId, updated);
  setBusyState(false);
  showToast(`Đã xóa Câu #${idx + 1}. Bấm "Hoàn tác xóa" nếu lỡ tay!`, 'info');
}

async function undoLastDeletedQuestion() {
  if (!requireEditor('hoàn tác câu hỏi') || state.isBusy) return;
  const snap = state.lastDeletedQuestion;
  if (!snap || Date.now() > snap.expiresAt) {
    state.lastDeletedQuestion = null;
    syncAllUI();
    return;
  }

  setBusyState(true);
  SoundEngine.click();
  const list = (await ensureSetQuestionsLoaded(snap.setId, false)).slice();
  const insertPos = Math.max(0, Math.min(list.length, snap.index));
  list.splice(insertPos, 0, snap.question);
  state.lastDeletedQuestion = null;
  await writeSetQuestionsAndMeta(snap.setId, list);
  setBusyState(false);
  showToast('Đã khôi phục câu hỏi vừa xóa!', 'success');
}

function setBusyState(busy) {
  state.isBusy = busy;
  [
    dom.quickNewSetBtn,
    dom.renameSetBtn,
    dom.pinSetBtn,
    dom.duplicateSetBtn,
    dom.deleteCurrentSetBtn,
    dom.applyTimeToAllBtn,
    dom.drawerClearCurrentSetBtn,
    dom.saveAsNewSetBtn,
    dom.appendImportBtn,
    dom.saveManualQuestionBtn,
    dom.refreshCloudBtn,
    dom.sendAccessRequestBtn
  ].forEach(el => {
    if (el) el.disabled = busy;
  });
}

function updateSyncBadge() {
  if (!dom.cloudSyncBadge) return;
  if (state.syncStatus === 'loading') {
    dom.cloudSyncBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-400/35 text-xs font-bold text-amber-200';
    dom.cloudSyncBadge.textContent = '⏳ Đang tải bộ đề...';
  } else if (state.syncStatus === 'synced') {
    dom.cloudSyncBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-400/35 text-xs font-bold text-emerald-200';
    dom.cloudSyncBadge.textContent = '☁️ Đã đồng bộ Firebase';
  } else {
    dom.cloudSyncBadge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-500/15 border border-rose-400/35 text-xs font-bold text-rose-200';
    dom.cloudSyncBadge.textContent = '📴 Đang dùng bản lưu cục bộ';
  }
}

function renderSetSelector() {
  const activeMeta = getActiveMeta();
  if (dom.totalSetsCount) dom.totalSetsCount.textContent = state.setsMeta.length;
  if (dom.activeSetTitleDisplay) dom.activeSetTitleDisplay.textContent = activeMeta.name;
  if (dom.pinSetBtn) dom.pinSetBtn.textContent = activeMeta.pinned ? '📌 Đã ghim' : '📌 Ghim đề';
  if (!dom.quizSetSelect) return;

  const kw = state.setFilterText.trim().toLowerCase();
  const filtered = kw
    ? state.setsMeta.filter(m => m.name.toLowerCase().includes(kw) || m.id === activeMeta.id)
    : state.setsMeta;
  const listToShow = filtered.length > 0 ? filtered : [activeMeta];

  const frag = document.createDocumentFragment();
  listToShow.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const count = m.id === activeMeta.id ? getActiveDisplayCount() : (m.questionCount || 0);
    opt.textContent = `${m.pinned ? '📌 ' : ''}${m.name} (${count} câu)`;
    if (m.id === activeMeta.id) opt.selected = true;
    frag.appendChild(opt);
  });
  dom.quizSetSelect.innerHTML = '';
  dom.quizSetSelect.appendChild(frag);
}

function syncAllUI() {
  const activeMeta = getActiveMeta();
  const count = getActiveDisplayCount();
  const hasQuestions = count > 0;

  updateAiKeyBadge();
  renderSetSelector();
  if (dom.headerCountPill) dom.headerCountPill.textContent = count;

  if (dom.lobbyStatusDot && dom.lobbyStatusBadge) {
    if (state.syncStatus === 'loading' && !state.loadedSetIds.has(activeMeta.id)) {
      dom.lobbyStatusDot.className = 'w-2 h-2 rounded-full bg-amber-300 animate-pulse';
      dom.lobbyStatusBadge.textContent = `Đang tải ${activeMeta.name}...`;
    } else if (hasQuestions) {
      dom.lobbyStatusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      dom.lobbyStatusBadge.textContent = `${activeMeta.name} • ${count} câu hỏi`;
    } else {
      dom.lobbyStatusDot.className = 'w-2 h-2 rounded-full bg-purple-300';
      dom.lobbyStatusBadge.textContent = `${activeMeta.name} • 0 câu hỏi`;
    }
  }

  updateSyncBadge();
  syncRoleUI();

  const canUndo = Boolean(
    state.lastDeletedQuestion &&
    state.lastDeletedQuestion.setId === activeMeta.id &&
    Date.now() <= state.lastDeletedQuestion.expiresAt
  );
  dom.undoDeleteBtn?.classList.toggle('hidden', !canUndo);

  if (dom.startGameBtn) {
    dom.startGameBtn.disabled = !hasQuestions || (state.syncStatus === 'loading' && !state.loadedSetIds.has(activeMeta.id));
  }
  if (dom.startGameBtnLabel) {
    dom.startGameBtnLabel.textContent = hasQuestions
      ? `Bắt đầu chơi (${count} câu)`
      : 'Bắt đầu chơi (0 câu)';
  }

  if (dom.bulkLoadedCount) dom.bulkLoadedCount.textContent = count;
  if (dom.formLoadedCount) dom.formLoadedCount.textContent = count;
  if (dom.drawerTotalCount) dom.drawerTotalCount.textContent = count;
  if (dom.playFromDrawerBtn) dom.playFromDrawerBtn.disabled = !hasQuestions;

  renderLobby();
  renderDrawerQuestionLists();
}

function renderLobby() {
  if (!dom.lobbyQuestionsContainer || !dom.lobbyListSummary) return;
  const activeMeta = getActiveMeta();
  const isLoadingSet = state.syncStatus === 'loading' && !state.loadedSetIds.has(activeMeta.id);

  if (isLoadingSet) {
    dom.lobbyListSummary.textContent = 'Đang tải...';
    dom.lobbyQuestionsContainer.innerHTML = `
      <div class="rounded-2xl border border-white/10 bg-black/20 py-9 px-4 text-center space-y-2">
        <div class="text-2xl animate-pulse">⏳</div>
        <p class="text-sm font-bold text-purple-200/80">Đang tải câu hỏi của "${escapeHtml(activeMeta.name)}"...</p>
      </div>
    `;
    return;
  }

  const allQuestions = getActiveQuestions();
  const kw = state.questionFilterText.trim().toLowerCase();
  const filteredIndices = allQuestions
    .map((q, idx) => ({ q, idx }))
    .filter(({ q }) => !kw || q.question.toLowerCase().includes(kw) || q.options.some(o => o.toLowerCase().includes(kw)));

  dom.lobbyListSummary.textContent = kw
    ? `${filteredIndices.length}/${allQuestions.length} câu khớp`
    : `${allQuestions.length} câu hỏi`;

  if (allQuestions.length === 0) {
    dom.lobbyQuestionsContainer.innerHTML = `
      <div class="rounded-2xl border-2 border-dashed border-white/15 bg-black/20 py-10 px-4 text-center space-y-2">
        <div class="text-3xl">📭</div>
        <p class="text-sm sm:text-base font-extrabold text-white">"${escapeHtml(activeMeta.name)}" chưa có câu hỏi nào</p>
        <p class="text-xs sm:text-sm text-purple-200/70 max-w-md mx-auto">
          Mở chế độ Chủ sở hữu để dán mã hoặc tạo câu hỏi mới cho bộ đề này.
        </p>
      </div>
    `;
    return;
  }

  if (filteredIndices.length === 0) {
    dom.lobbyQuestionsContainer.innerHTML = `
      <div class="rounded-2xl border border-white/10 bg-black/20 py-7 px-4 text-center text-xs sm:text-sm text-purple-200/75">
        Không tìm thấy câu hỏi nào khớp với "${escapeHtml(state.questionFilterText)}".
      </div>
    `;
    return;
  }

  const letters = ['A', 'B', 'C', 'D'];
  const listEl = document.createElement('div');
  listEl.className = 'space-y-2.5 max-h-80 overflow-y-auto pr-1';
  const frag = document.createDocumentFragment();

  filteredIndices.forEach(({ q, idx }) => {
    const correctLetter = letters[q.correctIndex] || 'A';
    const row = document.createElement('div');
    row.className = 'rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 p-3.5 flex items-center justify-between gap-3 transition';
    row.innerHTML = `
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-wider">
          <span class="text-[#ff7ab5]">Câu ${idx + 1}</span>
          <span class="text-purple-300/60">•</span>
          <span class="text-[#ffd000]">${q.timeLimit || 20}s</span>
          <span class="text-purple-300/60">•</span>
          <span class="text-emerald-300">Đáp án ${correctLetter}</span>
        </div>
        <p class="text-xs sm:text-sm font-bold text-white truncate mt-0.5">${escapeHtml(q.question)}</p>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-action="edit" class="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-[#ffd000] hover:text-[#1e0929] text-xs font-bold transition cursor-pointer">Sửa</button>
        <button type="button" data-action="delete" class="px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/35 text-rose-200 text-xs font-bold transition cursor-pointer">Xóa</button>
      </div>
    `;

    row.querySelector('[data-action="edit"]').addEventListener('click', () => {
      if (!requireEditor('sửa câu hỏi')) return;
      SoundEngine.click();
      openDrawer('form', idx);
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      deleteQuestionAt(idx);
    });
    frag.appendChild(row);
  });

  listEl.appendChild(frag);
  dom.lobbyQuestionsContainer.innerHTML = '';
  dom.lobbyQuestionsContainer.appendChild(listEl);
}

const QUIZIZZ_CARDS = [
  { cls: 'qz-card-red', shape: '▲', letter: 'A', key: '1 / A' },
  { cls: 'qz-card-blue', shape: '◆', letter: 'B', key: '2 / B' },
  { cls: 'qz-card-yellow', shape: '●', letter: 'C', key: '3 / C' },
  { cls: 'qz-card-green', shape: '■', letter: 'D', key: '4 / D' }
];

function switchView(target) {
  clearTimer();
  state.view = target;
  dom.lobbyView?.classList.toggle('hidden', target !== 'lobby');
  dom.gameView?.classList.toggle('hidden', target !== 'game');
  dom.summaryView?.classList.toggle('hidden', target !== 'summary');
  if (target === 'lobby') renderLobby();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getEffectiveQuestionTime(questionTime) {
  const override = dom.playTimeOverrideSelect?.value || 'default';
  if (override === 'default') {
    return { noLimit: false, seconds: questionTime || 20 };
  }
  const num = parseInt(override, 10);
  if (num === 0) {
    return { noLimit: true, seconds: 0 };
  }
  return { noLimit: false, seconds: Math.max(5, num) };
}

async function startGame(customQuestions = null) {
  const sourceQuestions = Array.isArray(customQuestions)
    ? customQuestions
    : await ensureSetQuestionsLoaded(state.activeSetId, false);

  if (sourceQuestions.length === 0) {
    showToast('Không có câu hỏi để bắt đầu lượt chơi.', 'error');
    return;
  }

  const shuffleQ = Boolean(dom.shuffleQuestionsCheckbox?.checked);
  const shuffleOpt = Boolean(dom.shuffleOptionsCheckbox?.checked);
  const orderedQuestions = shuffleQ ? shuffleArray(sourceQuestions) : sourceQuestions.slice();

  state.deck = orderedQuestions.map(q => {
    const pairs = q.options.map((text, origIdx) => ({
      text,
      isCorrect: origIdx === q.correctIndex
    }));
    return {
      ...q,
      shuffledOptions: shuffleOpt ? shuffleArray(pairs) : pairs
    };
  });

  state.currentIndex = 0;
  state.score = 0;
  state.streak = 0;
  state.maxStreak = 0;
  state.answeredCurrent = false;
  state.history = [];
  state.aiCacheBySharedKey = {};
  state.aiPendingKeys.clear();

  switchView('game');
  renderCurrentQuestion();
}

function practiceWrongQuestionsOnly() {
  const wrongItems = state.history
    .filter(h => !h.isCorrect)
    .map((h, i) => {
      const origCorrect = h.shuffledOptions.findIndex(o => o.isCorrect);
      return {
        id: `retry-${i}-${Date.now()}`,
        question: h.question,
        options: h.shuffledOptions.map(o => o.text),
        correctIndex: origCorrect >= 0 ? origCorrect : 0,
        timeLimit: 20,
        explanation: h.explanation || ''
      };
    });

  if (wrongItems.length === 0) {
    showToast('Bạn đã làm đúng hết tất cả câu hỏi rồi!', 'success');
    return;
  }
  SoundEngine.click();
  startGame(wrongItems);
}

function clearTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function renderCurrentQuestion() {
  clearTimer();
  state.answeredCurrent = false;
  dom.feedbackBanner?.classList.add('hidden');
  if (dom.aiFeedbackBox) {
    dom.aiFeedbackBox.classList.add('hidden');
    dom.aiFeedbackBox.innerHTML = '';
  }
  if (dom.askAiCurrentBtn) {
    dom.askAiCurrentBtn.disabled = false;
    dom.askAiCurrentBtn.textContent = '✨ Giải thích bằng AI';
  }

  const qItem = state.deck[state.currentIndex];
  const total = state.deck.length;

  if (dom.currentQNum) dom.currentQNum.textContent = state.currentIndex + 1;
  if (dom.totalQNum) dom.totalQNum.textContent = total;
  if (dom.streakCount) dom.streakCount.textContent = state.streak;
  if (dom.liveScore) dom.liveScore.textContent = state.score.toLocaleString('vi-VN');
  if (dom.questionPrompt) dom.questionPrompt.textContent = qItem.question;
  if (dom.nextQuestionBtn) {
    dom.nextQuestionBtn.textContent = state.currentIndex === total - 1 ? 'Xem tổng kết 🏆' : 'Câu tiếp theo →';
  }

  const gridFrag = document.createDocumentFragment();
  qItem.shuffledOptions.forEach((optObj, idx) => {
    const meta = QUIZIZZ_CARDS[idx % QUIZIZZ_CARDS.length];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.optionIdx = String(idx);
    btn.className = `qz-answer-card ${meta.cls} rounded-2xl p-4 sm:p-5 text-left text-white min-h-[104px] sm:min-h-[124px] flex items-center gap-3.5 sm:gap-4 cursor-pointer select-none focus:outline-none focus:ring-4 focus:ring-white/70`;
    btn.innerHTML = `
      <div class="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-black/20 flex flex-col items-center justify-center shrink-0 font-black">
        <span class="text-base sm:text-lg leading-none">${meta.shape}</span>
        <span class="text-[10px] tracking-wider opacity-90 mt-0.5">${meta.letter}</span>
      </div>
      <div class="flex-1 text-sm sm:text-base md:text-[17px] font-extrabold leading-snug">${escapeHtml(optObj.text)}</div>
      <span class="hidden sm:inline-block text-[11px] font-extrabold px-2 py-0.5 rounded-md bg-black/20 opacity-85 shrink-0">${meta.key}</span>
    `;
    btn.addEventListener('click', () => handleSelectOption(idx));
    gridFrag.appendChild(btn);
  });
  if (dom.answersGrid) {
    dom.answersGrid.innerHTML = '';
    dom.answersGrid.appendChild(gridFrag);
  }

  const timeCfg = getEffectiveQuestionTime(qItem.timeLimit || 20);
  state.noTimeLimit = timeCfg.noLimit;
  state.currentTimeLimit = timeCfg.seconds;
  state.timeLeft = timeCfg.seconds;
  updateTimerDisplay();

  if (state.noTimeLimit) return;

  state.timerInterval = setInterval(() => {
    if (state.answeredCurrent) {
      clearTimer();
      return;
    }
    state.timeLeft = Math.max(0, Number((state.timeLeft - 0.1).toFixed(1)));
    updateTimerDisplay();
    const whole = Math.ceil(state.timeLeft);
    if (Math.abs(state.timeLeft - whole) < 0.06 && whole > 0 && whole <= 5) {
      SoundEngine.tick(true);
    }
    if (state.timeLeft <= 0) {
      clearTimer();
      handleTimeout();
    }
  }, 100);
}

function updateTimerDisplay() {
  if (!dom.timerText || !dom.timerBar || !dom.timerPill) return;
  if (state.noTimeLimit) {
    dom.timerText.textContent = '∞';
    if (dom.timerUnitText) dom.timerUnitText.textContent = 'tự do';
    dom.timerBar.style.width = '100%';
    dom.timerPill.classList.remove('timer-urgent');
    return;
  }
  const sec = Math.ceil(state.timeLeft);
  dom.timerText.textContent = sec;
  if (dom.timerUnitText) dom.timerUnitText.textContent = 'giây';
  const pct = Math.max(0, Math.min(100, (state.timeLeft / Math.max(1, state.currentTimeLimit)) * 100));
  dom.timerBar.style.width = `${pct}%`;
  dom.timerPill.classList.toggle('timer-urgent', sec <= 5 && !state.answeredCurrent);
}

function lockCards(selectedIdx, correctIdx) {
  if (!dom.answersGrid) return;
  const btns = dom.answersGrid.querySelectorAll('button[data-option-idx]');
  btns.forEach((btn, idx) => {
    btn.disabled = true;
    if (idx === correctIdx) btn.classList.add('ring-4', 'ring-white', 'scale-[1.02]');
    else if (idx === selectedIdx && idx !== correctIdx) btn.classList.add('opacity-90', 'animate-shake');
    else btn.classList.add('opacity-40', 'saturate-50');
  });
}

function computePoints(isCorrect, timeLeft, timeLimit, streak, noLimit = false) {
  if (!isCorrect) return 0;
  const base = 1000;
  const speedBonus = noLimit
    ? 250
    : Math.round(500 * Math.max(0, Math.min(1, timeLeft / Math.max(1, timeLimit))));
  const streakBonus = Math.min(streak, 10) * 100;
  return base + speedBonus + streakBonus;
}

function handleSelectOption(choiceIdx) {
  if (state.answeredCurrent) return;
  state.answeredCurrent = true;
  clearTimer();

  const qItem = state.deck[state.currentIndex];
  const correctIdx = qItem.shuffledOptions.findIndex(o => o.isCorrect);
  const isCorrect = choiceIdx === correctIdx;
  lockCards(choiceIdx, correctIdx);

  let pointsEarned = 0;
  if (isCorrect) {
    state.streak += 1;
    state.maxStreak = Math.max(state.maxStreak, state.streak);
    pointsEarned = computePoints(true, state.timeLeft, state.currentTimeLimit, state.streak, state.noTimeLimit);
    state.score += pointsEarned;
    SoundEngine.correct(state.streak);
    showFeedback({ isCorrect: true, timedOut: false, pointsEarned, explanation: qItem.explanation });
  } else {
    state.streak = 0;
    SoundEngine.wrong();
    showFeedback({
      isCorrect: false,
      timedOut: false,
      pointsEarned: 0,
      explanation: qItem.explanation,
      correctText: qItem.shuffledOptions[correctIdx]?.text || ''
    });
  }

  if (dom.streakCount) dom.streakCount.textContent = state.streak;
  if (dom.liveScore) dom.liveScore.textContent = state.score.toLocaleString('vi-VN');
  state.history.push({
    question: qItem.question,
    shuffledOptions: qItem.shuffledOptions,
    userChoiceIndex: choiceIdx,
    correctIndex: correctIdx,
    isCorrect,
    pointsEarned,
    timedOut: false,
    explanation: qItem.explanation
  });
}

function handleTimeout() {
  if (state.answeredCurrent) return;
  state.answeredCurrent = true;
  const qItem = state.deck[state.currentIndex];
  const correctIdx = qItem.shuffledOptions.findIndex(o => o.isCorrect);
  state.streak = 0;
  if (dom.streakCount) dom.streakCount.textContent = 0;
  SoundEngine.timeout();
  lockCards(-1, correctIdx);
  showFeedback({
    isCorrect: false,
    timedOut: true,
    pointsEarned: 0,
    explanation: qItem.explanation,
    correctText: qItem.shuffledOptions[correctIdx]?.text || ''
  });
  state.history.push({
    question: qItem.question,
    shuffledOptions: qItem.shuffledOptions,
    userChoiceIndex: -1,
    correctIndex: correctIdx,
    isCorrect: false,
    pointsEarned: 0,
    timedOut: true,
    explanation: qItem.explanation
  });
}

function showFeedback({ isCorrect, timedOut, pointsEarned, explanation, correctText }) {
  if (!dom.feedbackBanner || !dom.feedbackTitle || !dom.feedbackPointsPill || !dom.feedbackExplanation) return;
  dom.feedbackBanner.classList.remove('hidden');
  if (isCorrect) {
    dom.feedbackTitle.className = 'text-lg sm:text-xl font-black text-emerald-300';
    dom.feedbackTitle.textContent = state.streak >= 2 ? `🎉 Chính xác! Streak ${state.streak}!` : '🎉 Chính xác!';
    dom.feedbackPointsPill.className = 'px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-500/25 text-emerald-200 border border-emerald-400/40';
    dom.feedbackPointsPill.textContent = `+${pointsEarned.toLocaleString('vi-VN')} điểm`;
  } else if (timedOut) {
    dom.feedbackTitle.className = 'text-lg sm:text-xl font-black text-[#ffd000]';
    dom.feedbackTitle.textContent = '⏰ Hết giờ!';
    dom.feedbackPointsPill.className = 'px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-white/10 text-purple-200';
    dom.feedbackPointsPill.textContent = '+0 điểm';
  } else {
    dom.feedbackTitle.className = 'text-lg sm:text-xl font-black text-rose-400';
    dom.feedbackTitle.textContent = '💥 Chưa chính xác!';
    dom.feedbackPointsPill.className = 'px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-rose-500/20 text-rose-200 border border-rose-400/30';
    dom.feedbackPointsPill.textContent = '+0 điểm';
  }
  const details = [];
  if (!isCorrect && correctText) details.push(`Đáp án đúng: "${correctText}".`);
  if (explanation) details.push(explanation);
  dom.feedbackExplanation.textContent = details.join(' ');
}

async function handleAskAiForCurrentQuestion() {
  if (!state.answeredCurrent) return;
  const currentRecord = state.history[state.history.length - 1];
  if (!currentRecord || !dom.aiFeedbackBox) return;

  const sharedKey = getSharedAiCacheKey(currentRecord);
  if (state.aiPendingKeys.has(sharedKey)) return;

  dom.aiFeedbackBox.classList.remove('hidden');
  if (state.aiCacheBySharedKey[sharedKey]) {
    dom.aiFeedbackBox.innerHTML = renderAiResultHtml(state.aiCacheBySharedKey[sharedKey]);
    return;
  }

  state.aiPendingKeys.add(sharedKey);
  if (dom.askAiCurrentBtn) {
    dom.askAiCurrentBtn.disabled = true;
    dom.askAiCurrentBtn.textContent = '⏳ Đang hỏi AI...';
  }
  dom.aiFeedbackBox.innerHTML = `<p class="text-purple-200/80 animate-pulse">Đang phân tích câu hỏi và các phương án...</p>`;

  try {
    const prompt = buildQuestionContextPrompt(currentRecord, getActiveMeta().name);
    const answerText = await requestGeminiExplanation(prompt);
    state.aiCacheBySharedKey[sharedKey] = answerText;
    dom.aiFeedbackBox.innerHTML = renderAiResultHtml(answerText);
  } catch (err) {
    if (err?.message === 'NO_API_KEY') {
      dom.aiFeedbackBox.innerHTML = `<p class="text-amber-200 font-bold">Chưa có Gemini API Key trên trình duyệt này. Đang mở khung cấu hình key...</p>`;
      openAiKeyModal();
    } else {
      dom.aiFeedbackBox.innerHTML = `<p class="text-rose-300 font-bold">${escapeHtml(err?.message || 'Không thể lấy giải thích từ AI.')}</p>`;
    }
  } finally {
    state.aiPendingKeys.delete(sharedKey);
    if (dom.askAiCurrentBtn) {
      dom.askAiCurrentBtn.disabled = false;
      dom.askAiCurrentBtn.textContent = '✨ Giải thích bằng AI';
    }
  }
}

function nextQuestion() {
  SoundEngine.click();
  if (state.currentIndex + 1 < state.deck.length) {
    state.currentIndex += 1;
    renderCurrentQuestion();
  } else {
    renderSummary();
  }
}

function renderSummary() {
  clearTimer();
  switchView('summary');
  SoundEngine.victory();

  const total = state.history.length;
  const rightCount = state.history.filter(h => h.isCorrect).length;
  const wrongCount = total - rightCount;
  const accuracy = total > 0 ? Math.round((rightCount / total) * 100) : 0;

  if (dom.finalScoreText) dom.finalScoreText.textContent = state.score.toLocaleString('vi-VN');
  if (dom.finalAccuracyText) dom.finalAccuracyText.textContent = `${accuracy}%`;
  if (dom.finalMaxStreakText) dom.finalMaxStreakText.textContent = `${state.maxStreak}🔥`;
  if (dom.finalRightWrongText) dom.finalRightWrongText.textContent = `${rightCount} / ${wrongCount}`;
  if (dom.reviewSummaryCount) dom.reviewSummaryCount.textContent = `Đúng ${rightCount}/${total} câu`;
  if (dom.practiceMistakesBtn) {
    dom.practiceMistakesBtn.classList.toggle('hidden', wrongCount === 0);
    dom.practiceMistakesBtn.textContent = `🎯 Ôn lại ${wrongCount} câu sai`;
  }

  if (dom.summaryTrophy) dom.summaryTrophy.textContent = accuracy >= 80 ? '🏆' : accuracy >= 50 ? '🥈' : '🎯';
  if (dom.summaryHeadline) dom.summaryHeadline.textContent = accuracy >= 80 ? 'Xuất Sắc! Phá Đảo Bộ Đề!' : 'Hoàn Thành Lượt Chơi!';
  if (dom.summarySubtext) {
    dom.summarySubtext.textContent = wrongCount > 0
      ? `Bạn có thể bấm "Ôn lại ${wrongCount} câu sai" để luyện tập thêm các câu chưa đúng.`
      : 'Tuyệt đối chính xác toàn bộ câu hỏi trong lượt chơi này!';
  }

  if (!dom.reviewList) return;
  const reviewFrag = document.createDocumentFragment();
  state.history.forEach((item, idx) => {
    const card = document.createElement('div');
    const boxStyle = item.isCorrect ? 'border-emerald-400/35 bg-emerald-950/25' : 'border-rose-400/35 bg-rose-950/25';
    const userChoiceText = item.userChoiceIndex >= 0 && item.shuffledOptions[item.userChoiceIndex]
      ? item.shuffledOptions[item.userChoiceIndex].text
      : 'Không chọn (Hết thời gian)';
    const rightChoiceText = item.shuffledOptions[item.correctIndex]?.text || '';
    const sharedKey = getSharedAiCacheKey(item);
    const cachedAi = state.aiCacheBySharedKey[sharedKey];

    card.className = `rounded-2xl border ${boxStyle} p-4 sm:p-5 space-y-2.5`;
    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-extrabold uppercase tracking-wider text-purple-200/80">Câu ${idx + 1}</span>
        <div class="flex items-center gap-2">
          <button type="button" data-ai-review="1" class="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 border border-[#ffd000]/40 text-[#ffd000] text-[11px] font-extrabold disabled:opacity-50 cursor-pointer">${cachedAi ? '✨ Xem lại AI' : '✨ Hỏi AI'}</button>
          <span class="text-xs font-extrabold">${item.isCorrect ? '✓ Đúng' : '✕ Chưa đúng'}</span>
        </div>
      </div>
      <p class="font-bold text-sm sm:text-base text-white">${escapeHtml(item.question)}</p>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs sm:text-sm">
        <div class="rounded-xl p-2.5 bg-black/25">
          <span class="font-bold block text-[11px] uppercase opacity-75">Bạn đã chọn</span>
          ${escapeHtml(userChoiceText)}
        </div>
        <div class="rounded-xl p-2.5 bg-emerald-500/15 border border-emerald-400/30 text-emerald-100">
          <span class="font-bold block text-[11px] uppercase opacity-75">Đáp án đúng</span>
          ${escapeHtml(rightChoiceText)}
        </div>
      </div>
      ${item.explanation ? `<p class="text-xs sm:text-sm text-purple-100/90"><strong class="text-[#ffd000]">Giải thích:</strong> ${escapeHtml(item.explanation)}</p>` : ''}
      <div data-ai-box="1" class="${cachedAi ? '' : 'hidden '}rounded-xl bg-black/35 border border-[#ff2a85]/35 p-3 text-xs sm:text-sm text-purple-100 leading-relaxed space-y-1">${cachedAi ? renderAiResultHtml(cachedAi) : ''}</div>
    `;

    const aiBtn = card.querySelector('[data-ai-review="1"]');
    const aiBox = card.querySelector('[data-ai-box="1"]');
    aiBtn?.addEventListener('click', async () => {
      if (!aiBox || state.aiPendingKeys.has(sharedKey)) return;
      aiBox.classList.remove('hidden');
      if (state.aiCacheBySharedKey[sharedKey]) {
        aiBox.innerHTML = renderAiResultHtml(state.aiCacheBySharedKey[sharedKey]);
        aiBtn.textContent = '✨ Xem lại AI';
        return;
      }
      state.aiPendingKeys.add(sharedKey);
      aiBtn.disabled = true;
      aiBtn.textContent = '⏳ Đang hỏi...';
      aiBox.innerHTML = `<p class="text-purple-200/80 animate-pulse">Đang lấy giải thích từ Gemini...</p>`;
      try {
        const prompt = buildQuestionContextPrompt(item, getActiveMeta().name);
        const answerText = await requestGeminiExplanation(prompt);
        state.aiCacheBySharedKey[sharedKey] = answerText;
        aiBox.innerHTML = renderAiResultHtml(answerText);
        aiBtn.textContent = '✨ Xem lại AI';
      } catch (err) {
        if (err?.message === 'NO_API_KEY') {
          aiBox.innerHTML = `<p class="text-amber-200 font-bold">Chưa có Gemini API Key trên trình duyệt này. Đang mở khung cấu hình key...</p>`;
          openAiKeyModal();
        } else {
          aiBox.innerHTML = `<p class="text-rose-300 font-bold">${escapeHtml(err?.message || 'Không thể lấy giải thích từ AI.')}</p>`;
        }
      } finally {
        state.aiPendingKeys.delete(sharedKey);
        aiBtn.disabled = false;
      }
    });

    reviewFrag.appendChild(card);
  });
  dom.reviewList.innerHTML = '';
  dom.reviewList.appendChild(reviewFrag);
}

async function openDrawer(tab = 'bulk', editIdx = null, suggestNewSet = false) {
  if (!requireEditor('mở khung nhập/sửa câu hỏi')) return;
  setDrawerTab(tab);
  if (tab === 'bulk') {
    if (dom.targetSetNameInput) {
      dom.targetSetNameInput.value = suggestNewSet ? `Đề ${state.setsMeta.length + 1}` : '';
    }
    setTimeout(() => dom.bulkPasteTextarea?.focus(), 120);
  } else {
    await ensureSetQuestionsLoaded(state.activeSetId, false);
    if (editIdx !== null && getActiveQuestions()[editIdx]) loadQuestionIntoForm(editIdx);
    else resetManualFormFields();
  }
  dom.builderOverlay?.classList.remove('hidden');
  requestAnimationFrame(() => dom.builderDrawer?.classList.remove('translate-x-full'));
}

function closeDrawer() {
  dom.builderDrawer?.classList.add('translate-x-full');
  setTimeout(() => dom.builderOverlay?.classList.add('hidden'), 280);
}

function setDrawerTab(tab) {
  state.drawerTab = tab;
  const isBulk = tab === 'bulk';
  dom.bulkModePanel?.classList.toggle('hidden', !isBulk);
  dom.formModePanel?.classList.toggle('hidden', isBulk);
}

function renderDrawerQuestionLists() {
  const questions = getActiveQuestions();
  [dom.bulkLoadedList, dom.formLoadedList].forEach(container => {
    if (!container) return;
    if (questions.length === 0) {
      container.innerHTML = `<p class="text-xs text-purple-200/60 italic py-2 text-center">Chưa có câu hỏi nào.</p>`;
      return;
    }
    const frag = document.createDocumentFragment();
    questions.forEach((q, idx) => {
      const item = document.createElement('div');
      item.className = 'rounded-xl bg-black/30 border border-white/10 px-3 py-2 flex items-center justify-between gap-2';
      item.innerHTML = `
        <div class="min-w-0 flex-1">
          <span class="text-[11px] font-extrabold text-[#ff7ab5]">Câu ${idx + 1} (${q.timeLimit || 20}s):</span>
          <span class="text-xs text-white truncate inline-block align-bottom max-w-[72%]">${escapeHtml(q.question)}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" data-act="edit" class="px-2 py-1 rounded bg-white/10 hover:bg-[#ffd000] hover:text-[#1e0929] text-[11px] font-bold cursor-pointer">Sửa</button>
          <button type="button" data-act="del" class="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-200 text-[11px] font-bold cursor-pointer">Xóa</button>
        </div>
      `;
      item.querySelector('[data-act="edit"]').addEventListener('click', () => {
        if (!requireEditor('sửa câu hỏi')) return;
        setDrawerTab('form');
        loadQuestionIntoForm(idx);
      });
      item.querySelector('[data-act="del"]').addEventListener('click', () => deleteQuestionAt(idx));
      frag.appendChild(item);
    });
    container.innerHTML = '';
    container.appendChild(frag);
  });
}

function parseQuizInput(raw, fallbackTimeLimit = 20) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Ô nhập đang trống.');

  if (text.startsWith('[') || text.startsWith('{')) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : (Array.isArray(data.questions) ? data.questions : null);
    if (!arr || arr.length === 0) throw new Error('JSON phải là mảng chứa ít nhất 1 câu hỏi.');
    return arr.map((item, idx) => {
      const question = String(item.question || '').trim();
      const options = Array.isArray(item.options) ? item.options.map(o => String(o || '').trim()) : [];
      if (!question || options.length !== 4 || options.some(o => !o)) {
        throw new Error(`Câu #${idx + 1} thiếu nội dung hoặc đủ 4 đáp án.`);
      }
      return {
        id: `q-${Date.now()}-${idx}`,
        question,
        options,
        correctIndex: Number.isInteger(item.correctIndex) && item.correctIndex >= 0 && item.correctIndex <= 3 ? item.correctIndex : 0,
        timeLimit: Number.isFinite(Number(item.timeLimit))
          ? Math.max(5, Math.min(300, Math.round(Number(item.timeLimit))))
          : fallbackTimeLimit,
        explanation: String(item.explanation || '').trim()
      };
    });
  }

  const blocks = text.split(/\n\s*\n+/);
  const result = [];
  blocks.forEach((block, bIdx) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    let question = '';
    const options = [];
    let correctIndex = 0;
    let explanation = '';

    lines.forEach(line => {
      const expMatch = line.match(/^(?:giải thích|explanation|lời giải)\s*:\s*(.+)$/i);
      if (expMatch) { explanation = expMatch[1].trim(); return; }
      const optMatch = line.match(/^(\*)?\s*([A-Da-d1-4])\s*[\.\)\:\-]\s*(.+)$/);
      if (optMatch && options.length < 4) {
        const cleanOpt = optMatch[3].replace(/\*+$/, '').trim();
        const pos = options.length;
        options.push(cleanOpt);
        if (optMatch[1] || /\*$/.test(optMatch[3].trim())) correctIndex = pos;
        return;
      }
      if (!question) question = line.replace(/^(?:câu\s*\d+\s*[\.\:\-]?)\s*/i, '').trim();
      else if (options.length === 0) question += ' ' + line;
    });

    if (question && options.length === 4 && options.every(Boolean)) {
      result.push({
        id: `q-txt-${Date.now()}-${bIdx}`,
        question,
        options,
        correctIndex,
        timeLimit: fallbackTimeLimit,
        explanation
      });
    }
  });

  if (result.length === 0) throw new Error('Không đọc được câu hỏi hợp lệ.');
  return result;
}

async function handleSaveAsNewSet() {
  if (!requireEditor('lưu bộ đề mới') || state.isBusy) return;
  try {
    const defaultTime = Math.max(5, Math.min(300, parseInt(dom.bulkDefaultTimeInput?.value, 10) || 20));
    const parsed = parseQuizInput(dom.bulkPasteTextarea?.value, defaultTime);
    setBusyState(true);
    const name = dom.targetSetNameInput?.value.trim() || `Đề ${state.setsMeta.length + 1}`;
    const newId = `set-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newMeta = makeMetaEntry(newId, name, parsed.length, false);
    state.setsMeta = normalizeMetaList(state.setsMeta.concat(newMeta));
    state.activeSetId = newId;
    state.questionsBySetId[newId] = parsed;
    state.loadedSetIds.add(newId);
    saveLightweightPref();
    syncAllUI();
    await fbPut(SET_ENDPOINT(newId), parsed);
    await fbPut(META_ENDPOINT, state.setsMeta);
    if (dom.bulkPasteTextarea) dom.bulkPasteTextarea.value = '';
    if (dom.targetSetNameInput) dom.targetSetNameInput.value = '';
    SoundEngine.correct(1);
    showToast(`Đã lưu "${name}" (${parsed.length} câu, ${defaultTime}s/câu)!`, 'success');
  } catch (err) {
    SoundEngine.wrong();
    showToast(err.message || 'Lỗi dữ liệu.', 'error');
  } finally {
    setBusyState(false);
  }
}

async function handleAppendIntoTargetSet() {
  if (!requireEditor('nạp thêm câu hỏi') || state.isBusy) return;
  try {
    const defaultTime = Math.max(5, Math.min(300, parseInt(dom.bulkDefaultTimeInput?.value, 10) || 20));
    const parsed = parseQuizInput(dom.bulkPasteTextarea?.value, defaultTime);
    setBusyState(true);
    const customName = dom.targetSetNameInput?.value.trim() || '';
    let targetId = state.activeSetId;

    if (customName) {
      const existing = state.setsMeta.find(m => m.name.toLowerCase() === customName.toLowerCase());
      if (existing) {
        targetId = existing.id;
        state.activeSetId = targetId;
        const cur = await ensureSetQuestionsLoaded(targetId, false);
        await writeSetQuestionsAndMeta(targetId, cur.concat(parsed));
      } else {
        targetId = `set-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        state.setsMeta = normalizeMetaList(state.setsMeta.concat(makeMetaEntry(targetId, customName, parsed.length, false)));
        state.activeSetId = targetId;
        await writeSetQuestionsAndMeta(targetId, parsed);
      }
    } else {
      const cur = await ensureSetQuestionsLoaded(targetId, false);
      await writeSetQuestionsAndMeta(targetId, cur.concat(parsed));
    }

    if (dom.bulkPasteTextarea) dom.bulkPasteTextarea.value = '';
    if (dom.targetSetNameInput) dom.targetSetNameInput.value = '';
    SoundEngine.correct(1);
    showToast(`Đã thêm ${parsed.length} câu vào "${getActiveMeta().name}"!`, 'success');
  } catch (err) {
    SoundEngine.wrong();
    showToast(err.message || 'Lỗi dữ liệu.', 'error');
  } finally {
    setBusyState(false);
  }
}

function resetManualFormFields() {
  state.editingIndex = null;
  if (dom.formHeaderTitle) dom.formHeaderTitle.textContent = `Thêm câu hỏi vào "${getActiveMeta().name}"`;
  [dom.qPromptInput, dom.qOpt0, dom.qOpt1, dom.qOpt2, dom.qOpt3, dom.qExplainInput].forEach(el => {
    if (el) el.value = '';
  });
  if (dom.qCorrectSelect) dom.qCorrectSelect.value = '0';
  if (dom.qTimeInput) dom.qTimeInput.value = '20';
}

function loadQuestionIntoForm(idx) {
  const q = getActiveQuestions()[idx];
  if (!q) return;
  state.editingIndex = idx;
  if (dom.formHeaderTitle) dom.formHeaderTitle.textContent = `Đang sửa Câu #${idx + 1} (${getActiveMeta().name})`;
  if (dom.qPromptInput) dom.qPromptInput.value = q.question || '';
  if (dom.qCorrectSelect) dom.qCorrectSelect.value = String(q.correctIndex ?? 0);
  if (dom.qTimeInput) dom.qTimeInput.value = String(q.timeLimit || 20);
  if (dom.qOpt0) dom.qOpt0.value = q.options[0] || '';
  if (dom.qOpt1) dom.qOpt1.value = q.options[1] || '';
  if (dom.qOpt2) dom.qOpt2.value = q.options[2] || '';
  if (dom.qOpt3) dom.qOpt3.value = q.options[3] || '';
  if (dom.qExplainInput) dom.qExplainInput.value = q.explanation || '';
}

async function saveManualQuestion() {
  if (!requireEditor('lưu câu hỏi') || state.isBusy) return;
  const question = dom.qPromptInput?.value.trim() || '';
  const options = [
    dom.qOpt0?.value.trim() || '',
    dom.qOpt1?.value.trim() || '',
    dom.qOpt2?.value.trim() || '',
    dom.qOpt3?.value.trim() || ''
  ];
  if (!question || options.some(o => !o)) {
    showToast('Vui lòng nhập đầy đủ câu hỏi và 4 đáp án.', 'error');
    return;
  }

  setBusyState(true);
  const activeId = state.activeSetId;
  const currentQs = (await ensureSetQuestionsLoaded(activeId, false)).slice();
  const rec = {
    id: state.editingIndex !== null && currentQs[state.editingIndex] ? currentQs[state.editingIndex].id : `q-${Date.now()}`,
    question,
    options,
    correctIndex: parseInt(dom.qCorrectSelect?.value, 10) || 0,
    timeLimit: Math.max(5, Math.min(300, parseInt(dom.qTimeInput?.value, 10) || 20)),
    explanation: dom.qExplainInput?.value.trim() || ''
  };

  if (state.editingIndex !== null && currentQs[state.editingIndex]) currentQs[state.editingIndex] = rec;
  else currentQs.push(rec);

  resetManualFormFields();
  await writeSetQuestionsAndMeta(activeId, currentQs);
  setBusyState(false);
  SoundEngine.correct(1);
  showToast(`Đã lưu câu hỏi vào "${getActiveMeta().name}"!`, 'success');
}

function bindEvents() {
  dom.aiKeyModalBtn?.addEventListener('click', openAiKeyModal);
  dom.closeAiKeyModalBtn?.addEventListener('click', closeAiKeyModal);
  dom.toggleGeminiKeyVisibilityBtn?.addEventListener('click', () => {
    const currentlyHidden = dom.geminiApiKeyInput?.type === 'password';
    setGeminiKeyInputVisibility(currentlyHidden);
  });
  dom.aiKeyOverlay?.addEventListener('click', (e) => {
    if (e.target === dom.aiKeyOverlay) closeAiKeyModal();
  });
  dom.saveGeminiApiKeyBtn?.addEventListener('click', () => {
    const check = validateGeminiKeyFormat(dom.geminiApiKeyInput?.value || '');
    if (!check.ok) {
      showToast(check.message, 'error');
      dom.geminiApiKeyInput?.focus();
      return;
    }
    setGeminiApiKey(check.value);
    updateAiKeyBadge();
    closeAiKeyModal();
    showToast('Đã lưu Gemini API Key vào trình duyệt!', 'success');
  });
  dom.clearGeminiApiKeyBtn?.addEventListener('click', () => {
    setGeminiApiKey('');
    if (dom.geminiApiKeyInput) dom.geminiApiKeyInput.value = '';
    setGeminiKeyInputVisibility(false);
    updateAiKeyBadge();
    showToast('Đã xóa Gemini API Key khỏi trình duyệt.', 'info');
  });
  dom.askAiCurrentBtn?.addEventListener('click', handleAskAiForCurrentQuestion);

  dom.ownerUnlockBtn?.addEventListener('click', unlockOwnerMode);
  dom.ownerLockBtn?.addEventListener('click', lockOwnerMode);
  dom.ownerPinInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockOwnerMode(); });
  dom.sendAccessRequestBtn?.addEventListener('click', submitEditRequest);

  dom.refreshCloudBtn?.addEventListener('click', async () => {
    if (state.isBusy) return;
    setBusyState(true);
    await refreshMetaOnly(true);
    if (state.isOwner) await loadAccessRequests();
    else await checkGuestRequestStatus();
    setBusyState(false);
    showToast('Đã đồng bộ lại dữ liệu mới nhất!', 'success');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.view === 'lobby' && !state.isBusy) {
      refreshMetaOnly(false);
      if (!state.isOwner) checkGuestRequestStatus();
    }
  });

  dom.soundToggleBtn?.addEventListener('click', () => {
    const next = !SoundEngine.isEnabled();
    SoundEngine.setEnabled(next);
    dom.soundToggleBtn.setAttribute('aria-pressed', String(next));
    if (dom.soundIcon) dom.soundIcon.textContent = next ? '🔊' : '🔇';
    if (dom.soundLabel) dom.soundLabel.textContent = next ? 'Âm thanh: Bật' : 'Âm thanh: Tắt';
  });

  dom.homeLogoBtn?.addEventListener('click', () => switchView('lobby'));
  dom.backToLobbyBtn?.addEventListener('click', () => switchView('lobby'));
  dom.exitGameBtn?.addEventListener('click', () => switchView('lobby'));

  dom.setFilterInput?.addEventListener('input', (e) => {
    state.setFilterText = e.target.value || '';
    renderSetSelector();
  });

  dom.questionSearchInput?.addEventListener('input', (e) => {
    state.questionFilterText = e.target.value || '';
    renderLobby();
  });

  dom.quizSetSelect?.addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id || id === state.activeSetId) return;
    resetDeleteGuard();
    state.activeSetId = id;
    state.editingIndex = null;
    saveLightweightPref();
    syncAllUI();
    await ensureSetQuestionsLoaded(id, false);
  });

  dom.applyTimeToAllBtn?.addEventListener('click', applyTimeToEntireActiveSet);
  dom.pinSetBtn?.addEventListener('click', togglePinActiveSet);
  dom.duplicateSetBtn?.addEventListener('click', duplicateActiveSet);
  dom.quickNewSetBtn?.addEventListener('click', () => createBlankQuizSet());
  dom.deleteCurrentSetBtn?.addEventListener('click', deleteCurrentSet);
  dom.drawerClearCurrentSetBtn?.addEventListener('click', clearCurrentSetQuestions);
  dom.undoDeleteBtn?.addEventListener('click', undoLastDeletedQuestion);

  dom.copySetJsonBtn?.addEventListener('click', async () => {
    const qs = await ensureSetQuestionsLoaded(state.activeSetId, false);
    if (!qs.length) return showToast('Bộ đề trống.', 'error');
    await navigator.clipboard.writeText(JSON.stringify(qs, null, 2));
    showToast(`Đã sao chép JSON (${qs.length} câu)!`, 'success');
  });

  dom.downloadSetJsonBtn?.addEventListener('click', async () => {
    const qs = await ensureSetQuestionsLoaded(state.activeSetId, false);
    if (!qs.length) return showToast('Bộ đề trống.', 'error');
    const blob = new Blob([JSON.stringify(qs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getActiveMeta().name}.json`;
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  dom.renameSetBtn?.addEventListener('click', () => {
    if (!requireEditor('đổi tên bộ đề')) return;
    const willShow = dom.renameSetBox?.classList.contains('hidden');
    dom.renameSetBox?.classList.toggle('hidden', !willShow);
    if (willShow && dom.renameSetInput) {
      dom.renameSetInput.value = getActiveMeta().name;
      dom.renameSetInput.focus();
      dom.renameSetInput.select();
    }
  });

  dom.renameSetInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      renameActiveSet();
    } else if (e.key === 'Escape') {
      dom.renameSetBox?.classList.add('hidden');
    }
  });

  dom.confirmRenameSetBtn?.addEventListener('click', renameActiveSet);
  dom.lobbyPasteCodeBtn?.addEventListener('click', () => openDrawer('bulk', null, true));
  dom.headerPasteBtn?.addEventListener('click', () => openDrawer('bulk', null, false));
  dom.lobbyManualCreateBtn?.addEventListener('click', () => openDrawer('form', null, false));

  dom.startGameBtn?.addEventListener('click', () => startGame());
  dom.playAgainBtn?.addEventListener('click', () => startGame());
  dom.practiceMistakesBtn?.addEventListener('click', practiceWrongQuestionsOnly);
  dom.playFromDrawerBtn?.addEventListener('click', () => { closeDrawer(); startGame(); });
  dom.loadNewCodeBtn?.addEventListener('click', () => { switchView('lobby'); openDrawer('bulk', null, true); });
  dom.nextQuestionBtn?.addEventListener('click', nextQuestion);

  dom.closeBuilderBtn?.addEventListener('click', closeDrawer);
  dom.builderOverlay?.addEventListener('click', closeDrawer);
  dom.tabBulkMode?.addEventListener('click', () => setDrawerTab('bulk'));
  dom.tabFormMode?.addEventListener('click', () => setDrawerTab('form'));
  dom.clearTextareaBtn?.addEventListener('click', () => { if (dom.bulkPasteTextarea) dom.bulkPasteTextarea.value = ''; });
  dom.saveAsNewSetBtn?.addEventListener('click', handleSaveAsNewSet);
  dom.appendImportBtn?.addEventListener('click', handleAppendIntoTargetSet);
  dom.resetFormFieldsBtn?.addEventListener('click', resetManualFormFields);
  dom.saveManualQuestionBtn?.addEventListener('click', saveManualQuestion);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.aiKeyOverlay && !dom.aiKeyOverlay.classList.contains('hidden')) {
      closeAiKeyModal();
      return;
    }
    if (e.key === 'Escape' && dom.builderDrawer && !dom.builderDrawer.classList.contains('translate-x-full')) {
      closeDrawer();
      return;
    }
    if (state.view !== 'game' || (dom.builderDrawer && !dom.builderDrawer.classList.contains('translate-x-full'))) return;
    const k = e.key.toLowerCase();
    if (!state.answeredCurrent) {
      const map = { '1': 0, 'a': 0, '2': 1, 'b': 1, '3': 2, 'c': 2, '4': 3, 'd': 3 };
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        e.preventDefault();
        handleSelectOption(map[k]);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      nextQuestion();
    }
  });
}

window.addEventListener('unhandledrejection', (e) => {
  showToast(`Lỗi chạy ngầm: ${e.reason?.message || e.reason || 'không xác định'}`, 'error');
});

window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  syncAllUI();
  initCloudMetadataAndActiveSet();
});
