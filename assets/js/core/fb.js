// Firebase connection (modular SDK loaded from Google's CDN — no build step needed).
// The config below is the public web config of project "almaster-b8c18".
// Access control is enforced by firestore.rules, not by hiding this config.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  createUserWithEmailAndPassword, updatePassword, EmailAuthProvider, reauthenticateWithCredential
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, onSnapshot,
  query, where, orderBy, limit, serverTimestamp, increment, arrayUnion, Timestamp, runTransaction, writeBatch, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: 'AIzaSyCXyuT529aGwiS5j_RPxW_zEeAtkYc7JlM',
  authDomain: 'almaster-b8c18.firebaseapp.com',
  projectId: 'almaster-b8c18',
  storageBucket: 'almaster-b8c18.firebasestorage.app',
  messagingSenderId: '884142036232',
  appId: '1:884142036232:web:eeb6677d988565653a08bd'
};

const app = getApps().find(a => a.name === '[DEFAULT]') || initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// A second app instance lets HR create accounts without signing themselves out.
let _secondary = null;
export function secondaryAuth() {
  if (!_secondary) {
    const sec = getApps().find(a => a.name === 'secondary') || initializeApp(firebaseConfig, 'secondary');
    _secondary = getAuth(sec);
  }
  return _secondary;
}

export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, increment, arrayUnion, Timestamp, runTransaction, writeBatch, deleteField
};

// ---- small helpers ----
export const ref = (path, id) => id === undefined ? doc(db, path) : doc(db, path, id);
export const col = (path) => collection(db, path);
export async function read(path, id) {
  const s = await getDoc(id === undefined ? doc(db, path) : doc(db, path, id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
export async function list(q) {
  const s = await getDocs(q);
  return s.docs.map(d => ({ id: d.id, ...d.data() }));
}
export function watch(target, cb, onErr) {
  return onSnapshot(target, snap => {
    if ('docs' in snap) cb(snap.docs.map(d => ({ id: d.id, ...d.data() })), snap);
    else cb(snap.exists() ? { id: snap.id, ...snap.data() } : null, snap);
  }, err => { console.warn('[watch]', err && err.message); onErr && onErr(err); });
}
export const toMs = (v) => v == null ? null : (typeof v === 'number' ? v : (v.toMillis ? v.toMillis() : (v.seconds != null ? v.seconds * 1000 : null)));
