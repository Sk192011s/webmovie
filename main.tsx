/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const app = new Hono();
const kv = await Deno.openKv();

// =======================
// 1. SECURITY & CONFIG
// =======================
const SALT = Deno.env.get("SECRET_SALT") || crypto.randomUUID(); // Auto generate if missing
let ADMIN_PASS = Deno.env.get("ADMIN_PASSWORD");

if (!ADMIN_PASS) {
  ADMIN_PASS = crypto.randomUUID().slice(0, 8);
  console.log("⚠️ WARNING: ADMIN_PASSWORD not set. Using temporary password:", ADMIN_PASS);
}

const ADMIN_ROUTE = "/soekyawwin";
const ADMIN_SESSION_EXPIRE = 24 * 60 * 60 * 1000; // 24 Hours

// Rate Limit Map (In-Memory)
const loginAttempts = new Map<string, { count: number, time: number }>();

// =======================
// 2. UTILS (SECURE)
// =======================

// Secure Password Hashing (PBKDF2 instead of simple SHA-256)
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

// Check Rate Limit (Prevent Brute Force)
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) {
    loginAttempts.set(ip, { count: 1, time: now });
    return true;
  }
  if (now - record.time > 60 * 1000) { // Reset after 1 min
    loginAttempts.set(ip, { count: 1, time: now });
    return true;
  }
  if (record.count >= 5) return false; // Max 5 attempts
  record.count++;
  return true;
}

// Prevent SSRF (Localhost access)
function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostname = u.hostname;
    // Block private ranges (Basic Check)
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
interface User { username: string; passwordHash: string; expiryDate: string | null; favorites: string[]; sessionId?: string; }
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
  return user;
}

function isPremium(user: User | null, config: AppConfig) {
  const now = Date.now();
  if (config.globalVipExpiry && config.globalVipExpiry > now) return true;
  if (!user || !user.expiryDate) return false;
  return new Date(user.expiryDate).getTime() > now;
}

// ADMIN AUTH & CSRF MIDDLEWARE
const adminGuard = async (c: any, next: any) => {
    // 1. Check Session
    const sessionId = getCookie(c, "admin_session_id");
    if (!sessionId) return c.redirect(ADMIN_ROUTE);
    
    const session = await kv.get(["admin_sessions", sessionId]);
    if (!session.value) return c.redirect(ADMIN_ROUTE);

    // 2. CSRF Check for POST methods
    if (c.req.method === "POST") {
        const origin = c.req.header("Origin");
        const referer = c.req.header("Referer");
        const host = c.req.header("Host");
        // Ensure request comes from same domain
        if ((origin && !origin.includes(host)) || (referer && !referer.includes(host))) {
             return c.text("Security Alert: Cross-Site Request Blocked", 403);
        }
    }
    await next();
};

// =======================
// 6. UI LAYOUT
// =======================
const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean; announcement?: string; isAdmin?: boolean }) => {
  const protectCSS = props.isAdmin ? "" : `* { -webkit-touch-callout: none !important; } img { pointer-events: none; }`;
  const protectJS = props.isAdmin ? "" : `
    document.addEventListener('contextmenu', event => {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return; 
        event.preventDefault();
    });
    window.addEventListener('dragstart', event => event.preventDefault());
`;

  return (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>{props.title || "Gold Flix"}</title>
      <link rel="manifest" href="/manifest.json" />
      <meta name="theme-color" content="#000000" />
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <style>{`
        body { background-color: #000; color: #fff; font-family: sans-serif; -webkit-tap-highlight-color: transparent; }
        * { user-select: none; -webkit-user-select: none; }
        input, textarea { user-select: text !important; -webkit-user-select: text !important; -webkit-touch-callout: default !important; }
        ${protectCSS}
        .input-box { background: #333; border: 1px solid #444; color: white; padding: 12px; border-radius: 4px; width: 100%; outline: none; transition: 0.3s; }
        .input-box:focus { border-color: #E50914; }
        .btn-primary { background: #E50914; color: white; font-weight: bold; padding: 10px 20px; border-radius: 4px; transition: 0.3s; cursor: pointer; }
        .btn-primary:active { transform: scale(0.95); }
        .custom-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scroll::-webkit-scrollbar-track { background: #000; }
        .custom-scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        
        #toast-box { position: fixed; top: 20px; right: 20px; z-index: 10000; display: flex; flex-direction: column; gap: 10px; }
        .toast { padding: 15px 20px; border-radius: 8px; color: white; font-weight: bold; display: flex; items-center; gap: 10px; box-shadow: 0 5px 15px rgba(0,0,0,0.5); animation: slideIn 0.5s ease; min-width: 250px; }
        .toast.error { background: #E50914; border-left: 5px solid #ff9999; }
        .toast.success { background: #2ecc71; border-left: 5px solid #a8e6cf; }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        
        #page-loader { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 9999; display: none; justify-content: center; align-items: center; }
        #page-loader.active { display: flex; }
        .spinner { width: 40px; height: 40px; border: 4px solid #333; border-top: 4px solid #E50914; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        
        .skeleton { background: linear-gradient(90deg, #1f1f1f 25%, #2a2a2a 50%, #1f1f1f 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        
        .float-tg { position: fixed; bottom: 80px; right: 20px; z-index: 50; background: #0088cc; color: white; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 4px 15px rgba(0,136,204,0.4); transition: transform 0.3s; text-decoration: none; }
        .float-tg:active { transform: scale(0.9); }

        .tab-btn.active { background: #E50914; color: white; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 10px; padding-bottom: 10px; scroll-snap-type: x mandatory; }
        .h-scroll-item { min-width: 110px; width: 110px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item.wide { min-width: 240px; width: 240px; }
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
             window.loadPlayer = async function(content, type, movieId, title, poster) {
                const container = document.getElementById('video-player');
                const cover = document.getElementById('video-cover');
                const loader = document.getElementById('video-player-loader');
                if(cover) cover.style.display = 'none';
                if(loader) loader.style.display = 'flex';
                let finalUrl = content;
                if (type === 'direct') { try { const res = await fetch('/api/resolve-url?token=' + content); const data = await res.json(); if (data.url) finalUrl = data.url; } catch (e) { console.error(e); } }
                let htmlContent = '';
                if (type === 'embed' || finalUrl.includes('<iframe')) { htmlContent = finalUrl.includes('<iframe') ? finalUrl : '<iframe src="'+finalUrl+'" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>'; setTimeout(() => { if(loader) loader.style.display = 'none'; }, 2000); } else { htmlContent = '<video controls autoplay class="w-full h-full"><source src="'+finalUrl+'" type="video/mp4"></video>'; }
                container.innerHTML = htmlContent; container.style.display = 'block';
                const video = container.querySelector('video');
                if(video) { video.addEventListener('loadeddata', () => { if(loader) loader.style.display = 'none'; }); video.addEventListener('waiting', () => { if(loader) loader.style.display = 'flex'; }); video.addEventListener('playing', () => { if(loader) loader.style.display = 'none'; }); video.play().catch(e => console.log("Autoplay prevented")); }
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
                        el.className = 'block bg-[#1f1f1f] rounded overflow-hidden mb-4'; 
                        el.innerHTML = '<img src="'+m.coverUrl+'" class="aspect-video object-cover w-full" /><div class="p-3"><h3 class="text-sm font-bold truncate text-white">'+m.title+'</h3></div>'; 
                    } else { 
                        el.className = 'block bg-[#1f1f1f] rounded overflow-hidden'; 
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
              <i class="fa-solid fa-cloud-arrow-down text-4xl text-red-600 mb-4"></i>
              <h3 id="dl-title" class="text-lg font-bold text-white mb-2 truncate">Movie Title</h3>
              <p class="text-gray-400 text-sm mb-6">File Size: <span id="dl-size" class="text-yellow-500 font-bold">--</span></p>
              <div class="flex gap-3">
                  <button onclick="closeDlModal()" class="flex-1 py-3 rounded bg-zinc-800 text-white font-bold hover:bg-zinc-700 transition">Cancel</button>
                  <a id="dl-confirm-btn" href="#" target="_blank" onclick="closeDlModal()" class="flex-1 py-3 rounded bg-red-600 text-white font-bold hover:bg-red-700 transition">Yes, Download</a>
              </div>
           </div>
      </div>

      {!props.isAdmin && (
         <a href="https://t.me/LuGyiandYoteshinMovies" target="_blank" class="float-tg">
             <i class="fa-brands fa-telegram"></i>
         </a>
      )}

      {!props.hideNav && (
        <nav class="sticky top-0 z-40 bg-black/95 border-b border-white/10 px-4 py-3 shadow-lg">
          <div class="max-w-7xl mx-auto flex justify-between items-center">
            {props.isAdmin ? (
               <a href={ADMIN_ROUTE + "/dashboard"} class="text-xl font-black text-blue-500 tracking-tighter">ADMIN PANEL</a>
            ) : (
               <a href="/" class="text-xl font-black text-red-600 tracking-tighter italic">GOLD FLIX</a>
            )}
            <div class="flex gap-4 text-xs font-bold text-gray-400">
              {props.isAdmin ? (
                 <>
                   <a href="/" target="_blank" class="hover:text-white">View App</a>
                   <a href="/logout" class="text-red-500">Logout</a>
                 </>
              ) : (
                 <>
                   <a href="/" class="hover:text-white">Home</a>
                   <a href="/favorites" class="hover:text-red-500">Saved</a>
                   <a href="/request" class="hover:text-yellow-500">Request</a>
                   {props.user ? <a href="/profile" class="text-white">Me</a> : <a href="/login">Login</a>}
                 </>
              )}
            </div>
          </div>
        </nav>
      )}

      {props.announcement && (
          <div class="sticky top-[53px] z-30 bg-yellow-500 text-black text-xs font-bold px-4 py-2 flex items-center gap-2 overflow-hidden shadow-md">
              <i class="fa-solid fa-bullhorn animate-pulse"></i>
              <marquee scrollamount="5">{props.announcement}</marquee>
          </div>
      )}

      <main class="flex-grow w-full pb-10">
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

// HOME PAGE
app.get("/", async (c) => {
  const user = await getCurrentUser(c);
  c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  c.header('Expires', '-1');
  
  const config = await getConfig();
  const sliderMovies = await getLatestMovies(5);
  const sections = [
      { name: "Movies", data: await getMoviesByCategory("Movies", 8) },
      { name: "Series", data: await getMoviesByCategory("Series", 8) },
      { name: "Adult", data: await getMoviesByCategory("Adult", 8) },
      { name: "All Uncensored", data: await getMoviesByCategory("All Uncensored", 8) }
  ];
  
  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}>
        <div class="p-3 bg-black sticky top-[50px] z-30 shadow-md">
             <form action="/search" method="get" class="relative">
                 <i class="fa-solid fa-magnifying-glass absolute left-3 top-3 text-gray-500"></i>
                 <input name="q" placeholder="Search movies..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 pl-10 pr-4 text-sm text-white focus:border-red-600 outline-none" />
             </form>
        </div>
      {sliderMovies.length > 0 && (<div class="slider-container">{sliderMovies.map((m, idx) => (<div class={`slide ${idx === 0 ? 'active' : ''}`}><img src={m.coverUrl} /><div class="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/30"></div><div class="absolute bottom-4 left-4 right-4"><span class="bg-red-600 text-[10px] text-white px-2 py-0.5 rounded font-bold">Featured</span><h1 class="text-xl md:text-3xl font-bold text-white drop-shadow-md truncate mt-1">{m.title}</h1><a href={`/movie/${m.id}`} class="mt-2 inline-flex items-center gap-2 bg-white text-black px-4 py-1.5 rounded font-bold text-sm"><i class="fa-solid fa-play"></i> Play</a></div></div>))}</div>)}
      <div class="px-3 py-6 space-y-8">{sections.map(section => { if (section.data.length === 0) return null; const cat = section.name; const catMovies = section.data; if(cat === "All Uncensored") { return (<div><div class="flex justify-between items-end mb-3 px-1"><h2 class="text-lg font-bold text-white border-l-4 border-red-600 pl-2">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1">See All <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div><div class="h-scroll-section custom-scroll">{catMovies.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item wide block relative bg-[#1f1f1f] rounded overflow-hidden active:scale-95 transition-transform"><img src={m.coverUrl || m.posterUrl} /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white leading-tight">{m.title}</h3></div></a>))}</div></div>) } return (<div><div class="flex justify-between items-end mb-3 px-1"><h2 class="text-lg font-bold text-white border-l-4 border-red-600 pl-2">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1">See All <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div><div class="h-scroll-section custom-scroll">{catMovies.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item block relative bg-[#1f1f1f] rounded overflow-hidden active:scale-95 transition-transform"><img src={m.posterUrl} /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white leading-tight">{m.title}</h3></div></a>))}</div></div>) })}</div>
    </Layout>
  );
});

app.get("/api/resolve-url", async (c) => { 
    const token = c.req.query("token"); 
    const entry = await kv.get(["stream_tokens", token]); 
    if (!entry.value) return c.json({ error: "Invalid token" }, 404); 
    // SSRF Check applied here before returning
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
    
    return c.html(<Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}><div class="px-3 py-6"><div class="flex justify-between items-center mb-4"><h1 class="text-xl font-bold text-white flex items-center gap-2"><a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a> {cat}</h1><span class="bg-red-600 text-[10px] px-2 py-1 rounded text-white font-bold tracking-wider">{movies.length}+ ITEMS</span></div><div id="movie-grid" class={isUncensored ? "space-y-4" : "grid grid-cols-3 gap-2"}>{movies.map(m => (<a href={`/movie/${m.id}`} class={`block bg-[#1f1f1f] rounded overflow-hidden ${isUncensored ? 'mb-4' : ''}`}><img src={isUncensored ? (m.coverUrl || m.posterUrl) : m.posterUrl} class={isUncensored ? "aspect-video object-cover w-full" : "aspect-[2/3] object-cover w-full"} /><div class={isUncensored ? "p-3" : "p-1.5"}><h3 class={isUncensored ? "text-sm font-bold truncate text-white" : "text-[10px] font-bold truncate text-white"}>{m.title}</h3></div></a>))}</div></div></Layout>); 
});

app.get("/search", async (c) => { const user = await getCurrentUser(c); const query = c.req.query("q")?.toLowerCase() || ""; const config = await getConfig(); const results = await searchMoviesDB(query); return c.html(<Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}><div class="p-4"><div class="flex items-center gap-3 mb-6"><a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a><form action="/search" method="get" class="flex-grow relative"><input name="q" value={query} placeholder="Search..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 px-4 text-sm outline-none" /></form></div><h2 class="text-sm text-gray-400 mb-4">Results for "{query}" ({results.length})</h2><div class="grid grid-cols-3 gap-2">{results.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div></Layout>); });
app.get("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const config = await getConfig(); return c.html(<Layout user={user} title="Request" announcement={config.showAnnouncement ? config.announcement : undefined}><div class="p-6 max-w-md mx-auto min-h-[70vh] flex flex-col justify-center"><h1 class="text-2xl font-bold mb-4 text-yellow-500">Request Movie</h1><p class="text-gray-400 text-sm mb-6">Can't find what you're looking for? Let us know!</p><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name (e.g. Iron Man)" required class="input-box" /><button class="btn-primary w-full">Submit Request</button></form></div></Layout>); });
app.post("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const { movieName } = await c.req.parseBody(); const req: UserRequest = { id: crypto.randomUUID(), username: user.username, movieName: String(movieName), timestamp: Date.now() }; await kv.set(["requests", req.id], req); return c.redirect("/request?success=Request Submitted!"); });
app.get("/favorites", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); 
    const favs = [];
    if(user.favorites) { for(const id of user.favorites) { const m = await getMovie(id); if(m) favs.push(m); } }
    return c.html(<Layout user={user} title="Saved"><div class="p-4"><h1 class="text-xl font-bold mb-4 flex items-center gap-2"><i class="fa-solid fa-heart text-red-600"></i> My Saved Movies</h1><div class="grid grid-cols-3 gap-2">{favs.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div>{favs.length===0 && <p class="text-gray-500 text-center mt-10">No saved movies.</p>}</div></Layout>); 
});
app.post("/api/fav", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { movieId } = await c.req.parseBody(); const id = String(movieId); if (!user.favorites) user.favorites = []; if (user.favorites.includes(id)) user.favorites = user.favorites.filter(f => f !== id); else user.favorites.push(id); await kv.set(["users", user.username], user); return c.redirect(c.req.header("Referer") || "/"); });
app.get("/stream/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Link Expired or Invalid", 403); return c.redirect(entry.value as string); });
app.get("/dl/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Download Link Expired", 403); return c.redirect(entry.value as string); });

app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const movie = await getMovie(id);
    const user = await getCurrentUser(c);
    const config = await getConfig();
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
      <Layout user={user} title={movie.title} announcement={config.showAnnouncement ? config.announcement : undefined}>
        <div class="max-w-4xl mx-auto">
           <div class="w-full aspect-video bg-black relative shadow-lg group">
           {premium ? (
    <>
      <div id="video-cover" class="absolute inset-0 z-20"><img src={displayImage} class="w-full h-full object-cover" /></div>
      <div id="video-player" class="w-full h-full hidden"></div>
    </>
) : (
                  <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 z-30"><img src={displayImage} class="absolute inset-0 w-full h-full object-cover opacity-20 blur-sm" /><div class="relative z-40 text-center"><i class="fa-solid fa-lock text-4xl text-red-600 mb-2"></i><h2 class="text-lg font-bold text-white">VIP Only</h2><a href={user ? "/profile" : "/login"} class="mt-4 bg-white text-black px-6 py-2 rounded font-bold text-sm inline-block">Unlock</a></div></div>
              )}
           </div>
           
           <div class="p-4">
               <div class="flex justify-between items-start mb-2"><h1 class="text-2xl font-bold text-white leading-tight">{movie.title}</h1>{user && (<form action="/api/fav" method="post"><input type="hidden" name="movieId" value={movie.id} /><button class="text-2xl p-2"><i class={`fa-solid fa-heart ${isFav ? 'text-red-600' : 'text-gray-600'}`}></i></button></form>)}</div>
               <div class="flex items-center gap-2 text-xs text-gray-400 mb-4"><span class="bg-gray-800 px-2 py-0.5 rounded">{movie.year}</span><span class="text-red-500 font-bold border border-red-500/50 px-2 py-0.5 rounded">{movie.category}</span></div>

               {premium && (
                   <div class="flex flex-col gap-2 mb-6">
                        {/* Player Buttons */}
                        {movie.category !== "Series" && (
                            <div class="flex gap-2 overflow-x-auto"><button onclick={`loadPlayer('${movie.linkType === 'direct' ? playbackToken : playerUrl}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="flex-1 bg-white text-black font-bold py-3 px-4 rounded flex items-center justify-center gap-2 active:scale-95 transition hover:bg-gray-200 whitespace-nowrap"><i class="fa-solid fa-play"></i> {movie.streamUrl2 ? "Server 1" : "Play"}</button>{movie.streamUrl2 && (<button onclick={`loadPlayer('${movie.linkType === 'direct' ? playbackToken2 : playerUrl2}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="flex-1 bg-gray-200 text-black font-bold py-3 px-4 rounded flex items-center justify-center gap-2 active:scale-95 transition hover:bg-white whitespace-nowrap"><i class="fa-solid fa-server"></i> Server 2</button>)}<button onclick={`shareMovie('${movie.title}')`} class="bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700"><i class="fa-solid fa-share-nodes"></i> Share</button></div>
                        )}
                        {movie.category !== "Series" && (
                             <div class="flex gap-2">
                                {secureDownloadUrl && (<button onclick={`confirmDownload('${secureDownloadUrl}', '${movie.title.replace(/'/g, "\\'")}', '${movie.fileSize || ""}')`} class="flex-1 bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 whitespace-nowrap text-xs"><i class="fa-solid fa-download"></i> DL {movie.downloadUrl2 ? "1" : ""}</button>)}
                                {secureDownloadUrl2 && (<button onclick={`confirmDownload('${secureDownloadUrl2}', '${movie.title.replace(/'/g, "\\'")}', '${movie.fileSize || ""}')`} class="flex-1 bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 whitespace-nowrap text-xs"><i class="fa-solid fa-download"></i> DL 2</button>)}
                             </div>
                        )}
                       <button onclick="toggleHelp()" class="text-xs text-yellow-500 hover:text-yellow-400 flex items-center gap-1 mt-2"><i class="fa-solid fa-circle-question"></i> ဒေါင်းလုဒ်လုပ်နည်း</button>
                       <div id="download-help" class="hidden bg-zinc-900 border border-yellow-600/50 rounded-lg p-3 text-xs text-gray-300 space-y-2 mt-1"><p><strong class="text-yellow-500">နည်းလမ်း (၁) - Direct Download</strong><br/>Download (သို့) DL ခလုတ်ပါလျှင် နှိပ်၍ ဒေါင်းပါ။ မပါလျှင် Video Play ပြီးမှ ဒေါင်းပါ။</p><hr class="border-zinc-700"/><p><strong class="text-yellow-500">နည်းလမ်း (၂) - Video Player မှတဆင့်</strong><br/>1. Video ကို Play နှိပ်ပါ။<br/>2. Video ဖွင့်လာလျှင် ညာဘက်အောက်ထောင့်က အစက် ၃ စက် (<i class="fa-solid fa-ellipsis-vertical"></i>) ကိုနှိပ်ပါ။<br/>3. 'Download' ကို ရွေးချယ်ပါ။</p></div>
                   </div>
               )}

               {movie.category === "Series" && episodes.length > 0 && premium && ( <div class="mb-6 space-y-2">{ungrouped.length > 0 && (<div class="grid grid-cols-3 md:grid-cols-4 gap-2">{ungrouped.map(ep => (<button onclick={`loadPlayer('${ep.url}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="bg-zinc-800 hover:bg-red-600 text-xs py-3 px-1 rounded truncate text-center border border-zinc-700 transition-colors">{ep.name}</button>))}</div>)}{Object.keys(seasons).map(season => { const safeId = season.replace(/\s+/g, '-'); return (<div class="border border-zinc-800 rounded bg-[#1f1f1f]"><button onclick={`toggleSeason('${safeId}')`} class="w-full flex justify-between items-center p-3 text-sm font-bold text-gray-300 hover:bg-zinc-800 transition"><span>{season}</span><i id={`icon-${safeId}`} class="fa-solid fa-chevron-down transition-transform"></i></button><div id={`season-${safeId}`} class="hidden p-2 grid grid-cols-3 gap-2 border-t border-zinc-800">{seasons[season].map(ep => (<button onclick={`loadPlayer('${ep.url}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="bg-zinc-800 hover:bg-red-600 text-xs py-2 px-1 rounded truncate text-center border border-zinc-700 transition-colors">{ep.name}</button>))}</div></div>) })}</div> )}
               <p class="text-sm text-gray-300 leading-relaxed mb-8">{movie.description}</p>
               {related.length > 0 && (<div class="pt-4 border-t border-zinc-800"><h3 class="font-bold text-white mb-4">You May Also Like</h3><div class="h-scroll-section custom-scroll">{related.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item block relative bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div>)}
           </div>
        </div>
      </Layout>
    );
});

// AUTH
app.get("/login", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-3xl font-black text-red-600 mb-8 text-center italic">GOLD FLIX</h1><form action="/login" method="post" class="bg-[#1f1f1f] p-6 rounded-lg border border-zinc-800 space-y-4 shadow-xl"><h2 class="text-xl font-bold text-white mb-2">Sign In</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><label class="flex items-center text-gray-400 text-xs"><input type="checkbox" name="remember" class="mr-2 accent-red-600" /> Remember Me (7 Days)</label><button class="btn-primary w-full mt-2">Login</button><p class="text-xs text-gray-500 text-center mt-4">No account? <a href="/signup" class="text-white font-bold">Sign up</a></p></form></div></div></Layout>));
app.post("/login", async (c) => { 
    // Rate Limit Check
    const ip = c.req.header("x-forwarded-for") || "unknown";
    if (!checkRateLimit(ip)) return c.text("Too many failed attempts. Try again in 1 minute.", 429);

    const body = await c.req.parseBody(); 
    const user = await getUser(body["username"] as string); 
    const hashedInput = await hashPassword(body["password"] as string); 
    
    if (user && user.passwordHash === hashedInput) { 
        const sessionId = crypto.randomUUID(); 
        user.sessionId = sessionId; 
        await kv.set(["users", user.username], user); 
        const maxAge = body["remember"] === "on" ? 60 * 60 * 24 * 7 : undefined; 
        setCookie(c, "auth_session", `${user.username}:${sessionId}`, { path: "/", maxAge, httpOnly: true, secure: !c.req.url.includes("localhost"), sameSite: "Lax" }); 
        return c.redirect("/"); 
    } 
    return c.redirect("/login?error=Invalid Username or Password"); 
});
app.get("/signup", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-3xl font-black text-red-600 mb-8 text-center italic">GOLD FLIX</h1><form action="/signup" method="post" class="bg-[#1f1f1f] p-6 rounded-lg border border-zinc-800 space-y-4 shadow-xl"><h2 class="text-xl font-bold text-white mb-2">Create Account</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-2">Sign Up</button><p class="text-xs text-gray-500 text-center mt-4">Has account? <a href="/login" class="text-white font-bold">Login</a></p></form></div></div></Layout>));
app.post("/signup", async (c) => { const { username, password } = await c.req.parseBody(); if (await getUser(username as string)) return c.redirect("/signup?error=User already exists!"); const passwordHash = await hashPassword(password as string); const newUser: User = { username: String(username), passwordHash, expiryDate: null, favorites: [], sessionId: "" }; await kv.set(["users", String(username)], newUser); return c.redirect("/login?success=Account created successfully!"); });

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

    const plans = [
        { name: "1 Month", price: "700 Ks", days: 30, features: ["Unlock All Movies", "Download Access", "18+ Uncensored"] },
        { name: "3 Months", price: "1,500 Ks", days: 90, popular: true, features: ["Unlock All Movies", "Download Access", "18+ Uncensored", "Fast Servers"] },
        { name: "5 Months", price: "2,200 Ks", days: 150, features: ["Unlock All Movies", "Download Access", "18+ Uncensored", "Fast Servers"] },
        { name: "1 Year", price: "5,000 Ks", days: 365, features: ["Everything Unlocked", "VIP Support", "Download Access", "Fast Servers"] }
    ]; 

    return c.html(
      <Layout user={user}>
        <div class="p-4 max-w-4xl mx-auto space-y-6">
            <div class="relative w-full aspect-[1.7/1] rounded-2xl bg-gradient-to-br from-amber-300 via-yellow-500 to-amber-600 p-5 shadow-2xl text-black flex flex-col justify-between overflow-hidden">
                <div class="absolute top-0 right-0 p-3 opacity-20"><i class="fa-solid fa-crown text-8xl"></i></div>
                <div class="relative z-10 flex justify-between items-start">
                     <div class="flex items-center gap-3">
                         <div class="w-12 h-12 bg-black text-yellow-500 rounded-full flex items-center justify-center text-2xl font-black border-2 border-white shadow-lg">{user.username[0].toUpperCase()}</div>
                         <div><h2 class="text-xl font-black tracking-tight">{user.username}</h2><div class="text-[10px] font-bold bg-black/20 px-2 py-0.5 rounded inline-block uppercase tracking-wider">{statusText}</div></div>
                     </div>
                     <i class="fa-solid fa-wifi text-xl opacity-70"></i>
                </div>
                <div class="relative z-10 flex justify-between items-end font-mono">
                    <div><p class="text-[8px] uppercase opacity-70 font-bold mb-0.5">Member ID</p><p class="text-sm sm:text-lg font-bold tracking-widest">{memberId}</p></div>
                    <div class="text-right"><p class="text-[8px] uppercase opacity-70 font-bold mb-0.5">Expires</p><p class="text-xs sm:text-sm font-bold">{premium ? `${finalDays} Days Left` : "Not Active"}</p></div>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
                 <div class="bg-[#1f1f1f] p-4 rounded-xl border border-zinc-800 flex flex-col justify-center items-center gap-2">
                     <i class="fa-solid fa-heart text-red-500 text-xl"></i>
                     <div class="text-center"><span class="block text-2xl font-bold text-white">{favCount}</span><span class="text-xs text-gray-500">Saved Movies</span></div>
                 </div>
                 <div class="bg-[#1f1f1f] p-4 rounded-xl border border-zinc-800 flex flex-col justify-center">
                     <div class="flex justify-between text-xs text-gray-400 mb-2"><span>VIP Status</span><span>{progress > 100 ? 100 : Math.round(progress)}%</span></div>
                     <div class="w-full bg-black h-2 rounded-full overflow-hidden"><div class={`h-full ${premium ? 'bg-yellow-500' : 'bg-gray-700'}`} style={{width: `${premium ? progress : 0}%`}}></div></div>
                     <p class="text-[10px] text-gray-500 mt-2 text-center">{premium ? "Enjoy your premium access!" : "Upgrade to watch movies."}</p>
                 </div>
            </div>

            <div class="bg-[#1f1f1f] p-6 rounded-xl border border-yellow-500/30 relative overflow-hidden group">
                 <div class="absolute -top-4 -right-4 opacity-10 rotate-12 transition-transform group-hover:rotate-0"><i class="fa-solid fa-gift text-9xl text-yellow-500"></i></div>
                 <h3 class="font-bold mb-4 text-white relative z-10 flex items-center gap-2"><i class="fa-solid fa-ticket text-yellow-500"></i> Redeem Voucher</h3>
                 <form action="/profile/redeem" method="post" class="relative z-10 flex gap-2"><input name="key" placeholder="Enter VIP Code..." required class="bg-black border border-zinc-700 text-white px-4 py-3 rounded-lg w-full outline-none focus:border-yellow-500 transition" /><button class="bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold px-6 py-3 rounded-lg hover:brightness-110 shadow-lg whitespace-nowrap"><i class="fa-solid fa-check"></i></button></form>
            </div>

            <div>
                <h3 class="font-bold text-xl text-white mb-4 flex items-center gap-2"><i class="fa-solid fa-layer-group text-blue-500"></i> Premium Plans</h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {plans.map(p => (
                        <div class={`relative bg-[#1f1f1f] p-5 rounded-xl border ${p.popular ? 'border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.2)]' : 'border-zinc-800'} flex flex-col`}>
                            {p.popular && <div class="absolute -top-3 left-4 bg-yellow-500 text-black text-[10px] font-bold px-3 py-1 rounded-full shadow-md">BEST VALUE</div>}
                            <div class="flex justify-between items-baseline mb-4"><h4 class="text-white font-bold text-lg">{p.name}</h4><span class="text-yellow-500 font-mono font-bold text-xl">{p.price}</span></div>
                            <ul class="space-y-2 mb-6 flex-grow">{p.features.map(f => (<li class="flex items-center gap-2 text-xs text-gray-400"><i class="fa-solid fa-check text-green-500"></i> {f}</li>))}</ul>
                            <a href="https://t.me/iqowoq" target="_blank" class={`block text-center py-3 rounded-lg font-bold text-sm transition ${p.popular ? 'bg-yellow-500 text-black hover:bg-yellow-400' : 'bg-zinc-800 text-white hover:bg-zinc-700'}`}>Buy Now</a>
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
app.get(ADMIN_ROUTE, (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action={ADMIN_ROUTE + "/login"} method="post" class="bg-[#1f1f1f] p-8 rounded w-80"><h2 class="font-bold text-center mb-4 text-blue-500">Secured Login</h2><input type="password" name="password" placeholder="Key" class="input-box mb-4" /><button class="bg-blue-600 text-white w-full py-2 rounded font-bold hover:bg-blue-700">Access</button></form></div></Layout>));

app.post(ADMIN_ROUTE + "/login", async (c) => { 
    const { password } = await c.req.parseBody(); 
    if (password === ADMIN_PASS) { 
        // Create Secure Session
        const sessionId = crypto.randomUUID();
        await kv.set(["admin_sessions", sessionId], "active", { expireIn: ADMIN_SESSION_EXPIRE });
        
        setCookie(c, "admin_session_id", sessionId, { path: "/", httpOnly: true, secure: !c.req.url.includes("localhost"), sameSite: "Strict" }); 
        return c.redirect(ADMIN_ROUTE + "/dashboard"); 
    } 
    return c.redirect(ADMIN_ROUTE); 
});

app.get(ADMIN_ROUTE + "/dashboard", adminGuard, async (c) => { 
    // ADMIN: Still use Full Fetch for Management (Acceptable for Admin)
    const iter = kv.list<Movie>({ prefix: ["movies"] });
    const movies = []; for await (const res of iter) movies.push(res.value);
    movies.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

    const keys = await getKeys(); 
    const requests = await getRequests(); 
    const config = await getConfig(); 
    const editId = c.req.query("edit"); 
    const editMovie = editId ? movies.find(m => m.id === editId) : null; 
    const epString = editMovie?.episodes?.map(e => (e.season ? `${e.season} | ${e.name} | ${e.url}` : `${e.name} | ${e.url}`)).join('\n') || "";
    const vipDate = config.globalVipExpiry ? new Date(config.globalVipExpiry).toLocaleDateString() : "Inactive";

    return c.html(
        <Layout title="Admin" isAdmin={true}>
            <div class="p-4 bg-zinc-900 min-h-screen">
                <div class="flex justify-between items-center mb-6 bg-black p-4 rounded border border-zinc-800"><h1 class="font-bold text-blue-500 text-lg">Dashboard</h1><div class="flex gap-2"><a href="/admin/backup" class="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1 rounded text-xs border border-zinc-700"><i class="fa-solid fa-download"></i> Backup</a><form action="/admin/restore" method="post" enctype="multipart/form-data" class="inline"><label class="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1 rounded text-xs border border-zinc-700 cursor-pointer"><i class="fa-solid fa-upload"></i> Restore<input type="file" name="file" class="hidden" onchange="this.form.submit()" /></label></form></div></div>
                <div class="flex gap-2 mb-4 overflow-x-auto pb-2"><button id="btn-movies" onclick="openTab('movies')" class="tab-btn active px-4 py-2 bg-[#1f1f1f] rounded text-sm font-bold text-gray-400 hover:text-white transition">Movies</button><button id="btn-keys" onclick="openTab('keys')" class="tab-btn px-4 py-2 bg-[#1f1f1f] rounded text-sm font-bold text-gray-400 hover:text-white transition">VIP Keys</button><button id="btn-users" onclick="openTab('users')" class="tab-btn px-4 py-2 bg-[#1f1f1f] rounded text-sm font-bold text-gray-400 hover:text-white transition">Users</button><button id="btn-requests" onclick="openTab('requests')" class="tab-btn px-4 py-2 bg-[#1f1f1f] rounded text-sm font-bold text-gray-400 hover:text-white transition">Requests</button><button id="btn-config" onclick="openTab('config')" class="tab-btn px-4 py-2 bg-[#1f1f1f] rounded text-sm font-bold text-gray-400 hover:text-white transition">Config</button></div>

                {/* TAB 1: MOVIES */}
                <div id="tab-movies" class="tab-content active">
                    <div class="grid lg:grid-cols-3 gap-6">
                        <div class="lg:col-span-1 bg-[#1f1f1f] p-4 rounded border border-zinc-700 h-fit lg:sticky lg:top-4 z-10">
                            <h2 class="font-bold mb-3 text-sm text-yellow-500 border-b border-zinc-700 pb-2">{editMovie ? "Edit Movie" : "Add New Movie"}</h2>
                            <form action="/admin/movie/save" method="post" class="space-y-3 text-sm"><input type="hidden" name="id" value={editMovie?.id || crypto.randomUUID()} /><input type="hidden" name="createdAt" value={editMovie?.createdAt || Date.now()} /><input name="title" placeholder="Title" value={editMovie?.title} required class="input-box" /><div class="flex gap-2"><select name="category" class="input-box">{["Movies","Series","Adult","All Uncensored"].map(o => <option selected={editMovie?.category===o}>{o}</option>)}</select><input name="year" value={editMovie?.year || "2025"} class="input-box w-20" /></div><input name="posterUrl" placeholder="Poster URL" value={editMovie?.posterUrl} required class="input-box" /><input name="coverUrl" placeholder="Cover URL" value={editMovie?.coverUrl} required class="input-box border-yellow-500/50" />
                            <input name="fileSize" placeholder="File Size (e.g. 1.2 GB)" value={editMovie?.fileSize} class="input-box" />
                            <div class="p-2 bg-black rounded border border-zinc-800"><select name="linkType" class="input-box mb-2 text-xs"><option value="direct" selected={editMovie?.linkType==="direct"}>Direct Link (Auto-Resolve)</option><option value="embed" selected={editMovie?.linkType==="embed"}>Embed Code / Iframe</option></select><input name="streamUrl" placeholder="Movie URL (Ep1)" value={editMovie?.streamUrl} class="input-box" /></div><div class="p-2 bg-black rounded border border-zinc-800"><label class="text-xs text-yellow-500 mb-1 block">Series Episodes (Season | Ep | URL)</label><textarea name="episodeList" placeholder="S1 Ep1 | https://...&#10;S1 Ep2 | https://..." rows={5} class="input-box font-mono text-xs whitespace-nowrap overflow-x-auto">{epString}</textarea></div><div class="grid grid-cols-2 gap-2"><input name="downloadUrl" placeholder="Download Link 1" value={editMovie?.downloadUrl} class="input-box text-xs border-green-900/50 focus:border-green-500" /><input name="downloadUrl2" placeholder="Download Link 2" value={editMovie?.downloadUrl2} class="input-box text-xs border-green-900/50 focus:border-green-500" /></div><div class="p-2 bg-black rounded border border-zinc-800"><label class="text-xs text-gray-500">Server 2 (Optional)</label><input name="streamUrl2" placeholder="Stream URL 2" value={editMovie?.streamUrl2} class="input-box mt-2" /></div><textarea name="description" placeholder="Description" class="input-box">{editMovie?.description}</textarea><button class="btn-primary w-full">{editMovie ? "Update Movie" : "Save Movie"}</button>{editMovie && <a href={ADMIN_ROUTE + "/dashboard"} class="block text-center text-xs text-gray-400 mt-2">Cancel Edit</a>}</form>
                        </div>
                        <div class="lg:col-span-2 bg-[#1f1f1f] p-4 rounded border border-zinc-700 flex flex-col h-[80vh]">
                            <div class="flex justify-between items-center mb-3"><h2 class="font-bold text-sm">Library ({movies.length})</h2><input oninput="filterMovies(this.value)" placeholder="Search library..." class="bg-black border border-zinc-800 rounded px-3 py-1 text-xs w-48" /></div>
                            <div class="space-y-2 flex-1 overflow-y-auto pr-2 custom-scroll">{movies.map(m => (<div class="movie-item flex gap-3 p-2 bg-black rounded items-center group relative border border-zinc-800 hover:border-zinc-600 transition" data-title={m.title}><img src={m.posterUrl} class="w-10 h-14 object-cover rounded" /><div class="flex-grow min-w-0"><div class="font-bold text-sm truncate text-gray-200">{m.title}</div><div class="text-[10px] text-gray-500">{m.category} • {m.year}</div></div><div class="flex gap-2"><a href={`${ADMIN_ROUTE}/dashboard?edit=${m.id}`} class="text-blue-500 text-xs border border-blue-500/30 px-3 py-1 rounded hover:bg-blue-500/10">Edit</a><form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Delete this movie?')"><button class="text-red-500 text-xs border border-red-500/30 px-3 py-1 rounded hover:bg-red-500/10">Del</button></form></div></div>))}</div>
                        </div>
                    </div>
                </div>

                {/* TAB 2: VIP KEYS */}
                <div id="tab-keys" class="tab-content">
                    <div class="max-w-2xl mx-auto space-y-4">
                        <div class="bg-[#1f1f1f] p-6 rounded border border-zinc-700 shadow-lg"><h2 class="font-bold mb-4 text-yellow-500"><i class="fa-solid fa-key mr-2"></i> Generate VIP Key</h2><form action="/admin/key/create" method="post" class="flex gap-2"><input type="number" name="days" placeholder="Days (e.g. 30)" required class="input-box flex-grow" /><button class="btn-primary w-32">Generate</button></form></div>
                        <div class="bg-[#1f1f1f] p-6 rounded border border-zinc-700"><h2 class="font-bold mb-4 text-gray-300">Active Keys</h2><div class="space-y-2 max-h-[500px] overflow-y-auto custom-scroll">{keys.map(k => (<div class="flex justify-between items-center p-3 bg-black rounded border border-zinc-800"><div class="flex items-center gap-3"><span class="text-yellow-500 font-mono font-bold text-lg">{k.code}</span><span class="text-xs bg-zinc-800 px-2 py-1 rounded text-gray-400">{k.days} Days</span></div><div class="flex items-center gap-2"><button onclick={`copyToClip('${k.code}')`} class="text-xs bg-blue-900/30 text-blue-400 px-3 py-1.5 rounded hover:bg-blue-900/50"><i class="fa-solid fa-copy"></i> Copy</button><form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-xs bg-red-900/30 text-red-400 px-3 py-1.5 rounded hover:bg-red-900/50"><i class="fa-solid fa-trash"></i></button></form></div></div>))}</div></div>
                    </div>
                </div>

                {/* TAB 3: USERS */}
                <div id="tab-users" class="tab-content">
                    <div class="max-w-xl mx-auto space-y-6">
                        <div class="bg-[#1f1f1f] p-6 rounded border border-yellow-500/30 shadow-lg">
                            <h2 class="font-bold mb-4 text-yellow-500 text-lg"><i class="fa-solid fa-circle-plus mr-2"></i> Manual VIP Top-up</h2>
                            <form action="/admin/user/add-vip" method="post" class="space-y-4">
                                <div><label class="block text-xs text-gray-400 mb-1">Target Username</label><input name="username" placeholder="Enter username..." required class="input-box" /></div>
                                <div><label class="block text-xs text-gray-400 mb-1">Add Days</label><input type="number" name="days" placeholder="e.g. 30" required class="input-box" /></div>
                                <button class="bg-gradient-to-r from-yellow-600 to-yellow-500 text-black font-bold w-full py-3 rounded hover:brightness-110 transition">Add VIP Time</button>
                            </form>
                        </div>
                        <div class="bg-[#1f1f1f] p-6 rounded border border-zinc-700 shadow-lg">
                            <h2 class="font-bold mb-4 text-blue-500 text-lg"><i class="fa-solid fa-user-lock mr-2"></i> Reset Password</h2>
                            <form action="/admin/user/reset" method="post" class="space-y-4">
                                <div><label class="block text-xs text-gray-400 mb-1">Target Username</label><input name="username" placeholder="Enter username..." required class="input-box" /></div>
                                <div><label class="block text-xs text-gray-400 mb-1">New Password</label><input name="newpass" placeholder="Enter new password..." required class="input-box" /></div>
                                <button class="bg-blue-600 text-white font-bold w-full py-3 rounded hover:bg-blue-700 transition">Reset Password</button>
                            </form>
                        </div>
                    </div>
                </div>

                {/* TAB 4: REQUESTS */}
                <div id="tab-requests" class="tab-content"><div class="max-w-3xl mx-auto bg-[#1f1f1f] p-6 rounded border border-zinc-700"><h2 class="font-bold mb-4 text-pink-500">Movie Requests ({requests.length})</h2><div class="space-y-3">{requests.map(r => (<div class="bg-black p-4 rounded flex justify-between items-center border border-zinc-800"><div><h3 class="font-bold text-lg text-white">{r.movieName}</h3><p class="text-xs text-gray-500">Requested by <span class="text-blue-400">{r.username}</span> • {new Date(r.timestamp).toLocaleDateString()}</p></div><form action={`/admin/request/delete/${r.id}`} method="post"><button class="text-red-500 hover:text-red-400 p-2"><i class="fa-solid fa-check"></i> Done</button></form></div>))}</div></div></div>

                {/* TAB 5: CONFIG */}
                <div id="tab-config" class="tab-content">
                    <div class="max-w-xl mx-auto bg-[#1f1f1f] p-6 rounded border border-zinc-700 space-y-6">
                        <div><h2 class="font-bold mb-4 text-gray-300">Announcement Bar</h2><form action="/admin/config" method="post" class="space-y-4"><div><label class="block text-xs text-gray-400 mb-1">Message</label><input name="text" placeholder="Enter message..." value={config.announcement} class="input-box" /></div><label class="flex items-center gap-2 p-3 bg-black rounded border border-zinc-800 cursor-pointer"><input type="checkbox" name="show" checked={config.showAnnouncement} class="accent-yellow-500 w-5 h-5" /><span class="font-bold text-sm">Show Bar</span></label><button class="btn-primary w-full">Save Message</button></form></div>
                        <div class="border-t border-zinc-800 pt-6"><h2 class="font-bold mb-2 text-green-500"><i class="fa-solid fa-gift mr-2"></i> Global VIP Event</h2><p class="text-xs text-gray-500 mb-4">Set a specific number of days. Everyone (old & new users) will get VIP until that date. (Fixed Expiry Date)</p><div class="bg-black p-4 rounded border border-zinc-800 mb-4"><span class="text-sm text-gray-400">Current Event Ends:</span> <span class="block text-xl font-bold text-white mt-1">{vipDate}</span></div><form action="/admin/config/vip" method="post" class="flex gap-2"><input type="number" name="days" placeholder="Days from now (e.g. 30)" required class="input-box" /><button class="bg-green-600 text-white font-bold px-4 rounded hover:bg-green-700">Set Event</button></form><form action="/admin/config/vip-clear" method="post" class="mt-2"><button class="text-xs text-red-500 hover:text-red-400">Clear Global Event</button></form></div>
                        <div class="border-t border-zinc-800 pt-6"><h2 class="font-bold mb-2 text-purple-500"><i class="fa-solid fa-database mr-2"></i> Database Maintenance</h2><p class="text-xs text-gray-500 mb-4">Click this if you just updated the code to optimize loading speed.</p><form action="/admin/config/reindex" method="post"><button class="bg-purple-600 text-white font-bold px-4 py-2 rounded hover:bg-purple-700 text-sm">Re-Sync Database</button></form></div>
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

// RE-INDEX ACTION
app.post("/admin/config/reindex", adminGuard, async (c) => { await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=config&success=Database Optimized!"); });

app.post("/admin/request/delete/:id", adminGuard, async (c) => { await kv.delete(["requests", c.req.param("id")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=requests"); });
app.post("/admin/movie/save", adminGuard, async (c) => { const body = await c.req.parseBody(); const epString = body["episodeList"] as string; const episodes: Episode[] = []; if(epString && epString.trim().length > 0) { epString.split('\n').forEach(line => { const parts = line.split('|'); if(parts.length === 3) { episodes.push({ season: parts[0].trim(), name: parts[1].trim(), url: parts[2].trim() }); } else if(parts.length === 2) { episodes.push({ season: "", name: parts[0].trim(), url: parts[1].trim() }); } }); } const movie = { ...body, id: body["id"], createdAt: Number(body["createdAt"]), episodes }; 
// Use Optimized Save
await saveMovieDB(movie as Movie); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Movie Saved"); });

app.post("/admin/movie/delete/:id", adminGuard, async (c) => { 
// Use Optimized Delete
await deleteMovieDB(c.req.param("id")); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Movie Deleted"); });

app.post("/admin/key/create", adminGuard, async (c) => { const { days } = await c.req.parseBody(); const code = "VIP-" + Math.random().toString(36).substring(2, 7).toUpperCase(); await kv.set(["keys", code], { code, days: parseInt(String(days)) }); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys"); });
app.post("/admin/key/delete/:code", adminGuard, async (c) => { await kv.delete(["keys", c.req.param("code")]); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=keys"); });
app.post("/admin/user/reset", adminGuard, async (c) => { const { username, newpass } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { user.passwordHash = await hashPassword(String(newpass)); await kv.set(["users", String(username)], user); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=Password Updated"); } return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); });
app.post("/admin/user/add-vip", adminGuard, async (c) => { const { username, days } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { const addDays = parseInt(String(days)); const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date(); currentExpiry.setDate(currentExpiry.getDate() + addDays); user.expiryDate = currentExpiry.toISOString(); await kv.set(["users", String(username)], user); return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&success=VIP Added Successfully"); } return c.redirect(ADMIN_ROUTE + "/dashboard?tab=users&error=User Not Found"); });
app.get("/admin/backup", adminGuard, async (c) => { const data = []; for await (const entry of kv.list({ prefix: [] })) { data.push({ key: entry.key, value: entry.value }); } return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="backup_${Date.now()}.json"` } }); });
app.post("/admin/restore", adminGuard, async (c) => { try { const body = await c.req.parseBody(); const file = body['file']; if (file instanceof File) { const text = await file.text(); const data = JSON.parse(text); for (const item of data) { await kv.set(item.key, item.value); } await reIndexDatabase(); return c.redirect(ADMIN_ROUTE + "/dashboard?success=Data Restored"); } } catch(e) { return c.redirect(ADMIN_ROUTE + "/dashboard?error=Restore Failed"); } });

Deno.serve(app.fetch);
