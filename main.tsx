/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Layout } from "./ui.tsx";
import { getUser, getMovies, getMovie, hashPassword, verifyPassword, kv, getConfig, getRequests } from "./db.ts";
import { admin } from "./admin.tsx";
import { User, UserRequest } from "./types.ts";

const app = new Hono();

// Auth Middleware Helper
async function getAuthUser(c: any): Promise<User | null> {
  const session = getCookie(c, "auth_session");
  if (!session) return null;
  const [username, token] = session.split(":");
  const user = await getUser(username);
  if (user && user.sessionId === token) return user;
  return null;
}

function isPremium(user: User | null) {
  if (!user || !user.expiryDate) return false;
  return new Date(user.expiryDate) > new Date();
}

// ========================
// 1. HOME PAGE
// ========================
app.get("/", async (c) => {
  const user = await getAuthUser(c);
  const movies = await getMovies(); 
  const config = await getConfig();
  const cats = ["Movies", "Series", "Adult", "All Uncensored"];

  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}>
      {/* Search Bar */}
      <div class="p-4">
        <form action="/search" method="get" class="relative">
          <input name="q" placeholder="Search movies..." class="input-box pl-10 text-sm" />
          <i class="fa-solid fa-search absolute left-3 top-3.5 text-gray-500"></i>
        </form>
      </div>

      {/* Hero Slider (Latest 1) */}
      {movies.length > 0 && (
        <div class="relative h-64 bg-zinc-900 overflow-hidden mx-4 rounded-2xl">
          <img src={movies[0].coverUrl || movies[0].posterUrl} class="w-full h-full object-cover opacity-60" />
          <div class="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent"></div>
          <div class="absolute bottom-4 left-4">
            <h1 class="text-2xl font-bold">{movies[0].title}</h1>
            <a href={`/movie/${movies[0].id}`} class="mt-2 inline-block bg-white text-black px-6 py-2 rounded-full font-bold text-sm">Play Now</a>
          </div>
        </div>
      )}

      {/* Movie Sections */}
      <div class="p-4 space-y-8">
        {cats.map(cat => {
            const catMovies = movies.filter(m => m.category === cat).slice(0, 10);
            if (catMovies.length === 0) return null;
            return (
              <section>
                <div class="flex justify-between items-center mb-4">
                  <h2 class="text-lg font-bold border-l-4 border-red-600 pl-2">{cat}</h2>
                  <a href={`/category/${cat}`} class="text-xs text-gray-500">See All</a>
                </div>
                <div class="h-scroll-section">
                  {catMovies.map(m => (
                    <a href={`/movie/${m.id}`} class={`movie-card ${cat === "All Uncensored" ? 'wide' : ''}`}>
                      <img src={(cat === "All Uncensored" && m.coverUrl) ? m.coverUrl : m.posterUrl} class="rounded-lg aspect-[2/3] object-cover bg-zinc-800" loading="lazy" />
                      <p class="text-[10px] mt-1 truncate text-gray-300">{m.title}</p>
                    </a>
                  ))}
                </div>
              </section>
            );
        })}
      </div>
    </Layout>
  );
});

// ========================
// 2. MOVIE DETAIL & PLAYER
// ========================
app.get("/movie/:id", async (c) => {
  const user = await getAuthUser(c);
  const movie = await getMovie(c.req.param("id"));
  if (!movie) return c.text("Movie Not Found", 404);
  
  const isVip = isPremium(user);
  const config = await getConfig();

  return c.html(
    <Layout user={user} title={movie.title} announcement={config.showAnnouncement ? config.announcement : undefined}>
      <div id="video-container" class="aspect-video bg-black w-full border-b border-zinc-800">
        {!isVip ? (
          <div class="flex flex-col items-center justify-center h-full space-y-4 bg-zinc-900">
            <i class="fa-solid fa-crown text-5xl text-yellow-500"></i>
            <p class="text-sm font-bold text-white">VIP Only Content</p>
            <a href="/profile" class="bg-red-600 px-8 py-2 rounded-full font-bold shadow-lg">Upgrade to VIP</a>
          </div>
        ) : (
          <video src={movie.streamUrl} controls controlsList="nodownload" class="w-full h-full"></video>
        )}
      </div>

      <div class="p-4">
        <div class="flex justify-between items-start">
          <div>
            <h1 class="text-xl font-bold">{movie.title}</h1>
            <p class="text-xs text-gray-500 mt-1">{movie.year} • {movie.category}</p>
          </div>
          <form action="/api/fav" method="post">
            <input type="hidden" name="movieId" value={movie.id} />
            <button class="text-xl"><i class={`fa-solid fa-heart ${user?.favorites?.includes(movie.id) ? 'text-red-600' : 'text-gray-600'}`}></i></button>
          </form>
        </div>

        {isVip && (
          <div class="mt-6 space-y-4">
             {/* Download Buttons */}
             <div class="flex gap-2">
                {movie.downloadUrl && <a href={movie.downloadUrl} target="_blank" class="flex-1 bg-zinc-800 py-3 rounded-lg text-xs text-center font-bold border border-zinc-700"><i class="fa-solid fa-download mr-1"></i> Download 1</a>}
                {movie.downloadUrl2 && <a href={movie.downloadUrl2} target="_blank" class="flex-1 bg-zinc-800 py-3 rounded-lg text-xs text-center font-bold border border-zinc-700"><i class="fa-solid fa-download mr-1"></i> Download 2</a>}
             </div>

             {/* Episodes (For Series) */}
             {movie.category === "Series" && movie.episodes && movie.episodes.length > 0 && (
               <div>
                  <h3 class="text-sm font-bold mb-3 text-gray-400">Episodes</h3>
                  <div class="grid grid-cols-3 gap-2">
                    {movie.episodes.map(ep => (
                      <button onclick={`loadPlayer('${ep.url}', 'direct')`} class="bg-zinc-900 border border-zinc-800 p-3 rounded text-[10px] truncate hover:border-red-600">
                        {ep.name}
                      </button>
                    ))}
                  </div>
               </div>
             )}
          </div>
        )}
        
        <p class="text-gray-400 text-sm mt-6 leading-relaxed">{movie.description}</p>
      </div>
    </Layout>
  );
});

// ========================
// 3. PROFILE & VIP REDEEM
// ========================
app.get("/profile", async (c) => {
  const user = await getAuthUser(c);
  if (!user) return c.redirect("/login");
  
  const isVip = isPremium(user);
  const daysLeft = user.expiryDate ? Math.ceil((new Date(user.expiryDate).getTime() - Date.now()) / 86400000) : 0;

  return c.html(
    <Layout user={user} title="My Profile">
      <div class="p-6">
        <div class="bg-zinc-900 p-8 rounded-3xl border border-zinc-800 text-center">
          <div class="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center text-3xl font-bold mx-auto mb-4">
            {user.username[0].toUpperCase()}
          </div>
          <h2 class="text-xl font-bold">{user.username}</h2>
          <p class={`text-sm mt-1 ${isVip ? 'text-green-500' : 'text-gray-500'}`}>
            {isVip ? `VIP Member (${daysLeft} Days Left)` : 'Free Account'}
          </p>
        </div>

        <div class="mt-8 bg-zinc-900 p-6 rounded-3xl border border-zinc-800">
          <h3 class="font-bold mb-4">Redeem VIP Code</h3>
          <form action="/profile/redeem" method="post" class="space-y-4">
            <input name="key" placeholder="Enter VIP Key" required class="input-box" />
            <button class="btn-primary w-full">Activate VIP</button>
          </form>
        </div>

        <a href="/logout" class="block text-center mt-10 text-red-500 font-bold">Logout</a>
      </div>
    </Layout>
  );
});

app.post("/profile/redeem", async (c) => {
    const user = await getAuthUser(c);
    if (!user) return c.redirect("/login");
    const { key } = await c.req.parseBody();
    const keyData = (await kv.get(["keys", key as string])).value as any;
    
    if (keyData) {
        const currentExpiry = user.expiryDate && new Date(user.expiryDate) > new Date() ? new Date(user.expiryDate) : new Date();
        currentExpiry.setDate(currentExpiry.getDate() + keyData.days);
        user.expiryDate = currentExpiry.toISOString();
        await kv.set(["users", user.username], user);
        await kv.delete(["keys", key as string]);
        return c.redirect("/profile?success=VIP Activated");
    }
    return c.redirect("/profile?error=Invalid Key");
});

// ========================
// 4. OTHER FEATURES (Search, Favorites, Request)
// ========================

app.get("/search", async (c) => {
    const query = c.req.query("q")?.toLowerCase() || "";
    const user = await getAuthUser(c);
    const movies = await getMovies();
    const results = movies.filter(m => m.title.toLowerCase().includes(query));
    return c.html(<Layout user={user}><div class="p-4"><h2 class="mb-4 text-gray-400">Results for "{query}"</h2><div class="grid grid-cols-3 gap-2">{results.map(m => (<a href={`/movie/${m.id}`} class="block"><img src={m.posterUrl} class="rounded aspect-[2/3] object-cover" /><p class="text-[10px] truncate mt-1">{m.title}</p></a>))}</div></div></Layout>);
});

app.get("/favorites", async (c) => {
    const user = await getAuthUser(c);
    if (!user) return c.redirect("/login");
    const movies = await getMovies();
    const favs = movies.filter(m => user.favorites?.includes(m.id));
    return c.html(<Layout user={user} title="Saved"><div class="p-4"><h2 class="font-bold mb-4">My Favorites</h2><div class="grid grid-cols-3 gap-2">{favs.map(m => (<a href={`/movie/${m.id}`} class="block"><img src={m.posterUrl} class="rounded aspect-[2/3] object-cover" /><p class="text-[10px] truncate mt-1">{m.title}</p></a>))}</div></div></Layout>);
});

app.post("/api/fav", async (c) => {
    const user = await getAuthUser(c);
    if (!user) return c.redirect("/login");
    const { movieId } = await c.req.parseBody();
    const id = movieId as string;
    if (!user.favorites) user.favorites = [];
    user.favorites = user.favorites.includes(id) ? user.favorites.filter(f => f !== id) : [...user.favorites, id];
    await kv.set(["users", user.username], user);
    return c.redirect(c.req.header("Referer") || "/");
});

app.get("/request", async (c) => {
    const user = await getAuthUser(c);
    if (!user) return c.redirect("/login");
    return c.html(<Layout user={user} title="Request Movie"><div class="p-6"><h1 class="text-xl font-bold mb-4">Request Movie</h1><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name..." required class="input-box" /><button class="btn-primary w-full">Send Request</button></form></div></Layout>);
});

app.post("/request", async (c) => {
    const user = await getAuthUser(c);
    if (!user) return c.redirect("/login");
    const { movieName } = await c.req.parseBody();
    const id = crypto.randomUUID();
    const req: UserRequest = { id, username: user.username, movieName: movieName as string, timestamp: Date.now() };
    await kv.set(["requests", id], req);
    return c.redirect("/request?success=Submitted");
});

app.get("/category/:cat", async (c) => {
    const cat = c.req.param("cat");
    const user = await getAuthUser(c);
    const allMovies = await getMovies();
    const filtered = allMovies.filter(m => m.category === cat);
    return c.html(<Layout user={user} title={cat}><div class="p-4"><h2 class="font-bold mb-4">{cat}</h2><div class="grid grid-cols-3 gap-2">{filtered.map(m => (<a href={`/movie/${m.id}`} class="block"><img src={m.posterUrl} class="rounded aspect-[2/3] object-cover" /><p class="text-[10px] truncate mt-1">{m.title}</p></a>))}</div></div></Layout>);
});

// ========================
// 5. AUTH ROUTES
// ========================
app.get("/login", (c) => c.html(<Layout hideNav={true}><div class="p-6 max-w-sm mx-auto mt-20 bg-zinc-900 rounded-2xl border border-zinc-800"><h1 class="text-2xl font-bold mb-6">Login</h1><form action="/login" method="post" class="space-y-4"><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full">Sign In</button></form><p class="text-xs text-center mt-4 text-gray-500">Don't have an account? <a href="/signup" class="text-red-500">Sign Up</a></p></div></Layout>));

app.post("/login", async (c) => {
  const { username, password } = await c.req.parseBody();
  const user = await getUser(username as string);
  if (user && await verifyPassword(password as string, user.passwordHash)) {
    const sessionId = crypto.randomUUID();
    user.sessionId = sessionId;
    await kv.set(["users", user.username], user);
    setCookie(c, "auth_session", `${user.username}:${sessionId}`, { httpOnly: true, secure: true, maxAge: 60 * 60 * 24 * 7, path: "/" });
    return c.redirect("/");
  }
  return c.redirect("/login?error=Invalid Credentials");
});

app.get("/signup", (c) => c.html(<Layout hideNav={true}><div class="p-6 max-w-sm mx-auto mt-20 bg-zinc-900 rounded-2xl border border-zinc-800"><h1 class="text-2xl font-bold mb-6">Create Account</h1><form action="/signup" method="post" class="space-y-4"><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full">Register</button></form></div></Layout>));

app.post("/signup", async (c) => {
  const { username, password } = await c.req.parseBody();
  if (await getUser(username as string)) return c.redirect("/signup?error=Exists");
  const passwordHash = await hashPassword(password as string);
  await kv.set(["users", username as string], { username, passwordHash, expiryDate: null, favorites: [] });
  return c.redirect("/login");
});

app.get("/logout", (c) => {
    deleteCookie(c, "auth_session");
    return c.redirect("/");
});

app.route("/admin", admin);

Deno.serve(app.fetch);
