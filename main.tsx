/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Layout } from "./ui.tsx";
import { getUser, getMovies, getMovie, hashPassword, verifyPassword, kv, getConfig } from "./db.ts";
import { admin } from "./admin.tsx";
import { User, UserRequest } from "./types.ts";

const app = new Hono();

async function getAuthUser(c: any): Promise<User | null> {
  const session = getCookie(c, "auth_session");
  if (!session) return null;
  const [username, token] = session.split(":");
  const user = await getUser(username);
  if (user && user.sessionId === token) return user;
  return null;
}

// 1. HOME & SLIDER
app.get("/", async (c) => {
  const user = await getAuthUser(c);
  const movies = await getMovies();
  const config = await getConfig();
  const sliderMovies = movies.slice(0, 5);

  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}>
      <div class="slider-container">
        {sliderMovies.map((m, idx) => (
          <div class={`slide ${idx === 0 ? 'active' : ''}`}>
            <img src={m.coverUrl || m.posterUrl} class="w-full h-full object-cover opacity-40" />
            <div class="absolute bottom-10 left-6">
                <h1 class="text-3xl font-black italic tracking-tighter">{m.title}</h1>
                <a href={`/movie/${m.id}`} class="mt-4 inline-block bg-white text-black px-6 py-2 rounded-full font-bold text-sm">Watch Now</a>
            </div>
          </div>
        ))}
      </div>

      <div class="p-6">
        <form action="/search" method="get" class="relative mb-10">
          <input name="q" placeholder="Search movies..." class="input-box pl-12" />
          <i class="fa-solid fa-search absolute left-5 top-4 text-gray-500"></i>
        </form>

        <div class="space-y-12">
          {["Movies", "Series", "Adult", "All Uncensored"].map(cat => {
            const filtered = movies.filter(m => m.category === cat).slice(0, 8);
            if(filtered.length === 0) return null;
            return (
              <section>
                <div class="flex justify-between items-end mb-4">
                  <h2 class="text-xl font-black border-l-4 border-red-600 pl-3">{cat.toUpperCase()}</h2>
                  <a href={`/category/${cat}`} class="text-xs font-bold text-gray-500">SEE ALL</a>
                </div>
                <div class="h-scroll-section">
                  {filtered.map(m => (
                    <a href={`/movie/${m.id}`} class={`movie-card ${cat === "All Uncensored" ? 'wide' : ''}`}>
                      <img src={(cat === "All Uncensored" && m.coverUrl) ? m.coverUrl : m.posterUrl} class="rounded-2xl aspect-[2/3] object-cover bg-zinc-800" />
                      <p class="text-[10px] font-bold mt-2 truncate text-gray-400">{m.title}</p>
                    </a>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </Layout>
  );
});

// 2. SEARCH, CATEGORY, FAVORITES, REQUEST
app.get("/search", async (c) => {
    const q = c.req.query("q")?.toLowerCase() || "";
    const user = await getAuthUser(c);
    const results = (await getMovies()).filter(m => m.title.toLowerCase().includes(q));
    return c.html(<Layout user={user}><div class="p-6"><h2 class="mb-4 font-bold text-gray-500 italic">Results for "{q}"</h2><div class="grid grid-cols-3 gap-3">{results.map(m => (<a href={`/movie/${m.id}`} class="block"><img src={m.posterUrl} class="rounded-xl aspect-[2/3] object-cover"/><p class="text-[10px] mt-1 truncate">{m.title}</p></a>))}</div></div></Layout>);
});

app.get("/category/:cat", async (c) => {
    const cat = c.req.param("cat");
    const user = await getAuthUser(c);
    const filtered = (await getMovies()).filter(m => m.category === cat);
    return c.html(<Layout user={user} title={cat}><div class="p-6"><h2 class="text-2xl font-black mb-6 italic">{cat.toUpperCase()}</h2><div class="grid grid-cols-3 gap-4">{filtered.map(m => (<a href={`/movie/${m.id}`} class="block"><img src={m.posterUrl} class="rounded-2xl aspect-[2/3] object-cover bg-zinc-800"/><p class="text-[10px] font-bold mt-2 truncate">{m.title}</p></a>))}</div></div></Layout>);
});

app.get("/favorites", async (c) => {
    const user = await getAuthUser(c);
    if(!user) return c.redirect("/login");
    const favs = (await getMovies()).filter(m => user.favorites?.includes(m.id));
    return c.html(<Layout user={user} title="Saved"><div class="p-6"><h2 class="text-2xl font-black mb-6 italic">SAVED MOVIES</h2><div class="grid grid-cols-3 gap-4">{favs.map(m => (<a href={`/movie/${m.id}`} class="block"><img src={m.posterUrl} class="rounded-2xl aspect-[2/3] object-cover"/><p class="text-[10px] font-bold mt-2 truncate">{m.title}</p></a>))}</div>{favs.length===0 && <p class="text-center text-gray-600 mt-20">No saved movies.</p>}</div></Layout>);
});

app.get("/request", async (c) => {
    const user = await getAuthUser(c);
    if(!user) return c.redirect("/login");
    return c.html(<Layout user={user} title="Request"><div class="p-8 max-w-sm mx-auto mt-10"><h2 class="text-2xl font-black mb-4">REQUEST MOVIE</h2><p class="text-xs text-gray-500 mb-6">ရှာမတွေ့တဲ့ကားရှိရင် နာမည်အပြည့်အစုံရေးခဲ့ပေးပါ။</p><form action="/request" method="post" class="space-y-4"><input name="movieName" placeholder="Movie Name..." required class="input-box"/><button class="btn-primary w-full">Submit Request</button></form></div></Layout>);
});

app.post("/request", async (c) => {
    const user = await getAuthUser(c);
    if(!user) return c.redirect("/login");
    const { movieName } = await c.req.parseBody();
    const id = crypto.randomUUID();
    const req: UserRequest = { id, username: user.username, movieName: movieName as string, timestamp: Date.now() };
    await kv.set(["requests", id], req);
    return c.redirect("/request?success=Submitted");
});

// 3. MOVIE DETAIL (Include episodes/player logic)
app.get("/movie/:id", async (c) => {
    const user = await getAuthUser(c);
    const movie = await getMovie(c.req.param("id"));
    if(!movie) return c.text("404");
    const premium = user && user.expiryDate && new Date(user.expiryDate) > new Date();
    return c.html(
        <Layout user={user} title={movie.title}>
            <div class="aspect-video bg-black relative" id="video-box">
                {premium ? (
                    <div id="video-cover" class="absolute inset-0 flex items-center justify-center">
                        <img src={movie.coverUrl || movie.posterUrl} class="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm" />
                        <button onclick={`loadPlayer('${movie.streamUrl}')`} class="relative z-10 w-20 h-20 bg-red-600 rounded-full flex items-center justify-center text-3xl"><i class="fa-solid fa-play ml-1"></i></button>
                    </div>
                ) : (
                    <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 text-center p-10">
                        <i class="fa-solid fa-lock text-4xl text-red-600 mb-4"></i>
                        <h2 class="font-bold">VIP ONLY</h2>
                        <a href="/profile" class="mt-4 bg-white text-black px-6 py-2 rounded-full font-bold text-sm">Upgrade</a>
                    </div>
                )}
            </div>
            <div class="p-6">
                <h1 class="text-2xl font-black">{movie.title}</h1>
                <div class="flex gap-2 text-xs mt-2 mb-6">
                    <span class="bg-zinc-800 px-3 py-1 rounded-full text-gray-400">{movie.year}</span>
                    <span class="bg-red-600/10 text-red-500 border border-red-500/20 px-3 py-1 rounded-full">{movie.category}</span>
                </div>
                {premium && (
                    <div class="space-y-4">
                        <div class="flex gap-2">
                            {movie.downloadUrl && <a href={movie.downloadUrl} target="_blank" class="flex-1 bg-zinc-900 py-4 rounded-xl text-xs font-bold text-center border border-zinc-800">Server 1</a>}
                            {movie.downloadUrl2 && <a href={movie.downloadUrl2} target="_blank" class="flex-1 bg-zinc-900 py-4 rounded-xl text-xs font-bold text-center border border-zinc-800">Server 2</a>}
                        </div>
                        {movie.category === "Series" && movie.episodes && (
                            <div class="grid grid-cols-3 gap-2 mt-6">
                                {movie.episodes.map(ep => (
                                    <button onclick={`loadPlayer('${ep.url}')`} class="bg-zinc-800 py-3 rounded-lg text-[10px] truncate px-1 border border-zinc-700">{ep.name}</button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <p class="text-gray-400 text-sm mt-8 leading-relaxed">{movie.description}</p>
            </div>
        </Layout>
    );
});

// 4. AUTH & PROFILE (Important: Path must be "/")
app.get("/login", (c) => c.html(<Layout hideNav={true}><div class="p-8 max-w-sm mx-auto mt-20 bg-zinc-900 rounded-3xl border border-zinc-800"><h1 class="text-3xl font-black mb-8 italic text-red-600">LOGIN</h1><form action="/login" method="post" class="space-y-4"><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-4">SIGN IN</button></form><p class="text-xs text-center mt-6 text-gray-500 font-bold">New account? <a href="/signup" class="text-red-500">Sign Up</a></p></div></Layout>));

app.post("/login", async (c) => {
    const { username, password } = await c.req.parseBody();
    const user = await getUser(username as string);
    if (user && await verifyPassword(password as string, user.passwordHash)) {
        const sessionId = crypto.randomUUID();
        user.sessionId = sessionId;
        await kv.set(["users", user.username], user);
        setCookie(c, "auth_session", `${user.username}:${sessionId}`, { path: "/", httpOnly: true, secure: true, maxAge: 60 * 60 * 24 * 7 });
        return c.redirect("/");
    }
    return c.redirect("/login?error=Invalid");
});

app.get("/signup", (c) => c.html(<Layout hideNav={true}><div class="p-8 max-w-sm mx-auto mt-20 bg-zinc-900 rounded-3xl border border-zinc-800"><h1 class="text-3xl font-black mb-8 italic text-red-600">SIGN UP</h1><form action="/signup" method="post" class="space-y-4"><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-4">REGISTER</button></form></div></Layout>));

app.post("/signup", async (c) => {
    const { username, password } = await c.req.parseBody();
    if (await getUser(username as string)) return c.redirect("/signup?error=Exists");
    const passwordHash = await hashPassword(password as string);
    await kv.set(["users", username as string], { username, passwordHash, expiryDate: null, favorites: [] });
    return c.redirect("/login");
});

app.get("/profile", async (c) => {
    const user = await getAuthUser(c);
    if(!user) return c.redirect("/login");
    const premium = user.expiryDate && new Date(user.expiryDate) > new Date();
    return c.html(<Layout user={user} title="Profile"><div class="p-6 max-w-sm mx-auto space-y-8"><div class="bg-zinc-900 p-8 rounded-3xl border border-zinc-800 text-center"><div class="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center text-2xl font-black mx-auto mb-4">{user.username[0].toUpperCase()}</div><h2 class="font-black text-xl">{user.username}</h2><p class="text-xs text-gray-500 mt-1">{premium ? "VIP Member" : "Free Member"}</p></div><div class="bg-zinc-900 p-8 rounded-3xl border border-zinc-800"><h3 class="font-black text-sm mb-6 uppercase">Redeem Key</h3><form action="/profile/redeem" method="post" class="flex gap-2"><input name="key" placeholder="VIP-XXXX" class="input-box" required/><button class="btn-primary">Redeem</button></form></div><a href="/logout" class="block text-center text-red-500 font-bold py-4">LOGOUT</a></div></Layout>);
});

app.post("/profile/redeem", async (c) => {
    const user = await getAuthUser(c);
    const { key } = await c.req.parseBody();
    const keyData = (await kv.get(["keys", key as string])).value as any;
    if(keyData) {
        const exp = user!.expiryDate && new Date(user!.expiryDate) > new Date() ? new Date(user!.expiryDate) : new Date();
        exp.setDate(exp.getDate() + keyData.days);
        user!.expiryDate = exp.toISOString();
        await kv.set(["users", user!.username], user!);
        await kv.delete(["keys", key as string]);
        return c.redirect("/profile?success=Redeemed");
    }
    return c.redirect("/profile?error=Invalid");
});

app.get("/logout", (c) => { deleteCookie(c, "auth_session", { path: "/" }); return c.redirect("/"); });

app.route("/admin", admin);
Deno.serve(app.fetch);
