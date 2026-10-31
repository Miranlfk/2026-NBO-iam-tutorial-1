// Runtime configuration. The container image overwrites this file at start-up
// with values from its environment (docker/40-wayfinder-env-config.sh). It is
// empty here, so `npm run dev` uses the VITE_* values from .env.
window.__WAYFINDER_ENV__ = window.__WAYFINDER_ENV__ || {};
