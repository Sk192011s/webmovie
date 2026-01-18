/** @jsxImportSource npm:hono@4/jsx */
import { Hono } from "npm:hono@4";
import { getCookie, setCookie, deleteCookie } from "npm:hono@4/cookie";
import { secureHeaders } from "npm:hono@4/secure-headers";
import { compress } from "npm:hono@4/compress";
import { csrf } from "npm:hono@4/csrf";
import { z } from "npm:zod"; // 🔥 SECURITY: Input Validation

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
    featuredMovies: { data: [], timestamp: 0 },
    config: { data: null, timestamp: 0 }
};
const CACHE_TTL = 5 * 60 * 1000; // 5 Minutes Cache

// 🔥 VALIDATION SCHEMAS (ZOD)
const AuthSchema = z.object({
    username: z.string().min(3, "Username must be at least 3 chars").max(20).regex(/^[a-zA-Z0-9_]+$/, "Only letters, numbers and _ allowed"),
    password: z.string().min(6, "Password must be at least 6 chars")
});

const TopupSchema = z.object({
    amount: z.coerce.number().min(500, "Minimum amount is 500"),
    transactionId: z.string().min(4, "Invalid Transaction ID"),
    method: z.string(),
    purpose: z.string()
});

const i18n: any = {
    en: {
        home: "Home", saved: "Saved", request: "Request", login: "Login", me: "Me",
        search_ph: "Search movies...", featured: "Featured", play: "Watch Now",
        see_all: "View All", views: "Views", dl_help: "Download Guide",
        server1: "Server 1", server2: "Server 2", share: "Share",
        unlock: "Unlock VIP", vip_only: "VIP Exclusive",
        access_denied: "Access Denied", ip_banned: "Your IP is restricted.",
        security_alert: "Security Check", wait: "Please Wait",
        dl_btn: "Download", next_ep: "Next Episode"
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
        back_login: "အကောင့်ဝင်ရန် ပြန်သွားမည်",
        next_ep: "နောက်တစ်ပိုင်း"
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
  isDeleted?: boolean; // 🔥 SOFT DELETE
}
interface MovieSummary { id: string; title: string; posterUrl: string; coverUrl: string; category: string; createdAt: number; isDeleted?: boolean; }
interface User {
    username: string; passwordHash: string; expiryDate: string | null;
    favorites: string[]; sessionId?: string; ip?: string; lastLoginIp?: string; isBanned?: boolean;
    coins?: number;
    purchased?: string[];
    securityQ?: string;
    securityA?: string;
    notifications?: { id: string; msg: string; date: number; read: boolean }[]; // 🔥 NOTIFICATIONS
}
interface VipKey { code: string; days: number; type?: "vip" | "coin"; value?: number; }
interface UserRequest { id: string; username: string; movieName: string; timestamp: number; }
interface TopupRequest { 
    id: string; 
    username: string; 
    amount: number; 
    method: string; 
    transactionId: string; 
    status: "pending" | "approved" | "rejected"; 
    timestamp: number;
    purpose?: string;
}
interface AdminLog { id: string; action: string; details: string; timestamp: number; }
interface AppConfig { 
    announcement: string; 
    showAnnouncement: boolean; 
    globalVipExpiry?: number;
    popupImage?: string; 
    popupMessage?: string; 
    popupBtnText?: string; 
    popupLink?: string; 
    popupTarget?: string; 
    showPopup?: boolean; 
    maintenanceMode?: boolean;
    customBannerImage?: string;
    customBannerLink?: string;
    showCustomBanner?: boolean;
}

// =======================
// 3. UTILS & DATABASE
// =======================
function getLang(c: any) { return getCookie(c, "app_lang") || "en"; }

// 🔥 FIX: IMAGE PROXY ဖြုတ်လိုက်ပါ (မူရင်း Link အတိုင်းပြရန်)
function optimizeImg(url: string, width: number = 400) {
    if(!url) return "";
    return url.trim(); 
}

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

function cleanText(text: string): string {
    return text
        .replace(/\\&quot;/g, '"')
        .replace(/&quot;/g, '"')
        .replace(/\\"/g, '"')
        .replace(/\\/g, '')
        .trim();
}

function tokenize(text: string): string[] {
    return text.toLowerCase()
        .replace(/[-_.:]+/g, " ") 
        .replace(/[^\p{L}\p{N}\s]/gu, "") 
        .split(/\s+/) 
        .filter(w => w.length > 1);
}

// 🔥 SECURITY: ADMIN RATE LIMITER
async function checkAdminRateLimit(ip: string): Promise<boolean> {
    const key = ["admin_limit", ip];
    const res = await kv.get<{ count: number }>(key);
    const count = res.value?.count || 0;
    if (count >= 5) return false; // 5 attempts per 15 mins
    return true;
}

async function recordAdminFail(ip: string) {
    const key = ["admin_limit", ip];
    const res = await kv.get<{ count: number }>(key);
    const count = (res.value?.count || 0) + 1;
    await kv.set(key, { count }, { expireIn: 15 * 60 * 1000 });
}

async function checkLoginRateLimit(ip: string): Promise<boolean> {
    const key = ["login_limit", ip];
    const res = await kv.get<{ count: number }>(key);
    const count = res.value?.count || 0;
    if (count >= 10) return false;
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

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostname = u.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) return false;
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

function clearConfigCache() {
    RAM_CACHE.config = { data: null, timestamp: 0 };
}

async function saveMovieDB(movie: Movie) {
    const summary: MovieSummary = {
        id: movie.id, title: movie.title, posterUrl: movie.posterUrl,
        coverUrl: movie.coverUrl, category: movie.category, createdAt: movie.createdAt, isDeleted: false
    };

    const oldRes = await kv.get<Movie>(["movies", movie.id]);
    const old = oldRes.value;
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };

    if (old) {
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

    await kv.set(["movies", movie.id], movie);
    await kv.set(["idx_time", movie.createdAt, movie.id], summary);
    await kv.set(["idx_cat", movie.category, movie.createdAt, movie.id], summary);

    const newWords = tokenize(movie.title + " " + (movie.tags || ""));
    for (const w of newWords) {
        await kv.set(["idx_search", w, movie.id], movie.createdAt);
    }
}

// 🔥 DATA: SOFT DELETE IMPLEMENTATION
async function softDeleteMovieDB(id: string) {
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
    const res = await kv.get<Movie>(["movies", id]);
    if (!res.value) return;
    const m = res.value;
    
    // Set isDeleted flag
    m.isDeleted = true;
    await kv.set(["movies", id], m);

    // Remove from active indexes so it doesn't show in search/home
    await kv.delete(["idx_time", m.createdAt, id]);
    await kv.delete(["idx_cat", m.category, m.createdAt, id]);

    const words = tokenize(m.title + " " + (m.tags || ""));
    for (const w of words) await kv.delete(["idx_search", w, id]);
}

async function restoreMovieDB(id: string) {
    const res = await kv.get<Movie>(["movies", id]);
    if (!res.value) return;
    const m = res.value;
    m.isDeleted = false;
    await saveMovieDB(m); // Re-index everything
}

async function permanentDeleteMovieDB(id: string) {
    const res = await kv.get<Movie>(["movies", id]);
    if (!res.value) return;
    const m = res.value;
    await kv.delete(["movies", id]);
    
    // Decrement count
    try {
        const countKey = ["counts", m.category];
        const countRes = await kv.get(countKey);
        if (countRes.value) await kv.set(countKey, new Deno.KvU64(BigInt(Math.max(0, Number(countRes.value) - 1))));
    } catch (e) {}
}

async function getLatestMovies(limit: number = 20) {
    if (limit <= 20 && RAM_CACHE.latestMovies.data.length > 0 && (Date.now() - RAM_CACHE.latestMovies.timestamp < CACHE_TTL)) {
        return RAM_CACHE.latestMovies.data.slice(0, limit);
    }
    const iter = kv.list<MovieSummary>({ prefix: ["idx_time"] }, { reverse: true, limit: limit + 10 }); // Fetch slightly more to filter
    const movies = []; 
    for await (const res of iter) {
        if(!res.value.isDeleted) movies.push(res.value);
        if(movies.length >= limit) break;
    }
    if (limit <= 20) RAM_CACHE.latestMovies = { data: movies, timestamp: Date.now() };
    return movies;
}

async function getMoviesByCategory(cat: string, limit: number = 20) {
    const iter = kv.list<MovieSummary>({ prefix: ["idx_cat", cat] }, { reverse: true, limit: limit + 10 });
    const movies = []; 
    for await (const res of iter) {
        if(!res.value.isDeleted) movies.push(res.value);
        if(movies.length >= limit) break;
    }
    return movies;
}

async function searchMoviesDB(query: string) {
    const words = tokenize(query);
    if (words.length === 0) return [];
    
    const searchWord = words.reduce((a, b) => a.length > b.length ? a : b, "");
    const startKey = ["idx_search", searchWord];
    const endKey = ["idx_search", searchWord + "\uffff"]; 

    const iter = kv.list({ start: startKey, end: endKey }, { limit: 100 }); // Limit Memory Usage
    const movieIds = new Set<string>();
    
    for await (const entry of iter) {
        movieIds.add(entry.key[2] as string); 
    }

    const uniqueIds = Array.from(movieIds);
    const results = [];
    
    for (let i = 0; i < uniqueIds.length; i += 10) {
        const batch = uniqueIds.slice(i, i + 10);
        const keys = batch.map(id => ["movies", id]);
        const res = await kv.getMany(keys);
        for (const r of res) {
            if (r.value && !(r.value as Movie).isDeleted) results.push(r.value as Movie);
        }
    }

    return results.filter(m => {
        const text = (m.title + " " + m.tags).toLowerCase();
        return words.every(w => text.includes(w));
    });
}

async function reIndexDatabase() {
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
    const cats = ["Movies","Series","4K Movies","Animation","Jav","All Uncensored","Myanmar and Asian","4K Porns"];
    for(const c of cats) await kv.delete(["counts", c]);

    const iter = kv.list<Movie>({ prefix: ["movies"] });
    for await (const res of iter) {
        if (!res.value.isDeleted) {
            await saveMovieDB(res.value);
        }
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

const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean; announcement?: string; isAdmin?: boolean; coverUrl?: string; lang?: string; activeTab?: string; globalExpiry?: number }) => {
  const protectCSS = props.isAdmin ? "" : `* { -webkit-touch-callout: none !important; } img { pointer-events: none; }`;
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
  
  // Unread Noti Count
  const notiCount = props.user?.notifications ? props.user.notifications.filter(n => !n.read).length : 0;

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
      <meta property="og:image" content={optimizeImg(props.coverUrl || "https://cdn-icons-png.flaticon.com/512/2503/2503508.png")} />
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&display=swap" rel="stylesheet" />
      

      <style>{`
        :root { --glass-bg: rgba(255, 255, 255, 0.08); --glass-border: rgba(255, 255, 255, 0.1); --primary: #8b5cf6; --accent: #06b6d4; --plyr-color-main: #8b5cf6; }
        body { background-color: #111827; color: #e2e8f0; font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; padding-bottom: 90px; }
        * { user-select: none; -webkit-user-select: none; }
        input, textarea { user-select: text !important; -webkit-user-select: text !important; -webkit-touch-callout: default !important; }
        ${protectCSS}
        .glass-panel { background: var(--glass-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--glass-border); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1); }
        .input-box { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); color: white; padding: 14px; border-radius: 12px; width: 100%; outline: none; transition: 0.3s; font-size: 14px; }
        .input-box:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2); }
        .btn-primary { background: linear-gradient(135deg, var(--primary), #6366f1); color: white; font-weight: 700; padding: 14px 20px; border-radius: 12px; transition: 0.3s; cursor: pointer; border: none; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3); }
        .btn-primary:active { transform: scale(0.97); }
        .bottom-nav { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); width: 90%; max-width: 400px; background: rgba(17, 24, 39, 0.95); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); display: flex; justify-content: space-around; padding: 12px 6px; z-index: 50; }
        .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; color: #94a3b8; transition: 0.3s; text-align: center; gap: 4px; }
        .nav-item i { font-size: 18px; transition: 0.3s; }
        .nav-item.active { color: white; }
        .nav-item.active i { color: #c084fc; text-shadow: 0 0 15px rgba(192, 132, 252, 0.8); transform: translateY(-3px); }
        .top-header { position: fixed; top: 0; left: 0; width: 100%; z-index: 40; padding: 12px 20px; display: flex; justify-content: space-between; items-center; background: rgba(17, 24, 39, 0.9); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.05); }
        .announcement-bar { position: fixed; top: 60px; left: 0; width: 100%; z-index: 39; background: linear-gradient(90deg, #f59e0b, #d97706); color: black; font-size: 11px; font-weight: bold; padding: 8px 16px; display: flex; items-center; gap: 8px; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3); }
        .custom-scroll::-webkit-scrollbar { width: 0px; height: 0px; }
        #toast-box { position: fixed; top: 24px; right: 20px; z-index: 10000; display: flex; flex-direction: column; gap: 10px; }
        .toast { padding: 16px 24px; border-radius: 12px; color: white; font-weight: 600; display: flex; items-center; gap: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); animation: slideIn 0.4s ease; min-width: 280px; border: 1px solid rgba(255,255,255,0.1); background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(10px); }
        .toast.error { border-left: 4px solid #f43f5e; }
        .toast.success { border-left: 4px solid #10b981; }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        #search-overlay { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.98); backdrop-filter: blur(20px); z-index: 100; transform: translateY(-100%); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); display: flex; flex-direction: column; padding: 20px; }
        #search-overlay.open { transform: translateY(0); }
        #instant-results { overflow-y: auto; flex-grow: 1; margin-top: 10px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding-bottom: 50px; }
        #page-loader { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.9); z-index: 99999; display: none; justify-content: center; align-items: center; backdrop-filter: blur(5px); }
        #page-loader.active { display: flex; }
        .spinner { width: 50px; height: 50px; border: 3px solid rgba(255,255,255,0.1); border-radius: 50%; border-top: 3px solid #c084fc; animation: spin 0.8s linear infinite; box-shadow: 0 0 15px rgba(192, 132, 252, 0.4); }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .movie-card { transition: all 0.3s ease; border: 1px solid transparent; }
        .movie-card:hover { transform: translateY(-5px); border-color: rgba(139, 92, 246, 0.3); box-shadow: 0 10px 30px -10px rgba(139, 92, 246, 0.3); }
        .movie-card:active { transform: scale(0.96); }
        .float-tg { position: fixed; bottom: 90px; right: 20px; z-index: 50; background: linear-gradient(135deg, #0ea5e9, #2563eb); color: white; width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 4px 20px rgba(14, 165, 233, 0.5); transition: transform 0.3s; text-decoration: none; }
        .float-tg:active { transform: scale(0.9); }
        .tab-btn.active { background: #8b5cf6; color: white; box-shadow: 0 0 15px rgba(139, 92, 246, 0.4); border-color: transparent; }
        .tab-content { display: none; animation: fadeIn 0.3s ease; }
        .tab-content.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 16px; padding-bottom: 24px; scroll-snap-type: x mandatory; padding-left: 20px; padding-right: 20px; scrollbar-width: none; }
        .h-scroll-item { width: 120px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item.wide { width: 280px; }
        .slider-container { position: relative; width: 100%; aspect-ratio: 16/9; overflow: hidden; border-radius: 24px; box-shadow: 0 20px 50px -10px rgba(0,0,0,0.5); }
        .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease-in-out; pointer-events: none; }
        .slide.active { opacity: 1; pointer-events: auto; }
        .modal-enter { animation: modalPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        @keyframes modalPop { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        img.img-fade { opacity: 0; transition: opacity 0.5s ease-in-out; }
        img.img-fade.loaded { opacity: 1; }
        .img-skeleton { background: linear-gradient(90deg, #1e293b 25%, #334155 50%, #1e293b 75%); background-size: 200% 100%; animation: skeleton-load 1.5s infinite; }
        @keyframes skeleton-load { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        /* Plyr Customization */
        .plyr--video { border-radius: 12px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.5); --plyr-color-main: #c084fc; }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        ${protectJS}
        window.imgLoaded = function(img) {
            img.classList.add('loaded');
            if(img.parentElement && img.parentElement.classList.contains('img-skeleton')) {
                img.parentElement.classList.remove('img-skeleton');
            }
        }
        document.addEventListener('DOMContentLoaded', () => {
             const loader = document.getElementById('page-loader');
             window.showLoader = () => { if(loader) loader.classList.add('active'); setTimeout(() => { if(loader) loader.classList.remove('active'); }, 5000); };
             window.hideLoader = () => { if(loader) loader.classList.remove('active'); };
             
             document.querySelectorAll('form').forEach(f => f.addEventListener('submit', window.showLoader));
             document.body.addEventListener('click', (e) => {
                const link = e.target.closest('a');
                if (link) {
                    const href = link.getAttribute('href');
                    const target = link.getAttribute('target');
                    if (href && href.startsWith('/') && !href.includes('#') && !href.includes('/dl/') && target !== '_blank' && !link.classList.contains('float-tg') && !link.classList.contains('search-trigger')) {
                        window.showLoader();
                    }
                }
             });
             window.addEventListener('pageshow', window.hideLoader);
             
             setTimeout(() => {
                 document.querySelectorAll('img.img-fade').forEach(img => {
                     if(img.complete && img.naturalHeight !== 0) window.imgLoaded(img);
                 });
             }, 100);

             const urlParams = new URLSearchParams(window.location.search);
             if(urlParams.get('error')) showToast(urlParams.get('error'), 'error');
             if(urlParams.get('success')) showToast(urlParams.get('success'), 'success');
             if(urlParams.get('error')||urlParams.get('success')) window.history.replaceState({}, document.title, window.location.pathname);
             
             const slides = document.querySelectorAll('.slide');
             if(slides.length>1){ let current=0; setInterval(()=>{ slides[current].classList.remove('active'); current=(current+1)%slides.length; slides[current].classList.add('active'); },4500); }
             
             window.openTab = function(name) {
                 document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                 document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                 document.getElementById('tab-'+name).classList.add('active');
                 document.getElementById('btn-'+name).classList.add('active');
                 localStorage.setItem('adminTab', name);
             }
             const savedTab = localStorage.getItem('adminTab');
             if(savedTab && document.getElementById('tab-'+savedTab)) openTab(savedTab);
             
             window.copyToClip = function(text) {
                 if(navigator.clipboard) { navigator.clipboard.writeText(text); showToast('Copied!', 'success'); }
                 else { const el = document.createElement('textarea'); el.value = text; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el); showToast('Copied!', 'success'); }
             }
             
             window.shareMovie = function(title) { if (navigator.share) { navigator.share({ title: title, text: 'Watch ' + title + ' on Gold Flix', url: window.location.href }); } else { copyToClip(window.location.href); } }
             window.openHelpModal = function() { const modal = document.getElementById('help-modal'); modal.classList.remove('hidden'); modal.classList.add('flex'); }
             window.closeHelpModal = function() { const modal = document.getElementById('help-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }
             
             window.confirmDownload = function(url, title, size) {
                 const modal = document.getElementById('dl-modal');
                 document.getElementById('dl-title').innerText = title;
                 document.getElementById('dl-size').innerText = size || "Unknown Size";
                 document.getElementById('dl-confirm-btn').href = url;
                 modal.classList.remove('hidden'); modal.classList.add('flex');
             }
             window.closeDlModal = function() { const modal = document.getElementById('dl-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }
             
             window.openBuyModal = function(price, title) {
                 const modal = document.getElementById('buy-modal');
                 document.getElementById('buy-price').innerText = price + " Ks";
                 modal.classList.remove('hidden'); modal.classList.add('flex');
             }
             window.closeBuyModal = function() { const modal = document.getElementById('buy-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }

             window.openVipModal = function() {
                 const modal = document.getElementById('vip-modal');
                 modal.classList.remove('hidden'); modal.classList.add('flex');
             }
             window.closeVipModal = function() { const modal = document.getElementById('vip-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }

             window.switchSeason = function(seasonId) {
                 const targetGrid = document.getElementById('ep-grid-' + seasonId);
                 const targetBtn = document.getElementById('btn-' + seasonId);
                 const isAlreadyActive = !targetGrid.classList.contains('hidden');
                 document.querySelectorAll('.season-content').forEach(el => el.classList.add('hidden'));
                 document.querySelectorAll('.season-tab-btn').forEach(btn => { btn.classList.remove('bg-purple-600', 'text-white', 'shadow-lg'); btn.classList.add('bg-slate-800', 'text-gray-400'); });
                 if (!isAlreadyActive) { targetGrid.classList.remove('hidden'); if(targetBtn) { targetBtn.classList.remove('bg-slate-800', 'text-gray-400'); targetBtn.classList.add('bg-purple-600', 'text-white', 'shadow-lg'); } }
             }
             
             // 🔥 UX: PLAYER USING GENERATOR LOGIC
             window.loadPlayer = async function(content, type, movieId, title, poster, btnElement) {
                // UI Reset
                document.querySelectorAll('.srv-btn').forEach(b => { 
                    b.classList.remove('bg-purple-600', 'text-white', 'border-transparent', 'shadow-lg'); 
                    b.classList.add('bg-slate-800', 'text-gray-300'); 
                });
                if (btnElement) { 
                    btnElement.classList.remove('bg-slate-800', 'text-gray-300'); 
                    btnElement.classList.add('bg-purple-600', 'text-white', 'border-transparent', 'shadow-lg'); 
                }

                const container = document.getElementById('video-player');
                const cover = document.getElementById('video-cover');
                
                if(container) container.innerHTML = ''; 
                if(cover) cover.style.display = 'none';
                if(container) container.style.display = 'block'; 

                var finalUrl = content.trim();

                // 🔥 MEDIAFIRE: Generator Logic ဆီ ပို့မည်
                if (finalUrl.includes('mediafire.com')) {
                    // Browser က ဒီ Link ကိုဖွင့်ရင် Deno က Direct Link ဆီ Redirect လုပ်ပေးလိမ့်မယ်
                    finalUrl = '/api/mediafire-stream?link=' + encodeURIComponent(finalUrl);
                } 
                else if (type === 'direct') { 
    try { 
        var res = await fetch('/api/resolve-url?token=' + content); 
        var data = await res.json(); 
        if (data.url) finalUrl = data.url; 
    } catch (e) { console.error("Link Resolve Error", e); } 
}

// 🔥 FIX: Token ဖြေပြီးမှ MediaFire ဖြစ်နေရင် Generator ဆီ ထပ်ပို့မည်
if (finalUrl.includes('mediafire.com')) {
    finalUrl = '/api/mediafire-stream?link=' + encodeURIComponent(finalUrl);
}

console.log("Playing:", finalUrl);

                var videoHtml = '<video id="main-video" controls autoplay playsinline class="w-full h-full" style="background-color:black;" poster="' + poster + '">';
                videoHtml += '<source src="' + finalUrl + '" type="video/mp4">';
                videoHtml += '<p class="text-white text-center pt-10">Browser does not support video.</p>';
                videoHtml += '</video>';
                
                // Error တက်ရင် Download Link ပြပေးမယ်
                videoHtml += '<div id="error-msg" class="hidden absolute inset-0 flex items-center justify-center bg-black/90 text-white text-xs text-center p-4 z-50">';
                videoHtml += '<div><p class="text-red-500 font-bold mb-2">Video Playback Failed</p>';
                videoHtml += '<a href="' + finalUrl + '" target="_blank" class="bg-blue-600 px-4 py-2 rounded-lg text-white font-bold inline-block">Click to Download</a></div>';
                videoHtml += '</div>';

                container.innerHTML = videoHtml;
                
                const video = document.getElementById('main-video');
                const errMsg = document.getElementById('error-msg');

                if(video) { 
                    video.addEventListener('error', function() {
                        if(errMsg) errMsg.classList.remove('hidden');
                    });
                    try { await video.play(); } catch(e) {}
                }

                if(btnElement && btnElement.dataset.next) {
                    var nextUrl = btnElement.dataset.next;
                    var nextBtn = document.createElement('div');
                    nextBtn.className = "absolute bottom-16 right-4 z-[50] hidden";
                    nextBtn.innerHTML = '<button id="next-ep-btn" class="bg-white text-black font-bold px-4 py-2 rounded-full shadow-lg hover:scale-105 transition flex items-center gap-2 text-xs"><i class="fa-solid fa-forward-step"></i> Next Episode</button>';
                    container.appendChild(nextBtn);
                    document.getElementById('next-ep-btn').onclick = function() {
                        var nextEl = document.querySelector('[data-url="'+nextUrl+'"]');
                        loadPlayer(nextUrl, type, movieId, title, poster, nextEl);
                    };
                    if(video) {
                        video.addEventListener('ended', function() { nextBtn.classList.remove('hidden'); });
                    }
                }

                window.scrollTo({top:0, behavior:'smooth'});
            }

             window.filterMovies = function(val) { document.querySelectorAll('.movie-item').forEach(i => i.style.display=i.getAttribute('data-title').toLowerCase().includes(val.toLowerCase())?'flex':'none'); }
             
             window.toggleSearch = function() {
                 const overlay = document.getElementById('search-overlay');
                 const input = document.getElementById('search-input-main');
                 overlay.classList.toggle('open');
                 if(overlay.classList.contains('open')) {
                    if(input) setTimeout(() => input.focus(), 100);
                    document.body.style.overflow = 'hidden';
                 } else {
                    document.body.style.overflow = 'auto';
                 }
             }
             
             window.submitSearch = function() {
                const form = document.querySelector('#search-overlay form');
                if(form) form.submit();
             }

             let searchTimeout;
             const searchInput = document.getElementById('search-input-main');
             const resultsContainer = document.getElementById('instant-results');
             
             if(searchInput) {
                 searchInput.addEventListener('input', (e) => {
                     const val = e.target.value.trim();
                     clearTimeout(searchTimeout);
                     
                     if(val.length < 1) {
                         resultsContainer.innerHTML = '';
                         return;
                     }

                     searchTimeout = setTimeout(async () => {
                         try {
                             resultsContainer.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-4"><div class="spinner w-6 h-6 mx-auto mb-2 border-2"></div>Searching...</div>';
                             const res = await fetch('/api/search?q=' + encodeURIComponent(val));
                             const data = await res.json();
                             
                             if(data.results.length === 0) {
                                 resultsContainer.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-4">No results found</div>';
                             } else {
                                 resultsContainer.innerHTML = data.results.map(m => \`
                                     <a href="/movie/\${m.id}" class="block rounded-xl overflow-hidden bg-zinc-800 relative aspect-[2/3] group shadow-lg">
                                         <img src="\${m.posterUrl}" class="absolute inset-0 w-full h-full object-cover transition duration-300 group-hover:scale-110" />
                                         <div class="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition"></div>
                                         <div class="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
                                             <p class="text-[10px] font-bold text-white truncate text-center">\${m.title}</p>
                                         </div>
                                     </a>
                                 \`).join('');
                             }
                         } catch(e) {
                             console.error(e);
                         }
                     }, 300);
                 });
             }
        });
        function showToast(msg, type) { const box=document.getElementById('toast-box'); const t=document.createElement('div'); t.className='toast '+type; t.innerHTML=(type==='error'?'<i class="fa-solid fa-circle-exclamation text-xl text-red-500"></i>':'<i class="fa-solid fa-circle-check text-xl text-green-500"></i>')+'<span>'+msg+'</span>'; box.appendChild(t); setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),500); },3000); }
        let page = 1; let isLoading = false; let hasMore = true;
        async function loadMoreMovies(category) { 
            if(isLoading || !hasMore) return; 
            isLoading = true; 
            const grid = document.getElementById('movie-grid');
            const skeletons = [];
            for(let i=0; i<6; i++) {
                const el = document.createElement('div');
                el.className = 'block rounded-lg overflow-hidden aspect-[2/3] img-skeleton mt-2';
                if(category === "All Uncensored" || category === "Myanmar and Asian" || category === "4K Porns") { el.classList.remove('aspect-[2/3]'); el.classList.add('aspect-video'); }
                grid.appendChild(el);
                skeletons.push(el);
            }
            page++; 
            try { 
                const res = await fetch('/api/list?cat=' + category + '&page=' + page); 
                const data = await res.json(); 
                skeletons.forEach(s => s.remove());
                if(data.movies.length === 0) { hasMore = false; return; } 
                data.movies.forEach(m => { 
                    const el = document.createElement('a'); 
                    el.href = '/movie/' + m.id; 
                    el.className = 'block mb-6 group relative';
                    const badge = (m.category === "4K Movies" || m.category === "4K Porns") ? "4K" : "HD";
                    const isWide = (category === "All Uncensored" || category === "Myanmar and Asian" || category === "4K Porns");
                    el.innerHTML = \`
                        <div class="relative \${isWide ? 'aspect-video' : 'aspect-[2/3]'} overflow-hidden rounded-lg shadow-lg img-skeleton">
                            <img src="\${isWide ? (m.coverUrl || m.posterUrl) : m.posterUrl}" loading="lazy" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" />
                            <div class="absolute top-2 right-2 bg-black/60 text-white text-[9px] font-bold px-1.5 py-0.5 rounded backdrop-blur-md border border-white/10">\${badge}</div>
                        </div>
                        <div class="mt-2 text-center">
                            <h3 class="text-[12px] font-bold truncate text-gray-200 group-hover:text-white transition">\${m.title}</h3>
                        </div>
                    \`;
                    grid.appendChild(el); 
                }); 
            } catch(e) { console.error(e); } 
            isLoading = false; 
        }
        window.addEventListener('scroll', () => { if(window.location.pathname.startsWith('/category/') && (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) { const cat = window.location.pathname.split('/').pop().replace(/%20/g, ' '); loadMoreMovies(cat); }});
      `}} />
    </head>
    <body>
      <div id="page-loader"><div class="spinner"></div></div>
      <div id="toast-box"></div>
      <div id="dl-modal" class="fixed inset-0 z-[100] bg-black/80 hidden items-center justify-center backdrop-blur-md">
           <div class="glass-panel p-6 rounded-lg w-11/12 max-w-sm text-center relative shadow-2xl modal-enter">
              <div class="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-blue-500/20"><i class="fa-solid fa-cloud-arrow-down text-3xl text-blue-400"></i></div>
              <h3 id="dl-title" class="text-lg font-bold text-white mb-2 truncate">Movie Title</h3>
              <p class="text-gray-400 text-xs mb-6">File Size: <span id="dl-size" class="text-blue-400 font-bold">--</span></p>
              <div class="flex gap-3">
                  <button onclick="closeDlModal()" class="flex-1 py-3 rounded-xl bg-slate-700 text-white font-bold hover:bg-slate-600 transition text-xs">Cancel</button>
                  <a id="dl-confirm-btn" href="#" target="_blank" onclick="closeDlModal()" class="flex-1 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 text-white font-bold hover:brightness-110 transition text-xs flex items-center justify-center gap-2"><i class="fa-solid fa-download"></i> Download</a>
              </div>
           </div>
      </div>
      <div id="help-modal" class="fixed inset-0 z-[100] bg-black/80 hidden items-center justify-center backdrop-blur-md">
           <div class="glass-panel p-6 rounded-lg w-11/12 max-w-sm text-center relative shadow-2xl modal-enter">
              <div class="w-16 h-16 bg-purple-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-purple-500/20"><i class="fa-solid fa-circle-question text-3xl text-purple-400"></i></div>
              <h3 class="text-lg font-bold text-white mb-4">ဒေါင်းလော့ လုပ်နည်း</h3>
              <div class="text-left text-xs text-gray-300 space-y-3 mb-6 bg-black/30 p-4 rounded-xl border border-white/5">
                   <p><strong class="text-purple-400">နည်းလမ်း ၁ (Direct)</strong><br/> Movieမှာ <span class="text-white font-bold bg-slate-700 px-1 rounded">DL</span> ခလုတ်များ ပါရှိပါက နှိပ်၍ တိုက်ရိုက်ဒေါင်းယူနိုင်ပါသည်။</p>
                   <hr class="border-white/10"/>
                   <p><strong class="text-purple-400">နည်းလမ်း ၂ (Player)</strong><br/> ၁။ Video ကို Play လိုက်ပါ။<br/> ၂။ Videoလာလျှင် ညာဘက်အောက်ထောင့်က <i class="fa-solid fa-ellipsis-vertical text-white"></i> ကိုနှိပ်ပါ။<br/> ၃။ <span class="text-white font-bold">'Download'</span> ကို ရွေးချယ်ပါ။</p>
              </div>
              <button onclick="closeHelpModal()" class="w-full py-3.5 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold hover:brightness-110 transition shadow-lg text-xs">OK, I Understand</button>
           </div>
      </div>
      
      <div id="search-overlay">
          <div class="flex justify-between items-center mb-6">
              <h2 class="text-xl font-bold text-white">Search Movies</h2>
              <button onclick="toggleSearch()" class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center hover:bg-red-500 hover:text-white transition"><i class="fa-solid fa-xmark text-lg"></i></button>
          </div>
          <form action="/search" method="get" class="relative mb-6">
              <i onclick="submitSearch()" class="fa-solid fa-magnifying-glass absolute left-4 top-4 text-gray-400 cursor-pointer hover:text-white transition z-10"></i>
              <input id="search-input-main" name="q" placeholder="Start typing..." autocomplete="off" class="w-full bg-white/5 border border-white/10 rounded-lg py-4 pl-12 pr-4 text-white text-lg focus:border-purple-500 outline-none transition" />
          </form>
          <h3 class="text-xs font-bold text-gray-500 uppercase mb-4 tracking-wider border-b border-white/5 pb-2">Top Results</h3>
          <div id="instant-results" class="custom-scroll">
              <div class="col-span-3 text-center text-gray-600 py-10">
                  <i class="fa-solid fa-film text-4xl mb-2 opacity-30"></i>
                  <p>Type to search...</p>
              </div>
          </div>
      </div>

      {!props.hideNav && (
        <>
            <header class="top-header">
                <div class="flex items-center gap-3">
                    <a href="/" class="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600 tracking-tighter italic drop-shadow-sm neon-text">GOLD FLIX</a>
                    <button onclick="toggleSearch()" class="search-trigger w-8 h-8 flex items-center justify-center rounded-full bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:bg-purple-600 hover:border-purple-500 transition shadow-lg"><i class="fa-solid fa-magnifying-glass text-xs"></i></button>
                </div>
                <div class="flex items-center gap-3">
                    
{active === 'home' && !props.isAdmin && props.user && (
    <div class="px-3 py-1 rounded-full border border-purple-500/30 bg-purple-500/10 text-[10px] font-bold text-purple-400 tracking-wide backdrop-blur-md shadow-[0_0_10px_rgba(168,85,247,0.3)]">P - {daysLeft} Day</div>
)}
                    {props.isAdmin ? (
                        <a href={ADMIN_ROUTE + "/dashboard"} class="text-xs font-bold bg-blue-600 text-white px-4 py-1.5 rounded-full shadow-lg hover:bg-blue-500 transition">ADMIN</a>
                    ) : (
                        <a href={l === 'en' ? '/lang/my' : '/lang/en'} class="text-xs font-bold text-gray-300 border border-white/20 px-3 py-1 rounded-full hover:bg-white/10 transition">{l === 'en' ? 'MY' : 'EN'}</a>
                    )}
                </div>
            </header>
            {!props.isAdmin && (
                <nav class="bottom-nav">
                    <a href="/" class={`nav-item ${active === 'home' ? 'active' : ''}`}><i class="fa-solid fa-house"></i><span>{t.home}</span></a>
                    <a href="/favorites" class={`nav-item ${active === 'saved' ? 'active' : ''}`}><i class="fa-solid fa-heart"></i><span>{t.saved}</span></a>
                    <a href="/request" class={`nav-item ${active === 'request' ? 'active' : ''}`}><i class="fa-solid fa-clapperboard"></i><span>{t.request}</span></a>
                    <a href={props.user ? "/profile" : "/login"} class={`nav-item ${active === 'me' ? 'active' : ''} relative`}>
                        <i class="fa-solid fa-user"></i><span>{t.me}</span>
                        {notiCount > 0 && <span class="absolute top-1 right-6 w-2 h-2 bg-red-500 rounded-full"></span>}
                    </a>
                </nav>
            )}
        </>
      )}
      {!props.isAdmin && (
         <a href="https://t.me/LuGyiandYoteshinMovies" target="_blank" class="float-tg"><i class="fa-brands fa-telegram"></i></a>
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

// 🔥 SEARCH API
app.get("/api/search", async (c) => {
    const query = c.req.query("q")?.toLowerCase() || "";
    if (query.length < 1) return c.json({ results: [] });
    const results = await searchMoviesDB(query);
    const cleanResults = results.map(m => ({
        id: m.id,
        title: m.title,
        posterUrl: optimizeImg(m.posterUrl, 200)
    }));
    return c.json({ results: cleanResults });
});

app.use("*", async (c, next) => {
    const ip = getClientIp(c);
    const userAgent = c.req.header("user-agent") || "";
    if (userAgent.match(/curl|wget|python|java|libwww|httpclient|axios/i)) {
        return c.text("Access Denied (Bot Detected)", 403);
    }
    const limitKey = ["rate_limit_protection", ip];
    const limitRes = await kv.get<{ count: number }>(limitKey);
    const currentCount = limitRes.value?.count || 0;
    if (currentCount > 100) return c.text("Too Many Requests! Please wait a minute.", 429);
    await kv.set(limitKey, { count: currentCount + 1 }, { expireIn: 60 * 1000 });
    await next();
});

app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith(ADMIN_ROUTE) || path.startsWith("/admin") || path.includes("login") || path.includes(".css") || path.includes(".js") || path.includes("manifest")) {
        return await next();
    }
    const config = await getConfig();
    if (config.maintenanceMode) {
        const adminSession = getCookie(c, "admin_session_id");
        let isAdmin = false;
        if (adminSession) {
            const sessionValid = await kv.get(["admin_sessions", adminSession]);
            if (sessionValid.value) isAdmin = true;
        }
        if (!isAdmin) {
            return c.html(<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Under Maintenance</title><script src="https://cdn.tailwindcss.com"></script><link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" /></head><body class="bg-slate-900 text-white h-screen flex flex-col items-center justify-center p-6 text-center"><div class="w-20 h-20 bg-yellow-500/10 rounded-full flex items-center justify-center mb-6 animate-pulse"><i class="fa-solid fa-screwdriver-wrench text-4xl text-yellow-500"></i></div><h1 class="text-3xl font-black text-white mb-2 uppercase tracking-widest">Website ပြုပြင်နေပါသည်</h1><p class="text-gray-400 max-w-md mx-auto leading-relaxed text-sm">Gold Flix ကို ပိုမိုကောင်းမွန်အောင် ပြုပြင်မွမ်းမံမှုများ ပြုလုပ်နေပါသည်။ <br/><span class="text-yellow-500 font-bold">ခေတ္တစောင့်ဆိုင်းပေးပါ။</span></p><div class="mt-8 px-6 py-3 bg-white/5 rounded-full border border-white/10"><p class="text-xs text-gray-500 font-mono">Status: <span class="text-yellow-500 font-bold">System Upgrade In Progress...</span></p></div></body></html>);
        }
    }
    await next();
});

app.use("*", secureHeaders({
  xFrameOptions: "DENY", xContentTypeOptions: "nosniff", xXssProtection: "1; mode=block",
  contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://cdn.plyr.io"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://cdn.plyr.io"], fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"], imgSrc: ["'self'", "data:", "https:", "http:"], mediaSrc: ["'self'", "https:", "http:"], connectSrc: ["'self'", "https:", "http:"], frameSrc: ["'self'", "https:", "http:"], }
}));
app.use("*", compress());
app.use("*", csrf({ origin: (origin) => true })); 

app.notFound((c) => c.html(<Layout title="Not Found" hideNav={true}><div class="min-h-screen flex flex-col items-center justify-center text-center p-6 bg-slate-900 text-white"><div class="w-24 h-24 bg-white/5 rounded-full flex items-center justify-center mb-6"><i class="fa-solid fa-compass-slash text-5xl text-gray-500"></i></div><h1 class="text-4xl font-black text-white mb-2">404</h1><p class="text-gray-400 mb-8 font-medium">ဒီလမ်းကြောင်းမှာ ဘာမှမရှိပါဘူး။</p><a href="/" class="px-8 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold text-sm shadow-lg hover:scale-105 transition"><i class="fa-solid fa-house mr-2"></i> Back Home</a></div></Layout>));
app.onError((err, c) => { console.error(err); return c.html(<Layout title="Error" hideNav={true}><div class="min-h-screen flex flex-col items-center justify-center text-center p-6 bg-slate-900 text-white"><div class="w-24 h-24 bg-red-500/10 rounded-full flex items-center justify-center mb-6 animate-pulse"><i class="fa-solid fa-triangle-exclamation text-5xl text-red-500"></i></div><h1 class="text-2xl font-bold text-white mb-2">Something went wrong!</h1><p class="text-gray-500 text-sm mb-8">စနစ်ပိုင်းဆိုင်ရာ ချို့ယွင်းချက် ဖြစ်ပေါ်နေပါသည်။</p><a href="/" class="px-8 py-3 rounded-xl border border-white/20 hover:bg-white/10 text-white font-bold text-sm transition">Try Again</a></div></Layout>); });

// =======================
// 6. ROUTES
// =======================
app.get("/manifest.json", (c) => c.json({ "name": "Gold Flix", "short_name": "GoldFlix", "start_url": "/", "display": "standalone", "background_color": "#0f172a", "theme_color": "#0f172a", "icons": [{ "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "192x192", "type": "image/png" }, { "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "512x512", "type": "image/png" }] }));
app.get("/.well-known/assetlinks.json", (c) => c.json([{ "relation": ["delegate_permission/common.handle_all_urls"], "target": { "namespace": "android_app", "package_name": "dev.deno.goldflix_stream.twa", "sha256_cert_fingerprints": ["29:7D:1A:43:86:09:03:FE:02:F9:69:46:5A:F8:B7:C0:9A:14:75:10:F6:F3:07:4F:2E:CF:0E:F1:3E:D4:5F:7D"] } }]));
app.get("/service-worker.js", (c) => c.text(`self.addEventListener('install', (e) => { self.skipWaiting(); }); self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); }); self.addEventListener('fetch', (e) => { if (e.request.mode === 'navigate') { e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); } else { e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request))); } });`, 200, { "Content-Type": "application/javascript" }));

app.get("/sitemap.xml", async (c) => {
    const movies = await getLatestMovies(1000); 
    const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${c.req.header("host")}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>${movies.map(m => `<url><loc>https://${c.req.header("host")}/movie/${m.id}</loc><lastmod>${new Date(m.createdAt || Date.now()).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`).join('')}</urlset>`;
    return new Response(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" } });
});

app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nDisallow: /stream\nSitemap: https://${c.req.header("host")}/sitemap.xml`));

app.get("/api/cron/reindex", async (c) => {
    const key = c.req.query("key");
    if (key !== "GoldFlix_Cron_Key_999") return c.text("Unauthorized", 401);
    await reIndexDatabase();
    return c.text("Database Re-Indexed Successfully!");
});

app.get("/lang/:code", (c) => {
    const code = c.req.param("code");
    setCookie(c, "app_lang", code === "en" ? "en" : "my", { path: "/", maxAge: 60 * 60 * 24 * 365 });
    return c.redirect(c.req.header("Referer") || "/");
});

app.get("/", async (c) => {
  const user = await getCurrentUser(c);
  c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  c.header('Expires', '-1');
  
  const lang = getLang(c);
  const t = i18n[lang];
  const config = await getConfig();
  const isVip = isPremium(user, config);
  const targetFreeOnly = config.popupTarget === "free";
  const shouldShowPopup = config.showPopup && config.popupImage && (!targetFreeOnly || !isVip);

  const [
      sliderMovies,
      catMovies,
      catSeries,
      cat4K,
      catAnim,
      catJav,
      catUncen,
      catMyanmar,
      cat4KPorns
  ] = await Promise.all([
      getLatestMovies(5), 
      getMoviesByCategory("Movies", 8),
      getMoviesByCategory("Series", 8),
      getMoviesByCategory("4K Movies", 8),
      getMoviesByCategory("Animation", 8),
      getMoviesByCategory("Jav", 8),
      getMoviesByCategory("All Uncensored", 8),
      getMoviesByCategory("Myanmar and Asian", 8),
      getMoviesByCategory("4K Porns", 8)
  ]);
  
  const sections = [
    { name: "Movies", data: catMovies },
    { name: "Series", data: catSeries },
    { name: "4K Movies", data: cat4K },
    { name: "Animation", data: catAnim },
    { name: "Jav", data: catJav },
    { name: "All Uncensored", data: catUncen },
    { name: "Myanmar and Asian", data: catMyanmar },
    { name: "4K Porns", data: cat4KPorns }
  ];
  
  return c.html(
    <Layout 
        user={user} 
        announcement={config.showAnnouncement ? config.announcement : undefined} 
        lang={lang} 
        activeTab="home"
        globalExpiry={config.globalVipExpiry}
    >
        {shouldShowPopup && (
          <div id="promo-popup" class="fixed inset-0 z-[200] bg-black/90 hidden items-center justify-center backdrop-blur-sm p-4">
              <div class="relative w-full max-w-sm bg-[#1f1f1f] rounded-lg overflow-hidden shadow-2xl border border-yellow-500/30 modal-enter flex flex-col max-h-[85vh]">
                  <button onclick="closePopup(false)" class="absolute top-2 right-2 z-10 bg-black/50 text-white w-8 h-8 rounded-full flex items-center justify-center hover:bg-red-600 transition backdrop-blur-md"><i class="fa-solid fa-xmark"></i></button>
                  <div class="overflow-y-auto custom-scroll flex-grow"><a href={config.popupLink || "#"}><img src={optimizeImg(config.popupImage!)} class="w-full h-auto object-cover" /></a><div class="p-5 bg-[#1f1f1f]">{config.popupMessage && (<p class="text-gray-300 text-sm mb-4 leading-relaxed whitespace-pre-wrap font-medium text-center">{config.popupMessage}</p>)}<a href={config.popupLink || "#"} class="block w-full bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold text-center py-3.5 rounded-xl shadow-lg hover:brightness-110 transition uppercase tracking-wider text-sm">{config.popupBtnText || "View Details"}</a><button onclick="closePopup(true)" class="block w-full text-center text-xs text-gray-500 font-bold mt-3 py-2 rounded-lg hover:bg-zinc-800 hover:text-gray-300 transition">Don't show again today</button></div></div>
              </div>
              <script dangerouslySetInnerHTML={{__html: `const popup = document.getElementById('promo-popup'); const today = new Date().toDateString(); const isHiddenToday = localStorage.getItem('popup_hidden_date') === today; const isHiddenSession = sessionStorage.getItem('popup_closed_session'); if (!isHiddenToday && !isHiddenSession) { setTimeout(() => { popup.classList.remove('hidden'); popup.classList.add('flex'); }, 2000); } window.closePopup = function(hideToday) { popup.classList.add('hidden'); popup.classList.remove('flex'); if(hideToday) { localStorage.setItem('popup_hidden_date', today); } else { sessionStorage.setItem('popup_closed_session', 'true'); } }`}} />
          </div>
        )}
        
      {config.showCustomBanner && config.customBannerImage ? (
            <div class="px-4 mb-8 mt-4">
                <a href={config.customBannerLink || "#"} class="block rounded-lg overflow-hidden shadow-2xl relative aspect-video group">
                    <img src={optimizeImg(config.customBannerImage)} class="w-full h-full object-cover" />
                </a>
            </div>
      ) : (
          sliderMovies.length > 0 && (
              <div class="px-4 mb-8 mt-4">
                  <div class="slider-container relative z-0 group rounded-lg overflow-hidden shadow-2xl aspect-video">
                      {sliderMovies.map((m, idx) => (
                          <div class={`slide ${idx === 0 ? 'active' : ''} absolute inset-0 transition-opacity duration-1000`}>
                              <img src={optimizeImg(m.coverUrl)} class="w-full h-full object-cover" />
                              <div class="absolute bottom-0 left-0 right-0 p-6">
                                  <h1 class="text-xl md:text-3xl font-black text-white truncate leading-tight mb-2 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{m.title}</h1>
                                  <a href={`/movie/${m.id}`} class="inline-flex items-center gap-2 bg-white text-black px-5 py-2 rounded-full font-bold text-xs hover:scale-105 transition transform shadow-lg"><i class="fa-solid fa-play"></i> {t.play}</a>
                              </div>
                          </div>
                      ))}
                  </div>
              </div>
          )
      )}

      <div class="px-3 space-y-10 pb-8">
          {sections.map(section => { 
              if (section.data.length === 0) return null; 
              const cat = section.name; 
              const catMovies = section.data; 
              if(cat === "All Uncensored" || cat === "Myanmar and Asian" || cat === "4K Porns") { 
                  return (
                    <div>
                        <div class="flex justify-between items-end mb-4 px-1"><h2 class="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-pink-500 to-rose-500 border-l-4 border-pink-500 pl-3 leading-none">{cat}</h2><a href={`/category/${cat}`} class="text-[10px] font-bold text-gray-400 flex items-center gap-1 hover:text-white transition uppercase tracking-wider">{t.see_all} <i class="fa-solid fa-chevron-right text-[8px]"></i></a></div>
                        <div class="h-scroll-section">
                            {catMovies.map(m => (
                                <a href={`/movie/${m.id}`} class="h-scroll-item wide block group relative mb-4">
                                    <div class="aspect-video w-full relative overflow-hidden rounded-lg shadow-lg img-skeleton">
                                        <img src={optimizeImg(m.coverUrl || m.posterUrl, 600)} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-700 img-fade" />
                                        <div class="absolute top-2 right-2 bg-pink-600 text-white text-[9px] font-bold px-2 py-0.5 rounded shadow z-10 backdrop-blur-sm">{m.category === "4K Movies" || m.category === "4K Porns" ? "4K" : "HD"}</div>
                                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center"><i class="fa-solid fa-circle-play text-4xl text-white drop-shadow-lg scale-0 group-hover:scale-100 transition duration-300"></i></div>
                                    </div>
                                    <div class="mt-2 text-center"><h3 class="text-xs font-bold truncate text-gray-200 group-hover:text-white transition">{m.title}</h3></div>
                                </a>
                            ))}
                        </div>
                    </div>
                  ) 
              } 
              return (
                <div>
                    <div class="flex justify-between items-end mb-4 px-1"><h2 class="text-lg font-bold text-white border-l-4 border-purple-500 pl-3 leading-none">{cat}</h2><a href={`/category/${cat}`} class="text-[10px] font-bold text-gray-400 flex items-center gap-1 hover:text-white transition uppercase tracking-wider">{t.see_all} <i class="fa-solid fa-chevron-right text-[8px]"></i></a></div>
                    <div class="h-scroll-section custom-scroll">
                        {catMovies.map(m => (
                            <a href={`/movie/${m.id}`} class="h-scroll-item block w-28 flex-shrink-0 group relative mb-4">
                                <div class="aspect-[2/3] w-full relative overflow-hidden rounded-lg shadow-lg img-skeleton">
                                    <img src={optimizeImg(m.posterUrl, 300)} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-700 img-fade" />
                                    <div class="absolute top-2 right-2 bg-purple-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded shadow backdrop-blur-sm">{m.category === "4K Movies" || m.category === "4K Porns" ? "4K" : "HD"}</div>
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

app.get("/api/resolve-url", async (c) => { 
    const token = c.req.query("token"); 
    const entry = await kv.get(["stream_tokens", token]); 
    if (!entry.value) return c.json({ error: "Invalid token" }, 404); 
    
    let url = entry.value as string;
    if(!isValidUrl(url)) return c.json({ error: "Unsafe URL detected" }, 403);
    try {
        url = await resolveRedirect(url);
    } catch (e) {
        console.error("Failed to resolve URL:", e);
    }
    return c.json({ url: url }); 
});
// 🔥 MEDIAFIRE STREAMER (Generator Logic)
app.get("/api/mediafire-stream", async (c) => {
    const url = c.req.query("link");
    if (!url) return c.text("Missing Link", 400);

    try {
        // 1. MediaFire ကို Browser အစစ်ယောင်ဆောင်ပြီး လှမ်းခေါ်မယ်
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
        });
        const html = await res.text();

        // 2. Download Button ကို Regex နဲ့ ရှာမယ် (Generator Code ထဲက ပုံစံအတိုင်း)
        let match = html.match(/aria-label="Download file"\s+href="([^"]+)"/);
        
        // Backup ရှာနည်းများ
        if (!match) match = html.match(/id="downloadButton"\s+href="([^"]+)"/);
        if (!match) match = html.match(/href="([^"]+)"\s+id="downloadButton"/);

        if (match && match[1]) {
            // 3. Link တွေ့ရင် Redirect လုပ်ပေးမယ် (Browser က ဒါကို Direct Link လို့ မြင်သွားမယ်)
            return c.redirect(match[1], 302);
        } else {
            return c.text("Link Extraction Failed", 404);
        }
    } catch (e) {
        return c.text("Server Error", 500);
    }
});

app.get("/api/list", async (c) => { 
    const cat = c.req.query("cat") || "Movies"; 
    const page = parseInt(c.req.query("page") || "1"); 
    const limit = 15; 
    const fetchLimit = (page * limit) + 10; 
    const all = await getMoviesByCategory(cat, fetchLimit); 
    const start = (page - 1) * limit; 
    const movies = all.slice(start, start + limit).map(m => ({
        ...m,
        posterUrl: optimizeImg(m.posterUrl, 300),
        coverUrl: optimizeImg(m.coverUrl, 600)
    })); 
    return c.json({ movies }); 
});

app.get("/category/:cat", async (c) => { 
    const user = await getCurrentUser(c); 
    const cat = c.req.param("cat"); 
    const config = await getConfig(); 
    const movies = await getMoviesByCategory(cat, 15); 
    const isUncensored = cat === "All Uncensored" || cat === "Myanmar and Asian" || cat === "4K Porns"; 
    const lang = getLang(c);
    const countRes = await kv.get<Deno.KvU64>(["counts", cat]);
    const totalCount = countRes.value ? Number(countRes.value) : 0;
    
    return c.html(
    <Layout 
        user={user} 
        announcement={config.showAnnouncement ? config.announcement : undefined} 
        lang={lang} 
        activeTab="home"
        globalExpiry={config.globalVipExpiry}
    ><div class="px-4 py-6"><div class="flex justify-between items-center mb-6"><h1 class="text-2xl font-bold text-white flex items-center gap-3"><a href="/" class="text-gray-400 hover:text-white"><i class="fa-solid fa-arrow-left"></i></a> {cat}</h1><span class="bg-purple-600 text-white text-[10px] px-2.5 py-1 rounded-full font-bold tracking-wider shadow">{totalCount}</span></div><div id="movie-grid" class={isUncensored ? "space-y-4" : "grid grid-cols-3 gap-2"}>
    {movies.map(m => (
        <a href={`/movie/${m.id}`} class="block group relative mb-2">
            <div class={`relative overflow-hidden rounded-lg shadow-lg img-skeleton ${isUncensored ? "aspect-video" : "aspect-[2/3]"}`}>
                <img src={optimizeImg(isUncensored ? (m.coverUrl || m.posterUrl) : m.posterUrl, isUncensored ? 600 : 300)} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-700 img-fade" />
                <div class="absolute top-2 right-2 bg-purple-600 text-white text-[9px] font-bold px-2 py-0.5 rounded shadow z-10 backdrop-blur-sm">{m.category === "4K Movies" || m.category === "4K Porns" ? "4K" : "HD"}</div>
            </div>
            <div class="mt-2 text-center"><h3 class="text-[12px] font-bold truncate text-gray-200 group-hover:text-white transition">{m.title}</h3></div>
        </a>
    ))}
</div></div></Layout>); 
});

app.get("/search", async (c) => { 
    const user = await getCurrentUser(c); 
    const query = c.req.query("q")?.toLowerCase() || ""; 
    const config = await getConfig(); 
    const results = await searchMoviesDB(query); 
    const lang = getLang(c); 
    return c.html(
    <Layout 
        user={user} 
        announcement={config.showAnnouncement ? config.announcement : undefined} 
        lang={lang} 
        activeTab="home"
        globalExpiry={config.globalVipExpiry}
    >
            <div class="p-4">
                <div class="flex items-center gap-3 mb-6">
                    <a href="/" class="text-gray-400 hover:text-white"><i class="fa-solid fa-arrow-left"></i></a>
                    <form action="/search" method="get" class="flex-grow relative">
                        <button type="submit" class="absolute left-3 top-3 text-gray-500 hover:text-white transition z-10"><i class="fa-solid fa-magnifying-glass"></i></button>
                        <input name="q" value={query} placeholder="Search..." class="w-full bg-white/5 border border-white/10 rounded-lg py-3 pl-10 pr-4 text-sm outline-none focus:border-purple-500 text-white" />
                    </form>
                </div>
                <h2 class="text-sm text-gray-400 mb-4 font-medium">Results for "{query}" ({results.length})</h2>
                <div class="grid grid-cols-3 gap-2">
                    {results.map(m => {
                        const isWide = m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns";
                        return (
                            <a href={`/movie/${m.id}`} class={`block group relative ${isWide ? 'col-span-3' : ''}`}>
                                <div class={`${isWide ? "aspect-video" : "aspect-[2/3]"} relative overflow-hidden rounded-lg shadow-lg img-skeleton`}>
                                    <img src={optimizeImg(isWide ? (m.coverUrl || m.posterUrl) : m.posterUrl, isWide ? 600 : 300)} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-700 img-fade" />
                                    {m.category === "All Uncensored" && <div class="absolute top-2 right-2 bg-red-600 text-white text-[9px] font-bold px-2 py-0.5 rounded shadow">18+</div>}
                                </div>
                                <div class="mt-2 text-center"><h3 class="text-[12px] font-bold truncate text-gray-200 group-hover:text-white transition">{m.title}</h3></div>
                            </a>
                        )
                    })}
                </div>
            </div>
        </Layout>
    ); 
});

app.get("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const config = await getConfig(); const lang = getLang(c); return c.html(<Layout user={user} title="Request" announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="request"><div class="p-6 max-w-md mx-auto min-h-[70vh] flex flex-col justify-center"><h1 class="text-3xl font-black mb-2 text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-500">Request Movie</h1><p class="text-gray-400 text-sm mb-8">ကြည့်လိုသော ဇာတ်ကားနာမည် codeများဖြင့်တောင်းဆိုရန်</p><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name (e.g. Iron Man CAWD111)" required class="input-box" /><button class="btn-primary w-full">Adminဆီ ပို့ရန်</button></form></div></Layout>); });
app.post("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const { movieName } = await c.req.parseBody(); const req: UserRequest = { id: crypto.randomUUID(), username: user.username, movieName: String(movieName), timestamp: Date.now() }; await kv.set(["requests", req.id], req); return c.redirect("/request?success=Request Submitted!"); });
app.post("/report", async (c) => { const user = await getCurrentUser(c); const { movieId, movieName } = await c.req.parseBody(); const reqId = crypto.randomUUID(); const reportData: UserRequest = { id: reqId, username: user ? user.username : "Guest", movieName: `[BROKEN LINK] ${movieName}`, timestamp: Date.now() }; await kv.set(["requests", reqId], reportData); return c.redirect(`/movie/${movieId}?success=Report Sent! Admin will fix it soon.`); });
app.get("/favorites", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const lang = getLang(c); const favs = []; if(user.favorites) { for(const id of user.favorites) { const m = await getMovie(id); if(m && !m.isDeleted) favs.push(m); } } return c.html(<Layout user={user} title="Saved" lang={lang} activeTab="saved"><div class="p-4"><h1 class="text-2xl font-bold mb-6 flex items-center gap-2"><i class="fa-solid fa-heart text-red-500"></i> My Saved Movies</h1><div class="grid grid-cols-3 gap-2">{favs.map(m => (<a href={`/movie/${m.id}`} class="block group relative"><div class="aspect-[2/3] relative overflow-hidden rounded-lg shadow-lg"><img src={optimizeImg(m.posterUrl, 300)} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-700 img-fade" /></div><div class="mt-2 text-center"><h3 class="text-xs font-bold truncate text-gray-200">{m.title}</h3></div></a>))}</div>{favs.length===0 && <p class="text-gray-500 text-center mt-10">No saved movies.</p>}</div></Layout>); });
app.post("/api/fav", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { movieId } = await c.req.parseBody(); const id = String(movieId); if (!user.favorites) user.favorites = []; if (user.favorites.includes(id)) user.favorites = user.favorites.filter(f => f !== id); else user.favorites.push(id); await kv.set(["users", user.username], user); return c.redirect(c.req.header("Referer") || "/"); });
app.get("/stream/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Link Expired or Invalid", 403); return c.redirect(entry.value as string); });
app.get("/dl/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Download Link Expired", 403); return c.redirect(entry.value as string); });

// 🔥 OPTIMIZED MOVIE DETAIL ROUTE (No Waiting for Resolve)
app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const lang = getLang(c);
    const t = i18n[lang];

    const [movieRes, user, config] = await Promise.all([
        getMovie(id), 
        getCurrentUser(c), 
        getConfig() 
    ]);
    
    const movie = movieRes;
    if (!movie || movie.isDeleted) return c.text("Not Found", 404);

    let related = [];
    try {
        const allRelated = await getMoviesByCategory(movie.category, 5);
        related = allRelated.filter(m => m.id !== movie.id).slice(0, 4);
    } catch (e) {}

    const moviePrice = movie.price || 0;
    const isPurchased = user?.purchased?.includes(movie.id);
    const isVip = isPremium(user, config);
    let canWatch = false;
    
    if (moviePrice > 0) {
        if (isPurchased) canWatch = true;
    } else {
        if (isVip) canWatch = true;
    }

    const displayImage = optimizeImg(movie.coverUrl || movie.posterUrl, 800); 
    let initialStreamUrl = movie.streamUrl;
    let episodes = movie.episodes || [];
    if (movie.category === "Series" && episodes.length > 0) initialStreamUrl = episodes[0].url;
    
    const seasons: Record<string, Episode[]> = {};
    if(episodes) { episodes.forEach(ep => { if(ep.season) { if(!seasons[ep.season]) seasons[ep.season] = []; seasons[ep.season].push(ep); } }); }

    let playerUrl = "", secureDownloadUrl = "", secureDownloadUrl2 = "", playerUrl2 = "", playbackToken = "", playbackToken2 = "";

    if (canWatch) {
        const token = crypto.randomUUID(); 
        await kv.set(["stream_tokens", token], initialStreamUrl, { expireIn: 3600 * 3 }); 
        playerUrl = `/stream/${token}`; 
        playbackToken = token; 

        if (movie.streamUrl2) { 
            const token2 = crypto.randomUUID(); 
            await kv.set(["stream_tokens", token2], movie.streamUrl2, { expireIn: 3600 * 3 }); 
            playerUrl2 = `/stream/${token2}`; 
            playbackToken2 = token2; 
        }

        if (movie.downloadUrl) { const dlToken = crypto.randomUUID(); await kv.set(["stream_tokens", dlToken], movie.downloadUrl, { expireIn: 3600 * 3 }); secureDownloadUrl = `/dl/${dlToken}`; }
        if (movie.downloadUrl2) { const dlToken2 = crypto.randomUUID(); await kv.set(["stream_tokens", dlToken2], movie.downloadUrl2, { expireIn: 3600 * 3 }); secureDownloadUrl2 = `/dl/${dlToken2}`; }
    }

    return c.html(
    <Layout 
        user={user} 
        announcement={config.showAnnouncement ? config.announcement : undefined} 
        lang={lang} 
        activeTab="home"
        globalExpiry={config.globalVipExpiry}
    >
        
        <div id="buy-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-md p-4">
             <div class="glass-panel p-6 rounded-lg w-full max-w-sm text-center relative shadow-2xl modal-enter">
                  <div class="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-yellow-500/20">
                      <i class="fa-solid fa-cart-shopping text-3xl text-yellow-500"></i>
                  </div>
                  <h3 class="text-xl font-black text-white mb-2">Premium Purchase</h3>
                  <p class="text-gray-300 text-sm leading-relaxed mb-6">
                      ယခု Video သည် <span class="text-yellow-500 font-bold">4K Quality</span> ဖြစ်တာမို့ ဝယ်ယူရန် <span id="buy-price" class="text-white font-black text-lg bg-white/10 px-2 rounded">--</span> ကောက်ခံပါမည်။
                  </p>
                  <div class="flex gap-3 h-12"> 
                      <button onclick="closeBuyModal()" class="flex-1 h-full rounded-xl bg-slate-800 text-white font-bold hover:bg-slate-700 transition border border-white/10">Cancel</button>
                      {user ? (
                          <form action="/api/buy-movie" method="post" class="flex-1 h-full"> 
                              <input type="hidden" name="movieId" value={movie.id} />
                              <button class="w-full h-full rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 text-white font-bold hover:brightness-110 transition shadow-lg">Buy Now</button>
                          </form>
                      ) : (
                          <a href="/login" class="flex-1 h-full flex items-center justify-center rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-500 transition">Login</a>
                      )}
                  </div>
             </div>
        </div>

        <div id="vip-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-md p-4">
             <div class="glass-panel p-6 rounded-lg w-full max-w-sm text-center relative shadow-2xl modal-enter">
                  <div class="w-16 h-16 bg-purple-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-purple-500/20">
                      <i class="fa-solid fa-crown text-3xl text-purple-500 animate-pulse"></i>
                  </div>
                  <h3 class="text-lg font-black text-white mb-2">VIP Access Required</h3>
                  <p class="text-gray-300 text-sm leading-relaxed mb-4 font-bold">Moviesများ ကြည့်ရန် ဒေါင်းရန်အတွက် Accountဖွင့်ပါ</p>
                  <div class="flex gap-3 h-12"> 
                      <button onclick="closeVipModal()" class="flex-1 h-full rounded-xl bg-slate-800 text-white font-bold hover:bg-slate-700 transition border border-white/10">Cancel</button>
                      <a href={user ? "/profile" : "/login"} class="flex-1 h-full flex items-center justify-center rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold hover:brightness-110 transition shadow-lg">{user ? "Enter Key" : "Login"}</a>
                  </div>
                  <a href="https://t.me/iqowoq" target="_blank" class="block mt-4 text-xs text-blue-400 hover:text-white underline">Contact Admin on Telegram</a>
             </div>
        </div>

        <div class="max-w-4xl mx-auto">
           {/* 🔥 VIDEO PLAYER */}
           <div class="w-full aspect-video bg-black relative shadow-lg group rounded-xl overflow-hidden border border-zinc-800">
                {canWatch ? (
                    <>
                        <div id="video-cover" class="absolute inset-0 z-20 cursor-pointer group">
                            <img src={displayImage} class="w-full h-full object-cover transition duration-700 group-hover:scale-105" />
                            <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-300 bg-black/20">
                                <i class="fa-solid fa-circle-play text-6xl text-white drop-shadow-lg"></i>
                            </div>
                        </div>
                        <div id="video-player" class="w-full h-full hidden"></div>
                    </>
                ) : (
                    <div class="absolute inset-0 z-20">
                        <img src={displayImage} class="w-full h-full object-cover" />
                    </div>
                )}
           </div>
           
           <div class="p-6">
               <div class="flex justify-between items-start mb-3">
                   <h1 class="text-xl font-bold text-white leading-tight flex-grow pr-4">{movie.title}</h1>
                   <div class="flex items-center gap-2 flex-shrink-0 h-10">
                       <button onclick={`shareMovie('${movie.title}')`} class="w-10 h-10 flex items-center justify-center rounded-full bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition"><i class="fa-solid fa-share-nodes text-lg"></i></button>
                       {user && (<form action="/api/fav" method="post" class="m-0 p-0 flex"><input type="hidden" name="movieId" value={movie.id} /><button class="w-10 h-10 flex items-center justify-center rounded-full bg-zinc-800 transition hover:bg-zinc-700"><i class={`fa-solid fa-heart text-lg ${user.favorites && user.favorites.includes(movie.id) ? 'text-red-600' : 'text-zinc-400'}`}></i></button></form>)}
                   </div>
               </div>
               
               {isPurchased && (
                   <div class="bg-gradient-to-r from-green-900/40 to-green-600/10 border border-green-500/30 p-3 rounded-xl mb-4 flex items-center gap-3">
                       <div class="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center text-green-500"><i class="fa-solid fa-circle-check"></i></div>
                       <div><h3 class="text-green-400 font-bold text-sm">ဝယ်ယူပြီးပါပြီ (Purchased)</h3><p class="text-green-500/60 text-[10px]">You have lifetime access to this video.</p></div>
                   </div>
               )}

               <div class="flex flex-wrap items-center gap-2 mb-6">
                   <span class="bg-zinc-800 text-gray-300 text-xs px-3 py-1 rounded-full border border-zinc-700">{movie.year}</span>
                   <span class="bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 text-xs px-3 py-1 rounded-full font-bold">{movie.category}</span>
                   {movie.fileSize && (<span class="bg-blue-900/30 text-blue-400 border border-blue-500/30 text-xs px-3 py-1 rounded-full flex items-center gap-1 font-bold"><i class="fa-solid fa-file-arrow-down"></i> {movie.fileSize}</span>)}
                   {movie.duration && (<span class="bg-purple-900/30 text-purple-400 border border-purple-500/30 text-xs px-3 py-1 rounded-full flex items-center gap-1 font-bold"><i class="fa-regular fa-clock"></i> {movie.duration}</span>)}
                   {moviePrice > 0 ? (isPurchased ? <span class="bg-green-900/30 text-green-400 px-3 py-1 rounded-full border border-green-500/30 font-bold text-xs"><i class="fa-solid fa-check"></i> Owned</span> : <span class="bg-red-900/30 text-red-400 px-3 py-1 rounded-full border border-red-500/30 font-bold text-xs">{moviePrice} Ks</span>) : (<span class="bg-yellow-500/20 text-yellow-500 border border-yellow-500/30 px-3 py-1 rounded-full font-bold text-xs">VIP</span>)}
               </div>

               <div class="flex flex-col gap-3 mb-8">
                   {movie.category !== "Series" && !(movie.category === "Animation" && episodes.length > 0) && (
                       <div class={`grid gap-2 ${movie.streamUrl2 ? "grid-cols-2" : "grid-cols-1"}`}>
                            <button onclick={canWatch ? `loadPlayer('${movie.linkType === 'direct' ? playbackToken : playerUrl}', '${movie.linkType}', '${movie.id}', '${movie.title.replace(/'/g, "\\'")}', '${movie.posterUrl}', this)` : (moviePrice > 0 ? `openBuyModal('${moviePrice}', '${movie.title.replace(/'/g, "\\'")}')` : `openVipModal()`)} class="srv-btn w-full bg-white text-black font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 active:scale-95 transition hover:brightness-110 shadow-lg text-xs"><i class={`fa-solid ${canWatch ? 'fa-play' : 'fa-lock'}`}></i> {t.server1} {canWatch ? "" : (moviePrice > 0 ? "(Buy)" : "")}</button>
                            {movie.streamUrl2 && (<button onclick={canWatch ? `loadPlayer('${movie.linkType === 'direct' ? playbackToken2 : playerUrl2}', '${movie.linkType}', '${movie.id}', '${movie.title.replace(/'/g, "\\'")}', '${movie.posterUrl}', this)` : (moviePrice > 0 ? `openBuyModal('${moviePrice}', '${movie.title.replace(/'/g, "\\'")}')` : `openVipModal()`)} class="srv-btn w-full bg-zinc-800 text-white font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 active:scale-95 transition hover:bg-zinc-700 border border-zinc-700 text-xs"><i class={`fa-solid ${canWatch ? 'fa-server' : 'fa-lock'}`}></i> {t.server2}</button>)}
                       </div>
                   )}

                   {movie.category !== "Series" && (movie.downloadUrl || movie.downloadUrl2) && (
                         <div class="grid grid-cols-2 gap-2 mt-1">
                            {movie.downloadUrl && (<button onclick={canWatch ? `confirmDownload('${secureDownloadUrl}', '${movie.title.replace(/'/g, "\\'")}', '${movie.fileSize || ""}')` : (moviePrice > 0 ? `openBuyModal('${moviePrice}', '${movie.title.replace(/'/g, "\\'")}')` : `openVipModal()`)} class="w-full bg-zinc-800 text-white font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 text-xs"><i class={`fa-solid ${canWatch ? 'fa-download' : 'fa-lock'}`}></i> DL 1</button>)}
                            {movie.downloadUrl2 && (<button onclick={canWatch ? `confirmDownload('${secureDownloadUrl2}', '${movie.title.replace(/'/g, "\\'")}', '${movie.fileSize || ""}')` : (moviePrice > 0 ? `openBuyModal('${moviePrice}', '${movie.title.replace(/'/g, "\\'")}')` : `openVipModal()`)} class="w-full bg-zinc-800 text-white font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 text-xs"><i class={`fa-solid ${canWatch ? 'fa-download' : 'fa-lock'}`}></i> DL 2</button>)}
                         </div>
                    )}
                    
                    <button onclick="openHelpModal()" class="w-fit mx-auto text-xs text-yellow-500 hover:text-yellow-400 flex items-center gap-2 mt-4 font-bold transition-colors bg-yellow-500/10 px-4 py-2 rounded-full border border-yellow-500/20"><i class="fa-solid fa-circle-question"></i> {t.dl_help}</button>
                    {canWatch && <form action="/report" method="post" class="mt-4 text-center"><input type="hidden" name="movieId" value={movie.id} /><input type="hidden" name="movieName" value={movie.title} /><button class="text-[10px] text-red-500 hover:text-red-400 font-bold underline decoration-dotted opacity-80 hover:opacity-100 transition"><i class="fa-solid fa-flag"></i> Report Broken Link</button></form>}
               </div>
               
<div class="bg-yellow-500/10 border border-yellow-500/20 p-3 rounded-xl mb-6 flex items-start gap-3 animate-pulse">
    <div class="mt-0.5 min-w-[20px]">
        <i class="fa-solid fa-triangle-exclamation text-yellow-500"></i>
    </div>
    <p class="text-xs text-gray-300 leading-relaxed">
        Movieများ ကြည့်မရ ဒေါင်းမရလျှင် <span class="text-yellow-500 font-bold border-b border-yellow-500 border-dotted">VPN</span> (Outline သို့မဟုတ် အခြား VPN တစ်ခုခု) ခံပြီး ပြန်စမ်းကြည့်ပေးပါ။
    </p>
</div>

               {(movie.category === "Series" || movie.category === "Animation") && episodes.length > 0 && (
                   <div class="mb-8">
                       <h3 class="font-bold text-white mb-3 flex items-center gap-2"><i class="fa-solid fa-layer-group text-yellow-500"></i> Seasons & Episodes</h3>
                       <div class="flex overflow-x-auto gap-3 pb-2 scrollbar-hide">{Object.keys(seasons).map((season, idx) => { const safeId = season.replace(/\s+/g, '-'); return (<button id={`btn-${safeId}`} onclick={`switchSeason('${safeId}')`} class="season-tab-btn flex-shrink-0 px-5 py-2 rounded-full text-xs font-bold transition border border-zinc-800 bg-zinc-800 text-gray-400 hover:text-white hover:border-zinc-600">{season}</button>) })}</div>
                       <div id="episodes-container">
                           {Object.keys(seasons).map((season, idx) => { 
                               const safeId = season.replace(/\s+/g, '-'); 
                               const eps = seasons[season];
                               return (
                                   <div id={`ep-grid-${safeId}`} class="season-content hidden mt-3 bg-[#1f1f1f] rounded-xl border border-zinc-800 p-3 animate-fade-in">
                                       <div class="grid grid-cols-4 gap-2 max-h-60 overflow-y-auto custom-scroll pr-1">
                                           {eps.map((ep, i) => {
                                               // Find next ep URL for Series Logic
                                               const nextEp = eps[i+1] ? eps[i+1].url.trim() : "";
                                               return (
                                               <button data-url={ep.url.trim()} data-next={nextEp} onclick={canWatch ? `loadPlayer('${ep.url.trim()}', '${movie.linkType}', '${movie.id}', '${movie.title.replace(/'/g, "\\'")}', '${movie.posterUrl}', this)` : (moviePrice > 0 ? `openBuyModal('${moviePrice}', '${movie.title.replace(/'/g, "\\'")}')` : `openVipModal()`)} class="srv-btn bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] py-3 rounded-lg border border-zinc-700 transition-colors font-bold truncate">{canWatch ? "" : "🔒 "} {ep.name}</button>
                                            )})}
                                       </div>
                                   </div>
                               ) 
                            })}
                        </div>
                   </div> 
               )}
               
               <p class="text-sm text-gray-300 leading-relaxed mb-8 whitespace-pre-wrap">{movie.description}</p>
               {related.length > 0 && (
                   <div class="pt-6 border-t border-zinc-800"><h3 class="font-bold text-white mb-4 text-lg">You May Also Like</h3><div class="h-scroll-section custom-scroll">{related.map(m => (<a href={`/movie/${m.id}`} class={`h-scroll-item block relative rounded-lg overflow-hidden flex-shrink-0 group ${m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns" ? 'wide' : 'w-28'}`}><div class={`${m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns" ? "aspect-video" : "aspect-[2/3]"} w-full relative overflow-hidden rounded-lg shadow-lg img-skeleton`}><img src={optimizeImg(m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns" ? (m.coverUrl || m.posterUrl) : m.posterUrl, 300)} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" /></div><div class="mt-2 text-center"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div>
               )}
           </div>
        </div>
      </Layout>
    );
});

app.post("/api/buy-movie", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const { movieId } = await c.req.parseBody();
    const id = String(movieId);
    const movie = await getMovie(id);
    if (!movie) return c.redirect(`/?error=Movie Not Found`);
    if (!movie.price || movie.price <= 0) return c.redirect(`/movie/${id}`);
    
    const userKey = ["users", user.username];
    const userRes = await kv.get<User>(userKey);
    const currentUser = userRes.value;

    if (!currentUser) return c.redirect("/login");
    if (currentUser.purchased && currentUser.purchased.includes(id)) return c.redirect(`/movie/${id}`);
    if (!currentUser.coins || currentUser.coins < movie.price) return c.redirect(`/movie/${id}?error=Not enough coins! Please top up.`);

    currentUser.coins -= movie.price;
    if (!currentUser.purchased) currentUser.purchased = [];
    currentUser.purchased.push(id);

    const commit = await kv.atomic().check(userRes).set(userKey, currentUser).commit();
    if (!commit.ok) return c.redirect(`/movie/${id}?error=Transaction failed. Please try again.`);

    await logAdminAction("purchase", `${user.username} bought ${movie.title} for ${movie.price}Ks`);
    return c.redirect(`/movie/${id}?success=Purchase Successful! Enjoy.`);
});

app.get("/login", (c) => {
    const lang = getLang(c);
    const t = i18n['my'];
    return c.html(
      <Layout hideNav={true} lang={lang} activeTab="me">
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black p-4 overflow-hidden">
            <div class="w-full max-w-sm">
                <h1 class="text-4xl font-black text-yellow-500 mb-8 text-center italic tracking-tighter">GOLD FLIX</h1>
                <form action="/login" method="post" class="bg-[#1f1f1f] p-8 rounded-lg border border-zinc-800 space-y-5 shadow-2xl">
                    <h2 class="text-xl font-bold text-white">{t.login}</h2>
                    <input name="username" placeholder={t.username} required class="input-box" />
                    <input type="password" name="password" placeholder={t.password} required class="input-box" />
                    <label class="flex items-center text-gray-400 text-xs">
                        <input type="checkbox" name="remember" class="mr-2 accent-yellow-500" /> {t.remember}
                    </label>
                    <button class="btn-primary w-full shadow-lg hover:shadow-yellow-500/20">{t.login}</button>
                    <p class="text-xs text-gray-500 text-center mt-2">{t.no_acc} <a href="/signup" class="text-white font-bold hover:text-yellow-500 transition">{t.create_acc}</a></p>
                    <p class="text-xs text-gray-500 text-center"><a href="/forgot-password" class="text-gray-400 hover:text-white">{t.forgot_pass}</a></p>
                </form>
            </div>
        </div>
      </Layout>
    );
});

app.post("/login", async (c) => { 
    const ip = getClientIp(c);
    const lang = getLang(c);
    const t = i18n['my'];
    if (await isIpBanned(ip)) return c.html(<Layout hideNav={true} title="Access Denied" lang={lang}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="bg-[#1f1f1f] p-8 rounded-lg border border-red-600 text-center max-w-sm w-full shadow-2xl relative overflow-hidden"><div class="absolute inset-0 bg-red-600/10 blur-xl"></div><div class="relative z-10"><i class="fa-solid fa-ban text-6xl text-red-600 mb-6 drop-shadow-[0_0_10px_rgba(220,38,38,0.5)]"></i><h1 class="text-2xl font-black text-white mb-2 uppercase tracking-widest">{t.access_denied}</h1><p class="text-gray-400 text-sm mb-6 leading-relaxed">{t.ip_banned} <span class="font-mono text-red-400 bg-red-900/20 px-1 rounded">{ip}</span></p><div class="text-[10px] text-gray-600 uppercase font-bold tracking-wider">Contact Admin for Support</div></div></div></div></Layout>);
    
    if (!await checkLoginRateLimit(ip)) return c.html(<Layout hideNav={true} title="Security Alert" lang={lang}><div class="min-h-screen flex items-center justify-center bg-black p-4 relative overflow-hidden"><div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-red-600/20 blur-[100px] rounded-full pointer-events-none"></div><div class="relative z-10 bg-[#1f1f1f] p-8 rounded-lg border border-red-500/30 shadow-2xl max-w-sm w-full text-center"><div class="w-20 h-20 bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-6 border border-red-500/20"><i class="fa-solid fa-shield-halved text-4xl text-red-500 animate-pulse"></i></div><h1 class="text-xl font-bold text-white mb-2">Too Many Attempts</h1><p class="text-gray-400 text-sm mb-6 leading-relaxed">Password မှားယွင်းမှု များနေပါသည်။</p><div class="bg-black/50 rounded-lg p-3 border border-red-900/50 mb-6"><p class="text-yellow-500 text-xs font-bold uppercase tracking-wider">{t.wait}</p><p class="text-white font-mono text-lg font-bold">15 Minutes</p></div><a href="/login" class="block w-full bg-zinc-700 hover:bg-zinc-600 text-white font-bold py-3 rounded-lg transition border border-zinc-600">Back to Login</a></div></div></Layout>);

    const body = await c.req.parseBody(); 
    
    // ZOD VALIDATION
    const parsed = AuthSchema.safeParse(body);
    if (!parsed.success) return c.redirect("/login?error=" + parsed.error.issues[0].message);

    const user = await getUser(String(body["username"])); 
    const hashedInput = await hashPassword(String(body["password"])); 
    
    if (user && user.passwordHash === hashedInput) { 
        if (user.isBanned) return c.redirect("/login?error=Your account has been suspended by Admin!");
        const sessionId = crypto.randomUUID(); 
        user.sessionId = sessionId; 
        user.lastLoginIp = ip; 
        await kv.set(["users", user.username], user); 
        const maxAge = body["remember"] === "on" ? 60 * 60 * 24 * 7 : undefined; 
        setCookie(c, "auth_session", `${user.username}:${sessionId}`, { path: "/", maxAge, httpOnly: true, secure: true, sameSite: "Strict" }); 
        return c.redirect("/"); 
    } 
    
    await recordLoginFail(ip);
    return c.redirect("/login?error=Invalid Username or Password"); 
});

app.get("/signup", (c) => {
    const lang = getLang(c);
    const t = i18n['my'];
    return c.html(
    <Layout hideNav={true} lang={lang} activeTab="me">
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black p-4 overflow-hidden">
            <div class="w-full max-w-sm">
                <h1 class="text-3xl font-black text-yellow-500 mb-8 text-center italic tracking-tighter">GOLD FLIX</h1>
                <form action="/signup" method="post" class="bg-[#1f1f1f] p-8 rounded-lg border border-zinc-800 space-y-5 shadow-2xl">
                    <h2 class="text-xl font-bold text-white">{t.create_acc}</h2>
                    <input name="username" placeholder={t.username} required class="input-box" />
                    <input type="password" name="password" placeholder={t.password} required class="input-box" />
                    <div class="space-y-2">
                         <label class="text-xs text-gray-400 font-bold">{t.sec_q} (စကားဝှက်မေ့ရင် ပြန်ယူရန်)</label>
                         <select name="question" class="input-box bg-[#1a1a1a] border-zinc-700 text-sm">
                             {SECURITY_QUESTIONS.map(q => <option value={q}>{q}</option>)}
                         </select>
                         <input name="answer" placeholder={t.sec_a} required class="input-box" />
                    </div>
                    <button class="btn-primary w-full shadow-lg hover:shadow-yellow-500/20">{t.signup}</button>
                    <p class="text-xs text-gray-500 text-center mt-2">{t.has_acc} <a href="/login" class="text-white font-bold hover:text-yellow-500 transition">{t.login}</a></p>
                </form>
            </div>
        </div>
    </Layout>
    );
});

app.post("/signup", async (c) => { 
    const clientIp = getClientIp(c);
    if (await isIpBanned(clientIp)) return c.text("Banned", 403);

    const body = await c.req.parseBody();
    // ZOD VALIDATION
    const parsed = AuthSchema.safeParse(body);
    if (!parsed.success) return c.redirect("/signup?error=" + parsed.error.issues[0].message);

    const { username, password, question, answer } = body;
    if (await getUser(username as string)) return c.redirect("/signup?error=User already exists!"); 
    
    const passwordHash = await hashPassword(password as string); 
    const answerHash = await hashPassword(String(answer).toLowerCase().trim());
    
    const newUser: User = { 
        username: String(username), passwordHash, expiryDate: null, favorites: [], 
        sessionId: "", ip: clientIp, lastLoginIp: clientIp, isBanned: false, coins: 0, purchased: [],
        securityQ: String(question), securityA: answerHash, notifications: []
    }; 
    await kv.set(["users", String(username)], newUser); 
    return c.redirect("/login?success=Account created successfully!"); 
});

app.get("/forgot-password", (c) => {
    const lang = getLang(c);
    const t = i18n['my'];
    return c.html(
        <Layout hideNav={true} lang={lang}>
            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black p-4 overflow-hidden">
                <div class="w-full max-w-sm bg-[#1f1f1f] p-8 rounded-lg border border-zinc-800 shadow-xl">
                    <h2 class="text-xl font-bold text-white mb-4">{t.forgot_pass}</h2>
                    <form action="/forgot-password" method="post" class="space-y-4">
                        <input name="username" placeholder={t.username} required class="input-box" />
                        <button class="btn-primary w-full">{t.next}</button>
                    </form>
                    <a href="/login" class="block text-center text-xs text-gray-500 mt-4 hover:text-white">{t.back_login}</a>
                </div>
            </div>
        </Layout>
    );
});

app.post("/forgot-password", async (c) => {
    const { username } = await c.req.parseBody();
    const user = await getUser(String(username));
    const lang = getLang(c);
    const t = i18n['my'];
    if (!user || !user.securityQ) return c.redirect("/forgot-password?error=User not found or no security question set.");
    return c.html(
        <Layout hideNav={true} lang={lang}>
            <div class="min-h-screen flex items-center justify-center bg-black p-4">
                <div class="w-full max-w-sm bg-[#1f1f1f] p-8 rounded-lg border border-zinc-800 shadow-xl">
                    <h2 class="text-xl font-bold text-white mb-2">{t.sec_q}</h2>
                    <div class="bg-yellow-500/10 border border-yellow-500/20 p-3 rounded-xl mb-4 text-yellow-500 font-bold text-sm text-center">{user.securityQ}</div>
                    <form action="/reset-password" method="post" class="space-y-4">
                        <input type="hidden" name="username" value={user.username} />
                        <input name="answer" placeholder={t.sec_a} required class="input-box" />
                        <input type="password" name="newpass" placeholder={t.new_pass} required class="input-box" />
                        <button class="btn-primary w-full">{t.reset_pass}</button>
                    </form>
                </div>
            </div>
        </Layout>
    );
});

app.post("/reset-password", async (c) => {
    const { username, answer, newpass } = await c.req.parseBody();
    const user = await getUser(String(username));
    if(!user) return c.redirect("/login?error=Error");
    const ansHash = await hashPassword(String(answer).toLowerCase().trim());
    if (ansHash !== user.securityA) return c.redirect("/forgot-password?error=Incorrect Answer");
    user.passwordHash = await hashPassword(String(newpass));
    await kv.set(["users", user.username], user);
    await logAdminAction("reset_pass", `User ${username} reset password`);
    return c.redirect("/login?success=Password Reset Successful!");
});

app.get("/profile", async (c) => { 
    const user = await getCurrentUser(c); 
    if (!user) return c.redirect("/login"); 
    const config = await getConfig(); 
    const premium = isPremium(user, config); 
    const isGlobal = config.globalVipExpiry && config.globalVipExpiry > Date.now();
    const globalDaysLeft = isGlobal ? Math.ceil((config.globalVipExpiry! - Date.now()) / 86400000) : 0;
    const personalDaysLeft = user.expiryDate ? Math.ceil((new Date(user.expiryDate).getTime() - Date.now()) / 86400000) : 0;
    const finalDays = Math.max(globalDaysLeft, personalDaysLeft);
    const statusText = premium ? "VIP Active" : "Free Member";
    const memberId = `GF-${user.username.toUpperCase().slice(0,3)}-${new Date().getFullYear()}`;
    const favCount = user.favorites ? user.favorites.length : 0;
    const userCoins = user.coins || 0;
    const lang = getLang(c);

    const purchasedMovies = [];
    if (user.purchased && user.purchased.length > 0) {
        const promises = user.purchased.map(id => getMovie(id));
        const results = await Promise.all(promises);
        purchasedMovies.push(...results.filter(m => m && !m.isDeleted)); 
    }

    const plans = [
        { name: "1 Month", price: "700 Ks", days: 30, features: ["Watch All (Except 4K Porns)", "Direct Download"] },
        { name: "3 Month", price: "1,500 Ks", days: 90, popular: true, features: ["Watch All (Except 4K Porns)", "Direct Download"] },
        { name: "5 Month", price: "2,200 Ks", days: 150, features: ["Watch All (Except 4K Porns)", "Direct Download"] },
        { name: "1Year", price: "5,000 Ks", days: 365, features: ["Watch All (Except 4K Porns)", "Direct Download"] }
    ]; 

    return c.html(
      <Layout user={user} lang={lang} activeTab="me">
        <div class="p-4 max-w-2xl mx-auto space-y-5 pb-20">
            {/* NOTIFICATIONS BOX */}
            {user.notifications && user.notifications.length > 0 && (
                <div class="bg-black/50 border border-zinc-800 p-4 rounded-xl">
                    <h3 class="font-bold text-white text-xs mb-3 flex items-center gap-2"><i class="fa-solid fa-bell text-yellow-500"></i> Notifications</h3>
                    <div class="space-y-2 max-h-40 overflow-y-auto custom-scroll">
                        {user.notifications.slice().reverse().map(n => (
                            <div class="text-xs p-2 bg-zinc-800/50 rounded flex justify-between items-start">
                                <span class="text-gray-300">{n.msg}</span>
                                <span class="text-[9px] text-gray-600 whitespace-nowrap ml-2">{new Date(n.date).toLocaleDateString()}</span>
                            </div>
                        ))}
                    </div>
                    <form action="/profile/clear-notis" method="post" class="mt-2 text-right">
                        <button class="text-[9px] text-red-400 hover:text-white underline">Clear All</button>
                    </form>
                </div>
            )}

            <div class="relative w-full aspect-[1.8/1] rounded-lg bg-gradient-to-br from-[#FFD700] via-[#FDB931] to-[#9e7f13] p-6 shadow-[0_10px_30px_-10px_rgba(253,185,49,0.4)] text-black flex flex-col justify-between overflow-hidden relative group">
                <div class="absolute top-0 right-0 p-4 opacity-10"><i class="fa-solid fa-crown text-9xl transform rotate-12"></i></div>
                <div class="absolute -bottom-10 -left-10 w-32 h-32 bg-white/20 blur-3xl rounded-full"></div>
                <div class="relative z-10 flex justify-between items-start">
                     <div class="flex items-center gap-4">
                         <div class="w-14 h-14 bg-black/90 text-yellow-500 rounded-full flex items-center justify-center text-2xl font-black border-2 border-white/50 shadow-lg backdrop-blur-sm">{user.username[0].toUpperCase()}</div>
                         <div><h2 class="text-2xl font-black tracking-tighter leading-none">{user.username}</h2><span class="text-[10px] font-bold bg-black/20 px-2 py-0.5 rounded text-black/80 inline-block mt-1 uppercase tracking-widest border border-black/10">{statusText}</span></div>
                     </div>
                     <i class="fa-solid fa-wifi text-2xl opacity-60"></i>
                </div>
                <div class="relative z-10 font-mono"><p class="text-[9px] uppercase opacity-70 font-bold mb-1">Membership ID</p><div class="flex items-center gap-2"><p class="text-lg font-bold tracking-widest">{memberId}</p><button onclick={`copyToClip('${memberId}')`} class="w-6 h-6 flex items-center justify-center bg-black/10 rounded hover:bg-black/20 transition text-xs"><i class="fa-regular fa-copy"></i></button></div></div>
            </div>

            <div class="grid grid-cols-3 gap-3">
                 <a href="/favorites" class="bg-[#1f1f1f] p-4 rounded-lg border border-zinc-800 flex flex-col items-center justify-center gap-1 hover:bg-[#252525] transition active:scale-95"><div class="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 text-sm"><i class="fa-solid fa-heart"></i></div><span class="block text-xl font-bold text-white leading-none">{favCount}</span><span class="text-[9px] text-gray-500 font-bold uppercase">Saved</span></a>
                 <div class="bg-[#1f1f1f] p-4 rounded-lg border border-zinc-800 flex flex-col items-center justify-center gap-1"><div class="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500 text-sm"><i class="fa-solid fa-coins"></i></div><span class="block text-xl font-bold text-white leading-none">{userCoins}</span><span class="text-[9px] text-gray-500 font-bold uppercase">Kyats (Ks)</span></div>
                 <div class="bg-[#1f1f1f] p-4 rounded-lg border border-zinc-800 flex flex-col items-center justify-center gap-1"><div class={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${premium ? 'bg-green-500/10 text-green-500' : 'bg-gray-700/20 text-gray-500'}`}><i class="fa-solid fa-clock"></i></div><span class={`block text-xl font-bold leading-none ${premium ? 'text-white' : 'text-gray-500'}`}>{premium ? finalDays : "0"}</span><span class="text-[9px] text-gray-500 font-bold uppercase">Days</span></div>
            </div>

            <div class="bg-[#1f1f1f] p-5 rounded-lg border border-zinc-800 relative overflow-hidden">
                 <div class="absolute -right-4 -top-4 opacity-5"><i class="fa-solid fa-ticket text-8xl"></i></div>
                 <h3 class="font-bold text-gray-300 text-sm mb-3 flex items-center gap-2 relative z-10"><i class="fa-solid fa-gift text-yellow-500"></i> Redeem Code</h3>
                 <form action="/profile/redeem" method="post" class="relative z-10 flex gap-2">
                    <input name="key" placeholder="Paste VIP or Coin Code..." required class="bg-black/50 border border-zinc-700 text-white text-sm px-4 py-3 rounded-xl w-full outline-none focus:border-yellow-500 transition placeholder-gray-600 font-mono" />
                    <button class="bg-yellow-500 text-black font-bold px-5 rounded-xl hover:bg-yellow-400 transition shadow-lg"><i class="fa-solid fa-arrow-right"></i></button>
                 </form>
            </div>
            
            <div class="bg-[#1f1f1f] p-5 rounded-lg border border-blue-900/30 relative overflow-hidden">
     <h3 class="font-bold text-blue-400 text-sm mb-4 flex items-center gap-2">
        <i class="fa-solid fa-money-bill-transfer"></i> Manual Top-up (ငွေလွှဲရန်)
     </h3>
     
     <form action="/profile/topup" method="post" class="space-y-4">
        <div>
            <label class="block text-[10px] uppercase font-bold text-gray-500 mb-2">ငွေလွှဲရသည့် အကြောင်းအရင်း</label>
            <div class="grid grid-cols-2 gap-3">
                <label class="cursor-pointer relative">
                    <input type="radio" name="purpose" value="VIP Plan" class="peer sr-only" checked />
                    <div class="py-3 px-2 rounded-xl bg-black/50 border border-zinc-700 peer-checked:border-purple-500 peer-checked:bg-purple-900/20 transition text-center hover:bg-zinc-800">
                        <i class="fa-solid fa-crown text-purple-500 mb-1 block text-lg"></i>
                        <span class="font-bold text-[10px] text-gray-300 peer-checked:text-white">VIP Plan ဝယ်ရန်</span>
                    </div>
                </label>
                <label class="cursor-pointer relative">
                    <input type="radio" name="purpose" value="Coins (4K)" class="peer sr-only" />
                    <div class="py-3 px-2 rounded-xl bg-black/50 border border-zinc-700 peer-checked:border-yellow-500 peer-checked:bg-yellow-900/20 transition text-center hover:bg-zinc-800">
                        <i class="fa-solid fa-coins text-yellow-500 mb-1 block text-lg"></i>
                        <span class="font-bold text-[10px] text-gray-300 peer-checked:text-white">4K Pornsအတွက် ဖြည့်ရန်</span>
                    </div>
                </label>
            </div>
        </div>
        <div class="pt-2 space-y-3">
            {/* Payment Methods Grid */}
        <div class="grid grid-cols-1 gap-3 mb-3">
            {/* KPAY */}
            <label class="cursor-pointer relative group">
                <input type="radio" name="method" value="kpay" class="peer sr-only" checked />
                <div class="p-4 rounded-xl bg-black/50 border border-zinc-700 peer-checked:border-blue-500 peer-checked:bg-blue-900/10 transition hover:bg-zinc-800 group-active:scale-95 flex items-center gap-4">
                    <img src={optimizeImg("https://szenulkqzclwvudsgnfx.supabase.co/storage/v1/object/public/lugyiapp/img_1768294652912_e9ozhgi.png")} class="w-12 h-12 rounded-lg object-cover shadow-sm border border-white/10 flex-shrink-0" />
                    <div class="flex-grow">
                        <span class="font-bold text-xs text-gray-400 block mb-0.5">KBZ Pay</span>
                        <div class="flex items-center gap-2">
                            <span class="text-lg font-black text-white tracking-wider">09961650283</span>
                            <button type="button" onclick="event.preventDefault(); copyToClip('09961650283')" class="w-6 h-6 rounded bg-zinc-700 hover:bg-white hover:text-black text-xs transition flex items-center justify-center"><i class="fa-regular fa-copy"></i></button>
                        </div>
                        <span class="text-[10px] text-blue-400 font-bold uppercase mt-1 block">Thein Naing Win</span>
                    </div>
                    <div class="absolute top-4 right-4 text-blue-500 opacity-0 peer-checked:opacity-100 transition"><i class="fa-solid fa-circle-check text-xl"></i></div>
                </div>
            </label>

            {/* WAVE PAY */}
            <label class="cursor-pointer relative group">
                <input type="radio" name="method" value="wave" class="peer sr-only" />
                <div class="p-4 rounded-xl bg-black/50 border border-zinc-700 peer-checked:border-yellow-400 peer-checked:bg-yellow-900/10 transition hover:bg-zinc-800 group-active:scale-95 flex items-center gap-4">
                    <img src={optimizeImg("https://szenulkqzclwvudsgnfx.supabase.co/storage/v1/object/public/lugyiapp/img_1768294676568_j1jfvuu.jpg")} class="w-12 h-12 rounded-lg object-cover shadow-sm border border-white/10 flex-shrink-0" />
                    <div class="flex-grow">
                        <span class="font-bold text-xs text-gray-400 block mb-0.5">Wave Pay</span>
                        <div class="flex items-center gap-2">
                            <span class="text-lg font-black text-white tracking-wider">09688171999</span>
                            <button type="button" onclick="event.preventDefault(); copyToClip('09688171999')" class="w-6 h-6 rounded bg-zinc-700 hover:bg-white hover:text-black text-xs transition flex items-center justify-center"><i class="fa-regular fa-copy"></i></button>
                        </div>
                        <span class="text-[10px] text-yellow-500 font-bold uppercase mt-1 block">Thein Naing Win</span>
                    </div>
                    <div class="absolute top-4 right-4 text-yellow-400 opacity-0 peer-checked:opacity-100 transition"><i class="fa-solid fa-circle-check text-xl"></i></div>
                </div>
            </label>
        </div>
            <input type="number" name="amount" placeholder="Amount (လွှဲခဲ့သည့် ပမာဏ)" required class="input-box bg-black/50 text-sm focus:border-blue-500 transition placeholder-gray-600" />
            <input name="transactionId" placeholder="Transaction ID (ငွေလွှဲပြေစာနံပါတ် နောက်ဆုံး ၄ လုံး)" required class="input-box bg-black/50 text-sm focus:border-blue-500 transition placeholder-gray-600" />
            <button class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl transition text-xs shadow-lg shadow-blue-900/20 active:scale-95 flex items-center justify-center gap-2">
                <i class="fa-solid fa-paper-plane"></i> ငွေလွှဲဖြတ်ပိုင်း တင်မည်
            </button>
        </div>
     </form>
</div>

            <div>
                <h3 class="font-bold text-white mb-4 flex items-center gap-2 text-sm uppercase tracking-wider text-gray-500"><i class="fa-solid fa-gem text-blue-500"></i> Gold Flix Plan</h3>
                <div class="space-y-3">
    {plans.map(p => (
        <div class={`relative p-5 rounded-2xl border-2 flex flex-col justify-between transition active:scale-95 shadow-lg
            ${p.popular 
                ? 'bg-gradient-to-br from-yellow-900/40 to-black border-yellow-500 shadow-yellow-900/20' 
                : 'bg-zinc-900 border-zinc-700 hover:border-zinc-600'
            }`}>
            {p.popular && (
                <div class="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-[10px] font-black px-3 py-1 rounded-full shadow-lg uppercase tracking-widest border border-white/20">
                    Best Value
                </div>
            )}
            <div class="text-center mb-3 mt-1">
                <h4 class={`font-bold text-xs uppercase mb-1 ${p.popular ? 'text-yellow-400' : 'text-gray-300'}`}>{p.name}</h4>
                <span class="text-white font-black text-2xl tracking-tight">{p.price}</span>
            </div>
            <div class="space-y-2 mb-4 px-2 bg-black/30 py-3 rounded-lg border border-white/5">
                {p.features.slice(0, 2).map(f => (
                    <div class="flex items-center gap-2 text-[11px] text-gray-400 justify-center">
                        <div class={`w-4 h-4 rounded-full flex items-center justify-center ${p.popular ? 'bg-yellow-500/20 text-yellow-500' : 'bg-green-500/20 text-green-500'}`}>
                            <i class="fa-solid fa-check text-[8px]"></i>
                        </div> 
                        {f}
                    </div>
                ))}
            </div>
            <a href="https://t.me/LuGyiandYoteshinMovies" target="_blank" 
               class={`block text-center py-3 rounded-xl font-bold text-xs transition shadow-lg
               ${p.popular 
                   ? 'bg-yellow-500 text-black hover:bg-yellow-400 hover:scale-105' 
                   : 'bg-zinc-800 text-white hover:bg-zinc-700 border border-zinc-600'
               }`}>
               Buy Now
            </a>
        </div>
    ))}
</div>
            </div>

            {purchasedMovies.length > 0 && (
                <div class="pt-4 border-t border-zinc-800">
                    <h3 class="font-bold text-green-400 mb-4 flex items-center gap-2 text-sm uppercase tracking-wider">
                        <i class="fa-solid fa-cart-arrow-down"></i> My Purchased 4K Porns ({purchasedMovies.length})
                    </h3>
                    <div class="max-h-[400px] overflow-y-auto custom-scroll pr-1">
                        <div class="grid grid-cols-2 gap-3 pb-2">
                            {purchasedMovies.map(m => (
                                <a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group relative border border-zinc-800/50">
                                    <div class="aspect-video relative overflow-hidden">
                                        <img src={optimizeImg(m.coverUrl || m.posterUrl, 300)} loading="lazy" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" />
                                        <div class="absolute top-1 right-1 bg-green-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded shadow">Owned</div>
                                    </div>
                                    <div class="p-2"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div>
                                </a>
                            ))}
                        </div>
                    </div>
                </div>
            )}
<a href="/change-password" class="flex items-center justify-center w-full gap-2 text-gray-300 font-bold text-xs py-3.5 rounded-xl border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 hover:text-white transition active:scale-95 shadow-sm mt-4"><i class="fa-solid fa-lock"></i> Change Password</a>

            <a href="/logout" class="flex items-center justify-center w-full gap-2 text-red-500 font-bold text-xs py-3.5 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500 hover:text-white transition active:scale-95 shadow-sm mt-4"><i class="fa-solid fa-arrow-right-from-bracket"></i> Sign Out</a>
        </div>
      </Layout>
    ); 
});

app.post("/profile/redeem", async (c) => { 
    const user = await getCurrentUser(c); 
    if (!user) return c.redirect("/login"); 
    const { key } = await c.req.parseBody(); 
    const keyData = await kv.get<VipKey>(["keys", String(key)]); 
    if (!keyData.value) return c.redirect("/profile?error=Invalid Key!"); 
    if (keyData.value.type === "coin") {
        user.coins = (user.coins || 0) + (keyData.value.value || 0);
        await kv.set(["users", user.username], user); 
        await kv.delete(["keys", String(key)]); 
        await logAdminAction("redeem_coin", `${user.username} redeemed ${keyData.value.value} Coins`);
        return c.redirect("/profile?success=Coins Added Successfully!"); 
    }
    const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date(); 
    currentExpiry.setDate(currentExpiry.getDate() + keyData.value.days); 
    user.expiryDate = currentExpiry.toISOString(); 
    await kv.set(["users", user.username], user); 
    await kv.delete(["keys", String(key)]); 
    await logAdminAction("redeem_vip", `${user.username} redeemed ${keyData.value.days} Days`);
    return c.redirect("/profile?success=VIP Activated Successfully!"); 
});

app.post("/profile/topup", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const body = await c.req.parseBody();
    
    // ZOD
    const parsed = TopupSchema.safeParse(body);
    if (!parsed.success) return c.redirect("/profile?error=" + parsed.error.issues[0].message);

    const { amount, method, transactionId, purpose } = body; 

    const topup: TopupRequest = {
        id: crypto.randomUUID(),
        username: user.username,
        amount: parseInt(String(amount)),
        method: String(method),
        transactionId: String(transactionId),
        status: "pending",
        timestamp: Date.now(),
        purpose: String(purpose || "VIP Plan")
    };
    await kv.set(["topups", topup.id], topup);
    return c.redirect("/profile?success=Top-up Submitted! Admin will verify soon.");
});

app.post("/profile/clear-notis", async (c) => {
    const user = await getCurrentUser(c);
    if(user) {
        user.notifications = [];
        await kv.set(["users", user.username], user);
    }
    return c.redirect("/profile");
});

app.get("/change-password", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const lang = getLang(c);
    return c.html(
        <Layout user={user} lang={lang} activeTab="me">
            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black p-4 overflow-hidden">
                <div class="w-full max-w-sm bg-[#1f1f1f] p-8 rounded-lg border border-zinc-800 shadow-xl">
                    <h1 class="text-xl font-bold text-white mb-6 flex items-center gap-2">
                        <i class="fa-solid fa-key text-yellow-500"></i> Change Password
                    </h1>
                    <form action="/change-password" method="post" class="space-y-4">
                        <div>
                            <label class="text-[10px] uppercase font-bold text-gray-500">Current Password</label>
                            <input type="password" name="oldPass" placeholder="******" required class="input-box bg-black border-zinc-700" />
                        </div>
                        <div>
                            <label class="text-[10px] uppercase font-bold text-gray-500">New Password</label>
                            <input type="password" name="newPass" placeholder="******" required class="input-box bg-black border-zinc-700" />
                        </div>
                        <button class="btn-primary w-full mt-2">Update Password</button>
                    </form>
                    <a href="/profile" class="block text-center text-xs text-gray-500 mt-4 hover:text-white">Cancel</a>
                </div>
            </div>
        </Layout>
    );
});

app.post("/change-password", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const { oldPass, newPass } = await c.req.parseBody();
    
    // Check Old Password
    const hashedOld = await hashPassword(String(oldPass));
    if (hashedOld !== user.passwordHash) {
        return c.redirect("/change-password?error=Old password incorrect");
    }
    
    // Check New Password Length
    if (String(newPass).length < 6) {
        return c.redirect("/change-password?error=Password must be at least 6 chars");
    }

    // Save New Password
    user.passwordHash = await hashPassword(String(newPass));
    await kv.set(["users", user.username], user);
    
    return c.redirect("/profile?success=Password Updated Successfully");
});

// 🔥 LOGOUT FIX (No Cache)
app.get("/logout", async (c) => {
    const authCookie = getCookie(c, "auth_session");
    if (authCookie) {
        const [username] = authCookie.split(":");
        const user = await getUser(username);
        if (user) {
            user.sessionId = ""; 
            await kv.set(["users", username], user);
        }
    }
    deleteCookie(c, "auth_session");
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.redirect("/?ref=" + Date.now());
});

app.get(ADMIN_ROUTE, (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action={ADMIN_ROUTE + "/login"} method="post" class="bg-[#1f1f1f] p-8 rounded-lg w-80 shadow-2xl border border-zinc-800"><h2 class="font-bold text-center mb-6 text-blue-500 text-xl">ADMIN ACCESS</h2><input type="password" name="password" placeholder="Enter Secure Key" class="input-box mb-4 text-center tracking-widest" /><button class="bg-blue-600 text-white w-full py-3 rounded-xl font-bold hover:bg-blue-500 transition shadow-lg shadow-blue-900/20">Unlock Dashboard</button></form></div></Layout>));

app.post(ADMIN_ROUTE + "/login", async (c) => { 
    const ip = getClientIp(c);
    // 🔥 ADMIN SECURITY: Brute Force Protection
    if (!await checkAdminRateLimit(ip)) return c.text("Too many failed attempts. Try again in 15 minutes.", 429);

    const { password } = await c.req.parseBody(); 
    if (password === ADMIN_PASS) { 
        const sessionId = crypto.randomUUID();
        await kv.set(["admin_sessions", sessionId], "active", { expireIn: ADMIN_SESSION_EXPIRE });
        setCookie(c, "admin_session_id", sessionId, { path: "/", httpOnly: true, secure: true, sameSite: "Strict" }); 
        await logAdminAction("login", "Admin Logged In");
        return c.redirect(ADMIN_ROUTE + "/dashboard"); 
    } 
    
    await recordAdminFail(ip);
    return c.redirect(ADMIN_ROUTE); 
});

app.get(ADMIN_ROUTE + "/dashboard", adminGuard, async (c) => { 
    c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    c.header('Expires', '-1');
    const adminQuery = c.req.query("q") || "";
    const limit = 50;
    const cursor = c.req.query("cursor"); 

    let movies = [];
    let nextCursor = ""; 

    if (adminQuery) {
        movies = await searchMoviesDB(adminQuery); // This now includes soft-deleted logic check inside searchMoviesDB if you want, but admin usually wants to see everything.
        // Let's modify searchMoviesDB slightly or just filter here. 
        // Current implementation of searchMoviesDB filters out deleted. 
        // For admin, we might want to see them, but for simplicity let's stick to active ones in search.
    } else {
        const iter = kv.list<MovieSummary>({ prefix: ["idx_time"] }, { reverse: true, limit: limit, cursor: cursor });
        for await (const res of iter) {
            const fullMovie = await getMovie(res.value.id);
            if(fullMovie) movies.push(fullMovie);
        }
        if (movies.length === limit) {
             nextCursor = iter.cursor; 
        }
    }

    movies.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    const iterDrafts = kv.list<Movie>({ prefix: ["drafts"] });
    const drafts = []; for await (const res of iterDrafts) drafts.push(res.value);
    const keys = await getKeys(); 
    const requests = await getRequests(); 
    const topups = await getTopups();
    const logs = await getLogs();
    const config = await getConfig(); 
    const iterUsers = kv.list<User>({ prefix: ["users"] });
    const userList = []; for await (const res of iterUsers) userList.push(res.value);
    const totalUsers = userList.length;
    const editId = c.req.query("edit"); 
    const editMovie = editId ? movies.find(m => m.id === editId) : null; 
    
    const epString = editMovie?.episodes?.map(e => 
        e.season ? `${e.season} | ${e.name} | ${e.url}` : `${e.name} | ${e.url}`
    ).join('\n') || "";
    const vipDate = config.globalVipExpiry ? new Date(config.globalVipExpiry).toLocaleDateString() : "Inactive";
    const catCounts: any = {};
    movies.forEach(m => { if(!m.isDeleted) catCounts[m.category] = (catCounts[m.category] || 0) + 1; });
    
    return c.html(
        <Layout title="Admin" isAdmin={true}>
            <div class="p-4 bg-black min-h-screen font-sans text-sm">
                <div class="flex justify-between items-center mb-6 bg-[#111] p-4 rounded-xl border border-zinc-800 shadow-sm"><h1 class="font-bold text-blue-500 text-lg flex items-center gap-2"><i class="fa-solid fa-shield-cat"></i> Dashboard</h1><div class="flex gap-2"><a href="/admin/backup" class="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-lg text-xs border border-zinc-700 font-bold"><i class="fa-solid fa-download"></i> Backup</a><form action="/admin/restore" method="post" enctype="multipart/form-data" class="inline"><label class="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-lg text-xs border border-zinc-700 cursor-pointer font-bold"><i class="fa-solid fa-upload"></i> Restore<input type="file" name="file" class="hidden" onchange="this.form.submit()" /></label></form></div></div>
                <div class="flex gap-2 mb-6 overflow-x-auto pb-2 scrollbar-hide">
                    <button id="btn-stats" onclick="openTab('stats')" class="tab-btn active px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Analytics</button>
                    <button id="btn-movies" onclick="openTab('movies')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Movies</button>
                    <button id="btn-drafts" onclick="openTab('drafts')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800 flex items-center gap-2">Drafts <span class="bg-yellow-500 text-black px-1.5 rounded-full text-[9px]">{drafts.length}</span></button>
                    <button id="btn-keys" onclick="openTab('keys')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">VIP/Coins</button>
                    <button id="btn-topups" onclick="openTab('topups')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800 flex items-center gap-2">Top-ups <span class="bg-blue-500 text-white px-1.5 rounded-full text-[9px]">{topups.filter(t=>t.status==='pending').length}</span></button>
                    <button id="btn-users" onclick="openTab('users')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Users</button>
                    <button id="btn-requests" onclick="openTab('requests')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Requests</button>
                    <button id="btn-logs" onclick="openTab('logs')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Logs</button>
                    <button id="btn-config" onclick="openTab('config')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Config</button>
                </div>

                <div id="tab-stats" class="tab-content active">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div class="bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl">
                            <h2 class="text-white font-bold mb-4">Content Distribution</h2>
                            <canvas id="contentChart"></canvas>
                        </div>
                        <div class="bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl flex flex-col justify-center items-center">
                            <h2 class="text-white font-bold mb-4">Quick Stats</h2>
                            <div class="grid grid-cols-2 gap-6 w-full text-center">
                                <div class="bg-black p-4 rounded-xl border border-zinc-800"><p class="text-3xl font-black text-white">{totalUsers}</p><p class="text-xs text-gray-500 uppercase">Users</p></div>
                                <div class="bg-black p-4 rounded-xl border border-zinc-800"><p class="text-3xl font-black text-yellow-500">{movies.filter(m=>!m.isDeleted).length}</p><p class="text-xs text-gray-500 uppercase">Active Movies</p></div>
                                <div class="bg-black p-4 rounded-xl border border-zinc-800"><p class="text-3xl font-black text-blue-500">{topups.filter(t=>t.status==='approved').reduce((a,b)=>a+b.amount,0).toLocaleString()}</p><p class="text-xs text-gray-500 uppercase">Total Income (Ks)</p></div>
                                <div class="bg-black p-4 rounded-xl border border-zinc-800"><p class="text-3xl font-black text-green-500">{logs.length}</p><p class="text-xs text-gray-500 uppercase">Actions</p></div>
                            </div>
                        </div>
                    </div>
                    <script dangerouslySetInnerHTML={{__html: `
                        setTimeout(() => {
                            const ctx = document.getElementById('contentChart');
                            if(ctx) {
                                new Chart(ctx, {
                                    type: 'doughnut',
                                    data: {
                                        labels: ${JSON.stringify(Object.keys(catCounts))},
                                        datasets: [{
                                            data: ${JSON.stringify(Object.values(catCounts))},
                                            backgroundColor: ['#Eab308', '#3b82f6', '#ef4444', '#10b981', '#a855f7', '#f97316', '#ec4899', '#6366f1'],
                                            borderWidth: 0
                                        }]
                                    },
                                    options: { plugins: { legend: { position: 'right', labels: { color: 'white', font: { size: 10 } } } } }
                                });
                            }
                        }, 500);
                    `}} />
                </div>

                <div id="tab-movies" class="tab-content">
                    <div class="flex flex-col lg:grid lg:grid-cols-3 gap-6">
                        <div class={`lg:col-span-1 p-5 rounded-lg border h-fit lg:sticky lg:top-4 z-10 w-full max-w-[100vw] overflow-hidden shadow-xl transition-colors ${editMovie ? 'bg-blue-900/20 border-blue-500/50' : 'bg-[#111] border-zinc-800'}`}>
                            <div class="flex justify-between items-center mb-4 border-b border-white/10 pb-3"><div><h2 class={`font-bold text-sm ${editMovie ? "text-blue-400" : "text-yellow-500"}`}>{editMovie ? "✏️ EDITING MODE" : "✨ ADD NEW MOVIE"}</h2>{editMovie && <p class="text-[10px] text-gray-400 mt-1">Editing: <span class="text-white font-bold">{editMovie.title}</span></p>}</div>{editMovie && (<a href={ADMIN_ROUTE + "/dashboard"} class="bg-red-600 text-white text-[10px] font-bold px-3 py-1.5 rounded hover:bg-red-500 transition shadow"><i class="fa-solid fa-xmark"></i> Cancel</a>)}</div>
                            <form action="/admin/movie/save" method="post" class="space-y-4 text-sm w-full">
                                <input type="hidden" name="id" value={editMovie?.id || crypto.randomUUID()} /><input type="hidden" name="createdAt" value={editMovie?.createdAt || Date.now()} /><input type="hidden" name="mode" value={editMovie ? "update" : "create"} />
                                <div class="space-y-2"><input name="title" placeholder="Movie Title (Leave empty for 4K Auto)" value={editMovie?.title} class="input-box w-full bg-black border-zinc-700 focus:border-yellow-500" /><div class="flex gap-2 w-full"><select name="category" class="input-box flex-grow min-w-0 bg-black border-zinc-700">{["Movies","Series","4K Movies","Animation","Jav","All Uncensored", "Myanmar and Asian", "4K Porns"].map(o => <option selected={editMovie?.category===o}>{o}</option>)}</select><input name="year" value={editMovie?.year || "2025"} class="input-box w-24 text-center flex-shrink-0 bg-black border-zinc-700" /></div></div>
                                <input name="posterUrl" placeholder="Poster URL (Portrait)" value={editMovie?.posterUrl} required class="input-box w-full bg-black border-zinc-700" /><input name="coverUrl" placeholder="Cover URL (Landscape)" value={editMovie?.coverUrl} required class="input-box w-full border-yellow-500/30 bg-black" />
                                <div class="grid grid-cols-3 gap-2"><input name="fileSize" placeholder="File Size (e.g. 1.2 GB)" value={editMovie?.fileSize} class="input-box w-full bg-black border-zinc-700" /><input name="duration" placeholder="Duration (e.g. 25m)" value={editMovie?.duration} class="input-box w-full bg-black border-zinc-700" /><input type="number" name="price" placeholder="Price (Ks)" value={editMovie?.price || 0} class="input-box w-full bg-black border-yellow-500/50 text-yellow-500 font-bold" /></div>
                                <div class="p-3 bg-black/40 rounded-xl border border-zinc-800 space-y-2"><label class="text-[10px] text-gray-500 uppercase font-bold">Main Stream</label><select name="linkType" class="input-box text-xs w-full py-2 bg-[#111]"><option value="direct" selected={editMovie?.linkType==="direct"}>Direct Link (Auto-Resolve)</option><option value="embed" selected={editMovie?.linkType==="embed"}>Embed Code / Iframe</option></select><input name="streamUrl" placeholder="Stream URL (or Episode 1)" value={editMovie?.streamUrl} class="input-box w-full bg-[#111]" /></div>
                                <div class="bg-zinc-800 p-3 rounded-xl mb-4 border border-zinc-700"><div class="flex justify-between items-center mb-2"><label class="text-[10px] text-green-400 uppercase font-bold"><i class="fa-solid fa-wand-magic-sparkles"></i> Magic Tools</label><button type="button" onclick="clearEpisodes()" class="text-[10px] text-red-400 hover:text-white underline">Clear All</button></div><div class="flex gap-2 mb-3"><input id="gen-season" placeholder="Season (e.g. 1)" value="1" class="input-box text-[10px] bg-black border-zinc-600 h-8 w-1/4 text-center" /><input id="gen-start" type="number" placeholder="Start Ep (1)" value="1" class="input-box text-[10px] bg-black border-zinc-600 h-8 w-1/4 text-center" /></div><div class="border-t border-zinc-700 pt-2 mb-3"><p class="text-[9px] text-gray-400 mb-1">Tool 1: Sequence (Use *** or $$)</p><div class="flex gap-2"><input id="gen-url" placeholder="Link template..." class="input-box text-[10px] bg-black border-zinc-600 h-8 flex-grow" /><input id="gen-end" type="number" placeholder="End Ep" class="input-box text-[10px] bg-black border-zinc-600 h-8 w-16 text-center" /><button type="button" onclick="generateEpisodes()" class="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold px-3 rounded transition">Gen</button></div></div><div class="border-t border-zinc-700 pt-2"><p class="text-[9px] text-gray-400 mb-1">Tool 2: Bulk Extractor (Paste Database/Messy text)</p><textarea id="bulk-text" placeholder="Paste text here..." class="input-box text-[10px] bg-black border-zinc-600 h-16 w-full mb-2"></textarea><button type="button" onclick="extractLinks()" class="w-full bg-green-700 hover:bg-green-600 text-white text-xs font-bold py-2 rounded transition">Force Extract Links</button></div><script dangerouslySetInnerHTML={{__html: `function generateEpisodes() { const urlTpl = document.getElementById('gen-url').value; const season = document.getElementById('gen-season').value; const start = parseInt(document.getElementById('gen-start').value) || 1; const end = parseInt(document.getElementById('gen-end').value); const textarea = document.getElementsByName('episodeList')[0]; if (!urlTpl || !end) { alert("URL & End Number Required!"); return; } let placeholder = ""; if (urlTpl.includes("***")) placeholder = "***"; else if (urlTpl.includes("$$")) placeholder = "$$"; else if (urlTpl.includes("XX")) placeholder = "XX"; if (!placeholder) { alert("Use *** or $$ in URL!"); return; } let result = textarea.value ? textarea.value + "\\n" : ""; for (let i = start; i <= end; i++) { const numStr = i < 10 ? '0' + i : '' + i; const finalUrl = urlTpl.replace(placeholder, numStr); result += \`Season \${season} | Ep.\${i} | \${finalUrl}\\n\`; } textarea.value = result.trim(); } function extractLinks() { try { let rawText = document.getElementById('bulk-text').value; const season = document.getElementById('gen-season').value; let epCount = parseInt(document.getElementById('gen-start').value) || 1; const textarea = document.getElementsByName('episodeList')[0]; if (!rawText) { alert("Paste some text first!"); return; } rawText = rawText.replace(/[\\x00-\\x1F\\x7F]/g, "\\n"); const urlRegex = /(https?:\\/\\/[^\\n\\r]+?\\.(?:txt|mp4|mkv|m3u8|avi|mov|flv|webm|ts|mpg|mpeg))/gi; const foundLinks = rawText.match(urlRegex); if (!foundLinks || foundLinks.length === 0) { alert("No valid file links found!"); return; } let processedLinks = foundLinks.map(link => { try { return decodeURIComponent(link).trim(); } catch (e) { return link.trim(); } }); const uniqueLinks = [...new Set(processedLinks)]; uniqueLinks.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })); let result = textarea.value ? textarea.value + "\\n" : ""; let addedCount = 0; uniqueLinks.forEach(url => { let cleanUrl = url; if (cleanUrl.endsWith('.')) cleanUrl = cleanUrl.slice(0, -1); if (cleanUrl.length < 15) return; result += \`Season \${season} | Ep.\${epCount} | \${cleanUrl}\\n\`; epCount++; addedCount++; }); textarea.value = result.trim(); document.getElementById('bulk-text').value = ''; alert(\`Success! Extracted \${addedCount} links!\`); } catch (e) { alert("Error: " + e.message); } } function clearEpisodes() { if(confirm('Clear all episodes?')) { document.getElementsByName('episodeList')[0].value = ''; } }`}} /></div>
                                <div class="p-3 bg-black/40 rounded-xl border border-zinc-800"><label class="text-[10px] text-yellow-500 uppercase font-bold mb-1 block">Series Episodes</label><textarea name="episodeList" placeholder="S1 | Ep.1 | https://..." rows={3} class="input-box w-full font-mono text-xs whitespace-pre overflow-x-auto bg-[#111]">{epString}</textarea></div>
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2"><input name="downloadUrl" placeholder="DL Link 1" value={editMovie?.downloadUrl} class="input-box w-full text-xs border-green-900/30 focus:border-green-500 bg-black" /><input name="downloadUrl2" placeholder="DL Link 2" value={editMovie?.downloadUrl2} class="input-box w-full text-xs border-green-900/30 focus:border-green-500 bg-black" /></div>
                                <div class="p-3 bg-black/40 rounded-xl border border-zinc-800"><label class="text-[10px] text-gray-500 uppercase font-bold">Backup Server</label><input name="streamUrl2" placeholder="Stream URL 2" value={editMovie?.streamUrl2} class="input-box w-full mt-1 bg-[#111]" /></div>
                                <div class="relative"><div class="flex justify-between items-end mb-1"><label class="text-[10px] text-gray-500 uppercase font-bold">Synopsis / Description</label><button type="button" onclick="generateAIDesc()" class="text-[10px] bg-purple-600 hover:bg-purple-500 text-white px-2 py-1 rounded flex items-center gap-1 transition"><i class="fa-solid fa-robot"></i> Auto Gen (AI)</button></div><textarea id="desc-box" name="description" placeholder="Description..." class="input-box w-full h-24 bg-black border-zinc-700">{editMovie?.description}</textarea><div id="ai-loader" class="absolute inset-0 bg-black/80 hidden items-center justify-center rounded-lg z-10"><div class="text-purple-500 font-bold text-xs animate-pulse">Thinking...</div></div></div><script dangerouslySetInnerHTML={{__html: `async function generateAIDesc() { const title = document.getElementsByName('title')[0].value; const type = document.getElementsByName('category')[0].value; const year = document.getElementsByName('year')[0].value; const box = document.getElementById('desc-box'); const currentDesc = box.value; if(!title) { alert("Please enter Movie Title first!"); return; } const loader = document.getElementById('ai-loader'); loader.classList.remove('hidden'); loader.classList.add('flex'); try { const res = await fetch('/admin/api/generate-desc', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'title=' + encodeURIComponent(title) + '&type=' + encodeURIComponent(type) + '&year=' + encodeURIComponent(year) + '&currentDesc=' + encodeURIComponent(currentDesc) }); const data = await res.json(); if(data.error) { alert(data.error); } else { box.value = data.desc; } } catch(e) { alert("Error generating description"); } finally { loader.classList.add('hidden'); loader.classList.remove('flex'); } }`}} /><label class="flex items-center gap-2 p-3 rounded-xl bg-zinc-800/50 border border-zinc-700 cursor-pointer hover:bg-zinc-800 transition my-2"><input type="checkbox" name="updateTime" class="accent-yellow-500 w-4 h-4" /><span class="text-xs font-bold text-gray-300">Move to Top / ထိပ်ဆုံးသို့ရွှေ့မည်</span></label><div class="grid grid-cols-2 gap-3 pt-2"><button type="submit" name="saveType" value="draft" class="py-3 rounded-xl font-bold text-xs bg-zinc-800 text-gray-300 hover:bg-zinc-700 border border-zinc-700 transition"><i class="fa-solid fa-floppy-disk"></i> Save Draft</button><button type="submit" name="saveType" value="publish" class="py-3 rounded-xl font-bold text-xs bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-900/20 transition">{editMovie ? "Update Live" : "Publish Now"}</button></div>
                            </form>
                        </div>
                        <div class="lg:col-span-2 bg-[#111] p-5 rounded-lg border border-zinc-800 flex flex-col h-[600px] lg:h-[80vh] w-full max-w-[100vw] shadow-xl">
                            <div class="flex justify-between items-center mb-4">
                                <h2 class="font-bold text-sm text-green-500"><i class="fa-solid fa-circle text-[8px] animate-pulse"></i> Live Movies ({movies.length})</h2>
                                <input oninput="filterMovies(this.value)" placeholder="Search..." class="bg-black border border-zinc-700 rounded-lg px-4 py-2 text-xs w-48 outline-none" />
                            </div>
                            <details class="mb-4 p-3 bg-zinc-900 rounded-xl border border-zinc-700 cursor-pointer text-xs">
                                <summary class="font-bold text-yellow-500 flex items-center gap-2"><i class="fa-solid fa-file-import"></i> Bulk Import (JSON)</summary>
                                <form action="/admin/movie/bulk-import" method="post" class="mt-3">
                                    <textarea name="json" placeholder='[{"title":"Movie1","posterUrl":"...","streamUrl":"..."},{"title":"Movie2"}]' class="w-full h-32 bg-black border border-zinc-700 rounded-lg p-2 font-mono text-xs"></textarea>
                                    <button class="mt-2 w-full bg-yellow-600 text-black font-bold py-2 rounded hover:bg-yellow-500 transition">Import JSON</button>
                                </form>
                            </details>
                            
    {/* 🔥 ADMIN: UPDATED MOVIE LIST WITH SOFT DELETE UI */}
    <div class="space-y-3 flex-1 overflow-y-auto pr-1 custom-scroll">
        {movies.map(m => (
            <div class={`movie-item flex gap-4 p-3 rounded-xl items-center border transition ${m.isDeleted ? 'bg-red-900/20 border-red-500/50 opacity-70' : 'bg-black border-zinc-800/50 hover:border-zinc-600'}`} data-title={m.title}>
                <img src={optimizeImg(m.posterUrl, 100)} class="w-10 h-14 object-cover rounded-lg flex-shrink-0" />
                <div class="flex-grow min-w-0">
                    <div class="flex items-center gap-2">
                        <div class="font-bold text-sm truncate text-gray-200">{m.title}</div>
                        {m.isDeleted && <span class="text-[9px] bg-red-600 text-white px-2 rounded font-bold">TRASH</span>}
                    </div>
                    <div class="text-[10px] text-gray-500">{m.category} • {m.year}</div>
                </div>
                <div class="flex gap-2">
                    {!m.isDeleted ? (
                        <>
                            <a href={`${ADMIN_ROUTE}/dashboard?edit=${m.id}`} class="text-blue-500 text-xs border border-blue-500/20 bg-blue-500/10 px-3 py-1.5 rounded hover:bg-blue-500 hover:text-white transition">Edit</a>
                            <form action={`/admin/movie/soft-delete/${m.id}`} method="post" onsubmit="return confirm('Move to Trash?')">
                                <button class="text-red-500 text-xs border border-red-500/20 bg-red-500/10 px-3 py-1.5 rounded hover:bg-red-600 hover:text-white transition"><i class="fa-solid fa-trash"></i></button>
                            </form>
                        </>
                    ) : (
                        <>
                            <form action={`/admin/movie/restore/${m.id}`} method="post">
                                <button class="text-green-500 text-xs border border-green-500/20 bg-green-500/10 px-3 py-1.5 rounded hover:bg-green-600 hover:text-white transition"><i class="fa-solid fa-rotate-left"></i> Restore</button>
                            </form>
                            <form action={`/admin/movie/permanent-delete/${m.id}`} method="post" onsubmit="return confirm('PERMANENTLY DELETE? Cannot undo!')">
                                <button class="text-red-500 text-xs border border-red-500/20 bg-red-500/10 px-3 py-1.5 rounded hover:bg-red-600 hover:text-white transition">Delete Forever</button>
                            </form>
                        </>
                    )}
                </div>
            </div>
        ))}
    </div>

    {!adminQuery && (
        <div class="mt-2 pt-3 border-t border-zinc-800 flex justify-center gap-3 bg-[#111] sticky bottom-0">
            <a href={ADMIN_ROUTE + "/dashboard?tab=movies"} class={`px-4 py-2 bg-zinc-800 rounded-lg text-xs font-bold text-white border border-zinc-700 ${!c.req.query("cursor") ? 'opacity-50 pointer-events-none' : 'hover:bg-zinc-700'}`}>
                <i class="fa-solid fa-backward-step"></i> First
            </a>
            {nextCursor && (
                <a href={ADMIN_ROUTE + "/dashboard?tab=movies&cursor=" + nextCursor} class="px-4 py-2 bg-blue-600 rounded-lg text-xs font-bold text-white hover:bg-blue-500 shadow-lg">
                    Next Page <i class="fa-solid fa-forward-step"></i>
                </a>
            )}
        </div>
    )}

                        </div>
                    </div>
                </div>

                <div id="tab-drafts" class="tab-content">
    <div class="max-w-4xl mx-auto bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl min-h-[50vh]">
        <div class="flex justify-between items-center mb-6">
            <h2 class="font-bold text-yellow-500 text-lg flex items-center gap-2">
                <i class="fa-solid fa-file-pen"></i> Drafts ({drafts.length})
            </h2>
            {drafts.length > 0 && (
                <form action="/admin/drafts/publish-all" method="post" onsubmit="return confirm('Are you sure? This will publish ALL drafts to the live site.')">
                    <button class="bg-gradient-to-r from-green-600 to-green-500 text-white font-bold px-6 py-2 rounded-xl shadow-lg hover:scale-105 transition flex items-center gap-2">
                        <i class="fa-solid fa-rocket"></i> Publish All ({drafts.length})
                    </button>
                </form>
            )}
        </div>
        {drafts.length === 0 ? (
            <div class="text-center text-gray-500 py-20 border-2 border-dashed border-zinc-800 rounded-xl">
                <i class="fa-regular fa-folder-open text-4xl mb-3 opacity-50"></i>
                <p>No drafts saved yet.</p>
            </div>
        ) : (
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                {drafts.map(d => (
                    <div class="flex gap-4 p-4 rounded-xl bg-black border border-yellow-500/20 relative group">
                        <div class="absolute top-2 right-2 bg-yellow-500 text-black text-[9px] font-bold px-2 py-0.5 rounded uppercase">Draft</div>
                        <img src={d.posterUrl} class="w-16 h-24 object-cover rounded-lg shadow-lg" />
                        <div class="flex flex-col justify-between flex-grow">
                            <div>
                                <h3 class="font-bold text-white text-md truncate pr-8">{d.title}</h3>
                                <p class="text-xs text-gray-500">{d.category}</p>
                            </div>
                            <div class="flex gap-2 mt-3">
                                <a href={`${ADMIN_ROUTE}/dashboard?edit=${d.id}&type=draft`} class="flex-1 text-center bg-zinc-800 hover:bg-zinc-700 text-gray-300 text-xs font-bold py-2 rounded border border-zinc-700 transition">Edit</a>
                                <form action={`/admin/draft/publish/${d.id}`} method="post" class="flex-1">
                                    <button class="w-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 rounded transition">Publish</button>
                                </form>
                                <form action={`/admin/draft/delete/${d.id}`} method="post" onsubmit="return confirm('Delete draft?')">
                                    <button class="px-3 py-2 bg-red-900/20 text-red-500 border border-red-900/50 rounded hover:bg-red-600 hover:text-white transition">
                                        <i class="fa-solid fa-trash"></i>
                                    </button>
                                </form>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        )}
    </div>
</div>

                <div id="tab-keys" class="tab-content"><div class="max-w-2xl mx-auto space-y-4"><div class="bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl"><h2 class="font-bold mb-4 text-yellow-500 flex items-center gap-2"><i class="fa-solid fa-crown"></i> Generate VIP Key</h2><form action="/admin/key/create" method="post" class="flex gap-3"><input type="hidden" name="type" value="vip" /><input type="number" name="days" placeholder="Days (e.g. 30)" required class="input-box flex-grow bg-black border-zinc-700" /><button class="btn-primary w-32 shadow-lg">Gen VIP</button></form></div><div class="bg-[#111] p-6 rounded-lg border border-blue-900/30 shadow-xl"><h2 class="font-bold mb-4 text-blue-400 flex items-center gap-2"><i class="fa-solid fa-coins"></i> Generate Money Key</h2><form action="/admin/key/create" method="post" class="flex gap-3"><input type="hidden" name="type" value="coin" /><input type="number" name="value" placeholder="Amount (e.g. 1000)" required class="input-box flex-grow bg-black border-zinc-700 text-blue-400 font-bold" /><button class="bg-blue-600 text-white font-bold px-4 rounded-lg w-32 hover:bg-blue-500 transition">Gen Ks</button></form></div><div class="bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl"><h2 class="font-bold mb-4 text-gray-300">Active Keys</h2><div class="space-y-3 max-h-[500px] overflow-y-auto custom-scroll">{keys.map(k => (<div class="flex justify-between items-center p-3 bg-black rounded-xl border border-zinc-800/50"><div class="flex items-center gap-3"><span class={`font-mono font-bold text-lg tracking-wider ${k.type === 'coin' ? 'text-blue-400' : 'text-yellow-500'}`}>{k.code}</span><span class="text-[10px] bg-zinc-900 px-2 py-1 rounded text-gray-400 font-bold border border-zinc-800">{k.type === 'coin' ? `${k.value} Ks` : `${k.days} Days`}</span></div><div class="flex items-center gap-2"><button onclick={`copyToClip('${k.code}')`} class="text-xs bg-zinc-800 text-gray-400 px-3 py-1.5 rounded-lg hover:text-white transition"><i class="fa-solid fa-copy"></i></button><form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-xs bg-red-900/20 text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-600 hover:text-white transition"><i class="fa-solid fa-trash"></i></button></form></div></div>))}</div></div></div></div>

                <div id="tab-topups" class="tab-content">
    <div class="max-w-4xl mx-auto bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl">
        <div class="flex justify-between items-center mb-6">
            <h2 class="font-bold text-blue-400 flex items-center gap-2">
                <i class="fa-solid fa-money-bill-transfer"></i> Top-up Requests
            </h2>
            <form action="/admin/topup/clear-history" method="post" onsubmit="return confirm('Clear all Approved/Rejected history?')">
                <button class="bg-red-900/30 text-red-500 border border-red-500/30 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-red-600 hover:text-white transition">
                    <i class="fa-solid fa-trash-can"></i> Clear History
                </button>
            </form>
        </div>
        <div class="space-y-4">
            {topups.map(t => (
                <div class={`p-4 rounded-xl border flex justify-between items-center ${t.status === 'pending' ? 'bg-black border-blue-500/30' : 'bg-zinc-900 border-zinc-800 opacity-60'}`}>
                    <div>
                        <div class="flex items-center gap-2 mb-1">
                            <span class="font-bold text-white text-lg">{t.amount} Ks</span>
                            <span class="text-xs bg-zinc-800 px-2 py-0.5 rounded text-gray-400 uppercase">{t.method}</span>
                            <span class={`text-[9px] font-bold px-2 py-0.5 rounded uppercase ${t.purpose?.includes('Coin') ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/50' : 'bg-purple-500/20 text-purple-400 border border-purple-500/50'}`}>
                                {t.purpose || "VIP"}
                            </span>
                            {t.status === 'pending' && <span class="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded animate-pulse">PENDING</span>}
                        </div>
                        <p class="text-xs text-gray-400">User: <span class="text-white font-bold">{t.username}</span> | ID: <span class="font-mono text-yellow-500">{t.transactionId}</span></p>
                        <p class="text-[10px] text-gray-600">{new Date(t.timestamp).toLocaleString()}</p>
                    </div>
                    <div class="flex gap-2 items-center">
                        {t.status === 'pending' ? (
                            <>
                                <form action="/admin/topup/approve" method="post">
                                    <input type="hidden" name="id" value={t.id} />
                                    <button class="bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold">Approve</button>
                                </form>
                                <form action="/admin/topup/reject" method="post">
                                    <input type="hidden" name="id" value={t.id} />
                                    <button class="bg-red-900/30 hover:bg-red-600 text-red-500 hover:text-white border border-red-500/30 px-3 py-1.5 rounded-lg text-xs font-bold">Reject</button>
                                </form>
                            </>
                        ) : (
                            <form action={`/admin/topup/delete/${t.id}`} method="post" onsubmit="return confirm('Delete this record?')">
                                <button class="w-8 h-8 rounded-lg bg-zinc-800 text-gray-500 hover:text-red-500 hover:bg-zinc-700 transition flex items-center justify-center">
                                    <i class="fa-solid fa-xmark"></i>
                                </button>
                            </form>
                        )}
                    </div>
                </div>
            ))}
        </div>
    </div>
</div>

                <div id="tab-users" class="tab-content"><div class="max-w-4xl mx-auto"><div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6"><div class="bg-gradient-to-br from-blue-900/20 to-black border border-blue-500/20 p-6 rounded-lg flex items-center gap-5 shadow-lg"><div class="w-14 h-14 bg-blue-500/10 rounded-full flex items-center justify-center text-blue-400 text-3xl shadow-inner"><i class="fa-solid fa-users"></i></div><div><h3 class="text-xs uppercase text-blue-400 font-bold tracking-widest mb-1">Total Users</h3><p class="text-4xl font-black text-white tracking-tight">{totalUsers}</p></div></div><div class="bg-[#111] border border-zinc-800 rounded-lg overflow-hidden h-64 flex flex-col shadow-lg"><h3 class="bg-black/50 px-5 py-3 text-xs font-bold text-gray-400 border-b border-zinc-800 flex justify-between backdrop-blur-sm"><span>User Control</span><span>IP / Action</span></h3><div class="overflow-y-auto custom-scroll p-3 space-y-2">{userList.map(u => { const isVip = u.expiryDate && new Date(u.expiryDate) > new Date(); return (<div class="flex justify-between items-center bg-black/40 p-2.5 rounded-xl border border-zinc-800/30 hover:border-zinc-700 transition"><div class="flex items-center gap-3"><div class={`w-2.5 h-2.5 rounded-full shadow ${u.isBanned ? 'bg-red-600 shadow-red-500/50' : (isVip ? 'bg-green-500 shadow-green-500/50' : 'bg-gray-500')}`}></div><div><span class={`font-bold block text-xs ${u.isBanned ? 'text-red-500 line-through' : 'text-gray-300'}`}>{u.username}</span><span class="text-[9px] text-gray-600 font-mono">{u.lastLoginIp || u.ip || "Unknown"}</span></div></div><div class="flex items-center gap-2"><span class={isVip ? "text-yellow-500 font-black text-[9px] bg-yellow-500/10 px-1.5 py-0.5 rounded" : "hidden"}>VIP</span><form action="/admin/user/toggle-ban" method="post"><input type="hidden" name="username" value={u.username} /><button class={`px-3 py-1 rounded-lg text-[9px] font-bold border transition ${u.isBanned ? 'bg-green-500/10 text-green-500 border-green-500/50 hover:bg-green-500 hover:text-black' : 'bg-red-500/10 text-red-500 border-red-500/50 hover:bg-red-500 hover:text-white'}`}>{u.isBanned ? "UNBAN" : "BAN"}</button></form></div></div>) })}</div></div></div><div class="grid md:grid-cols-2 gap-6"><div class="bg-[#111] p-6 rounded-lg border border-yellow-500/20 shadow-xl h-fit relative overflow-hidden"><div class="absolute top-0 right-0 p-4 opacity-5"><i class="fa-solid fa-crown text-8xl text-yellow-500"></i></div><h2 class="font-bold mb-5 text-yellow-500 text-lg flex items-center gap-2 relative z-10"><i class="fa-solid fa-circle-plus"></i> Manual VIP Top-up</h2><form action="/admin/user/add-vip" method="post" class="space-y-4 relative z-10"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Username</label><input name="username" placeholder="Enter username..." required class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Duration (Days)</label><input type="number" name="days" placeholder="e.g. 30" required class="input-box bg-black border-zinc-700" /></div><button class="bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold w-full py-3 rounded-xl hover:brightness-110 transition shadow-lg shadow-yellow-500/20">Add VIP Time</button></form></div><div class="bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl h-fit relative overflow-hidden"><div class="absolute top-0 right-0 p-4 opacity-5"><i class="fa-solid fa-lock text-8xl text-blue-500"></i></div><h2 class="font-bold mb-5 text-blue-500 text-lg flex items-center gap-2 relative z-10"><i class="fa-solid fa-user-lock"></i> Reset Password</h2><form action="/admin/user/reset" method="post" class="space-y-4 relative z-10"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Username</label><input name="username" placeholder="Enter username..." required class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">New Password</label><input name="newpass" placeholder="Enter new password..." required class="input-box bg-black border-zinc-700" /></div><button class="bg-blue-600 text-white font-bold w-full py-3 rounded-xl hover:bg-blue-500 transition shadow-lg shadow-blue-500/20">Reset Password</button></form></div></div>
<div class="bg-[#111] p-6 rounded-lg border border-purple-500/30 shadow-xl h-fit relative overflow-hidden mt-6">
    <div class="absolute top-0 right-0 p-4 opacity-5"><i class="fa-solid fa-gift text-8xl text-purple-500"></i></div>
    <h2 class="font-bold mb-5 text-purple-500 text-lg flex items-center gap-2 relative z-10">
        <i class="fa-solid fa-hand-holding-heart"></i> Gift Days to ALL Users
    </h2>
    <p class="text-xs text-gray-500 mb-4 relative z-10">
        User အားလုံး (Free ရော VIP ရော) ကို ရက်ထပ်ပေါင်းပေးမည်။ (ဥပမာ - Server Error ဖြစ်လို့ လျော်ကြေးပေးခြင်း)
    </p>
    <form action="/admin/user/give-all" method="post" class="space-y-4 relative z-10" onsubmit="return confirm('သေချာပါသလား? User အကုန်လုံး ရက်တိုးသွားပါလိမ့်မည်။')">
        <div>
            <label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Add Days (ရက်အရေအတွက်)</label>
            <input type="number" name="days" placeholder="e.g. 2" required class="input-box bg-black border-zinc-700" />
        </div>
        <button class="bg-gradient-to-r from-purple-600 to-purple-500 text-white font-bold w-full py-3 rounded-xl hover:brightness-110 transition shadow-lg shadow-purple-500/20">
            Add Days to Everyone
        </button>
    </form>
</div>
</div></div>

                <div id="tab-requests" class="tab-content"><div class="max-w-3xl mx-auto bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl"><h2 class="font-bold mb-6 text-pink-500 flex items-center gap-2"><i class="fa-solid fa-clapperboard"></i> Movie Requests ({requests.length})</h2><div class="space-y-3">{requests.map(r => (<div class="bg-black p-4 rounded-xl flex justify-between items-center border border-zinc-800/50 hover:border-zinc-700 transition"><div><h3 class="font-bold text-lg text-white">{r.movieName}</h3><p class="text-xs text-gray-500 mt-1">Requested by <span class="text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded font-bold">{r.username}</span> • {new Date(r.timestamp).toLocaleDateString()}</p></div><form action={`/admin/request/delete/${r.id}`} method="post"><button class="text-red-500 hover:text-red-400 p-2 transition bg-red-500/10 rounded-lg hover:bg-red-500 hover:text-white"><i class="fa-solid fa-check"></i> Done</button></form></div>))}</div></div></div>
                
                <div id="tab-logs" class="tab-content">
                    <div class="max-w-4xl mx-auto bg-[#111] p-6 rounded-lg border border-zinc-800 shadow-xl">
                        <h2 class="font-bold mb-4 text-gray-300">System Logs</h2>
                        <div class="space-y-2 h-[500px] overflow-y-auto custom-scroll p-2 bg-black rounded-xl">
                            {logs.map(l => (
                                <div class="text-xs font-mono border-b border-zinc-800 pb-2 mb-2">
                                    <span class="text-green-500">[{new Date(l.timestamp).toLocaleString()}]</span> <span class="text-yellow-500 font-bold uppercase">{l.action}</span> - <span class="text-gray-300">{l.details}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div id="tab-config" class="tab-content"><div class="max-w-xl mx-auto bg-[#111] p-6 rounded-lg border border-zinc-800 space-y-8 shadow-xl"><div class="bg-red-900/10 border border-red-500/30 p-4 rounded-xl flex justify-between items-center"><div><h3 class="font-bold text-red-500 flex items-center gap-2"><i class="fa-solid fa-screwdriver-wrench"></i> Maintenance Mode</h3><p class="text-[10px] text-gray-400">Turn ON to hide website from users.</p></div><form action="/admin/config/maintenance" method="post"><input type="hidden" name="status" value={config.maintenanceMode ? "off" : "on"} /><button class={`px-4 py-2 rounded-lg font-bold text-xs transition ${config.maintenanceMode ? 'bg-red-600 text-white animate-pulse' : 'bg-zinc-800 text-gray-400'}`}>{config.maintenanceMode ? "🔴 ON (Hidden)" : "⚪️ OFF (Visible)"}</button></form></div><div><h2 class="font-bold mb-4 text-gray-300 flex items-center gap-2"><i class="fa-solid fa-bullhorn"></i> Announcement</h2><form action="/admin/config" method="post" class="space-y-4"><div><input name="text" placeholder="Enter message..." value={config.announcement} class="input-box bg-black border-zinc-700" /></div><label class="flex items-center gap-3 p-4 bg-black rounded-xl border border-zinc-800 cursor-pointer hover:border-zinc-600 transition"><input type="checkbox" name="show" checked={config.showAnnouncement} class="accent-yellow-500 w-5 h-5" /><span class="font-bold text-sm text-gray-300">Show Announcement Bar</span></label><button class="btn-primary w-full shadow-lg">Save Changes</button></form></div>
<div class="border-t border-zinc-800 pt-8">
    <h2 class="font-bold mb-4 text-blue-400 flex items-center gap-2">
        <i class="fa-solid fa-panorama"></i> Home Main Banner
    </h2>
    <p class="text-xs text-gray-500 mb-4">
        "ON" လုပ်ထားလျှင် Auto Slider ပျောက်ပြီး ဒီပုံကိုပဲ ပြပါမည်။ (ကြော်ငြာအတွက်)
    </p>
    <form action="/admin/config/banner" method="post" class="space-y-4">
        <div>
            <label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Banner Image URL</label>
            <input name="bannerImage" placeholder="https://..." value={config.customBannerImage || ""} class="input-box bg-black border-zinc-700" />
        </div>
        <div>
            <label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Link URL (Optional)</label>
            <input name="bannerLink" placeholder="Click နှိပ်ရင် ရောက်မည့် Link..." value={config.customBannerLink || ""} class="input-box bg-black border-zinc-700" />
        </div>
        <label class="flex items-center gap-3 p-4 bg-black rounded-xl border border-zinc-800 cursor-pointer hover:border-zinc-600 transition">
            <input type="checkbox" name="showBanner" checked={config.showCustomBanner} class="accent-blue-500 w-5 h-5" />
            <span class="font-bold text-sm text-gray-300">Show Custom Banner (Hide Movie Slider)</span>
        </label>
        <button class="btn-primary w-full shadow-lg bg-blue-600 hover:bg-blue-500">Save Banner Settings</button>
    </form>
</div><div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-4 text-yellow-500 flex items-center gap-2"><i class="fa-solid fa-image"></i> Popup Ads / Promotion</h2><form action="/admin/config/popup" method="post" class="space-y-4"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Image URL</label><input name="popupImage" placeholder="https://..." value={config.popupImage || ""} class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Message / Description (Optional)</label><textarea name="popupMessage" placeholder="Write your promotion text here..." class="input-box bg-black border-zinc-700 h-20 text-xs">{config.popupMessage || ""}</textarea></div><div class="grid grid-cols-2 gap-3"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Button Text</label><input name="popupBtnText" placeholder="e.g. Buy VIP Now" value={config.popupBtnText || "Check it out"} class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Link URL</label><input name="popupLink" placeholder="/profile" value={config.popupLink || "/profile"} class="input-box bg-black border-zinc-700" /></div></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Target Audience</label><select name="popupTarget" class="input-box bg-black border-zinc-700"><option value="all" selected={config.popupTarget !== "free"}>Show to EVERYONE (VIP + Free)</option><option value="free" selected={config.popupTarget === "free"}>Show to FREE Users Only (Hide for VIP)</option></select></div><label class="flex items-center gap-3 p-4 bg-black rounded-xl border border-zinc-800 cursor-pointer hover:border-zinc-600 transition"><input type="checkbox" name="showPopup" checked={config.showPopup} class="accent-yellow-500 w-5 h-5" /><span class="font-bold text-sm text-gray-300">Active Popup (Enable)</span></label><button class="btn-primary w-full shadow-lg">Save Popup Settings</button></form></div><div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-2 text-green-500 flex items-center gap-2"><i class="fa-solid fa-gift"></i> Global VIP Event</h2><p class="text-xs text-gray-500 mb-4">Give VIP access to ALL users until a specific date.</p><div class="bg-black p-4 rounded-xl border border-zinc-800 mb-4 flex justify-between items-center"><span class="text-xs font-bold text-gray-500 uppercase">Status</span> <span class="text-lg font-black text-white">{vipDate}</span></div><form action="/admin/config/vip" method="post" class="flex gap-3"><input type="number" name="days" placeholder="Days" required class="input-box bg-black border-zinc-700 w-24 text-center" /><button class="bg-green-600 text-white font-bold px-4 py-2 rounded-xl hover:bg-green-500 flex-grow shadow-lg shadow-green-900/20">Start Event</button></form><form action="/admin/config/vip-clear" method="post" class="mt-3 text-right"><button class="text-xs text-red-500 hover:text-red-400 font-bold bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20 hover:bg-red-500 hover:text-white transition">End Event</button></form></div><div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-2 text-purple-500 flex items-center gap-2"><i class="fa-solid fa-database"></i> Database</h2><p class="text-xs text-gray-500 mb-4">Re-sync search index if movies are missing.</p><form action="/admin/config/reindex" method="post"><button class="bg-purple-900/30 text-purple-400 border border-purple-500/30 font-bold px-6 py-3 rounded-xl hover:bg-purple-600 hover:text-white w-full transition">Re-Sync Database</button></form></div></div></div>

            </div>
        </Layout>
    );
});

app.post("/admin/config", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, announcement: body['text'], showAnnouncement: body['show'] === 'on' }); 
    clearConfigCache();
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Message Saved"); 
});
app.post("/admin/config/popup", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, popupImage: body['popupImage'], popupMessage: body['popupMessage'], popupBtnText: body['popupBtnText'], popupLink: body['popupLink'], popupTarget: body['popupTarget'], showPopup: body['showPopup'] === 'on' }); 
    clearConfigCache();
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Popup Settings Updated"); 
});
app.post("/admin/config/banner", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const current = await getConfig(); 
    await kv.set(["config"], { 
        ...current, 
        customBannerImage: body['bannerImage'], 
        customBannerLink: body['bannerLink'], 
        showCustomBanner: body['showBanner'] === 'on' 
    }); 
    clearConfigCache();
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Banner Updated"); 
});
app.post("/admin/config/maintenance", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, maintenanceMode: body['status'] === 'on' }); 
    clearConfigCache();
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Maintenance Mode Updated"); 
});
app.post("/admin/config/vip", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const days = parseInt(String(body['days'])); 
    const targetDate = Date.now() + (days * 86400000); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, globalVipExpiry: targetDate }); 
    clearConfigCache();
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Global VIP Event Started"); 
});
app.post("/admin/config/vip-clear", adminGuard, async (c) => { 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, globalVipExpiry: 0 }); 
    clearConfigCache();
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Global Event Cleared"); 
});
app.post("/admin/config/reindex", adminGuard, async (c) => { await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Database Optimized!"); });
app.post("/admin/request/delete/:id", adminGuard, async (c) => { await kv.delete(["requests", c.req.param("id")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=requests"); });
app.get("/admin/check-ai", adminGuard, async (c) => { const apiKey = Deno.env.get("GEMINI_API_KEY"); if (!apiKey) return c.json({ error: "API Key မရှိပါ" }); try { const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`); const data = await res.json(); return c.json(data); } catch (e) { return c.json({ error: e.message }); } });
app.post("/admin/api/generate-desc", adminGuard, async (c) => { const { title, type, year, currentDesc } = await c.req.parseBody(); const apiKey = Deno.env.get("GEMINI_API_KEY"); if (!apiKey) return c.json({ error: "Server Error: GEMINI_API_KEY not set." }); async function askGemini(promptText) { try { const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], safetySettings: [ { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" } ] }) }); const data = await response.json(); return data?.candidates?.[0]?.content?.parts?.[0]?.text || null; } catch (e) { return null; } } let prompt = `Role: Movie Channel Admin. Task: Rewrite the input text into engaging Burmese (Myanmar Unicode). Style: Use natural, spoken Burmese (e.g., "တယ်", "မယ်", "နော်"). Avoid formal "သည်/မည်". Tone: Exciting, Suspenseful. Input: "${currentDesc || title}" Output: ONLY Burmese text.`; let result = await askGemini(prompt); if (!result) { console.log("Blocked. Switching to Soft Romance Admin Style..."); prompt = `Role: Adult Romance Novelist / Channel Admin. Task: Rewrite the explicit plot below into a "Romantic/Erotic Drama" summary in Burmese. Rules: 1. Euphemism: Replace explicit/dirty words with soft, romantic metaphors. 2. Style: Maintain the "Channel Admin" storytelling style. Input: "${currentDesc || title}" Output: ONLY Burmese text.`; result = await askGemini(prompt); } if (!result) { prompt = `Translate to Burmese directly. Input: "${currentDesc || title}"`; result = await askGemini(prompt); } if (!result) return c.json({ error: "AI gave up. Text is too extreme." }); return c.json({ desc: result }); });

app.post("/admin/movie/bulk-import", adminGuard, async (c) => {
    try {
        const { json } = await c.req.parseBody();
        let inputData = String(json).trim();
        let movies = [];

        if (inputData.startsWith("http://") || inputData.startsWith("https://")) {
            try {
                const res = await fetch(inputData);
                movies = await res.json();
            } catch (err) {
                return c.redirect(ADMIN_ROUTE + "/dashboard?error=Failed to fetch JSON from URL");
            }
        } else {
            movies = JSON.parse(inputData);
        }

        if (!Array.isArray(movies)) throw new Error("Format must be an array []");

        // 🔥 UI မှာ အသစ်ဆုံးရောက်အောင် ပြောင်းပြန်လှန်မယ်
        movies.reverse();

        // 🔥 ID ထပ်မထွက်အောင် လုပ်ပေးမယ့် Function (Link ကိုယူပြီး ID ဖန်တီးမည်)
        async function createUniqueId(text) {
            const msgUint8 = new TextEncoder().encode(text);
            const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        }

        const BATCH_SIZE = 15; 
        let totalCount = 0;
        const baseTime = Date.now();

        for (let i = 0; i < movies.length; i += BATCH_SIZE) {
            const chunk = movies.slice(i, i + BATCH_SIZE);
            
            await Promise.all(chunk.map(async (m, idx) => {
                if (!m.title) return;

                // 🔥 KEY FIX: Link ရှိရင် Link ကို ID လုပ်မယ်။ Link မရှိမှ Title ကို ID လုပ်မယ်။
                // ဒါမှ နောက်တစ်ခါ ပြန်တင်ရင် ID တူနေပြီး ထပ်မသွားဘဲ Update ပဲ ဖြစ်သွားမယ်။
                const uniqueKey = m.link || m.title;
                const id = await createUniqueId(uniqueKey);
                
                // Check if movie already exists to preserve view counts or other data if needed
                // But for bulk import, usually overwrite is safer for fixing data.
                
                const originalLink = m.link || "";
                const proxyLink = originalLink ? "https://proxy.avotc.tk/" + originalLink : ""; 
                const image = m.image || ""; 
                const desc = m.info || "";  
                const duration = m.time || "";
                const itemTime = baseTime + i + idx; 

                const movieData: Movie = {
                    id: id, // 🔥 Random မဟုတ်တော့ဘူး
                    title: m.title,
                    posterUrl: image,
                    coverUrl: image, 
                    category: "Myanmar and Asian",
                    description: desc,
                    tags: m.title,
                    year: new Date().getFullYear().toString(),
                    duration: duration,
                    streamUrl: proxyLink,        
                    streamUrl2: originalLink,    
                    linkType: "direct", 
                    createdAt: itemTime,
                    isDeleted: false
                };

                await saveMovieDB(movieData);
            }));

            totalCount += chunk.length;
        }

        await logAdminAction("bulk_import", `Imported ${totalCount} movies (No Duplicates Mode)`);
        return c.redirect(ADMIN_ROUTE + "/dashboard?success=Imported " + totalCount + " Movies (Safe & Fast)");

    } catch (e) {
        console.error(e);
        return c.redirect(ADMIN_ROUTE + "/dashboard?error=Error: " + e.message);
    }
});

app.post("/admin/movie/save", adminGuard, async (c) => {
    const body = await c.req.parseBody();
    
    const movie: Movie = {
        id: String(body.id) || crypto.randomUUID(),
        title: cleanText(String(body.title)),
        posterUrl: String(body.posterUrl),
        coverUrl: String(body.coverUrl) || String(body.posterUrl),
        category: String(body.category) as any,
        description: cleanText(String(body.description || "")), 
        tags: String(body.title).toLowerCase(), 
        year: String(body.year || "2025"),
        streamUrl: String(body.streamUrl),
        streamUrl2: String(body.streamUrl2 || ""), 
        downloadUrl: String(body.downloadUrl || ""),
        downloadUrl2: String(body.downloadUrl2 || ""),
        linkType: String(body.linkType) as any,
        createdAt: Number(body.createdAt) || Date.now(),
        price: Number(body.price) || 0,
        isDeleted: false
    };
    
    const epText = String(body.episodeList || "");
    if(epText.trim()){
        movie.episodes = epText.split("\n").map(line => {
            if(!line.trim()) return null;
            const parts = line.split("|").map(s => s.trim());
            if (parts.length >= 3) {
                const url = parts.slice(2).join("|"); 
                return { season: cleanText(parts[0]), name: cleanText(parts[1]), url: url };
            } else if (parts.length === 2) {
                return { name: cleanText(parts[0]), url: parts[1] };
            }
            return null;
        }).filter(e => e) as Episode[];
    }

    const saveType = String(body.saveType); 

    if (saveType === "draft") {
        await kv.set(["drafts", movie.id], movie);
        return c.redirect(ADMIN_ROUTE + "/dashboard?tab=drafts&success=Saved to Drafts");
    } else {
        await saveMovieDB(movie);
        await kv.delete(["drafts", movie.id]);
        return c.redirect(ADMIN_ROUTE + "/dashboard?tab=movies&success=Published Successfully");
    }
});

app.post("/admin/drafts/publish-all", adminGuard, async (c) => {
    const iter = kv.list<Movie>({ prefix: ["drafts"] });
    let count = 0;
    for await (const res of iter) {
        await saveMovieDB(res.value); 
        await kv.delete(res.key);     
        count++;
    }
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=movies&success=Published " + count + " Drafts");
});

app.post("/admin/draft/publish/:id", adminGuard, async (c) => {
    const id = c.req.param("id");
    const res = await kv.get<Movie>(["drafts", id]);
    if (!res.value) return c.redirect(ADMIN_ROUTE + "/dashboard?tab=drafts&error=Draft Not Found");
    await saveMovieDB(res.value); 
    await kv.delete(["drafts", id]); 
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=movies&success=Draft Published Successfully");
});

app.post("/admin/draft/delete/:id", adminGuard, async (c) => {
    const id = c.req.param("id");
    await kv.delete(["drafts", id]);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=drafts&success=Draft Deleted");
});

// 🔥 SOFT DELETE ROUTES
app.post("/admin/movie/soft-delete/:id", adminGuard, async (c) => { 
    await softDeleteMovieDB(c.req.param("id"));
    return c.redirect(ADMIN_ROUTE + "/dashboard?success=Moved to Trash"); 
});

app.post("/admin/movie/restore/:id", adminGuard, async (c) => { 
    await restoreMovieDB(c.req.param("id"));
    return c.redirect(ADMIN_ROUTE + "/dashboard?success=Restored Successfully"); 
});

app.post("/admin/movie/permanent-delete/:id", adminGuard, async (c) => { 
    await permanentDeleteMovieDB(c.req.param("id"));
    return c.redirect(ADMIN_ROUTE + "/dashboard?success=Permanently Deleted"); 
});

app.post("/admin/key/create", adminGuard, async (c) => {
    const body = await c.req.parseBody();
    const keyData: VipKey = {
        code: crypto.randomUUID().slice(0, 8).toUpperCase(), 
        days: parseInt(String(body.days || "0")),            
        value: parseInt(String(body.value || "0")),          
        type: String(body.type) as "vip" | "coin"            
    };
    await kv.set(["keys", keyData.code], keyData);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys&success=Key Generated Successfully");
});

app.post("/admin/key/delete/:code", adminGuard, async (c) => {
    const code = c.req.param("code");
    await kv.delete(["keys", code]);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys&success=Key Deleted");
});

app.post("/admin/user/reset", adminGuard, async (c) => {
    const { username, newpass } = await c.req.parseBody();
    const user = await getUser(String(username));
    if (!user) return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found");
    user.passwordHash = await hashPassword(String(newpass));
    await kv.set(["users", user.username], user);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=Password Reset Successfully");
});

app.post("/admin/user/add-vip", adminGuard, async (c) => {
    const { username, days } = await c.req.parseBody();
    const user = await getUser(String(username));
    if (!user) return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found");
    const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date();
    currentExpiry.setDate(currentExpiry.getDate() + parseInt(String(days)));
    user.expiryDate = currentExpiry.toISOString();
    await kv.set(["users", user.username], user);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=Added VIP Days to " + username);
});

app.post("/admin/user/toggle-ban", adminGuard, async (c) => {
    const { username } = await c.req.parseBody();
    const user = await getUser(String(username));
    if(user) {
        user.isBanned = !user.isBanned;
        user.sessionId = ""; 
        await kv.set(["users", user.username], user);
    }
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users");
});

app.post("/admin/user/give-all", adminGuard, async (c) => {
    const { days } = await c.req.parseBody();
    const addDays = parseInt(String(days));
    const addTime = addDays * 24 * 60 * 60 * 1000;
    
    const iter = kv.list<User>({ prefix: ["users"] });
    let count = 0;
    
    for await (const res of iter) {
        const user = res.value;
        const now = Date.now();
        let currentExpiry = user.expiryDate ? new Date(user.expiryDate).getTime() : 0;
        if (currentExpiry < now) currentExpiry = now;
        const newExpiry = currentExpiry + addTime;
        user.expiryDate = new Date(newExpiry).toISOString();
        
        // Push Noti
        if(!user.notifications) user.notifications = [];
        user.notifications.push({
            id: crypto.randomUUID(),
            msg: `Gift: You received ${addDays} FREE VIP Days!`,
            date: Date.now(),
            read: false
        });

        await kv.set(res.key, user);
        count++;
    }
    
    await logAdminAction("gift_all", `Added ${addDays} days to ${count} users`);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=Added " + addDays + " Days to " + count + " Users!");
});

app.post("/admin/topup/approve", adminGuard, async (c) => {
    const { id } = await c.req.parseBody();
    const topupRes = await kv.get<TopupRequest>(["topups", String(id)]);
    const topup = topupRes.value;

    if (!topup || topup.status !== 'pending') {
        return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&error=Invalid Request");
    }

    const userRes = await kv.get<User>(["users", topup.username]);
    const user = userRes.value;

    if (user) {
        let actionMessage = "";
        if (topup.purpose === "VIP Plan") {
            const plans: Record<number, number> = { 700: 30, 1500: 90, 2200: 150, 5000: 365 };
            const daysToAdd = plans[topup.amount];

            if (daysToAdd) {
                const now = Date.now();
                let currentExpiry = user.expiryDate ? new Date(user.expiryDate).getTime() : 0;
                if (currentExpiry < now) currentExpiry = now;
                const newExpiry = currentExpiry + (daysToAdd * 24 * 60 * 60 * 1000);
                user.expiryDate = new Date(newExpiry).toISOString();
                actionMessage = `Approved VIP ${daysToAdd} Days for ${topup.username}`;
            } else {
                user.coins = (user.coins || 0) + topup.amount;
                actionMessage = `Approved ${topup.amount}Ks (Plan Mismatch) for ${topup.username}`;
            }
        } else {
            user.coins = (user.coins || 0) + topup.amount;
            actionMessage = `Approved ${topup.amount}Ks for ${topup.username}`;
        }

        // 🔥 NOTIFICATION PUSH
        if(!user.notifications) user.notifications = [];
        user.notifications.push({
            id: crypto.randomUUID(),
            msg: `Topup Approved: ${actionMessage}`,
            date: Date.now(),
            read: false
        });

        await kv.set(["users", user.username], user);
        topup.status = 'approved';
        await kv.set(["topups", String(id)], topup);
        await logAdminAction("approve_topup", actionMessage);

        return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&success=" + actionMessage);
    }
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&error=User Not Found");
});

app.post("/admin/topup/reject", adminGuard, async (c) => {
    const { id } = await c.req.parseBody();
    const topupRes = await kv.get<TopupRequest>(["topups", String(id)]);
    const topup = topupRes.value;
    if (topup) {
        topup.status = 'rejected';
        await kv.set(["topups", String(id)], topup);
        await logAdminAction("reject_topup", `Rejected ${topup.amount}Ks for ${topup.username}`);
        
        // Notify Rejection
        const user = await getUser(topup.username);
        if(user) {
            if(!user.notifications) user.notifications = [];
            user.notifications.push({ id: crypto.randomUUID(), msg: `Topup Rejected: ${topup.amount}Ks (Check Transaction ID)`, date: Date.now(), read: false });
            await kv.set(["users", user.username], user);
        }
    }
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&success=Top-up Rejected");
});

app.post("/admin/topup/delete/:id", adminGuard, async (c) => {
    const id = c.req.param("id");
    await kv.delete(["topups", id]);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&success=Record Deleted");
});

app.post("/admin/topup/clear-history", adminGuard, async (c) => {
    const iter = kv.list<TopupRequest>({ prefix: ["topups"] });
    let count = 0;
    for await (const res of iter) {
        if (res.value.status !== 'pending') {
            await kv.delete(res.key);
            count++;
        }
    }
    await logAdminAction("clear_topups", `Deleted ${count} old records`);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&success=Cleared " + count + " old records");
});

app.get("/admin/backup", adminGuard, async (c) => { 
    const stream = new ReadableStream({ 
        async start(controller) { 
            const encoder = new TextEncoder(); 
            const prefixes = [["config"],["movies"],["users"],["keys"],["drafts"],["requests"],["topups"],["banned_ips"],["counts"],["idx_time"],["idx_cat"]];
            for (const prefix of prefixes) {
                for await (const entry of kv.list({ prefix })) { 
                    const line = JSON.stringify({ key: entry.key, value: entry.value }) + "\n";
                    controller.enqueue(encoder.encode(line)); 
                }
            }
            controller.close(); 
        } 
    }); 
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": `attachment; filename="goldflix_full_backup_${Date.now()}.ndjson"`, "Cache-Control": "no-cache" } }); 
});

app.post("/admin/restore", adminGuard, async (c) => { 
    try { 
        const body = await c.req.parseBody(); 
        const file = body['file']; 
        if (file instanceof File) { 
            const text = await file.text(); 
            const lines = text.split("\n");
            let count = 0;
            for (const line of lines) {
                if (!line.trim()) continue; 
                try {
                    const { key, value } = JSON.parse(line); 
                    await kv.set(key, value); 
                    count++;
                } catch(e) {} 
            }
            await reIndexDatabase(); 
            return c.redirect(ADMIN_ROUTE + "/dashboard?success=Restored " + count + " items successfully"); 
        } 
    } catch(e) { 
        return c.redirect(ADMIN_ROUTE + "/dashboard?error=Restore Failed"); 
    } 
});

app.get("/admin/force-fix-all", adminGuard, async (c) => {
    const iter = kv.list({ prefix: ["movies"] });
    let count = 0;
    let updated = 0;
    
    const keysToCheck = ["idx_time", "idx_cat", "idx_search", "search_idx"];
    for (const k of keysToCheck) {
        const iterIdx = kv.list({ prefix: [k] });
        for await (const res of iterIdx) await kv.delete(res.key);
    }

    for await (const res of iter) {
        const m = res.value;
        let needsUpdate = false;
        if (!m.createdAt) { m.createdAt = Date.now() - (count * 1000); needsUpdate = true; }
        if (typeof m.id !== 'string') { m.id = String(m.id); needsUpdate = true; }
        
        await saveMovieDB(m); 
        count++;
        if(needsUpdate) updated++;
    }
    return c.html(`<div style="font-family:sans-serif; padding:20px; background:#111; color:white; text-align:center;"><h1 style="color:#22c55e;">✅ System Repair Complete!</h1><p>Scanned: <b>${count}</b> Movies</p><p>Repaired & Timestamped: <b>${updated}</b> Movies</p><hr style="border-color:#333;"/><a href="${ADMIN_ROUTE}/dashboard" style="display:inline-block; padding:10px 20px; background:blue; color:white; text-decoration:none; border-radius:5px;">Go to Dashboard</a></div>`);
});

app.get("/admin/fix-counts-now", adminGuard, async (c) => {
    const cats = ["Movies","Series","4K Movies","Animation","Jav","All Uncensored","Myanmar and Asian","4K Porns"];
    for(const cat of cats) await kv.delete(["counts", cat]);
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    const tally: Record<string, number> = {};
    let total = 0;
    for await (const res of iter) {
        if(!res.value.isDeleted) {
            const cat = res.value.category || "Movies";
            tally[cat] = (tally[cat] || 0) + 1;
            total++;
        }
    }
    let msg = `✅ Fixed Counts for ${total} Movies:\n\n`;
    for (const cat in tally) {
        await kv.set(["counts", cat], new Deno.KvU64(BigInt(tally[cat])));
        msg += `- ${cat}: ${tally[cat]}\n`;
    }
    return c.text(msg);
});
// 🔥 DELETE ALL MOVIES IN 'MYANMAR AND ASIAN'
app.get("/admin/danger/nuke-myanmar", adminGuard, async (c) => {
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    let count = 0;
    for await (const res of iter) {
        // Category တူရင် အကုန်ဖျက်မည်
        if (res.value.category === "Myanmar and Asian") {
            await kv.delete(res.key); // Main Data ဖျက်မည်
            // Index တွေပါ လိုက်ဖျက်ချင်ရင် deleteMovieDB(res.value.id) သုံးရမယ်၊ 
            // ဒါပေမဲ့ အမြန်လိုချင်ရင် ဒီလိုဖျက်ပြီး Re-index ပြန်လုပ်လိုက်ပါ။
            count++;
        }
    }
    return c.text(`Deleted ${count} movies from Myanmar and Asian. Now please go to Admin > Config > Re-Sync Database.`);
});
// 🔥 MYANMAR GHOST FIXER: Myanmar Category တစ်ခုတည်း သီးသန့်ရှင်းရန်
app.get("/admin/fix-myanmar-ghosts", adminGuard, async (c) => {
    const targetCat = "Myanmar and Asian";
    
    // 1. Myanmar Category ထဲက List အကုန်လိုက်စစ်မယ်
    const iter = kv.list({ prefix: ["idx_cat", targetCat] });
    let removedCount = 0;

    for await (const res of iter) {
        const summary = res.value; // List ထဲက အချက်အလက်
        const movieId = summary.id;

        // 2. Data အစစ် ရှိ/မရှိ လှမ်းစစ်မယ်
        const movieData = await kv.get(["movies", movieId]);

        // 3. Data အစစ်မရှိရင် (Null ဖြစ်နေရင်) ဒါ Ghost ဖြစ်လို့ Index တွေကို လိုက်ဖျက်မယ်
        if (!movieData.value) {
            // Category Index ဖျက်မယ်
            await kv.delete(res.key);

            // Latest Movies (Time) Index ဖျက်မယ်
            await kv.delete(["idx_time", summary.createdAt, movieId]);

            // Search Index တွေ လိုက်ဖျက်မယ်
            const words = tokenize(summary.title);
            for (const w of words) {
                await kv.delete(["idx_search", w, movieId]);
            }

            removedCount++;
        }
    }

    // 4. Cache ရှင်းမယ် (ချက်ချင်း အာနိသင်ပြအောင်)
    RAM_CACHE.latestMovies = { data: [], timestamp: 0 };
    
    return c.text(`Scanned '${targetCat}'. Found and removed ${removedCount} ghost images.`);
});

Deno.serve(app.fetch);
