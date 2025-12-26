/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const app = new Hono();
const kv = await Deno.openKv();

// --- Types ---
interface Movie {
  id: string;
  title: string;
  posterUrl: string; // Portrait (2:3)
  coverUrl: string;  // Landscape (16:9) - New!
  category: "Movies" | "Series" | "Adult";
  description: string;
  tags: string;
  year: string;
  streamUrl: string;
  linkType: "direct" | "embed";
  downloadUrl?: string;
  createdAt: number;
}

interface User {
  username: string;
  password: string;
  expiryDate: string | null;
  favorites: string[];
}

interface VipKey {
  code: string;
  days: number;
}

// --- Database Helpers ---
async function getMovies() {
  const iter = kv.list<Movie>({ prefix: ["movies"] });
  const movies = [];
  for await (const res of iter) movies.push(res.value);
  return movies.sort((a, b) => b.createdAt - a.createdAt);
}

async function getPaginatedMovies(category: string, page: number, limit: number) {
  const allMovies = await getMovies();
  const filtered = allMovies.filter(m => m.category === category);
  const total = filtered.length;
  const start = (page - 1) * limit;
  const data = filtered.slice(start, start + limit);
  return { data, total, totalPages: Math.ceil(total / limit) };
}

async function getMovie(id: string) {
  const res = await kv.get<Movie>(["movies", id]);
  return res.value;
}

async function getUser(username: string) {
  const res = await kv.get<User>(["users", username]);
  return res.value;
}

async function getKeys() {
  const iter = kv.list<VipKey>({ prefix: ["keys"] });
  const keys = [];
  for await (const res of iter) keys.push(res.value);
  return keys;
}

// --- Middleware & Utilities ---
async function getCurrentUser(c: any) {
  const username = getCookie(c, "user_session");
  if (!username) return null;
  return await getUser(username);
}

function isPremium(user: User | null) {
  if (!user || !user.expiryDate) return false;
  return new Date(user.expiryDate) > new Date();
}

async function resolveRedirect(url: string) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return res.url;
  } catch {
    return url;
  }
}

// --- UI Components ---
const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>{props.title || "Gold Flix"}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <style>{`
        body { background-color: #000; color: #fff; font-family: sans-serif; -webkit-tap-highlight-color: transparent; user-select: none; }
        .glass { background: #1a1a1a; border: 1px solid #333; }
        .input-box { background: #333; border: 1px solid #444; color: white; padding: 12px; border-radius: 4px; width: 100%; outline: none; }
        .btn-primary { background: #E50914; color: white; font-weight: bold; padding: 10px 20px; border-radius: 4px; }
        
        /* Loader */
        #page-loader { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 9999; display: flex; justify-content: center; align-items: center; transition: opacity 0.3s; pointer-events: none; opacity: 0; }
        #page-loader.active { pointer-events: all; opacity: 1; }
        .spinner { width: 40px; height: 40px; border: 4px solid #333; border-top: 4px solid #E50914; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        /* Slider Styles */
        .slider-container { position: relative; width: 100%; height: 50vh; overflow: hidden; }
        .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s ease-in-out; }
        .slide.active { opacity: 1; }
        .slide img { width: 100%; height: 100%; object-fit: cover; }

        img { pointer-events: none; }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        document.addEventListener('DOMContentLoaded', () => {
            // Loader
            const loader = document.getElementById('page-loader');
            document.querySelectorAll('a').forEach(link => {
                link.addEventListener('click', (e) => {
                    const href = link.getAttribute('href');
                    if(href && href.startsWith('/') && !href.startsWith('#')) loader.classList.add('active');
                });
            });
            document.querySelectorAll('form').forEach(form => form.addEventListener('submit', () => loader.classList.add('active')));
            window.addEventListener('pageshow', () => loader.classList.remove('active'));

            // Slider Logic
            const slides = document.querySelectorAll('.slide');
            if(slides.length > 1) {
                let currentSlide = 0;
                setInterval(() => {
                    slides[currentSlide].classList.remove('active');
                    currentSlide = (currentSlide + 1) % slides.length;
                    slides[currentSlide].classList.add('active');
                }, 4000); // 4 Seconds
            }

            // Click to Play
            window.playVideo = function(id) {
                document.getElementById(id + '-cover').style.display = 'none';
                document.getElementById(id + '-player').style.display = 'block';
            }

            // Admin Search
            window.filterMovies = function(val) {
                const items = document.querySelectorAll('.movie-item');
                items.forEach(item => {
                    const title = item.getAttribute('data-title').toLowerCase();
                    item.style.display = title.includes(val.toLowerCase()) ? 'flex' : 'none';
                });
            }
        });
      `}} />
    </head>
    <body oncontextmenu="return false;">
      <div id="page-loader"><div class="spinner"></div></div>

      {!props.hideNav && (
        <nav class="sticky top-0 z-40 bg-black/95 border-b border-white/10 px-4 py-3 shadow-lg">
          <div class="max-w-7xl mx-auto flex justify-between items-center">
            <a href="/" class="text-xl font-black text-red-600 tracking-tighter italic">GOLD FLIX</a>
            <div class="flex gap-4 text-xs font-bold text-gray-400">
              <a href="/" class="hover:text-white">Home</a>
              <a href="/category/Movies" class="hover:text-white">Movies</a>
              <a href="/category/Series" class="hover:text-white">Series</a>
              <a href="/category/Adult" class="text-red-500">18+</a>
              {props.user ? <a href="/profile" class="text-white">Me</a> : <a href="/login">Login</a>}
            </div>
          </div>
        </nav>
      )}

      <main class="flex-grow w-full pb-10">
        {props.children}
      </main>
    </body>
  </html>
);

// --- ROUTES ---

// 1. Home Page (Slider + Search + Sections)
app.get("/", async (c) => {
  const user = await getCurrentUser(c);
  const allMovies = await getMovies();
  
  // Slider: Get 5 latest movies with coverUrl
  const sliderMovies = allMovies.filter(m => m.coverUrl && m.coverUrl.length > 5).slice(0, 5);
  const sections = ["Movies", "Series", "Adult"];
  
  return c.html(
    <Layout user={user}>
        {/* Search Bar */}
        <div class="p-3 bg-black">
             <form action="/search" method="get" class="relative">
                 <i class="fa-solid fa-magnifying-glass absolute left-3 top-3 text-gray-500"></i>
                 <input name="q" placeholder="Search movies..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 pl-10 pr-4 text-sm text-white focus:border-red-600 outline-none transition" />
             </form>
        </div>

      {/* Hero Slider */}
      {sliderMovies.length > 0 && (
        <div class="slider-container">
             {sliderMovies.map((m, idx) => (
                 <div class={`slide ${idx === 0 ? 'active' : ''}`}>
                     <img src={m.coverUrl} />
                     <div class="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/30"></div>
                     <div class="absolute bottom-4 left-4 right-4">
                         <span class="bg-red-600 text-[10px] text-white px-2 py-0.5 rounded font-bold">Featured</span>
                         <h1 class="text-2xl font-bold text-white drop-shadow-md truncate mt-1">{m.title}</h1>
                         <a href={`/movie/${m.id}`} class="mt-2 inline-flex items-center gap-2 bg-white text-black px-4 py-1.5 rounded font-bold text-sm">
                            <i class="fa-solid fa-play"></i> Play Now
                         </a>
                     </div>
                 </div>
             ))}
        </div>
      )}

      {/* Sections */}
      <div class="px-3 py-6 space-y-8">
        {sections.map(cat => {
            const catMovies = allMovies.filter(m => m.category === cat).slice(0, 6);
            if (catMovies.length === 0) return null;
            return (
                <div>
                    <div class="flex justify-between items-end mb-3 px-1">
                        <h2 class="text-lg font-bold text-white border-l-4 border-red-600 pl-2">{cat}</h2>
                        <a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 flex items-center gap-1">More <i class="fa-solid fa-chevron-right text-[10px]"></i></a>
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        {catMovies.map(m => (
                            <a href={`/movie/${m.id}`} class="block relative rounded bg-[#1f1f1f] overflow-hidden active:scale-95 transition-transform">
                                <div class="aspect-[2/3] w-full">
                                    <img src={m.posterUrl} class="w-full h-full object-cover" />
                                </div>
                                <div class="p-1.5">
                                    <h3 class="text-[10px] font-bold truncate text-white leading-tight">{m.title}</h3>
                                </div>
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

// Search Result Page
app.get("/search", async (c) => {
    const user = await getCurrentUser(c);
    const query = c.req.query("q")?.toLowerCase() || "";
    const allMovies = await getMovies();
    const results = allMovies.filter(m => m.title.toLowerCase().includes(query) || m.tags.toLowerCase().includes(query));

    return c.html(
        <Layout user={user}>
            <div class="p-4">
                <div class="flex items-center gap-3 mb-6">
                    <a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a>
                    <form action="/search" method="get" class="flex-grow relative">
                         <input name="q" value={query} placeholder="Search..." class="w-full bg-[#1f1f1f] border border-zinc-800 rounded-full py-2 px-4 text-sm outline-none" />
                    </form>
                </div>
                <h2 class="text-sm text-gray-400 mb-4">Results for "{query}" ({results.length})</h2>
                <div class="grid grid-cols-3 gap-2">
                    {results.map(m => (
                         <a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden">
                            <img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" />
                            <div class="p-1.5">
                                <h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3>
                            </div>
                         </a>
                    ))}
                </div>
            </div>
        </Layout>
    );
});

// Category Page
app.get("/category/:cat", async (c) => {
    const user = await getCurrentUser(c);
    const cat = c.req.param("cat");
    const page = parseInt(c.req.query("page") || "1");
    const { data, totalPages } = await getPaginatedMovies(cat, page, 15);

    return c.html(
        <Layout user={user}>
            <div class="px-3 py-6">
                <h1 class="text-xl font-bold mb-4 text-white flex items-center gap-2"><a href="/" class="text-gray-400"><i class="fa-solid fa-arrow-left"></i></a> {cat}</h1>
                <div class="grid grid-cols-3 gap-2">
                    {data.map(m => (
                         <a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden">
                            <img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" />
                            <div class="p-1.5"><h3 class="text-[10px] font-bold truncate text-white">{m.title}</h3></div>
                         </a>
                    ))}
                </div>
                <div class="flex justify-center gap-4 mt-8 text-sm font-bold">
                    {page > 1 && <a href={`/category/${cat}?page=${page - 1}`} class="px-4 py-2 bg-gray-800 rounded">Prev</a>}
                    <span class="py-2 px-4 text-gray-400">{page} / {totalPages || 1}</span>
                    {page < totalPages && <a href={`/category/${cat}?page=${page + 1}`} class="px-4 py-2 bg-red-600 rounded">Next</a>}
                </div>
            </div>
        </Layout>
    );
});

// Movie Detail (Updated to use Cover Photo)
app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const movie = await getMovie(id);
    const user = await getCurrentUser(c);
    if (!movie) return c.text("Not Found", 404);
  
    const premium = isPremium(user);
    // Use Cover for video player, fallback to poster if cover missing
    const displayImage = movie.coverUrl || movie.posterUrl; 

    let finalStreamUrl = movie.streamUrl;
    if (premium && movie.linkType === "direct" && !movie.streamUrl.includes("iframe")) {
        finalStreamUrl = await resolveRedirect(movie.streamUrl);
    }
  
    return c.html(
      <Layout user={user} title={movie.title}>
        <div class="max-w-4xl mx-auto">
           {/* Video Section */}
           <div class="w-full aspect-video bg-black relative shadow-lg">
              {premium ? (
                  <>
                    <div id="video-cover" class="absolute inset-0 z-20 cursor-pointer group" onclick="playVideo('video')">
                        {/* Display Cover Image here */}
                        <img src={displayImage} class="w-full h-full object-cover" />
                        <div class="absolute inset-0 bg-black/40 flex flex-col items-center justify-center">
                            <div class="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(229,9,20,0.6)] group-hover:scale-110 transition-transform">
                                <i class="fa-solid fa-play text-white text-2xl ml-1"></i>
                            </div>
                        </div>
                    </div>
                    <div id="video-player" class="w-full h-full hidden">
                        {movie.linkType === "embed" || movie.streamUrl.includes("<iframe") ? (
                             <div dangerouslySetInnerHTML={{__html: movie.streamUrl}} class="w-full h-full [&_iframe]:w-full [&_iframe]:h-full [&_iframe]:border-0"></div>
                        ) : (
                             <video controls class="w-full h-full" autoplay poster={displayImage}>
                                 <source src={finalStreamUrl} type="video/mp4" />
                             </video>
                        )}
                    </div>
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
               <h1 class="text-2xl font-bold text-white mb-2">{movie.title}</h1>
               <div class="flex items-center gap-2 text-xs text-gray-400 mb-4">
                   <span class="bg-gray-800 px-2 py-0.5 rounded">{movie.year}</span>
                   <span class="text-red-500 font-bold border border-red-500/50 px-2 py-0.5 rounded">{movie.category}</span>
               </div>
               <p class="text-sm text-gray-300 leading-relaxed mb-6">{movie.description}</p>
               {premium && movie.downloadUrl && (
                   <a href={movie.downloadUrl} target="_blank" class="block w-full text-center bg-gray-800 py-3 rounded text-white font-bold text-sm">Download</a>
               )}
           </div>
        </div>
      </Layout>
    );
});

// Auth & Profile Routes (Same as before)
app.get("/login", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-3xl font-black text-red-600 mb-8 text-center italic">GOLD FLIX</h1><form action="/login" method="post" class="bg-[#1f1f1f] p-6 rounded-lg border border-zinc-800 space-y-4"><h2 class="text-xl font-bold text-white mb-2">Sign In</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-2">Login</button><p class="text-xs text-gray-500 text-center mt-4">No account? <a href="/signup" class="text-white font-bold">Sign up</a></p></form></div></div></Layout>));
app.post("/login", async (c) => { const { username, password } = await c.req.parseBody(); const user = await getUser(username as string); if (user && user.password === password) { setCookie(c, "user_session", String(username), { path: "/", maxAge: 86400 * 30 }); return c.redirect("/profile"); } return c.text("Invalid", 401); });
app.get("/signup", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black p-4"><div class="w-full max-w-sm"><h1 class="text-3xl font-black text-red-600 mb-8 text-center italic">GOLD FLIX</h1><form action="/signup" method="post" class="bg-[#1f1f1f] p-6 rounded-lg border border-zinc-800 space-y-4"><h2 class="text-xl font-bold text-white mb-2">Create Account</h2><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-2">Sign Up</button><p class="text-xs text-gray-500 text-center mt-4">Has account? <a href="/login" class="text-white font-bold">Login</a></p></form></div></div></Layout>));
app.post("/signup", async (c) => { const { username, password } = await c.req.parseBody(); if (await getUser(username as string)) return c.text("User exists", 400); const newUser: User = { username: String(username), password: String(password), expiryDate: null, favorites: [] }; await kv.set(["users", String(username)], newUser); return c.redirect("/login"); });
app.get("/profile", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const premium = isPremium(user); const daysLeft = user.expiryDate ? Math.ceil((new Date(user.expiryDate).getTime() - Date.now()) / 86400000) : 0; return c.html(<Layout user={user}><div class="p-4"><h1 class="text-2xl font-bold mb-6">Profile</h1><div class="bg-[#1f1f1f] p-4 rounded-lg flex items-center gap-4 mb-6"><div class="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center text-2xl font-bold">{user.username[0].toUpperCase()}</div><div><h2 class="text-lg font-bold">{user.username}</h2><p class={`text-sm ${premium ? "text-green-500" : "text-gray-500"}`}>{premium ? `VIP Active (${daysLeft} days)` : "Free Account"}</p></div></div><div class="bg-[#1f1f1f] p-4 rounded-lg mb-6"><h3 class="font-bold mb-3 text-sm text-gray-400 uppercase">Redeem Code</h3><form action="/profile/redeem" method="post" class="flex gap-2"><input name="key" placeholder="Enter VIP Key" required class="input-box" /><button class="btn-primary whitespace-nowrap">Submit</button></form></div><a href="/logout" class="block w-full bg-zinc-800 text-center py-3 rounded text-red-500 font-bold">Log Out</a></div></Layout>); });
app.post("/profile/redeem", async (c) => { const user = await getCurrentUser(c); if (!user) return c.redirect("/login"); const { key } = await c.req.parseBody(); const keyData = await kv.get<VipKey>(["keys", String(key)]); if (!keyData.value) return c.text("Invalid Key", 400); const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date(); currentExpiry.setDate(currentExpiry.getDate() + keyData.value.days); user.expiryDate = currentExpiry.toISOString(); await kv.set(["users", user.username], user); await kv.delete(["keys", String(key)]); return c.redirect("/profile"); });
app.get("/logout", (c) => { deleteCookie(c, "user_session"); return c.redirect("/"); });

// --- ADMIN ROUTES ---
const adminAuth = async (c: any, next: any) => {
  const session = getCookie(c, "admin_session");
  if (session === Deno.env.get("ADMIN_PASSWORD")) await next();
  else return c.redirect("/admin");
};

app.get("/admin", (c) => c.html(<Layout hideNav={true}><div class="min-h-screen flex items-center justify-center bg-black"><form action="/admin/login" method="post" class="bg-[#1f1f1f] p-8 rounded w-80"><h2 class="font-bold text-center mb-4">Admin Login</h2><input type="password" name="password" placeholder="Key" class="input-box mb-4" /><button class="btn-primary w-full">Enter</button></form></div></Layout>));
app.post("/admin/login", async (c) => { const { password } = await c.req.parseBody(); if (password === Deno.env.get("ADMIN_PASSWORD")) { setCookie(c, "admin_session", String(password), { path: "/" }); return c.redirect("/admin/dashboard"); } return c.redirect("/admin"); });

app.get("/admin/dashboard", adminAuth, async (c) => {
    const movies = await getMovies();
    const keys = await getKeys();
    const editId = c.req.query("edit");
    const editMovie = editId ? movies.find(m => m.id === editId) : null;

    return c.html(
        <Layout title="Admin">
            <div class="p-4 bg-zinc-900 min-h-screen">
                <div class="flex justify-between items-center mb-6">
                    <h1 class="font-bold text-red-600">Admin Panel</h1>
                    <a href="/" class="text-xs bg-black px-3 py-1 rounded">View App</a>
                </div>

                <div class="grid lg:grid-cols-2 gap-6">
                    <div class="space-y-6">
                        {/* Add/Edit Movie Form */}
                        <div class="bg-[#1f1f1f] p-4 rounded border border-zinc-700 sticky top-4">
                            <h2 class="font-bold mb-3 text-sm text-yellow-500">{editMovie ? "Edit Movie" : "Add Movie"}</h2>
                            <form action="/admin/movie/save" method="post" class="space-y-2 text-sm">
                                <input type="hidden" name="id" value={editMovie?.id || crypto.randomUUID()} />
                                <input type="hidden" name="createdAt" value={editMovie?.createdAt || Date.now()} />
                                <input name="title" placeholder="Title" value={editMovie?.title} required class="input-box" />
                                <div class="flex gap-2">
                                    <select name="category" class="input-box">
                                        {["Movies","Series","Adult"].map(o => <option selected={editMovie?.category===o}>{o}</option>)}
                                    </select>
                                    <input name="year" value={editMovie?.year || "2025"} class="input-box w-20" />
                                </div>
                                <input name="posterUrl" placeholder="Poster URL (Portrait)" value={editMovie?.posterUrl} required class="input-box" />
                                <input name="coverUrl" placeholder="Cover URL (Landscape - Slider)" value={editMovie?.coverUrl} required class="input-box border-yellow-500/50" />
                                <div class="p-2 bg-black rounded border border-zinc-800">
                                    <select name="linkType" class="input-box mb-2 text-xs">
                                        <option value="direct" selected={editMovie?.linkType==="direct"}>Direct Link (Auto-Resolve)</option>
                                        <option value="embed" selected={editMovie?.linkType==="embed"}>Embed Code / Iframe</option>
                                    </select>
                                    <input name="streamUrl" placeholder="URL or Iframe Code" value={editMovie?.streamUrl} required class="input-box" />
                                </div>
                                <textarea name="description" placeholder="Desc" class="input-box">{editMovie?.description}</textarea>
                                <button class="btn-primary w-full">{editMovie ? "Update Movie" : "Save Movie"}</button>
                                {editMovie && <a href="/admin/dashboard" class="block text-center text-xs text-gray-400 mt-2">Cancel Edit</a>}
                            </form>
                        </div>
                        {/* Key Gen */}
                        <div class="bg-[#1f1f1f] p-4 rounded border border-zinc-700">
                            <h2 class="font-bold mb-3 text-sm">VIP Keys</h2>
                            <form action="/admin/key/create" method="post" class="flex gap-2"><input type="number" name="days" placeholder="Days" required class="input-box" /><button class="btn-primary">Gen</button></form>
                            <div class="mt-2 max-h-32 overflow-y-auto">{keys.map(k => (<div class="flex justify-between text-xs p-2 border-b border-zinc-800"><span class="text-yellow-500 font-mono">{k.code}</span><span>{k.days}D</span><form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-red-500">x</button></form></div>))}</div>
                        </div>
                    </div>
                    {/* Movie List with Search & Edit */}
                    <div class="bg-[#1f1f1f] p-4 rounded border border-zinc-700 h-fit">
                        <div class="flex justify-between items-center mb-3">
                             <h2 class="font-bold text-sm">Library ({movies.length})</h2>
                             <input oninput="filterMovies(this.value)" placeholder="Search..." class="bg-black border border-zinc-800 rounded px-2 py-1 text-xs w-32" />
                        </div>
                        <div class="space-y-2 max-h-[80vh] overflow-y-auto pr-2">
                            {movies.map(m => (
                                <div class="movie-item flex gap-3 mb-3 p-2 bg-black rounded items-center group relative" data-title={m.title}>
                                    <img src={m.posterUrl} class="w-10 h-14 object-cover" />
                                    <div class="flex-grow min-w-0">
                                        <div class="font-bold text-xs truncate">{m.title}</div>
                                        <div class="text-[10px] text-gray-500">{m.category}</div>
                                    </div>
                                    <div class="flex gap-2">
                                        <a href={`/admin/dashboard?edit=${m.id}`} class="text-blue-500 text-xs border border-blue-500/50 px-2 py-1 rounded hover:bg-blue-500/10">Edit</a>
                                        <form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Del?')"><button class="text-red-500 text-xs border border-red-500/50 px-2 py-1 rounded hover:bg-red-500/10">Del</button></form>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
});

app.post("/admin/movie/save", adminAuth, async (c) => {
    const body = await c.req.parseBody();
    const movie = { 
        ...body, 
        id: body["id"], 
        createdAt: Number(body["createdAt"]) 
    };
    await kv.set(["movies", movie.id as string], movie);
    return c.redirect("/admin/dashboard");
});
app.post("/admin/movie/delete/:id", adminAuth, async (c) => { await kv.delete(["movies", c.req.param("id")]); return c.redirect("/admin/dashboard"); });
app.post("/admin/key/create", adminAuth, async (c) => { const { days } = await c.req.parseBody(); const code = "VIP-" + Math.random().toString(36).substring(2, 7).toUpperCase(); await kv.set(["keys", code], { code, days: parseInt(String(days)) }); return c.redirect("/admin/dashboard"); });
app.post("/admin/key/delete/:code", adminAuth, async (c) => { await kv.delete(["keys", c.req.param("code")]); return c.redirect("/admin/dashboard"); });

Deno.serve(app.fetch);
