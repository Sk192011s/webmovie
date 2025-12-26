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
  streamUrl: string; // Can be URL or <iframe...>
  downloadUrl?: string;
}

interface User {
  username: string;
  password: string; // Plaintext for simplicity (Use hash in production)
  expiryDate: string | null; // ISO Date String
  favorites: string[]; // List of Movie IDs
}

interface VipKey {
  code: string;
  days: number; // Duration in days
}

// --- Database Helpers ---
async function getMovies() {
  const iter = kv.list<Movie>({ prefix: ["movies"] });
  const movies = [];
  for await (const res of iter) movies.push(res.value);
  return movies.sort((a, b) => b.year.localeCompare(a.year));
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

// --- Middleware & Logic ---
async function getCurrentUser(c: any) {
  const username = getCookie(c, "user_session");
  if (!username) return null;
  return await getUser(username);
}

function isPremium(user: User | null) {
  if (!user || !user.expiryDate) return false;
  return new Date(user.expiryDate) > new Date();
}

// --- UI Components ---
const Layout = (props: { children: any; title?: string; user?: User | null; backUrl?: string }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{props.title || "Gold Flix"}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet" />
      <style>{`
        body { background-color: #09090b; color: #fff; font-family: sans-serif; }
        .bg-glass { background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        .gold-text { background: linear-gradient(to right, #fbbf24, #d97706); -webkit-background-clip: text; color: transparent; }
      `}</style>
    </head>
    <body class="min-h-screen flex flex-col pb-20 md:pb-0">
      {/* Navbar */}
      <nav class="sticky top-0 z-50 bg-black/90 backdrop-blur border-b border-white/10">
        <div class="max-w-6xl mx-auto p-4 flex justify-between items-center">
          <div class="flex items-center gap-4">
            {props.backUrl && (
                <a href={props.backUrl} class="text-white hover:text-yellow-500 text-xl">
                    <i class="fa-solid fa-arrow-left"></i>
                </a>
            )}
            <a href="/" class="text-2xl font-black italic gold-text">GOLD FLIX</a>
          </div>
          
          <div class="flex items-center gap-4">
             {props.user ? (
                 <a href="/profile" class="flex items-center gap-2 text-sm font-bold bg-zinc-800 py-1 px-3 rounded-full border border-white/10">
                    <i class="fa-solid fa-user text-yellow-500"></i>
                    <span class="hidden md:inline">{props.user.username}</span>
                 </a>
             ) : (
                 <a href="/login" class="text-sm font-bold text-yellow-500 hover:text-white">Login</a>
             )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main class="flex-grow p-4 md:p-6 max-w-6xl mx-auto w-full">
        {props.children}
      </main>

      {/* Mobile Bottom Nav */}
      <div class="md:hidden fixed bottom-0 w-full bg-black border-t border-white/10 flex justify-around p-3 z-40 text-xs">
          <a href="/" class="flex flex-col items-center gap-1 text-gray-400 hover:text-yellow-500">
             <i class="fa-solid fa-home text-lg"></i> Home
          </a>
          <a href="/favorites" class="flex flex-col items-center gap-1 text-gray-400 hover:text-yellow-500">
             <i class="fa-solid fa-heart text-lg"></i> Saved
          </a>
          <a href="/profile" class="flex flex-col items-center gap-1 text-gray-400 hover:text-yellow-500">
             <i class="fa-solid fa-user text-lg"></i> Me
          </a>
      </div>
    </body>
  </html>
);

// --- ROUTES ---

// 1. Home Page
app.get("/", async (c) => {
  const cat = c.req.query("cat") || "Movies";
  const user = await getCurrentUser(c);
  const allMovies = await getMovies();
  const movies = allMovies.filter((m) => m.category === cat);

  return c.html(
    <Layout user={user}>
      {/* Categories */}
      <div class="flex gap-3 overflow-x-auto pb-4 mb-4 scrollbar-hide">
        {["Movies", "Series", "Adult"].map((c) => (
          <a href={`/?cat=${c}`} class={`px-6 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${cat === c ? "bg-yellow-500 text-black" : "bg-zinc-800 text-gray-300"}`}>
            {c}
          </a>
        ))}
      </div>

      {/* Grid */}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        {movies.map((movie) => (
          <a href={`/movie/${movie.id}`} class="block bg-zinc-900 rounded-lg overflow-hidden relative group">
             <div class="aspect-[2/3] relative">
                 <img src={movie.posterUrl} class="w-full h-full object-cover" />
                 <div class="absolute inset-0 bg-black/20 group-hover:bg-black/0 transition-all"></div>
             </div>
             <div class="p-3">
                 <h3 class="font-bold text-sm truncate">{movie.title}</h3>
                 <div class="flex justify-between items-center text-xs text-gray-500 mt-1">
                     <span>{movie.year}</span>
                     <span class="text-yellow-600">{movie.category}</span>
                 </div>
             </div>
          </a>
        ))}
      </div>
    </Layout>
  );
});

// 2. Movie Detail
app.get("/movie/:id", async (c) => {
  const id = c.req.param("id");
  const movie = await getMovie(id);
  const user = await getCurrentUser(c);
  
  if (!movie) return c.text("Not Found", 404);

  const premiumUser = isPremium(user);
  const isFav = user?.favorites.includes(id);

  // Video Renderer Logic (Iframe or Video Tag)
  const isEmbed = movie.streamUrl.trim().startsWith("<iframe");

  return c.html(
    <Layout user={user} backUrl="/" title={movie.title}>
      <div class="max-w-4xl mx-auto">
         {/* Video Player */}
         <div class="aspect-video bg-black rounded-xl overflow-hidden shadow-2xl mb-6 relative border border-white/10">
            {premiumUser ? (
                isEmbed ? (
                    <div dangerouslySetInnerHTML={{__html: movie.streamUrl}} class="w-full h-full [&_iframe]:w-full [&_iframe]:h-full"></div>
                ) : (
                    <video controls class="w-full h-full" poster={movie.posterUrl}>
                        <source src={movie.streamUrl} type="video/mp4" />
                    </video>
                )
            ) : (
                <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/90 backdrop-blur z-10 text-center p-6">
                    <i class="fa-solid fa-crown text-5xl text-yellow-500 mb-4 animate-bounce"></i>
                    <h2 class="text-xl font-bold text-white mb-2">VIP Membership Required</h2>
                    <p class="text-gray-400 mb-4 text-sm">Please login and activate a VIP Key to watch.</p>
                    {user ? (
                        <a href="/profile" class="bg-yellow-500 text-black font-bold px-6 py-2 rounded-full">Upgrade Now</a>
                    ) : (
                        <a href="/login" class="bg-white text-black font-bold px-6 py-2 rounded-full">Login First</a>
                    )}
                </div>
            )}
         </div>

         <div class="flex justify-between items-start mb-6">
             <div>
                 <h1 class="text-2xl md:text-3xl font-bold mb-2">{movie.title}</h1>
                 <div class="flex gap-2 text-sm text-gray-400">
                     <span class="bg-zinc-800 px-2 py-1 rounded">{movie.year}</span>
                     <span class="bg-zinc-800 px-2 py-1 rounded">{movie.category}</span>
                 </div>
             </div>
             {/* Favorite Button */}
             {user && (
                 <form action="/api/fav" method="post">
                     <input type="hidden" name="movieId" value={movie.id} />
                     <button class={`text-2xl ${isFav ? "text-red-500" : "text-gray-500 hover:text-white"}`}>
                         <i class={`fa-${isFav ? "solid" : "regular"} fa-heart`}></i>
                     </button>
                 </form>
             )}
         </div>

         <p class="text-gray-300 leading-relaxed mb-8">{movie.description}</p>

         {premiumUser && movie.downloadUrl && (
             <a href={movie.downloadUrl} target="_blank" class="block w-full text-center bg-zinc-800 hover:bg-zinc-700 py-3 rounded-lg font-bold text-white">
                 <i class="fa-solid fa-download mr-2"></i> Download
             </a>
         )}
      </div>
    </Layout>
  );
});

// 3. Favorites Page
app.get("/favorites", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.redirect("/login");

  const allMovies = await getMovies();
  const favMovies = allMovies.filter(m => user.favorites.includes(m.id));

  return c.html(
    <Layout user={user} backUrl="/" title="My Favorites">
        <h1 class="text-xl font-bold mb-6 flex items-center gap-2">
            <i class="fa-solid fa-heart text-red-500"></i> Saved Movies
        </h1>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            {favMovies.map(m => (
                <a href={`/movie/${m.id}`} class="block relative">
                    <img src={m.posterUrl} class="rounded-lg aspect-[2/3] object-cover" />
                    <div class="mt-2 text-sm font-bold truncate">{m.title}</div>
                </a>
            ))}
        </div>
        {favMovies.length === 0 && <p class="text-gray-500 text-center mt-10">No favorites yet.</p>}
    </Layout>
  );
});

// 4. User Profile & VIP Logic
app.get("/profile", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.redirect("/login");

  const premium = isPremium(user);
  const expiry = user.expiryDate ? new Date(user.expiryDate).toLocaleDateString() : "No Active Plan";
  const daysLeft = user.expiryDate 
    ? Math.ceil((new Date(user.expiryDate).getTime() - new Date().getTime()) / (1000 * 3600 * 24)) 
    : 0;

  return c.html(
    <Layout user={user} backUrl="/" title="Profile">
       <div class="max-w-md mx-auto mt-6">
           <div class="bg-gradient-to-r from-zinc-800 to-zinc-900 p-6 rounded-2xl border border-white/10 text-center mb-8">
               <div class="w-20 h-20 bg-black rounded-full mx-auto flex items-center justify-center text-3xl mb-4 border-2 border-yellow-500">
                   {premium ? "👑" : "👤"}
               </div>
               <h2 class="text-xl font-bold">{user.username}</h2>
               <div class="mt-4 inline-block bg-black/50 px-4 py-2 rounded-lg">
                   <p class="text-xs text-gray-400 uppercase tracking-wider">Plan Status</p>
                   <p class={`text-lg font-bold ${premium ? "text-yellow-400" : "text-gray-400"}`}>
                       {premium ? "VIP Member" : "Free User"}
                   </p>
                   {premium && <p class="text-xs text-green-400 mt-1">{daysLeft} Days Left (Exp: {expiry})</p>}
               </div>
           </div>

           {/* Redeem Key Form */}
           <div class="bg-glass p-6 rounded-xl mb-6">
               <h3 class="font-bold mb-3 flex items-center gap-2"><i class="fa-solid fa-key text-yellow-500"></i> Redeem VIP Key</h3>
               <form action="/profile/redeem" method="post" class="flex gap-2">
                   <input name="key" placeholder="Enter VIP Key" required class="bg-black/50" />
                   <button class="bg-yellow-500 text-black font-bold px-4 rounded">Apply</button>
               </form>
           </div>
           
           <a href="/logout" class="block text-center text-red-500 font-bold py-3 bg-red-500/10 rounded-xl">Logout</a>
       </div>
    </Layout>
  );
});

// 5. Auth Routes (Login/Signup)
app.get("/login", (c) => c.html(
    <Layout>
        <div class="h-[80vh] flex flex-col justify-center items-center max-w-sm mx-auto p-4">
            <h1 class="text-3xl font-black gold-text mb-8">GOLD FLIX</h1>
            <form action="/login" method="post" class="w-full bg-glass p-6 rounded-xl space-y-4">
                <h2 class="text-xl font-bold text-center mb-4">Login</h2>
                <input name="username" placeholder="Username" required class="bg-black/50" />
                <input type="password" name="password" placeholder="Password" required class="bg-black/50" />
                <button class="w-full bg-yellow-500 text-black font-bold py-3 rounded-lg">Login</button>
                <p class="text-center text-sm text-gray-400 mt-4">
                    New here? <a href="/signup" class="text-yellow-500">Create Account</a>
                </p>
            </form>
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
    return c.text("Invalid credentials", 401);
});

app.get("/signup", (c) => c.html(
    <Layout>
        <div class="h-[80vh] flex flex-col justify-center items-center max-w-sm mx-auto p-4">
            <h1 class="text-3xl font-black gold-text mb-8">GOLD FLIX</h1>
            <form action="/signup" method="post" class="w-full bg-glass p-6 rounded-xl space-y-4">
                <h2 class="text-xl font-bold text-center mb-4">Sign Up</h2>
                <input name="username" placeholder="Username" required class="bg-black/50" />
                <input type="password" name="password" placeholder="Password" required class="bg-black/50" />
                <button class="w-full bg-white text-black font-bold py-3 rounded-lg">Create Account</button>
                <p class="text-center text-sm text-gray-400 mt-4">
                    Already have account? <a href="/login" class="text-yellow-500">Login</a>
                </p>
            </form>
        </div>
    </Layout>
));

app.post("/signup", async (c) => {
    const { username, password } = await c.req.parseBody();
    if (await getUser(username as string)) return c.text("User exists!", 400);
    
    const newUser: User = { username: String(username), password: String(password), expiryDate: null, favorites: [] };
    await kv.set(["users", String(username)], newUser);
    return c.redirect("/login");
});

app.get("/logout", (c) => {
    deleteCookie(c, "user_session");
    return c.redirect("/");
});

// 6. Actions (Redeem / Favorite)
app.post("/profile/redeem", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    
    const { key } = await c.req.parseBody();
    const keyData = await kv.get<VipKey>(["keys", String(key)]);
    
    if (!keyData.value) return c.text("Invalid Key", 400);

    // Calculate New Expiry
    const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() 
        ? new Date(user.expiryDate) 
        : new Date();
    
    currentExpiry.setDate(currentExpiry.getDate() + keyData.value.days); // Add days

    // Update User & Delete Key
    user.expiryDate = currentExpiry.toISOString();
    await kv.set(["users", user.username], user);
    await kv.delete(["keys", String(key)]);

    return c.redirect("/profile");
});

app.post("/api/fav", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.redirect("/login");
    const { movieId } = await c.req.parseBody();
    const id = String(movieId);
    
    if (user.favorites.includes(id)) {
        user.favorites = user.favorites.filter(fid => fid !== id);
    } else {
        user.favorites.push(id);
    }
    await kv.set(["users", user.username], user);
    return c.redirect(c.req.header("Referer") || "/");
});

// --- ADMIN PANEL ---
const adminAuth = async (c: any, next: any) => {
  const session = getCookie(c, "admin_session");
  const envPass = Deno.env.get("ADMIN_PASSWORD");
  if (session === envPass) await next();
  else return c.redirect("/admin");
};

app.get("/admin", (c) => c.html(
    <Layout>
        <div class="h-screen flex justify-center items-center">
            <form action="/admin/login" method="post" class="bg-glass p-8 rounded border border-white/10">
                <h1 class="text-xl font-bold mb-4">Admin Access</h1>
                <input type="password" name="password" placeholder="Password" class="mb-4" />
                <button class="bg-white text-black font-bold px-4 py-2 w-full">Login</button>
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
        <Layout title="Admin Dashboard">
            <div class="flex justify-between items-center mb-6 bg-zinc-900 p-4 rounded-lg">
                <h1 class="text-xl font-bold text-yellow-500">Admin Panel</h1>
                <a href="/" class="text-sm underline">Go to Site</a>
            </div>

            <div class="grid lg:grid-cols-2 gap-8">
                {/* 1. Add Movie */}
                <div class="space-y-6">
                    <div class="bg-glass p-6 rounded-xl border border-white/10">
                        <h2 class="font-bold mb-4">Add / Edit Movie</h2>
                        <form action="/admin/movie/save" method="post" class="space-y-3 text-sm">
                            <input type="hidden" name="id" value={crypto.randomUUID()} />
                            <input name="title" placeholder="Title" required />
                            <div class="grid grid-cols-2 gap-2">
                                <select name="category" class="bg-black border border-gray-700">
                                    <option>Movies</option><option>Series</option><option>Adult</option>
                                </select>
                                <input name="year" value="2025" />
                            </div>
                            <input name="posterUrl" placeholder="Poster Image URL" required />
                            <input name="streamUrl" placeholder="Stream URL (.mp4) OR Embed Code (<iframe...)" required />
                            <p class="text-[10px] text-gray-500">* For redirect links, use &lt;iframe src="..."&gt;&lt;/iframe&gt;</p>
                            <input name="tags" placeholder="Tags (Action, Horror)" />
                            <textarea name="description" placeholder="Synopsis" rows={2}></textarea>
                            <button class="bg-green-600 w-full py-2 rounded font-bold">Save Movie</button>
                        </form>
                    </div>
                </div>

                {/* 2. Key Generator */}
                <div class="space-y-6">
                    <div class="bg-glass p-6 rounded-xl border border-white/10">
                        <h2 class="font-bold mb-4">Generate VIP Key</h2>
                        <form action="/admin/key/create" method="post" class="flex gap-2">
                            <input type="number" name="days" placeholder="Days (e.g. 30)" required class="w-24" />
                            <button class="bg-yellow-500 text-black font-bold px-4 rounded flex-grow">Generate</button>
                        </form>
                    </div>

                    <div class="bg-zinc-900 rounded-xl overflow-hidden">
                        <table class="w-full text-left text-sm">
                            <thead class="bg-zinc-800 text-gray-400"><tr><th class="p-3">Key</th><th class="p-3">Days</th><th class="p-3">Action</th></tr></thead>
                            <tbody>
                                {keys.map(k => (
                                    <tr class="border-b border-white/5">
                                        <td class="p-3 font-mono text-yellow-400 select-all">{k.code}</td>
                                        <td class="p-3">{k.days} Days</td>
                                        <td class="p-3 text-red-500">
                                            <form action={`/admin/key/delete/${k.code}`} method="post"><button>Del</button></form>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            {/* Movie List */}
            <div class="mt-8">
                <h3 class="font-bold mb-4">Movie List</h3>
                <div class="space-y-2">
                    {movies.map(m => (
                        <div class="flex justify-between items-center bg-zinc-900 p-3 rounded">
                            <div class="flex gap-3">
                                <img src={m.posterUrl} class="w-10 h-14 object-cover rounded" />
                                <div><div class="font-bold">{m.title}</div><div class="text-xs text-gray-500">{m.category}</div></div>
                            </div>
                            <form action={`/admin/movie/delete/${m.id}`} method="post"><button class="text-red-500 text-sm">Delete</button></form>
                        </div>
                    ))}
                </div>
            </div>
        </Layout>
    );
});

// Admin Actions
app.post("/admin/movie/save", adminAuth, async (c) => {
    const body = await c.req.parseBody();
    const movie = { ...body, id: body["id"] || crypto.randomUUID() };
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
