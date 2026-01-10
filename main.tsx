/** @jsxImportSource npm:hono@4/jsx */
import { Hono } from "npm:hono@4";
import { getCookie, setCookie, deleteCookie } from "npm:hono@4/cookie";
import { secureHeaders } from "npm:hono@4/secure-headers";
import { compress } from "npm:hono@4/compress";
import { csrf } from "npm:hono@4/csrf";

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
const CACHE_TTL = 5 * 60 * 1000; // 5 Minutes Cache

const i18n: any = {
    en: {
        home: "Home", saved: "Saved", request: "Request", login: "Login", me: "Me",
        search_ph: "Search movies...", featured: "Featured", play: "Watch Now",
        see_all: "View All", views: "Views", dl_help: "How to Download",
        server1: "Server 1", server2: "Server 2", share: "Share",
        unlock: "Unlock VIP", vip_only: "VIP Exclusive",
        access_denied: "Access Denied", ip_banned: "Your IP is restricted.",
        security_alert: "Security Check", wait: "Please Wait",
        dl_btn: "Download"
    },
    my: {
        home: "ပင်မ", saved: "သိမ်းဆည်း", request: "တောင်းဆို", login: "ဝင်ရန်", me: "မိမိ",
        search_ph: "ဇာတ်ကားရှာရန်...", featured: "အထူးပြသ", play: "ကြည့်မည်",
        see_all: "အားလုံးကြည့်", views: "ကြိမ်", dl_help: "ဒေါင်းနည်း",
        server1: "ဆာဗာ ၁", server2: "ဆာဗာ ၂", share: "မျှဝေမည်",
        unlock: "VIP ဖွင့်ရန်", vip_only: "VIP သီးသန့်",
        access_denied: "ဝင်ရောက်ခွင့် ပိတ်ပင်ထားသည်", ip_banned: "သင့် IP ကို ပိတ်ပင်ထားပါသည်။",
        security_alert: "လုံခြုံရေး သတိပေးချက်", wait: "ခေတ္တစောင့်ပါ",
        dl_btn: "ဒေါင်းလုပ်",
        create_acc: "အကောင့်သစ်",
        username: "အမည် (Username)",
        password: "စကားဝှက် (Password)",
        remember: "မှတ်ထားမည် (၇ ရက်)",
        no_acc: "အကောင့်မရှိဘူးလား?",
        has_acc: "အကောင့်ရှိပြီးသားလား?",
        signup: "မှတ်ပုံတင်မည်",
        forgot_pass: "စကားဝှက် မေ့နေပါသလား?",
        reset_pass: "စကားဝှက် အသစ်ပြန်ယူမည်",
        sec_q: "လုံခြုံရေး မေးခွန်း",
        sec_a: "အဖြေ",
        new_pass: "စကားဝှက် အသစ်",
        next: "ရှေ့ဆက်မည်",
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
    coins?: number;
    purchased?: string[];
    securityQ?: string;
    securityA?: string;
}
interface VipKey { code: string; days: number; type?: "vip" | "coin"; value?: number; }
interface UserRequest { id: string; username: string; movieName: string; timestamp: number; }
interface TopupRequest { id: string; username: string; amount: number; method: string; transactionId: string; status: "pending" | "approved" | "rejected"; timestamp: number; }
interface AdminLog { id: string; action: string; details: string; timestamp: number; }
interface AppConfig { announcement: string; showAnnouncement: boolean; globalVipExpiry?: number;
    popupImage?: string; popupMessage?: string; popupBtnText?: string; popupLink?: string; popupTarget?: string; showPopup?: boolean; maintenanceMode?: boolean;
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
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 🔥 UPDATE: Tokenizer for Indexing (Search အမြန်စနစ်အတွက် စာလုံးခွဲပေးခြင်း)
function tokenize(text: string): string[] {
    return text.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "") // Remove special chars
        .split(/\s+/) // Split by space
        .filter(w => w.length > 1); // Keep words > 1 char
}

async function checkLoginRateLimit(ip: string): Promise<boolean> {
    const key = ["login_limit", ip];
    const res = await kv.get<{ count: number }>(key);
    const count = res.value?.count || 0;
    if (count >= 5) return false;
    return true;
}

async function recordLoginFail(ip: string) {
    const key = ["login_limit", ip];
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

async function resolveRedirect(url: string) {
  if (!url || !url.startsWith('http')) return url;
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

function clearConfigCache() {
    RAM_CACHE.config = { data: null, timestamp: 0 };
}

// 🔥 UPDATE: Save function with Indexing Logic
async function saveMovieDB(movie: Movie) {
    const summary: MovieSummary = {
        id: movie.id, title: movie.title, posterUrl: movie.posterUrl,
        coverUrl: movie.coverUrl, category: movie.category, createdAt: movie.createdAt
    };

    // 1. Clean up old indexes if updating
    const oldRes = await kv.get<Movie>(["movies", movie.id]);
    const old = oldRes.value;

    if (old) {
        // Cleanup old search indexes
        const oldWords = tokenize(old.title + " " + (old.tags || ""));
        for (const w of oldWords) await kv.delete(["idx_search", w, movie.id]);

        if (old.category !== movie.category) {
            await kv.delete(["idx_cat", old.category, old.createdAt, old.id]);
            try {
                const oldKey = ["counts", old.category];
                const oldCnt = await kv.get(oldKey);
                if (oldCnt.value) await kv.set(oldKey, new Deno.KvU64(BigInt(Math.max(0, Number(oldCnt.value) - 1))));
            } catch (e) {}
        }
        if (old.createdAt !== movie.createdAt) {
             await kv.delete(["idx_time", old.createdAt, old.id]);
             if (old.category === movie.category) await kv.delete(["idx_cat", old.category, old.createdAt, old.id]);
        }
    }

    if (!old || old.category !== movie.category) {
        try {
            const newKey = ["counts", movie.category];
            const newCnt = await kv.get(newKey);
            await kv.set(newKey, new Deno.KvU64(BigInt((newCnt.value ? Number(newCnt.value) : 0) + 1)));
        } catch (e) {}
    }

    // 2. Save new data and indexes
    const atomic = kv.atomic();
    atomic.set(["movies", movie.id], movie);
    atomic.set(["idx_time", movie.createdAt, movie.id], summary);
    atomic.set(["idx_cat", movie.category, movie.createdAt, movie.id], summary);

    // 3. New Search Index
    const newWords = tokenize(movie.title + " " + (movie.tags || ""));
    for (const w of newWords) {
        atomic.set(["idx_search", w, movie.id], movie.createdAt);
    }

    await atomic.commit();
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
}

async function deleteMovieDB(id: string) {
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
    const res = await kv.get<Movie>(["movies", id]);
    if (!res.value) return;
    const m = res.value;

    const atomic = kv.atomic();
    atomic.delete(["movies", id]);
    atomic.delete(["idx_time", m.createdAt, id]);
    atomic.delete(["idx_cat", m.category, m.createdAt, id]);
    
    // Delete Search Indexes
    const words = tokenize(m.title + " " + (m.tags || ""));
    for (const w of words) atomic.delete(["idx_search", w, id]);

    try {
        const countKey = ["counts", m.category];
        const countRes = await kv.get(countKey);
        if (countRes.value) atomic.set(countKey, new Deno.KvU64(BigInt(Math.max(0, Number(countRes.value) - 1))));
    } catch (e) {}

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

// 🔥 UPDATE: FAST Search Logic
async function searchMoviesDB(query: string) {
    const words = tokenize(query);
    if (words.length === 0) return [];
    
    // Use the longest word for the primary index scan (most unique usually)
    const searchWord = words.reduce((a, b) => a.length > b.length ? a : b, "");
    const iter = kv.list({ prefix: ["idx_search", searchWord] }, { limit: 60 });
    const movieIds = new Set<string>();
    
    for await (const entry of iter) {
        movieIds.add(entry.key[2] as string); // ["idx_search", "word", "id"]
    }

    const results = [];
    for (const id of movieIds) {
        const m = await getMovie(id);
        if (m) results.push(m);
    }

    // Refine results: must match all keywords
    return results.filter(m => {
        const text = (m.title + " " + m.tags).toLowerCase();
        return words.every(w => text.includes(w));
    });
}

async function reIndexDatabase() {
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
    // Clear counts
    const cats = ["Movies","Series","4K Movies","Animation","Jav","All Uncensored","Myanmar and Asian","4K Porns"];
    for(const c of cats) await kv.delete(["counts", c]);

    const iter = kv.list<Movie>({ prefix: ["movies"] });
    for await (const res of iter) {
        await saveMovieDB(res.value); 
    }
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
  const now = Date.now();
  if (config.globalVipExpiry && config.globalVipExpiry > now) return true;
  if (!user || !user.expiryDate) return false;
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
// 4. UI LAYOUT
// =======================
const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean; announcement?: string; isAdmin?: boolean; coverUrl?: string; lang?: string; activeTab?: string }) => {
  const protectCSS = props.isAdmin ? "" : `* { -webkit-touch-callout: none !important; } img { pointer-events: none; }`;
  
  // 🔥 UPDATE: Allow context menu on Video for Download, Block on others
  const protectJS = props.isAdmin ? "" : `
    document.addEventListener('contextmenu', event => {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'VIDEO') return; 
        event.preventDefault();
    });
    window.addEventListener('dragstart', event => event.preventDefault());
`;
  const l = props.lang || "en";
  const t = i18n[l];
  const active = props.activeTab || "home";

  let daysLeft = 0;
  if (props.user && props.user.expiryDate) {
      const diff = new Date(props.user.expiryDate).getTime() - Date.now();
      if (diff > 0) daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24));
  }

  return (
  <html lang={l}>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>{props.title || "Gold Flix"}</title>
      <meta property="og:title" content={props.title || "Gold Flix"} />
      <meta property="og:image" content={props.coverUrl || "https://cdn-icons-png.flaticon.com/512/2503/2503508.png"} />
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&display=swap" rel="stylesheet" />
      <style>{`
        :root { --glass-bg: rgba(255, 255, 255, 0.08); --glass-border: rgba(255, 255, 255, 0.1); --primary: #8b5cf6; }
        body { background-color: #111827; color: #e2e8f0; font-family: 'Inter', sans-serif; padding-bottom: 90px; }
        ${protectCSS}
        .glass-panel { background: var(--glass-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--glass-border); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1); }
        .input-box { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); color: white; padding: 14px; border-radius: 12px; width: 100%; outline: none; transition: 0.3s; font-size: 14px; }
        .input-box:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2); }
        .btn-primary { background: linear-gradient(135deg, var(--primary), #6366f1); color: white; font-weight: 700; padding: 14px 20px; border-radius: 12px; transition: 0.3s; cursor: pointer; border: none; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3); }
        .bottom-nav { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); width: 90%; max-width: 400px; background: rgba(17, 24, 39, 0.95); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); display: flex; justify-content: space-around; padding: 12px 6px; z-index: 50; }
        .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; color: #94a3b8; transition: 0.3s; text-align: center; gap: 4px; }
        .nav-item.active { color: white; }
        .nav-item.active i { color: #c084fc; text-shadow: 0 0 15px rgba(192, 132, 252, 0.8); transform: translateY(-3px); }
        .top-header { position: fixed; top: 0; left: 0; width: 100%; z-index: 40; padding: 12px 20px; display: flex; justify-content: space-between; items-center; background: rgba(17, 24, 39, 0.9); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.05); }
        .announcement-bar { position: fixed; top: 60px; left: 0; width: 100%; z-index: 39; background: linear-gradient(90deg, #f59e0b, #d97706); color: black; font-size: 11px; font-weight: bold; padding: 8px 16px; display: flex; items-center; gap: 8px; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3); }
        .custom-scroll::-webkit-scrollbar { width: 0px; height: 0px; }
        #toast-box { position: fixed; top: 24px; right: 20px; z-index: 10000; display: flex; flex-direction: column; gap: 10px; }
        .toast { padding: 16px 24px; border-radius: 12px; color: white; font-weight: 600; display: flex; items-center; gap: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); animation: slideIn 0.4s ease; min-width: 280px; border: 1px solid rgba(255,255,255,0.1); background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(10px); }
        .toast.error { border-left: 4px solid #f43f5e; }
        .toast.success { border-left: 4px solid #10b981; }
        #search-overlay { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.98); backdrop-filter: blur(20px); z-index: 100; transform: translateY(-100%); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); display: flex; flex-direction: column; padding: 20px; }
        #search-overlay.open { transform: translateY(0); }
        #instant-results { overflow-y: auto; flex-grow: 1; margin-top: 10px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding-bottom: 50px; }
        #page-loader { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.9); z-index: 99999; display: none; justify-content: center; align-items: center; backdrop-filter: blur(5px); }
        #page-loader.active { display: flex; }
        .spinner { width: 50px; height: 50px; border: 3px solid rgba(255,255,255,0.1); border-radius: 50%; border-top: 3px solid #c084fc; animation: spin 0.8s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .movie-card { transition: all 0.3s ease; }
        .movie-card:hover { transform: translateY(-5px); }
        .tab-btn.active { background: #8b5cf6; color: white; }
        .tab-content { display: none; animation: fadeIn 0.3s ease; }
        .tab-content.active { display: block; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 16px; padding-bottom: 24px; scroll-snap-type: x mandatory; padding-left: 20px; padding-right: 20px; scrollbar-width: none; }
        .h-scroll-item { width: 120px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item.wide { width: 280px; }
        img.img-fade { opacity: 0; transition: opacity 0.5s ease-in-out; }
        img.img-fade.loaded { opacity: 1; }
        .img-skeleton { background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%); background-size: 200% 100%; animation: skeleton-load 1.5s infinite; }
        @keyframes skeleton-load { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        ${protectJS}
        window.imgLoaded = function(img) { img.classList.add('loaded'); if(img.parentElement.classList.contains('img-skeleton')) img.parentElement.classList.remove('img-skeleton'); }
        document.addEventListener('DOMContentLoaded', () => {
             const loader = document.getElementById('page-loader');
             window.showLoader = () => { if(loader) loader.classList.add('active'); setTimeout(() => { if(loader) loader.classList.remove('active'); }, 5000); };
             window.hideLoader = () => { if(loader) loader.classList.remove('active'); };
             document.querySelectorAll('form').forEach(f => f.addEventListener('submit', window.showLoader));
             document.body.addEventListener('click', (e) => {
                const link = e.target.closest('a');
                if (link && link.getAttribute('href')?.startsWith('/') && !link.getAttribute('href').includes('#')) window.showLoader();
             });
             window.addEventListener('pageshow', window.hideLoader);
             
             setTimeout(() => { document.querySelectorAll('img.img-fade').forEach(img => { if(img.complete) window.imgLoaded(img); }); }, 100);

             const urlParams = new URLSearchParams(window.location.search);
             if(urlParams.get('error')) showToast(urlParams.get('error'), 'error');
             if(urlParams.get('success')) showToast(urlParams.get('success'), 'success');
             if(urlParams.get('error')||urlParams.get('success')) window.history.replaceState({}, document.title, window.location.pathname);
             
             window.toggleSearch = function() {
                 const overlay = document.getElementById('search-overlay');
                 const input = document.getElementById('search-input-main');
                 overlay.classList.toggle('open');
                 if(overlay.classList.contains('open')) { if(input) setTimeout(() => input.focus(), 100); document.body.style.overflow = 'hidden'; }
                 else { document.body.style.overflow = 'auto'; }
             }
             
             let searchTimeout;
             const searchInput = document.getElementById('search-input-main');
             const resultsContainer = document.getElementById('instant-results');
             if(searchInput) {
                 searchInput.addEventListener('input', (e) => {
                     const val = e.target.value.trim();
                     clearTimeout(searchTimeout);
                     if(val.length < 1) { resultsContainer.innerHTML = ''; return; }
                     searchTimeout = setTimeout(async () => {
                         resultsContainer.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-4">Searching...</div>';
                         const res = await fetch('/api/search?q=' + encodeURIComponent(val));
                         const data = await res.json();
                         if(data.results.length === 0) { resultsContainer.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-4">No results</div>'; } 
                         else {
                             resultsContainer.innerHTML = data.results.map(m => \`
                                 <a href="/movie/\${m.id}" class="block rounded-xl overflow-hidden glass-panel aspect-[2/3] relative group">
                                     <img src="\${m.posterUrl}" class="absolute inset-0 w-full h-full object-cover" />
                                     <div class="absolute bottom-0 left-0 right-0 p-2 bg-black/80"><p class="text-[10px] font-bold text-white truncate">\${m.title}</p></div>
                                 </a>\`).join('');
                         }
                     }, 300);
                 });
             }
             
             window.openTab = function(name) {
                 document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                 document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                 document.getElementById('tab-'+name).classList.add('active');
                 document.getElementById('btn-'+name).classList.add('active');
                 localStorage.setItem('adminTab', name);
             }
             const savedTab = localStorage.getItem('adminTab');
             if(savedTab && document.getElementById('tab-'+savedTab)) openTab(savedTab);
             window.copyToClip = function(text) { if(navigator.clipboard) { navigator.clipboard.writeText(text); showToast('Copied!', 'success'); } }
             window.openBuyModal = function(price, title) { const modal = document.getElementById('buy-modal'); document.getElementById('buy-price').innerText = price + " Ks"; modal.classList.remove('hidden'); modal.classList.add('flex'); }
             window.closeBuyModal = function() { const modal = document.getElementById('buy-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }
             window.openVipModal = function() { document.getElementById('vip-modal').classList.remove('hidden'); document.getElementById('vip-modal').classList.add('flex'); }
             window.closeVipModal = function() { document.getElementById('vip-modal').classList.add('hidden'); document.getElementById('vip-modal').classList.remove('flex'); }
        });
        function showToast(msg, type) { const box=document.getElementById('toast-box'); const t=document.createElement('div'); t.className='toast '+type; t.innerHTML='<span>'+msg+'</span>'; box.appendChild(t); setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),500); },3000); }
        
        // 🔥 UPDATE: Native Video Player Integration
        // This ensures the browser's native controls (with download button) are used.
        window.loadPlayer = async function(content, type, movieId, title, poster, btnElement) {
            const container = document.getElementById('video-player');
            const cover = document.getElementById('video-cover');
            const loader = document.getElementById('video-player-loader');
            if(cover) cover.style.display = 'none';
            if(container) container.style.display = 'block'; 
            if(loader) loader.style.display = 'flex'; 

            let finalUrl = content;
            if (type === 'direct') { 
                try { 
                    const res = await fetch('/api/resolve-url?token=' + content); 
                    const data = await res.json(); 
                    if (data.url) finalUrl = data.url; 
                } catch (e) { console.error("Link Error", e); } 
            }
            
            // Standard Video Tag -> Enables "Download" in context menu or 3-dots
            container.innerHTML = '<video id="main-video" controls autoplay playsinline class="w-full h-full" style="background-color:black;" poster="'+poster+'"><source src="'+finalUrl+'" type="video/mp4"></video>';
            
            const video = document.getElementById('main-video');
            if(video) { 
                video.addEventListener('loadeddata', () => { if(loader) loader.style.display = 'none'; });
                video.addEventListener('error', () => { if(loader) loader.style.display = 'none'; });
                try { await video.play(); } catch(e) {}
            }
        }
      `}} />
    </head>
    <body>
      <div id="page-loader"><div class="spinner"></div></div>
      <div id="toast-box"></div>
      
      {/* SEARCH OVERLAY */}
      <div id="search-overlay">
          <div class="flex justify-between items-center mb-6">
              <h2 class="text-xl font-bold text-white">Search Movies</h2>
              <button onclick="toggleSearch()" class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center hover:bg-red-500 hover:text-white transition"><i class="fa-solid fa-xmark text-lg"></i></button>
          </div>
          <form action="/search" method="get" class="relative mb-6">
              <input id="search-input-main" name="q" placeholder="Type to search..." autocomplete="off" class="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-4 pr-4 text-white text-lg focus:border-purple-500 outline-none transition" />
          </form>
          <div id="instant-results" class="custom-scroll"></div>
      </div>

      {!props.hideNav && (
        <>
            <header class="top-header">
                <div class="flex items-center gap-3">
                    <a href="/" class="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600 tracking-tighter italic">GOLD FLIX</a>
                    <button onclick="toggleSearch()" class="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-gray-300"><i class="fa-solid fa-magnifying-glass text-xs"></i></button>
                </div>
                <div class="flex items-center gap-3">
                    {active === 'home' && !props.isAdmin && (
                        <div class="px-3 py-1 rounded-full border border-purple-500/30 bg-purple-500/10 text-[10px] font-bold text-purple-400 tracking-wide">P - {daysLeft} Day</div>
                    )}
                    {props.isAdmin ? (
                        <a href={ADMIN_ROUTE + "/dashboard"} class="text-xs font-bold bg-blue-600 text-white px-4 py-1.5 rounded-full">ADMIN</a>
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
      {props.announcement && <div class="announcement-bar"><i class="fa-solid fa-bullhorn text-white"></i><marquee scrollamount="5">{props.announcement}</marquee></div>}
      <main class={`flex-grow w-full ${props.announcement ? 'pt-[90px]' : 'pt-[70px]'}`}>{props.children}</main>
    </body>
  </html>
)};

// =======================
// 5. MAIN APP
// =======================
const app = new Hono();

app.use("*", secureHeaders({ xFrameOptions: "DENY", xContentTypeOptions: "nosniff", xXssProtection: "1; mode=block" }));
app.use("*", compress());
app.use("*", csrf({ origin: (origin) => true }));

app.get("/manifest.json", (c) => c.json({ "name": "Gold Flix", "short_name": "GoldFlix", "start_url": "/", "display": "standalone", "background_color": "#0f172a", "theme_color": "#0f172a", "icons": [{ "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "192x192", "type": "image/png" }, { "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "512x512", "type": "image/png" }] }));

app.get("/api/search", async (c) => {
    const query = c.req.query("q")?.toLowerCase() || "";
    if (query.length < 1) return c.json({ results: [] });
    const results = await searchMoviesDB(query);
    const cleanResults = results.map(m => ({ id: m.id, title: m.title, posterUrl: m.posterUrl }));
    return c.json({ results: cleanResults });
});

app.get("/api/resolve-url", async (c) => { 
    const token = c.req.query("token"); 
    const entry = await kv.get(["stream_tokens", token]); 
    if (!entry.value) return c.json({ error: "Invalid token" }, 404); 
    const url = await resolveRedirect(entry.value as string);
    return c.json({ url: url }); 
});

app.get("/lang/:code", (c) => {
    const code = c.req.param("code");
    setCookie(c, "app_lang", code === "en" ? "en" : "my", { path: "/", maxAge: 60 * 60 * 24 * 365 });
    return c.redirect(c.req.header("Referer") || "/");
});

app.get("/", async (c) => {
    const user = await getCurrentUser(c);
    const lang = getLang(c);
    const config = await getConfig();
    if (config.maintenanceMode && !getCookie(c, "admin_session_id")) return c.text("MAINTENANCE MODE ON", 503);

    const [sliderMovies, catMovies, catSeries, catUncen] = await Promise.all([
        getLatestMovies(5), getMoviesByCategory("Movies", 12), getMoviesByCategory("Series", 8), getMoviesByCategory("All Uncensored", 8)
    ]);
    
    return c.html(
      <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home">
        {sliderMovies.length > 0 && (
          <div class="px-4 mb-8 mt-4">
              <div class="relative w-full aspect-video rounded-2xl overflow-hidden shadow-2xl">
                   <img src={sliderMovies[0].coverUrl} class="w-full h-full object-cover" />
                   <div class="absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black via-black/50 to-transparent">
                        <h1 class="text-xl font-bold text-white mb-2">{sliderMovies[0].title}</h1>
                        <a href={`/movie/${sliderMovies[0].id}`} class="bg-white text-black px-4 py-2 rounded-full font-bold text-xs"><i class="fa-solid fa-play"></i> Watch</a>
                   </div>
              </div>
          </div>
        )}
        <div class="px-4 pb-8 space-y-8">
            <div>
                <h2 class="text-lg font-bold text-white mb-4 border-l-4 border-purple-500 pl-3">New Movies</h2>
                <div class="grid grid-cols-3 gap-3">
                    {catMovies.map(m => (
                        <a href={`/movie/${m.id}`} class="block rounded-xl overflow-hidden movie-card group glass-panel relative">
                            <div class="aspect-[2/3] relative overflow-hidden bg-zinc-800">
                                 <img src={m.posterUrl} loading="lazy" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" />
                            </div>
                            <div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div>
                        </a>
                    ))}
                </div>
            </div>
            {catSeries.length > 0 && (
                <div><h2 class="text-lg font-bold text-white mb-4 border-l-4 border-blue-500 pl-3">Series</h2>
                <div class="h-scroll-section custom-scroll">{catSeries.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item block relative rounded-xl overflow-hidden"><div class="aspect-[2/3] w-full relative"><img src={m.posterUrl} class="absolute inset-0 w-full h-full object-cover" /></div><div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div>
            )}
        </div>
      </Layout>
    );
});

app.get("/category/:cat", async (c) => {
    const user = await getCurrentUser(c);
    const cat = c.req.param("cat");
    const movies = await getMoviesByCategory(cat, 50);
    return c.html(<Layout user={user} activeTab="home"><div class="p-4"><h1 class="text-2xl font-bold mb-4">{cat}</h1><div class="grid grid-cols-3 gap-3">{movies.map(m => (<a href={`/movie/${m.id}`} class="block rounded-xl overflow-hidden movie-card"><div class="aspect-[2/3] relative"><img src={m.posterUrl} class="w-full h-full object-cover" /></div><div class="p-2"><h3 class="text-xs font-bold truncate">{m.title}</h3></div></a>))}</div></div></Layout>);
});

app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const lang = getLang(c);
    const user = await getCurrentUser(c);
    const config = await getConfig();
    const movie = await getMovie(id);
    if (!movie) return c.text("Not Found", 404);

    const isVip = isPremium(user, config);
    const moviePrice = movie.price || 0;
    const isPurchased = user?.purchased?.includes(movie.id);
    let canWatch = false;
    if (moviePrice > 0) { if (isPurchased) canWatch = true; } else { if (isVip) canWatch = true; }

    const token = crypto.randomUUID(); 
    await kv.set(["stream_tokens", token], movie.streamUrl, { expireIn: 3600 * 3 });

    return c.html(
      <Layout user={user} title={movie.title} coverUrl={movie.coverUrl} lang={lang}>
        
        <div id="buy-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-md p-4">
             <div class="glass-panel p-6 rounded-2xl w-full max-w-sm text-center">
                  <h3 class="text-xl font-black text-white mb-2">Purchase</h3>
                  <p class="text-gray-300 text-sm mb-6">Price: <span id="buy-price" class="text-white font-bold">--</span></p>
                  <div class="flex gap-3 h-12"> 
                      <button onclick="closeBuyModal()" class="flex-1 rounded-xl bg-slate-800 text-white">Cancel</button>
                      {user ? (<form action="/api/buy-movie" method="post" class="flex-1"><input type="hidden" name="movieId" value={movie.id} /><button class="w-full h-full rounded-xl bg-yellow-500 text-black font-bold">Buy Now</button></form>) : (<a href="/login" class="flex-1 flex items-center justify-center rounded-xl bg-blue-600 text-white">Login</a>)}
                  </div>
             </div>
        </div>

        <div id="vip-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-md p-4">
             <div class="glass-panel p-6 rounded-2xl w-full max-w-sm text-center">
                  <h3 class="text-lg font-black text-white mb-2">VIP Required</h3>
                  <div class="flex gap-3 h-12 mt-4"> 
                      <button onclick="closeVipModal()" class="flex-1 rounded-xl bg-slate-800 text-white">Cancel</button>
                      <a href={user ? "/profile" : "/login"} class="flex-1 flex items-center justify-center rounded-xl bg-purple-600 text-white font-bold">{user ? "Enter Key" : "Login"}</a>
                  </div>
             </div>
        </div>

        <div class="max-w-4xl mx-auto">
            <div class="w-full aspect-video bg-black relative shadow-lg group rounded-xl overflow-hidden border border-zinc-800">
                 {canWatch ? (
                    <>
                    <div id="video-cover" class="absolute inset-0 z-20 cursor-pointer group" onclick={`loadPlayer('${token}', 'direct', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`}>
                        <img src={movie.coverUrl || movie.posterUrl} class="w-full h-full object-cover transition duration-700 group-hover:scale-105" />
                        <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-300 bg-black/20"><i class="fa-solid fa-circle-play text-6xl text-white drop-shadow-lg"></i></div>
                    </div>
                    <div id="video-player" class="w-full h-full hidden"></div>
                    <div id="video-player-loader" class="absolute inset-0 z-10 bg-black flex items-center justify-center hidden"><div class="spinner"></div></div>
                    </>
                 ) : (
                    <div class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80">
                         <img src={movie.coverUrl} class="absolute inset-0 w-full h-full object-cover opacity-20" />
                         <i class="fa-solid fa-lock text-5xl text-gray-500 mb-4"></i>
                         <button onclick={moviePrice > 0 ? `openBuyModal('${moviePrice}')` : `openVipModal()`} class="bg-yellow-500 text-black font-bold px-6 py-3 rounded-full relative z-30 hover:scale-105 transition">{moviePrice > 0 ? `Buy for ${moviePrice}Ks` : "Unlock VIP"}</button>
                    </div>
                 )}
            </div>
            <div class="p-6">
                <div class="flex justify-between items-start mb-3">
                   <h1 class="text-2xl font-bold text-white mb-2">{movie.title}</h1>
                   <div class="flex items-center gap-2">
                       <button onclick={`copyToClip('${window.location.href}')`} class="w-10 h-10 flex items-center justify-center rounded-full bg-zinc-800"><i class="fa-solid fa-share-nodes"></i></button>
                       {user && (<form action="/api/fav" method="post"><input type="hidden" name="movieId" value={movie.id} /><button class="w-10 h-10 flex items-center justify-center rounded-full bg-zinc-800"><i class={`fa-solid fa-heart ${user.favorites?.includes(movie.id) ? 'text-red-600' : 'text-zinc-400'}`}></i></button></form>)}
                   </div>
                </div>
                <div class="flex flex-wrap gap-2 mb-4">
                     <span class="bg-zinc-800 text-xs px-3 py-1 rounded-full">{movie.year}</span>
                     <span class="bg-purple-900/30 text-purple-400 text-xs px-3 py-1 rounded-full">{movie.category}</span>
                </div>
                <p class="text-gray-400 text-sm mb-6 whitespace-pre-wrap">{movie.description}</p>
            </div>
        </div>
      </Layout>
    );
});

app.post("/api/buy-movie", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const { movieId } = await c.req.parseBody();
    const movie = await getMovie(String(movieId));
    if (!movie || !movie.price) return c.redirect(`/?error=Error`);
    if (user.coins && user.coins >= movie.price) {
        user.coins -= movie.price;
        if (!user.purchased) user.purchased = [];
        user.purchased.push(movie.id);
        await kv.set(["users", user.username], user);
        return c.redirect(`/movie/${movie.id}?success=Purchased`);
    }
    return c.redirect(`/movie/${movie.id}?error=Insufficient Coins`);
});

app.post("/api/fav", async (c) => { 
    const user = await getCurrentUser(c); 
    if (!user) return c.redirect("/login"); 
    const { movieId } = await c.req.parseBody(); 
    const id = String(movieId);
    if (!user.favorites) user.favorites = []; 
    if (user.favorites.includes(id)) user.favorites = user.favorites.filter(f => f !== id); 
    else user.favorites.push(id); 
    await kv.set(["users", user.username], user); 
    return c.redirect(c.req.header("Referer") || "/"); 
});

app.get("/favorites", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const favs = [];
    if(user.favorites) { for(const id of user.favorites) { const m = await getMovie(id); if(m) favs.push(m); } }
    return c.html(<Layout user={user} activeTab="saved"><div class="p-4"><h1 class="text-2xl font-bold mb-4">My Saved</h1><div class="grid grid-cols-3 gap-3">{favs.map(m => (<a href={`/movie/${m.id}`} class="block rounded-xl overflow-hidden movie-card"><img src={m.posterUrl} class="w-full aspect-[2/3] object-cover" /><div class="p-2"><h3 class="text-xs font-bold truncate">{m.title}</h3></div></a>))}</div></div></Layout>);
});

app.get("/request", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    return c.html(<Layout user={user} activeTab="request"><div class="p-6 max-w-md mx-auto min-h-[70vh] flex flex-col justify-center"><h1 class="text-3xl font-black mb-2 text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-500">Request Movie</h1><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name" required class="input-box" /><button class="btn-primary w-full">Submit</button></form></div></Layout>);
});
app.post("/request", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const { movieName } = await c.req.parseBody();
    const req: UserRequest = { id: crypto.randomUUID(), username: user.username, movieName: String(movieName), timestamp: Date.now() };
    await kv.set(["requests", req.id], req);
    return c.redirect("/request?success=Submitted");
});

// AUTH
app.get("/login", (c) => c.html(<Layout hideNav={true} activeTab="me"><div class="min-h-[80vh] flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-4xl font-black text-white mb-8 text-center italic">GOLD FLIX</h1><form action="/login" method="post" class="bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 space-y-5"><h2 class="text-xl font-bold text-white">Login</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full">Login</button><p class="text-xs text-center text-gray-500"><a href="/signup">Create Account</a></p></form></div></div></Layout>));
app.post("/login", async (c) => {
    const ip = getClientIp(c);
    if (!await checkLoginRateLimit(ip)) return c.redirect("/login?error=Too many attempts");
    const body = await c.req.parseBody();
    const user = await getUser(body["username"] as string);
    const hashedInput = await hashPassword(body["password"] as string);
    if (user && user.passwordHash === hashedInput) {
        if (user.isBanned) return c.redirect("/login?error=Banned");
        const sessionId = crypto.randomUUID();
        user.sessionId = sessionId; user.lastLoginIp = ip;
        await kv.set(["users", user.username], user);
        setCookie(c, "auth_session", `${user.username}:${sessionId}`, { path: "/", httpOnly: true, secure: true });
        return c.redirect("/");
    }
    await recordLoginFail(ip);
    return c.redirect("/login?error=Invalid Credentials");
});

app.get("/signup", (c) => c.html(<Layout hideNav={true} activeTab="me"><div class="min-h-[80vh] flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><form action="/signup" method="post" class="bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 space-y-5"><h2 class="text-xl font-bold text-white">Sign Up</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full">Sign Up</button></form></div></div></Layout>));
app.post("/signup", async (c) => {
    const { username, password } = await c.req.parseBody();
    if (await getUser(username as string)) return c.redirect("/signup?error=User Exists");
    const newUser: User = { username: String(username), passwordHash: await hashPassword(String(password)), expiryDate: null, favorites: [], sessionId: "", ip: getClientIp(c), coins: 0, purchased: [] };
    await kv.set(["users", String(username)], newUser);
    return c.redirect("/login?success=Created");
});

app.get("/profile", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const config = await getConfig();
    const premium = isPremium(user, config);
    return c.html(
      <Layout user={user} activeTab="me">
        <div class="p-4 space-y-4">
            <div class="bg-gradient-to-br from-[#FFD700] to-[#9e7f13] p-6 rounded-2xl text-black">
                <h2 class="text-2xl font-black">{user.username}</h2>
                <p class="font-bold">{premium ? "VIP Member" : "Free User"}</p>
                <p class="text-xs mt-2">Coins: {user.coins || 0} Ks</p>
                {premium && <p class="text-[10px] mt-1">Expiry: {user.expiryDate ? new Date(user.expiryDate).toLocaleDateString() : "Global VIP"}</p>}
            </div>
            
            <div class="bg-[#1f1f1f] p-5 rounded-2xl border border-zinc-800">
                 <h3 class="font-bold text-white mb-2">Redeem VIP/Coins</h3>
                 <form action="/profile/redeem" method="post" class="flex gap-2"><input name="key" placeholder="Enter Key" class="input-box" /><button class="btn-primary">Go</button></form>
            </div>

            <div class="bg-[#1f1f1f] p-5 rounded-2xl border border-zinc-800">
                 <h3 class="font-bold text-blue-400 mb-2">Manual Topup</h3>
                 <form action="/profile/topup" method="post" class="space-y-3">
                    <input type="number" name="amount" placeholder="Amount" class="input-box" />
                    <select name="method" class="input-box bg-black"><option value="kpay">KPay</option><option value="wave">Wave</option></select>
                    <input name="transactionId" placeholder="Transaction ID" class="input-box" />
                    <button class="w-full bg-blue-600 text-white font-bold py-3 rounded-xl">Submit</button>
                 </form>
            </div>

            <a href="/logout" class="block text-center text-red-500 mt-6 font-bold bg-red-900/10 py-3 rounded-xl">Logout</a>
        </div>
      </Layout>
    );
});

app.post("/profile/redeem", async (c) => {
    const user = await getCurrentUser(c);
    if(!user) return c.redirect("/login");
    const { key } = await c.req.parseBody();
    const k = await kv.get<VipKey>(["keys", String(key)]);
    if(!k.value) return c.redirect("/profile?error=Invalid Key");
    
    if(k.value.type === 'coin') {
        user.coins = (user.coins || 0) + (k.value.value || 0);
    } else {
        const exp = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date();
        exp.setDate(exp.getDate() + k.value.days);
        user.expiryDate = exp.toISOString();
    }
    
    await kv.set(["users", user.username], user);
    await kv.delete(["keys", String(key)]);
    return c.redirect("/profile?success=Redeemed");
});

app.post("/profile/topup", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const body = await c.req.parseBody();
    const req: TopupRequest = { id: crypto.randomUUID(), username: user.username, amount: Number(body.amount), method: String(body.method), transactionId: String(body.transactionId), status: 'pending', timestamp: Date.now() };
    await kv.set(["topups", req.id], req);
    return c.redirect("/profile?success=Submitted");
});

app.get("/logout", (c) => { deleteCookie(c, "auth_session"); return c.redirect("/"); });

// ADMIN DASHBOARD
app.get(ADMIN_ROUTE + "/dashboard", adminGuard, async (c) => { 
    c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    const adminQuery = c.req.query("q") || "";
    const limit = 50;
    
    let movies = [];
    if (adminQuery) {
        movies = await searchMoviesDB(adminQuery);
    } else {
        const iter = kv.list<MovieSummary>({ prefix: ["idx_time"] }, { reverse: true, limit: limit, cursor: c.req.query("cursor") });
        for await (const res of iter) movies.push(await getMovie(res.value.id));
    }

    const keys = await getKeys(); 
    const topups = await getTopups();
    const requests = await getRequests();

    return c.html(
        <Layout title="Admin" isAdmin={true}>
            <div class="p-4 bg-black min-h-screen text-sm">
                <div class="flex justify-between items-center mb-6 bg-[#111] p-4 rounded-xl border border-zinc-800">
                    <h1 class="font-bold text-blue-500">Admin Dashboard</h1>
                    <div class="flex gap-2"><a href="/admin/backup-ndjson" class="bg-zinc-800 text-white px-3 py-1.5 rounded text-xs">Backup</a><form action="/admin/restore-ndjson" method="post" enctype="multipart/form-data"><label class="bg-zinc-800 text-white px-3 py-1.5 rounded text-xs cursor-pointer">Restore <input type="file" name="file" class="hidden" onchange="this.form.submit()" /></label></form></div>
                </div>

                <div class="flex gap-2 mb-6 overflow-x-auto pb-2">
                    <button onclick="openTab('movies')" id="btn-movies" class="tab-btn active px-5 py-2 bg-[#111] rounded-full text-xs font-bold text-gray-400 border border-zinc-800">Movies</button>
                    <button onclick="openTab('keys')" id="btn-keys" class="tab-btn px-5 py-2 bg-[#111] rounded-full text-xs font-bold text-gray-400 border border-zinc-800">Keys</button>
                    <button onclick="openTab('topups')" id="btn-topups" class="tab-btn px-5 py-2 bg-[#111] rounded-full text-xs font-bold text-gray-400 border border-zinc-800">Topups</button>
                    <button onclick="openTab('reqs')" id="btn-reqs" class="tab-btn px-5 py-2 bg-[#111] rounded-full text-xs font-bold text-gray-400 border border-zinc-800">Requests</button>
                    <button onclick="openTab('config')" id="btn-config" class="tab-btn px-5 py-2 bg-[#111] rounded-full text-xs font-bold text-gray-400 border border-zinc-800">Config</button>
                </div>

                <div id="tab-movies" class="tab-content active">
                    <div class="grid lg:grid-cols-3 gap-6">
                        <div class="bg-[#111] p-5 rounded-2xl border border-zinc-800 h-fit">
                            <h2 class="font-bold text-yellow-500 mb-4">Add Movie</h2>
                            <form action="/admin/movie/save" method="post" class="space-y-4">
                                <input name="id" type="hidden" value={crypto.randomUUID()} /> 
                                <input name="title" placeholder="Title" required class="input-box bg-black border-zinc-700" />
                                <input name="posterUrl" placeholder="Poster URL" required class="input-box bg-black border-zinc-700" />
                                <input name="streamUrl" placeholder="Stream URL" required class="input-box bg-black border-zinc-700" />
                                <input type="number" name="price" placeholder="Price (Optional)" class="input-box bg-black border-zinc-700" />
                                <select name="category" class="input-box bg-black border-zinc-700">{["Movies","Series","Animation","Jav","All Uncensored"].map(o=><option>{o}</option>)}</select>
                                <button class="w-full bg-blue-600 text-white font-bold py-3 rounded-xl">Save</button>
                            </form>
                        </div>
                        <div class="lg:col-span-2 bg-[#111] p-5 rounded-2xl border border-zinc-800">
                            <div class="flex justify-between mb-4"><h2 class="font-bold text-white">Latest Movies</h2><form class="flex gap-2"><input name="q" value={adminQuery} placeholder="Search..." class="bg-black border border-zinc-700 rounded px-2 text-xs" /><button class="bg-zinc-800 px-2 rounded text-xs text-white">Go</button></form></div>
                            <div class="space-y-3 h-[600px] overflow-y-auto custom-scroll">
                                {movies.map(m => (m ? <div class="flex gap-4 p-3 rounded-xl items-center border bg-black border-zinc-800/50"><img src={m.posterUrl} class="w-10 h-14 object-cover rounded" /><div class="flex-grow"><div class="font-bold text-gray-200">{m.title}</div><div class="text-[10px] text-gray-500">{m.category}</div></div><form action="/admin/movie/delete" method="post"><input type="hidden" name="id" value={m.id} /><button class="text-red-500 text-xs px-2 bg-red-900/20 rounded">Del</button></form></div> : null))}
                            </div>
                        </div>
                    </div>
                </div>

                <div id="tab-keys" class="tab-content">
                    <div class="grid grid-cols-2 gap-4">
                        <div class="bg-[#111] p-6 rounded-2xl border border-zinc-800">
                             <h2 class="font-bold text-white mb-4">VIP Key</h2>
                             <form action="/admin/key/create" method="post" class="flex gap-3"><input type="hidden" name="type" value="vip" /><input type="number" name="days" placeholder="Days" class="input-box bg-black" /><button class="bg-blue-600 text-white px-4 rounded font-bold">Gen</button></form>
                        </div>
                        <div class="bg-[#111] p-6 rounded-2xl border border-zinc-800">
                             <h2 class="font-bold text-white mb-4">Coin Key</h2>
                             <form action="/admin/key/create" method="post" class="flex gap-3"><input type="hidden" name="type" value="coin" /><input type="number" name="value" placeholder="Amount" class="input-box bg-black" /><button class="bg-yellow-600 text-white px-4 rounded font-bold">Gen</button></form>
                        </div>
                    </div>
                    <div class="mt-4 space-y-2">{keys.map(k => (<div class="flex justify-between p-2 bg-black border border-zinc-800 rounded"><span class="font-mono text-yellow-500">{k.code}</span><span class="text-gray-500 text-xs">{k.type} - {k.value || k.days}</span></div>))}</div>
                </div>
                
                <div id="tab-topups" class="tab-content">
                    <div class="space-y-3">{topups.map(t => (<div class="bg-[#111] p-4 rounded border border-zinc-800 flex justify-between"><div><span class="font-bold text-white">{t.amount} Ks</span> <span class="text-xs text-gray-500">{t.method}</span><p class="text-xs text-gray-400">{t.username} | {t.transactionId}</p></div>{t.status === 'pending' && (<div class="flex gap-2"><form action="/admin/topup/approve" method="post"><input type="hidden" name="id" value={t.id} /><button class="text-green-500 text-xs">Approve</button></form><form action="/admin/topup/reject" method="post"><input type="hidden" name="id" value={t.id} /><button class="text-red-500 text-xs">Reject</button></form></div>)}</div>))}</div>
                </div>

                <div id="tab-reqs" class="tab-content">
                    <div class="space-y-2">{requests.map(r => (<div class="bg-black p-3 rounded border border-zinc-800 flex justify-between"><span>{r.movieName}</span><span class="text-gray-500 text-xs">{r.username}</span></div>))}</div>
                </div>

                <div id="tab-config" class="tab-content">
                     <div class="max-w-xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800">
                         <form action="/admin/config/reindex" method="post"><button class="w-full bg-purple-900/30 text-purple-400 border border-purple-500/30 font-bold px-6 py-3 rounded-xl">Re-Build Search Index</button></form>
                         <div class="mt-6 border-t border-zinc-800 pt-6"><h3 class="font-bold text-white mb-2">Maintenance</h3><form action="/admin/config/maintenance" method="post"><input type="hidden" name="status" value="toggle"/><button class="bg-red-900/30 text-red-500 px-4 py-2 rounded">Toggle Maintenance</button></form></div>
                     </div>
                </div>
            </div>
        </Layout>
    );
});

app.post("/admin/movie/save", adminGuard, async (c) => {
    const body = await c.req.parseBody();
    const movie: Movie = {
        id: String(body.id) || crypto.randomUUID(), title: String(body.title), posterUrl: String(body.posterUrl),
        coverUrl: String(body.posterUrl), category: String(body.category) as any, description: "", tags: "", year: "2025",
        streamUrl: String(body.streamUrl), linkType: "direct", createdAt: Date.now(), price: Number(body.price) || 0
    };
    await saveMovieDB(movie);
    return c.redirect(ADMIN_ROUTE + "/dashboard?success=Saved");
});
app.post("/admin/movie/delete", adminGuard, async (c) => { const { id } = await c.req.parseBody(); await deleteMovieDB(String(id)); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Deleted"); });
app.post("/admin/config/reindex", adminGuard, async (c) => { await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Indexed"); });
app.post("/admin/config/maintenance", adminGuard, async (c) => { const cur = await getConfig(); await kv.set(["config"], { ...cur, maintenanceMode: !cur.maintenanceMode }); clearConfigCache(); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config"); });
app.post("/admin/key/create", adminGuard, async (c) => { const b = await c.req.parseBody(); const k: VipKey = { code: crypto.randomUUID().slice(0,8).toUpperCase(), days: Number(b.days)||0, value: Number(b.value)||0, type: String(b.type) as any }; await kv.set(["keys", k.code], k); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys&success=Key Generated"); });
app.post("/admin/topup/approve", adminGuard, async (c) => { const {id} = await c.req.parseBody(); const t = (await kv.get<TopupRequest>(["topups", String(id)])).value; if(t){ t.status='approved'; await kv.set(["topups", t.id], t); const u = await getUser(t.username); if(u){ u.coins=(u.coins||0)+t.amount; await kv.set(["users", u.username], u); } } return c.redirect(ADMIN_ROUTE+"/dashboard?tab=topups"); });
app.post("/admin/topup/reject", adminGuard, async (c) => { const {id} = await c.req.parseBody(); const t = (await kv.get<TopupRequest>(["topups", String(id)])).value; if(t){ t.status='rejected'; await kv.set(["topups", t.id], t); } return c.redirect(ADMIN_ROUTE+"/dashboard?tab=topups"); });

// BACKUP & RESTORE
app.get("/admin/backup-ndjson", adminGuard, async (c) => { 
    const stream = new ReadableStream({ 
        async start(controller) { 
            const encoder = new TextEncoder(); 
            for await (const entry of kv.list({ prefix: [] })) { 
                const line = JSON.stringify({ key: entry.key, value: entry.value }) + "\n";
                controller.enqueue(encoder.encode(line)); 
            }
            controller.close(); 
        } 
    }); 
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": `attachment; filename="backup_${Date.now()}.ndjson"` } }); 
});
app.post("/admin/restore-ndjson", adminGuard, async (c) => { 
    try { 
        const body = await c.req.parseBody(); 
        const file = body['file']; 
        if (file instanceof File) { 
            const text = await file.text(); const lines = text.split("\n");
            for (const line of lines) { if(!line.trim()) continue; try { const { key, value } = JSON.parse(line); await kv.set(key, value); } catch(e) {} }
            await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Restored"); 
        } 
    } catch(e) { return c.redirect(ADMIN_ROUTE + "/dashboard?error=Failed"); } 
});

app.post(ADMIN_ROUTE + "/login", async (c) => { const { password } = await c.req.parseBody(); if (password === ADMIN_PASS) { const sessionId = crypto.randomUUID(); await kv.set(["admin_sessions", sessionId], "active", { expireIn: ADMIN_SESSION_EXPIRE }); setCookie(c, "admin_session_id", sessionId, { path: "/", httpOnly: true, secure: true }); return c.redirect(ADMIN_ROUTE + "/dashboard"); } return c.redirect(ADMIN_ROUTE); });
app.get(ADMIN_ROUTE, (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action={ADMIN_ROUTE + "/login"} method="post" class="bg-[#1f1f1f] p-8 rounded-2xl w-80 border border-zinc-800"><h2 class="font-bold text-center mb-6 text-blue-500">ADMIN</h2><input type="password" name="password" placeholder="Key" class="input-box mb-4 text-center" /><button class="bg-blue-600 text-white w-full py-3 rounded-xl font-bold">Unlock</button></form></div></Layout>));

Deno.serve(app.fetch);
