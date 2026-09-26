// Test double for firebase-app.js (served in place of the CDN file during browser tests).
const apps = [];
export function initializeApp(options, name = '[DEFAULT]') {
  const existing = apps.find(a => a.name === name);
  if (existing) return existing;
  const app = { name, options };
  apps.push(app);
  return app;
}
export const getApps = () => apps.slice();
export const getApp = (name = '[DEFAULT]') => apps.find(a => a.name === name);
export const deleteApp = async (app) => { const i = apps.indexOf(app); if (i >= 0) apps.splice(i, 1); };
