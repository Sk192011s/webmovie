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
  tags: string; // Comma separated string for easier editing
  year: string;
  streamUrl: string;
  downloadUrl?: string;
}

interface VipKey {
  code: string;
  note: string; // User Name or Note
  createdAt: string;
}

// --- Database Helpers ---
async function getMovies() {
  const iter = kv.list<Movie>({ prefix: ["movies"] });
  const movies = [];
  for await (const res of iter) movies.push(res.value);
  return movies.sort((a, b) => b.year.localeCompare(a.year)); // Newest first
}

async function getMovie(id: string) {
  const res = await kv.get<Movie>(["movies", id]);
  return res.value;
}

async function getVipKeys() {
  const iter = kv.list<VipKey>({ prefix: ["keys"] });
  const keys = [];
  for await (const res of iter) keys.push(res.value);
  return keys;
}

// --- UI Components ---
const Layout = (props: { children: any; title?: string; isAdmin?: boolean }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{props.title || "Gold Flix Premium"}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>{`
        body { background-color: #09090b; color: #fff; font-family: sans-serif; }
        .gold { color: #EAB308; }
        .bg-glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.05); }
        input, select, textarea { background: #18181b; border: 1px solid #3f3f46; color: white; padding: 0.5rem; border-radius: 0.375rem; width: 100%; }
        input:focus, select:focus, textarea:focus { outline: none; border-color: #EAB308; }
      `}</style>
    </head>
    <body class="min-h-screen flex flex-col">
      <nav class="sticky top-0 z-50 border-b border-white/10 bg-black/80 backdrop-blur-md">
        <div class="max-w-7xl mx-auto p-4 flex justify-between items-center">
          <a href="/" class="text-2xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-yellow-700">
            GOLD FLIX
          </a>
          <div class="flex gap-4 text-sm font-semibold">
             {props.isAdmin ? (
               <>
                 <a href="/admin/dashboard" class="text-yellow-500">Dashboard</a>
                 <a href="/admin/keys" class="text-yellow-500">Manage Keys</a>
                 <a href="/logout" class="text-red-500">Logout</a>
               </>
             ) : (
               <>
                 <a href="/?cat=Movies" class="hover:text-yellow-400">Movies</a>
                 <a href="/?cat=Series" class="hover:text-yellow-400">Series</a>
                 <a href="/?cat=Adult" class="text-red-500 hover:text-red-400">18+</a>
               </>
             )}
          </div>
        </div>
      </nav>
      <main class="flex-grow p-4 md:p-8 max-w-7xl mx-auto w-full">
        {props.children}
      </main>
    </body>
  </html>
);

// --- Public Routes ---

// Home Page
app.get("/", async (c) => {
  const cat = c.req.query("cat") || "Movies";
  const allMovies = await getMovies();
  const movies = allMovies.filter((m) => m.category === cat);

  return c.html(
    <Layout>
      {/* Category Filter */}
      <div class="flex justify-center gap-4 mb-8">
        {["Movies", "Series", "Adult"].map((c) => (
          <a href={`/?cat=${c}`} class={`px-6 py-2 rounded-full font-bold transition-all ${cat === c ? "bg-yellow-500 text-black shadow-lg shadow-yellow-500/20" : "bg-zinc-900 text-gray-400 hover:text-white"}`}>
            {c}
          </a>
        ))}
      </div>

      {/* Movie Grid */}
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
        {movies.map((movie) => (
          <a href={`/movie/${movie.id}`} class="group relative bg-glass rounded-xl overflow-hidden hover:border-yellow-500/50 transition-all duration-300">
            <div class="aspect-[2/3] overflow-hidden">
                <img src={movie.posterUrl} class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
            </div>
            <div class="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-90"></div>
            <div class="absolute bottom-0 p-4 w-full">
              <h3 class="font-bold text-white truncate">{movie.title}</h3>
              <div class="flex justify-between items-center mt-1 text-xs text-gray-400">
                 <span>{movie.year}</span>
                 <span class="text-yellow-500 border border-yellow-500/30 px-1 rounded">{movie.tags.split(',')[0]}</span>
              </div>
            </div>
          </a>
        ))}
      </div>
      {movies.length === 0 && <div class="text-center py-20 text-gray-500">No content available.</div>}
    </Layout>
  );
});

// Movie Detail & Premium Check
app.get("/movie/:id", async (c) => {
  const id = c.req.param("id");
  const movie = await getMovie(id);
  if (!movie) return c.text("Not Found", 404);

  // Check VIP Key
  const userKey = getCookie(c, "vip_key");
  let isVip = false;
  if (userKey) {
    const keyData = await kv.get(["keys", userKey]);
    if (keyData.value) isVip = true;
  }

  return c.html(
    <Layout title={movie.title}>
      <div class="grid md:grid-cols-[3fr_1fr] gap-8">
        <div>
           {/* Player */}
           <div class="aspect-video bg-black rounded-xl overflow-hidden border border-white/10 relative shadow-2xl mb-6">
            {isVip ? (
              <video controls class="w-full h-full" poster={movie.posterUrl}>
                <source src={movie.streamUrl} type="video/mp4" />
              </video>
            ) : (
              <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/95 backdrop-blur z-10 p-6 text-center">
                <div class="text-5xl mb-4">👑</div>
                <h2 class="text-2xl font-bold text-yellow-500 mb-2">Premium Content</h2>
                <p class="text-gray-400 mb-6">This movie is reserved for VIP members.</p>
                
                <form action="/login" method="post" class="flex flex-col gap-3 w-full max-w-xs">
                  <input type="text" name="key" placeholder="Enter VIP Key here..." required class="text-center font-mono text-lg" />
                  <button class="bg-gradient-to-r from-yellow-500 to-yellow-600 text-black font-bold py-3 rounded hover:scale-105 transition-transform">
                    Unlock Now
                  </button>
                </form>
              </div>
            )}
          </div>

          <h1 class="text-4xl font-bold text-white mb-2">{movie.title}</h1>
          <p class="text-gray-400 leading-relaxed mb-6">{movie.description}</p>
          
          {isVip && movie.downloadUrl && (
             <a href={movie.downloadUrl} class="inline-block bg-green-600 hover:bg-green-500 text-white font-bold px-6 py-2 rounded-full">
               Download Movie
             </a>
          )}
        </div>

        {/* Sidebar Info */}
        <div class="bg-glass p-6 rounded-xl h-fit">
           <img src={movie.posterUrl} class="w-full rounded mb-4" />
           <div class="space-y-2 text-sm">
             <div class="flex justify-between border-b border-white/10 pb-2">
               <span class="text-gray-400">Category</span>
               <span>{movie.category}</span>
             </div>
             <div class="flex justify-between border-b border-white/10 pb-2">
               <span class="text-gray-400">Year</span>
               <span>{movie.year}</span>
             </div>
             <div>
                <span class="text-gray-400 block mb-1">Tags</span>
                <div class="flex flex-wrap gap-2">
                    {movie.tags.split(',').map(t => <span class="bg-zinc-800 px-2 py-1 rounded text-xs">{t.trim()}</span>)}
                </div>
             </div>
           </div>
        </div>
      </div>
    </Layout>
  );
});

// User Login (VIP Key)
app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const key = body["key"] as string;
  
  const keyCheck = await kv.get(["keys", key]);
  if (keyCheck.value) {
    setCookie(c, "vip_key", key, { path: "/", maxAge: 86400 * 30 }); // 30 Days
    return c.redirect(c.req.header("Referer") || "/");
  }
  return c.text("Invalid VIP Key", 401);
});

// --- ADMIN ROUTES ---

// Admin Middleware
const adminAuth = async (c: any, next: any) => {
  const session = getCookie(c, "admin_session");
  const envPass = Deno.env.get("ADMIN_PASSWORD");
  if (!envPass) return c.text("Please set ADMIN_PASSWORD env variable in Deno Deploy.", 500);
  
  if (session === envPass) {
    await next();
  } else {
    return c.redirect("/admin");
  }
};

// Admin Login Page
app.get("/admin", (c) => c.html(
  <Layout title="Admin Login">
    <div class="flex justify-center items-center h-[60vh]">
      <form action="/admin/login" method="post" class="bg-glass p-8 rounded-xl w-full max-w-md border border-white/10">
        <h2 class="text-2xl font-bold text-center mb-6 text-yellow-500">Admin Login</h2>
        <input type="password" name="password" placeholder="Admin Password" class="mb-4" />
        <button class="w-full bg-yellow-500 text-black font-bold py-2 rounded">Login</button>
      </form>
    </div>
  </Layout>
));

app.post("/admin/login", async (c) => {
  const body = await c.req.parseBody();
  const pass = body["password"];
  const envPass = Deno.env.get("ADMIN_PASSWORD");
  
  if (pass === envPass) {
    setCookie(c, "admin_session", String(pass), { path: "/", httpOnly: true });
    return c.redirect("/admin/dashboard");
  }
  return c.redirect("/admin");
});

app.get("/logout", (c) => {
  deleteCookie(c, "admin_session");
  deleteCookie(c, "vip_key");
  return c.redirect("/");
});

// Admin Dashboard (Movie List & Add Form)
app.get("/admin/dashboard", adminAuth, async (c) => {
  const movies = await getMovies();
  return c.html(
    <Layout title="Dashboard" isAdmin={true}>
      <div class="grid lg:grid-cols-[1fr_2fr] gap-8">
        
        {/* Add / Edit Form */}
        <div class="bg-glass p-6 rounded-xl h-fit sticky top-24">
          <h2 class="text-xl font-bold mb-4 text-yellow-500">Add / Edit Movie</h2>
          <form action="/admin/movie/save" method="post" class="space-y-4">
            <input type="hidden" name="id" value={crypto.randomUUID()} /> 
            <div>
                <label class="text-xs text-gray-400">Title</label>
                <input name="title" required placeholder="Movie Name" />
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="text-xs text-gray-400">Category</label>
                    <select name="category">
                        <option value="Movies">Movies</option>
                        <option value="Series">Series</option>
                        <option value="Adult">Adult</option>
                    </select>
                </div>
                <div>
                    <label class="text-xs text-gray-400">Year</label>
                    <input name="year" value="2025" />
                </div>
            </div>
            <div>
                <label class="text-xs text-gray-400">Poster URL (Image Link)</label>
                <input name="posterUrl" required placeholder="https://..." />
            </div>
            <div>
                <label class="text-xs text-gray-400">Stream URL (.mp4/.m3u8)</label>
                <input name="streamUrl" required placeholder="https://..." />
            </div>
            <div>
                <label class="text-xs text-gray-400">Download URL (Optional)</label>
                <input name="downloadUrl" placeholder="https://..." />
            </div>
            <div>
                <label class="text-xs text-gray-400">Tags (comma separated)</label>
                <input name="tags" placeholder="Horror, Action, 2025" />
            </div>
            <div>
                <label class="text-xs text-gray-400">Description</label>
                <textarea name="description" rows={3}></textarea>
            </div>
            <button class="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-2 rounded">Save Movie</button>
          </form>
        </div>

        {/* Movie List */}
        <div>
           <h2 class="text-xl font-bold mb-4 text-yellow-500">All Movies ({movies.length})</h2>
           <div class="space-y-4">
             {movies.map(m => (
               <div class="bg-glass p-4 rounded-lg flex gap-4 items-start border border-white/5">
                 <img src={m.posterUrl} class="w-16 h-24 object-cover rounded" />
                 <div class="flex-grow">
                    <h3 class="font-bold text-lg">{m.title}</h3>
                    <div class="text-sm text-gray-400">{m.category} • {m.year}</div>
                    <div class="text-xs text-gray-500 mt-1">{m.tags}</div>
                 </div>
                 <div class="flex flex-col gap-2">
                    {/* Delete Button */}
                    <form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Delete this movie?');">
                        <button class="bg-red-600/20 text-red-500 hover:bg-red-600 hover:text-white px-3 py-1 rounded text-sm w-full">Delete</button>
                    </form>
                    {/* Simplified Edit: For now, we instruct to delete and re-add or we can implement complex edit logic. 
                        To keep this single file simple, Admin can just copy data, delete and re-add, OR I can add a simple fill script? 
                        Let's stick to basic functionality for MVP. 
                    */}
                 </div>
               </div>
             ))}
           </div>
        </div>
      </div>
    </Layout>
  );
});

// Admin: Save Movie
app.post("/admin/movie/save", adminAuth, async (c) => {
  const body = await c.req.parseBody();
  const movie: Movie = {
    id: body["id"] as string, // If editing, keep ID. If new, randomUUID from form
    title: body["title"] as string,
    category: body["category"] as any,
    posterUrl: body["posterUrl"] as string,
    streamUrl: body["streamUrl"] as string,
    downloadUrl: body["downloadUrl"] as string,
    tags: body["tags"] as string,
    year: body["year"] as string,
    description: body["description"] as string,
  };

  // If ID already exists (editing), this overwrites. If new, it creates.
  // Note: The simple form above generates a NEW ID every load. 
  // For proper editing, we would need a separate route. 
  // For this simple version, "Save" always creates new unless we manually hack the ID.
  // But let's allow overwriting if someone sends an existing ID.
  
  await kv.set(["movies", movie.id], movie);
  return c.redirect("/admin/dashboard");
});

// Admin: Delete Movie
app.post("/admin/movie/delete/:id", adminAuth, async (c) => {
  const id = c.req.param("id");
  await kv.delete(["movies", id]);
  return c.redirect("/admin/dashboard");
});

// Admin: Manage Keys Page
app.get("/admin/keys", adminAuth, async (c) => {
  const keys = await getVipKeys();
  return c.html(
    <Layout title="Manage VIP Keys" isAdmin={true}>
      <div class="max-w-4xl mx-auto">
        <h1 class="text-2xl font-bold text-yellow-500 mb-6">VIP Access Keys Management</h1>
        
        {/* Generator */}
        <div class="bg-glass p-6 rounded-xl mb-8 border border-white/10">
          <h3 class="font-bold mb-4">Generate New Key</h3>
          <form action="/admin/keys/create" method="post" class="flex gap-4">
             <input name="note" placeholder="Note (e.g. User Name or '1 Month Plan')" required />
             <button class="bg-yellow-500 text-black font-bold px-6 rounded whitespace-nowrap">Generate Key</button>
          </form>
        </div>

        {/* Key List */}
        <div class="bg-zinc-900 rounded-xl overflow-hidden">
           <table class="w-full text-left">
             <thead class="bg-zinc-800 text-gray-400">
               <tr>
                 <th class="p-4">Key Code</th>
                 <th class="p-4">Note</th>
                 <th class="p-4">Action</th>
               </tr>
             </thead>
             <tbody class="divide-y divide-white/10">
               {keys.map(k => (
                 <tr>
                   <td class="p-4 font-mono text-yellow-400 select-all">{k.code}</td>
                   <td class="p-4 text-gray-300">{k.note}</td>
                   <td class="p-4">
                     <form action={`/admin/keys/delete/${k.code}`} method="post">
                        <button class="text-red-500 hover:underline">Revoke</button>
                     </form>
                   </td>
                 </tr>
               ))}
               {keys.length === 0 && <tr><td colspan={3} class="p-4 text-center text-gray-500">No active keys.</td></tr>}
             </tbody>
           </table>
        </div>
      </div>
    </Layout>
  );
});

// Create Key
app.post("/admin/keys/create", adminAuth, async (c) => {
  const body = await c.req.parseBody();
  const code = "VIP-" + Math.random().toString(36).substring(2, 8).toUpperCase(); // Random 6 char code
  const keyData: VipKey = {
    code,
    note: body["note"] as string,
    createdAt: new Date().toISOString()
  };
  await kv.set(["keys", code], keyData);
  return c.redirect("/admin/keys");
});

// Delete Key
app.post("/admin/keys/delete/:code", adminAuth, async (c) => {
  const code = c.req.param("code");
  await kv.delete(["keys", code]);
  return c.redirect("/admin/keys");
});

Deno.serve(app.fetch);
