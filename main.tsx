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
  console.error("❌ ERROR: You MUST set 'SECRET_SALT', 'ADMIN_PASSWORD' and 'ADMIN_ROUTE_PATH' in Environment Variables.");
}

const ADMIN_SESSION_EXPIRE = 24 * 60 * 60 * 1000; 

const i18n: any = {
    en: {
        home: "Home", saved: "Saved", request: "Request", login: "Login", me: "Me",
        search_ph: "Search movies...", featured: "Featured", play: "Play",
        see_all: "View All", views: "Views", dl_help: "​​Download လုပ်နည်း",
        server1: "Server 1", server2: "Server 2", share: "Share",
        unlock: "Unlock VIP", vip_only: "VIP Exclusive",
        access_denied: "Access Denied", ip_banned: "Your IP is restricted.",
        security_alert: "Security Check", wait: "Please Wait",
        dl_btn: "Download"
    },
    my: {
        home: "ပင်မ", saved: "သိမ်းဆည်း", request: "တောင်းဆို", login: "အကောင့်", me: "မိမိ",
        search_ph: "ဇာတ်ကားရှာရန်...", featured: "အထူးပြသ", play: "ကြည့်မည်",
        see_all: "အားလုံးကြည့်", views: "ကြိမ်", dl_help: "ဒေါင်းနည်းကြည့်ရန်",
        server1: "ဆာဗာ ၁", server2: "ဆာဗာ ၂", share: "မျှဝေမည်",
        unlock: "VIP ဖွင့်ရန်", vip_only: "VIP သီးသန့်",
        access_denied: "ဝင်ရောက်ခွင့် ပိတ်ပင်ထားသည်", ip_banned: "သင့် IP ကို ပိတ်ပင်ထားပါသည်။",
        security_alert: "လုံခြုံရေး သတိပေးချက်", wait: "ခေတ္တစောင့်ပါ",
        dl_btn: "ဒေါင်းလုပ်"
    }
};

const SECURITY_QUESTIONS = [
    "What is the name of your first pet?",
    "In what city were you born?",
    "What is your mother's maiden name?",
    "What is your favorite movie?",
    "What was the name of your first school?"
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
    // New Fields
    securityQ?: string;
    securityA?: string; // Hashed Answer
    watchHistory?: Record<string, number>; // movieId -> timestamp (seconds)
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

async function checkRateLimit(ip: string): Promise<boolean> {
  const key = ["rate_limit", ip];
  const res = await kv.get<{ count: number }>(key);
  const count = res.value?.count || 0;
  if (count >= 10) return false;
  await kv.set(key, { count: count + 1 }, { expireIn: 5 * 60 * 1000 });
  return true;
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

async function logAdminAction(action: string, details: string) {
    const log: AdminLog = { id: crypto.randomUUID(), action, details, timestamp: Date.now() };
    await kv.set(["admin_logs", log.timestamp, log.id], log, { expireIn: 30 * 24 * 60 * 60 * 1000 }); // 30 days retention
}

async function saveMovieDB(movie: Movie) {
    const summary: MovieSummary = { 
        id: movie.id, 
        title: movie.title, 
        posterUrl: movie.posterUrl, 
        coverUrl: movie.coverUrl, 
        category: movie.category, 
        createdAt: movie.createdAt 
    };
    const oldRes = await kv.get<Movie>(["movies", movie.id]);
    const old = oldRes.value;
    if (old) {
        if (old.category !== movie.category) {
            await kv.delete(["idx_cat", old.category, old.createdAt, old.id]);
            try {
                const oldKey = ["counts", old.category];
                const oldCnt = await kv.get(oldKey);
                if (oldCnt.value) {
                    let val = Number(oldCnt.value) - 1;
                    if (val < 0) val = 0;
                    await kv.set(oldKey, new Deno.KvU64(BigInt(val)));
                }
            } catch (e) {}
        }
        if (old.createdAt !== movie.createdAt) {
             await kv.delete(["idx_time", old.createdAt, old.id]);
             if (old.category === movie.category) {
                 await kv.delete(["idx_cat", old.category, old.createdAt, old.id]);
             }
        }
    }
    if (!old || old.category !== movie.category) {
        try {
            const newKey = ["counts", movie.category];
            const newCnt = await kv.get(newKey);
            let val = newCnt.value ? Number(newCnt.value) + 1 : 1;
            await kv.set(newKey, new Deno.KvU64(BigInt(val)));
        } catch (e) {}
    }
    await kv.set(["movies", movie.id], movie);
    await kv.set(["idx_time", movie.createdAt, movie.id], summary);
    await kv.set(["idx_cat", movie.category, movie.createdAt, movie.id], summary);
}

async function deleteMovieDB(id: string) {
    const res = await kv.get<Movie>(["movies", id]);
    if (!res.value) return;
    const m = res.value;
    await kv.delete(["movies", id]); 
    if (m.createdAt) {
        await kv.delete(["idx_time", m.createdAt, id]);
        await kv.delete(["idx_cat", m.category, m.createdAt, id]);
    }
    try {
        const countKey = ["counts", m.category];
        const countRes = await kv.get(countKey);
        if (countRes.value) {
            let newCount = Number(countRes.value) - 1;
            if (newCount < 0) newCount = 0;
            await kv.set(countKey, new Deno.KvU64(BigInt(newCount)));
        }
    } catch (e) { console.log("Counter error ignored."); }
}

async function getLatestMovies(limit: number = 20) {
    const iter = kv.list<MovieSummary>({ prefix: ["idx_time"] }, { reverse: true, limit });
    const movies = []; for await (const res of iter) movies.push(res.value); return movies;
}

async function getMoviesByCategory(cat: string, limit: number = 20) {
    const iter = kv.list<MovieSummary>({ prefix: ["idx_cat", cat] }, { reverse: true, limit });
    const movies = []; for await (const res of iter) movies.push(res.value); return movies;
}

async function searchMoviesDB(query: string) {
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    const results = [];
    const cleanText = (txt: string) => txt.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const cleanQuery = cleanText(query);
    if (!cleanQuery) return [];
    for await (const res of iter) {
        const m = res.value;
        const cleanTitle = cleanText(m.title);
        const cleanTags = m.tags ? cleanText(m.tags) : "";
        if (cleanTitle.includes(cleanQuery) || cleanTags.includes(cleanQuery)) {
            results.push(m);
            if (results.length >= 50) break; 
        }
    }
    return results;
}

async function reIndexDatabase() {
    await kv.delete(["counts", "Movies"]);
    await kv.delete(["counts", "Series"]);
    await kv.delete(["counts", "4K Movies"]);
    await kv.delete(["counts", "Animation"]);
    await kv.delete(["counts", "Jav"]);
    await kv.delete(["counts", "All Uncensored"]);
    await kv.delete(["counts", "Myanmar and Asian"]);
    await kv.delete(["counts", "4K Porns"]);

    const iter = kv.list<Movie>({ prefix: ["movies"] });
    const countMap: Record<string, number> = {};
    for await (const res of iter) {
        const m = res.value;
        await saveMovieDB(m); 
        const cat = m.category;
        countMap[cat] = (countMap[cat] || 0) + 1;
    }
    for (const cat in countMap) {
        await kv.set(["counts", cat], new Deno.KvU64(BigInt(countMap[cat])));
    }
}

async function getMovie(id: string) { const res = await kv.get<Movie>(["movies", id]); return res.value; }
async function getUser(username: string) { const res = await kv.get<User>(["users", username]); return res.value; }
async function getKeys() { const iter = kv.list<VipKey>({ prefix: ["keys"] }); const keys = []; for await (const res of iter) keys.push(res.value); return keys; }
async function getRequests() { const iter = kv.list<UserRequest>({ prefix: ["requests"] }); const reqs = []; for await (const res of iter) reqs.push(res.value); return reqs.sort((a,b)=>b.timestamp-a.timestamp); }
async function getTopups() { const iter = kv.list<TopupRequest>({ prefix: ["topups"] }); const reqs = []; for await (const res of iter) reqs.push(res.value); return reqs.sort((a,b)=>b.timestamp-a.timestamp); }
async function getLogs() { const iter = kv.list<AdminLog>({ prefix: ["admin_logs"] }, { reverse: true, limit: 100 }); const logs = []; for await (const res of iter) logs.push(res.value); return logs; }
// 🔥 CACHE VARIABLES
let configCache: AppConfig | null = null;
let lastConfigTime = 0;

// ဒီ Function လေး အသစ်ထည့်ပါ
function clearConfigCache() {
    configCache = null;
    lastConfigTime = 0;
}

async function getConfig() {
    if (configCache && (Date.now() - lastConfigTime < 60000)) {
        return configCache;
    }
    const res = await kv.get<AppConfig>(["config"]);
    const config = res.value || { announcement: "Welcome to Gold Flix!", showAnnouncement: true, globalVipExpiry: 0 };
    configCache = config;
    lastConfigTime = Date.now();
    return config;
}

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
  const protectJS = props.isAdmin ? "" : `
    document.addEventListener('contextmenu', event => {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return; 
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
      if (diff > 0) {
          daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24));
      }
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
      {/* Chart.js for Analytics */}
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <style>{`
        body { background-color: #050505; color: #fff; font-family: sans-serif; -webkit-tap-highlight-color: transparent; padding-bottom: 70px; }
        * { user-select: none; -webkit-user-select: none; }
        input, textarea { user-select: text !important; -webkit-user-select: text !important; -webkit-touch-callout: default !important; }
        ${protectCSS}
        .input-box { background: #1a1a1a; border: 1px solid #333; color: white; padding: 12px; border-radius: 8px; width: 100%; outline: none; transition: 0.3s; }
        .input-box:focus { border-color: #Eab308; box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.2); }
        .btn-primary { background: linear-gradient(to right, #Eab308, #d97706); color: black; font-weight: 800; padding: 12px 20px; border-radius: 8px; transition: 0.3s; cursor: pointer; border: none; }
        .btn-primary:active { transform: scale(0.95); opacity: 0.9; }
        .bottom-nav { position: fixed; bottom: 0; left: 0; width: 100%; background: #151515; border-top: 1px solid #333; box-shadow: 0 -5px 15px rgba(0,0,0,0.5); display: flex; justify-content: space-around; padding: 12px 0; z-index: 50; padding-bottom: max(12px, env(safe-area-inset-bottom)); }
        .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; color: #666; transition: 0.3s; text-align: center; }
        .nav-item i { font-size: 20px; margin-bottom: 4px; }
        .nav-item.active { color: #Eab308; }
        .top-header { position: fixed; top: 0; left: 0; width: 100%; background: rgba(0,0,0,0.9); backdrop-filter: blur(10px); z-index: 40; padding: 12px 16px; display: flex; justify-content: space-between; items-center; border-bottom: 1px solid #222; }
        .announcement-bar { position: fixed; top: 57px; left: 0; width: 100%; z-index: 39; background: #Eab308; color: black; font-size: 11px; font-weight: bold; padding: 6px 16px; display: flex; items-center; gap: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
        .custom-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scroll::-webkit-scrollbar-track { background: #000; }
        .custom-scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        #toast-box { position: fixed; top: 20px; right: 20px; z-index: 10000; display: flex; flex-direction: column; gap: 10px; }
        .toast { padding: 15px 20px; border-radius: 8px; color: white; font-weight: bold; display: flex; items-center; gap: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); animation: slideIn 0.5s ease; min-width: 250px; border: 1px solid #333; }
        .toast.error { background: #1a1a1a; border-left: 4px solid #ef4444; }
        .toast.success { background: #1a1a1a; border-left: 4px solid #Eab308; }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        #page-loader { position: fixed; inset: 0; background: #000; z-index: 9999; display: none; justify-content: center; align-items: center; }
        #page-loader.active { display: flex; }
        .spinner { width: 40px; height: 40px; border: 3px solid #333; border-top: 3px solid #Eab308; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .movie-card { transition: transform 0.3s ease; }
        .movie-card:active { transform: scale(0.95); }
        .float-tg { position: fixed; bottom: 80px; right: 20px; z-index: 50; background: #0088cc; color: white; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 4px 15px rgba(0,136,204,0.4); transition: transform 0.3s; text-decoration: none; }
        .float-tg:active { transform: scale(0.9); }
        .tab-btn.active { background: #Eab308; color: black; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 12px; padding-bottom: 20px; scroll-snap-type: x mandatory; padding-left: 10px; padding-right: 10px; scrollbar-width: none; -ms-overflow-style: none; }
        .h-scroll-section::-webkit-scrollbar { display: none; }
        .h-scroll-item { width: 110px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item.wide { width: 260px; }
        .slider-container { position: relative; width: 100%; aspect-ratio: 16/9; overflow: hidden; }
        .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease-in-out; pointer-events: none; }
        .slide.active { opacity: 1; pointer-events: auto; }
        .modal-enter { animation: modalPop 0.3s ease-out forwards; }
        @keyframes modalPop { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        img.img-fade { opacity: 0; transition: opacity 0.5s ease-in-out; }
        img.img-fade.loaded { opacity: 1; }
        .img-skeleton { background: linear-gradient(90deg, #1f1f1f 25%, #2a2a2a 50%, #1f1f1f 75%); background-size: 200% 100%; animation: skeleton-load 1.5s infinite; }
        @keyframes skeleton-load { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        /* 🔥 PLAYER MARQUEE (ဗီဒီယိုပေါ်က စာတန်းပြေး) */
        .player-marquee {
            position: absolute;
            bottom: 15%; 
            left: 0;
            width: 100%;
            overflow: hidden;
            pointer-events: none; 
            z-index: 20;
            opacity: 0.8;
        }
        .marquee-content {
            display: inline-block;
            white-space: nowrap;
            color: #Eab308; 
            font-weight: bold;
            font-size: 14px;
            text-shadow: 1px 1px 2px black; 
            animation: marquee-scroll 20s linear infinite; 
        }
        @keyframes marquee-scroll {
            0% { transform: translateX(100%); }
            100% { transform: translateX(-100%); }
        }
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
             window.showLoader = () => { loader.classList.add('active'); setTimeout(() => loader.classList.remove('active'), 5000); };
             window.hideLoader = () => loader.classList.remove('active');
             document.querySelectorAll('form').forEach(f => f.addEventListener('submit', window.showLoader));
             document.body.addEventListener('click', (e) => {
                const link = e.target.closest('a');
                if (link) {
                    const href = link.getAttribute('href');
                    const target = link.getAttribute('target');
                    if (href && href.startsWith('/') && !href.includes('#') && !href.includes('/dl/') && target !== '_blank' && !link.classList.contains('float-tg')) window.showLoader();
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
             if(slides.length>1){ let current=0; setInterval(()=>{ slides[current].classList.remove('active'); current=(current+1)%slides.length; slides[current].classList.add('active'); },4000); }
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
                 document.querySelectorAll('.season-tab-btn').forEach(btn => { btn.classList.remove('bg-yellow-500', 'text-black'); btn.classList.add('bg-zinc-800', 'text-gray-400'); });
                 if (!isAlreadyActive) { targetGrid.classList.remove('hidden'); if(targetBtn) { targetBtn.classList.remove('bg-zinc-800', 'text-gray-400'); targetBtn.classList.add('bg-yellow-500', 'text-black'); } }
             }
             
            // 🔥 FINAL CLEAN PLAYER (No Marquee + Supports 2-Step Links)
             window.loadPlayer = async function(content, type, movieId, title, poster, btnElement) {
                // 1. Button Design ပြင်မယ်
                document.querySelectorAll('.srv-btn').forEach(b => { 
                    b.classList.remove('bg-yellow-500', 'text-black', 'border-transparent'); 
                    b.classList.add('bg-zinc-800', 'text-white'); 
                });
                if (btnElement) { 
                    btnElement.classList.remove('bg-zinc-800', 'text-white'); 
                    btnElement.classList.add('bg-yellow-500', 'text-black', 'border-transparent'); 
                }

                const container = document.getElementById('video-player');
                const cover = document.getElementById('video-cover');
                const loader = document.getElementById('video-player-loader');

                // 2. Player အဟောင်းရှင်းပြီး Loading ပြမယ်
                if(container) container.innerHTML = ''; 
                if(cover) cover.style.display = 'none';
                if(container) container.style.display = 'block'; 
                if(loader) loader.style.display = 'flex';

                // 3. Link Logic (2-Step Link တွေအတွက် အရေးကြီးသည်)
                let finalUrl = content;
                if (type === 'direct') { 
                    // Browser ကိုယ်တိုင် Redirect လိုက်သွားအောင် Server Route ကို တန်းထည့်ပေးလိုက်တာပါ
                    finalUrl = '/stream/' + content;
                }

                // 4. Player HTML (စာတန်းပြေး မပါတော့ပါ)
                let htmlContent = '';
                if (type === 'embed' || (type !== 'direct' && finalUrl.includes('<iframe'))) { 
                    htmlContent = finalUrl.includes('<iframe') ? finalUrl : '<iframe src="'+finalUrl+'" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>'; 
                    setTimeout(() => { if(loader) loader.style.display = 'none'; }, 2000); 
                } else { 
                    // ရိုးရိုး Video Tag
                    htmlContent = '<video id="main-video" controls autoplay playsinline class="w-full h-full"><source src="'+finalUrl+'" type="video/mp4"></video>'; 
                }

                container.innerHTML = htmlContent; 

                // 5. Video Events
                const video = document.getElementById('main-video');
                if(video) { 
                    video.addEventListener('waiting', () => { if(loader) loader.style.display = 'flex'; }); 
                    video.addEventListener('playing', () => { if(loader) loader.style.display = 'none'; }); 
                    video.addEventListener('error', async () => { console.log("Stream Error"); });
                    try { await video.play(); } catch(e) {}
                }

                window.scrollTo({top:0, behavior:'smooth'});
             }
             window.filterMovies = function(val) { document.querySelectorAll('.movie-item').forEach(i => i.style.display=i.getAttribute('data-title').toLowerCase().includes(val.toLowerCase())?'flex':'none'); }
        });
        function showToast(msg, type) { const box=document.getElementById('toast-box'); const t=document.createElement('div'); t.className='toast '+type; t.innerHTML=(type==='error'?'<i class="fa-solid fa-circle-exclamation"></i>':'<i class="fa-solid fa-circle-check"></i>')+msg; box.appendChild(t); setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),500); },3000); }
        let page = 1; let isLoading = false; let hasMore = true;
        async function loadMoreMovies(category) { 
            if(isLoading || !hasMore) return; 
            isLoading = true; 
            const grid = document.getElementById('movie-grid');
            const skeletons = [];
            for(let i=0; i<6; i++) {
                const el = document.createElement('div');
                el.className = 'skeleton-card block bg-[#1f1f1f] rounded overflow-hidden aspect-[2/3]';
                el.innerHTML = '<div class="w-full h-full skeleton"></div>';
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
                    const badge = (m.category === "4K Movies" || m.category === "4K Porns") ? "4K" : "HD";
                    if(category === "All Uncensored" || category === "Myanmar and Asian" || category === "4K Porns") { 
                        el.className = 'movie-card block bg-[#1f1f1f] rounded overflow-hidden mb-4 group relative'; 
                        el.innerHTML = '<div class="relative aspect-video overflow-hidden img-skeleton"><img src="'+(m.coverUrl || m.posterUrl)+'" loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" /><div class="absolute top-2 right-2 bg-yellow-500 text-black text-[9px] font-bold px-1.5 py-0.5 rounded shadow z-10">'+badge+'</div></div><div class="p-3"><h3 class="text-sm font-bold truncate text-white">'+m.title+'</h3></div>';
                    } else { 
                        el.className = 'movie-card block bg-[#1f1f1f] rounded overflow-hidden group relative'; 
                        el.innerHTML = '<div class="relative aspect-[2/3] overflow-hidden img-skeleton"><img src="'+m.posterUrl+'" loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" /><div class="absolute top-1 right-1 bg-yellow-500 text-black text-[8px] font-bold px-1.5 py-0.5 rounded shadow z-10">'+badge+'</div></div><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">'+m.title+'</h3></div>';
                    } 
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
      <div id="dl-modal" class="fixed inset-0 z-[100] bg-black/80 hidden items-center justify-center backdrop-blur-sm">
           <div class="bg-[#1f1f1f] p-6 rounded-xl border border-zinc-700 w-11/12 max-w-sm text-center relative shadow-2xl modal-enter">
              <i class="fa-solid fa-cloud-arrow-down text-4xl text-yellow-500 mb-4"></i>
              <h3 id="dl-title" class="text-lg font-bold text-white mb-2 truncate">Movie Title</h3>
              <p class="text-gray-400 text-sm mb-6">File Size: <span id="dl-size" class="text-yellow-500 font-bold">--</span></p>
              <div class="flex gap-3">
                  <button onclick="closeDlModal()" class="flex-1 py-3 rounded bg-zinc-800 text-white font-bold hover:bg-zinc-700 transition">Cancel</button>
                  <a id="dl-confirm-btn" href="#" target="_blank" onclick="closeDlModal()" class="flex-1 py-3 rounded bg-yellow-600 text-black font-bold hover:bg-yellow-500 transition">Yes, Download</a>
              </div>
           </div>
      </div>
      <div id="help-modal" class="fixed inset-0 z-[100] bg-black/80 hidden items-center justify-center backdrop-blur-sm">
           <div class="bg-[#1f1f1f] p-6 rounded-xl border border-zinc-700 w-11/12 max-w-sm text-center relative shadow-2xl modal-enter">
              <i class="fa-solid fa-circle-question text-4xl text-yellow-500 mb-4"></i>
              <h3 class="text-lg font-bold text-white mb-4">ဒေါင်းလော့ လုပ်နည်း</h3>
              <div class="text-left text-xs text-gray-300 space-y-3 mb-6 bg-black/40 p-3 rounded-lg border border-zinc-800">
                   <p><strong class="text-yellow-500">နည်းလမ်း ၁ (Direct)</strong><br/> Movieမှာ <span class="text-white font-bold bg-zinc-700 px-1 rounded">DL</span> ခလုတ်များ ပါရှိပါက နှိပ်၍ တိုက်ရိုက်ဒေါင်းယူနိုင်ပါသည်။ မပါလျှင် နည်းလမ်း၂ကို သုံးပါ</p>
                   <hr class="border-zinc-700"/>
                   <p><strong class="text-yellow-500">နည်းလမ်း ၂ (Player)</strong><br/> ၁။ Video ကို ခနPlay လိုက်ပါ။<br/> ၂။Videoလာလျှင် ညာဘက်အောက်ထောင့်က အစက် ၃ စက် (<i class="fa-solid fa-ellipsis-vertical"></i>) ကိုနှိပ်ပါ။<br/> ၃။ <span class="text-white font-bold">'Download'</span> ကို ရွေးချယ်ပီးဒေါင်းနိူင်ပါသည်။</p>
              </div>
              <button onclick="closeHelpModal()" class="w-full py-3 rounded bg-yellow-600 text-black font-bold hover:bg-yellow-500 transition shadow-lg">OK, I Understand</button>
           </div>
      </div>
      {!props.hideNav && (
        <>
            <header class="top-header">
                <a href="/" class="text-xl font-black text-yellow-500 tracking-tighter italic">GOLD FLIX</a>
                <div class="flex items-center gap-3">
                    {active === 'home' && !props.isAdmin && (
                        <div class="px-2.5 py-1 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-[10px] font-bold text-yellow-500 tracking-wide shadow-[0_0_10px_rgba(234,179,8,0.1)]">P - {daysLeft} Day</div>
                    )}
                    {props.isAdmin ? (
                        <a href={ADMIN_ROUTE + "/dashboard"} class="text-xs font-bold bg-blue-600 text-white px-3 py-1.5 rounded-full shadow-lg hover:bg-blue-500 transition">ADMIN PANEL</a>
                    ) : (
                        <a href={l === 'en' ? '/lang/my' : '/lang/en'} class="text-xs font-bold text-gray-400 border border-zinc-700 px-2 py-1 rounded hover:text-white transition">{l === 'en' ? 'MY' : 'EN'}</a>
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
      {!props.isAdmin && (
         <a href="https://t.me/LuGyiandYoteshinMovies" target="_blank" class="float-tg"><i class="fa-brands fa-telegram"></i></a>
      )}
      {props.announcement && (
          <div class="announcement-bar"><i class="fa-solid fa-bullhorn animate-pulse"></i><marquee scrollamount="5">{props.announcement}</marquee></div>
      )}
      <main class={`flex-grow w-full ${props.announcement ? 'pt-[90px]' : 'pt-[60px]'}`}>
        {props.children}
      </main>
    </body>
  </html>
)};

// =======================
// 5. MAIN APP
// =======================
const app = new Hono();

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
            return c.html(<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Under Maintenance</title><script src="https://cdn.tailwindcss.com"></script><link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" /></head><body class="bg-black text-white h-screen flex flex-col items-center justify-center p-6 text-center"><i class="fa-solid fa-person-digging text-6xl text-yellow-500 mb-6 animate-bounce"></i><h1 class="text-3xl font-black text-white mb-2 uppercase tracking-widest">Website ပြုပြင်နေပါသည်</h1><p class="text-gray-400 max-w-md mx-auto leading-relaxed">Gold Flix ကို ပိုမိုကောင်းမွန်အောင် ပြုပြင်မွမ်းမံမှုများ ပြုလုပ်နေပါသည်။ <br/><span class="text-yellow-500 font-bold">ခေတ္တစောင့်ဆိုင်းပေးပါ။</span></p><div class="mt-8 p-4 bg-[#111] rounded-xl border border-zinc-800"><p class="text-xs text-gray-500 font-mono">Status: <span class="text-red-500 font-bold">System Upgrade In Progress...</span></p></div></body></html>);
        }
    }
    await next();
});

app.use("*", secureHeaders({
  xFrameOptions: "DENY", xContentTypeOptions: "nosniff", xXssProtection: "1; mode=block",
  contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"], fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"], imgSrc: ["'self'", "data:", "https:", "http:"], mediaSrc: ["'self'", "https:", "http:"], connectSrc: ["'self'", "https:", "http:"], frameSrc: ["'self'", "https:", "http:"], }
}));
app.use("*", compress());
app.use("*", csrf({ origin: (origin) => true })); 

app.notFound((c) => c.html(<Layout title="Not Found" hideNav={true}><div class="min-h-screen flex flex-col items-center justify-center text-center p-6 bg-black text-white"><i class="fa-solid fa-compass-slash text-6xl text-zinc-700 mb-4"></i><h1 class="text-4xl font-black text-yellow-500 mb-2">404</h1><p class="text-gray-400 mb-8 font-bold">ဒီလမ်းကြောင်းမှာ ဘာမှမရှိပါဘူး။</p><a href="/" class="btn-primary rounded-xl text-sm shadow-lg shadow-yellow-500/20"><i class="fa-solid fa-house mr-2"></i> Back Home</a></div></Layout>));
app.onError((err, c) => { console.error(err); return c.html(<Layout title="Error" hideNav={true}><div class="min-h-screen flex flex-col items-center justify-center text-center p-6 bg-black text-white"><i class="fa-solid fa-triangle-exclamation text-6xl text-red-600 mb-4 animate-pulse"></i><h1 class="text-2xl font-bold text-white mb-2">Something went wrong!</h1><p class="text-gray-500 text-sm mb-8">စနစ်ပိုင်းဆိုင်ရာ ချို့ယွင်းချက် ဖြစ်ပေါ်နေပါသည်။</p><a href="/" class="bg-zinc-800 border border-zinc-700 text-white px-6 py-3 rounded-xl text-sm font-bold hover:bg-zinc-700 transition">Try Again</a></div></Layout>); });

// =======================
// 6. ROUTES
// =======================
app.get("/manifest.json", (c) => c.json({ "name": "Gold Flix", "short_name": "GoldFlix", "start_url": "/", "display": "standalone", "background_color": "#000000", "theme_color": "#000000", "icons": [{ "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "192x192", "type": "image/png" }, { "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "512x512", "type": "image/png" }] }));
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
  
  // 🔥 FIX: အရင်ထည့်ထားတဲ့ public cache ကို ဖျက်ပြီး ဒါနဲ့အစားထိုးပါ
  // Browser ကို Page အဟောင်းမသုံးဘဲ အမြဲတမ်း Server ကို လှမ်းမေးခိုင်းတာပါ
  c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  c.header('Expires', '-1');
  c.header('Pragma', 'no-cache');
  
  const lang = getLang(c);
  // ... (ကျန်တဲ့ ကုဒ်များ အတူတူပါပဲ) ...
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
      getLatestMovies(5), // Slider
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
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home">
        {shouldShowPopup && (
          <div id="promo-popup" class="fixed inset-0 z-[200] bg-black/90 hidden items-center justify-center backdrop-blur-sm p-4">
              <div class="relative w-full max-w-sm bg-[#1f1f1f] rounded-2xl overflow-hidden shadow-2xl border border-yellow-500/30 modal-enter flex flex-col max-h-[85vh]">
                  <button onclick="closePopup(false)" class="absolute top-2 right-2 z-10 bg-black/50 text-white w-8 h-8 rounded-full flex items-center justify-center hover:bg-red-600 transition backdrop-blur-md"><i class="fa-solid fa-xmark"></i></button>
                  <div class="overflow-y-auto custom-scroll flex-grow"><a href={config.popupLink || "#"}><img src={config.popupImage} class="w-full h-auto object-cover" /></a><div class="p-5 bg-[#1f1f1f]">{config.popupMessage && (<p class="text-gray-300 text-sm mb-4 leading-relaxed whitespace-pre-wrap font-medium text-center">{config.popupMessage}</p>)}<a href={config.popupLink || "#"} class="block w-full bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold text-center py-3.5 rounded-xl shadow-lg hover:brightness-110 transition uppercase tracking-wider text-sm">{config.popupBtnText || "View Details"}</a><button onclick="closePopup(true)" class="block w-full text-center text-xs text-gray-500 font-bold mt-3 py-2 rounded-lg hover:bg-zinc-800 hover:text-gray-300 transition">Don't show again today</button></div></div>
              </div>
              <script dangerouslySetInnerHTML={{__html: `const popup = document.getElementById('promo-popup'); const today = new Date().toDateString(); const isHiddenToday = localStorage.getItem('popup_hidden_date') === today; const isHiddenSession = sessionStorage.getItem('popup_closed_session'); if (!isHiddenToday && !isHiddenSession) { setTimeout(() => { popup.classList.remove('hidden'); popup.classList.add('flex'); }, 2000); } window.closePopup = function(hideToday) { popup.classList.add('hidden'); popup.classList.remove('flex'); if(hideToday) { localStorage.setItem('popup_hidden_date', today); } else { sessionStorage.setItem('popup_closed_session', 'true'); } }`}} />
          </div>
        )}
        <div class="sticky top-[50px] z-30 bg-black/95 backdrop-blur-md px-4 py-3 border-b border-zinc-800 transition-all shadow-lg">
             <form action="/search" method="get" class="relative">
                 <button type="submit" class="absolute left-4 top-3.5 text-gray-500 hover:text-yellow-500 transition z-10"><i class="fa-solid fa-magnifying-glass"></i></button>
                 <input name="q" placeholder={t.search_ph} class="w-full bg-[#1a1a1a] border border-zinc-800 rounded-full py-3 pl-12 pr-4 text-sm text-white focus:border-yellow-500 outline-none transition shadow-sm" />
             </form>
        </div>
      {sliderMovies.length > 0 && (
          <div class="px-4 mb-6">
              <div class="slider-container rounded-2xl overflow-hidden shadow-2xl border border-zinc-800 relative z-0">
                  {sliderMovies.map((m, idx) => (
                      <div class={`slide ${idx === 0 ? 'active' : ''}`}>
                          <img src={m.coverUrl} class="w-full h-full object-cover" />
                          <div class="absolute bottom-6 left-4 right-4">
                              <h1 class="text-xl md:text-3xl font-black text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)] truncate leading-tight">{m.title}</h1>
                              <a href={`/movie/${m.id}`} class="mt-3 inline-flex items-center gap-2 bg-white/90 backdrop-blur text-black px-4 py-1.5 rounded-lg font-bold text-xs hover:scale-105 transition transform shadow-lg"><i class="fa-solid fa-play"></i> {t.play}</a>
                          </div>
                      </div>
                  ))}
              </div>
          </div>
      )}
      <div class="px-4 space-y-10 pb-8">
          {sections.map(section => { 
              if (section.data.length === 0) return null; 
              const cat = section.name; 
              const catMovies = section.data; 
              if(cat === "All Uncensored" || cat === "Myanmar and Asian" || cat === "4K Porns") { 
                  return (
                    <div>
                        <div class="flex justify-between items-end mb-4"><h2 class="text-lg font-bold text-white border-l-4 border-yellow-500 pl-3">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1 hover:text-white transition">{t.see_all} <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div>
                        <div class="h-scroll-section">
                            {catMovies.map(m => (
                                <a href={`/movie/${m.id}`} class="h-scroll-item wide block relative bg-[#1f1f1f] rounded-xl overflow-hidden active:scale-95 transition-transform movie-card group">
                                    <div class="aspect-video w-full relative overflow-hidden">
                                        <img src={m.coverUrl || m.posterUrl} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" />
                                        <div class="absolute top-2 right-2 bg-yellow-500 text-black text-[9px] font-bold px-1.5 py-0.5 rounded shadow z-10">{m.category === "4K Movies" || m.category === "4K Porns" ? "4K" : "HD"}</div>
                                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center"><i class="fa-solid fa-circle-play text-4xl text-white drop-shadow-lg"></i></div>
                                    </div>
                                    <div class="p-2"><h3 class="text-sm font-bold truncate text-white leading-tight">{m.title}</h3></div>
                                </a>
                            ))}
                        </div>
                    </div>
                  ) 
              } 
              return (
                <div>
                    <div class="flex justify-between items-end mb-4"><h2 class="text-lg font-bold text-white border-l-4 border-yellow-500 pl-3">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1 hover:text-white transition">{t.see_all} <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div>
                    <div class="h-scroll-section custom-scroll">
                        {catMovies.map(m => (
                            <a href={`/movie/${m.id}`} class="h-scroll-item block relative bg-[#1f1f1f] rounded-xl overflow-hidden w-28 flex-shrink-0 active:scale-95 transition-transform movie-card group">
                                <div class="aspect-[2/3] w-full relative overflow-hidden">
                                    <img src={m.posterUrl} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" />
                                    <div class="absolute top-1 right-1 bg-yellow-500 text-black text-[8px] font-bold px-1.5 py-0.5 rounded shadow">{m.category === "4K Movies" || m.category === "4K Porns" ? "4K" : "HD"}</div>
                                </div>
                                <div class="p-2"><h3 class="text-[11px] font-bold truncate text-white leading-tight">{m.title}</h3></div>
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
    if(!isValidUrl(entry.value as string)) return c.json({ error: "Unsafe URL detected" }, 403);
    return c.json({ url: entry.value }); 
});

app.get("/api/list", async (c) => { const cat = c.req.query("cat") || "Movies"; const page = parseInt(c.req.query("page") || "1"); const limit = 15; const start = (page - 1) * limit; const all = await getMoviesByCategory(cat, 300); const movies = all.slice(start, start + limit); return c.json({ movies }); });

app.get("/category/:cat", async (c) => { 
    const user = await getCurrentUser(c); 
    const cat = c.req.param("cat"); 
    const config = await getConfig(); 
    const movies = await getMoviesByCategory(cat, 15); 
    const isUncensored = cat === "All Uncensored" || cat === "Myanmar and Asian" || cat === "4K Porns"; 
    const lang = getLang(c);
    const countRes = await kv.get<Deno.KvU64>(["counts", cat]);
    const totalCount = countRes.value ? Number(countRes.value) : 0;
    
    return c.html(<Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home"><div class="sticky top-[50px] z-30 bg-black/95 backdrop-blur-md px-4 py-3 border-b border-zinc-800 transition-all shadow-lg">
             <form action="/search" method="get" class="relative">
                 <button type="submit" class="absolute left-4 top-3.5 text-gray-500 hover:text-yellow-500 transition z-10"><i class="fa-solid fa-magnifying-glass"></i></button>
                 <input name="q" placeholder={i18n[lang].search_ph} class="w-full bg-[#1a1a1a] border border-zinc-800 rounded-full py-3 pl-12 pr-4 text-sm text-white focus:border-yellow-500 outline-none transition shadow-sm" />
             </form>
        </div><div class="px-4 py-6"><div class="flex justify-between items-center mb-6"><h1 class="text-2xl font-bold text-white flex items-center gap-3"><a href="/" class="text-gray-400 hover:text-white"><i class="fa-solid fa-arrow-left"></i></a> {cat}</h1><span class="bg-yellow-500 text-black text-[10px] px-2 py-1 rounded font-bold tracking-wider">{totalCount}</span></div><div id="movie-grid" class={isUncensored ? "space-y-4" : "grid grid-cols-3 gap-3"}>
    {movies.map(m => (
        <a href={`/movie/${m.id}`} class={`block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group ${isUncensored ? 'mb-4' : ''}`}>
            <div class={`relative overflow-hidden ${isUncensored ? "aspect-video" : "aspect-[2/3]"}`}>
                <img src={isUncensored ? (m.coverUrl || m.posterUrl) : m.posterUrl} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" />
                <div class="absolute top-2 right-2 bg-yellow-500 text-black text-[9px] font-bold px-1.5 py-0.5 rounded shadow z-10">{m.category === "4K Movies" || m.category === "4K Porns" ? "4K" : "HD"}</div>
            </div>
            <div class={isUncensored ? "p-3" : "p-2"}><h3 class={isUncensored ? "text-sm font-bold truncate text-white" : "text-[11px] font-bold truncate text-white"}>{m.title}</h3></div>
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
        <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home">
            <div class="p-4">
                <div class="flex items-center gap-3 mb-6">
                    <a href="/" class="text-gray-400 hover:text-white"><i class="fa-solid fa-arrow-left"></i></a>
                    <form action="/search" method="get" class="flex-grow relative">
                        <button type="submit" class="absolute left-3 top-3 text-gray-500 hover:text-yellow-500 transition z-10"><i class="fa-solid fa-magnifying-glass"></i></button>
                        <input name="q" value={query} placeholder="Search..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-xl py-3 pl-10 pr-4 text-sm outline-none focus:border-yellow-500" />
                    </form>
                </div>
                <h2 class="text-sm text-gray-400 mb-4">Results for "{query}" ({results.length})</h2>
                <div class="grid grid-cols-3 gap-3">
                    {results.map(m => {
                        const isWide = m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns";
                        return (
                            <a href={`/movie/${m.id}`} class={`block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group ${isWide ? 'col-span-3' : ''}`}>
                                <div class={`${isWide ? "aspect-video" : "aspect-[2/3]"} relative overflow-hidden`}>
                                    <img src={isWide ? (m.coverUrl || m.posterUrl) : m.posterUrl} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" />
                                    {m.category === "All Uncensored" && <div class="absolute top-2 right-2 bg-red-600 text-white text-[9px] font-bold px-2 py-0.5 rounded">18+</div>}
                                </div>
                                <div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div>
                            </a>
                        )
                    })}
                </div>
            </div>
        </Layout>
    ); 
});

app.get("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const config = await getConfig(); const lang = getLang(c); return c.html(<Layout user={user} title="Request" announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="request"><div class="p-6 max-w-md mx-auto min-h-[70vh] flex flex-col justify-center"><h1 class="text-3xl font-black mb-2 text-yellow-500">Request Movie</h1><p class="text-gray-400 text-sm mb-8">Can't find what you're looking for? Let us know!</p><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name (e.g. Iron Man)" required class="input-box" /><button class="btn-primary w-full">Submit Request</button></form></div></Layout>); });
app.post("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const { movieName } = await c.req.parseBody(); const req: UserRequest = { id: crypto.randomUUID(), username: user.username, movieName: String(movieName), timestamp: Date.now() }; await kv.set(["requests", req.id], req); return c.redirect("/request?success=Request Submitted!"); });
app.post("/report", async (c) => { const user = await getCurrentUser(c); const { movieId, movieName } = await c.req.parseBody(); const reqId = crypto.randomUUID(); const reportData: UserRequest = { id: reqId, username: user ? user.username : "Guest", movieName: `[BROKEN LINK] ${movieName}`, timestamp: Date.now() }; await kv.set(["requests", reqId], reportData); return c.redirect(`/movie/${movieId}?success=Report Sent! Admin will fix it soon.`); });
app.get("/favorites", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const lang = getLang(c); const favs = []; if(user.favorites) { for(const id of user.favorites) { const m = await getMovie(id); if(m) favs.push(m); } } return c.html(<Layout user={user} title="Saved" lang={lang} activeTab="saved"><div class="p-4"><h1 class="text-2xl font-bold mb-6 flex items-center gap-2"><i class="fa-solid fa-heart text-red-600"></i> My Saved Movies</h1><div class="grid grid-cols-3 gap-3">{favs.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group"><div class="aspect-[2/3] relative overflow-hidden"><img src={m.posterUrl} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" /></div><div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div>{favs.length===0 && <p class="text-gray-500 text-center mt-10">No saved movies.</p>}</div></Layout>); });
app.post("/api/fav", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { movieId } = await c.req.parseBody(); const id = String(movieId); if (!user.favorites) user.favorites = []; if (user.favorites.includes(id)) user.favorites = user.favorites.filter(f => f !== id); else user.favorites.push(id); await kv.set(["users", user.username], user); return c.redirect(c.req.header("Referer") || "/"); });
app.get("/stream/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Link Expired or Invalid", 403); return c.redirect(entry.value as string); });
app.get("/dl/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Download Link Expired", 403); return c.redirect(entry.value as string); });

// 🔥 API Endpoint for Watch Progress
app.post("/api/watch-progress", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const { movieId, time } = await c.req.json();
    if (!user.watchHistory) user.watchHistory = {};
    user.watchHistory[String(movieId)] = Number(time);
    await kv.set(["users", user.username], user);
    return c.json({ success: true });
});

app.get("/api/watch-progress", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.json({ time: 0 });
    const movieId = c.req.query("movieId");
    if (!user.watchHistory || !user.watchHistory[String(movieId)]) return c.json({ time: 0 });
    return c.json({ time: user.watchHistory[String(movieId)] });
});

app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const lang = getLang(c);
    const t = i18n[lang];

    // Config Cache နှင့်အတူ Data ယူခြင်း
    const [movieRes, user, config] = await Promise.all([
        getMovie(id), 
        getCurrentUser(c), 
        getConfig() 
    ]);
    
    const movie = movieRes;
    if (!movie) return c.text("Not Found", 404);

    // Related Movies (Performance Optimized)
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

    const displayImage = movie.coverUrl || movie.posterUrl; 
    let initialStreamUrl = movie.streamUrl;
    let episodes = movie.episodes || [];
    if (movie.category === "Series" && episodes.length > 0) initialStreamUrl = episodes[0].url;
    
    const seasons: Record<string, Episode[]> = {};
    if(episodes) { episodes.forEach(ep => { if(ep.season) { if(!seasons[ep.season]) seasons[ep.season] = []; seasons[ep.season].push(ep); } }); }

    // 🔥 FIX: playbackToken2 အသစ်ထည့်လိုက်ပါသည်
    let playerUrl = "", secureDownloadUrl = "", secureDownloadUrl2 = "", playerUrl2 = "", playbackToken = "", playbackToken2 = "";

    if (canWatch) {
        // Server 1 Token
        const token = crypto.randomUUID(); 
        await kv.set(["stream_tokens", token], initialStreamUrl, { expireIn: 3600 * 3 }); 
        playerUrl = `/stream/${token}`; 
        playbackToken = token; 

        // Server 2 Token (Fix: playbackToken2 သိမ်းမည်)
        if (movie.streamUrl2) { 
            const token2 = crypto.randomUUID(); 
            await kv.set(["stream_tokens", token2], movie.streamUrl2, { expireIn: 3600 * 3 }); 
            playerUrl2 = `/stream/${token2}`; 
            playbackToken2 = token2; // <--- ဒီနေရာမှာ Token 2 ကို သီးသန့်မှတ်လိုက်ပါပြီ
        }

        // Download Tokens
        if (movie.downloadUrl) { const dlToken = crypto.randomUUID(); await kv.set(["stream_tokens", dlToken], movie.downloadUrl, { expireIn: 3600 * 3 }); secureDownloadUrl = `/dl/${dlToken}`; }
        if (movie.downloadUrl2) { const dlToken2 = crypto.randomUUID(); await kv.set(["stream_tokens", dlToken2], movie.downloadUrl2, { expireIn: 3600 * 3 }); secureDownloadUrl2 = `/dl/${dlToken2}`; }
    }

    return c.html(
      <Layout user={user} title={movie.title} coverUrl={movie.coverUrl} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home">
        
        {/* Buy Modal */}
        <div id="buy-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-sm p-4">
             <div class="bg-[#1f1f1f] p-6 rounded-2xl border border-yellow-500/30 w-full max-w-sm text-center relative shadow-2xl modal-enter">
                  <div class="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-yellow-500/20">
                      <i class="fa-solid fa-cart-shopping text-3xl text-yellow-500"></i>
                  </div>
                  <h3 class="text-lg font-black text-white mb-2">Premium Purchase</h3>
                  <p class="text-gray-300 text-sm leading-relaxed mb-4">
                      ယခု Video သည် <span class="text-yellow-500 font-bold">4K Quality</span> ဖြစ်တာမို့ ဝယ်ယူရန် <span id="buy-price" class="text-white font-black text-lg">--</span> ကောက်ခံပါမည်။
                  </p>
                  <div class="flex gap-3 h-12"> 
                      <button onclick="closeBuyModal()" class="flex-1 h-full rounded-xl bg-zinc-800 text-white font-bold hover:bg-zinc-700 transition border border-zinc-700">Cancel</button>
                      {user ? (
                          <form action="/api/buy-movie" method="post" class="flex-1 h-full"> 
                              <input type="hidden" name="movieId" value={movie.id} />
                              <button class="w-full h-full rounded-xl bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold hover:brightness-110 transition shadow-lg">Buy Now</button>
                          </form>
                      ) : (
                          <a href="/login" class="flex-1 h-full flex items-center justify-center rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-500 transition">Login</a>
                      )}
                  </div>
             </div>
        </div>

        {/* VIP Modal */}
        <div id="vip-modal" class="fixed inset-0 z-[100] bg-black/90 hidden items-center justify-center backdrop-blur-sm p-4">
             <div class="bg-[#1f1f1f] p-6 rounded-2xl border border-yellow-500/30 w-full max-w-sm text-center relative shadow-2xl modal-enter">
                  <div class="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-yellow-500/20">
                      <i class="fa-solid fa-crown text-3xl text-yellow-500 animate-pulse"></i>
                  </div>
                  <h3 class="text-lg font-black text-white mb-2">VIP Access Required</h3>
                  <p class="text-gray-300 text-sm leading-relaxed mb-4 font-bold">Moviesများ ကြည့်ရန် ဒေါင်းရန်အတွက် Accountဖွင့်ပါ</p>
                  <div class="flex gap-3 h-12"> 
                      <button onclick="closeVipModal()" class="flex-1 h-full rounded-xl bg-zinc-800 text-white font-bold hover:bg-zinc-700 transition border border-zinc-700">Cancel</button>
                      <a href={user ? "/profile" : "/login"} class="flex-1 h-full flex items-center justify-center rounded-xl bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold hover:brightness-110 transition shadow-lg">{user ? "Enter Key" : "Login"}</a>
                  </div>
                  <a href="https://t.me/iqowoq" target="_blank" class="block mt-4 text-xs text-blue-400 hover:text-white underline">Contact Admin on Telegram</a>
             </div>
        </div>

        <div class="max-w-4xl mx-auto">
           {/* 🔥 VIDEO PLAYER SECTION (Lock Icon ဖယ်ရှားပြီး) */}
           <div class="w-full aspect-video bg-black relative shadow-lg group rounded-xl overflow-hidden border border-zinc-800">
                {canWatch ? (
                    <>
                        {/* ကြည့်ခွင့်ရှိသူများအတွက် Player */}
                        <div id="video-cover" class="absolute inset-0 z-20 cursor-pointer group">
                            <img src={displayImage} class="w-full h-full object-cover transition duration-700 group-hover:scale-105" />
                            {/* Play Icon လေး အလယ်မှာပြမယ် (Optional) */}
                            <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-300 bg-black/20">
                                <i class="fa-solid fa-circle-play text-6xl text-white drop-shadow-lg"></i>
                            </div>
                        </div>
                        <div id="video-player" class="w-full h-full hidden"></div>
                        
                        {/* 🔥 FIX: border-yellow-500 ကို ဖျက်လိုက်ပါ (CSS က အလုပ်လုပ်အောင်လို့ပါ) */}
                        <div id="video-player-loader" class="absolute inset-0 z-10 bg-black flex items-center justify-center hidden">
                            <div class="spinner"></div> 
                        </div>
                    </>
                ) : (
                    <div class="absolute inset-0 z-20">
                        {/* 🔥 ကြည့်ခွင့်မရှိသေးသူများ (သောခလောက်ဖြုတ်ထားသည်) */}
                        {/* ပုံကို ကြည်ကြည်လင်လင်ပဲ ပြထားပါမယ် */}
                        <img src={displayImage} class="w-full h-full object-cover" />
                        
                        {/* Lock Icon နဲ့ အမည်းရောင် Overlay ကို ဖျက်လိုက်ပါပြီ */}
                    </div>
                )}
           </div>
           
           <div class="p-6">
               {/* ... အောက်ပိုင်း စာသားများ ဆက်လက်ရှိနေမည် ... */}
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
                            {/* 🔥 Server 1: playbackToken (Token 1) ကိုသုံးမည် */}
                            <button onclick={canWatch ? `loadPlayer('${movie.linkType === 'direct' ? playbackToken : playerUrl}', '${movie.linkType}', '${movie.id}', '${movie.title.replace(/'/g, "\\'")}', '${movie.posterUrl}', this)` : (moviePrice > 0 ? `openBuyModal('${moviePrice}', '${movie.title.replace(/'/g, "\\'")}')` : `openVipModal()`)} class="srv-btn w-full bg-white text-black font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 active:scale-95 transition hover:brightness-110 shadow-lg text-xs"><i class={`fa-solid ${canWatch ? 'fa-play' : 'fa-lock'}`}></i> {t.server1} {canWatch ? "" : (moviePrice > 0 ? "(Buy)" : "")}</button>
                            
                            {/* 🔥 Server 2: playbackToken2 (Token 2) ကိုပြောင်းသုံးထားပါသည် */}
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

               {(movie.category === "Series" || movie.category === "Animation") && episodes.length > 0 && (
                   <div class="mb-8">
                       <h3 class="font-bold text-white mb-3 flex items-center gap-2"><i class="fa-solid fa-layer-group text-yellow-500"></i> Seasons & Episodes</h3>
                       <div class="flex overflow-x-auto gap-3 pb-2 scrollbar-hide">{Object.keys(seasons).map((season, idx) => { const safeId = season.replace(/\s+/g, '-'); return (<button id={`btn-${safeId}`} onclick={`switchSeason('${safeId}')`} class="season-tab-btn flex-shrink-0 px-5 py-2 rounded-full text-xs font-bold transition border border-zinc-800 bg-zinc-800 text-gray-400 hover:text-white hover:border-zinc-600">{season}</button>) })}</div>
                       <div id="episodes-container">
                           {Object.keys(seasons).map((season, idx) => { 
                               const safeId = season.replace(/\s+/g, '-'); 
                               return (
                                   <div id={`ep-grid-${safeId}`} class="season-content hidden mt-3 bg-[#1f1f1f] rounded-xl border border-zinc-800 p-3 animate-fade-in">
                                       <div class="grid grid-cols-4 gap-2 max-h-60 overflow-y-auto custom-scroll pr-1">
                                           {seasons[season].map(ep => (
                                               <button onclick={canWatch ? `loadPlayer('${ep.url.trim()}', '${movie.linkType}', '${movie.id}', '${movie.title.replace(/'/g, "\\'")}', '${movie.posterUrl}', this)` : (moviePrice > 0 ? `openBuyModal('${moviePrice}', '${movie.title.replace(/'/g, "\\'")}')` : `openVipModal()`)} class="srv-btn bg-zinc-800 hover:bg-zinc-700 text-white text-[10px] py-3 rounded-lg border border-zinc-700 transition-colors font-bold truncate">{canWatch ? "" : "🔒 "} {ep.name}</button>
                                            ))}
                                       </div>
                                   </div>
                               ) 
                            })}
                        </div>
                   </div> 
               )}
               
               <p class="text-sm text-gray-300 leading-relaxed mb-8 whitespace-pre-wrap">{movie.description}</p>
               {related.length > 0 && (
                   <div class="pt-6 border-t border-zinc-800"><h3 class="font-bold text-white mb-4 text-lg">You May Also Like</h3><div class="h-scroll-section custom-scroll">{related.map(m => (<a href={`/movie/${m.id}`} class={`h-scroll-item block relative bg-[#1f1f1f] rounded-xl overflow-hidden flex-shrink-0 movie-card group ${m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns" ? 'wide' : 'w-28'}`}><div class={`${m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns" ? "aspect-video" : "aspect-[2/3]"} w-full relative overflow-hidden img-skeleton`}><img src={m.category === "All Uncensored" || m.category === "Myanmar and Asian" || m.category === "4K Porns" ? (m.coverUrl || m.posterUrl) : m.posterUrl} loading="lazy" decoding="async" onload="window.imgLoaded(this)" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500 img-fade" /></div><div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div>
               )}
           </div>
        </div>
      </Layout>
    );
});

// 🔥 Atomic Transaction for Movie Purchase
app.post("/api/buy-movie", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const { movieId } = await c.req.parseBody();
    const id = String(movieId);
    const movie = await getMovie(id);
    if (!movie) return c.redirect(`/?error=Movie Not Found`);
    if (!movie.price || movie.price <= 0) return c.redirect(`/movie/${id}`);
    
    // Check user versionstamp for Atomic Transaction
    const userKey = ["users", user.username];
    const userRes = await kv.get<User>(userKey);
    const currentUser = userRes.value;

    if (!currentUser) return c.redirect("/login");
    if (currentUser.purchased && currentUser.purchased.includes(id)) return c.redirect(`/movie/${id}`);
    if (!currentUser.coins || currentUser.coins < movie.price) return c.redirect(`/movie/${id}?error=Not enough coins! Please top up.`);

    currentUser.coins -= movie.price;
    if (!currentUser.purchased) currentUser.purchased = [];
    currentUser.purchased.push(id);

    // Atomic Commit
    const commit = await kv.atomic()
        .check(userRes) 
        .set(userKey, currentUser)
        .commit();

    if (!commit.ok) {
         return c.redirect(`/movie/${id}?error=Transaction failed. Please try again.`);
    }

    await logAdminAction("purchase", `${user.username} bought ${movie.title} for ${movie.price}Ks`);
    return c.redirect(`/movie/${id}?success=Purchase Successful! Enjoy.`);
});

app.get("/login", (c) => {
    const lang = getLang(c);
    const t = i18n[lang];
    return c.html(<Layout hideNav={true} lang={lang} activeTab="me"><div class="min-h-[80vh] flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-4xl font-black text-yellow-500 mb-8 text-center italic tracking-tighter">GOLD FLIX</h1><form action="/login" method="post" class="bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 space-y-5 shadow-2xl"><h2 class="text-xl font-bold text-white">{t.login}</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><label class="flex items-center text-gray-400 text-xs"><input type="checkbox" name="remember" class="mr-2 accent-yellow-500" /> Remember Me (7 Days)</label><button class="btn-primary w-full shadow-lg hover:shadow-yellow-500/20">{t.login}</button><p class="text-xs text-gray-500 text-center mt-2">No account? <a href="/signup" class="text-white font-bold hover:text-yellow-500 transition">Sign up</a></p><p class="text-xs text-gray-500 text-center"><a href="/forgot-password" class="text-gray-400 hover:text-white">Forgot Password?</a></p></form></div></div></Layout>);
});

app.post("/login", async (c) => { 
    const ip = getClientIp(c);
    const lang = getLang(c);
    const t = i18n[lang];
    if (await isIpBanned(ip)) return c.html(<Layout hideNav={true} title="Access Denied" lang={lang}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="bg-[#1f1f1f] p-8 rounded-2xl border border-red-600 text-center max-w-sm w-full shadow-2xl relative overflow-hidden"><div class="absolute inset-0 bg-red-600/10 blur-xl"></div><div class="relative z-10"><i class="fa-solid fa-ban text-6xl text-red-600 mb-6 drop-shadow-[0_0_10px_rgba(220,38,38,0.5)]"></i><h1 class="text-2xl font-black text-white mb-2 uppercase tracking-widest">{t.access_denied}</h1><p class="text-gray-400 text-sm mb-6 leading-relaxed">{t.ip_banned} <span class="font-mono text-red-400 bg-red-900/20 px-1 rounded">{ip}</span></p><div class="text-[10px] text-gray-600 uppercase font-bold tracking-wider">Contact Admin for Support</div></div></div></div></Layout>);
    if (!await checkRateLimit(ip)) return c.html(<Layout hideNav={true} title="Security Alert" lang={lang}><div class="min-h-screen flex items-center justify-center bg-black p-4 relative overflow-hidden"><div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-red-600/20 blur-[100px] rounded-full pointer-events-none"></div><div class="relative z-10 bg-[#1f1f1f] p-8 rounded-2xl border border-red-500/30 shadow-2xl max-w-sm w-full text-center"><div class="w-20 h-20 bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-6 border border-red-500/20"><i class="fa-solid fa-shield-halved text-4xl text-red-500 animate-pulse"></i></div><h1 class="text-xl font-bold text-white mb-2">{t.security_alert}</h1><p class="text-gray-400 text-sm mb-6 leading-relaxed">Too many failed attempts. Please wait.</p><div class="bg-black/50 rounded-lg p-3 border border-red-900/50 mb-6"><p class="text-yellow-500 text-xs font-bold uppercase tracking-wider">{t.wait}</p><p class="text-white font-mono text-lg font-bold">5 Minutes</p></div><a href="/login" class="block w-full bg-zinc-700 hover:bg-zinc-600 text-white font-bold py-3 rounded-lg transition border border-zinc-600">Back to Login</a></div></div></Layout>);
    const body = await c.req.parseBody(); 
    const user = await getUser(body["username"] as string); 
    const hashedInput = await hashPassword(body["password"] as string); 
    if (user && user.passwordHash === hashedInput) { 
        if (user.isBanned) return c.redirect("/login?error=Your account has been suspended by Admin!");
        const sessionId = crypto.randomUUID(); 
        user.sessionId = sessionId; 
        user.lastLoginIp = ip; 
        await kv.set(["users", user.username], user); 
        const maxAge = body["remember"] === "on" ? 60 * 60 * 24 * 7 : undefined; 
        setCookie(c, "auth_session", `${user.username}:${sessionId}`, { path: "/", maxAge, httpOnly: true, secure: !c.req.url.includes("localhost"), sameSite: "Lax" }); 
        return c.redirect("/"); 
    } 
    return c.redirect("/login?error=Invalid Username or Password"); 
});

app.get("/signup", (c) => c.html(
    <Layout hideNav={true} lang={getLang(c)} activeTab="me">
        <div class="min-h-[80vh] flex items-center justify-center bg-black p-4">
            <div class="w-full max-w-sm">
                <h1 class="text-3xl font-black text-yellow-500 mb-8 text-center italic tracking-tighter">GOLD FLIX</h1>
                <form action="/signup" method="post" class="bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 space-y-5 shadow-2xl">
                    <h2 class="text-xl font-bold text-white">Create Account</h2>
                    <input name="username" placeholder="Username" required class="input-box" />
                    <input type="password" name="password" placeholder="Password" required class="input-box" />
                    
                    <div class="space-y-2">
                         <label class="text-xs text-gray-400 font-bold">Security Question (For Recovery)</label>
                         <select name="question" class="input-box bg-[#1a1a1a] border-zinc-700 text-sm">
                             {SECURITY_QUESTIONS.map(q => <option value={q}>{q}</option>)}
                         </select>
                         <input name="answer" placeholder="Your Answer..." required class="input-box" />
                    </div>

                    <button class="btn-primary w-full shadow-lg hover:shadow-yellow-500/20">Sign Up</button>
                    <p class="text-xs text-gray-500 text-center mt-2">Has account? <a href="/login" class="text-white font-bold hover:text-yellow-500 transition">Login</a></p>
                </form>
            </div>
        </div>
    </Layout>
));

app.post("/signup", async (c) => { 
    const clientIp = getClientIp(c);
    const lang = getLang(c);
    const t = i18n[lang];
    if (await isIpBanned(clientIp)) return c.html(<Layout hideNav={true} title="Access Denied" lang={lang}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="bg-[#1f1f1f] p-8 rounded-2xl border border-red-600 text-center max-w-sm w-full shadow-2xl relative overflow-hidden"><div class="absolute inset-0 bg-red-600/10 blur-xl"></div><div class="relative z-10"><i class="fa-solid fa-ban text-6xl text-red-600 mb-6 drop-shadow-[0_0_10px_rgba(220,38,38,0.5)]"></i><h1 class="text-2xl font-black text-white mb-2 uppercase tracking-widest">{t.access_denied}</h1><p class="text-gray-400 text-sm mb-6 leading-relaxed">{t.ip_banned} <span class="font-mono text-red-400 bg-red-900/20 px-1 rounded">{clientIp}</span></p></div></div></div></Layout>);
    const { username, password, question, answer } = await c.req.parseBody();
    if (String(password).length < 6) return c.redirect("/signup?error=Password must be at least 6 characters!");
    if (await getUser(username as string)) return c.redirect("/signup?error=User already exists!"); 
    
    const passwordHash = await hashPassword(password as string); 
    const answerHash = await hashPassword(String(answer).toLowerCase().trim());

    const newUser: User = { 
        username: String(username), 
        passwordHash, 
        expiryDate: null, 
        favorites: [], 
        sessionId: "", 
        ip: clientIp, 
        lastLoginIp: clientIp, 
        isBanned: false, 
        coins: 0, 
        purchased: [],
        securityQ: String(question),
        securityA: answerHash 
    }; 
    await kv.set(["users", String(username)], newUser); 
    return c.redirect("/login?success=Account created successfully!"); 
});

// 🔥 Password Reset Flow
app.get("/forgot-password", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="text-xl font-bold text-white mb-4">Reset Password</h2><form action="/forgot-password" method="post" class="space-y-4"><input name="username" placeholder="Enter Username" required class="input-box" /><button class="btn-primary w-full">Next</button></form></div></div></Layout>));
app.post("/forgot-password", async (c) => {
    const { username } = await c.req.parseBody();
    const user = await getUser(String(username));
    if (!user || !user.securityQ) return c.redirect("/forgot-password?error=User not found or no security question set.");
    return c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="text-xl font-bold text-white mb-4">Security Check</h2><p class="text-gray-400 text-sm mb-4">{user.securityQ}</p><form action="/reset-password" method="post" class="space-y-4"><input type="hidden" name="username" value={user.username} /><input name="answer" placeholder="Your Answer" required class="input-box" /><input type="password" name="newpass" placeholder="New Password" required class="input-box" /><button class="btn-primary w-full">Reset Password</button></form></div></div></Layout>);
});
app.post("/reset-password", async (c) => {
    const { username, answer, newpass } = await c.req.parseBody();
    const user = await getUser(String(username));
    if(!user) return c.redirect("/login?error=Error");
    const ansHash = await hashPassword(String(answer).toLowerCase().trim());
    if (ansHash !== user.securityA) return c.redirect("/forgot-password?error=Incorrect Answer");
    user.passwordHash = await hashPassword(String(newpass));
    await kv.set(["users", user.username], user);
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
        purchasedMovies.push(...results.filter(m => m)); 
    }

    const plans = [
        { name: "LuGyi Apk 1 Month + Gold 15 Day", price: "700 Ks", days: 30, features: ["Watch All (Except 4K Porns)", "Direct Download"] },
        { name: "LuGyi Apk 3 Month + Gold 45 Day", price: "1,500 Ks", days: 90, popular: true, features: ["Watch All (Except 4K Porns)", "Direct Download"] },
        { name: "LuGyi Apk 5 Month + Gold 75 Day", price: "2,200 Ks", days: 150, features: ["Watch All (Except 4K Porns)", "Direct Download"] },
        { name: "LuGyi Apk 1Year + Gold 180 Day", price: "5,000 Ks", days: 365, features: ["Watch All (Except 4K Porns)", "Direct Download"] }
    ]; 

    return c.html(
      <Layout user={user} lang={lang} activeTab="me">
        <div class="p-4 max-w-2xl mx-auto space-y-5 pb-20">
            <div class="relative w-full aspect-[1.8/1] rounded-2xl bg-gradient-to-br from-[#FFD700] via-[#FDB931] to-[#9e7f13] p-6 shadow-[0_10px_30px_-10px_rgba(253,185,49,0.4)] text-black flex flex-col justify-between overflow-hidden relative group">
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
                 <a href="/favorites" class="bg-[#1f1f1f] p-4 rounded-2xl border border-zinc-800 flex flex-col items-center justify-center gap-1 hover:bg-[#252525] transition active:scale-95"><div class="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 text-sm"><i class="fa-solid fa-heart"></i></div><span class="block text-xl font-bold text-white leading-none">{favCount}</span><span class="text-[9px] text-gray-500 font-bold uppercase">Saved</span></a>
                 <div class="bg-[#1f1f1f] p-4 rounded-2xl border border-zinc-800 flex flex-col items-center justify-center gap-1"><div class="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500 text-sm"><i class="fa-solid fa-coins"></i></div><span class="block text-xl font-bold text-white leading-none">{userCoins}</span><span class="text-[9px] text-gray-500 font-bold uppercase">Kyats (Ks)</span></div>
                 <div class="bg-[#1f1f1f] p-4 rounded-2xl border border-zinc-800 flex flex-col items-center justify-center gap-1"><div class={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${premium ? 'bg-green-500/10 text-green-500' : 'bg-gray-700/20 text-gray-500'}`}><i class="fa-solid fa-clock"></i></div><span class={`block text-xl font-bold leading-none ${premium ? 'text-white' : 'text-gray-500'}`}>{premium ? finalDays : "0"}</span><span class="text-[9px] text-gray-500 font-bold uppercase">Days</span></div>
            </div>

            <div class="bg-[#1f1f1f] p-5 rounded-2xl border border-zinc-800 relative overflow-hidden">
                 <div class="absolute -right-4 -top-4 opacity-5"><i class="fa-solid fa-ticket text-8xl"></i></div>
                 <h3 class="font-bold text-gray-300 text-sm mb-3 flex items-center gap-2 relative z-10"><i class="fa-solid fa-gift text-yellow-500"></i> Redeem Code</h3>
                 <form action="/profile/redeem" method="post" class="relative z-10 flex gap-2">
                    <input name="key" placeholder="Paste VIP or Coin Code..." required class="bg-black/50 border border-zinc-700 text-white text-sm px-4 py-3 rounded-xl w-full outline-none focus:border-yellow-500 transition placeholder-gray-600 font-mono" />
                    <button class="bg-yellow-500 text-black font-bold px-5 rounded-xl hover:bg-yellow-400 transition shadow-lg"><i class="fa-solid fa-arrow-right"></i></button>
                 </form>
            </div>
            
            {/* 🔥 Slip Upload / Manual Topup (Full Updated Section) */}
            <div class="bg-[#1f1f1f] p-5 rounded-2xl border border-blue-900/30 relative overflow-hidden">
                 <h3 class="font-bold text-blue-400 text-sm mb-4 flex items-center gap-2"><i class="fa-solid fa-money-bill-transfer"></i> Manual Top-up (KPay/Wave)</h3>
                 
                 <form action="/profile/topup" method="post" class="space-y-4">
                    
                    {/* ၁. Payment Method ရွေးသည့်နေရာ (Custom Cards) */}
                    <div class="grid grid-cols-2 gap-3">
                        {/* KPay Option */}
                        <label class="cursor-pointer relative group">
                            <input type="radio" name="method" value="kpay" class="peer sr-only" checked />
                            <div class="p-3 rounded-xl bg-black/50 border border-zinc-700 peer-checked:border-orange-500 peer-checked:bg-orange-500/10 transition text-center hover:bg-zinc-800 group-active:scale-95">
                                <i class="fa-solid fa-wallet text-orange-500 mb-2 text-xl block"></i>
                                <span class="font-bold text-xs text-gray-400 peer-checked:text-orange-500">KBZ Pay</span>
                            </div>
                            <div class="absolute top-2 right-2 text-orange-500 opacity-0 peer-checked:opacity-100 transition">
                                <i class="fa-solid fa-circle-check"></i>
                            </div>
                        </label>

                        {/* Wave Option */}
                        <label class="cursor-pointer relative group">
                            <input type="radio" name="method" value="wave" class="peer sr-only" />
                            <div class="p-3 rounded-xl bg-black/50 border border-zinc-700 peer-checked:border-yellow-400 peer-checked:bg-yellow-400/10 transition text-center hover:bg-zinc-800 group-active:scale-95">
                                <i class="fa-solid fa-money-bill-wave text-yellow-400 mb-2 text-xl block"></i>
                                <span class="font-bold text-xs text-gray-400 peer-checked:text-yellow-400">Wave Pay</span>
                            </div>
                            <div class="absolute top-2 right-2 text-yellow-400 opacity-0 peer-checked:opacity-100 transition">
                                <i class="fa-solid fa-circle-check"></i>
                            </div>
                        </label>
                    </div>

                    {/* ၂. ပမာဏ ထည့်သည့်နေရာ */}
                    <input type="number" name="amount" placeholder="Amount (Ks)" required class="input-box bg-black/50 text-sm focus:border-blue-500 transition placeholder-gray-600" />
                    
                    {/* ၃. Transaction ID (ခင်ဗျားမေးတဲ့အပိုင်း - မဖျက်ရပါ) */}
                    <input name="transactionId" placeholder="Transaction ID (e.g. 01234...) or Link" required class="input-box bg-black/50 text-sm focus:border-blue-500 transition placeholder-gray-600" />
                    
                    {/* ၄. Submit Button */}
                    <button class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl transition text-xs shadow-lg shadow-blue-900/20 active:scale-95">
                        Submit Slip
                    </button>
                 </form>
            </div>

            <div>
                <h3 class="font-bold text-white mb-4 flex items-center gap-2 text-sm uppercase tracking-wider text-gray-500"><i class="fa-solid fa-gem text-blue-500"></i> LuGyi and Gold Plan</h3>
                <div class="space-y-3">{plans.map(p => (<div class={`relative bg-[#1f1f1f] p-4 rounded-2xl border flex flex-col justify-between transition active:scale-95 ${p.popular ? 'border-yellow-500/50 shadow-[0_0_15px_rgba(234,179,8,0.1)]' : 'border-zinc-800'}`}>{p.popular && <div class="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-[9px] font-black px-2 py-0.5 rounded shadow-sm uppercase tracking-widest">Best Value</div>}<div class="text-center mb-3"><h4 class="text-gray-400 font-bold text-xs uppercase mb-1">{p.name}</h4><span class="text-white font-black text-xl tracking-tight">{p.price}</span></div><div class="space-y-1.5 mb-4 px-2">{p.features.slice(0,2).map(f => (<div class="flex items-center gap-1.5 text-[10px] text-gray-500 justify-center"><i class="fa-solid fa-check text-green-500"></i> {f}</div>))}</div><a href="https://t.me/LuGyiandYoteshinMovies" target="_blank" class={`block text-center py-2.5 rounded-xl font-bold text-xs transition ${p.popular ? 'bg-yellow-500 text-black hover:bg-yellow-400' : 'bg-zinc-800 text-white hover:bg-zinc-700'}`}>Buy Now</a></div>))}</div>
            </div>

            {purchasedMovies.length > 0 && (
                <div class="pt-4 border-t border-zinc-800">
                    <h3 class="font-bold text-green-400 mb-4 flex items-center gap-2 text-sm uppercase tracking-wider">
                        <i class="fa-solid fa-cart-arrow-down"></i> My Purchased Movies ({purchasedMovies.length})
                    </h3>
                    
                    {/* 🔥 ပြင်ဆင်ချက် - max-h (အမြင့်ဆုံးထားမည့်ဆိုဒ်) နှင့် overflow-y-auto (Scroll) ထည့်လိုက်ပါသည် */}
                    <div class="max-h-[400px] overflow-y-auto custom-scroll pr-1">
                        <div class="grid grid-cols-2 gap-3 pb-2">
                            {purchasedMovies.map(m => (
                                <a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group relative border border-zinc-800/50">
                                    <div class="aspect-video relative overflow-hidden">
                                        <img src={m.coverUrl || m.posterUrl} loading="lazy" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" />
                                        <div class="absolute top-1 right-1 bg-green-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded shadow">Owned</div>
                                    </div>
                                    <div class="p-2"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div>
                                </a>
                            ))}
                        </div>
                    </div>
                </div>
            )}

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
    const { amount, method, transactionId } = await c.req.parseBody();
    const topup: TopupRequest = {
        id: crypto.randomUUID(),
        username: user.username,
        amount: parseInt(String(amount)),
        method: String(method),
        transactionId: String(transactionId),
        status: "pending",
        timestamp: Date.now()
    };
    await kv.set(["topups", topup.id], topup);
    return c.redirect("/profile?success=Top-up Submitted! Admin will verify soon.");
});

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
    
    // 🔥 FIX: Redirect လုပ်တဲ့အခါ timestamp ကပ်လိုက်ပါ
    // ဒါဆို Browser က Cache ယူမသုံးတော့ဘဲ အသစ်ဆွဲပါလိမ့်မယ်
    return c.redirect("/?ref=" + Date.now());
});

app.get(ADMIN_ROUTE, (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action={ADMIN_ROUTE + "/login"} method="post" class="bg-[#1f1f1f] p-8 rounded-2xl w-80 shadow-2xl border border-zinc-800"><h2 class="font-bold text-center mb-6 text-blue-500 text-xl">ADMIN ACCESS</h2><input type="password" name="password" placeholder="Enter Secure Key" class="input-box mb-4 text-center tracking-widest" /><button class="bg-blue-600 text-white w-full py-3 rounded-xl font-bold hover:bg-blue-500 transition shadow-lg shadow-blue-900/20">Unlock Dashboard</button></form></div></Layout>));

app.post(ADMIN_ROUTE + "/login", async (c) => { 
    const { password } = await c.req.parseBody(); 
    if (password === ADMIN_PASS) { 
        const sessionId = crypto.randomUUID();
        await kv.set(["admin_sessions", sessionId], "active", { expireIn: ADMIN_SESSION_EXPIRE });
        setCookie(c, "admin_session_id", sessionId, { path: "/", httpOnly: true, secure: !c.req.url.includes("localhost"), sameSite: "Strict" }); 
        await logAdminAction("login", "Admin Logged In");
        return c.redirect(ADMIN_ROUTE + "/dashboard"); 
    } 
    return c.redirect(ADMIN_ROUTE); 
});

app.get(ADMIN_ROUTE + "/dashboard", adminGuard, async (c) => { 
    c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    c.header('Expires', '-1');
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    const iterDrafts = kv.list<Movie>({ prefix: ["drafts"] });
    const drafts = []; for await (const res of iterDrafts) drafts.push(res.value);
    const movies = []; for await (const res of iter) movies.push(res.value);
    movies.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
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
    const epString = editMovie?.episodes?.map(e => (e.season ? `${e.season} | ${e.name} | ${e.url}` : `${e.name} | ${e.url}`)).join('\n') || "";
    const vipDate = config.globalVipExpiry ? new Date(config.globalVipExpiry).toLocaleDateString() : "Inactive";

    // Chart Data Preparation
    const catCounts: any = {};
    movies.forEach(m => { catCounts[m.category] = (catCounts[m.category] || 0) + 1; });
    
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
                        <div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl">
                            <h2 class="text-white font-bold mb-4">Content Distribution</h2>
                            <canvas id="contentChart"></canvas>
                        </div>
                        <div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl flex flex-col justify-center items-center">
                            <h2 class="text-white font-bold mb-4">Quick Stats</h2>
                            <div class="grid grid-cols-2 gap-6 w-full text-center">
                                <div class="bg-black p-4 rounded-xl border border-zinc-800"><p class="text-3xl font-black text-white">{totalUsers}</p><p class="text-xs text-gray-500 uppercase">Users</p></div>
                                <div class="bg-black p-4 rounded-xl border border-zinc-800"><p class="text-3xl font-black text-yellow-500">{movies.length}</p><p class="text-xs text-gray-500 uppercase">Movies</p></div>
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
                        <div class={`lg:col-span-1 p-5 rounded-2xl border h-fit lg:sticky lg:top-4 z-10 w-full max-w-[100vw] overflow-hidden shadow-xl transition-colors ${editMovie ? 'bg-blue-900/20 border-blue-500/50' : 'bg-[#111] border-zinc-800'}`}>
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
                        <div class="lg:col-span-2 bg-[#111] p-5 rounded-2xl border border-zinc-800 flex flex-col h-[600px] lg:h-[80vh] w-full max-w-[100vw] shadow-xl">
                            <div class="flex justify-between items-center mb-4">
                                <h2 class="font-bold text-sm text-green-500"><i class="fa-solid fa-circle text-[8px] animate-pulse"></i> Live Movies ({movies.length})</h2>
                                <input oninput="filterMovies(this.value)" placeholder="Search..." class="bg-black border border-zinc-700 rounded-lg px-4 py-2 text-xs w-48 outline-none" />
                            </div>
                            <form action="/admin/movie/bulk-delete" method="post" id="bulk-form">
                                <div class="mb-2 text-right">
                                    <button onclick="return confirm('Are you sure you want to delete selected items?')" class="text-red-500 text-xs font-bold bg-red-900/20 px-3 py-1.5 rounded border border-red-500/30 hover:bg-red-600 hover:text-white transition">Delete Selected</button>
                                </div>
                                <div class="space-y-3 flex-1 overflow-y-auto pr-1 custom-scroll h-[calc(100%-80px)]">
                                    {movies.map(m => (
                                        <div class="movie-item flex gap-4 p-3 rounded-xl items-center border bg-black border-zinc-800/50 hover:border-zinc-600 transition" data-title={m.title}>
                                            <input type="checkbox" name="ids[]" value={m.id} class="w-4 h-4 accent-red-600" />
                                            <img src={m.posterUrl} class="w-10 h-14 object-cover rounded-lg flex-shrink-0" />
                                            <div class="flex-grow min-w-0">
                                                <div class="font-bold text-sm truncate text-gray-200">{m.title}</div>
                                                <div class="text-[10px] text-gray-500">{m.category} • {m.year}</div>
                                            </div>
                                            <div class="flex gap-2">
                                                <a href={`${ADMIN_ROUTE}/dashboard?edit=${m.id}`} class="text-blue-500 text-xs border border-blue-500/20 bg-blue-500/10 px-3 py-1.5 rounded hover:bg-blue-500 hover:text-white transition">Edit</a>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </form>
                        </div>
                    </div>
                </div>

                <div id="tab-drafts" class="tab-content"><div class="max-w-4xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl min-h-[50vh]"><div class="flex justify-between items-center mb-6"><h2 class="font-bold text-yellow-500 text-lg flex items-center gap-2"><i class="fa-solid fa-file-pen"></i> Drafts ({drafts.length})</h2>{drafts.length > 0 && (<form action="/admin/drafts/publish-all" method="post" onsubmit="return confirm('Are you sure? This will publish ALL drafts to the live site.')"><button class="bg-gradient-to-r from-green-600 to-green-500 text-white font-bold px-6 py-2 rounded-xl shadow-lg hover:scale-105 transition flex items-center gap-2"><i class="fa-solid fa-rocket"></i> Publish All ({drafts.length})</button></form>)}</div>{drafts.length === 0 ? (<div class="text-center text-gray-500 py-20 border-2 border-dashed border-zinc-800 rounded-xl"><i class="fa-regular fa-folder-open text-4xl mb-3 opacity-50"></i><p>No drafts saved yet.</p></div>) : (<div class="grid grid-cols-1 md:grid-cols-2 gap-4">{drafts.map(d => (<div class="flex gap-4 p-4 rounded-xl bg-black border border-yellow-500/20 relative group"><div class="absolute top-2 right-2 bg-yellow-500 text-black text-[9px] font-bold px-2 py-0.5 rounded uppercase">Draft</div><img src={d.posterUrl} class="w-16 h-24 object-cover rounded-lg shadow-lg" /><div class="flex flex-col justify-between flex-grow"><div><h3 class="font-bold text-white text-md truncate pr-8">{d.title}</h3><p class="text-xs text-gray-500">{d.category}</p></div><div class="flex gap-2 mt-3"><a href={`${ADMIN_ROUTE}/dashboard?edit=${d.id}&type=draft`} class="flex-1 text-center bg-zinc-800 hover:bg-zinc-700 text-gray-300 text-xs font-bold py-2 rounded border border-zinc-700 transition">Edit</a><form action="/admin/movie/save" method="post" class="flex-1"><input type="hidden" name="id" value={d.id} />{Object.entries(d).map(([k,v]) => { if(k==='episodes'||k==='id') return null; return <input type="hidden" name={k} value={String(v)} /> })}</form><form action={`/admin/draft/delete/${d.id}`} method="post" onsubmit="return confirm('Delete draft?')"><button class="px-3 py-2 bg-red-900/20 text-red-500 border border-red-900/50 rounded hover:bg-red-600 hover:text-white transition"><i class="fa-solid fa-trash"></i></button></form></div></div></div>))}</div>)}</div></div>

                <div id="tab-keys" class="tab-content"><div class="max-w-2xl mx-auto space-y-4"><div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="font-bold mb-4 text-yellow-500 flex items-center gap-2"><i class="fa-solid fa-crown"></i> Generate VIP Key</h2><form action="/admin/key/create" method="post" class="flex gap-3"><input type="hidden" name="type" value="vip" /><input type="number" name="days" placeholder="Days (e.g. 30)" required class="input-box flex-grow bg-black border-zinc-700" /><button class="btn-primary w-32 shadow-lg">Gen VIP</button></form></div><div class="bg-[#111] p-6 rounded-2xl border border-blue-900/30 shadow-xl"><h2 class="font-bold mb-4 text-blue-400 flex items-center gap-2"><i class="fa-solid fa-coins"></i> Generate Money Key</h2><form action="/admin/key/create" method="post" class="flex gap-3"><input type="hidden" name="type" value="coin" /><input type="number" name="value" placeholder="Amount (e.g. 1000)" required class="input-box flex-grow bg-black border-zinc-700 text-blue-400 font-bold" /><button class="bg-blue-600 text-white font-bold px-4 rounded-lg w-32 hover:bg-blue-500 transition">Gen Ks</button></form></div><div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="font-bold mb-4 text-gray-300">Active Keys</h2><div class="space-y-3 max-h-[500px] overflow-y-auto custom-scroll">{keys.map(k => (<div class="flex justify-between items-center p-3 bg-black rounded-xl border border-zinc-800/50"><div class="flex items-center gap-3"><span class={`font-mono font-bold text-lg tracking-wider ${k.type === 'coin' ? 'text-blue-400' : 'text-yellow-500'}`}>{k.code}</span><span class="text-[10px] bg-zinc-900 px-2 py-1 rounded text-gray-400 font-bold border border-zinc-800">{k.type === 'coin' ? `${k.value} Ks` : `${k.days} Days`}</span></div><div class="flex items-center gap-2"><button onclick={`copyToClip('${k.code}')`} class="text-xs bg-zinc-800 text-gray-400 px-3 py-1.5 rounded-lg hover:text-white transition"><i class="fa-solid fa-copy"></i></button><form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-xs bg-red-900/20 text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-600 hover:text-white transition"><i class="fa-solid fa-trash"></i></button></form></div></div>))}</div></div></div></div>

                <div id="tab-topups" class="tab-content">
                    <div class="max-w-4xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl">
                        <h2 class="font-bold mb-6 text-blue-400 flex items-center gap-2"><i class="fa-solid fa-money-bill-transfer"></i> Top-up Requests</h2>
                        <div class="space-y-4">
                            {topups.map(t => (
                                <div class={`p-4 rounded-xl border flex justify-between items-center ${t.status === 'pending' ? 'bg-black border-blue-500/30' : 'bg-zinc-900 border-zinc-800 opacity-60'}`}>
                                    <div>
                                        <div class="flex items-center gap-2 mb-1">
                                            <span class="font-bold text-white text-lg">{t.amount} Ks</span>
                                            <span class="text-xs bg-zinc-800 px-2 py-0.5 rounded text-gray-400 uppercase">{t.method}</span>
                                            {t.status === 'pending' && <span class="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded animate-pulse">PENDING</span>}
                                        </div>
                                        <p class="text-xs text-gray-400">User: <span class="text-white font-bold">{t.username}</span> | ID: <span class="font-mono text-yellow-500">{t.transactionId}</span></p>
                                        <p class="text-[10px] text-gray-600">{new Date(t.timestamp).toLocaleString()}</p>
                                    </div>
                                    {t.status === 'pending' && (
                                        <div class="flex gap-2">
                                            <form action="/admin/topup/approve" method="post">
                                                <input type="hidden" name="id" value={t.id} />
                                                <button class="bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold">Approve</button>
                                            </form>
                                            <form action="/admin/topup/reject" method="post">
                                                <input type="hidden" name="id" value={t.id} />
                                                <button class="bg-red-900/30 hover:bg-red-600 text-red-500 hover:text-white border border-red-500/30 px-3 py-1.5 rounded-lg text-xs font-bold">Reject</button>
                                            </form>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div id="tab-users" class="tab-content"><div class="max-w-4xl mx-auto"><div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6"><div class="bg-gradient-to-br from-blue-900/20 to-black border border-blue-500/20 p-6 rounded-2xl flex items-center gap-5 shadow-lg"><div class="w-14 h-14 bg-blue-500/10 rounded-full flex items-center justify-center text-blue-400 text-3xl shadow-inner"><i class="fa-solid fa-users"></i></div><div><h3 class="text-xs uppercase text-blue-400 font-bold tracking-widest mb-1">Total Users</h3><p class="text-4xl font-black text-white tracking-tight">{totalUsers}</p></div></div><div class="bg-[#111] border border-zinc-800 rounded-2xl overflow-hidden h-64 flex flex-col shadow-lg"><h3 class="bg-black/50 px-5 py-3 text-xs font-bold text-gray-400 border-b border-zinc-800 flex justify-between backdrop-blur-sm"><span>User Control</span><span>IP / Action</span></h3><div class="overflow-y-auto custom-scroll p-3 space-y-2">{userList.map(u => { const isVip = u.expiryDate && new Date(u.expiryDate) > new Date(); return (<div class="flex justify-between items-center bg-black/40 p-2.5 rounded-xl border border-zinc-800/30 hover:border-zinc-700 transition"><div class="flex items-center gap-3"><div class={`w-2.5 h-2.5 rounded-full shadow ${u.isBanned ? 'bg-red-600 shadow-red-500/50' : (isVip ? 'bg-green-500 shadow-green-500/50' : 'bg-gray-500')}`}></div><div><span class={`font-bold block text-xs ${u.isBanned ? 'text-red-500 line-through' : 'text-gray-300'}`}>{u.username}</span><span class="text-[9px] text-gray-600 font-mono">{u.lastLoginIp || u.ip || "Unknown"}</span></div></div><div class="flex items-center gap-2"><span class={isVip ? "text-yellow-500 font-black text-[9px] bg-yellow-500/10 px-1.5 py-0.5 rounded" : "hidden"}>VIP</span><form action="/admin/user/toggle-ban" method="post"><input type="hidden" name="username" value={u.username} /><button class={`px-3 py-1 rounded-lg text-[9px] font-bold border transition ${u.isBanned ? 'bg-green-500/10 text-green-500 border-green-500/50 hover:bg-green-500 hover:text-black' : 'bg-red-500/10 text-red-500 border-red-500/50 hover:bg-red-500 hover:text-white'}`}>{u.isBanned ? "UNBAN" : "BAN"}</button></form></div></div>) })}</div></div></div><div class="grid md:grid-cols-2 gap-6"><div class="bg-[#111] p-6 rounded-2xl border border-yellow-500/20 shadow-xl h-fit relative overflow-hidden"><div class="absolute top-0 right-0 p-4 opacity-5"><i class="fa-solid fa-crown text-8xl text-yellow-500"></i></div><h2 class="font-bold mb-5 text-yellow-500 text-lg flex items-center gap-2 relative z-10"><i class="fa-solid fa-circle-plus"></i> Manual VIP Top-up</h2><form action="/admin/user/add-vip" method="post" class="space-y-4 relative z-10"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Username</label><input name="username" placeholder="Enter username..." required class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Duration (Days)</label><input type="number" name="days" placeholder="e.g. 30" required class="input-box bg-black border-zinc-700" /></div><button class="bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold w-full py-3 rounded-xl hover:brightness-110 transition shadow-lg shadow-yellow-500/20">Add VIP Time</button></form></div><div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl h-fit relative overflow-hidden"><div class="absolute top-0 right-0 p-4 opacity-5"><i class="fa-solid fa-lock text-8xl text-blue-500"></i></div><h2 class="font-bold mb-5 text-blue-500 text-lg flex items-center gap-2 relative z-10"><i class="fa-solid fa-user-lock"></i> Reset Password</h2><form action="/admin/user/reset" method="post" class="space-y-4 relative z-10"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Username</label><input name="username" placeholder="Enter username..." required class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">New Password</label><input name="newpass" placeholder="Enter new password..." required class="input-box bg-black border-zinc-700" /></div><button class="bg-blue-600 text-white font-bold w-full py-3 rounded-xl hover:bg-blue-500 transition shadow-lg shadow-blue-500/20">Reset Password</button></form></div></div></div></div>

                <div id="tab-requests" class="tab-content"><div class="max-w-3xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="font-bold mb-6 text-pink-500 flex items-center gap-2"><i class="fa-solid fa-clapperboard"></i> Movie Requests ({requests.length})</h2><div class="space-y-3">{requests.map(r => (<div class="bg-black p-4 rounded-xl flex justify-between items-center border border-zinc-800/50 hover:border-zinc-700 transition"><div><h3 class="font-bold text-lg text-white">{r.movieName}</h3><p class="text-xs text-gray-500 mt-1">Requested by <span class="text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded font-bold">{r.username}</span> • {new Date(r.timestamp).toLocaleDateString()}</p></div><form action={`/admin/request/delete/${r.id}`} method="post"><button class="text-red-500 hover:text-red-400 p-2 transition bg-red-500/10 rounded-lg hover:bg-red-500 hover:text-white"><i class="fa-solid fa-check"></i> Done</button></form></div>))}</div></div></div>
                
                <div id="tab-logs" class="tab-content">
                    <div class="max-w-4xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl">
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

                <div id="tab-config" class="tab-content"><div class="max-w-xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800 space-y-8 shadow-xl"><div class="bg-red-900/10 border border-red-500/30 p-4 rounded-xl flex justify-between items-center"><div><h3 class="font-bold text-red-500 flex items-center gap-2"><i class="fa-solid fa-screwdriver-wrench"></i> Maintenance Mode</h3><p class="text-[10px] text-gray-400">Turn ON to hide website from users.</p></div><form action="/admin/config/maintenance" method="post"><input type="hidden" name="status" value={config.maintenanceMode ? "off" : "on"} /><button class={`px-4 py-2 rounded-lg font-bold text-xs transition ${config.maintenanceMode ? 'bg-red-600 text-white animate-pulse' : 'bg-zinc-800 text-gray-400'}`}>{config.maintenanceMode ? "🔴 ON (Hidden)" : "⚪️ OFF (Visible)"}</button></form></div><div><h2 class="font-bold mb-4 text-gray-300 flex items-center gap-2"><i class="fa-solid fa-bullhorn"></i> Announcement</h2><form action="/admin/config" method="post" class="space-y-4"><div><input name="text" placeholder="Enter message..." value={config.announcement} class="input-box bg-black border-zinc-700" /></div><label class="flex items-center gap-3 p-4 bg-black rounded-xl border border-zinc-800 cursor-pointer hover:border-zinc-600 transition"><input type="checkbox" name="show" checked={config.showAnnouncement} class="accent-yellow-500 w-5 h-5" /><span class="font-bold text-sm text-gray-300">Show Announcement Bar</span></label><button class="btn-primary w-full shadow-lg">Save Changes</button></form></div><div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-4 text-yellow-500 flex items-center gap-2"><i class="fa-solid fa-image"></i> Popup Ads / Promotion</h2><form action="/admin/config/popup" method="post" class="space-y-4"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Image URL</label><input name="popupImage" placeholder="https://..." value={config.popupImage || ""} class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Message / Description (Optional)</label><textarea name="popupMessage" placeholder="Write your promotion text here..." class="input-box bg-black border-zinc-700 h-20 text-xs">{config.popupMessage || ""}</textarea></div><div class="grid grid-cols-2 gap-3"><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Button Text</label><input name="popupBtnText" placeholder="e.g. Buy VIP Now" value={config.popupBtnText || "Check it out"} class="input-box bg-black border-zinc-700" /></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Link URL</label><input name="popupLink" placeholder="/profile" value={config.popupLink || "/profile"} class="input-box bg-black border-zinc-700" /></div></div><div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Target Audience</label><select name="popupTarget" class="input-box bg-black border-zinc-700"><option value="all" selected={config.popupTarget !== "free"}>Show to EVERYONE (VIP + Free)</option><option value="free" selected={config.popupTarget === "free"}>Show to FREE Users Only (Hide for VIP)</option></select></div><label class="flex items-center gap-3 p-4 bg-black rounded-xl border border-zinc-800 cursor-pointer hover:border-zinc-600 transition"><input type="checkbox" name="showPopup" checked={config.showPopup} class="accent-yellow-500 w-5 h-5" /><span class="font-bold text-sm text-gray-300">Active Popup (Enable)</span></label><button class="btn-primary w-full shadow-lg">Save Popup Settings</button></form></div><div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-2 text-green-500 flex items-center gap-2"><i class="fa-solid fa-gift"></i> Global VIP Event</h2><p class="text-xs text-gray-500 mb-4">Give VIP access to ALL users until a specific date.</p><div class="bg-black p-4 rounded-xl border border-zinc-800 mb-4 flex justify-between items-center"><span class="text-xs font-bold text-gray-500 uppercase">Status</span> <span class="text-lg font-black text-white">{vipDate}</span></div><form action="/admin/config/vip" method="post" class="flex gap-3"><input type="number" name="days" placeholder="Days" required class="input-box bg-black border-zinc-700 w-24 text-center" /><button class="bg-green-600 text-white font-bold px-4 py-2 rounded-xl hover:bg-green-500 flex-grow shadow-lg shadow-green-900/20">Start Event</button></form><form action="/admin/config/vip-clear" method="post" class="mt-3 text-right"><button class="text-xs text-red-500 hover:text-red-400 font-bold bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20 hover:bg-red-500 hover:text-white transition">End Event</button></form></div><div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-2 text-purple-500 flex items-center gap-2"><i class="fa-solid fa-database"></i> Database</h2><p class="text-xs text-gray-500 mb-4">Re-sync search index if movies are missing.</p><form action="/admin/config/reindex" method="post"><button class="bg-purple-900/30 text-purple-400 border border-purple-500/30 font-bold px-6 py-3 rounded-xl hover:bg-purple-600 hover:text-white w-full transition">Re-Sync Database</button></form></div></div></div>

            </div>
        </Layout>
    );
});

// 🔥 Admin Config Save လုပ်တဲ့ Route တွေမှာ clearConfigCache() ထည့်လိုက်ပါ
app.post("/admin/config", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, announcement: body['text'], showAnnouncement: body['show'] === 'on' }); 
    clearConfigCache(); // <--- ဒီလိုမျိုး လိုက်ထည့်ရပါမယ်
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Message Saved"); 
});

app.post("/admin/config/popup", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, popupImage: body['popupImage'], popupMessage: body['popupMessage'], popupBtnText: body['popupBtnText'], popupLink: body['popupLink'], popupTarget: body['popupTarget'], showPopup: body['showPopup'] === 'on' }); 
    clearConfigCache(); // <--- ထပ်ထည့်ပါ
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Popup Settings Updated"); 
});

app.post("/admin/config/maintenance", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, maintenanceMode: body['status'] === 'on' }); 
    clearConfigCache(); // <--- ထပ်ထည့်ပါ (ဒါထည့်လိုက်ရင် ခလုတ်က ချက်ချင်းအလုပ်လုပ်ပါပြီ)
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Maintenance Mode Updated"); 
});

app.post("/admin/config/vip", adminGuard, async (c) => { 
    const body = await c.req.parseBody(); 
    const days = parseInt(String(body['days'])); 
    const targetDate = Date.now() + (days * 86400000); 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, globalVipExpiry: targetDate }); 
    clearConfigCache(); // <--- ထပ်ထည့်ပါ
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Global VIP Event Started"); 
});

app.post("/admin/config/vip-clear", adminGuard, async (c) => { 
    const current = await getConfig(); 
    await kv.set(["config"], { ...current, globalVipExpiry: 0 }); 
    clearConfigCache(); // <--- ထပ်ထည့်ပါ
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Global Event Cleared"); 
});
app.post("/admin/config/reindex", adminGuard, async (c) => { await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Database Optimized!"); });
app.post("/admin/request/delete/:id", adminGuard, async (c) => { await kv.delete(["requests", c.req.param("id")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=requests"); });
app.get("/admin/check-ai", adminGuard, async (c) => { const apiKey = Deno.env.get("GEMINI_API_KEY"); if (!apiKey) return c.json({ error: "API Key မရှိပါ" }); try { const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`); const data = await res.json(); return c.json(data); } catch (e) { return c.json({ error: e.message }); } });
app.post("/admin/api/generate-desc", adminGuard, async (c) => { const { title, type, year, currentDesc } = await c.req.parseBody(); const apiKey = Deno.env.get("GEMINI_API_KEY"); if (!apiKey) return c.json({ error: "Server Error: GEMINI_API_KEY not set." }); async function askGemini(promptText) { try { const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], safetySettings: [ { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" } ] }) }); const data = await response.json(); return data?.candidates?.[0]?.content?.parts?.[0]?.text || null; } catch (e) { return null; } } let prompt = `Role: Movie Channel Admin. Task: Rewrite the input text into engaging Burmese (Myanmar Unicode). Style: Use natural, spoken Burmese (e.g., "တယ်", "မယ်", "နော်"). Avoid formal "သည်/မည်". Tone: Exciting, Suspenseful. Input: "${currentDesc || title}" Output: ONLY Burmese text.`; let result = await askGemini(prompt); if (!result) { console.log("Blocked. Switching to Soft Romance Admin Style..."); prompt = `Role: Adult Romance Novelist / Channel Admin. Task: Rewrite the explicit plot below into a "Romantic/Erotic Drama" summary in Burmese. Rules: 1. Euphemism: Replace explicit/dirty words with soft, romantic metaphors. 2. Style: Maintain the "Channel Admin" storytelling style. Input: "${currentDesc || title}" Output: ONLY Burmese text.`; result = await askGemini(prompt); } if (!result) { prompt = `Translate to Burmese directly. Input: "${currentDesc || title}"`; result = await askGemini(prompt); } if (!result) return c.json({ error: "AI gave up. Text is too extreme." }); return c.json({ desc: result }); });

// 🔥 Bulk Delete
app.post("/admin/movie/bulk-delete", adminGuard, async (c) => {
    const body = await c.req.parseBody();
    const ids = body["ids[]"];
    if (!ids) return c.redirect(ADMIN_ROUTE + "/dashboard?error=No items selected");
    const idArray = Array.isArray(ids) ? ids : [ids];
    for (const id of idArray) {
        await deleteMovieDB(String(id));
    }
    await logAdminAction("bulk_delete", `Deleted ${idArray.length} movies`);
    return c.redirect(ADMIN_ROUTE + "/dashboard?success=Items Deleted");
});

// 🔥 Topup Actions
app.post("/admin/topup/approve", adminGuard, async (c) => {
    const { id } = await c.req.parseBody();
    const topupRes = await kv.get<TopupRequest>(["topups", String(id)]);
    const topup = topupRes.value;
    if (!topup || topup.status !== 'pending') return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&error=Invalid Request");
    
    // Credit User
    const userRes = await kv.get<User>(["users", topup.username]);
    const user = userRes.value;
    if (user) {
        user.coins = (user.coins || 0) + topup.amount;
        await kv.set(["users", user.username], user);
        
        topup.status = 'approved';
        await kv.set(["topups", String(id)], topup);
        await logAdminAction("approve_topup", `Approved ${topup.amount}Ks for ${topup.username}`);
        return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&success=Top-up Approved");
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
    }
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=topups&success=Top-up Rejected");
});

app.post("/admin/movie/save", adminGuard, async (c) => { 
    try {
        const body = await c.req.parseBody(); 
        const saveType = body["saveType"]; 
        const isMoveToTop = body["updateTime"] === "on"; 
        
        let category = body["category"] as string;
        let title = body["title"] as string;
        
        // ဒီနေရာမှာ description ကို variable ထဲအရင်ထည့်မယ်
        let description = body["description"] as string; 
        
        // 🔥 AUTO CLEANER (ပြီးမှ သန့်ရှင်းရေးလုပ်မယ်)
        if (description) {
            description = description
                .replace(/&amp;nbsp;/g, " ")  
                .replace(/&nbsp;/g, " ")      
                .replace(/&amp;/g, "&")       
                .replace(/<[^>]*>?/gm, "")    
                .replace(/\s+/g, " ")         
                .trim();                      
        }

        let duration = body["duration"] as string; 
        let price = parseInt(String(body["price"] || "0"));

        if (category === "4K Porns" && body["mode"] === "create") {
            price = 50; 
            if (!description || description.trim() === "") {
                description = `🔥 𝟒𝐊 𝐔𝐥𝐭𝐫𝐚 𝐇𝐃 𝐐𝐮𝐚𝐥𝐢𝐭𝐲\n` +
                              `ရုပ်ထွက်အထူးကောင်းမွန်ပြီး ကြည်လင်ပြတ်သားသော 4K Original Quality ဖြင့် တင်ဆက်ထားပါသည်။\n\n` +
                              `⭐️ 𝐋𝐢𝐟𝐞𝐭𝐢𝐦𝐞 𝐀𝐜𝐜𝐞𝐬𝐬 (ရာသက်ပန်)\n` +
                              `ယခု Video ကို 50Ksနဲ့ တစ်ခါဝယ်ယူထားရုံဖြင့် မိမိအကောင့်ထဲတွင် တစ်သက်လုံး သိမ်းဆည်းထားနိုင်ပြီး၊ ` +
                              `VIP သက်တမ်းကုန်ဆုံးသွားပါကလည်း မိမိကြိုက်နှစ်သက်ရာအချိန်တွင် ပြန်လည်ကြည့်ရှုနိုင်၊ ဒေါင်းယူနိုင်ပါသည်။`;
            }
            if (!title) {
                let maxNum = 0;
                const latestLive = await getMoviesByCategory("4K Porns", 1);
                if (latestLive.length > 0) {
                    const num = parseInt(latestLive[0].title);
                    if (!isNaN(num)) maxNum = num;
                }
                const draftIter = kv.list<Movie>({ prefix: ["drafts"] });
                for await (const entry of draftIter) {
                    if (entry.value.category === "4K Porns") {
                        const dNum = parseInt(entry.value.title);
                        if (!isNaN(dNum) && dNum > maxNum) maxNum = dNum;
                    }
                }
                title = String(maxNum + 1);
            }
        }

        if (!title) {
            return c.redirect(ADMIN_ROUTE + "/dashboard?error=Title is required!");
        }

        const epString = body["episodeList"] as string; 
        const episodes: Episode[] = []; 
        if(epString && epString.trim().length > 0) { 
            epString.split('\n').forEach(line => { 
                const parts = line.split('|'); 
                if(parts.length === 3) { 
                    episodes.push({ season: parts[0].trim(), name: parts[1].trim(), url: parts[2].trim() }); 
                } else if(parts.length === 2) { 
                    episodes.push({ season: "", name: parts[0].trim(), url: parts[1].trim() }); 
                } 
            }); 
        } 
        
        let id = body["id"] as string;
        const existingLive = await kv.get(["movies", id]);
        
        if (body["mode"] === "create" && existingLive.value && saveType === "publish") { 
            id = crypto.randomUUID(); 
        }
        
        let timeToSave = Number(body["createdAt"]) || Date.now();
        if (saveType === "publish") { 
            if (!existingLive.value || isMoveToTop) { 
                timeToSave = Date.now(); 
            } 
        }
        
        const movie = { 
            ...body, 
            title: title, 
            description: description,
            id: id, 
            createdAt: timeToSave, 
            episodes, 
            price: price,
            duration: duration 
        }; 
        
        if (saveType === "draft") { 
            await kv.set(["drafts", id], movie); 
            return c.redirect(ADMIN_ROUTE + "/dashboard?tab=drafts&success=Saved to Drafts (" + title + ")"); 
        } else { 
            await kv.delete(["drafts", id]); 
            await saveMovieDB(movie as Movie); 
            await logAdminAction("publish_movie", `Published ${title}`);
            return c.redirect(ADMIN_ROUTE + "/dashboard?success=Movie Published Live!"); 
        }
    } catch (e) {
        console.error(e);
        return c.text("Error Saving Movie: " + e.message, 500);
    }
});

app.post("/admin/drafts/publish-all", adminGuard, async (c) => { 
    const iter = kv.list<Movie>({ prefix: ["drafts"] }); 
    const drafts: Movie[] = []; 
    for await (const res of iter) drafts.push(res.value); 
    
    // Draft များကို အချိန်စဉ်လိုက်စီမယ်
    drafts.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); 
    
    let count = 0; 
    for (const m of drafts) { 
        
        // 🔥 POWERFUL AUTO CLEANER (အမှိုက်ရှင်းစနစ် အကြီးစား)
        if (m.description) {
            m.description = m.description
                // ၁. &quot; နဲ့ \" အမှိုက်များကို အရင်ရှင်းမည်
                .replace(/\\*&quot;/g, '"')   // \&quot; သို့မဟုတ် &quot; တွေ့ရင် " ပြောင်းမယ်
                .replace(/\\+"/g, '"')        // \" တွေ့ရင် " ပြောင်းမယ်
                .replace(/\\/g, "")           // ကျန်နေတဲ့ Backslash (\) တွေကို ဖျက်မယ်
                
                // ၂. HTML Code များကို ရှင်းမည်
                .replace(/&amp;nbsp;/g, " ")
                .replace(/&nbsp;/g, " ")
                .replace(/&amp;/g, "&")
                .replace(/<[^>]*>?/gm, "")    // <br>, <p> အကုန်ဖျက်မယ်
                
                // ၃. စာသားအကွာအဝေး ညှိမည်
                .replace(/\s+/g, " ")
                .trim();
        }

        m.createdAt = Date.now() + (count * 1000); 
        await saveMovieDB(m); 
        await kv.delete(["drafts", m.id]); 
        count++; 
    } 
    return c.redirect(ADMIN_ROUTE + "/dashboard?success=All Drafts Published & Cleaned!"); 
});
app.post("/admin/draft/delete/:id", adminGuard, async (c) => { await kv.delete(["drafts", c.req.param("id")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=drafts"); });
app.post("/admin/movie/delete/:id", adminGuard, async (c) => { await deleteMovieDB(c.req.param("id")); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Movie Deleted"); });

app.post("/admin/key/create", adminGuard, async (c) => { 
    const { days, type, value } = await c.req.parseBody(); 
    const code = (type === "coin" ? "COIN-" : "VIP-") + Math.random().toString(36).substring(2, 7).toUpperCase(); 
    const keyData: VipKey = { code, days: parseInt(String(days) || "0"), type: type as "vip" | "coin", value: parseInt(String(value) || "0") };
    await kv.set(["keys", code], keyData); 
    await logAdminAction("create_key", `Created ${type} key ${code}`);
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys"); 
});

app.post("/admin/key/delete/:code", adminGuard, async (c) => { await kv.delete(["keys", c.req.param("code")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys"); });
app.post("/admin/user/reset", adminGuard, async (c) => { const { username, newpass } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { user.passwordHash = await hashPassword(String(newpass)); await kv.set(["users", String(username)], user); await logAdminAction("reset_pass", `Reset password for ${username}`); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=Password Updated"); } return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); });
app.post("/admin/user/add-vip", adminGuard, async (c) => { const { username, days } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { const addDays = parseInt(String(days)); const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date(); currentExpiry.setDate(currentExpiry.getDate() + addDays); user.expiryDate = currentExpiry.toISOString(); await kv.set(["users", String(username)], user); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=VIP Added Successfully"); } return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); });
app.post("/admin/user/toggle-ban", adminGuard, async (c) => { const { username } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { user.isBanned = !user.isBanned; const targetIp = user.lastLoginIp || user.ip; if (user.isBanned) { user.sessionId = "banned"; if (targetIp && targetIp !== "Unknown-IP") await kv.set(["banned_ips", targetIp], true); } else { if (targetIp) await kv.delete(["banned_ips", targetIp]); } await kv.set(["users", String(username)], user); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=User & IP Status Updated"); } return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); });
app.get("/admin/backup", adminGuard, async (c) => { 
    const stream = new ReadableStream({ 
        async start(controller) { 
            const encoder = new TextEncoder(); 
            try {
                controller.enqueue(encoder.encode("[")); 
                let first = true; 

                // 🔥 TARGETED BACKUP (လိုအပ်တာတွေပဲ သီးသန့်ရွေးထုတ်မည်)
                // Logs တွေ Sessions တွေကို လုံးဝမထိတော့ပါဘူး
                const targetPrefixes = [
                    ["config"],      // ဆက်တင်များ
                    ["movies"],      // ဇာတ်ကားများ
                    ["users"],       // အသုံးပြုသူများ
                    ["keys"],        // VIP/Coin Keys
                    ["drafts"],      // Drafts
                    ["requests"],    // User Requests
                    ["topups"],      // Manual Topups
                    ["banned_ips"],  // Banned IPs
                    ["counts"],      // Movie Counts
                    ["idx_time"],    // Time Index (Restore လုပ်ရင် ပြန်စီစရာမလိုအောင်)
                    ["idx_cat"]      // Category Index
                ];

                for (const prefix of targetPrefixes) {
                    // တစ်ကန့်စီ လိုက်ဆွဲထုတ်မယ်
                    for await (const entry of kv.list({ prefix: prefix })) { 
                        if (!first) controller.enqueue(encoder.encode(",")); 
                        const item = JSON.stringify({ key: entry.key, value: entry.value }); 
                        controller.enqueue(encoder.encode(item)); 
                        first = false; 
                    }
                }

                controller.enqueue(encoder.encode("]")); 
            } catch (e) {
                console.error("Backup Failed:", e);
            } finally {
                controller.close(); 
            }
        } 
    }); 
    return new Response(stream, { 
        headers: { 
            "Content-Type": "application/json", 
            "Content-Disposition": `attachment; filename="backup_full_${Date.now()}.json"` 
        } 
    }); 
});
app.post("/admin/restore", adminGuard, async (c) => { try { const body = await c.req.parseBody(); const file = body['file']; if (file instanceof File) { const text = await file.text(); const data = JSON.parse(text); for (const item of data) { await kv.set(item.key, item.value); } await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Data Restored"); } } catch(e) { return c.redirect(ADMIN_ROUTE + "/dashboard?error=Restore Failed"); } });

Deno.serve(app.fetch);
