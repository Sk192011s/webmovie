/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Layout } from "./ui.tsx";
import { getUser, getMovies, getMovie, hashPassword, verifyPassword, kv, getConfig } from "./db.ts";
import { admin } from "./admin.tsx";
import { User, Episode } from "./types.ts";

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

// 1. HOME PAGE
app.get("/", async (c) => {
  const user = await getAuthUser(c);
  const movies = await getMovies();
  const config = await getConfig();
  const cats = ["Movies", "Series", "Adult", "All Uncensored"];

  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}>
      <div class="p-6"><form action="/search" method="get" class="relative"><input name="q" placeholder="Search movies..." class="input-box pl-12 shadow-2xl"/><i class="fa-solid fa-search absolute left-5 top-4 text-gray-500"></i></form></div>
      
      <div class="px-6 space-y-12">
        {cats.map(cat => {
          const filtered = movies.filter(m => m.category === cat).slice(0, 10);
          if(filtered.length === 0) return null;
          return (
            <section>
              <div class="flex justify-between items-end mb-5 px-1">
                <h2 class="text-2xl font-black italic tracking-tighter border-l-4 border-red-600 pl-3">{cat.toUpperCase()}</h2>
                <a href={`/category/${cat}`} class="text-xs font-bold text-gray-500 hover:text-red-500 transition">SEE ALL</a>
              </div>
              <div class="h-scroll-section">
                {filtered.map(m => (
                  <a href={`/movie/${m.id}`} class={`movie-card ${cat === "All Uncensored" ? 'wide' : ''}`}>
                    <div class="relative group overflow-hidden rounded-2xl">
                        <img src={(cat === "All Uncensored" && m.coverUrl) ? m.coverUrl : m.posterUrl} class="w-full aspect-[2/3] object-cover bg-zinc-800 transition duration-500 group-hover:scale-110" loading="lazy" />
                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center"><i class="fa-solid fa-play text-2xl"></i></div>
                    </div>
                    <p class="text-xs font-bold mt-3 truncate text-gray-300">{m.title}</p>
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

// 2. MOVIE DETAIL
app.get("/movie/:id", async (c) => {
  const user = await getAuthUser(c);
  const movie = await getMovie(c.req.param("id"));
  if (!movie) return c.text("404 Not Found");
  const premium = user && user.expiryDate && new Date(user.expiryDate) > new Date();

  const seasons: Record<string, Episode[]> = {};
  movie.episodes?.forEach(ep => {
    const sName = ep.season || "Episodes";
    if (!seasons[sName]) seasons[sName] = [];
    seasons[sName].push(ep);
  });

  return c.html(
    <Layout user={user} title={movie.title}>
      <div class="max-w-5xl mx-auto">
          <div class="aspect-video bg-black relative shadow-2xl overflow-hidden md:rounded-b-3xl" id="video-box">
            {premium ? (
              <div id="video-cover" class="absolute inset-0 flex items-center justify-center">
                 <img src={movie.coverUrl || movie.posterUrl} class="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm" />
                 <button onclick={`loadPlayer('${movie.streamUrl}')`} class="relative z-10 w-20 h-20 bg-red-600 rounded-full flex items-center justify-center text-3xl shadow-2xl hover:scale-110 transition"><i class="fa-solid fa-play ml-1"></i></button>
              </div>
            ) : (
              <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 text-center p-10">
                <i class="fa-solid fa-crown text-6xl text-yellow-500 mb-4 animate-bounce"></i>
                <h2 class="text-xl font-black">VIP ONLY CONTENT</h2>
                <a href="/profile" class="mt-6 bg-red-600 px-10 py-3 rounded-full font-black shadow-lg">UPGRADE NOW</a>
              </div>
            )}
          </div>

          <div class="p-6">
            <h1 class="text-3xl font-black tracking-tighter">{movie.title}</h1>
            <div class="flex gap-3 text-xs font-bold mt-3 mb-8">
                <span class="bg-zinc-800 px-3 py-1.5 rounded-full">{movie.year}</span>
                <span class="bg-red-600/10 text-red-500 border border-red-500/20 px-3 py-1.5 rounded-full">{movie.category}</span>
            </div>

            {premium && (
                <div class="space-y-6">
                    <div class="flex gap-3">
                        {movie.downloadUrl && <a href={movie.downloadUrl} target="_blank" class="flex-1 bg-zinc-900 py-4 rounded-2xl text-sm font-bold text-center border border-zinc-800 shadow-xl hover:bg-zinc-800">Download Server 1</a>}
                        {movie.downloadUrl2 && <a href={movie.downloadUrl2} target="_blank" class="flex-1 bg-zinc-900 py-4 rounded-2xl text-sm font-bold text-center border border-zinc-800 shadow-xl hover:bg-zinc-800">Download Server 2</a>}
                    </div>
                    
                    <button onclick="toggleHelp()" class="text-xs text-yellow-500 font-bold flex items-center gap-2"><i class="fa-solid fa-circle-question"></i> ဒေါင်းလုဒ်လုပ်နည်း ကြည့်ရန်</button>
                    <div id="help-box" class="hidden bg-zinc-900/50 p-6 rounded-2xl text-xs text-gray-400 space-y-3 border border-zinc-800">
                        <p><span class="text-yellow-500 font-bold">နည်းလမ်း (၁):</span> အပေါ်က Download Button တွေကို နှိပ်ပါ။</p>
                        <p><span class="text-yellow-500 font-bold">နည်းလမ်း (၂):</span> Video Play ပြီးလျှင် Player ညာဘက်အောက်ရှိ အစက် ၃ စက် (⋮) ကိုနှိပ်၍ Download ကို ရွေးပါ။</p>
                    </div>

                    <div class="space-y-3 mt-10">
                        {Object.keys(seasons).map((sName, idx) => (
                            <div class="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden shadow-lg">
                                <button onclick={`toggleSeason('${idx}')`} class="w-full p-5 flex justify-between items-center font-black text-sm">
                                    <span>{sName.toUpperCase()}</span>
                                    <i id={`icon-${idx}`} class="fa-solid fa-chevron-down text-xs transition-transform"></i>
                                </button>
                                <div id={`season-${idx}`} class="hidden p-4 grid grid-cols-2 md:grid-cols-4 gap-3 bg-black/40 border-t border-zinc-800">
                                    {seasons[sName].map(ep => (
                                        <button onclick={`loadPlayer('${ep.url}')`} class="bg-zinc-800 py-3 px-2 rounded-xl text-[11px] font-bold truncate hover:bg-red-600 transition">
                                            {ep.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            <p class="text-gray-400 text-sm mt-8 leading-relaxed font-medium">{movie.description}</p>
          </div>
      </div>
    </Layout>
  );
});

// 3. PROFILE & PLANS
app.get("/profile", async (c) => {
  const user = await getAuthUser(c);
  if (!user) return c.redirect("/login");
  const premium = user.expiryDate && new Date(user.expiryDate) > new Date();
  const days = user.expiryDate ? Math.ceil((new Date(user.expiryDate).getTime() - Date.now()) / 86400000) : 0;
  
  const plans = [
      { name: "1 MONTH", price: "700 Ks", days: 30 },
      { name: "3 MONTHS", price: "1,500 Ks", days: 90, popular: true },
      { name: "1 YEAR", price: "5,000 Ks", days: 365 }
  ];

  return c.html(
    <Layout user={user} title="Profile">
      <div class="p-6 max-w-2xl mx-auto space-y-8">
        <div class="bg-gradient-to-br from-zinc-800 to-zinc-900 p-8 rounded-3xl border border-zinc-700 flex items-center gap-6 shadow-2xl">
            <div class="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center text-3xl font-black shadow-lg shadow-red-600/20">{user.username[0].toUpperCase()}</div>
            <div>
                <h2 class="font-black text-2xl tracking-tighter">{user.username.toUpperCase()}</h2>
                <div class="mt-2 inline-block px-3 py-1 rounded-full bg-black/30 border border-white/10 text-[10px] font-bold">
                    {premium ? <span class="text-green-500">VIP ACTIVE • {days} DAYS LEFT</span> : <span class="text-gray-500">FREE PLAN</span>}
                </div>
            </div>
        </div>

        <div class="space-y-4">
            <h3 class="font-black text-sm text-yellow-500 tracking-widest uppercase">Select VIP Plan</h3>
            <div class="grid grid-cols-1 gap-4">
                {plans.map(p => (
                    <div class={`p-6 rounded-3xl border ${p.popular ? 'border-yellow-500 bg-yellow-500/5 shadow-lg shadow-yellow-500/10' : 'border-zinc-800 bg-zinc-900'} flex justify-between items-center`}>
                        <div><p class="text-[10px] font-bold text-gray-500">{p.name}</p><p class="font-black text-2xl tracking-tighter">{p.price}</p></div>
                        {p.popular && <span class="bg-yellow-500 text-black text-[10px] font-black px-4 py-1.5 rounded-full">BEST VALUE</span>}
                    </div>
                ))}
            </div>
        </div>

        <div class="bg-zinc-900 p-8 rounded-3xl border border-zinc-800 shadow-xl">
            <h3 class="font-black text-sm mb-6">REDEEM VIP KEY</h3>
            <form action="/profile/redeem" method="post" class="flex gap-3">
                <input name="key" placeholder="Enter VIP-XXXXXX" class="input-box font-mono" required />
                <button class="btn-primary">REDEEM</button>
            </form>
        </div>
        
        <a href="/logout" class="block w-full text-center py-5 bg-zinc-900 rounded-3xl text-red-500 font-black border border-zinc-800 shadow-lg">LOGOUT</a>
      </div>
    </Layout>
  );
});

// 4. AUTH ROUTES (Login/Signup)
app.get("/login", (c) => c.html(<Layout hideNav={true}><div class="p-8 max-w-sm mx-auto mt-20 bg-zinc-900 rounded-3xl border border-zinc-800 shadow-2xl"><h1 class="text-3xl font-black mb-8 italic text-red-600">LOGIN</h1><form action="/login" method="post" class="space-y-4"><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-4">SIGN IN</button></form><p class="text-xs text-center mt-6 text-gray-500 font-bold">New to Gold Flix? <a href="/signup" class="text-red-500">Create Account</a></p></div></Layout>));

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
  return c.redirect("/login?error=Invalid Credentials");
});

app.get("/signup", (c) => c.html(<Layout hideNav={true}><div class="p-8 max-w-sm mx-auto mt-20 bg-zinc-900 rounded-3xl border border-zinc-800 shadow-2xl"><h1 class="text-3xl font-black mb-8 italic text-red-600">SIGN UP</h1><form action="/signup" method="post" class="space-y-4"><input name="username" placeholder="Username" required class="input-box" /><input type="password" name="password" placeholder="Password" required class="input-box" /><button class="btn-primary w-full mt-4">REGISTER</button></form><p class="text-xs text-center mt-6 text-gray-500 font-bold">Already have an account? <a href="/login" class="text-red-500">Login</a></p></div></Layout>));

app.post("/signup", async (c) => {
  const { username, password } = await c.req.parseBody();
  if (await getUser(username as string)) return c.redirect("/signup?error=Exists");
  const passwordHash = await hashPassword(password as string);
  await kv.set(["users", username as string], { username, passwordHash, expiryDate: null, favorites: [] });
  return c.redirect("/login");
});

app.get("/logout", (c) => { deleteCookie(c, "auth_session", { path: "/" }); return c.redirect("/"); });

// MOUNT ADMIN
app.route("/admin", admin);

Deno.serve(app.fetch);
