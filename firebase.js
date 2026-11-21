/**
 * Firebase Realtime Database client for Quizizz Mini
 * - Lazy-loads only the selected quiz set via /quizizz_mini/sets_meta.json and /quizizz_mini/sets/{setId}.json
 * - Supports Owner PIN ('226') & Approval-based Edit Access via /quizizz_mini/access_requests.json
 */

export const FIREBASE_DB_URL = 'https://quizizz-mini-shared-e3865-default-rtdb.asia-southeast1.firebasedatabase.app';
export const META_PATH = '/quizizz_mini/sets_meta.json';
export const SET_QUESTIONS_PATH = (setId) => `/quizizz_mini/sets/${encodeURIComponent(setId)}.json`;
export const REQUESTS_PATH = '/quizizz_mini/access_requests.json';
export const LEGACY_MULTI_PATH = '/quizizz_mini/quiz_sets.json';
export const LEGACY_SINGLE_PATH = '/quizizz_mini/shared_questions.json';

export const OWNER_PIN_CODE = '226';
const OWNER_SESSION_KEY = 'quizizz_mini_owner_unlocked_v1';
const MY_REQUEST_ID_KEY = 'quizizz_mini_my_request_id_v1';
const DEFAULT_TIMEOUT_MS = 8000;

export function isOwnerUnlocked() {
  try {
    return sessionStorage.getItem(OWNER_SESSION_KEY) === '1' || localStorage.getItem(OWNER_SESSION_KEY) === '1';
  } catch (e) {
    return false;
  }
}

export function setOwnerUnlocked(unlocked, remember = true) {
  try {
    if (unlocked) {
      sessionStorage.setItem(OWNER_SESSION_KEY, '1');
      if (remember) localStorage.setItem(OWNER_SESSION_KEY, '1');
    } else {
      sessionStorage.removeItem(OWNER_SESSION_KEY);
      localStorage.removeItem(OWNER_SESSION_KEY);
    }
  } catch (e) {}
}

export function getSavedRequestId() {
  try {
    return localStorage.getItem(MY_REQUEST_ID_KEY) || '';
  } catch (e) {
    return '';
  }
}

export function setSavedRequestId(reqId) {
  try {
    if (reqId) localStorage.setItem(MY_REQUEST_ID_KEY, reqId);
    else localStorage.removeItem(MY_REQUEST_ID_KEY);
  } catch (e) {}
}

function normalizePath(path) {
  const clean = String(path || '').replace(/^\/+/, '').replace(/\.json$/i, '');
  return `${FIREBASE_DB_URL}/${clean}.json`;
}

async function fbRequest(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(normalizePath(path), {
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

export async function fbGet(path) {
  return await fbRequest(path, { cache: 'no-store' });
}

export async function fbPut(path, data) {
  return await fbRequest(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function fbPatch(path, data) {
  return await fbRequest(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function fbPost(path, data) {
  return await fbRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

export async function fbDelete(path) {
  return await fbRequest(path, { method: 'DELETE' });
}
