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
interface Episode { name: string; url: string; }
interface Movie {
  id: string; title: string; posterUrl: string; coverUrl: string;
  category: "Movies" | "Series" | "Adult"; description: string; tags: string;
  year: string; streamUrl: string; episodes?: Episode[];
  linkType: "direct" | "embed"; downloadUrl?: string; createdAt: number;
}
interface User {
  username: string; passwordHash: string; expiryDate: string | null; favorites: string[]; sessionId?: string;
}
interface VipKey { code: string; days: number; }

// =======================
// 2. DB FUNCTIONS
// =======================
async function getMovies() {
  const iter = kv.list<Movie>({ prefix: ["movies"] });
  const movies = [];
  for await (const res of iter) movies.push(res.value);
  return movies.sort((a, b) => b.createdAt - a.createdAt);
}
async function getMovie(id: string) { const res = await kv.get<Movie>(["movies", id]); return res.value; }
async function getUser(username: string) { const res = await kv.get<User>(["users", username]); return res.value; }
async function getKeys() { const iter = kv.list<VipKey>({ prefix: ["keys"] }); const keys = []; for await (const res of iter) keys.push(res.value); return keys; }

// =======================
// 3. MIDDLEWARE
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
const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>{props.title || "Gold Flix"}</title>
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
        .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease-in-out; }
        .slide.active { opacity: 1; }
        .slide img { width: 100%; height: 100%; object-fit: cover; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 10px; padding-bottom: 10px; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; }
        .h-scroll-item { min-width: 110px; width: 110px; flex-shrink: 0; scroll-snap-align: start; }
        .h-scroll-item img { width: 100%; aspect-ratio: 2/3; object-fit: cover; border-radius: 4px; }
        .video-loader { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: #000; z-index: 20; }
        .video-loader .spinner { border-color: #333; border-top-color: #E50914; }
        
        /* Ensure download button is visible in native controls */
        video::-internal-media-controls-download-button { display:block !important; }
        video::-webkit-media-controls-enclosure { overflow:visible !important; }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        document.addEventListener('DOMContentLoaded', () => {
            const loader = document.getElementById('page-loader');
            document.addEventListener('contextmenu', e => { if(e.target.nodeName!=='INPUT'&&e.target.nodeName!=='TEXTAREA'&&e.target.nodeName!=='VIDEO') e.preventDefault(); });
            document.querySelectorAll('a').forEach(l => l.addEventListener('click', e => { const href=l.getAttribute('href'); if(href&&href.startsWith('/')&&!href.includes('logout')&&!href.includes('#')) loader.classList.add('active'); }));
            document.querySelectorAll('form').forEach(f => f.addEventListener('submit', () => loader.classList.add('active')));
            window.addEventListener('pageshow', () => loader.classList.remove('active'));
            const urlParams = new URLSearchParams(window.location.search);
            if(urlParams.get('error')) showToast(urlParams.get('error'), 'error');
            if(urlParams.get('success')) showToast(urlParams.get('success'), 'success');
            if(urlParams.get('error')||urlParams.get('success')) window.history.replaceState({}, document.title, window.location.pathname);
            const slides = document.querySelectorAll('.slide');
            if(slides.length>1){ let current=0; setInterval(()=>{ slides[current].classList.remove('active'); current=(current+1)%slides.length; slides[current].classList.add('active'); },4000); }
            
            // --- ROBUST VIDEO LOADER ---
            window.loadVideo = function(url, type) {
                const container = document.getElementById('video-player');
                const cover = document.getElementById('video-cover');
                const loader = document.getElementById('video-player-loader');
                
                // Show local loader
                if(cover) cover.style.display = 'none';
                loader.style.display = 'flex';
                
                let html = '';
                if(type === 'embed' || url.includes('<iframe')) {
                    html = url.includes('<iframe') ? url : '<iframe src="'+url+'" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>';
                    // Hide loader after delay for iframe
                    setTimeout(() => loader.style.display = 'none', 1500);
                } else {
                    // Standard Video Tag (Supports 3-dots download)
                    html = '<video controls autoplay class="w-full h-full"><source src="'+url+'" type="video/mp4"></video>';
                }
                
                container.innerHTML = html;
                container.style.display = 'block';
                
                const video = container.querySelector('video');
                if(video) {
                    video.addEventListener('loadeddata', () => loader.style.display = 'none');
                    video.addEventListener('waiting', () => loader.style.display = 'flex');
                    video.addEventListener('playing', () => loader.style.display = 'none');
                    video.play().catch(e => console.log("Autoplay blocked, user must interact"));
                }
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
                    const el = document.createElement('a'); el.href = '/movie/' + m.id; el.className = 'block bg-[#1f1f1f] rounded overflow-hidden';
                    el.innerHTML = '<img src="'+m.posterUrl+'" class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">'+m.title+'</h3></div>'; container.appendChild(el);
                });
            } catch(e) { console.error(e); }
            isLoading = false; document.getElementById('loading-indicator').style.display = 'none';
        }
        window.addEventListener('scroll', () => { if(window.location.pathname.startsWith('/category/') && (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) { const cat = window.location.pathname.split('/').pop(); loadMoreMovies(cat); }});
      `}} />
    </head>
    <body><div id="page-loader"><div class="spinner"></div></div><div id="toast-box"></div>{!props.hideNav&&(<nav class="sticky top-0 z-40 bg-black/95 border-b border-white/10 px-4 py-3 shadow-lg"><div class="max-w-7xl mx-auto flex justify-between items-center"><a href="/" class="text-xl font-black text-red-600 tracking-tighter italic">GOLD FLIX</a><div class="flex gap-4 text-xs font-bold text-gray-400"><a href="/" class="hover:text-white">Home</a><a href="/favorites" class="hover:text-red-500">Saved</a><a href="/category/Movies" class="hover:text-white">Movies</a><a href="/category/Series" class="hover:text-white">Series</a>{props.user?<a href="/profile" class="text-white">Me</a>:<a href="/login">Login</a>}</div></div></nav>)}<main class="flex-grow w-full pb-10">{props.children}</main></body>
  </html>
);

// =======================
// 5. PUBLIC ROUTES
// =======================

app.get("/", async (c) => {
  const user = await getCurrentUser(c);
  const allMovies = await getMovies();
  const sliderMovies = allMovies.filter(m => m.coverUrl && m.coverUrl.length > 5).slice(0, 5);
  const sections = ["Movies", "Series", "Adult"];
  return c.html(
    <Layout user={user}>
        <div class="p-3 bg-black sticky top-[50px] z-30 shadow-md">
             <form action="/search" method="get" class="relative">
                 <i class="fa-solid fa-magnifying-glass absolute left-3 top-3 text-gray-500"></i>
                 <input name="q" placeholder="Search movies..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 pl-10 pr-4 text-sm text-white focus:border-red-600 outline-none" />
             </form>
        </div>
      {sliderMovies.length > 0 && (<div class="slider-container">{sliderMovies.map((m, idx) => (<div class={`slide ${idx === 0 ? 'active' : ''}`}><img src={m.coverUrl} /><div class="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/30"></div><div class="absolute bottom-4 left-4 right-4"><span class="bg-red-600 text-[10px] text-white px-2 py-0.5 rounded font-bold">Featured</span><h1 class="text-xl md:text-3xl font-bold text-white drop-shadow-md truncate mt-1">{m.title}</h1><button onclick={`loadVideo('/movie/${m.id}', 'direct')`} class="mt-2 inline-flex items-center gap-2 bg-white text-black px-4 py-1.5 rounded font-bold text-sm"><i class="fa-solid fa-play"></i> Play</button></div></div>))}</div>)}
      <div class="px-3 py-6 space-y-8">{sections.map(cat => { const catMovies = allMovies.filter(m => m.category === cat).slice(0, 8); if (catMovies.length === 0) return null; return (<div><div class="flex justify-between items-end mb-3 px-1"><h2 class="text-lg font-bold text-white border-l-4 border-red-600 pl-2">{cat}</h2><a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1">See All <i class="fa-solid fa-chevron-right text-[10px]"></i></a></div><div class="h-scroll-section custom-scroll">{catMovies.map(m => (<a href={`/movie/${m.id}`} class="h-scroll-item block relative bg-[#1f1f1f] rounded overflow-hidden active:scale-95 transition-transform"><img src={m.posterUrl} /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white leading-tight">{m.title}</h3></div></a>))}</div></div>)})}</div>
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
    const movies = filtered.slice(start, start + limit).map(m => ({ id: m.id, title: m.title, posterUrl: m.posterUrl }));
    return c.json({ movies });
});

app.get("/category/:cat", async (c) => {
    const user = await getCurrentUser(c);
    const cat = c.req.param("cat");
    const allMovies = await getMovies();
    const filtered = allMovies.filter((m) => m.category === cat);
    const initialMovies = filtered.slice(0, 15);
    return c.html(<Layout user={user}><div class="px-3 py-6"><div class="flex justify-between items-center mb-4"><h1 class="text-xl font-bold text-white flex items-center gap-2"><a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a> {cat}</h1><span class="bg-red-600 text-[10px] px-2 py-1 rounded text-white font-bold tracking-wider">{filtered.length} ITEMS</span></div><div id="movie-grid" class="grid grid-cols-3 gap-2">{initialMovies.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div><div id="loading-indicator" class="text-center py-4 hidden"><i class="fa-solid fa-circle-notch fa-spin text-red-600 text-xl"></i></div></div></Layout>);
});

app.get("/search", async (c) => {
    const user = await getCurrentUser(c);
    const query = c.req.query("q")?.toLowerCase() || "";
    const allMovies = await getMovies();
    const results = allMovies.filter(m => (m.title && m.title.toLowerCase().includes(query)) || (m.tags && m.tags.toLowerCase().includes(query)));
    return c.html(<Layout user={user}><div class="p-4"><div class="flex items-center gap-3 mb-6"><a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a><form action="/search" method="get" class="flex-grow relative"><input name="q" value={query} placeholder="Search..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 px-4 text-sm outline-none" /></form></div><h2 class="text-sm text-gray-400 mb-4">Results for "{query}" ({results.length})</h2><div class="grid grid-cols-3 gap-2">{results.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div></div></Layout>);
});

app.get("/favorites", async (c) => {
    const user = await getCurrentUser(c);
    if(!user) return c.redirect("/login");
    const allMovies = await getMovies();
    const favs = allMovies.filter(m => user.favorites?.includes(m.id));
    return c.html(<Layout user={user} title="Saved"><div class="p-4"><h1 class="text-xl font-bold mb-4 flex items-center gap-2"><i class="fa-solid fa-heart text-red-600"></i> My Saved Movies</h1><div class="grid grid-cols-3 gap-2">{favs.map(m => (<a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden"><img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" /><div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div></a>))}</div>{favs.length===0 && <p class="text-gray-500 text-center mt-10">No saved movies.</p>}</div></Layout>);
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

// =======================
// 6. STREAM & DOWNLOAD LOGIC
// =======================

app.get("/stream/:token", async (c) => {
    const token = c.req.param("token");
    const entry = await kv.get(["stream_tokens", token]);
    if (!entry.value) return c.text("Link Expired or Invalid", 403);
    return c.redirect(entry.value as string);
});

app.get("/dl/:token", async (c) => {
    const token = c.req.param("token");
    const entry = await kv.get(["stream_tokens", token]);
    if (!entry.value) return c.text("Download Link Expired", 403);
    return c.redirect(entry.value as string);
});

app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const movie = await getMovie(id);
    const user = await getCurrentUser(c);
    if (!movie) return c.text("Not Found", 404);
  
    const premium = isPremium(user);
    const isFav = user?.favorites?.includes(id);
    const displayImage = movie.coverUrl || movie.posterUrl; 

    let initialStreamUrl = movie.streamUrl;
    let episodes = movie.episodes || [];
    if (movie.category === "Series" && episodes.length > 0) initialStreamUrl = episodes[0].url;

    let playerUrl = "";
    let secureDownloadUrl = "";

    if (premium) {
        if (movie.linkType === "embed" || initialStreamUrl.includes("<iframe")) {
            playerUrl = initialStreamUrl;
        } else {
            let realUrl = initialStreamUrl;
            if (movie.linkType === "direct") realUrl = await resolveRedirect(initialStreamUrl);
            const token = crypto.randomUUID();
            await kv.set(["stream_tokens", token], realUrl, { expireIn: 3600 * 3 }); 
            playerUrl = `/stream/${token}`;
        }

        if (movie.downloadUrl) {
             const dlToken = crypto.randomUUID();
             await kv.set(["stream_tokens", dlToken], movie.downloadUrl, { expireIn: 3600 * 3 });
             secureDownloadUrl = `/dl/${dlToken}`;
        }
    }
  
    return c.html(
      <Layout user={user} title={movie.title}>
        <div class="max-w-4xl mx-auto">
           {/* VIDEO CONTAINER */}
           <div class="w-full aspect-video bg-black relative shadow-lg group">
              {premium ? (
                  <>
                    <div id="video-cover" class="absolute inset-0 z-20 cursor-pointer" onclick={`loadVideo('${playerUrl}', '${movie.linkType}')`}>
                        <img src={displayImage} class="w-full h-full object-cover" />
                    </div>
                    {/* LOADING SPINNER */}
                    <div id="video-player-loader" class="video-loader"><div class="spinner"></div></div>
                    {/* PLAYER */}
                    <div id="video-player" class="w-full h-full hidden"></div>
                  </>
              ) : (
                  <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 z-30">
                      <img src={displayImage} class="absolute inset-0 w-full h-full object-cover opacity-20 blur-sm" />
                      <div class="relative z-40 text-center">
                          <i class="fa-solid fa-lock text-4xl text-red-600 mb-2"></i>
                          <h2 class="text-lg font-bold text-white">VIP Only</h2>
                          <a href={user ? "/profile" : "/login"} class="mt-4 bg-white text-black px-6 py-2 rounded font-bold text-sm inline-block">Unlock</a>
                      </div>
                  </div>
              )}
           </div>
           
           <div class="p-4">
               <div class="flex justify-between items-start mb-2">
                   <h1 class="text-2xl font-bold text-white leading-tight">{movie.title}</h1>
                   {user && (
                       <form action="/api/fav" method="post">
                           <input type="hidden" name="movieId" value={movie.id} />
                           <button class="text-2xl p-2"><i class={`fa-solid fa-heart ${isFav ? 'text-red-600' : 'text-gray-600'}`}></i></button>
                       </form>
                   )}
               </div>
               
               <div class="flex items-center gap-2 text-xs text-gray-400 mb-4">
                   <span class="bg-gray-800 px-2 py-0.5 rounded">{movie.year}</span>
                   <span class="text-red-500 font-bold border border-red-500/50 px-2 py-0.5 rounded">{movie.category}</span>
               </div>

               {/* ACTION BUTTONS */}
               {premium && (
                   <div class="flex gap-3 mb-6">
                        {movie.category !== "Series" && (
                            <button onclick={`loadVideo('${playerUrl}', '${movie.linkType}')`} class="flex-1 bg-white text-black font-bold py-3 rounded flex items-center justify-center gap-2 active:scale-95 transition">
                                <i class="fa-solid fa-play"></i> Play Movie
                            </button>
                        )}
                        
                        {secureDownloadUrl && (
                            <a href={secureDownloadUrl} target="_blank" class="flex-1 bg-zinc-800 text-white font-bold py-3 rounded flex items-center justify-center gap-2 border border-zinc-700 active:scale-95 transition">
                                <i class="fa-solid fa-download"></i> Download
                            </a>
                        )}
                   </div>
               )}

               {/* SERIES EPISODES */}
               {movie.category === "Series" && episodes.length > 0 && premium && (
                   <div class="mb-6">
                       <h3 class="font-bold text-gray-300 mb-2">Episodes</h3>
                       <div class="grid grid-cols-3 md:grid-cols-4 gap-2 max-h-60 overflow-y-auto custom-scroll">
                           {episodes.map(ep => (
                               <button onclick={`loadVideo('${ep.url}', '${movie.linkType}')`} class="bg-zinc-800 hover:bg-red-600 text-xs py-3 px-1 rounded truncate text-center border border-zinc-700 transition-colors">
                                   {ep.name}
                               </button>
                           ))}
                       </div>
                   </div>
               )}

               <p class="text-sm text-gray-300 leading-relaxed mb-6">{movie.description}</p>
           </div>
        </div>
      </Layout>
    );
});

// =======================
// 7. AUTH & 8. ADMIN (SAME AS BEFORE)
// =======================
app.get("/login", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-3xl font-black text-red-600 mb-8 text-center italic">GOLD FLIX</h1><form action="/login" method="post" class="bg-[#1f1f1f] p-6 rounded-lg border border-zinc-800 space-y-4 shadow-xl"><h2 class="text-xl font-bold text-white mb-2">Sign In</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><label class="flex items-center text-gray-400 text-xs"><input type="checkbox" name="remember" class="mr-2 accent-red-600" /> Remember Me (7 Days)</label><button class="btn-primary w-full mt-2">Login</button><p class="text-xs text-gray-500 text-center mt-4">No account? <a href="/signup" class="text-white font-bold">Sign up</a></p></form></div></div></Layout>));
app.post("/login", async (c) => { const body = await c.req.parseBody(); const user = await getUser(body["username"] as string); const hashedInput = await hashPassword(body["password"] as string); if (user && user.passwordHash === hashedInput) { const sessionId = crypto.randomUUID(); user.sessionId = sessionId; await kv.set(["users", user.username], user); const maxAge = body["remember"] === "on" ? 60 * 60 * 24 * 7 : undefined; setCookie(c, "auth_session", `${user.username}:${sessionId}`, { path: "/", maxAge }); return c.redirect("/profile"); } return c.redirect("/login?error=Invalid Username or Password"); });
app.get("/signup", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-3xl font-black text-red-600 mb-8 text-center italic">GOLD FLIX</h1><form action="/signup" method="post" class="bg-[#1f1f1f] p-6 rounded-lg border border-zinc-800 space-y-4 shadow-xl"><h2 class="text-xl font-bold text-white mb-2">Create Account</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-2">Sign Up</button><p class="text-xs text-gray-500 text-center mt-4">Has account? <a href="/login" class="text-white font-bold">Login</a></p></form></div></div></Layout>));
app.post("/signup", async (c) => { const { username, password } = await c.req.parseBody(); if (await getUser(username as string)) return c.redirect("/signup?error=User already exists!"); const passwordHash = await hashPassword(password as string); const newUser: User = { username: String(username), passwordHash, expiryDate: null, favorites: [], sessionId: "" }; await kv.set(["users", String(username)], newUser); return c.redirect("/login?success=Account created successfully!"); });
app.get("/profile", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const premium = isPremium(user); const daysLeft = user.expiryDate ? Math.ceil((new Date(user.expiryDate).getTime() - Date.now()) / 86400000) : 0; const plans = [{ name: "1 Month", price: "700 Ks", days: 30 }, { name: "3 Months", price: "1,500 Ks", days: 90, popular: true }, { name: "5 Months", price: "2,200 Ks", days: 150 }, { name: "1 Year", price: "5,000 Ks", days: 365 }]; return c.html(<Layout user={user}><div class="p-4 max-w-4xl mx-auto"><div class="bg-[#1f1f1f] p-6 rounded-xl flex items-center gap-6 mb-8 border border-zinc-800 shadow-lg"><div class="w-20 h-20 bg-gradient-to-br from-red-600 to-red-800 rounded-full flex items-center justify-center text-3xl font-bold shadow-lg shadow-red-900/50">{user.username[0].toUpperCase()}</div><div><h2 class="text-2xl font-bold mb-1">{user.username}</h2><div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-black border border-zinc-700 text-sm"><span class={premium ? "w-2 h-2 rounded-full bg-green-500" : "w-2 h-2 rounded-full bg-gray-500"}></span><span class={premium ? "text-green-400 font-bold" : "text-gray-400"}>{premium ? `VIP Active (${daysLeft} days)` : "Free Plan"}</span></div></div></div><div class="bg-[#1f1f1f] p-6 rounded-xl mb-8 border border-zinc-800"><h3 class="font-bold mb-4 text-gray-300 uppercase text-xs tracking-wider">Activate VIP</h3><form action="/profile/redeem" method="post" class="flex gap-2"><input name="key" placeholder="Enter VIP Code (e.g. VIP-12345)" required class="input-box" /><button class="btn-primary whitespace-nowrap">Redeem Code</button></form></div><h3 class="font-bold mb-4 text-xl text-yellow-500"><i class="fa-solid fa-crown mr-2"></i> Premium Plans</h3><div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">{plans.map(p => (<div class={`relative bg-black p-4 rounded-xl border ${p.popular ? 'border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.3)]' : 'border-zinc-800'} text-center flex flex-col justify-center`}>{p.popular && <div class="absolute -top-3 left-0 right-0 mx-auto w-fit bg-yellow-500 text-black text-[10px] font-bold px-2 py-0.5 rounded-full">MOST POPULAR</div>}<h4 class="text-gray-400 text-sm mb-1">{p.name}</h4><div class="text-xl font-black text-white mb-2">{p.price}</div></div>))}</div><a href="/logout" class="block w-full bg-zinc-900 border border-zinc-700 text-center py-3 rounded-lg text-red-500 font-bold hover:bg-red-900/10 transition">Log Out</a></div></Layout>); });
app.post("/profile/redeem", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { key } = await c.req.parseBody(); const keyData = await kv.get<VipKey>(["keys", String(key)]); if (!keyData.value) return c.redirect("/profile?error=Invalid VIP Key!"); const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date(); currentExpiry.setDate(currentExpiry.getDate() + keyData.value.days); user.expiryDate = currentExpiry.toISOString(); await kv.set(["users", user.username], user); await kv.delete(["keys", String(key)]); return c.redirect("/profile?success=VIP Activated Successfully!"); });
app.get("/logout", (c) => { deleteCookie(c, "auth_session"); return c.redirect("/"); });
const adminAuth = async (c: any, next: any) => { const session = getCookie(c, "admin_session"); if (session === Deno.env.get("ADMIN_PASSWORD")) await next(); else return c.redirect("/admin"); };
app.get("/admin", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action="/admin/login" method="post" class="bg-[#1f1f1f] p-8 rounded w-80"><h2 class="font-bold text-center mb-4">Admin Login</h2><input type="password" name="password" placeholder="Key" class="input-box mb-4" /><button class="btn-primary w-full">Enter</button></form></div></Layout>));
app.post("/admin/login", async (c) => { const { password } = await c.req.parseBody(); if (password === Deno.env.get("ADMIN_PASSWORD")) { setCookie(c, "admin_session", String(password), { path: "/" }); return c.redirect("/admin/dashboard"); } return c.redirect("/admin"); });
app.get("/admin/dashboard", adminAuth, async (c) => { const movies = await getMovies(); const keys = await getKeys(); const editId = c.req.query("edit"); const editMovie = editId ? movies.find(m => m.id === editId) : null; const epString = editMovie?.episodes?.map(e => `${e.name}|${e.url}`).join('\n') || ""; return c.html(<Layout title="Admin"><div class="p-4 bg-zinc-900 min-h-screen"><div class="flex justify-between items-center mb-6"><h1 class="font-bold text-red-600">Admin Panel</h1><a href="/" class="text-xs bg-black px-3 py-1 rounded">View App</a></div><div class="grid lg:grid-cols-2 gap-6"><div class="space-y-6"><div class="bg-[#1f1f1f] p-4 rounded border border-zinc-700 sticky top-4"><h2 class="font-bold mb-3 text-sm text-yellow-500">{editMovie ? "Edit Movie" : "Add Movie"}</h2><form action="/admin/movie/save" method="post" class="space-y-2 text-sm"><input type="hidden" name="id" value={editMovie?.id || crypto.randomUUID()} /><input type="hidden" name="createdAt" value={editMovie?.createdAt || Date.now()} /><input name="title" placeholder="Title" value={editMovie?.title} required class="input-box" /><div class="flex gap-2"><select name="category" class="input-box">{["Movies","Series","Adult"].map(o => <option selected={editMovie?.category===o}>{o}</option>)}</select><input name="year" value={editMovie?.year || "2025"} class="input-box w-20" /></div><input name="posterUrl" placeholder="Poster URL (Portrait)" value={editMovie?.posterUrl} required class="input-box" /><input name="coverUrl" placeholder="Cover URL (Landscape - Slider)" value={editMovie?.coverUrl} required class="input-box border-yellow-500/50" /><div class="p-2 bg-black rounded border border-zinc-800"><select name="linkType" class="input-box mb-2 text-xs"><option value="direct" selected={editMovie?.linkType==="direct"}>Direct Link (Auto-Resolve)</option><option value="embed" selected={editMovie?.linkType==="embed"}>Embed Code / Iframe</option></select><input name="streamUrl" placeholder="Movie URL (If Series, leave or put Ep1)" value={editMovie?.streamUrl} class="input-box" /></div><div class="p-2 bg-black rounded border border-zinc-800"><label class="text-xs text-yellow-500 mb-1 block">Series Episodes</label><textarea name="episodeList" placeholder="S1 Ep1 | https://...&#10;S1 Ep2 | https://..." rows={5} class="input-box font-mono text-xs whitespace-nowrap overflow-x-auto">{epString}</textarea></div><input name="downloadUrl" placeholder="Download Link (Optional)" value={editMovie?.downloadUrl} class="input-box text-xs border-green-900/50 focus:border-green-500" /><textarea name="description" placeholder="Desc" class="input-box">{editMovie?.description}</textarea><button class="btn-primary w-full">{editMovie ? "Update Movie" : "Save Movie"}</button>{editMovie && <a href="/admin/dashboard" class="block text-center text-xs text-gray-400 mt-2">Cancel Edit</a>}</form></div></div><div class="space-y-6"><div class="bg-[#1f1f1f] p-4 rounded border border-zinc-700"><h2 class="font-bold mb-3 text-sm">VIP Keys</h2><form action="/admin/key/create" method="post" class="flex gap-2"><input type="number" name="days" placeholder="Days" required class="input-box" /><button class="btn-primary">Gen</button></form><div class="mt-2 max-h-32 overflow-y-auto custom-scroll">{keys.map(k => (<div class="flex justify-between text-xs p-2 border-b border-zinc-800"><span class="text-yellow-500 font-mono">{k.code}</span><span>{k.days}D</span><form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-red-500">x</button></form></div>))}</div></div><div class="bg-[#1f1f1f] p-4 rounded border border-zinc-700 border-red-900/50"><h2 class="font-bold mb-3 text-sm text-red-500">Reset User Password</h2><form action="/admin/user/reset" method="post" class="flex flex-col gap-2"><input name="username" placeholder="Username" required class="input-box text-sm" /><div class="flex gap-2"><input name="newpass" placeholder="New Password" required class="input-box text-sm" /><button class="btn-primary text-sm whitespace-nowrap">Reset</button></div></form></div><div class="bg-[#1f1f1f] p-4 rounded border border-zinc-700 flex flex-col h-[600px]"><div class="flex justify-between items-center mb-3"><h2 class="font-bold text-sm">Library ({movies.length})</h2><input oninput="filterMovies(this.value)" placeholder="Search..." class="bg-black border border-zinc-800 rounded px-2 py-1 text-xs w-32" /></div><div class="space-y-2 flex-1 overflow-y-auto pr-2 custom-scroll">{movies.map(m => (<div class="movie-item flex gap-3 mb-3 p-2 bg-black rounded items-center group relative" data-title={m.title}><img src={m.posterUrl} class="w-10 h-14 object-cover" /><div class="flex-grow min-w-0"><div class="font-bold text-xs truncate">{m.title}</div><div class="text-[10px] text-gray-500">{m.category}</div></div><div class="flex gap-2"><a href={`/admin/dashboard?edit=${m.id}`} class="text-blue-500 text-xs border border-blue-500/50 px-2 py-1 rounded hover:bg-blue-500/10">Edit</a><form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Del?')"><button class="text-red-500 text-xs border border-red-500/50 px-2 py-1 rounded hover:bg-red-500/10">Del</button></form></div></div>))}</div></div></div></div></div></Layout>); });
app.post("/admin/movie/save", adminAuth, async (c) => { const body = await c.req.parseBody(); const epString = body["episodeList"] as string; const episodes: Episode[] = []; if(epString && epString.trim().length > 0) { epString.split('\n').forEach(line => { const parts = line.split('|'); if(parts.length >= 2) { episodes.push({ name: parts[0].trim(), url: parts.slice(1).join('|').trim() }); } }); } const movie = { ...body, id: body["id"], createdAt: Number(body["createdAt"]), episodes }; await kv.set(["movies", movie.id as string], movie); return c.redirect("/admin/dashboard"); });
app.post("/admin/movie/delete/:id", adminAuth, async (c) => { await kv.delete(["movies", c.req.param("id")]); return c.redirect("/admin/dashboard"); });
app.post("/admin/key/create", adminAuth, async (c) => { const { days } = await c.req.parseBody(); const code = "VIP-" + Math.random().toString(36).substring(2, 7).toUpperCase(); await kv.set(["keys", code], { code, days: parseInt(String(days)) }); return c.redirect("/admin/dashboard"); });
app.post("/admin/key/delete/:code", adminAuth, async (c) => { await kv.delete(["keys", c.req.param("code")]); return c.redirect("/admin/dashboard"); });
app.post("/admin/user/reset", adminAuth, async (c) => { const { username, newpass } = await c.req.parseBody(); const user = await getUser(String(username)); if (user) { user.passwordHash = await hashPassword(String(newpass)); await kv.set(["users", String(username)], user); return c.redirect("/admin/dashboard?success=Password updated"); } return c.redirect("/admin/dashboard?error=User not found"); });

Deno.serve(app.fetch);
