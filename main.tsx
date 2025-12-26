/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const app = new Hono();
const kv = await Deno.openKv();

// --- Types ---
interface Movie {
  id: string;
  title: string;
  posterUrl: string;
  category: "Movies" | "Series" | "Adult";
  description: string;
  tags: string;
  year: string;
  streamUrl: string;
  linkType: "direct" | "embed"; // New: To handle mp4 vs iframe
  downloadUrl?: string;
  createdAt: number; // For sorting
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
  return movies.sort((a, b) => b.createdAt - a.createdAt); // Newest first
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

// Resolve Redirects (For TkTube type links)
async function resolveRedirect(url: string) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return res.url; // Returns the final long URL
  } catch {
    return url;
  }
}

// --- UI Components ---
const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{props.title || "Gold Flix Premium"}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <style>{`
        body { background-color: #141414; color: #e5e5e5; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
        .gold-text { color: #E50914; } /* Netflix Red style or Gold #EAB308 */
        .glass { background: #1f1f1f; border: 1px solid #333; }
        .input-box { background: #333; border: 1px solid #444; color: white; padding: 12px; border-radius: 4px; width: 100%; outline: none; }
        .input-box:focus { border-color: #E50914; background: #404040; }
        .btn-primary { background: #E50914; color: white; font-weight: bold; padding: 10px 20px; border-radius: 4px; transition: 0.2s; }
        .btn-primary:hover { background: #f40612; }
      `}</style>
    </head>
    <body class="min-h-screen flex flex-col">
      {!props.hideNav && (
        <nav class="sticky top-0 z-50 bg-black/90 backdrop-blur-sm border-b border-white/10 px-4 py-3">
          <div class="max-w-7xl mx-auto flex justify-between items-center">
            <a href="/" class="text-2xl font-black text-red-600 tracking-tighter">GOLD FLIX</a>
            <div class="flex items-center gap-4 text-sm">
              <a href="/" class="hover:text-white text-gray-400">Home</a>
              <a href="/category/Movies" class="hover:text-white text-gray-400">Movies</a>
              <a href="/category/Series" class="hover:text-white text-gray-400">Series</a>
              <a href="/category/Adult" class="hover:text-red-500 text-red-600 font-bold">18+</a>
              {props.user ? (
                <a href="/profile" class="ml-2 w-8 h-8 rounded bg-red-600 flex items-center justify-center font-bold text-white">
                   {props.user.username[0].toUpperCase()}
                </a>
              ) : (
                <a href="/login" class="ml-2 bg-red-600 px-4 py-1 rounded text-white font-bold text-xs">Sign In</a>
              )}
            </div>
          </div>
        </nav>
      )}

      <main class="flex-grow w-full">
        {props.children}
      </main>

      <footer class="p-8 bg-black text-center text-gray-500 text-xs mt-10 border-t border-zinc-800">
        © 2025 Gold Flix. Premium Streaming.
      </footer>
    </body>
  </html>
);

// --- ROUTES ---

// 1. Home Page (Preview Sections)
app.get("/", async (c) => {
  const user = await getCurrentUser(c);
  const allMovies = await getMovies();
  
  const sections = ["Movies", "Series", "Adult"];
  
  return c.html(
    <Layout user={user}>
      {/* Hero / Banner (Optional - using first movie as featured) */}
      {allMovies[0] && (
        <div class="relative h-[50vh] w-full overflow-hidden">
             <img src={allMovies[0].posterUrl} class="w-full h-full object-cover opacity-60" />
             <div class="absolute inset-0 bg-gradient-to-t from-[#141414] via-transparent to-black/60"></div>
             <div class="absolute bottom-0 p-6 md:p-12 w-full">
                 <span class="bg-red-600 text-white text-xs px-2 py-1 rounded font-bold mb-2 inline-block">Featured</span>
                 <h1 class="text-4xl md:text-6xl font-bold text-white drop-shadow-lg mb-2">{allMovies[0].title}</h1>
                 <p class="max-w-xl text-gray-300 line-clamp-2 mb-4">{allMovies[0].description}</p>
                 <a href={`/movie/${allMovies[0].id}`} class="btn-primary inline-flex items-center gap-2">
                    <i class="fa-solid fa-play"></i> Play Now
                 </a>
             </div>
        </div>
      )}

      <div class="max-w-7xl mx-auto px-4 py-8 space-y-12">
        {sections.map(cat => {
            const catMovies = allMovies.filter(m => m.category === cat).slice(0, 6); // Show only 6
            if (catMovies.length === 0) return null;
            return (
                <div>
                    <div class="flex justify-between items-end mb-4 px-1">
                        <h2 class="text-xl md:text-2xl font-bold text-white border-l-4 border-red-600 pl-3">{cat}</h2>
                        <a href={`/category/${cat}`} class="text-xs font-bold text-gray-400 hover:text-white flex items-center gap-1">
                            See All <i class="fa-solid fa-chevron-right"></i>
                        </a>
                    </div>
                    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 md:gap-4">
                        {catMovies.map(m => (
                            <a href={`/movie/${m.id}`} class="group block relative rounded bg-[#1f1f1f] overflow-hidden hover:z-10 transition-transform duration-300 hover:scale-105">
                                <div class="aspect-[2/3] w-full">
                                    <img src={m.posterUrl} class="w-full h-full object-cover" />
                                </div>
                                <div class="p-2">
                                    <h3 class="text-sm font-bold truncate text-white">{m.title}</h3>
                                    <div class="flex justify-between text-[10px] text-gray-400 mt-1">
                                        <span>{m.year}</span>
                                        <span>HD</span>
                                    </div>
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

// 2. Category Page with Pagination
app.get("/category/:cat", async (c) => {
    const user = await getCurrentUser(c);
    const cat = c.req.param("cat");
    const page = parseInt(c.req.query("page") || "1");
    const limit = 15;
    
    const { data, totalPages } = await getPaginatedMovies(cat, page, limit);

    return c.html(
        <Layout user={user}>
            <div class="max-w-7xl mx-auto px-4 py-8">
                <h1 class="text-3xl font-bold mb-6 text-white">{cat} <span class="text-lg text-gray-500 font-normal">(Page {page})</span></h1>
                
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                    {data.map(m => (
                         <a href={`/movie/${m.id}`} class="block bg-[#1f1f1f] rounded overflow-hidden hover:ring-2 hover:ring-red-600 transition">
                            <img src={m.posterUrl} class="aspect-[2/3] object-cover w-full" />
                            <div class="p-3">
                                <h3 class="text-sm font-bold truncate text-white">{m.title}</h3>
                            </div>
                         </a>
                    ))}
                </div>

                {/* Pagination Controls */}
                <div class="flex justify-center gap-4 mt-10">
                    {page > 1 && (
                        <a href={`/category/${cat}?page=${page - 1}`} class="btn-primary bg-gray-700 hover:bg-gray-600">Prev</a>
                    )}
                    <span class="py-2 px-4 bg-black border border-gray-700 rounded text-gray-400">
                        {page} / {totalPages || 1}
                    </span>
                    {page < totalPages && (
                        <a href={`/category/${cat}?page=${page + 1}`} class="btn-primary">Next</a>
                    )}
                </div>
            </div>
        </Layout>
    );
});

// 3. Movie Detail & Resolving Link
app.get("/movie/:id", async (c) => {
    const id = c.req.param("id");
    const movie = await getMovie(id);
    const user = await getCurrentUser(c);
    
    if (!movie) return c.text("Not Found", 404);
  
    const premium = isPremium(user);
    
    // Auto-resolve redirect if it's a direct link type (Attempt to fix tkTube links)
    let finalStreamUrl = movie.streamUrl;
    if (premium && movie.linkType === "direct" && !movie.streamUrl.includes("iframe")) {
        // Only try to resolve if it looks like a short link
        finalStreamUrl = await resolveRedirect(movie.streamUrl);
    }
  
    return c.html(
      <Layout user={user} title={movie.title}>
        <div class="max-w-6xl mx-auto px-4 py-6">
           <div class="bg-black aspect-video w-full rounded-lg overflow-hidden border border-zinc-800 relative shadow-2xl">
              {premium ? (
                  movie.linkType === "embed" || movie.streamUrl.includes("<iframe") ? (
                      <div dangerouslySetInnerHTML={{__html: movie.streamUrl}} class="w-full h-full [&_iframe]:w-full [&_iframe]:h-full [&_iframe]:border-0"></div>
                  ) : (
                      <video controls class="w-full h-full" poster={movie.posterUrl} preload="metadata">
                          <source src={finalStreamUrl} type="video/mp4" />
                          <p class="text-center mt-20">Your browser cannot play this video.</p>
                      </video>
                  )
              ) : (
                  <div class="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10 text-center">
                      <i class="fa-solid fa-lock text-5xl text-red-600 mb-4"></i>
                      <h2 class="text-2xl font-bold text-white">Premium Content</h2>
                      <p class="text-gray-400 mb-6 mt-2">Activate a VIP Key to watch this video.</p>
                      {user ? <a href="/profile" class="btn-primary">Upgrade Now</a> : <a href="/login" class="btn-primary">Login to Watch</a>}
                  </div>
              )}
           </div>
           
           <div class="mt-6 grid md:grid-cols-[3fr_1fr] gap-8">
               <div>
                   <h1 class="text-3xl font-bold text-white mb-2">{movie.title}</h1>
                   <div class="flex items-center gap-3 text-sm text-gray-400 mb-4">
                       <span class="border border-gray-600 px-2 rounded">{movie.year}</span>
                       <span class="text-red-500 font-bold">{movie.category}</span>
                       <span>{movie.tags}</span>
                   </div>
                   <p class="text-gray-300 leading-relaxed">{movie.description}</p>
                   {premium && movie.downloadUrl && (
                       <a href={movie.downloadUrl} target="_blank" class="mt-6 inline-block bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-3 rounded font-bold">
                           <i class="fa-solid fa-download mr-2"></i> Download
                       </a>
                   )}
               </div>
               <div class="bg-[#1f1f1f] p-4 rounded h-fit">
                   <img src={movie.posterUrl} class="w-full rounded mb-3" />
                   <p class="text-center text-xs text-gray-500">Scan to share</p>
               </div>
           </div>
        </div>
      </Layout>
    );
});

// 4. Auth Pages (Fixed UI - Centered & Straight)
app.get("/login", (c) => c.html(
    <Layout hideNav={true}>
        <div class="min-h-screen flex items-center justify-center bg-[url('https://assets.nflxext.com/ffe/siteui/vlv3/ab180a27-b661-44cd-9579-9dcaf57d6da0/9661a72d-222a-4318-910a-31a87e83d352/US-en-20231009-popsignuptwoweeks-perspective_alpha_website_large.jpg')] bg-cover bg-center">
            <div class="absolute inset-0 bg-black/60"></div>
            <div class="relative z-10 bg-black/75 p-8 md:p-12 rounded-lg max-w-md w-full shadow-2xl border-t-2 border-red-600">
                <h1 class="text-3xl font-bold text-white mb-8">Sign In</h1>
                <form action="/login" method="post" class="space-y-4">
                    <input name="username" placeholder="Username" required class="input-box" />
                    <input type="password" name="password" placeholder="Password" required class="input-box" />
                    <button class="btn-primary w-full py-3 mt-4 text-lg">Sign In</button>
                    <div class="flex justify-between text-sm text-gray-400 mt-2">
                         <label class="flex items-center"><input type="checkbox" class="mr-2" /> Remember me</label>
                         <a href="#" class="hover:underline">Need help?</a>
                    </div>
                </form>
                <div class="mt-8 text-gray-400 text-sm">
                    New to Gold Flix? <a href="/signup" class="text-white hover:underline font-bold">Sign up now</a>.
                </div>
            </div>
        </div>
    </Layout>
));

app.post("/login", async (c) => {
    const { username, password } = await c.req.parseBody();
    const user = await getUser(username as string);
    if (user && user.password === password) {
        setCookie(c, "user_session", String(username), { path: "/", maxAge: 86400 * 30 });
        return c.redirect("/profile");
    }
    return c.text("Invalid Credentials", 401);
});

app.get("/signup", (c) => c.html(
    <Layout hideNav={true}>
        <div class="min-h-screen flex items-center justify-center bg-black">
             <div class="bg-[#1f1f1f] p-8 md:p-12 rounded-lg max-w-md w-full border border-zinc-800">
                <h1 class="text-3xl font-bold text-white mb-6">Create Account</h1>
                <form action="/signup" method="post" class="space-y-4">
                    <input name="username" placeholder="Choose Username" required class="input-box" />
                    <input type="password" name="password" placeholder="Create Password" required class="input-box" />
                    <button class="btn-primary w-full py-3 text-lg">Sign Up</button>
                </form>
                <p class="mt-4 text-gray-400 text-center">Already have an account? <a href="/login" class="text-white font-bold">Login</a></p>
            </div>
        </div>
    </Layout>
));

app.post("/signup", async (c) => {
    const { username, password } = await c.req.parseBody();
    if (await getUser(username as string)) return c.text("User already exists", 400);
    const newUser: User = { username: String(username), password: String(password), expiryDate: null, favorites: [] };
    await kv.set(["users", String(username)], newUser);
    return c.redirect("/login");
});

// 5. Profile
app.get("/profile", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const premium = isPremium(user);
    const daysLeft = user.expiryDate ? Math.ceil((new Date(user.expiryDate).getTime() - Date.now()) / 86400000) : 0;

    return c.html(
        <Layout user={user}>
            <div class="max-w-2xl mx-auto px-4 py-10">
                <h1 class="text-3xl font-bold mb-8">Account</h1>
                <div class="bg-[#1f1f1f] p-6 rounded border border-zinc-700 flex flex-col md:flex-row gap-6 items-center">
                    <div class="w-24 h-24 bg-red-600 rounded-full flex items-center justify-center text-4xl font-bold text-white">
                        {user.username[0].toUpperCase()}
                    </div>
                    <div class="flex-grow text-center md:text-left">
                        <h2 class="text-xl font-bold">{user.username}</h2>
                        <p class="text-gray-400 text-sm">Member since 2025</p>
                        <div class="mt-2 inline-block px-3 py-1 rounded bg-black border border-zinc-700 text-sm">
                            Status: <span class={premium ? "text-green-500 font-bold" : "text-gray-500"}>{premium ? "Premium VIP" : "Free Plan"}</span>
                        </div>
                        {premium && <p class="text-xs text-green-400 mt-1">{daysLeft} days remaining</p>}
                    </div>
                    <a href="/logout" class="text-red-500 hover:underline text-sm font-bold">Sign Out</a>
                </div>

                <div class="mt-8 bg-[#1f1f1f] p-6 rounded border border-zinc-700">
                    <h3 class="font-bold text-lg mb-4 text-yellow-500">Redeem VIP Key</h3>
                    <form action="/profile/redeem" method="post" class="flex gap-2">
                        <input name="key" placeholder="Enter XXXXX-XXXXX key" required class="input-box" />
                        <button class="btn-primary whitespace-nowrap">Activate</button>
                    </form>
                </div>
            </div>
        </Layout>
    );
});

app.post("/profile/redeem", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const { key } = await c.req.parseBody();
    const keyData = await kv.get<VipKey>(["keys", String(key)]);
    
    if (!keyData.value) return c.text("Invalid Key", 400);

    const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date();
    currentExpiry.setDate(currentExpiry.getDate() + keyData.value.days);
    
    user.expiryDate = currentExpiry.toISOString();
    await kv.set(["users", user.username], user);
    await kv.delete(["keys", String(key)]);
    
    return c.redirect("/profile");
});

app.get("/logout", (c) => {
    deleteCookie(c, "user_session");
    return c.redirect("/");
});

// --- ADMIN PANEL ---
const adminAuth = async (c: any, next: any) => {
  const session = getCookie(c, "admin_session");
  const envPass = Deno.env.get("ADMIN_PASSWORD");
  if (session === envPass) await next();
  else return c.redirect("/admin");
};

app.get("/admin", (c) => c.html(
    <Layout hideNav={true}>
        <div class="min-h-screen flex items-center justify-center bg-black">
            <form action="/admin/login" method="post" class="bg-[#1f1f1f] p-8 rounded border border-zinc-700 w-80">
                <h2 class="text-xl font-bold mb-4 text-center">Admin Login</h2>
                <input type="password" name="password" placeholder="Pass Code" class="input-box mb-4" />
                <button class="btn-primary w-full">Access</button>
            </form>
        </div>
    </Layout>
));

app.post("/admin/login", async (c) => {
    const { password } = await c.req.parseBody();
    if (password === Deno.env.get("ADMIN_PASSWORD")) {
        setCookie(c, "admin_session", String(password), { path: "/" });
        return c.redirect("/admin/dashboard");
    }
    return c.redirect("/admin");
});

app.get("/admin/dashboard", adminAuth, async (c) => {
    const movies = await getMovies();
    const keys = await getKeys();
    return c.html(
        <Layout title="Admin">
            <div class="bg-zinc-900 min-h-screen p-4 md:p-8">
                <div class="flex justify-between items-center mb-8">
                    <h1 class="text-2xl font-bold text-red-600">Admin Control</h1>
                    <a href="/" class="bg-black px-4 py-2 rounded border border-zinc-700 hover:text-white">View Site</a>
                </div>

                <div class="grid lg:grid-cols-3 gap-8">
                    {/* Add Movie Form */}
                    <div class="lg:col-span-1 space-y-6">
                        <div class="bg-[#1f1f1f] p-6 rounded border border-zinc-700">
                            <h2 class="font-bold mb-4 text-white">Add Movie</h2>
                            <form action="/admin/movie/save" method="post" class="space-y-3">
                                <input type="hidden" name="id" value={crypto.randomUUID()} />
                                <input name="title" placeholder="Movie Title" required class="input-box" />
                                <div class="flex gap-2">
                                    <select name="category" class="input-box">
                                        <option>Movies</option><option>Series</option><option>Adult</option>
                                    </select>
                                    <input name="year" value="2025" class="input-box w-24" />
                                </div>
                                <input name="posterUrl" placeholder="Poster Image URL" required class="input-box" />
                                
                                {/* New Link Type Selector */}
                                <div class="bg-black/30 p-3 rounded border border-zinc-700">
                                    <label class="text-xs text-gray-400 block mb-2">Video Source Type</label>
                                    <select name="linkType" class="input-box mb-2 text-sm">
                                        <option value="direct">Direct Link (Auto-Resolve Redirects)</option>
                                        <option value="embed">Embed Code / Iframe (Recommended)</option>
                                    </select>
                                    <input name="streamUrl" placeholder="Paste URL or Embed Code here..." required class="input-box" />
                                </div>
                                
                                <input name="tags" placeholder="Tags (e.g. Action, 2025)" class="input-box" />
                                <textarea name="description" placeholder="Description" rows={3} class="input-box"></textarea>
                                <button class="btn-primary w-full">Save Movie</button>
                            </form>
                        </div>

                        {/* Key Gen */}
                        <div class="bg-[#1f1f1f] p-6 rounded border border-zinc-700">
                            <h2 class="font-bold mb-4">Generate VIP Key</h2>
                            <form action="/admin/key/create" method="post" class="flex gap-2">
                                <input type="number" name="days" placeholder="Days" required class="input-box w-20" />
                                <button class="btn-primary flex-grow">Generate</button>
                            </form>
                            <div class="mt-4 max-h-40 overflow-y-auto space-y-2">
                                {keys.map(k => (
                                    <div class="flex justify-between items-center bg-black p-2 rounded text-xs border border-zinc-800">
                                        <span class="text-yellow-500 font-mono">{k.code}</span>
                                        <span>{k.days}D</span>
                                        <form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-red-500">×</button></form>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Movie List */}
                    <div class="lg:col-span-2">
                        <div class="bg-[#1f1f1f] p-6 rounded border border-zinc-700">
                            <h2 class="font-bold mb-4">Library ({movies.length})</h2>
                            <div class="space-y-2 max-h-[80vh] overflow-y-auto pr-2">
                                {movies.map(m => (
                                    <div class="flex gap-4 bg-black p-3 rounded border border-zinc-800 items-center">
                                        <img src={m.posterUrl} class="w-12 h-16 object-cover rounded" />
                                        <div class="flex-grow">
                                            <h3 class="font-bold text-sm text-white">{m.title}</h3>
                                            <div class="text-xs text-gray-500 flex gap-2">
                                                <span>{m.category}</span>
                                                <span>{m.year}</span>
                                                <span class="text-red-500 uppercase">{m.linkType}</span>
                                            </div>
                                        </div>
                                        <form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Delete?');">
                                            <button class="text-gray-400 hover:text-red-500"><i class="fa-solid fa-trash"></i></button>
                                        </form>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
});

// Admin Actions
app.post("/admin/movie/save", adminAuth, async (c) => {
    const body = await c.req.parseBody();
    const movie = { ...body, id: body["id"] || crypto.randomUUID(), createdAt: Date.now() };
    await kv.set(["movies", movie.id], movie);
    return c.redirect("/admin/dashboard");
});

app.post("/admin/movie/delete/:id", adminAuth, async (c) => {
    await kv.delete(["movies", c.req.param("id")]);
    return c.redirect("/admin/dashboard");
});

app.post("/admin/key/create", adminAuth, async (c) => {
    const { days } = await c.req.parseBody();
    const code = "VIP-" + Math.random().toString(36).substring(2, 7).toUpperCase();
    await kv.set(["keys", code], { code, days: parseInt(String(days)) });
    return c.redirect("/admin/dashboard");
});

app.post("/admin/key/delete/:code", adminAuth, async (c) => {
    await kv.delete(["keys", c.req.param("code")]);
    return c.redirect("/admin/dashboard");
});

Deno.serve(app.fetch);
