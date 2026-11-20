/**
 * Firebase Realtime Database client for Quizizz Mini
 * - Lazy-loads only the selected quiz set via /quizizz_mini/sets_meta.json and /quizizz_mini/sets/{setId}.json
 * - Supports Owner PIN session & Edit Access Requests via /quizizz_mini/access_requests.json
 */

export const FIREBASE_DB_URL = 'https://quizizz-mini-shared-e3865-default-rtdb.asia-southeast1.firebasedatabase.app';
export const META_PATH = '/quizizz_mini/sets_meta.json';
export const SET_QUESTIONS_PATH = (setId) => `/quizizz_mini/sets/${encodeURIComponent(setId)}.json`;
export const REQUESTS_PATH = '/quizizz_mini/access_requests.json';
export const LEGACY_MULTI_PATH = '/quizizz_mini/quiz_sets.json';
export const LEGACY_SINGLE_PATH = '/quizizz_mini/shared_questions.json';

// Mã PIN chủ sở hữu mặc định (bạn có thể đổi mã này trong code trước khi deploy)
export const OWNER_PIN_CODE = '2026';
const OWNER_SESSION_KEY = 'quizizz_mini_owner_unlocked_v1';

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
  } catch (e) {
    // Ignore storage error
  }
}

export async function fbGet(path) {
  const res = await fetch(`${FIREBASE_DB_URL}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function fbPut(path, data) {
  const res = await fetch(`${FIREBASE_DB_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function fbPost(path, data) {
  const res = await fetch(`${FIREBASE_DB_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function fbDelete(path) {
  const res = await fetch(`${FIREBASE_DB_URL}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
