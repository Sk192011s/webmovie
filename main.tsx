/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { crypto } from "std/crypto/mod.ts";

const app = new Hono();
const kv = await Deno.openKv();

// =======================
// SECURITY & UTILS
// =======================
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "GOLD_FLIX_SALT_2025"); 
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// =======================
// 1. DATA TYPES
// =======================
interface Episode { season?: string; name: string; url: string; }
interface Movie {
  id: string; title: string; posterUrl: string; coverUrl: string;
  category: "Movies" | "Series" | "Adult"; description: string; tags: string;
  year: string; streamUrl: string; streamUrl2?: string;
  episodes?: Episode[];
  linkType: "direct" | "embed"; 
  downloadUrl?: string; downloadUrl2?: string;
  createdAt: number;
}
interface User {
  username: string; passwordHash: string; expiryDate: string | null; favorites: string[]; sessionId?: string;
  ip?: string; // Track IP
}
interface VipKey { code: string; days: number; }
interface UserRequest { id: string; username: string; movieName: string; timestamp: number; }
interface AppConfig { announcement: string; showAnnouncement: boolean; }
interface BannedIP { ip: string; reason: string; }
interface LoginLog { username: string; ip: string; timestamp: number; }

// =======================
// 2. DB FUNCTIONS
// =======================
async function getMovies() {
  const iter = kv.list<Movie>({ prefix: ["movies"] });
  const movies = [];
  for await (const res of iter) movies.push(res.value);
  return movies.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}
async function getMovie(id: string) { const res = await kv.get<Movie>(["movies", id]); return res.value; }
async function getUser(username: string) { const res = await kv.get<User>(["users", username]); return res.value; }
async function getKeys() { const iter = kv.list<VipKey>({ prefix: ["keys"] }); const keys = []; for await (const res of iter) keys.push(res.value); return keys; }
async function getRequests() { const iter = kv.list<UserRequest>({ prefix: ["requests"] }); const reqs = []; for await (const res of iter) reqs.push(res.value); return reqs.sort((a,b)=>b.timestamp-a.timestamp); }
async function getConfig() { const res = await kv.get<AppConfig>(["config"]); return res.value || { announcement: "Welcome to Gold Flix!", showAnnouncement: true }; }
async function getBannedIPs() { const iter = kv.list<BannedIP>({ prefix: ["banned_ips"] }); const ips = []; for await (const res of iter) ips.push(res.value); return ips; }
async function getRecentLogins() { const iter = kv.list<LoginLog>({ prefix: ["login_logs"] }, { limit: 20, reverse: true }); const logs = []; for await (const res of iter) logs.push(res.value); return logs; }
async function addLoginLog(username: string, ip: string) { await kv.set(["login_logs", Date.now()], { username, ip, timestamp: Date.now() }, { expireIn: 86400 * 3 }); }

// =======================
// 3. MIDDLEWARE (ADMIN AUTH MOVED HERE)
// =======================

// Admin Authentication Middleware
const adminAuth = async (c: any, next: any) => {
  const session = getCookie(c, "admin_session");
  const envPass = Deno.env.get("ADMIN_PASSWORD");
  // If session matches env password, proceed. Else redirect to login.
  if (session && session === envPass) {
      await next();
  } else {
      return c.redirect("/admin");
  }
};

async function checkIP(c: any) {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0] || "unknown";
    const banned = await kv.get(["banned_ips", ip]);
    if (banned.value) return true; 
    return false;
}

async function getCurrentUser(c: any) {
  const authCookie = getCookie(c, "auth_session");
  if (!authCookie) return null;
  const [username, token] = authCookie.split(":");
  if (!username || !token) return null;
  const user = await getUser(username);
  if (!user || user.sessionId !== token) return null;
  return user;
}
function isPremium(user: User | null) {
  if (!user || !user.expiryDate) return false;
  return new Date(user.expiryDate) > new Date();
}
async function resolveRedirect(url: string) {
  try { const res = await fetch(url, { method: "HEAD", redirect: "follow" }); return res.url; } catch { return url; }
}

// =======================
// 4. UI LAYOUT
// =======================
const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean; announcement?: string }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      
      {/* FORCE NO CACHE FOR HTML */}
      <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
      <meta http-equiv="Pragma" content="no-cache" />
      <meta http-equiv="Expires" content="0" />

      <title>{props.title || "Gold Flix"}</title>
      <link rel="manifest" href="/manifest.json" />
      <meta name="theme-color" content="#000000" />
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <style>{`
        body { background-color: #000; color: #fff; font-family: sans-serif; -webkit-tap-highlight-color: transparent; }
        * { user-select: none; -webkit-user-select: none; }
        input, textarea { user-select: text !important; -webkit-user-select: text !important; }
        img { pointer-events: none; }
        .glass { background: #1a1a1a; border: 1px solid #333; }
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
        #page-loader { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 9999; display: flex; justify-content: center; align-items: center; transition: opacity 0.3s; pointer-events: none; opacity: 0; }
        #page-loader.active { pointer-events: all; opacity: 1; }
        .spinner { width: 40px; height: 40px; border: 4px solid #333; border-top: 4px solid #E50914; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .slider-container { position: relative; width: 100%; aspect-ratio: 16/9; overflow: hidden; background: #000; }
        .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease-in-out; pointer-events: none; z-index: 0; }
        .slide.active { opacity: 1; pointer-events: auto; z-index: 10; }
        .slide img { width: 100%; height: 100%; object-fit: cover; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 10px; padding-bottom: 10px; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; }
        .h-scroll-item { min-width: 110px; width: 110px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item img { width: 100%; aspect-ratio: 2/3; object-fit: cover; border-radius: 4px; }
        .h-scroll-item.wide { min-width: 240px; width: 240px; }
        .h-scroll-item.wide img { aspect-ratio: 16/9; }
        .video-loader { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: #000; z-index: 20; }
        .video-loader .spinner { border-color: #333; border-top-color: #E50914; }
        video::-internal-media-controls-download-button { display:block !important; }
        video::-webkit-media-controls-enclosure { overflow:visible !important; }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        document.addEventListener('DOMContentLoaded', () => {
            if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/service-worker.js').then(reg => reg.update()); }
            const loader = document.getElementById('page-loader');
            document.addEventListener('contextmenu', e => { if(e.target.nodeName!=='INPUT'&&e.target.nodeName!=='TEXTAREA'&&e.target.nodeName!=='VIDEO') e.preventDefault(); });
            document.body.addEventListener('click', (e) => {
                const link = e.target.closest('a');
                if (link) {
                    const href = link.getAttribute('href');
                    const target = link.getAttribute('target');
                    if (href && href.startsWith('/') && !href.includes('logout') && !href.includes('#') && target !== '_blank') {
                        loader.classList.add('active');
                    }
                }
            });
            document.querySelectorAll('form').forEach(f => f.addEventListener('submit', () => loader.classList.add('active')));
            window.addEventListener('pageshow', () => loader.classList.remove('active'));
            const urlParams = new URLSearchParams(window.location.search);
            if(urlParams.get('error')) showToast(urlParams.get('error'), 'error');
            if(urlParams.get('success')) showToast(urlParams.get('success'), 'success');
            if(urlParams.get('error')||urlParams.get('success')) window.history.replaceState({}, document.title, window.location.pathname);
            const slides = document.querySelectorAll('.slide');
            if(slides.length>1){ let current=0; setInterval(()=>{ slides[current].classList.remove('active'); current=(current+1)%slides.length; slides[current].classList.add('active'); },4000); }
            window.shareMovie = function(title) { if (navigator.share) { navigator.share({ title: title, text: 'Watch ' + title + ' on Gold Flix', url: window.location.href }); } else { const el = document.createElement('textarea'); el.value = window.location.href; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el); showToast('Link Copied!', 'success'); } }
            window.toggleHelp = function() { document.getElementById('download-help').classList.toggle('hidden'); }
            window.toggleSeason = function(id) { const el = document.getElementById('season-' + id); const icon = document.getElementById('icon-' + id); if(el) { el.classList.toggle('hidden'); if(icon) icon.classList.toggle('rotate-180'); } }
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
            document.getElementById('loading-indicator').style.display = 'block';
            page++;
            try {
                const res = await fetch('/api/list?cat=' + category + '&page=' + page);
                const data = await res.json();
                if(data.movies.length === 0) { hasMore = false; document.getElementById('loading-indicator').style.display = 'none'; return; }
                const container = document.getElementById('movie-grid');
                data.movies.forEach(m => {
                    const el = document.createElement('a'); el.href = '/movie/' + m.id;
                    if(category === "All Uncensored") { el.className = 'block bg-[#1f1f1f] rounded overflow-hidden mb-4'; el.innerHTML = '<img src="'+m.coverUrl+'" class="aspect-video object-cover w-full" /><div class="p-3"><h3 class="text-sm font-bold truncate text-white">'+m.title+'</h3></div>'; } 
                    else { el.className = 'block bg-[#1f1f1f] rounded overflow-hidden'; el.innerHTML = '<img src="'+m.posterUrl+'" class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">'+m.title+'</h3></div>'; }
                    container.appendChild(el);
                });
            } catch(e) { console.error(e); }
            isLoading = false; document.getElementById('loading-indicator').style.display = 'none';
        }
        window.addEventListener('scroll', () => { if(window.location.pathname.startsWith('/category/') && (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) { const cat = window.location.pathname.split('/').pop().replace(/%20/g, ' '); loadMoreMovies(cat); }});
      `}} />
    </head>
    <body>
      <div id="page-loader"><div class="spinner"></div></div>
      <div id="toast-box"></div>
      {!props.hideNav && (
        <nav class="sticky top-0 z-40 bg-black/95 border-b border-white/10 px-4 py-3 shadow-lg"><div class="max-w-7xl mx-auto flex justify-between items-center"><a href="/" class="text-xl font-black text-red-600 tracking-tighter italic">GOLD FLIX</a><div class="flex gap-4 text-xs font-bold text-gray-400"><a href="/" class="hover:text-white">Home</a><a href="/favorites" class="hover:text-red-500">Saved</a><a href="/request" class="hover:text-yellow-500">Request</a>{props.user ? <a href="/profile" class="text-white">Me</a> : <a href="/login">Login</a>}</div></div></nav>
      )}
      {props.announcement && (<div class="sticky top-[53px] z-30 bg-yellow-500 text-black text-xs font-bold px-4 py-2 flex items-center gap-2 overflow-hidden shadow-md"><i class="fa-solid fa-bullhorn animate-pulse"></i><marquee scrollamount="5">{props.announcement}</marquee></div>)}
      <main class="flex-grow w-full pb-10">{props.children}</main>
    </body>
  </html>
);

// =======================
// 5. PUBLIC ROUTES & API
// =======================

app.get("/manifest.json", (c) => c.json({ "name": "Gold Flix", "short_name": "GoldFlix", "start_url": "/", "display": "standalone", "background_color": "#000000", "theme_color": "#000000", "icons": [{ "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "192x192", "type": "image/png" }, { "src": "https://cdn-icons-png.flaticon.com/512/2503/2503508.png", "sizes": "512x512", "type": "image/png" }] }));
app.get("/.well-known/assetlinks.json", (c) => c.json([{ "relation": ["delegate_permission/common.handle_all_urls"], "target": { "namespace": "android_app", "package_name": "dev.deno.goldflix_stream.twa", "sha256_cert_fingerprints": ["29:7D:1A:43:86:09:03:FE:02:F9:69:46:5A:F8:B7:C0:9A:14:75:10:F6:F3:07:4F:2E:CF:0E:F1:3E:D4:5F:7D"] } }]));
app.get("/service-worker.js", (c) => c.text(`self.addEventListener('install', (e) => { self.skipWaiting(); }); self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); }); self.addEventListener('fetch', (e) => { if (e.request.mode === 'navigate') { e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); } else { e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request))); } });`, 200, { "Content-Type": "application/javascript" }));

app.get("/", async (c) => {
  if(await checkIP(c)) return c.text("Access Denied: IP Banned", 403);
  const user = await getCurrentUser(c);
  c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate'); c.header('Expires', '-1'); c.header('Pragma', 'no-cache');
  const allMovies = await getMovies();
  const config = await getConfig();
  const sliderMovies = allMovies.filter(m => m.coverUrl && m.coverUrl.length > 5).slice(0, 5);
  const sections = ["Movies", "Series", "Adult", "All Uncensored"];
  
  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}>
        <div class="p-3 bg-black sticky top-[50px] z-30 shadow-md">
             <form action="/search" method="get" class="relative"><i class="fa-solid fa-magnifying-glass absolute left-3 top-3 text-gray-500"></i><input name="q" placeholder="Search movies..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 pl-10 pr-4 text-sm text-white focus:border-red-600 outline-none" /></form>
        </div>
      {sliderMovies.length > 0 && (<div class="slider-container">{sliderMovies.map((m, idx) => (<div class={`slide ${idx === 0 ? 'active' : ''}`}><img src={m.coverUrl} /><div class="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/30"></div><div class="absolute bottom-4 left-4 right-4"><span class="bg-red-600 text-[10px] text-white px-2 py-0.5 rounded font-bold">Featured</span><h1 class="text-xl md:text-3xl font-bold text-white drop-shadow-md truncate mt-1">{m.title}</h1><a href={`/movie/${m.id}`} class="mt-2 inline-flex items-center gap-2 bg-white text-black px-4 py-1.5 rounded font-bold text-sm"><i class="fa-solid fa-play"></i> Play</a></div></div>))}</div>)}
      <div class="px-3 py-6 space-y-8">{sections.map(cat => { 
          const catMovies = allMovies.filter(m => m.category === cat).slice(0, 8); 
          if (catMovies.length === 0) return null; 
          if (cat === "All Uncensored") {
              return (<div><div class="flex justify-between items-end mb-3 px-1"><h2 class="text-lg font-bold text-white border-l-4 border-red-600 pl-2">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1">See All <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div><div class="h-scroll-section custom-scroll">{catMovies.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item wide block relative bg-[#1f1f1f] rounded overflow-hidden active:scale-95 transition-transform"><img src={m.coverUrl || m.posterUrl} /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white leading-tight">{m.title}</h3></div></a>))}</div></div>);
          }
          return (<div><div class="flex justify-between items-end mb-3 px-1"><h2 class="text-lg font-bold text-white border-l-4 border-red-600 pl-2">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1">See All <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div><div class="h-scroll-section custom-scroll">{catMovies.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item block relative bg-[#1f1f1f] rounded overflow-hidden active:scale-95 transition-transform"><img src={m.posterUrl} /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white leading-tight">{m.title}</h3></div></a>))}</div></div>);
      })}</div>
    </Layout>
  );
});

app.get("/api/list", async (c) => {
    const cat = c.req.query("cat") || "Movies";
    const page = parseInt(c.req.query("page") || "1");
    const limit = 15;
    const allMovies = await getMovies();
    const filtered = allMovies.filter((m) => m.category === cat);
    const start = (page - 1) * limit;
    const movies = filtered.slice(start, start + limit).map(m => ({ id: m.id, title: m.title, posterUrl: m.posterUrl, coverUrl: m.coverUrl }));
    return c.json({ movies });
});
app.get("/api/resolve-url", async (c) => { const token = c.req.query("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.json({ error: "Invalid token" }, 404); return c.json({ url: entry.value }); });
app.get("/category/:cat", async (c) => {
    const user = await getCurrentUser(c);
    const cat = c.req.param("cat");
    const config = await getConfig();
    const allMovies = await getMovies();
    const filtered = allMovies.filter((m) => m.category === cat);
    const initialMovies = filtered.slice(0, 15);
    const isUncensored = cat === "All Uncensored";
    return c.html(<Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}><div class="px-3 py-6"><div class="flex justify-between items-center mb-4"><h1 class="text-xl font-bold text-white flex items-center gap-2"><a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a> {cat}</h1><span class="bg-red-600 text-[10px] px-2 py-1 rounded text-white font-bold tracking-wider">{filtered.length} ITEMS</span></div><div id="movie-grid" class={isUncensored ? "space-y-4" : "grid grid-cols-3 gap-2"}>{initialMovies.map(m => (<a href={`/movie/${m.id}`} class={`block bg-[#1f1f1f] rounded overflow-hidden ${isUncensored ? 'mb-4' : ''}`}><img src={isUncensored ? (m.coverUrl || m.posterUrl) : m.posterUrl} class={isUncensored ? "aspect-video object-cover w-full" : "aspect-[2/3] object-cover w-full"} /><div class={isUncensored ? "p-3" : "p-1.5"}><h3 class={isUncensored ? "text-sm font-bold truncate text-white" : "text-[10px] font-bold truncate text-white"}>{m.title}</h3></div></a>))}</div><div id="loading-indicator" class="text-center py-4 hidden"><i class="fa-solid fa-circle-notch fa-spin text-red-600 text-xl"></i></div></div></Layout>);
});
app.get("/search", async (c) => { const user = await getCurrentUser(c); const query = c.req.query("q")?.toLowerCase() || ""; const config = await getConfig(); const allMovies = await getMovies(); const results = allMovies.filter(m => (m.title && m.title.toLowerCase().includes(query)) || (m.tags && m.tags.toLowerCase().includes(query))); return c.html(<Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}><div class="p-4"><div class="flex items-center gap-3 mb-6"><a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a><form action="/search" method="get" class="flex-grow relative"><input name="q" value={query} placeholder="Search..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 px-4 text-sm outline-none" /></form></div><h2 class="text-sm text-gray-400 mb-4">Results for "{query}" ({results.length})</h2><div class="grid grid-cols-3 gap-2">{results.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div></Layout>); });
app.get("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const config = await getConfig(); return c.html(<Layout user={user} title="Request" announcement={config.showAnnouncement ? config.announcement : undefined}><div class="p-6 max-w-md mx-auto min-h-[70vh] flex flex-col justify-center"><h1 class="text-2xl font-bold mb-4 text-yellow-500">Request Movie</h1><p class="text-gray-400 text-sm mb-6">Can't find what you're looking for? Let us know!</p><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name (e.g. Iron Man)" required class="input-box" /><button class="btn-primary w-full">Submit Request</button></form></div></Layout>); });
app.post("/request", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const { movieName } = await c.req.parseBody(); const req: UserRequest = { id: crypto.randomUUID(), username: user.username, movieName: String(movieName), timestamp: Date.now() }; await kv.set(["requests", req.id], req); return c.redirect("/request?success=Request Submitted!"); });
app.get("/favorites", async (c) => { const user = await getCurrentUser(c); if(!user) return c.redirect("/login"); const allMovies = await getMovies(); const favs = allMovies.filter(m => user.favorites?.includes(m.id)); return c.html(<Layout user={user} title="Saved"><div class="p-4"><h1 class="text-xl font-bold mb-4 flex items-center gap-2"><i class="fa-solid fa-heart text-red-600"></i> My Saved Movies</h1><div class="grid grid-cols-3 gap-2">{favs.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div>{favs.length===0 && <p class="text-gray-500 text-center mt-10">No saved movies.</p>}</div></Layout>); });
app.post("/api/fav", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { movieId } = await c.req.parseBody(); const id = String(movieId); if (!user.favorites) user.favorites = []; if (user.favorites.includes(id)) user.favorites = user.favorites.filter(f => f !== id); else user.favorites.push(id); await kv.set(["users", user.username], user); return c.redirect(c.req.header("Referer") || "/"); });
app.get("/stream/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Link Expired or Invalid", 403); return c.redirect(entry.value as string); });
app.get("/dl/:token", async (c) => { const token = c.req.param("token"); const entry = await kv.get(["stream_tokens", token]); if (!entry.value) return c.text("Download Link Expired", 403); return c.redirect(entry.value as string); });

app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const movie = await getMovie(id);
    const user = await getCurrentUser(c);
    const config = await getConfig();
    if (!movie) return c.text("Not Found", 404);
    const premium = isPremium(user);
    const isFav = user?.favorites?.includes(id);
    const displayImage = movie.coverUrl || movie.posterUrl; 
    const allMovies = await getMovies();
    const related = allMovies.filter(m => m.category === movie.category && m.id !== movie.id).slice(0, 6);
    let initialStreamUrl = movie.streamUrl;
    let episodes = movie.episodes || [];
    if (movie.category === "Series" && episodes.length > 0) initialStreamUrl = episodes[0].url;
    const seasons: Record<string, Episode[]> = {};
    const ungrouped: Episode[] = [];
    if(episodes) { episodes.forEach(ep => { if(ep.season) { if(!seasons[ep.season]) seasons[ep.season] = []; seasons[ep.season].push(ep); } else { ungrouped.push(ep); } }); }
    let playerUrl = ""; let secureDownloadUrl = ""; let secureDownloadUrl2 = ""; let playerUrl2 = ""; let playbackToken = ""; let playbackToken2 = "";
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
              {premium ? ( <> <div id="video-cover" class="absolute inset-0 z-20"> <img src={displayImage} class="w-full h-full object-cover" /> </div> <div id="video-player-loader" class="video-loader"><div class="spinner"></div></div> <div id="video-player" class="w-full h-full hidden"></div> </> ) : ( <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 z-30"> <img src={displayImage} class="absolute inset-0 w-full h-full object-cover opacity-20 blur-sm" /> <div class="relative z-40 text-center"> <i class="fa-solid fa-lock text-4xl text-red-600 mb-2"></i> <h2 class="text-lg font-bold text-white">VIP Only</h2> <a href={user ? "/profile" : "/login"} class="mt-4 bg-white text-black px-6 py-2 rounded font-bold text-sm inline-block">Unlock</a> </div> </div> )}
           </div>
           <div class="p-4">
               <div class="flex justify-between items-start mb-2"> <h1 class="text-2xl font-bold text-white leading-tight">{movie.title}</h1> {user && ( <form action="/api/fav" method="post"> <input type="hidden" name="movieId" value={movie.id} /> <button class="text-2xl p-2"><i class={`fa-solid fa-heart ${isFav ? 'text-red-600' : 'text-gray-600'}`}></i></button> </form> )} </div>
               <div class="flex items-center gap-2 text-xs text-gray-400 mb-4"> <span class="bg-gray-800 px-2 py-0.5 rounded">{movie.year}</span> <span class="text-red-500 font-bold border border-red-500/50 px-2 py-0.5 rounded">{movie.category}</span> </div>
               {premium && movie.category !== "Series" && (
                   <div class="flex flex-col gap-2 mb-6">
                        <div class="flex gap-2 overflow-x-auto">
                            <button onclick={`loadPlayer('${movie.linkType === 'direct' ? playbackToken : playerUrl}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="flex-1 bg-white text-black font-bold py-3 px-4 rounded flex items-center justify-center gap-2 active:scale-95 transition hover:bg-gray-200 whitespace-nowrap"> <i class="fa-solid fa-play"></i> {movie.streamUrl2 ? "Server 1" : "Play"} </button>
                            {movie.streamUrl2 && ( <button onclick={`loadPlayer('${movie.linkType === 'direct' ? playbackToken2 : playerUrl2}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="flex-1 bg-gray-200 text-black font-bold py-3 px-4 rounded flex items-center justify-center gap-2 active:scale-95 transition hover:bg-white whitespace-nowrap"> <i class="fa-solid fa-server"></i> Server 2 </button> )}
                            <button onclick={`shareMovie('${movie.title}')`} class="bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700"> <i class="fa-solid fa-share-nodes"></i> Share </button>
                        </div>
                        <div class="flex gap-2">
                             {secureDownloadUrl && ( <a href={secureDownloadUrl} target="_blank" class="flex-1 bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 whitespace-nowrap text-xs"> <i class="fa-solid fa-download"></i> DL {movie.downloadUrl2 ? "1" : ""} </a> )}
                             {secureDownloadUrl2 && ( <a href={secureDownloadUrl2} target="_blank" class="flex-1 bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 whitespace-nowrap text-xs"> <i class="fa-solid fa-download"></i> DL 2 </a> )}
                        </div>
                       <button onclick="toggleHelp()" class="text-xs text-yellow-500 hover:text-yellow-400 flex items-center gap-1 mt-2"><i class="fa-solid fa-circle-question"></i> ဒေါင်းလုဒ်လုပ်နည်း</button>
                       <div id="download-help" class="hidden bg-zinc-900 border border-yellow-600/50 rounded-lg p-3 text-xs text-gray-300 space-y-2 mt-1"> <p><strong class="text-yellow-500">နည်းလမ်း (၁) - Direct Download</strong><br/>Download (သို့) DL ခလုတ်ပါလျှင် နှိပ်၍ ဒေါင်းပါ။ မပါလျှင် Video Play ပြီးမှ ဒေါင်းပါ။</p> <hr class="border-zinc-700"/> <p><strong class="text-yellow-500">နည်းလမ်း (၂) - Video Player မှတဆင့်</strong><br/>1. Video ကို Play နှိပ်ပါ။<br/>2. Video ဖွင့်လာလျှင် ညာဘက်အောက်ထောင့်က အစက် ၃ စက် (<i class="fa-solid fa-ellipsis-vertical"></i>) ကိုနှိပ်ပါ။<br/>3. 'Download' ကို ရွေးချယ်ပါ။</p> </div>
                   </div>
               )}
               {movie.category === "Series" && episodes.length > 0 && premium && (
                   <div class="mb-6 space-y-2">
                       {ungrouped.length > 0 && ( <div class="grid grid-cols-3 md:grid-cols-4 gap-2"> {ungrouped.map(ep => ( <button onclick={`loadPlayer('${ep.url}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="bg-zinc-800 hover:bg-red-600 text-xs py-3 px-1 rounded truncate text-center border border-zinc-700 transition-colors">{ep.name}</button> ))} </div> )}
                       {Object.keys(seasons).map(season => { const safeId = season.replace(/\s+/g, '-'); return ( <div class="border border-zinc-800 rounded bg-[#1f1f1f]"> <button onclick={`toggleSeason('${safeId}')`} class="w-full flex justify-between items-center p-3 text-sm font-bold text-gray-300 hover:bg-zinc-800 transition"><span>{season}</span><i id={`icon-${safeId}`} class="fa-solid fa-chevron-down transition-transform"></i></button> <div id={`season-${safeId}`} class="hidden p-2 grid grid-cols-3 gap-2 border-t border-zinc-800"> {seasons[season].map(ep => (<button onclick={`loadPlayer('${ep.url}', '${movie.linkType}', '${movie.id}', '${movie.title}', '${movie.posterUrl}')`} class="bg-zinc-800 hover:bg-red-600 text-xs py-2 px-1 rounded truncate text-center border border-zinc-700 transition-colors">{ep.name}</button>))} </div> </div> ) })}
                       <div class="flex gap-2 mt-4">
                             {secureDownloadUrl && ( <a href={secureDownloadUrl} target="_blank" class="flex-1 bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 whitespace-nowrap text-xs"> <i class="fa-solid fa-download"></i> DL {movie.downloadUrl2 ? "1" : ""} </a> )}
                             {secureDownloadUrl2 && ( <a href={secureDownloadUrl2} target="_blank" class="flex-1 bg-zinc-800 text-white font-bold py-3 px-4 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition hover:bg-zinc-700 whitespace-nowrap text-xs"> <i class="fa-solid fa-download"></i> DL 2 </a> )}
                        </div>
                        <button onclick="toggleHelp()" class="text-xs text-yellow-500 hover:text-yellow-400 flex items-center gap-1 mt-2"><i class="fa-solid fa-circle-question"></i> ဒေါင်းလုဒ်လုပ်နည်း</button>
                        <div id="download-help" class="hidden bg-zinc-900 border border-yellow-600/50 rounded-lg p-3 text-xs text-gray-300 space-y-2 mt-1"> <p><strong class="text-yellow-500">နည်းလမ်း (၁) - Direct Download</strong><br/>DL ခလုတ်ကို နှိပ်ပါ။ (Series ဖြစ်ပါက Folder Link သို့ ရောက်သွားပါမည်)</p> <hr class="border-zinc-700"/> <p><strong class="text-yellow-500">နည်းလမ်း (၂) - Video Player မှတဆင့်</strong><br/>1. Episode တစ်ခုကို နှိပ်၍ Play ပါ။<br/>2. Video ဖွင့်လာလျှင် ညာဘက်အောက်ထောင့်က အစက် ၃ စက် (<i class="fa-solid fa-ellipsis-vertical"></i>) ကိုနှိပ်ပါ။<br/>3. 'Download' ကို ရွေးချယ်ပါ။</p> </div>
                   </div>
               )}
               <p class="text-sm text-gray-300 leading-relaxed mb-8">{movie.description}</p>
               {related.length > 0 && ( <div class="pt-4 border-t border-zinc-800"> <h3 class="font-bold text-white mb-4">You May Also Like</h3> <div class="h-scroll-section custom-scroll"> {related.map(m => ( <a href={`/movie/${m.id}`} class="h-scroll-item block relative bg-[#1f1f1f] rounded overflow-hidden"> <img src={m.posterUrl} /> <div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div> </a> ))} </div> </div> )}
           </div>
        </div>
      </Layout>
    );
});

// Admin Actions
app.post("/admin/config", adminAuth, async (c) => { const body = await c.req.parseBody(); await kv.set(["config"], { announcement: body['text'], showAnnouncement: body['show'] === 'on' }); return c.redirect("/admin/dashboard"); });
app.post("/admin/request/delete/:id", adminAuth, async (c) => { await kv.delete(["requests", c.req.param("id")]); return c.redirect("/admin/dashboard"); });
app.post("/admin/movie/save", adminAuth, async (c) => { 
    const body = await c.req.parseBody(); 
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
    const movie = { 
        ...body, 
        id: body["id"], 
        createdAt: Number(body["createdAt"]), 
        episodes 
    }; 
    await kv.set(["movies", movie.id as string], movie); 
    return c.redirect("/admin/dashboard"); 
});
app.post("/admin/movie/delete/:id", adminAuth, async (c) => { await kv.delete(["movies", c.req.param("id")]); return c.redirect("/admin/dashboard"); });
app.post("/admin/key/create", adminAuth, async (c) => { const { days } = await c.req.parseBody(); const code = "VIP-" + Math.random().toString(36).substring(2, 7).toUpperCase(); await kv.set(["keys", code], { code, days: parseInt(String(days)) }); return c.redirect("/admin/dashboard"); });
app.post("/admin/key/delete/:code", adminAuth, async (c) => { await kv.delete(["keys", c.req.param("code")]); return c.redirect("/admin/dashboard"); });
app.post("/admin/user/reset", adminAuth, async (c) => { const { username, newpass } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { user.passwordHash = await hashPassword(String(newpass)); await kv.set(["users", String(username)], user); return c.redirect("/admin/dashboard?success=Password updated"); } return c.redirect("/admin/dashboard?error=User not found"); });
app.post("/admin/ban", adminAuth, async (c) => { const { ip } = await c.req.parseBody(); await kv.set(["banned_ips", String(ip)], { ip, reason: "Manual Ban" }); return c.redirect("/admin/dashboard"); });
app.post("/admin/unban/:ip", adminAuth, async (c) => { await kv.delete(["banned_ips", c.req.param("ip")]); return c.redirect("/admin/dashboard"); });
app.get("/admin/backup", adminAuth, async (c) => { const data = []; for await (const entry of kv.list({ prefix: [] })) { data.push({ key: entry.key, value: entry.value }); } return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="backup_${Date.now()}.json"` } }); });
app.post("/admin/restore", adminAuth, async (c) => { try { const body = await c.req.parseBody(); const file = body['file']; if (file instanceof File) { const text = await file.text(); const data = JSON.parse(text); for (const item of data) { await kv.set(item.key, item.value); } return c.redirect("/admin/dashboard?success=Data Restored"); } } catch(e) { return c.redirect("/admin/dashboard?error=Restore Failed"); } });

Deno.serve(app.fetch);
