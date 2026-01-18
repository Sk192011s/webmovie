/** @jsxImportSource npm:hono@4/jsx */
import { Hono } from "npm:hono@4";
import { getCookie, setCookie, deleteCookie } from "npm:hono@4/cookie";
import { secureHeaders } from "npm:hono@4/secure-headers";
import { compress } from "npm:hono@4/compress";
import { csrf } from "npm:hono@4/csrf";
import { z } from "npm:zod@3"; // 🔥 NEW: Security Validation

// =======================
// 1. GLOBAL CONFIG & KV
// =======================
const kv = await Deno.openKv();

const SALT = Deno.env.get("SECRET_SALT");
const ADMIN_PASS = Deno.env.get("ADMIN_PASSWORD");
const ADMIN_ROUTE = Deno.env.get("ADMIN_ROUTE_PATH") || "/admin_panel_secure";

if (!SALT || !ADMIN_PASS) {
  console.error("❌ ERROR: Set 'SECRET_SALT', 'ADMIN_PASSWORD' & 'ADMIN_ROUTE_PATH' env vars.");
}

const ADMIN_SESSION_EXPIRE = 24 * 60 * 60 * 1000;

// 🔥 PERFORMANCE: RAM CACHE SYSTEM
const RAM_CACHE = {
    latestMovies: { data: [], timestamp: 0 },
    config: { data: null, timestamp: 0 }
};
const CACHE_TTL = 5 * 60 * 1000;

// 🔥 SECURITY: ZOD SCHEMAS (Input Validation)
const loginSchema = z.object({
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Only letters, numbers & underscores allowed"),
    password: z.string().min(6),
    remember: z.string().optional()
});

const signupSchema = loginSchema.extend({
    question: z.string().min(3),
    answer: z.string().min(2)
});

const reviewSchema = z.object({
    movieId: z.string(),
    rating: z.coerce.number().min(1).max(5),
    comment: z.string().max(500).optional()
});

const i18n: any = {
    en: {
        home: "Home", saved: "Saved", request: "Request", login: "Login", me: "Me",
        search_ph: "Search movies...", featured: "Featured", play: "Watch Now",
        see_all: "View All", views: "Views", dl_help: "Download Help",
        server1: "Server 1", server2: "Server 2", share: "Share",
        unlock: "Unlock VIP", vip_only: "VIP Exclusive",
        access_denied: "Access Denied", ip_banned: "Your IP is restricted.",
        security_alert: "Security Check", wait: "Please Wait",
        dl_btn: "Download", reviews: "Reviews", write_review: "Write a Review",
        continue_watching: "Continue Watching"
    },
    my: {
        home: "ပင်မ", saved: "သိမ်းဆည်း", request: "တောင်းဆို", login: "ဝင်ရန်", me: "မိမိ",
        search_ph: "ဇာတ်ကားရှာရန်...", featured: "အထူးပြသ", play: "ကြည့်မည်",
        see_all: "အားလုံးကြည့်", views: "ကြိမ်", dl_help: "ဒေါင်းနည်း",
        server1: "ဆာဗာ ၁", server2: "ဆာဗာ ၂", share: "မျှဝေမည်",
        unlock: "VIP ဖွင့်ရန်", vip_only: "VIP သီးသန့်",
        access_denied: "ဝင်ရောက်ခွင့် ပိတ်ပင်ထားသည်", ip_banned: "သင့် IP ကို ပိတ်ပင်ထားပါသည်။",
        security_alert: "လုံခြုံရေး သတိပေးချက်", wait: "ခေတ္တစောင့်ပါ",
        dl_btn: "ဒေါင်းလုပ်", reviews: "သုံးသပ်ချက်များ", write_review: "မှတ်ချက်ရေးရန်",
        continue_watching: "ဆက်လက်ကြည့်ရှုရန်",
        create_acc: "အကောင့်သစ်", username: "အမည် (Username)", password: "စကားဝှက် (Password)",
        remember: "မှတ်ထားမည် (၇ ရက်)", no_acc: "အကောင့်မရှိဘူးလား?", has_acc: "အကောင့်ရှိပြီးသားလား?",
        signup: "မှတ်ပုံတင်မည်", forgot_pass: "စကားဝှက် မေ့နေပါသလား?", reset_pass: "စကားဝှက် အသစ်ပြန်ယူမည်",
        sec_q: "လုံခြုံရေး မေးခွန်း", sec_a: "အဖြေ", new_pass: "စကားဝှက် အသစ်", next: "ရှေ့ဆက်မည်",
        back_login: "အကောင့်ဝင်ရန် ပြန်သွားမည်"
    }
};

const SECURITY_QUESTIONS = [
    "သင့်မွေးရပ်မြေက ဘယ်မှာလဲ?",
    "သင့်အချစ်ဆုံး သူငယ်ချင်းနာမည်?",
    "သင့်အကြိုက်ဆုံး ဇာတ်ကားနာမည်?",
    "သင့်ပထမဆုံး ကျောင်းနာမည်?",
    "သင့်အမေရဲ့ နာမည်အရင်း?"
];

// =======================
// 2. TYPES
// =======================
interface Episode { season?: string; name: string; url: string; }
interface Movie {
  id: string; title: string; posterUrl: string; coverUrl: string;
  category: "Movies" | "Series" | "Animation" | "Jav" | "All Uncensored" | "Myanmar and Asian" | "4K Porns";
  description: string; tags: string;
  year: string; fileSize?: string; duration?: string;
  streamUrl: string; streamUrl2?: string;
  episodes?: Episode[];
  linkType: "direct" | "embed";
  downloadUrl?: string; downloadUrl2?: string;
  createdAt: number;
  price?: number;
}
interface MovieSummary { id: string; title: string; posterUrl: string; coverUrl: string; category: string; createdAt: number; }
interface User {
    username: string; passwordHash: string; expiryDate: string | null;
    favorites: string[]; sessionId?: string; ip?: string; lastLoginIp?: string; isBanned?: boolean;
    coins?: number; purchased?: string[];
    securityQ?: string; securityA?: string;
}
interface Review { id: string; movieId: string; username: string; rating: number; comment: string; timestamp: number; }
interface WatchHistory { movieId: string; timestamp: number; progress: number; lastWatched: number; }
interface VipKey { code: string; days: number; type?: "vip" | "coin"; value?: number; }
interface UserRequest { id: string; username: string; movieName: string; timestamp: number; }
interface TopupRequest { 
    id: string; username: string; amount: number; method: string; transactionId: string; 
    status: "pending" | "approved" | "rejected"; timestamp: number; purpose?: string;
}
interface AdminLog { id: string; action: string; details: string; timestamp: number; }
interface AppConfig { 
    announcement: string; showAnnouncement: boolean; globalVipExpiry?: number;
    popupImage?: string; popupMessage?: string; popupBtnText?: string; popupLink?: string; 
    popupTarget?: string; showPopup?: boolean; maintenanceMode?: boolean;
    customBannerImage?: string; customBannerLink?: string; showCustomBanner?: boolean;
}

// =======================
// 3. UTILS & DATABASE
// =======================
function getLang(c: any) { return getCookie(c, "app_lang") || "en"; }

async function hashPassword(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(text), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(SALT || "default_salt"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanText(text: string): string {
    return text.replace(/<[^>]*>/g, '').trim(); // Remove HTML tags (XSS Prevention)
}

function tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[-_.:]+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(w => w.length > 1);
}

// 🔥 RATE LIMIT UPDATED (Session Aware)
async function checkLoginRateLimit(ip: string, session?: string): Promise<boolean> {
    const key = ["rate_limit", session || ip];
    const res = await kv.get<{ count: number }>(key);
    const count = res.value?.count || 0;
    if (count >= 100) return false;
    await kv.set(key, { count: count + 1 }, { expireIn: 60 * 1000 });
    return true;
}

async function recordLoginFail(ip: string) {
    const key = ["login_fail", ip];
    const res = await kv.get<{ count: number }>(key);
    const count = (res.value?.count || 0) + 1;
    await kv.set(key, { count }, { expireIn: 15 * 60 * 1000 });
}

function getClientIp(c: any): string {
    try {
        const info = c.env as any;
        if (info?.remoteAddr?.hostname) return info.remoteAddr.hostname;
    } catch (e) {}
    const headers = ["cf-connecting-ip", "x-real-ip", "x-forwarded-for", "x-client-ip"];
    for (const header of headers) {
        const val = c.req.header(header);
        if (val) return val.split(",")[0].trim();
    }
    return "Unknown-IP";
}

async function isIpBanned(ip: string): Promise<boolean> {
    if (ip === "Unknown-IP") return false;
    const entry = await kv.get(["banned_ips", ip]);
    return !!entry.value;
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostname = u.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return false;
    return true;
  } catch { return false; }
}

async function resolveRedirect(url: string) {
  if (!isValidUrl(url)) return url;
  const cacheKey = ["link_cache", url];
  const cached = await kv.get(cacheKey);
  if (cached.value) return cached.value as string;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
      clearTimeout(timeoutId);
      const realUrl = res.url;
      await kv.set(cacheKey, realUrl, { expireIn: 60 * 60 * 1000 });
      return realUrl;
  } catch { return url; }
}

async function logAdminAction(action: string, details: string) {
    const log: AdminLog = { id: crypto.randomUUID(), action, details, timestamp: Date.now() };
    await kv.set(["admin_logs", log.timestamp, log.id], log, { expireIn: 30 * 24 * 60 * 60 * 1000 });
}

async function getConfig() {
    if (RAM_CACHE.config.data && (Date.now() - RAM_CACHE.config.timestamp < CACHE_TTL)) {
        return RAM_CACHE.config.data as AppConfig;
    }
    const res = await kv.get<AppConfig>(["config"]);
    const config = res.value || { announcement: "Welcome to Gold Flix!", showAnnouncement: true, globalVipExpiry: 0 };
    RAM_CACHE.config = { data: config, timestamp: Date.now() };
    return config;
}

function clearConfigCache() { RAM_CACHE.config = { data: null, timestamp: 0 }; }

// 🔥 UPGRADE: ATOMIC TRANSACTIONS FOR DATA INTEGRITY
async function saveMovieDB(movie: Movie) {
    const summary: MovieSummary = {
        id: movie.id, title: movie.title, posterUrl: movie.posterUrl,
        coverUrl: movie.coverUrl, category: movie.category, createdAt: movie.createdAt
    };

    const oldRes = await kv.get<Movie>(["movies", movie.id]);
    const old = oldRes.value;
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };

    const atomic = kv.atomic();

    if (old) {
        const oldWords = tokenize(old.title + " " + (old.tags || ""));
        for (const w of oldWords) atomic.delete(["idx_search", w, movie.id]);

        if (old.category !== movie.category) atomic.delete(["idx_cat", old.category, old.createdAt, old.id]);
        if (old.createdAt !== movie.createdAt) {
             atomic.delete(["idx_time", old.createdAt, old.id]);
             if (old.category === movie.category) atomic.delete(["idx_cat", old.category, old.createdAt, old.id]);
        }
    }

    atomic.set(["movies", movie.id], movie);
    atomic.set(["idx_time", movie.createdAt, movie.id], summary);
    atomic.set(["idx_cat", movie.category, movie.createdAt, movie.id], summary);

    const newWords = tokenize(movie.title + " " + (movie.tags || ""));
    for (const w of newWords) atomic.set(["idx_search", w, movie.id], movie.createdAt);
    
    await atomic.commit();
}

async function deleteMovieDB(id: string) {
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
    const res = await kv.get<Movie>(["movies", id]);
    if (!res.value) return;
    const m = res.value;
    
    const atomic = kv.atomic();
    atomic.delete(["movies", id]);
    if (m.createdAt) {
        atomic.delete(["idx_time", m.createdAt, id]);
        atomic.delete(["idx_cat", m.category, m.createdAt, id]);
    }
    const words = tokenize(m.title + " " + (m.tags || ""));
    for (const w of words) atomic.delete(["idx_search", w, id]);
    await atomic.commit();
}

async function getLatestMovies(limit: number = 20) {
    if (limit <= 20 && RAM_CACHE.latestMovies.data.length > 0 && (Date.now() - RAM_CACHE.latestMovies.timestamp < CACHE_TTL)) {
        return RAM_CACHE.latestMovies.data.slice(0, limit);
    }
    const iter = kv.list<MovieSummary>({ prefix: ["idx_time"] }, { reverse: true, limit });
    const movies = []; for await (const res of iter) movies.push(res.value);
    if (limit <= 20) RAM_CACHE.latestMovies = { data: movies, timestamp: Date.now() };
    return movies;
}

async function getMoviesByCategory(cat: string, limit: number = 20) {
    const iter = kv.list<MovieSummary>({ prefix: ["idx_cat", cat] }, { reverse: true, limit });
    const movies = []; for await (const res of iter) movies.push(res.value); return movies;
}

async function searchMoviesDB(query: string) {
    const words = tokenize(query);
    if (words.length === 0) return [];
    const searchWord = words.reduce((a, b) => a.length > b.length ? a : b, "");
    const iter = kv.list({ start: ["idx_search", searchWord], end: ["idx_search", searchWord + "\uffff"] }, { limit: 100 });
    const movieIds = new Set<string>();
    
    for await (const entry of iter) movieIds.add(entry.key[2] as string); 
    const uniqueIds = Array.from(movieIds);
    const results = [];
    
    for (let i = 0; i < uniqueIds.length; i += 10) {
        const batch = uniqueIds.slice(i, i + 10);
        const keys = batch.map(id => ["movies", id]);
        const res = await kv.getMany(keys);
        for (const r of res) if (r.value) results.push(r.value as Movie);
    }
    return results.filter(m => {
        const text = (m.title + " " + m.tags).toLowerCase();
        return words.every(w => text.includes(w));
    });
}

async function reIndexDatabase() {
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    for await (const res of iter) await saveMovieDB(res.value);
}

async function getMovie(id: string) { const res = await kv.get<Movie>(["movies", id]); return res.value; }
async function getUser(username: string) { const res = await kv.get<User>(["users", username]); return res.value; }
async function getKeys() { const iter = kv.list<VipKey>({ prefix: ["keys"] }); const keys = []; for await (const res of iter) keys.push(res.value); return keys; }
async function getRequests() { const iter = kv.list<UserRequest>({ prefix: ["requests"] }); const reqs = []; for await (const res of iter) reqs.push(res.value); return reqs.sort((a,b)=>b.timestamp-a.timestamp); }
async function getTopups() { const iter = kv.list<TopupRequest>({ prefix: ["topups"] }); const reqs = []; for await (const res of iter) reqs.push(res.value); return reqs.sort((a,b)=>b.timestamp-a.timestamp); }
async function getLogs() { const iter = kv.list<AdminLog>({ prefix: ["admin_logs"] }, { reverse: true, limit: 100 }); const logs = []; for await (const res of iter) logs.push(res.value); return logs; }

async function getCurrentUser(c: any) {
  const authCookie = getCookie(c, "auth_session");
  if (!authCookie) return null;
  const [username, token] = authCookie.split(":");
  if (!username || !token) return null;
  const user = await getUser(username);
  if (!user || user.sessionId !== token) return null;
  if (user.isBanned) return null;
  return user;
}

function isPremium(user: User | null, config: AppConfig) {
  if (!user) return false;
  const now = Date.now();
  if (config.globalVipExpiry && config.globalVipExpiry > now) return true;
  if (!user.expiryDate) return false;
  return new Date(user.expiryDate).getTime() > now;
}

const adminGuard = async (c: any, next: any) => {
    const sessionId = getCookie(c, "admin_session_id");
    if (!sessionId) return c.redirect(ADMIN_ROUTE);
    const session = await kv.get(["admin_sessions", sessionId]);
    if (!session.value) return c.redirect(ADMIN_ROUTE);
    await next();
};

// =======================
// 4. LAYOUT (HTMX + ALPINE + CUSTOM STYLES)
// =======================
const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean; announcement?: string; isAdmin?: boolean; coverUrl?: string; lang?: string; activeTab?: string; globalExpiry?: number }) => {
  const protectCSS = props.isAdmin ? "" : `* { -webkit-touch-callout: none !important; } img { pointer-events: none; }`;
  const protectJS = props.isAdmin ? "" : `
    document.addEventListener('contextmenu', event => { if(event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') event.preventDefault(); });
    window.addEventListener('dragstart', event => event.preventDefault());
`;
  const l = props.lang || "en";
  const t = i18n[l];
  const active = props.activeTab || "home";

  let daysLeft = 0;
  const now = Date.now();
  if (props.user && props.user.expiryDate) {
      const diff = new Date(props.user.expiryDate).getTime() - now;
      if (diff > 0) daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24));
  }
  if (props.globalExpiry && props.globalExpiry > now) {
      const globalDays = Math.ceil((props.globalExpiry - now) / (1000 * 60 * 60 * 24));
      if (globalDays > daysLeft) daysLeft = globalDays;
  }

  return (
  <html lang={l}>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>{props.title || "Gold Flix V2"}</title>
      <meta property="og:title" content={props.title || "Gold Flix"} />
      <meta property="og:image" content={props.coverUrl || "https://cdn-icons-png.flaticon.com/512/2503/2503508.png"} />
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      {/* 🔥 HTMX for SPA Feel */}
      <script src="https://unpkg.com/htmx.org@1.9.10" integrity="sha384-D1Kt99CQMDuVetoL1lrYwg5t+9QdHe7NLX/SoJYkXDFfX37iInKRy5xLSi8nO7UC" crossorigin="anonymous"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&display=swap" rel="stylesheet" />
      <style>{`
        :root { --glass-bg: rgba(255, 255, 255, 0.08); --glass-border: rgba(255, 255, 255, 0.1); --primary: #8b5cf6; }
        body { background-color: #111827; color: #e2e8f0; font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; padding-bottom: 90px; }
        * { user-select: none; -webkit-user-select: none; }
        input, textarea { user-select: text !important; -webkit-user-select: text !important; -webkit-touch-callout: default !important; }
        ${protectCSS}
        .glass-panel { background: var(--glass-bg); backdrop-filter: blur(16px); border: 1px solid var(--glass-border); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1); }
        .input-box { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); color: white; padding: 14px; border-radius: 12px; width: 100%; outline: none; transition: 0.3s; font-size: 14px; }
        .input-box:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2); }
        .btn-primary { background: linear-gradient(135deg, var(--primary), #6366f1); color: white; font-weight: 700; padding: 14px 20px; border-radius: 12px; transition: 0.3s; cursor: pointer; border: none; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3); }
        .btn-primary:active { transform: scale(0.97); }
        .bottom-nav { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); width: 90%; max-width: 400px; background: rgba(17, 24, 39, 0.95); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); display: flex; justify-content: space-around; padding: 12px 6px; z-index: 50; }
        .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; color: #94a3b8; transition: 0.3s; text-align: center; gap: 4px; }
        .nav-item.active { color: white; }
        .nav-item.active i { color: #c084fc; text-shadow: 0 0 15px rgba(192, 132, 252, 0.8); transform: translateY(-3px); }
        .top-header { position: fixed; top: 0; left: 0; width: 100%; z-index: 40; padding: 12px 20px; display: flex; justify-content: space-between; items-center; background: rgba(17, 24, 39, 0.9); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.05); }
        .announcement-bar { position: fixed; top: 60px; left: 0; width: 100%; z-index: 39; background: linear-gradient(90deg, #f59e0b, #d97706); color: black; font-size: 11px; font-weight: bold; padding: 8px 16px; display: flex; items-center; gap: 8px; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3); }
        .custom-scroll::-webkit-scrollbar { width: 0px; height: 0px; }
        .htmx-indicator { display: none; } .htmx-request .htmx-indicator { display: inline-block; }
        .slider-container { position: relative; width: 100%; aspect-ratio: 16/9; overflow: hidden; border-radius: 24px; box-shadow: 0 20px 50px -10px rgba(0,0,0,0.5); }
        .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease-in-out; pointer-events: none; }
        .slide.active { opacity: 1; pointer-events: auto; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 16px; padding-bottom: 24px; scroll-snap-type: x mandatory; padding-left: 20px; padding-right: 20px; scrollbar-width: none; }
        .h-scroll-item { width: 120px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item.wide { width: 280px; }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        ${protectJS}
        window.imgLoaded = function(img) { img.classList.add('loaded'); if(img.parentElement) img.parentElement.classList.remove('img-skeleton'); }
        
        // 🔥 WATCH HISTORY TRACKER
        window.saveProgress = async function(movieId, time) {
             if(!movieId || time < 5) return;
             await fetch('/api/history', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({movieId, time}) });
        }
        
        window.loadPlayer = async function(content, type, movieId, title, poster, btnElement) {
            document.querySelectorAll('.srv-btn').forEach(b => { b.classList.remove('bg-purple-600', 'text-white'); b.classList.add('bg-slate-800', 'text-gray-300'); });
            if (btnElement) { btnElement.classList.remove('bg-slate-800', 'text-gray-300'); btnElement.classList.add('bg-purple-600', 'text-white'); }
            const container = document.getElementById('video-player');
            const cover = document.getElementById('video-cover');
            if(container) container.innerHTML = ''; 
            if(cover) cover.style.display = 'none';
            if(container) container.style.display = 'block'; 
            let finalUrl = content;
            if (type === 'direct') { 
                try { const res = await fetch('/api/resolve-url?token=' + content); const data = await res.json(); if (data.url) finalUrl = data.url; } catch (e) {} 
            }
            container.innerHTML = '<video id="main-video" controls autoplay playsinline class="w-full h-full" style="background-color:black;"><source src="'+finalUrl+'" type="video/mp4"></video>';
            
            // Start Tracking
            const v = document.getElementById('main-video');
            setInterval(() => { if(!v.paused) window.saveProgress(movieId, v.currentTime); }, 5000);
            window.scrollTo({top:0, behavior:'smooth'});
        }

        window.shareMovie = function(title) { if (navigator.share) { navigator.share({ title: title, text: 'Watch ' + title + ' on Gold Flix', url: window.location.href }); } else { navigator.clipboard.writeText(window.location.href); alert('Copied!'); } }
        window.openBuyModal = function(price, title) { const modal = document.getElementById('buy-modal'); if(modal) modal.classList.remove('hidden'); modal.classList.add('flex'); }
        window.closeBuyModal = function() { const modal = document.getElementById('buy-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }
        window.openVipModal = function() { const modal = document.getElementById('vip-modal'); modal.classList.remove('hidden'); modal.classList.add('flex'); }
        window.closeVipModal = function() { const modal = document.getElementById('vip-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }
        window.toggleSearch = function() { const ov = document.getElementById('search-overlay'); ov.classList.toggle('open'); if(ov.classList.contains('open')) document.getElementById('search-input-main').focus(); }
        
        document.addEventListener('DOMContentLoaded', () => {
             const slides = document.querySelectorAll('.slide');
             if(slides.length>1){ let current=0; setInterval(()=>{ slides[current].classList.remove('active'); current=(current+1)%slides.length; slides[current].classList.add('active'); },4500); }
             
             window.openTab = function(name) {
                 document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active')); document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
                 document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                 const content = document.getElementById('tab-'+name);
                 if(content) { content.classList.add('active'); content.style.display = 'block'; }
                 const btn = document.getElementById('btn-'+name);
                 if(btn) btn.classList.add('active');
                 localStorage.setItem('adminTab', name);
             }
             const savedTab = localStorage.getItem('adminTab') || 'movies';
             if(document.getElementById('tab-'+savedTab)) openTab(savedTab);
        });
      `}} />
    </head>
    {/* 🔥 ENABLE HTMX SPA FEEL */}
    <body hx-boost="true">
      <div id="page-loader" class="htmx-indicator fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"><div class="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div></div>
      
      {/* MODALS */}
      <div id="buy-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-md p-4">
             <div class="glass-panel p-6 rounded-lg w-full max-w-sm text-center relative shadow-2xl">
                  <div class="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-yellow-500/20"><i class="fa-solid fa-cart-shopping text-3xl text-yellow-500"></i></div>
                  <h3 class="text-xl font-black text-white mb-2">Premium Purchase</h3>
                  <div class="flex gap-3 h-12 mt-4"> 
                      <button onclick="closeBuyModal()" class="flex-1 h-full rounded-xl bg-slate-800 text-white font-bold border border-white/10">Cancel</button>
                      <a href={props.user ? "/profile" : "/login"} class="flex-1 h-full flex items-center justify-center rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 text-white font-bold shadow-lg">Buy / Login</a>
                  </div>
             </div>
      </div>
      <div id="vip-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-md p-4">
             <div class="glass-panel p-6 rounded-lg w-full max-w-sm text-center relative shadow-2xl">
                  <div class="w-16 h-16 bg-purple-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-purple-500/20"><i class="fa-solid fa-crown text-3xl text-purple-500 animate-pulse"></i></div>
                  <h3 class="text-lg font-black text-white mb-2">VIP Required</h3>
                  <div class="flex gap-3 h-12 mt-4"> 
                      <button onclick="closeVipModal()" class="flex-1 h-full rounded-xl bg-slate-800 text-white font-bold border border-white/10">Cancel</button>
                      <a href={props.user ? "/profile" : "/login"} class="flex-1 h-full flex items-center justify-center rounded-xl bg-purple-600 text-white font-bold shadow-lg">Get VIP</a>
                  </div>
             </div>
      </div>
      
      {/* SEARCH OVERLAY */}
      <div id="search-overlay" class="fixed inset-0 bg-gray-900/95 z-50 transform translate-y-full transition-transform duration-300 p-4">
          <div class="flex justify-between items-center mb-6">
              <h2 class="text-xl font-bold text-white">Search Movies</h2>
              <button onclick="toggleSearch()" class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <form action="/search" method="get">
              <input id="search-input-main" name="q" placeholder="Type movie name..." class="w-full bg-white/10 border border-white/10 rounded-xl py-4 pl-4 text-white text-lg focus:border-purple-500 outline-none" />
          </form>
      </div>

      {!props.hideNav && (
        <>
            <header class="top-header">
                <div class="flex items-center gap-3">
                    <a href="/" class="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600 tracking-tighter italic">GOLD FLIX</a>
                    <button onclick="toggleSearch()" class="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 border border-white/10"><i class="fa-solid fa-magnifying-glass text-xs text-gray-300"></i></button>
                </div>
                <div class="flex items-center gap-3">
                    {active === 'home' && !props.isAdmin && props.user && (
                        <div class="px-3 py-1 rounded-full border border-purple-500/30 bg-purple-500/10 text-[10px] font-bold text-purple-400">P - {daysLeft} Day</div>
                    )}
                    {props.isAdmin ? (
                        <a href={ADMIN_ROUTE + "/dashboard"} class="text-xs font-bold bg-blue-600 text-white px-4 py-1.5 rounded-full shadow-lg">ADMIN</a>
                    ) : (
                        <a href={l === 'en' ? '/lang/my' : '/lang/en'} class="text-xs font-bold text-gray-300 border border-white/20 px-3 py-1 rounded-full">{l === 'en' ? 'MY' : 'EN'}</a>
                    )}
                </div>
            </header>
            {!props.isAdmin && (
                <nav class="bottom-nav">
                    <a href="/" class={`nav-item ${active === 'home' ? 'active' : ''}`}><i class="fa-solid fa-house"></i><span>{t.home}</span></a>
                    <a href="/favorites" class={`nav-item ${active === 'saved' ? 'active' : ''}`}><i class="fa-solid fa-heart"></i><span>{t.saved}</span></a>
                    <a href="/request" class={`nav-item ${active === 'request' ? 'active' : ''}`}><i class="fa-solid fa-clapperboard"></i><span>{t.request}</span></a>
                    <a href={props.user ? "/profile" : "/login"} class={`nav-item ${active === 'me' ? 'active' : ''}`}><i class="fa-solid fa-user"></i><span>{t.me}</span></a>
                </nav>
            )}
        </>
      )}
      {props.announcement && (
          <div class="announcement-bar"><i class="fa-solid fa-bullhorn text-white"></i><marquee scrollamount="5">{props.announcement}</marquee></div>
      )}
      <main class={`flex-grow w-full ${props.announcement ? 'pt-[90px]' : 'pt-[70px]'}`}>
        {props.children}
      </main>
    </body>
  </html>
)};

// =======================
// 5. MAIN APP
// =======================
const app = new Hono();

// 🔥 GLOBAL MIDDLEWARE
app.use("*", async (c, next) => {
    const ip = getClientIp(c);
    const session = getCookie(c, "auth_session");
    // Bot Protection
    const ua = c.req.header("user-agent") || "";
    if (ua.match(/curl|wget|python|java|libwww/i)) return c.text("Bot Access Denied", 403);
    // Rate Limiting
    if (!await checkLoginRateLimit(ip, session)) return c.text("Too Many Requests! Please wait.", 429);
    await next();
});
app.use("*", secureHeaders());
app.use("*", compress());
app.use("*", csrf());

// ROUTES
app.get("/manifest.json", (c) => c.json({ "name": "Gold Flix", "short_name": "GoldFlix", "start_url": "/", "display": "standalone", "background_color": "#0f172a", "theme_color": "#0f172a", "icons": [{ "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "192x192", "type": "image/png" }] }));

app.get("/lang/:code", (c) => {
    const code = c.req.param("code");
    setCookie(c, "app_lang", code === "en" ? "en" : "my", { path: "/", maxAge: 86400 * 365 });
    return c.redirect(c.req.header("Referer") || "/");
});

app.get("/", async (c) => {
  const user = await getCurrentUser(c);
  const lang = getLang(c);
  const t = i18n[lang];
  const config = await getConfig();
  
  const [sliderMovies, catMovies, catSeries, catUncen] = await Promise.all([
      getLatestMovies(5), 
      getMoviesByCategory("Movies", 10),
      getMoviesByCategory("Series", 10),
      getMoviesByCategory("All Uncensored", 10)
  ]);
  
  // 🔥 WATCH HISTORY FETCHING
  let continueWatching = [];
  if (user) {
      const iter = kv.list<WatchHistory>({ prefix: ["history", user.username] }, { limit: 5 });
      for await (const res of iter) {
          const m = await getMovie(res.value.movieId);
          if (m) continueWatching.push({ ...m, progress: res.value.progress });
      }
  }
  
  const sections = [
    { name: "Movies", data: catMovies },
    { name: "Series", data: catSeries },
    { name: "All Uncensored", data: catUncen }
  ];
  
  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home" globalExpiry={config.globalVipExpiry}>
      {/* CONTINUE WATCHING SECTION */}
      {continueWatching.length > 0 && (
          <div class="px-4 mb-6 mt-2">
              <h2 class="text-white font-bold mb-3 flex items-center gap-2"><i class="fa-solid fa-clock-rotate-left text-yellow-500"></i> {t.continue_watching}</h2>
              <div class="flex overflow-x-auto gap-3 pb-2 custom-scroll">
                  {continueWatching.map(m => (
                      <a href={`/movie/${m.id}`} class="min-w-[140px] relative rounded-lg overflow-hidden group border border-zinc-800">
                          <img src={m.coverUrl || m.posterUrl} class="aspect-video w-full object-cover opacity-80 group-hover:opacity-100 transition" />
                          <div class="absolute bottom-0 w-full h-1 bg-gray-700"><div class="h-full bg-yellow-500" style={`width:${Math.min(100, (m.progress/100)*100)}%`}></div></div>
                          <div class="absolute inset-0 flex items-center justify-center"><i class="fa-solid fa-play text-white text-2xl drop-shadow-lg"></i></div>
                      </a>
                  ))}
              </div>
          </div>
      )}

      {/* SLIDER */}
      {sliderMovies.length > 0 && (
          <div class="px-4 mb-8 mt-4">
              <div class="slider-container relative z-0 group rounded-lg overflow-hidden shadow-2xl aspect-video">
                  {sliderMovies.map((m, idx) => (
                      <div class={`slide ${idx === 0 ? 'active' : ''} absolute inset-0 transition-opacity duration-1000`}>
                          <img src={m.coverUrl} class="w-full h-full object-cover" />
                          <div class="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black via-black/50 to-transparent">
                              <h1 class="text-xl md:text-3xl font-black text-white truncate drop-shadow-md">{m.title}</h1>
                              <a href={`/movie/${m.id}`} class="inline-flex items-center gap-2 bg-white text-black px-5 py-2 rounded-full font-bold text-xs hover:scale-105 transition transform shadow-lg mt-2"><i class="fa-solid fa-play"></i> {t.play}</a>
                          </div>
                      </div>
                  ))}
              </div>
          </div>
      )}

      <div class="px-3 space-y-10 pb-8">
          {sections.map(section => { 
              if (section.data.length === 0) return null; 
              return (
                <div>
                    <div class="flex justify-between items-end mb-4 px-1"><h2 class="text-lg font-bold text-white border-l-4 border-purple-500 pl-3 leading-none">{section.name}</h2><a href={`/category/${section.name}`} class="text-[10px] font-bold text-gray-400 flex items-center gap-1 hover:text-white transition uppercase tracking-wider">{t.see_all} <i class="fa-solid fa-chevron-right text-[8px]"></i></a></div>
                    <div class="h-scroll-section custom-scroll">
                        {section.data.map(m => (
                            <a href={`/movie/${m.id}`} class={`h-scroll-item block ${section.name.includes("Uncensored") ? "wide" : "w-28"} flex-shrink-0 group relative mb-4`}>
                                <div class={`${section.name.includes("Uncensored") ? "aspect-video" : "aspect-[2/3]"} w-full relative overflow-hidden rounded-lg shadow-lg`}>
                                    <img src={section.name.includes("Uncensored") ? (m.coverUrl || m.posterUrl) : m.posterUrl} loading="lazy" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-700" />
                                    <div class="absolute top-2 right-2 bg-purple-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded shadow backdrop-blur-sm">HD</div>
                                </div>
                                <div class="mt-2 text-center"><h3 class="text-[11px] font-bold truncate text-gray-200 group-hover:text-white transition">{m.title}</h3></div>
                            </a>
                        ))}
                    </div>
                </div>
              ) 
          })}
      </div>
    </Layout>
  );
});

// 🔥 MOVIE DETAIL ROUTE (Enhanced)
app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const lang = getLang(c);
    const t = i18n[lang];
    const user = await getCurrentUser(c);
    const config = await getConfig();
    const movie = await getMovie(id);
    
    if (!movie) return c.text("Not Found", 404);

    const isVip = isPremium(user, config);
    const canWatch = (!movie.price && isVip) || (user?.purchased?.includes(movie.id)) || (movie.price === 0);
    const displayImage = movie.coverUrl || movie.posterUrl; 

    // Tokens for stream (Secure URL resolving)
    let playerUrl = "", playbackToken = "";
    if (canWatch) {
        const token = crypto.randomUUID(); 
        await kv.set(["stream_tokens", token], movie.streamUrl, { expireIn: 3600 }); 
        playerUrl = `/stream/${token}`; 
        playbackToken = token;
    }

    // 🔥 FETCH REVIEWS & HISTORY
    const reviewIter = kv.list<Review>({ prefix: ["reviews", id] }, { limit: 10, reverse: true });
    const reviews = []; for await (const r of reviewIter) reviews.push(r.value);

    let startTime = 0;
    if(user) {
        const h = await kv.get<WatchHistory>(["history", user.username, id]);
        if(h.value) startTime = h.value.progress;
    }

    return c.html(
    <Layout user={user} lang={lang} activeTab="home" globalExpiry={config.globalVipExpiry}>
        <div class="max-w-4xl mx-auto">
           {/* VIDEO PLAYER */}
           <div class="w-full aspect-video bg-black relative shadow-lg group rounded-xl overflow-hidden border border-zinc-800">
                {canWatch ? (
                    <>
                        <div id="video-cover" class="absolute inset-0 z-20 cursor-pointer group" onclick={`loadPlayer('${movie.linkType === 'direct' ? playbackToken : movie.streamUrl}', '${movie.linkType}', '${movie.id}', '', '', this)`}>
                            <img src={displayImage} class="w-full h-full object-cover opacity-80 group-hover:opacity-60 transition duration-700" />
                            <div class="absolute inset-0 flex items-center justify-center">
                                <i class="fa-solid fa-circle-play text-6xl text-white drop-shadow-lg scale-90 group-hover:scale-110 transition"></i>
                            </div>
                            {startTime > 0 && <div class="absolute bottom-4 left-4 bg-black/80 text-white px-3 py-1 rounded-full text-xs font-bold border border-white/20">Resume from {Math.floor(startTime/60)}m</div>}
                        </div>
                        <div id="video-player" class="w-full h-full hidden"></div>
                    </>
                ) : (
                    <div class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-zinc-900">
                        <i class="fa-solid fa-lock text-4xl text-gray-500 mb-2"></i>
                        <p class="text-xs text-gray-400 font-bold">VIP Access or Purchase Required</p>
                    </div>
                )}
           </div>
           
           <div class="p-6">
               <h1 class="text-xl font-bold text-white leading-tight mb-2">{movie.title}</h1>
               <div class="flex items-center gap-2 mb-4">
                   <span class="bg-zinc-800 text-gray-300 text-xs px-3 py-1 rounded-full border border-zinc-700">{movie.year}</span>
                   <span class="bg-yellow-500/10 text-yellow-500 text-xs px-3 py-1 rounded-full font-bold border border-yellow-500/20">{movie.category}</span>
                   {movie.price && !canWatch ? <span class="bg-red-500/20 text-red-500 text-xs px-3 py-1 rounded-full font-bold">{movie.price} Ks</span> : null}
               </div>
               
               {!canWatch && (
                    <button onclick="openVipModal()" class="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold py-3 rounded-xl shadow-lg mb-6">Unlock VIP to Watch</button>
               )}

               <p class="text-sm text-gray-300 leading-relaxed mb-8">{movie.description}</p>
               
               {/* 🔥 REVIEWS SECTION */}
               <div class="border-t border-zinc-800 pt-6">
                   <h3 class="text-white font-bold mb-4 flex items-center gap-2"><i class="fa-solid fa-comments"></i> {t.reviews}</h3>
                   {user && (
                       <form hx-post="/api/review" hx-target="#review-list" hx-swap="afterbegin" class="mb-6 bg-zinc-900/50 p-4 rounded-xl border border-zinc-800">
                           <input type="hidden" name="movieId" value={movie.id} />
                           <div class="flex gap-2 mb-2">
                               <select name="rating" class="bg-black text-white text-xs p-2 rounded border border-zinc-700">
                                   <option value="5">⭐⭐⭐⭐⭐</option>
                                   <option value="4">⭐⭐⭐⭐</option>
                                   <option value="3">⭐⭐⭐</option>
                               </select>
                               <input name="comment" placeholder={t.write_review} class="bg-black text-white text-xs p-2 rounded border border-zinc-700 w-full outline-none" />
                           </div>
                           <button class="bg-blue-600 text-white text-xs font-bold px-4 py-2 rounded w-full hover:bg-blue-500 transition shadow-lg">{t.write_review}</button>
                       </form>
                   )}
                   <div id="review-list" class="space-y-3">
                       {reviews.map(r => (
                           <div class="bg-zinc-900/30 p-3 rounded-lg border border-zinc-800">
                               <div class="flex justify-between items-start">
                                   <span class="font-bold text-gray-300 text-xs">{r.username}</span>
                                   <span class="text-yellow-500 text-[10px]">{"⭐".repeat(r.rating)}</span>
                               </div>
                               <p class="text-gray-400 text-xs mt-1">{r.comment}</p>
                           </div>
                       ))}
                       {reviews.length === 0 && <p class="text-gray-500 text-xs italic">No reviews yet.</p>}
                   </div>
               </div>
           </div>
        </div>
    </Layout>
    );
});

// 🔥 REVIEW & HISTORY APIs
app.post("/api/review", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.text("Login required", 401);
    const body = await c.req.parseBody();
    try {
        const data = reviewSchema.parse(body);
        const review: Review = { id: crypto.randomUUID(), movieId: data.movieId, username: user.username, rating: data.rating, comment: cleanText(data.comment || ""), timestamp: Date.now() };
        await kv.set(["reviews", data.movieId, review.id], review);
        return c.html(<div class="bg-zinc-900/30 p-3 rounded-lg border border-zinc-800 animate-pulse"><div class="flex justify-between items-start"><span class="font-bold text-gray-300 text-xs">{review.username}</span><span class="text-yellow-500 text-[10px]">{"⭐".repeat(review.rating)}</span></div><p class="text-gray-400 text-xs mt-1">{review.comment}</p></div>);
    } catch { return c.text("Invalid Input", 400); }
});

app.post("/api/history", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const { movieId, time } = await c.req.json();
    await kv.set(["history", user.username, movieId], { movieId, timestamp: Date.now(), progress: time, lastWatched: Date.now() });
    return c.json({ success: true });
});

// STREAM RESOLVER
app.get("/api/resolve-url", async (c) => {
    const token = c.req.query("token");
    const entry = await kv.get(["stream_tokens", token]);
    if (!entry.value) return c.json({ error: "Invalid" }, 404);
    const url = await resolveRedirect(entry.value as string);
    return c.json({ url });
});
app.get("/stream/:token", async (c) => { 
    const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); 
    if (!entry.value) return c.text("Expired", 403); 
    return c.redirect(await resolveRedirect(entry.value as string)); 
});

// SEARCH & CATEGORY
app.get("/search", async (c) => { 
    const user = await getCurrentUser(c); const query = c.req.query("q")?.toLowerCase() || ""; const results = await searchMoviesDB(query); 
    return c.html(<Layout user={user} lang={getLang(c)} activeTab="home"><div class="p-4"><h2 class="text-sm text-gray-400 mb-4 font-medium">Results for "{query}" ({results.length})</h2><div class="grid grid-cols-3 gap-2">{results.map(m => (<a href={`/movie/${m.id}`} class="block group relative"><div class="aspect-[2/3] relative overflow-hidden rounded-lg shadow-lg"><img src={m.posterUrl} loading="lazy" class="absolute inset-0 w-full h-full object-cover" /></div><div class="mt-2 text-center"><h3 class="text-[12px] font-bold truncate text-gray-200">{m.title}</h3></div></a>))}</div></div></Layout>); 
});
app.get("/category/:cat", async (c) => { 
    const user = await getCurrentUser(c); const cat = c.req.param("cat"); const movies = await getMoviesByCategory(cat, 50); 
    return c.html(<Layout user={user} lang={getLang(c)}><div class="p-4"><h1 class="text-xl font-bold text-white mb-4">{cat}</h1><div class="grid grid-cols-3 gap-2">{movies.map(m => (<a href={`/movie/${m.id}`} class="block"><img src={m.posterUrl} class="rounded-lg mb-2"/><p class="text-xs truncate text-gray-300">{m.title}</p></a>))}</div></div></Layout>); 
});

// 🔥 AUTH WITH ZOD VALIDATION
app.get("/login", (c) => c.html(<Layout hideNav={true}><div class="h-screen flex items-center justify-center bg-black p-4"><form action="/login" method="post" class="w-full max-w-sm bg-zinc-900 p-8 rounded-2xl border border-zinc-800 space-y-4 shadow-2xl"><h1 class="text-2xl font-bold text-white text-center">Login</h1><input name="username" placeholder="Username" class="input-box" /><input type="password" name="password" placeholder="Password" class="input-box" /><button class="btn-primary">Sign In</button><a href="/signup" class="block text-center text-xs text-blue-400">Create Account</a></form></div></Layout>));
app.post("/login", async (c) => { 
    const ip = getClientIp(c); const body = await c.req.parseBody(); 
    const result = loginSchema.safeParse(body);
    if (!result.success) return c.redirect("/login?error=Invalid Input Format");

    const user = await getUser(result.data.username); 
    if (user && user.passwordHash === await hashPassword(result.data.password)) { 
        if (user.isBanned) return c.redirect("/login?error=Banned");
        const sessionId = crypto.randomUUID(); user.sessionId = sessionId; user.lastLoginIp = ip; 
        await kv.set(["users", user.username], user); 
        setCookie(c, "auth_session", `${user.username}:${sessionId}`, { path: "/", maxAge: 86400*7, httpOnly: true }); 
        return c.redirect("/"); 
    } 
    await recordLoginFail(ip);
    return c.redirect("/login?error=Invalid Credentials"); 
});
app.get("/signup", (c) => c.html(<Layout hideNav={true}><div class="h-screen flex items-center justify-center bg-black p-4"><form action="/signup" method="post" class="w-full max-w-sm bg-zinc-900 p-8 rounded-2xl border border-zinc-800 space-y-4"><h1 class="text-2xl font-bold text-white text-center">Sign Up</h1><input name="username" placeholder="Username" class="input-box" /><input type="password" name="password" placeholder="Password" class="input-box" /><select name="question" class="input-box bg-black"><option value="pet">First Pet Name?</option><option value="school">First School?</option></select><input name="answer" placeholder="Security Answer" class="input-box" /><button class="btn-primary">Register</button></form></div></Layout>));
app.post("/signup", async (c) => { 
    const body = await c.req.parseBody();
    const result = signupSchema.safeParse(body);
    if (!result.success) return c.redirect("/signup?error=Invalid Format (Min 6 chars pass)");
    if (await getUser(result.data.username)) return c.redirect("/signup?error=User exists"); 
    const newUser: User = { username: result.data.username, passwordHash: await hashPassword(result.data.password), expiryDate: null, favorites: [], sessionId: "", ip: getClientIp(c), lastLoginIp: "", isBanned: false, coins: 0, purchased: [], securityQ: result.data.question, securityA: await hashPassword(result.data.answer) }; 
    await kv.set(["users", newUser.username], newUser); 
    return c.redirect("/login?success=Created"); 
});
app.get("/logout", (c) => { deleteCookie(c, "auth_session"); return c.redirect("/"); });

// USER PROFILE
app.get("/profile", async (c) => {
    const user = await getCurrentUser(c); if(!user) return c.redirect("/login");
    const isVip = isPremium(user, await getConfig());
    return c.html(<Layout user={user} activeTab="me"><div class="p-6 max-w-2xl mx-auto space-y-5"><div class="bg-gradient-to-br from-purple-900/50 to-black p-6 rounded-xl border border-purple-500/20 text-center"><div class="w-20 h-20 bg-purple-600 rounded-full mx-auto flex items-center justify-center text-2xl font-bold mb-4 border-4 border-black shadow-lg">{user.username[0]}</div><h2 class="text-2xl font-bold text-white">{user.username}</h2><p class="text-gray-400 mb-6 font-mono text-xs">{isVip ? "VIP Member" : "Free Account"} • {user.coins || 0} Ks</p><div class="grid grid-cols-2 gap-3"><a href="/favorites" class="bg-zinc-800 p-3 rounded-lg text-xs font-bold text-gray-300">Saved Movies</a><a href="/request" class="bg-zinc-800 p-3 rounded-lg text-xs font-bold text-gray-300">Requests</a></div></div><div class="bg-[#1f1f1f] p-5 rounded-lg border border-blue-900/30"><h3 class="font-bold text-blue-400 text-sm mb-4">Manual Top-up</h3><form action="/profile/topup" method="post" class="space-y-4"><div class="grid grid-cols-2 gap-3"><label class="cursor-pointer"><input type="radio" name="method" value="kpay" checked class="mr-2"/>KPay</label><label class="cursor-pointer"><input type="radio" name="method" value="wave" class="mr-2"/>Wave</label></div><input type="number" name="amount" placeholder="Amount" class="input-box" required /><input name="transactionId" placeholder="Transaction ID (Last 4 Digits)" class="input-box" required /><button class="btn-primary">Submit Top-up</button></form></div><a href="/logout" class="block text-center text-red-500 font-bold mt-8 bg-red-900/10 py-3 rounded-xl border border-red-500/20">Sign Out</a></div></Layout>);
});
app.post("/profile/topup", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const { amount, method, transactionId } = await c.req.parseBody(); const topup: TopupRequest = { id: crypto.randomUUID(), username: user.username, amount: parseInt(String(amount)), method: String(method), transactionId: String(transactionId), status: "pending", timestamp: Date.now(), purpose: "Topup" }; await kv.set(["topups", topup.id], topup); return c.redirect("/profile?success=Top-up Submitted"); });
app.get("/request", async (c) => { const user = await getCurrentUser(c); return c.html(<Layout user={user} activeTab="request"><div class="p-6"><h1 class="text-2xl font-bold mb-4 text-white">Request Movie</h1><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name..." class="input-box" required /><button class="btn-primary">Submit</button></form></div></Layout>); });
app.post("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const { movieName } = await c.req.parseBody(); const req: UserRequest = { id: crypto.randomUUID(), username: user.username, movieName: String(movieName), timestamp: Date.now() }; await kv.set(["requests", req.id], req); return c.redirect("/request?success=Sent"); });

// =======================
// 6. ADMIN DASHBOARD (FULL FEATURES)
// =======================
app.get(ADMIN_ROUTE, (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action={ADMIN_ROUTE + "/login"} method="post" class="bg-zinc-900 p-8 rounded-lg w-80 border border-zinc-800"><h2 class="font-bold text-center mb-6 text-blue-500 text-xl">ADMIN ACCESS</h2><input type="password" name="password" placeholder="Key" class="input-box mb-4 text-center" /><button class="bg-blue-600 text-white w-full py-3 rounded-xl font-bold">Unlock</button></form></div></Layout>));
app.post(ADMIN_ROUTE + "/login", async (c) => { 
    const { password } = await c.req.parseBody(); 
    if (password === ADMIN_PASS) { 
        const sessionId = crypto.randomUUID();
        await kv.set(["admin_sessions", sessionId], "active", { expireIn: ADMIN_SESSION_EXPIRE });
        setCookie(c, "admin_session_id", sessionId, { path: "/", httpOnly: true, secure: true }); 
        return c.redirect(ADMIN_ROUTE + "/dashboard"); 
    } 
    return c.redirect(ADMIN_ROUTE); 
});

app.get(ADMIN_ROUTE + "/dashboard", adminGuard, async (c) => { 
    const movies = await getLatestMovies(100);
    const keys = await getKeys(); 
    const requests = await getRequests(); 
    const topups = await getTopups();
    const editId = c.req.query("edit"); 
    const editMovie = editId ? await getMovie(editId) : null; 

    return c.html(
        <Layout title="Admin" isAdmin={true}>
            <div class="p-4 bg-black min-h-screen font-sans text-sm">
                <div class="flex justify-between mb-6 bg-zinc-900 p-4 rounded-xl border border-zinc-800 items-center">
                    <h1 class="font-bold text-blue-500 text-lg flex items-center gap-2"><i class="fa-solid fa-shield-cat"></i> Dashboard</h1>
                    <div class="flex gap-2 overflow-x-auto">
                        <button onclick="openTab('movies')" class="tab-btn active px-3 py-1 bg-zinc-800 rounded text-gray-300">Movies</button>
                        <button onclick="openTab('tools')" class="tab-btn px-3 py-1 bg-zinc-800 rounded text-gray-300">Tools</button>
                        <button onclick="openTab('topups')" class="tab-btn px-3 py-1 bg-zinc-800 rounded text-gray-300">Topups</button>
                        <button onclick="openTab('keys')" class="tab-btn px-3 py-1 bg-zinc-800 rounded text-gray-300">Keys</button>
                    </div>
                </div>
                
                {/* 1. MOVIES TAB */}
                <div id="tab-movies" class="tab-content active">
                    <div class="grid lg:grid-cols-3 gap-6">
                        <div class="bg-zinc-900 p-5 rounded-lg border border-zinc-800 h-fit">
                            <h2 class="font-bold text-yellow-500 mb-4">{editMovie ? "✏️ EDIT MOVIE" : "✨ ADD MOVIE"}</h2>
                            <form action="/admin/movie/save" method="post" class="space-y-3">
                                <input type="hidden" name="id" value={editMovie?.id || crypto.randomUUID()} />
                                <input name="title" placeholder="Title" value={editMovie?.title} class="input-box bg-black border-zinc-700" required />
                                <input name="posterUrl" placeholder="Poster URL" value={editMovie?.posterUrl} class="input-box bg-black border-zinc-700" required />
                                <input name="coverUrl" placeholder="Cover URL" value={editMovie?.coverUrl} class="input-box bg-black border-zinc-700" />
                                <div class="flex gap-2"><select name="category" class="input-box bg-black border-zinc-700">{["Movies","Series","All Uncensored","4K Movies"].map(o => <option selected={editMovie?.category===o}>{o}</option>)}</select><input name="year" value={editMovie?.year || "2025"} class="input-box bg-black border-zinc-700 w-24 text-center" /></div>
                                <input name="streamUrl" placeholder="Stream URL" value={editMovie?.streamUrl} class="input-box bg-black border-zinc-700" />
                                <input name="price" placeholder="Price (Optional)" value={editMovie?.price} type="number" class="input-box bg-black border-zinc-700" />
                                <textarea name="description" placeholder="Description..." class="input-box bg-black border-zinc-700 h-20">{editMovie?.description}</textarea>
                                <button class="btn-primary shadow-lg">{editMovie ? "Update" : "Publish"}</button>
                            </form>
                        </div>
                        <div class="lg:col-span-2 bg-zinc-900 p-5 rounded-lg border border-zinc-800 h-[80vh] overflow-y-auto custom-scroll">
                            {movies.map(m => (
                                <div class="flex justify-between items-center p-3 border-b border-zinc-800 hover:bg-black/30 transition">
                                    <div class="flex items-center gap-3">
                                        <img src={m.posterUrl} class="w-8 h-12 bg-gray-800 object-cover rounded"/>
                                        <div><div class="text-xs font-bold text-white">{m.title}</div><div class="text-[10px] text-gray-500">{m.category}</div></div>
                                    </div>
                                    <div class="flex gap-2"><a href={`?edit=${m.id}`} class="text-blue-500 text-xs bg-blue-500/10 px-2 py-1 rounded">Edit</a><form action="/admin/movie/delete" method="post"><input type="hidden" name="id" value={m.id} /><button class="text-red-500 text-xs bg-red-500/10 px-2 py-1 rounded">Del</button></form></div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* 2. ADMIN TOOLS TAB (New Features) */}
                <div id="tab-tools" class="tab-content hidden">
                    <div class="grid gap-6">
                        {/* BULK EDIT */}
                        <div class="bg-zinc-900 p-6 rounded-xl border border-zinc-800">
                            <h2 class="font-bold text-white mb-4">⚡ Bulk Category Editor</h2>
                            <form action="/admin/tools/bulk-edit" method="post">
                                <div class="max-h-60 overflow-y-auto custom-scroll mb-4 border border-zinc-800 rounded p-2 bg-black">
                                    {movies.map(m => (
                                        <label class="flex items-center gap-2 p-2 hover:bg-zinc-800 cursor-pointer border-b border-zinc-900">
                                            <input type="checkbox" name="ids[]" value={m.id} />
                                            <span class="text-xs text-gray-400">{m.title}</span> <span class="text-[10px] text-zinc-600">({m.category})</span>
                                        </label>
                                    ))}
                                </div>
                                <div class="flex gap-2">
                                    <select name="newCategory" class="input-box bg-black text-xs py-2"><option>Movies</option><option>Series</option><option>All Uncensored</option></select>
                                    <button class="bg-blue-600 text-white px-4 py-2 rounded font-bold text-xs hover:bg-blue-500">Update Selected</button>
                                </div>
                            </form>
                        </div>

                        {/* BROKEN LINK SCANNER */}
                        <div class="bg-zinc-900 p-6 rounded-xl border border-zinc-800">
                            <h2 class="font-bold text-red-500 mb-2">🔗 Broken Link Scanner</h2>
                            <p class="text-xs text-gray-500 mb-3">Checks the stream URLs of latest 50 movies.</p>
                            <div id="scan-results" class="bg-black h-40 overflow-y-auto p-2 text-[10px] font-mono mb-2 rounded border border-zinc-800 text-gray-400">Ready to scan...</div>
                            <button hx-post="/admin/tools/scan" hx-target="#scan-results" class="bg-red-900/50 text-red-400 w-full py-2 rounded text-xs font-bold border border-red-500/30 hover:bg-red-900">Start Scan</button>
                        </div>
                    </div>
                </div>

                {/* 3. TOPUPS TAB */}
                <div id="tab-topups" class="tab-content hidden">
                    <div class="bg-zinc-900 p-6 rounded-xl border border-zinc-800">
                         <h2 class="font-bold text-green-500 mb-4">Top-up Requests</h2>
                         <div class="space-y-2">
                            {topups.map(t => (
                                <div class="flex justify-between items-center p-3 bg-black rounded border border-zinc-800">
                                    <div class="text-xs text-gray-300">
                                        <span class="font-bold text-white">{t.amount} Ks</span> via {t.method} <br/>
                                        User: {t.username} | ID: {t.transactionId}
                                    </div>
                                    <div class="flex gap-2">
                                        {t.status === 'pending' ? (<><form action="/admin/topup/approve" method="post"><input type="hidden" name="id" value={t.id}/><button class="text-green-500 bg-green-900/20 px-2 py-1 rounded text-xs">Approve</button></form><form action="/admin/topup/reject" method="post"><input type="hidden" name="id" value={t.id}/><button class="text-red-500 bg-red-900/20 px-2 py-1 rounded text-xs">Reject</button></form></>) : <span class={`text-xs font-bold ${t.status==='approved'?'text-green-600':'text-red-600'}`}>{t.status.toUpperCase()}</span>}
                                    </div>
                                </div>
                            ))}
                         </div>
                    </div>
                </div>

                {/* 4. KEYS TAB */}
                <div id="tab-keys" class="tab-content hidden">
                    <div class="bg-zinc-900 p-6 rounded-xl border border-zinc-800">
                        <h2 class="font-bold text-purple-500 mb-4">Generate Keys</h2>
                        <form action="/admin/key/create" method="post" class="flex gap-3 mb-6">
                             <input name="days" placeholder="Days (e.g 30)" type="number" class="input-box bg-black"/>
                             <button class="bg-purple-600 text-white px-4 rounded font-bold">Gen</button>
                        </form>
                        <div class="space-y-2 max-h-60 overflow-y-auto">
                            {keys.map(k => (
                                <div class="flex justify-between p-2 bg-black rounded border border-zinc-800">
                                    <span class="font-mono text-white">{k.code}</span>
                                    <span class="text-gray-500 text-xs">{k.days} Days</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

            </div>
        </Layout>
    );
});

// ADMIN ACTIONS
app.post("/admin/movie/save", adminGuard, async (c) => {
    const body = await c.req.parseBody();
    const movie: Movie = {
        id: String(body.id), title: cleanText(String(body.title)), posterUrl: String(body.posterUrl),
        coverUrl: String(body.coverUrl || body.posterUrl), category: String(body.category) as any, description: cleanText(String(body.description)),
        tags: String(body.title).toLowerCase(), year: String(body.year), streamUrl: String(body.streamUrl),
        linkType: "direct", createdAt: Date.now(), price: Number(body.price) || 0
    };
    await saveMovieDB(movie);
    return c.redirect(ADMIN_ROUTE + "/dashboard");
});
app.post("/admin/movie/delete", adminGuard, async (c) => { const { id } = await c.req.parseBody(); await deleteMovieDB(String(id)); return c.redirect(ADMIN_ROUTE + "/dashboard"); });

// 🔥 BULK EDIT ACTION
app.post("/admin/tools/bulk-edit", adminGuard, async (c) => {
    const body = await c.req.parseBody();
    const ids = body["ids[]"];
    const newCat = String(body.newCategory);
    if (!ids) return c.redirect(ADMIN_ROUTE + "/dashboard");
    const idList = Array.isArray(ids) ? ids : [ids];
    for (const id of idList) {
        const m = await getMovie(String(id));
        if (m) { m.category = newCat as any; await saveMovieDB(m); }
    }
    return c.redirect(ADMIN_ROUTE + "/dashboard?success=Updated");
});

// 🔥 BROKEN LINK SCANNER ACTION (Streamed)
app.post("/admin/tools/scan", adminGuard, async (c) => {
    const movies = await getLatestMovies(50);
    const stream = new ReadableStream({
        async start(controller) {
            const enc = new TextEncoder();
            for (const m of movies) {
                const url = await getMovie(m.id).then(mov => mov?.streamUrl);
                if (!url || !url.startsWith("http")) continue;
                try {
                    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
                    if (res.ok) controller.enqueue(enc.encode(`<div class="text-green-500 border-b border-zinc-800 py-1">✔ ${m.title} - OK</div>`));
                    else controller.enqueue(enc.encode(`<div class="text-red-500 border-b border-zinc-800 py-1">❌ ${m.title} - BROKEN (${res.status})</div>`));
                } catch { controller.enqueue(enc.encode(`<div class="text-red-500 border-b border-zinc-800 py-1">❌ ${m.title} - TIMEOUT</div>`)); }
            }
            controller.close();
        }
    });
    return new Response(stream, { headers: { "Content-Type": "text/html" } });
});

// KEYS & TOPUPS
app.post("/admin/key/create", adminGuard, async (c) => { 
    const { days } = await c.req.parseBody(); 
    const key: VipKey = { code: crypto.randomUUID().slice(0,8).toUpperCase(), days: parseInt(String(days)), type: "vip" }; 
    await kv.set(["keys", key.code], key); 
    return c.redirect(ADMIN_ROUTE+"/dashboard"); 
});
app.post("/admin/topup/approve", adminGuard, async (c) => {
    const { id } = await c.req.parseBody();
    const topupRes = await kv.get<TopupRequest>(["topups", String(id)]);
    const topup = topupRes.value;
    if (topup && topup.status === 'pending') {
        const userRes = await kv.get<User>(["users", topup.username]);
        const user = userRes.value;
        if(user) {
            user.coins = (user.coins || 0) + topup.amount;
            await kv.set(["users", user.username], user);
            topup.status = 'approved';
            await kv.set(["topups", String(id)], topup);
        }
    }
    return c.redirect(ADMIN_ROUTE+"/dashboard");
});
app.post("/admin/topup/reject", adminGuard, async (c) => {
    const { id } = await c.req.parseBody();
    const topupRes = await kv.get<TopupRequest>(["topups", String(id)]);
    if(topupRes.value) { topupRes.value.status = 'rejected'; await kv.set(["topups", String(id)], topupRes.value); }
    return c.redirect(ADMIN_ROUTE+"/dashboard");
});

Deno.serve(app.fetch);
