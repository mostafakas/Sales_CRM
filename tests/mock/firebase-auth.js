// Test double for firebase-auth.js — accounts live in localStorage.
const LS_USERS = 'mockauth_users', LS_CUR = 'mockauth_current';
const loadUsers = () => JSON.parse(localStorage.getItem(LS_USERS) || '{}');
const saveUsers = (u) => localStorage.setItem(LS_USERS, JSON.stringify(u));
const instances = new Map();
function err(code) { const e = new Error(code); e.code = code; return e; }
function mkUser(email, auth) {
  const u = { uid: 'uid_' + email.replace(/[^a-z0-9]/gi, '_'), email, displayName: null, getIdToken: async () => 'mock-token-' + email };
  u._auth = auth;
  return u;
}
export function getAuth(app) {
  const key = app ? app.name : '[DEFAULT]';
  if (instances.has(key)) return instances.get(key);
  const auth = { app, currentUser: null, listeners: new Set(), primary: key === '[DEFAULT]' };
  if (auth.primary) { const cur = localStorage.getItem(LS_CUR); if (cur && loadUsers()[cur]) auth.currentUser = mkUser(cur, auth); }
  instances.set(key, auth);
  return auth;
}
function emit(auth) { auth.listeners.forEach(cb => setTimeout(() => cb(auth.currentUser), 0)); }
export function onAuthStateChanged(auth, cb) {
  auth.listeners.add(cb);
  setTimeout(() => cb(auth.currentUser), 0);
  return () => auth.listeners.delete(cb);
}
export async function signInWithEmailAndPassword(auth, email, password) {
  email = String(email).toLowerCase();
  const u = loadUsers()[email];
  if (!u || u.password !== password) throw err('auth/invalid-credential');
  auth.currentUser = mkUser(email, auth);
  if (auth.primary) localStorage.setItem(LS_CUR, email);
  emit(auth);
  return { user: auth.currentUser };
}
export async function signOut(auth) {
  auth.currentUser = null;
  if (auth.primary) localStorage.removeItem(LS_CUR);
  emit(auth);
}
export async function createUserWithEmailAndPassword(auth, email, password) {
  email = String(email).toLowerCase();
  const all = loadUsers();
  if (all[email]) throw err('auth/email-already-in-use');
  if (!password || password.length < 6) throw err('auth/weak-password');
  all[email] = { password }; saveUsers(all);
  auth.currentUser = mkUser(email, auth);
  if (auth.primary) localStorage.setItem(LS_CUR, email);
  emit(auth);
  return { user: auth.currentUser };
}
export async function sendPasswordResetEmail(auth, email) {
  const log = JSON.parse(localStorage.getItem('mockauth_resets') || '[]'); log.push(email);
  localStorage.setItem('mockauth_resets', JSON.stringify(log));
}
export async function updatePassword(user, password) {
  const all = loadUsers(); if (!all[user.email]) throw err('auth/user-not-found');
  all[user.email].password = password; saveUsers(all);
}
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
export async function reauthenticateWithCredential(user, cred) {
  const all = loadUsers(); if (!all[user.email] || all[user.email].password !== cred.password) throw err('auth/wrong-password');
  return { user };
}
