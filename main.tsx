/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const app = new Hono();
const kv = await Deno.openKv();

// =======================
// 1. CONFIG & TRANSLATIONS
// =======================
const SALT = Deno.env.get("SECRET_SALT") || "GOLD_FLIX_SECURE_SALT_FIXED_2026";
let ADMIN_PASS = Deno.env.get("ADMIN_PASSWORD");

if (!ADMIN_PASS) {
  ADMIN_PASS = "admin123"; 
  console.log("⚠️ WARNING: ADMIN_PASSWORD not set. Using default: admin123");
}

const ADMIN_ROUTE = "/soekyawwin";
const ADMIN_SESSION_EXPIRE = 24 * 60 * 60 * 1000; 
const loginAttempts = new Map<string, { count: number, time: number }>();

const i18n: any = {
    en: {
        home: "Home", saved: "Saved", request: "Request", login: "Login", me: "Me",
        search_ph: "Search movies...", featured: "Featured", play: "Play",
        see_all: "View All", views: "Views", dl_help: "How to Download?",
        server1: "Server 1", server2: "Server 2", share: "Share",
        unlock: "Unlock VIP", vip_only: "VIP Exclusive",
        latest_users: "New Members", total_users: "Total Members",
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
        latest_users: "နောက်ဆုံးဝင်သူများ", total_users: "အသုံးပြုသူ စုစုပေါင်း",
        access_denied: "ဝင်ရောက်ခွင့် ပိတ်ပင်ထားသည်", ip_banned: "သင့် IP ကို ပိတ်ပင်ထားပါသည်။",
        security_alert: "လုံခြုံရေး သတိပေးချက်", wait: "ခေတ္တစောင့်ပါ",
        dl_btn: "ဒေါင်းလုပ်"
    }
};

// =======================
// 2. UTILS
// =======================
function getLang(c: any) { return getCookie(c, "app_lang") || "en"; }

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(SALT), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) { loginAttempts.set(ip, { count: 1, time: now }); return true; }
  if (now - record.time > 60 * 1000) { loginAttempts.set(ip, { count: 1, time: now }); return true; }
  if (record.count >= 3) return false; 
  record.count++;
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

async function resolveRedirect(url: string) {
  if (!isValidUrl(url)) return url;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try { 
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal }); 
      clearTimeout(timeoutId); 
      return res.url; 
  } catch { return url; }
}

// =======================
// 3. DATA TYPES
// =======================
interface Episode { season?: string; name: string; url: string; }
interface Movie {
  id: string; title: string; posterUrl: string; coverUrl: string;
  category: "Movies" | "Series" | "Adult" | "All Uncensored"; description: string; tags: string;
  year: string; fileSize?: string;
  streamUrl: string; streamUrl2?: string;
  episodes?: Episode[];
  linkType: "direct" | "embed"; 
  downloadUrl?: string; downloadUrl2?: string;
  createdAt: number;
}
interface MovieSummary { id: string; title: string; posterUrl: string; coverUrl: string; category: string; createdAt: number; }
interface User { username: string; passwordHash: string; expiryDate: string | null; favorites: string[]; sessionId?: string; ip?: string; lastLoginIp?: string; isBanned?: boolean; }
interface VipKey { code: string; days: number; }
interface UserRequest { id: string; username: string; movieName: string; timestamp: number; }
interface AppConfig { announcement: string; showAnnouncement: boolean; globalVipExpiry?: number; }

// =======================
// 4. DB FUNCTIONS
// =======================
async function saveMovieDB(movie: Movie) {
    const summary: MovieSummary = { id: movie.id, title: movie.title, posterUrl: movie.posterUrl, coverUrl: movie.coverUrl, category: movie.category, createdAt: movie.createdAt };
    const old = await kv.get<Movie>(["movies", movie.id]);
    const op = kv.atomic();
    if (old.value) {
        op.delete(["idx_cat", old.value.category, old.value.createdAt, old.value.id]);
        op.delete(["idx_time", old.value.createdAt, old.value.id]);
    }
    op.set(["movies", movie.id], movie);
    op.set(["idx_time", movie.createdAt, movie.id], summary);
    op.set(["idx_cat", movie.category, movie.createdAt, movie.id], summary);
    await op.commit();
}

async function deleteMovieDB(id: string) {
    const movie = await kv.get<Movie>(["movies", id]);
    if (!movie.value) return;
    const m = movie.value;
    const op = kv.atomic();
    op.delete(["movies", id]);
    op.delete(["idx_time", m.createdAt, id]);
    op.delete(["idx_cat", m.category, m.createdAt, id]);
    await op.commit();
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
    const results = []; const q = query.toLowerCase();
    for await (const res of iter) {
        const m = res.value;
        if (m.title.toLowerCase().includes(q) || (m.tags && m.tags.toLowerCase().includes(q))) {
            results.push(m); if (results.length >= 50) break;
        }
    }
    return results;
}

async function reIndexDatabase() {
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    for await (const res of iter) await saveMovieDB(res.value);
}

async function getMovie(id: string) { const res = await kv.get<Movie>(["movies", id]); return res.value; }
async function getUser(username: string) { const res = await kv.get<User>(["users", username]); return res.value; }
async function getKeys() { const iter = kv.list<VipKey>({ prefix: ["keys"] }); const keys = []; for await (const res of iter) keys.push(res.value); return keys; }
async function getRequests() { const iter = kv.list<UserRequest>({ prefix: ["requests"] }); const reqs = []; for await (const res of iter) reqs.push(res.value); return reqs.sort((a,b)=>b.timestamp-a.timestamp); }
async function getConfig() { const res = await kv.get<AppConfig>(["config"]); return res.value || { announcement: "Welcome to Gold Flix!", showAnnouncement: true, globalVipExpiry: 0 }; }

// =======================
// 5. MIDDLEWARE
// =======================
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
    if (c.req.method === "POST") {
        const origin = c.req.header("Origin");
        const referer = c.req.header("Referer");
        const host = c.req.header("Host");
        if ((origin && !origin.includes(host)) || (referer && !referer.includes(host))) {
             return c.text("Security Alert: Cross-Site Request Blocked", 403);
        }
    }
    await next();
};

// =======================
// 6. UI LAYOUT (🔥 UPDATED APP STYLE)
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

  return (
  <html lang={l}>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>{props.title || "Gold Flix"}</title>
      <meta property="og:title" content={props.title || "Gold Flix"} />
      <meta property="og:description" content="Watch high quality movies on Gold Flix." />
      <meta property="og:image" content={props.coverUrl || "https://cdn-icons-png.flaticon.com/512/2503/2503508.png"} />
      <meta property="og:type" content="website" />
      <link rel="manifest" href="/manifest.json" />
      <meta name="theme-color" content="#000000" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&display=swap" rel="stylesheet" />
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      
      <style>{`
        body { background-color: #050505; color: #fff; font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; padding-bottom: 70px; }
        * { user-select: none; -webkit-user-select: none; }
        input, textarea { user-select: text !important; -webkit-user-select: text !important; -webkit-touch-callout: default !important; }
        ${protectCSS}
        
        .input-box { background: #1a1a1a; border: 1px solid #333; color: white; padding: 12px; border-radius: 8px; width: 100%; outline: none; transition: 0.3s; }
        .input-box:focus { border-color: #Eab308; box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.2); }
        .btn-primary { background: linear-gradient(to right, #Eab308, #d97706); color: black; font-weight: 800; padding: 12px 20px; border-radius: 8px; transition: 0.3s; cursor: pointer; border: none; }
        .btn-primary:active { transform: scale(0.95); opacity: 0.9; }
        
        /* 🔥 APP STYLE BOTTOM NAV (Fixed Alignment) */
        .bottom-nav { position: fixed; bottom: 0; left: 0; width: 100%; background: #000; border-top: 1px solid #222; display: flex; justify-content: space-around; padding: 10px 0; z-index: 50; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
        .nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; color: #666; transition: 0.3s; }
        .nav-item i { font-size: 20px; margin-bottom: 4px; }
        .nav-item.active { color: #Eab308; }
        
        /* 🔥 TOP HEADER */
        .top-header { position: fixed; top: 0; left: 0; width: 100%; background: rgba(0,0,0,0.9); backdrop-filter: blur(10px); z-index: 40; padding: 12px 16px; display: flex; justify-content: space-between; items-center; border-bottom: 1px solid #222; }

        /* Announcement Bar (Below Header) */
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
        
        /* Floating Telegram */
        .float-tg { position: fixed; bottom: 80px; right: 20px; z-index: 50; background: #0088cc; color: white; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 4px 15px rgba(0,136,204,0.4); transition: transform 0.3s; text-decoration: none; }
        .float-tg:active { transform: scale(0.9); }

        .tab-btn.active { background: #Eab308; color: black; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 12px; padding-bottom: 20px; scroll-snap-type: x mandatory; padding-left: 10px; padding-right: 10px; }
        .h-scroll-item { width: 110px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item.wide { width: 260px; }
        .slider-container { position: relative; width: 100%; aspect-ratio: 16/9; overflow: hidden; }
        .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease-in-out; pointer-events: none; }
        .slide.active { opacity: 1; pointer-events: auto; }
        .modal-enter { animation: modalPop 0.3s ease-out forwards; }
        @keyframes modalPop { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        ${protectJS}
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
             window.toggleHelp = function() { document.getElementById('download-help').classList.toggle('hidden'); }
             window.toggleSeason = function(id) { const el = document.getElementById('season-' + id); const icon = document.getElementById('icon-' + id); if(el) { el.classList.toggle('hidden'); if(icon) icon.classList.toggle('rotate-180'); } }
             window.confirmDownload = function(url, title, size) {
                 const modal = document.getElementById('dl-modal');
                 document.getElementById('dl-title').innerText = title;
                 document.getElementById('dl-size').innerText = size || "Unknown Size";
                 document.getElementById('dl-confirm-btn').href = url;
                 modal.classList.remove('hidden'); modal.classList.add('flex');
             }
             window.closeDlModal = function() { const modal = document.getElementById('dl-modal'); modal.classList.add('hidden'); modal.classList.remove('flex'); }
             window.loadPlayer = async function(content, type, movieId, title, poster, btnElement) {
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
                if(cover) cover.style.display = 'none';
                if(loader) loader.style.display = 'flex';
                let finalUrl = content;
                if (type === 'direct') { try { const res = await fetch('/api/resolve-url?token=' + content); const data = await res.json(); if (data.url) finalUrl = data.url; } catch (e) { console.error(e); } }
                let htmlContent = '';
                if (type === 'embed' || finalUrl.includes('<iframe')) { htmlContent = finalUrl.includes('<iframe') ? finalUrl : '<iframe src="'+finalUrl+'" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>'; setTimeout(() => { if(loader) loader.style.display = 'none'; }, 2000); } else { htmlContent = '<video id="main-video" controls autoplay playsinline class="w-full h-full"><source src="'+finalUrl+'" type="video/mp4"></video>'; }
                container.innerHTML = htmlContent; container.style.display = 'block';
                const video = document.getElementById('main-video');
                if(video) { 
                    video.addEventListener('waiting', () => { if(loader) loader.style.display = 'flex'; }); 
                    video.addEventListener('playing', () => { if(loader) loader.style.display = 'none'; }); 
                    video.addEventListener('error', async () => {
                        console.log("Video Error! Attempting to reconnect...");
                        const currentTime = video.currentTime;
                        video.load();
                        video.currentTime = currentTime;
                        try { await video.play(); } catch(e) {}
                    });
                    video.play().catch(e => console.log("Autoplay prevented")); 
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
                if(category === "All Uncensored") { el.classList.remove('aspect-[2/3]'); el.classList.add('aspect-video'); }
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
                    if(category === "All Uncensored") { 
                        el.className = 'movie-card block bg-[#1f1f1f] rounded overflow-hidden mb-4'; 
                        el.innerHTML = '<img src="'+m.coverUrl+'" class="aspect-video object-cover w-full" /><div class="p-3"><h3 class="text-sm font-bold truncate text-white">'+m.title+'</h3></div>'; 
                    } else { 
                        el.className = 'movie-card block bg-[#1f1f1f] rounded overflow-hidden'; 
                        el.innerHTML = '<img src="'+m.posterUrl+'" class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">'+m.title+'</h3></div>'; 
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

      {!props.hideNav && (
        <>
            {/* 🔥 TOP HEADER (Logo only) */}
            <header class="top-header">
                <a href="/" class="text-xl font-black text-yellow-500 tracking-tighter italic">GOLD FLIX</a>
                {props.isAdmin ? (
                    <a href={ADMIN_ROUTE + "/dashboard"} class="text-xs font-bold bg-blue-600 text-white px-3 py-1.5 rounded-full shadow-lg hover:bg-blue-500 transition">ADMIN PANEL</a>
                ) : (
                    // Language Switcher
                    <a href={l === 'en' ? '/lang/my' : '/lang/en'} class="text-xs font-bold text-gray-400 border border-zinc-700 px-2 py-1 rounded hover:text-white transition">{l === 'en' ? 'MY' : 'EN'}</a>
                )}
            </header>

            {/* 🔥 BOTTOM NAVIGATION (Fixed) */}
            {!props.isAdmin && (
                <nav class="bottom-nav">
                    <a href="/" class={`nav-item ${active === 'home' ? 'active' : ''}`}>
                        <i class="fa-solid fa-house"></i>
                        <span>{t.home}</span>
                    </a>
                    <a href="/favorites" class={`nav-item ${active === 'saved' ? 'active' : ''}`}>
                        <i class="fa-solid fa-heart"></i>
                        <span>{t.saved}</span>
                    </a>
                    <a href="/request" class={`nav-item ${active === 'request' ? 'active' : ''}`}>
                        <i class="fa-solid fa-clapperboard"></i>
                        <span>{t.request}</span>
                    </a>
                    <a href={props.user ? "/profile" : "/login"} class={`nav-item ${active === 'me' ? 'active' : ''}`}>
                        <i class="fa-solid fa-user"></i>
                        <span>{t.me}</span>
                    </a>
                </nav>
            )}
        </>
      )}

      {!props.isAdmin && (
         <a href="https://t.me/LuGyiandYoteshinMovies" target="_blank" class="float-tg">
             <i class="fa-brands fa-telegram"></i>
         </a>
      )}

      {props.announcement && (
          <div class="announcement-bar">
              <i class="fa-solid fa-bullhorn animate-pulse"></i>
              <marquee scrollamount="5">{props.announcement}</marquee>
          </div>
      )}

      {/* Main Content Padding Adjusted for Top/Bottom Bars */}
      <main class={`flex-grow w-full ${props.announcement ? 'pt-[90px]' : 'pt-[60px]'}`}>
        {props.children}
      </main>
    </body>
  </html>
)};

// =======================
// 7. PUBLIC ROUTES & API
// =======================

app.get("/manifest.json", (c) => c.json({ "name": "Gold Flix", "short_name": "GoldFlix", "start_url": "/", "display": "standalone", "background_color": "#000000", "theme_color": "#000000", "icons": [{ "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "192x192", "type": "image/png" }, { "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "512x512", "type": "image/png" }] }));
app.get("/.well-known/assetlinks.json", (c) => c.json([{ "relation": ["delegate_permission/common.handle_all_urls"], "target": { "namespace": "android_app", "package_name": "dev.deno.goldflix_stream.twa", "sha256_cert_fingerprints": ["29:7D:1A:43:86:09:03:FE:02:F9:69:46:5A:F8:B7:C0:9A:14:75:10:F6:F3:07:4F:2E:CF:0E:F1:3E:D4:5F:7D"] } }]));
app.get("/service-worker.js", (c) => c.text(`self.addEventListener('install', (e) => { self.skipWaiting(); }); self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); }); self.addEventListener('fetch', (e) => { if (e.request.mode === 'navigate') { e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); } else { e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request))); } });`, 200, { "Content-Type": "application/javascript" }));

// LANGUAGE SWITCHER ROUTE
app.get("/lang/:code", (c) => {
    const code = c.req.param("code");
    setCookie(c, "app_lang", code === "en" ? "en" : "my", { path: "/", maxAge: 60 * 60 * 24 * 365 });
    return c.redirect(c.req.header("Referer") || "/");
});

// HOME PAGE
app.get("/", async (c) => {
  const user = await getCurrentUser(c);
  c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  c.header('Expires', '-1');
  
  const lang = getLang(c);
  const t = i18n[lang];
  const config = await getConfig();
  const sliderMovies = await getLatestMovies(5);
  const sections = [
      { name: "Movies", data: await getMoviesByCategory("Movies", 8) },
      { name: "Series", data: await getMoviesByCategory("Series", 8) },
      { name: "Adult", data: await getMoviesByCategory("Adult", 8) },
      { name: "All Uncensored", data: await getMoviesByCategory("All Uncensored", 8) }
  ];
  
  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home">
        <div class="px-4 pb-4">
             <form action="/search" method="get" class="relative">
                 <i class="fa-solid fa-magnifying-glass absolute left-4 top-3.5 text-gray-500"></i>
                 <input name="q" placeholder={t.search_ph} class="w-full bg-[#1a1a1a] border border-zinc-800 rounded-full py-3 pl-12 pr-4 text-sm text-white focus:border-yellow-500 outline-none transition shadow-sm" />
             </form>
        </div>
      {sliderMovies.length > 0 && (<div class="slider-container mb-6">{sliderMovies.map((m, idx) => (<div class={`slide ${idx === 0 ? 'active' : ''}`}><img src={m.coverUrl} class="w-full h-full object-cover" /><div class="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent"></div><div class="absolute bottom-6 left-4 right-4"><span class="bg-yellow-500 text-black text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider mb-2 inline-block">{t.featured}</span><h1 class="text-2xl md:text-4xl font-black text-white drop-shadow-lg truncate leading-tight">{m.title}</h1><a href={`/movie/${m.id}`} class="mt-3 inline-flex items-center gap-2 bg-white text-black px-5 py-2 rounded-lg font-bold text-sm hover:scale-105 transition transform shadow-lg"><i class="fa-solid fa-play"></i> {t.play}</a></div></div>))}</div>)}
      
      <div class="px-4 space-y-10 pb-8">
          {sections.map(section => { 
              if (section.data.length === 0) return null; 
              const cat = section.name; 
              const catMovies = section.data; 
              
              if(cat === "All Uncensored") { 
                  return (
                    <div>
                        <div class="flex justify-between items-end mb-4"><h2 class="text-lg font-bold text-white border-l-4 border-yellow-500 pl-3">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1 hover:text-white transition">{t.see_all} <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div>
                        <div class="h-scroll-section custom-scroll">
                            {catMovies.map(m => (
                                <a href={`/movie/${m.id}`} class="h-scroll-item wide block relative bg-[#1f1f1f] rounded-xl overflow-hidden active:scale-95 transition-transform movie-card group">
                                    <div class="aspect-video w-full relative overflow-hidden"><img src={m.coverUrl || m.posterUrl} class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" /><div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center"><i class="fa-solid fa-circle-play text-4xl text-white drop-shadow-lg"></i></div></div>
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
                                <div class="aspect-[2/3] w-full relative overflow-hidden"><img src={m.posterUrl} class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" /><div class="absolute top-1 right-1 bg-yellow-500 text-black text-[8px] font-bold px-1.5 py-0.5 rounded shadow">HD</div></div>
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

app.get("/api/list", async (c) => { const cat = c.req.query("cat") || "Movies"; const page = parseInt(c.req.query("page") || "1"); const limit = 15; const start = (page - 1) * limit; const all = await getMoviesByCategory(cat, 1000); const movies = all.slice(start, start + limit); return c.json({ movies }); });

// CATEGORY PAGE
app.get("/category/:cat", async (c) => { 
    const user = await getCurrentUser(c); 
    const cat = c.req.param("cat"); 
    const config = await getConfig(); 
    const movies = await getMoviesByCategory(cat, 15); 
    const isUncensored = cat === "All Uncensored"; 
    const lang = getLang(c);
    
    return c.html(<Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home"><div class="px-4 py-6"><div class="flex justify-between items-center mb-6"><h1 class="text-2xl font-bold text-white flex items-center gap-3"><a href="/" class="text-gray-400 hover:text-white"><i class="fa-solid fa-arrow-left"></i></a> {cat}</h1><span class="bg-yellow-500 text-black text-[10px] px-2 py-1 rounded font-bold tracking-wider">{movies.length}+ ITEMS</span></div><div id="movie-grid" class={isUncensored ? "space-y-4" : "grid grid-cols-3 gap-3"}>{movies.map(m => (<a href={`/movie/${m.id}`} class={`block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group ${isUncensored ? 'mb-4' : ''}`}><div class={`relative overflow-hidden ${isUncensored ? "aspect-video" : "aspect-[2/3]"}`}><img src={isUncensored ? (m.coverUrl || m.posterUrl) : m.posterUrl} class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" /></div><div class={isUncensored ? "p-3" : "p-2"}><h3 class={isUncensored ? "text-sm font-bold truncate text-white" : "text-[11px] font-bold truncate text-white"}>{m.title}</h3></div></a>))}</div></div></Layout>); 
});

app.get("/search", async (c) => { const user = await getCurrentUser(c); const query = c.req.query("q")?.toLowerCase() || ""; const config = await getConfig(); const results = await searchMoviesDB(query); const lang = getLang(c); return c.html(<Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home"><div class="p-4"><div class="flex items-center gap-3 mb-6"><a href="/" class="text-gray-400 hover:text-white"><i class="fa-solid fa-arrow-left"></i></a><form action="/search" method="get" class="flex-grow relative"><input name="q" value={query} placeholder="Search..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-xl py-3 px-4 text-sm outline-none focus:border-yellow-500" /></form></div><h2 class="text-sm text-gray-400 mb-4">Results for "{query}" ({results.length})</h2><div class="grid grid-cols-3 gap-3">{results.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group"><div class="aspect-[2/3] relative overflow-hidden"><img src={m.posterUrl} class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" /></div><div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div></Layout>); });
app.get("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const config = await getConfig(); const lang = getLang(c); return c.html(<Layout user={user} title="Request" announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="request"><div class="p-6 max-w-md mx-auto min-h-[70vh] flex flex-col justify-center"><h1 class="text-3xl font-black mb-2 text-yellow-500">Request Movie</h1><p class="text-gray-400 text-sm mb-8">Can't find what you're looking for? Let us know!</p><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name (e.g. Iron Man)" required class="input-box" /><button class="btn-primary w-full">Submit Request</button></form></div></Layout>); });
app.post("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const { movieName } = await c.req.parseBody(); const req: UserRequest = { id: crypto.randomUUID(), username: user.username, movieName: String(movieName), timestamp: Date.now() }; await kv.set(["requests", req.id], req); return c.redirect("/request?success=Request Submitted!"); });
app.get("/favorites", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const lang = getLang(c);
    const favs = [];
    if(user.favorites) { for(const id of user.favorites) { const m = await getMovie(id); if(m) favs.push(m); } }
    return c.html(<Layout user={user} title="Saved" lang={lang} activeTab="saved"><div class="p-4"><h1 class="text-2xl font-bold mb-6 flex items-center gap-2"><i class="fa-solid fa-heart text-red-600"></i> My Saved Movies</h1><div class="grid grid-cols-3 gap-3">{favs.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded-xl overflow-hidden movie-card group"><div class="aspect-[2/3] relative overflow-hidden"><img src={m.posterUrl} class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" /></div><div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div>{favs.length===0 && <p class="text-gray-500 text-center mt-10">No saved movies.</p>}</div></Layout>); 
});
app.post("/api/fav", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { movieId } = await c.req.parseBody(); const id = String(movieId); if (!user.favorites) user.favorites = []; if (user.favorites.includes(id)) user.favorites = user.favorites.filter(f => f !== id); else user.favorites.push(id); await kv.set(["users", user.username], user); return c.redirect(c.req.header("Referer") || "/"); });
app.get("/stream/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Link Expired or Invalid", 403); return c.redirect(entry.value as string); });
app.get("/dl/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Download Link Expired", 403); return c.redirect(entry.value as string); });

app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const movie = await getMovie(id);
    const user = await getCurrentUser(c);
    const config = await getConfig();
    const lang = getLang(c);
    const t = i18n[lang];

    if (!movie) return c.text("Not Found", 404);
  
    const premium = isPremium(user, config);
    const isFav = user?.favorites?.includes(id);
    const displayImage = movie.coverUrl || movie.posterUrl; 
    const related = (await getMoviesByCategory(movie.category, 6)).filter(m => m.id !== movie.id);

    let initialStreamUrl = movie.streamUrl;
    let episodes = movie.episodes || [];
    if (movie.category === "Series" && episodes.length > 0) initialStreamUrl = episodes[0].url;
    const seasons: Record<string, Episode[]> = {};
    const ungrouped: Episode[] = [];
    if(episodes) { episodes.forEach(ep => { if(ep.season) { if(!seasons[ep.season]) seasons[ep.season] = []; seasons[ep.season].push(ep); } else { ungrouped.push(ep); } }); }

    let playerUrl = "", secureDownloadUrl = "", secureDownloadUrl2 = "", playerUrl2 = "", playbackToken = "", playbackToken2 = "";
    if (premium) {
        if (movie.linkType === "embed" || initialStreamUrl.includes("<iframe")) { playerUrl = initialStreamUrl; } else { let realUrl = initialStreamUrl; if (movie.linkType === "direct") realUrl = await resolveRedirect(initialStreamUrl); const token = crypto.randomUUID(); await kv.set(["stream_tokens", token], realUrl, { expireIn: 3600 * 3 }); playerUrl = `/stream/${token}`; playbackToken = token; }
        if (movie.streamUrl2) { const token2 = crypto.randomUUID(); await kv.set(["stream_tokens", token2], movie.streamUrl2, { expireIn: 3600 * 3 }); playerUrl2 = `/stream/${token2}`; playbackToken2 = token2; }
        if (movie.downloadUrl) { const dlToken = crypto.randomUUID(); await kv.set(["stream_tokens", dlToken], movie.downloadUrl, { expireIn: 3600 * 3 }); secureDownloadUrl = `/dl/${dlToken}`; }
        if (movie.downloadUrl2) { const dlToken2 = crypto.randomUUID(); await kv.set(["stream_tokens", dlToken2], movie.downloadUrl2, { expireIn: 3600 * 3 }); secureDownloadUrl2 = `/dl/${dlToken2}`; }
    }
  
    return c.html(
      <Layout user={user} title={movie.title} coverUrl={movie.coverUrl} announcement={config.showAnnouncement ? config.announcement : undefined} lang={lang} activeTab="home">
        <div class="max-w-4xl mx-auto">
           <div class="w-full aspect-video bg-black relative shadow-lg group">
           {premium ? (
    <>
      <div id="video-cover" class="absolute inset-0 z-20"><img src={displayImage} class="w-full h-full object-cover" /></div>
      <div id="video-player" class="w-full h-full hidden"></div>
    </>
) : (
                  <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 z-30"><img src={displayImage} class="absolute inset-0 w-full h-full object-cover opacity-30 blur-sm" /><div class="relative z-40 text-center"><i class="fa-solid fa-lock text-5xl text-yellow-500 mb-4 drop-shadow-lg"></i><h2 class="text-2xl font-black text-white mb-2">{t.vip_only}</h2><p class="text-gray-400 text-sm mb-6">Join VIP to watch this content.</p><a href={user ? "/profile" : "/login"} class="btn-primary inline-block text-sm">{t.unlock}</a></div></div>
              )}
           </div>
           
           <div class="p-6">
               <div class="flex justify-between items-start mb-3">
                   <h1 class="text-3xl font-black text-white leading-tight flex-grow">{movie.title}</h1>
                   <div class="flex gap-3 flex-shrink-0">
                       {/* 🔥 SHARE ICON MOVED HERE */}
                       <button onclick={`shareMovie('${movie.title}')`} class="text-2xl p-2 text-zinc-400 hover:text-white transition"><i class="fa-solid fa-share-nodes"></i></button>
                       {user && (<form action="/api/fav" method="post"><input type="hidden" name="movieId" value={movie.id} /><button class="text-2xl p-2 transition hover:scale-110"><i class={`fa-solid fa-heart ${isFav ? 'text-red-600' : 'text-zinc-600'}`}></i></button></form>)}
                   </div>
               </div>
               <div class="flex items-center gap-3 text-xs text-gray-400 mb-6"><span class="bg-zinc-800 px-3 py-1 rounded-full border border-zinc-700">{movie.year}</span><span class="text-yellow-500 font-bold border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 rounded-full">{movie.category}</span><span class="bg-zinc-800 px-3 py-1 rounded-full border border-zinc-700">{movie.fileSize || "HD"}</span></div>

               {premium && (
                   <div class="flex flex-col gap-3 mb-8">
                        {/* 🔥 PLAYER BUTTONS (GRID LAYOUT - SHARE REMOVED) */}
                        {movie.category !== "Series" && (
                            <div class="grid grid-cols-2 gap-2">
                                <button onclick={`loadPlayer('${movie.linkType === 'direct' ? playbackToken : playerUrl}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}', this)`} class="srv-btn w-full bg-white text-black font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 active:scale-95 transition hover:brightness-110 shadow-lg text-xs">
                                    <i class="fa-solid fa-play"></i> {movie.streamUrl2 ? t.server1 : t.play}
                                </button>
                                {movie.streamUrl2 && (
                                    <button onclick={`loadPlayer('${movie.linkType === 'direct' ? playbackToken2 : playerUrl2}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}', this)`} class="srv-btn w-full bg-zinc-800 text-white font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 active:scale-95 transition hover:bg-zinc-700 border border-zinc-700 text-xs">
                                        <i class="fa-solid fa-server"></i> {t.server2}
                                    </button>
                                )}
                            </div>
                        )}
                        {/* Download Buttons Grid */}
                        {movie.category !== "Series" && (secureDownloadUrl || secureDownloadUrl2) && (
                             <div class="grid grid-cols-2 gap-2 mt-1">
                                {secureDownloadUrl && (<button onclick={`confirmDownload('${secureDownloadUrl}', '${movie.title.replace(/'/g, "\\'")}', '${movie.fileSize || ""}')`} class="w-full bg-zinc-800 text-white font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 text-xs"><i class="fa-solid fa-download"></i> DL 1</button>)}
                                {secureDownloadUrl2 && (<button onclick={`confirmDownload('${secureDownloadUrl2}', '${movie.title.replace(/'/g, "\\'")}', '${movie.fileSize || ""}')`} class="w-full bg-zinc-800 text-white font-bold py-3 px-2 rounded-xl flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 text-xs"><i class="fa-solid fa-download"></i> DL 2</button>)}
                             </div>
                        )}
                       
                       <button onclick="toggleHelp()" class="text-xs text-yellow-500 hover:text-yellow-400 flex items-center gap-1 mt-2 font-bold justify-center"><i class="fa-solid fa-circle-question"></i> {t.dl_help}</button>
                       <div id="download-help" class="hidden bg-zinc-900 border border-yellow-600/30 rounded-xl p-4 text-xs text-gray-300 space-y-3 mt-1"><p><strong class="text-yellow-500">Method 1 - Direct Download</strong><br/>Click the DL buttons above. If play starts, look for download icon in player.</p><hr class="border-zinc-700"/><p><strong class="text-yellow-500">Method 2 - Video Player</strong><br/>1. Play video.<br/>2. Click 3 dots (<i class="fa-solid fa-ellipsis-vertical"></i>).<br/>3. Select 'Download'.</p></div>
                   </div>
               )}

               {movie.category === "Series" && episodes.length > 0 && premium && ( <div class="mb-8 space-y-3">{ungrouped.length > 0 && (<div class="grid grid-cols-3 md:grid-cols-4 gap-2">{ungrouped.map(ep => (<button onclick={`loadPlayer('${ep.url}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="bg-zinc-800 hover:bg-yellow-500 hover:text-black text-xs py-3 px-1 rounded-lg truncate text-center border border-zinc-700 transition-colors font-bold">{ep.name}</button>))}</div>)}{Object.keys(seasons).map(season => { const safeId = season.replace(/\s+/g, '-'); return (<div class="border border-zinc-800 rounded-xl bg-[#1f1f1f] overflow-hidden"><button onclick={`toggleSeason('${safeId}')`} class="w-full flex justify-between items-center p-4 text-sm font-bold text-gray-300 hover:bg-zinc-800 transition"><span>{season}</span><i id={`icon-${safeId}`} class="fa-solid fa-chevron-down transition-transform"></i></button><div id={`season-${safeId}`} class="hidden p-3 grid grid-cols-3 gap-2 border-t border-zinc-800 bg-black/20">{seasons[season].map(ep => (<button onclick={`loadPlayer('${ep.url}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="bg-zinc-800 hover:bg-yellow-500 hover:text-black text-xs py-2.5 px-1 rounded-lg truncate text-center border border-zinc-700 transition-colors font-bold">{ep.name}</button>))}</div></div>) })}</div> )}
               <p class="text-sm text-gray-300 leading-relaxed mb-8">{movie.description}</p>
               {related.length > 0 && (<div class="pt-6 border-t border-zinc-800"><h3 class="font-bold text-white mb-4 text-lg">You May Also Like</h3><div class="h-scroll-section custom-scroll">{related.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item block relative bg-[#1f1f1f] rounded-xl overflow-hidden w-32 flex-shrink-0 movie-card group"><div class="aspect-[2/3] w-full relative overflow-hidden"><img src={m.posterUrl} class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition duration-500" /></div><div class="p-2"><h3 class="text-[11px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div>)}
           </div>
        </div>
      </Layout>
    );
});

// AUTH
app.get("/login", (c) => {
    const lang = getLang(c);
    const t = i18n[lang];
    return c.html(<Layout hideNav={true} lang={lang} activeTab="me"><div class="min-h-[80vh] flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-4xl font-black text-yellow-500 mb-8 text-center italic tracking-tighter">GOLD FLIX</h1><form action="/login" method="post" class="bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 space-y-5 shadow-2xl"><h2 class="text-xl font-bold text-white">{t.login}</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><label class="flex items-center text-gray-400 text-xs"><input type="checkbox" name="remember" class="mr-2 accent-yellow-500" /> Remember Me (7 Days)</label><button class="btn-primary w-full shadow-lg hover:shadow-yellow-500/20">{t.login}</button><p class="text-xs text-gray-500 text-center mt-2">No account? <a href="/signup" class="text-white font-bold hover:text-yellow-500 transition">Sign up</a></p></form></div></div></Layout>);
});

// 🔥 LOGIN ROUTE (🔥 IP BLACKLIST CHECK + UI FIX 🔥)
app.post("/login", async (c) => { 
    const ip = getClientIp(c);
    const lang = getLang(c);
    const t = i18n[lang];

    // 1. IP Ban Check
    if (await isIpBanned(ip)) {
        return c.html(
            <Layout hideNav={true} title="Access Denied" lang={lang}>
                <div class="min-h-screen flex items-center justify-center bg-black p-4">
                    <div class="bg-[#1f1f1f] p-8 rounded-2xl border border-red-600 text-center max-w-sm w-full shadow-2xl relative overflow-hidden">
                        <div class="absolute inset-0 bg-red-600/10 blur-xl"></div>
                        <div class="relative z-10">
                            <i class="fa-solid fa-ban text-6xl text-red-600 mb-6 drop-shadow-[0_0_10px_rgba(220,38,38,0.5)]"></i>
                            <h1 class="text-2xl font-black text-white mb-2 uppercase tracking-widest">{t.access_denied}</h1>
                            <p class="text-gray-400 text-sm mb-6 leading-relaxed">
                                {t.ip_banned} <span class="font-mono text-red-400 bg-red-900/20 px-1 rounded">{ip}</span>
                            </p>
                            <div class="text-[10px] text-gray-600 uppercase font-bold tracking-wider">Contact Admin for Support</div>
                        </div>
                    </div>
                </div>
            </Layout>
        );
    }

    // 2. Rate Limit Check (Red Shield UI)
    if (!checkRateLimit(ip)) {
        return c.html(
            <Layout hideNav={true} title="Security Alert" lang={lang}>
                <div class="min-h-screen flex items-center justify-center bg-black p-4 relative overflow-hidden">
                    <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-red-600/20 blur-[100px] rounded-full pointer-events-none"></div>
                    <div class="relative z-10 bg-[#1f1f1f] p-8 rounded-2xl border border-red-500/30 shadow-2xl max-w-sm w-full text-center">
                        <div class="w-20 h-20 bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-6 border border-red-500/20"><i class="fa-solid fa-shield-halved text-4xl text-red-500 animate-pulse"></i></div>
                        <h1 class="text-xl font-bold text-white mb-2">{t.security_alert}</h1>
                        <p class="text-gray-400 text-sm mb-6 leading-relaxed">Too many failed attempts. Please wait.</p>
                        <div class="bg-black/50 rounded-lg p-3 border border-red-900/50 mb-6"><p class="text-yellow-500 text-xs font-bold uppercase tracking-wider">{t.wait}</p><p class="text-white font-mono text-lg font-bold">1 Minute</p></div>
                        <a href="/login" class="block w-full bg-zinc-700 hover:bg-zinc-600 text-white font-bold py-3 rounded-lg transition border border-zinc-600">Back to Login</a>
                    </div>
                </div>
            </Layout>
        );
    }

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

app.get("/signup", (c) => c.html(<Layout hideNav={true} lang={getLang(c)} activeTab="me"><div class="min-h-[80vh] flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-3xl font-black text-yellow-500 mb-8 text-center italic tracking-tighter">GOLD FLIX</h1><form action="/signup" method="post" class="bg-[#1f1f1f] p-8 rounded-2xl border border-zinc-800 space-y-5 shadow-2xl"><h2 class="text-xl font-bold text-white">Create Account</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full shadow-lg hover:shadow-yellow-500/20">Sign Up</button><p class="text-xs text-gray-500 text-center mt-2">Has account? <a href="/login" class="text-white font-bold hover:text-yellow-500 transition">Login</a></p></form></div></div></Layout>));

// 🔥 SIGNUP ROUTE (🔥 IP BLACKLIST CHECK + UI FIX 🔥)
app.post("/signup", async (c) => { 
    const clientIp = getClientIp(c);
    const lang = getLang(c);
    const t = i18n[lang];

    // 1. IP Ban Check
    if (await isIpBanned(clientIp)) {
        return c.html(
            <Layout hideNav={true} title="Access Denied" lang={lang}>
                <div class="min-h-screen flex items-center justify-center bg-black p-4">
                    <div class="bg-[#1f1f1f] p-8 rounded-2xl border border-red-600 text-center max-w-sm w-full shadow-2xl relative overflow-hidden">
                        <div class="absolute inset-0 bg-red-600/10 blur-xl"></div>
                        <div class="relative z-10">
                            <i class="fa-solid fa-ban text-6xl text-red-600 mb-6 drop-shadow-[0_0_10px_rgba(220,38,38,0.5)]"></i>
                            <h1 class="text-2xl font-black text-white mb-2 uppercase tracking-widest">{t.access_denied}</h1>
                            <p class="text-gray-400 text-sm mb-6 leading-relaxed">
                                {t.ip_banned} <span class="font-mono text-red-400 bg-red-900/20 px-1 rounded">{clientIp}</span>
                            </p>
                        </div>
                    </div>
                </div>
            </Layout>
        );
    }

    const { username, password } = await c.req.parseBody(); 
    if (await getUser(username as string)) return c.redirect("/signup?error=User already exists!"); 
    
    const passwordHash = await hashPassword(password as string); 
    
    const newUser: User = { 
        username: String(username), 
        passwordHash, 
        expiryDate: null, 
        favorites: [], 
        sessionId: "",
        ip: clientIp,           
        lastLoginIp: clientIp,  
        isBanned: false         
    }; 
    
    await kv.set(["users", String(username)], newUser); 
    return c.redirect("/login?success=Account created successfully!"); 
});

// PROFILE UI
app.get("/profile", async (c) => { 
    const user = await getCurrentUser(c); 
    if (!user) return c.redirect("/login"); 
    const config = await getConfig(); 
    const premium = isPremium(user, config); 
    const isGlobal = config.globalVipExpiry && config.globalVipExpiry > Date.now();
    const globalDaysLeft = isGlobal ? Math.ceil((config.globalVipExpiry! - Date.now()) / 86400000) : 0;
    const personalDaysLeft = user.expiryDate ? Math.ceil((new Date(user.expiryDate).getTime() - Date.now()) / 86400000) : 0;
    
    const finalDays = Math.max(globalDaysLeft, personalDaysLeft);
    const progress = Math.min(100, (finalDays / 30) * 100); 
    const statusText = premium ? "VIP Active" : "Free Member";
    const memberId = `GF-${user.username.toUpperCase().slice(0,3)}-${new Date().getFullYear()}`;
    const favCount = user.favorites ? user.favorites.length : 0;
    const lang = getLang(c);
    const t = i18n[lang];

    const plans = [
        { name: "1 Month", price: "700 Ks", days: 30, features: ["Unlock All Movies", "Download Access", "18+ Uncensored"] },
        { name: "3 Months", price: "1,500 Ks", days: 90, popular: true, features: ["Unlock All Movies", "Download Access", "18+ Uncensored", "Fast Servers"] },
        { name: "5 Months", price: "2,200 Ks", days: 150, features: ["Unlock All Movies", "Download Access", "18+ Uncensored", "Fast Servers"] },
        { name: "1 Year", price: "5,000 Ks", days: 365, features: ["Everything Unlocked", "VIP Support", "Download Access", "Fast Servers"] }
    ]; 

    return c.html(
      <Layout user={user} lang={lang} activeTab="me">
        <div class="p-4 max-w-4xl mx-auto space-y-6">
            <div class="relative w-full aspect-[1.7/1] rounded-2xl bg-gradient-to-br from-yellow-400 via-yellow-600 to-yellow-700 p-6 shadow-2xl text-black flex flex-col justify-between overflow-hidden">
                <div class="absolute top-0 right-0 p-3 opacity-20"><i class="fa-solid fa-crown text-9xl"></i></div>
                <div class="relative z-10 flex justify-between items-start">
                     <div class="flex items-center gap-4">
                         <div class="w-14 h-14 bg-black text-yellow-500 rounded-full flex items-center justify-center text-3xl font-black border-2 border-white shadow-lg">{user.username[0].toUpperCase()}</div>
                         <div><h2 class="text-2xl font-black tracking-tight">{user.username}</h2><div class="text-[11px] font-bold bg-black/20 px-3 py-1 rounded-full inline-block uppercase tracking-wider">{statusText}</div></div>
                     </div>
                     <i class="fa-solid fa-wifi text-2xl opacity-70"></i>
                </div>
                <div class="relative z-10 flex justify-between items-end font-mono mt-4">
                    <div><p class="text-[9px] uppercase opacity-70 font-bold mb-0.5">Member ID</p><p class="text-lg font-bold tracking-widest">{memberId}</p></div>
                    <div class="text-right"><p class="text-[9px] uppercase opacity-70 font-bold mb-0.5">Expires</p><p class="text-xs sm:text-sm font-bold">{premium ? `${finalDays} Days Left` : "Not Active"}</p></div>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
                 <div class="bg-[#1f1f1f] p-5 rounded-2xl border border-zinc-800 flex flex-col justify-center items-center gap-2">
                     <i class="fa-solid fa-heart text-red-500 text-2xl drop-shadow-md"></i>
                     <div class="text-center"><span class="block text-3xl font-bold text-white">{favCount}</span><span class="text-xs text-gray-500 font-bold">Saved Movies</span></div>
                 </div>
                 <div class="bg-[#1f1f1f] p-5 rounded-2xl border border-zinc-800 flex flex-col justify-center">
                     <div class="flex justify-between text-xs text-gray-400 mb-2 font-bold"><span>VIP Status</span><span>{progress > 100 ? 100 : Math.round(progress)}%</span></div>
                     <div class="w-full bg-black h-2.5 rounded-full overflow-hidden border border-zinc-700"><div class={`h-full ${premium ? 'bg-gradient-to-r from-yellow-500 to-yellow-300' : 'bg-gray-700'}`} style={{width: `${premium ? progress : 0}%`}}></div></div>
                     <p class="text-[10px] text-gray-500 mt-2 text-center">{premium ? "Enjoy your premium access!" : "Upgrade to watch movies."}</p>
                 </div>
            </div>

            <div class="bg-[#1f1f1f] p-6 rounded-2xl border border-yellow-500/30 relative overflow-hidden group">
                 <div class="absolute -top-4 -right-4 opacity-10 rotate-12 transition-transform group-hover:rotate-0"><i class="fa-solid fa-gift text-9xl text-yellow-500"></i></div>
                 <h3 class="font-bold mb-4 text-white relative z-10 flex items-center gap-2 text-lg"><i class="fa-solid fa-ticket text-yellow-500"></i> Redeem Voucher</h3>
                 <form action="/profile/redeem" method="post" class="relative z-10 flex gap-2"><input name="key" placeholder="Enter VIP Code..." required class="bg-black border border-zinc-700 text-white px-4 py-3 rounded-xl w-full outline-none focus:border-yellow-500 transition" /><button class="bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold px-6 py-3 rounded-xl hover:brightness-110 shadow-lg whitespace-nowrap"><i class="fa-solid fa-check"></i></button></form>
            </div>

            <div>
                <h3 class="font-bold text-xl text-white mb-4 flex items-center gap-2"><i class="fa-solid fa-layer-group text-blue-500"></i> Premium Plans</h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {plans.map(p => (
                        <div class={`relative bg-[#1f1f1f] p-5 rounded-2xl border ${p.popular ? 'border-yellow-500 shadow-[0_0_20px_rgba(234,179,8,0.15)]' : 'border-zinc-800'} flex flex-col hover:scale-[1.02] transition-transform`}>
                            {p.popular && <div class="absolute -top-3 left-4 bg-yellow-500 text-black text-[10px] font-bold px-3 py-1 rounded-full shadow-md">BEST VALUE</div>}
                            <div class="flex justify-between items-baseline mb-4"><h4 class="text-white font-bold text-lg">{p.name}</h4><span class="text-yellow-500 font-mono font-bold text-xl">{p.price}</span></div>
                            <ul class="space-y-2 mb-6 flex-grow">{p.features.map(f => (<li class="flex items-center gap-2 text-xs text-gray-400"><i class="fa-solid fa-check text-green-500"></i> {f}</li>))}</ul>
                            <a href="https://t.me/iqowoq" target="_blank" class={`block text-center py-3 rounded-xl font-bold text-sm transition ${p.popular ? 'btn-primary shadow-lg hover:shadow-yellow-500/20' : 'bg-zinc-800 text-white hover:bg-zinc-700'}`}>Buy Now</a>
                        </div>
                    ))}
                </div>
            </div>
            <a href="/logout" class="block w-full bg-red-900/20 border border-red-900/50 text-center py-4 rounded-xl text-red-500 font-bold hover:bg-red-900/40 transition mt-8"><i class="fa-solid fa-right-from-bracket mr-2"></i> Log Out</a>
        </div>
      </Layout>
    ); 
});

app.post("/profile/redeem", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { key } = await c.req.parseBody(); const keyData = await kv.get<VipKey>(["keys", String(key)]); if (!keyData.value) return c.redirect("/profile?error=Invalid VIP Key!"); const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date(); currentExpiry.setDate(currentExpiry.getDate() + keyData.value.days); user.expiryDate = currentExpiry.toISOString(); await kv.set(["users", user.username], user); await kv.delete(["keys", String(key)]); return c.redirect("/profile?success=VIP Activated Successfully!"); });
app.get("/logout", (c) => { deleteCookie(c, "auth_session"); return c.redirect("/"); });

// =======================
// 8. ADMIN PANEL
// =======================
app.get(ADMIN_ROUTE, (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action={ADMIN_ROUTE + "/login"} method="post" class="bg-[#1f1f1f] p-8 rounded-2xl w-80 shadow-2xl border border-zinc-800"><h2 class="font-bold text-center mb-6 text-blue-500 text-xl">ADMIN ACCESS</h2><input type="password" name="password" placeholder="Enter Secure Key" class="input-box mb-4 text-center tracking-widest" /><button class="bg-blue-600 text-white w-full py-3 rounded-xl font-bold hover:bg-blue-500 transition shadow-lg shadow-blue-900/20">Unlock Dashboard</button></form></div></Layout>));

app.post(ADMIN_ROUTE + "/login", async (c) => { 
    const { password } = await c.req.parseBody(); 
    if (password === ADMIN_PASS) { 
        const sessionId = crypto.randomUUID();
        await kv.set(["admin_sessions", sessionId], "active", { expireIn: ADMIN_SESSION_EXPIRE });
        setCookie(c, "admin_session_id", sessionId, { path: "/", httpOnly: true, secure: !c.req.url.includes("localhost"), sameSite: "Strict" }); 
        return c.redirect(ADMIN_ROUTE + "/dashboard"); 
    } 
    return c.redirect(ADMIN_ROUTE); 
});

app.get(ADMIN_ROUTE + "/dashboard", adminGuard, async (c) => { 
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    const movies = []; for await (const res of iter) movies.push(res.value);
    movies.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    const keys = await getKeys(); 
    const requests = await getRequests(); 
    const config = await getConfig(); 
    const iterUsers = kv.list<User>({ prefix: ["users"] });
    const userList = []; for await (const res of iterUsers) userList.push(res.value);
    const totalUsers = userList.length;
    const editId = c.req.query("edit"); 
    const editMovie = editId ? movies.find(m => m.id === editId) : null; 
    const epString = editMovie?.episodes?.map(e => (e.season ? `${e.season} | ${e.name} | ${e.url}` : `${e.name} | ${e.url}`)).join('\n') || "";
    const vipDate = config.globalVipExpiry ? new Date(config.globalVipExpiry).toLocaleDateString() : "Inactive";

    return c.html(
        <Layout title="Admin" isAdmin={true}>
            <div class="p-4 bg-black min-h-screen font-sans text-sm">
                <div class="flex justify-between items-center mb-6 bg-[#111] p-4 rounded-xl border border-zinc-800 shadow-sm"><h1 class="font-bold text-blue-500 text-lg flex items-center gap-2"><i class="fa-solid fa-shield-cat"></i> Dashboard</h1><div class="flex gap-2"><a href="/admin/backup" class="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-lg text-xs border border-zinc-700 font-bold"><i class="fa-solid fa-download"></i> Backup</a><form action="/admin/restore" method="post" enctype="multipart/form-data" class="inline"><label class="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-lg text-xs border border-zinc-700 cursor-pointer font-bold"><i class="fa-solid fa-upload"></i> Restore<input type="file" name="file" class="hidden" onchange="this.form.submit()" /></label></form></div></div>
                <div class="flex gap-2 mb-6 overflow-x-auto pb-2 scrollbar-hide"><button id="btn-movies" onclick="openTab('movies')" class="tab-btn active px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Movies</button><button id="btn-keys" onclick="openTab('keys')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">VIP Keys</button><button id="btn-users" onclick="openTab('users')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Users</button><button id="btn-requests" onclick="openTab('requests')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Requests</button><button id="btn-config" onclick="openTab('config')" class="tab-btn px-5 py-2.5 bg-[#111] rounded-full text-xs font-bold text-gray-400 hover:text-white transition whitespace-nowrap border border-zinc-800">Config</button></div>

                {/* TAB 1: MOVIES */}
                <div id="tab-movies" class="tab-content active">
                    <div class="flex flex-col lg:grid lg:grid-cols-3 gap-6">
                        <div class="lg:col-span-1 bg-[#111] p-5 rounded-2xl border border-zinc-800 h-fit lg:sticky lg:top-4 z-10 w-full max-w-[100vw] overflow-hidden shadow-xl">
                            <h2 class="font-bold mb-4 text-sm text-yellow-500 border-b border-zinc-800 pb-3 flex justify-between items-center"><span>{editMovie ? "Edit Movie" : "Add New Movie"}</span>{editMovie && <span class="text-[10px] text-gray-500">ID: {editMovie.id.slice(0,6)}...</span>}</h2>
                            <form action="/admin/movie/save" method="post" class="space-y-4 text-sm w-full">
                                <input type="hidden" name="id" value={editMovie?.id || crypto.randomUUID()} />
                                <input type="hidden" name="createdAt" value={editMovie?.createdAt || Date.now()} />
                                <div class="space-y-2">
                                    <input name="title" placeholder="Movie Title" value={editMovie?.title} required class="input-box w-full bg-black border-zinc-700 focus:border-yellow-500" />
                                    <div class="flex gap-2 w-full">
                                        <select name="category" class="input-box flex-grow min-w-0 bg-black border-zinc-700">
                                            {["Movies","Series","Adult","All Uncensored"].map(o => <option selected={editMovie?.category===o}>{o}</option>)}
                                        </select>
                                        <input name="year" value={editMovie?.year || "2025"} class="input-box w-24 text-center flex-shrink-0 bg-black border-zinc-700" />
                                    </div>
                                </div>
                                <input name="posterUrl" placeholder="Poster URL (Portrait)" value={editMovie?.posterUrl} required class="input-box w-full bg-black border-zinc-700" />
                                <input name="coverUrl" placeholder="Cover URL (Landscape)" value={editMovie?.coverUrl} required class="input-box w-full border-yellow-500/30 bg-black" />
                                <input name="fileSize" placeholder="File Size (e.g. 1.2 GB)" value={editMovie?.fileSize} class="input-box w-full bg-black border-zinc-700" />
                                <div class="p-3 bg-black/40 rounded-xl border border-zinc-800 space-y-2">
                                    <label class="text-[10px] text-gray-500 uppercase font-bold">Main Stream</label>
                                    <select name="linkType" class="input-box text-xs w-full py-2 bg-[#111]">
                                        <option value="direct" selected={editMovie?.linkType==="direct"}>Direct Link (Auto-Resolve)</option>
                                        <option value="embed" selected={editMovie?.linkType==="embed"}>Embed Code / Iframe</option>
                                    </select>
                                    <input name="streamUrl" placeholder="Stream URL (or Episode 1)" value={editMovie?.streamUrl} class="input-box w-full bg-[#111]" />
                                </div>
                                <div class="p-3 bg-black/40 rounded-xl border border-zinc-800">
                                    <label class="text-[10px] text-yellow-500 uppercase font-bold mb-1 block">Series Episodes</label>
                                    <p class="text-[9px] text-gray-500 mb-2">Format: Season | Name | URL</p>
                                    <textarea name="episodeList" placeholder="S1 | Ep.1 | https://..." rows={5} class="input-box w-full font-mono text-xs whitespace-pre overflow-x-auto bg-[#111]">{epString}</textarea>
                                </div>
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <input name="downloadUrl" placeholder="DL Link 1" value={editMovie?.downloadUrl} class="input-box w-full text-xs border-green-900/30 focus:border-green-500 bg-black" />
                                    <input name="downloadUrl2" placeholder="DL Link 2" value={editMovie?.downloadUrl2} class="input-box w-full text-xs border-green-900/30 focus:border-green-500 bg-black" />
                                </div>
                                <div class="p-3 bg-black/40 rounded-xl border border-zinc-800">
                                    <label class="text-[10px] text-gray-500 uppercase font-bold">Backup Server (Opt)</label>
                                    <input name="streamUrl2" placeholder="Stream URL 2" value={editMovie?.streamUrl2} class="input-box w-full mt-1 bg-[#111]" />
                                </div>
                                <textarea name="description" placeholder="Movie Synopsis / Description..." class="input-box w-full h-24 bg-black border-zinc-700">{editMovie?.description}</textarea>
                                <button class="btn-primary w-full py-3 text-sm uppercase tracking-widest shadow-lg shadow-yellow-500/20">{editMovie ? "Update Movie" : "Save Movie"}</button>
                                {editMovie && <a href={ADMIN_ROUTE + "/dashboard"} class="block text-center text-xs text-gray-400 mt-2 py-2 hover:text-white transition">Cancel Edit</a>}
                            </form>
                        </div>
                        <div class="lg:col-span-2 bg-[#111] p-5 rounded-2xl border border-zinc-800 flex flex-col h-[600px] lg:h-[80vh] w-full max-w-[100vw] shadow-xl">
                            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-3">
                                <h2 class="font-bold text-sm text-gray-300">Library <span class="bg-zinc-800 px-2 py-0.5 rounded text-[10px] ml-2 text-white">{movies.length}</span></h2>
                                <input oninput="filterMovies(this.value)" placeholder="Search library..." class="bg-black border border-zinc-700 rounded-lg px-4 py-2 text-xs w-full sm:w-64 outline-none focus:border-blue-500 transition" />
                            </div>
                            <div class="space-y-3 flex-1 overflow-y-auto pr-1 custom-scroll">
                                {movies.map(m => (
                                    <div class="movie-item flex gap-4 p-3 bg-black rounded-xl items-center group relative border border-zinc-800/50 hover:border-zinc-600 transition" data-title={m.title}>
                                        <img src={m.posterUrl} class="w-12 h-16 object-cover rounded-lg flex-shrink-0 shadow-md" />
                                        <div class="flex-grow min-w-0 pr-2">
                                            <div class="font-bold text-sm truncate text-gray-200 group-hover:text-yellow-500 transition">{m.title}</div>
                                            <div class="text-[10px] text-gray-500 mt-1 flex items-center gap-2"><span class="bg-zinc-900 px-1.5 py-0.5 rounded border border-zinc-800">{m.category}</span> <span>{m.year}</span></div>
                                        </div>
                                        <div class="flex gap-2 flex-shrink-0">
                                            <a href={`${ADMIN_ROUTE}/dashboard?edit=${m.id}`} class="text-blue-500 text-xs border border-blue-500/20 bg-blue-500/10 px-3 py-1.5 rounded-lg hover:bg-blue-500 hover:text-white transition font-bold">Edit</a>
                                            <form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Delete this movie?')">
                                                <button class="text-red-500 text-xs border border-red-500/20 bg-red-500/10 px-3 py-1.5 rounded-lg hover:bg-red-500 hover:text-white transition font-bold">Del</button>
                                            </form>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* TAB 2: VIP KEYS */}
                <div id="tab-keys" class="tab-content">
                    <div class="max-w-2xl mx-auto space-y-4">
                        <div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="font-bold mb-4 text-yellow-500 flex items-center gap-2"><i class="fa-solid fa-key"></i> Generate VIP Key</h2><form action="/admin/key/create" method="post" class="flex gap-3"><input type="number" name="days" placeholder="Days (e.g. 30)" required class="input-box flex-grow bg-black border-zinc-700" /><button class="btn-primary w-32 shadow-lg">Generate</button></form></div>
                        <div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="font-bold mb-4 text-gray-300">Active Keys</h2><div class="space-y-3 max-h-[500px] overflow-y-auto custom-scroll">{keys.map(k => (<div class="flex justify-between items-center p-3 bg-black rounded-xl border border-zinc-800/50"><div class="flex items-center gap-3"><span class="text-yellow-500 font-mono font-bold text-lg tracking-wider">{k.code}</span><span class="text-[10px] bg-zinc-900 px-2 py-1 rounded text-gray-400 font-bold border border-zinc-800">{k.days} Days</span></div><div class="flex items-center gap-2"><button onclick={`copyToClip('${k.code}')`} class="text-xs bg-blue-900/20 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-600 hover:text-white transition"><i class="fa-solid fa-copy"></i> Copy</button><form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-xs bg-red-900/20 text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-600 hover:text-white transition"><i class="fa-solid fa-trash"></i></button></form></div></div>))}</div></div>
                    </div>
                </div>

                {/* TAB 3: USERS */}
                <div id="tab-users" class="tab-content">
                    <div class="max-w-4xl mx-auto">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                             <div class="bg-gradient-to-br from-blue-900/20 to-black border border-blue-500/20 p-6 rounded-2xl flex items-center gap-5 shadow-lg">
                                 <div class="w-14 h-14 bg-blue-500/10 rounded-full flex items-center justify-center text-blue-400 text-3xl shadow-inner"><i class="fa-solid fa-users"></i></div>
                                 <div><h3 class="text-xs uppercase text-blue-400 font-bold tracking-widest mb-1">Total Users</h3><p class="text-4xl font-black text-white tracking-tight">{totalUsers}</p></div>
                             </div>
                             <div class="bg-[#111] border border-zinc-800 rounded-2xl overflow-hidden h-64 flex flex-col shadow-lg">
                                 <h3 class="bg-black/50 px-5 py-3 text-xs font-bold text-gray-400 border-b border-zinc-800 flex justify-between backdrop-blur-sm"><span>User Control</span><span>IP / Action</span></h3>
                                 <div class="overflow-y-auto custom-scroll p-3 space-y-2">
                                     {userList.map(u => {
                                         const isVip = u.expiryDate && new Date(u.expiryDate) > new Date();
                                         return (
                                            <div class="flex justify-between items-center bg-black/40 p-2.5 rounded-xl border border-zinc-800/30 hover:border-zinc-700 transition">
                                                <div class="flex items-center gap-3">
                                                    <div class={`w-2.5 h-2.5 rounded-full shadow ${u.isBanned ? 'bg-red-600 shadow-red-500/50' : (isVip ? 'bg-green-500 shadow-green-500/50' : 'bg-gray-500')}`}></div>
                                                    <div>
                                                        <span class={`font-bold block text-xs ${u.isBanned ? 'text-red-500 line-through' : 'text-gray-300'}`}>{u.username}</span>
                                                        <span class="text-[9px] text-gray-600 font-mono">{u.lastLoginIp || u.ip || "Unknown"}</span>
                                                    </div>
                                                </div>
                                                <div class="flex items-center gap-2">
                                                    <span class={isVip ? "text-yellow-500 font-black text-[9px] bg-yellow-500/10 px-1.5 py-0.5 rounded" : "hidden"}>VIP</span>
                                                    <form action="/admin/user/toggle-ban" method="post">
                                                        <input type="hidden" name="username" value={u.username} />
                                                        <button class={`px-3 py-1 rounded-lg text-[9px] font-bold border transition ${u.isBanned ? 'bg-green-500/10 text-green-500 border-green-500/50 hover:bg-green-500 hover:text-black' : 'bg-red-500/10 text-red-500 border-red-500/50 hover:bg-red-500 hover:text-white'}`}>{u.isBanned ? "UNBAN" : "BAN"}</button>
                                                    </form>
                                                </div>
                                            </div>
                                         )
                                     })}
                                 </div>
                             </div>
                        </div>
                        <div class="grid md:grid-cols-2 gap-6">
                            <div class="bg-[#111] p-6 rounded-2xl border border-yellow-500/20 shadow-xl h-fit relative overflow-hidden">
                                <div class="absolute top-0 right-0 p-4 opacity-5"><i class="fa-solid fa-crown text-8xl text-yellow-500"></i></div>
                                <h2 class="font-bold mb-5 text-yellow-500 text-lg flex items-center gap-2 relative z-10"><i class="fa-solid fa-circle-plus"></i> Manual VIP Top-up</h2>
                                <form action="/admin/user/add-vip" method="post" class="space-y-4 relative z-10">
                                    <div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Username</label><input name="username" placeholder="Enter username..." required class="input-box bg-black border-zinc-700" /></div>
                                    <div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Duration (Days)</label><input type="number" name="days" placeholder="e.g. 30" required class="input-box bg-black border-zinc-700" /></div>
                                    <button class="bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold w-full py-3 rounded-xl hover:brightness-110 transition shadow-lg shadow-yellow-500/20">Add VIP Time</button>
                                </form>
                            </div>
                            <div class="bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl h-fit relative overflow-hidden">
                                <div class="absolute top-0 right-0 p-4 opacity-5"><i class="fa-solid fa-lock text-8xl text-blue-500"></i></div>
                                <h2 class="font-bold mb-5 text-blue-500 text-lg flex items-center gap-2 relative z-10"><i class="fa-solid fa-user-lock"></i> Reset Password</h2>
                                <form action="/admin/user/reset" method="post" class="space-y-4 relative z-10">
                                    <div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">Username</label><input name="username" placeholder="Enter username..." required class="input-box bg-black border-zinc-700" /></div>
                                    <div><label class="block text-[10px] uppercase font-bold text-gray-500 mb-1">New Password</label><input name="newpass" placeholder="Enter new password..." required class="input-box bg-black border-zinc-700" /></div>
                                    <button class="bg-blue-600 text-white font-bold w-full py-3 rounded-xl hover:bg-blue-500 transition shadow-lg shadow-blue-500/20">Reset Password</button>
                                </form>
                            </div>
                        </div>
                    </div>
                </div>

                {/* TAB 4: REQUESTS */}
                <div id="tab-requests" class="tab-content"><div class="max-w-3xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800 shadow-xl"><h2 class="font-bold mb-6 text-pink-500 flex items-center gap-2"><i class="fa-solid fa-clapperboard"></i> Movie Requests ({requests.length})</h2><div class="space-y-3">{requests.map(r => (<div class="bg-black p-4 rounded-xl flex justify-between items-center border border-zinc-800/50 hover:border-zinc-700 transition"><div><h3 class="font-bold text-lg text-white">{r.movieName}</h3><p class="text-xs text-gray-500 mt-1">Requested by <span class="text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded font-bold">{r.username}</span> • {new Date(r.timestamp).toLocaleDateString()}</p></div><form action={`/admin/request/delete/${r.id}`} method="post"><button class="text-red-500 hover:text-red-400 p-2 transition bg-red-500/10 rounded-lg hover:bg-red-500 hover:text-white"><i class="fa-solid fa-check"></i> Done</button></form></div>))}</div></div></div>

                {/* TAB 5: CONFIG */}
                <div id="tab-config" class="tab-content">
                    <div class="max-w-xl mx-auto bg-[#111] p-6 rounded-2xl border border-zinc-800 space-y-8 shadow-xl">
                        <div><h2 class="font-bold mb-4 text-gray-300 flex items-center gap-2"><i class="fa-solid fa-bullhorn"></i> Announcement</h2><form action="/admin/config" method="post" class="space-y-4"><div><input name="text" placeholder="Enter message..." value={config.announcement} class="input-box bg-black border-zinc-700" /></div><label class="flex items-center gap-3 p-4 bg-black rounded-xl border border-zinc-800 cursor-pointer hover:border-zinc-600 transition"><input type="checkbox" name="show" checked={config.showAnnouncement} class="accent-yellow-500 w-5 h-5" /><span class="font-bold text-sm text-gray-300">Show Announcement Bar</span></label><button class="btn-primary w-full shadow-lg">Save Changes</button></form></div>
                        <div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-2 text-green-500 flex items-center gap-2"><i class="fa-solid fa-gift"></i> Global VIP Event</h2><p class="text-xs text-gray-500 mb-4">Give VIP access to ALL users until a specific date.</p><div class="bg-black p-4 rounded-xl border border-zinc-800 mb-4 flex justify-between items-center"><span class="text-xs font-bold text-gray-500 uppercase">Status</span> <span class="text-lg font-black text-white">{vipDate}</span></div><form action="/admin/config/vip" method="post" class="flex gap-3"><input type="number" name="days" placeholder="Days" required class="input-box bg-black border-zinc-700 w-24 text-center" /><button class="bg-green-600 text-white font-bold px-4 py-2 rounded-xl hover:bg-green-500 flex-grow shadow-lg shadow-green-900/20">Start Event</button></form><form action="/admin/config/vip-clear" method="post" class="mt-3 text-right"><button class="text-xs text-red-500 hover:text-red-400 font-bold bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20 hover:bg-red-500 hover:text-white transition">End Event</button></form></div>
                        <div class="border-t border-zinc-800 pt-8"><h2 class="font-bold mb-2 text-purple-500 flex items-center gap-2"><i class="fa-solid fa-database"></i> Database</h2><p class="text-xs text-gray-500 mb-4">Re-sync search index if movies are missing.</p><form action="/admin/config/reindex" method="post"><button class="bg-purple-900/30 text-purple-400 border border-purple-500/30 font-bold px-6 py-3 rounded-xl hover:bg-purple-600 hover:text-white w-full transition">Re-Sync Database</button></form></div>
                    </div>
                </div>

            </div>
        </Layout>
    );
});

// Admin Actions
app.post("/admin/config", adminGuard, async (c) => { const body = await c.req.parseBody(); const current = await getConfig(); await kv.set(["config"], { ...current, announcement: body['text'], showAnnouncement: body['show'] === 'on' }); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Message Saved"); });
app.post("/admin/config/vip", adminGuard, async (c) => { const body = await c.req.parseBody(); const days = parseInt(String(body['days'])); const targetDate = Date.now() + (days * 86400000); const current = await getConfig(); await kv.set(["config"], { ...current, globalVipExpiry: targetDate }); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Global VIP Event Started"); });
app.post("/admin/config/vip-clear", adminGuard, async (c) => { const current = await getConfig(); await kv.set(["config"], { ...current, globalVipExpiry: 0 }); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Global Event Cleared"); });
app.post("/admin/config/reindex", adminGuard, async (c) => { await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Database Optimized!"); });
app.post("/admin/request/delete/:id", adminGuard, async (c) => { await kv.delete(["requests", c.req.param("id")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=requests"); });
app.post("/admin/movie/save", adminGuard, async (c) => { const body = await c.req.parseBody(); const epString = body["episodeList"] as string; const episodes: Episode[] = []; if(epString && epString.trim().length > 0) { epString.split('\n').forEach(line => { const parts = line.split('|'); if(parts.length === 3) { episodes.push({ season: parts[0].trim(), name: parts[1].trim(), url: parts[2].trim() }); } else if(parts.length === 2) { episodes.push({ season: "", name: parts[0].trim(), url: parts[1].trim() }); } }); } const movie = { ...body, id: body["id"], createdAt: Number(body["createdAt"]), episodes }; await saveMovieDB(movie as Movie); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Movie Saved"); });
app.post("/admin/movie/delete/:id", adminGuard, async (c) => { await deleteMovieDB(c.req.param("id")); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Movie Deleted"); });
app.post("/admin/key/create", adminGuard, async (c) => { const { days } = await c.req.parseBody(); const code = "VIP-" + Math.random().toString(36).substring(2, 7).toUpperCase(); await kv.set(["keys", code], { code, days: parseInt(String(days)) }); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys"); });
app.post("/admin/key/delete/:code", adminGuard, async (c) => { await kv.delete(["keys", c.req.param("code")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys"); });
app.post("/admin/user/reset", adminGuard, async (c) => { const { username, newpass } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { user.passwordHash = await hashPassword(String(newpass)); await kv.set(["users", String(username)], user); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=Password Updated"); } return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); });
app.post("/admin/user/add-vip", adminGuard, async (c) => { const { username, days } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { const addDays = parseInt(String(days)); const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date(); currentExpiry.setDate(currentExpiry.getDate() + addDays); user.expiryDate = currentExpiry.toISOString(); await kv.set(["users", String(username)], user); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=VIP Added Successfully"); } return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); });

// TOGGLE BAN ACTION
app.post("/admin/user/toggle-ban", adminGuard, async (c) => { 
    const { username } = await c.req.parseBody(); 
    const user = await getUser(String(username)); 
    if (user) { 
        user.isBanned = !user.isBanned; 
        const targetIp = user.lastLoginIp || user.ip; 
        if (user.isBanned) {
            user.sessionId = "banned"; 
            if (targetIp && targetIp !== "Unknown-IP") await kv.set(["banned_ips", targetIp], true);
        } else {
            if (targetIp) await kv.delete(["banned_ips", targetIp]);
        }
        await kv.set(["users", String(username)], user); 
        return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=User & IP Status Updated"); 
    } 
    return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); 
});

app.get("/admin/backup", adminGuard, async (c) => { const data = []; for await (const entry of kv.list({ prefix: [] })) { data.push({ key: entry.key, value: entry.value }); } return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="backup_${Date.now()}.json"` } }); });
app.post("/admin/restore", adminGuard, async (c) => { try { const body = await c.req.parseBody(); const file = body['file']; if (file instanceof File) { const text = await file.text(); const data = JSON.parse(text); for (const item of data) { await kv.set(item.key, item.value); } await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Data Restored"); } } catch(e) { return c.redirect(ADMIN_ROUTE + "/dashboard?error=Restore Failed"); } });

Deno.serve(app.fetch);
