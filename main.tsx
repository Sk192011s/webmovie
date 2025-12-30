/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Layout } from "./ui.tsx";
import { getUser, getMovies, getMovie, hashPassword, verifyPassword, kv, getConfig } from "./db.ts";
import { admin } from "./admin.tsx";
import { User, Episode } from "./types.ts";

const app = new Hono();

async function getAuthUser(c: any): Promise<User | null> {
  const session = getCookie(c, "auth_session");
  if (!session) return null;
  const [username, token] = session.split(":");
  const user = await getUser(username);
  if (user && user.sessionId === token) return user;
  return null;
}

// --- HOME PAGE ---
app.get("/", async (c) => {
  const user = await getAuthUser(c);
  const movies = await getMovies();
  const config = await getConfig();
  const cats = ["Movies", "Series", "Adult", "All Uncensored"];

  return c.html(
    <Layout user={user} announcement={config.showAnnouncement ? config.announcement : undefined}>
      <div class="p-4"><form action="/search" method="get" class="relative"><input name="q" placeholder="Search..." class="input-box pl-10 text-sm"/><i class="fa-solid fa-search absolute left-4 top-4 text-gray-500"></i></form></div>
      <div class="p-4 space-y-8">
        {cats.map(cat => {
          const filtered = movies.filter(m => m.category === cat).slice(0, 10);
          if(filtered.length === 0) return null;
          return (
            <section>
              <div class="flex justify-between items-center mb-3 px-1"><h2 class="font-bold border-l-4 border-red-600 pl-2">{cat}</h2><a href={`/category/${cat}`} class="text-xs text-gray-500">See All</a></div>
              <div class="h-scroll-section px-1">
                {filtered.map(m => (
                  <a href={`/movie/${m.id}`} class={`movie-card ${cat === "All Uncensored" ? 'wide' : ''}`}>
                    <img src={(cat === "All Uncensored" && m.coverUrl) ? m.coverUrl : m.posterUrl} class="rounded-lg aspect-[2/3] object-cover bg-zinc-800" />
                    <p class="text-[10px] mt-1 truncate">{m.title}</p>
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

// --- MOVIE DETAIL (With Season Logic & Download Help) ---
app.get("/movie/:id", async (c) => {
  const user = await getAuthUser(c);
  const movie = await getMovie(c.req.param("id"));
  if (!movie) return c.text("404 Not Found");
  const premium = user && user.expiryDate && new Date(user.expiryDate) > new Date();

  // Group Episodes by Season
  const seasons: Record<string, Episode[]> = {};
  movie.episodes?.forEach(ep => {
    const sName = ep.season || "Episodes";
    if (!seasons[sName]) seasons[sName] = [];
    seasons[sName].push(ep);
  });

  return c.html(
    <Layout user={user} title={movie.title}>
      <div class="aspect-video bg-black relative" id="video-player-box">
        {premium ? (
          <div id="player-cover" class="absolute inset-0 flex items-center justify-center">
             <img src={movie.coverUrl || movie.posterUrl} class="absolute inset-0 w-full h-full object-cover opacity-50" />
             <button onclick={`loadPlayer('${movie.streamUrl}', '${movie.title}')`} class="relative z-10 w-16 h-16 bg-red-600 rounded-full flex items-center justify-center text-2xl shadow-2xl"><i class="fa-solid fa-play ml-1"></i></button>
          </div>
        ) : (
          <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900 text-center p-6">
            <i class="fa-solid fa-lock text-4xl text-red-600 mb-2"></i>
            <p class="font-bold">VIP Only Content</p>
            <a href="/profile" class="mt-4 bg-white text-black px-6 py-2 rounded-full font-bold text-sm">Upgrade VIP</a>
          </div>
        )}
      </div>

      <div class="p-5">
        <h1 class="text-xl font-bold">{movie.title}</h1>
        <div class="flex gap-2 text-[10px] mt-2 mb-6">
            <span class="bg-zinc-800 px-2 py-1 rounded">{movie.year}</span>
            <span class="border border-red-600 text-red-600 px-2 py-1 rounded">{movie.category}</span>
        </div>

        {premium && (
            <div class="space-y-4">
                {/* Download Buttons & Help */}
                <div class="flex gap-2">
                    {movie.downloadUrl && <a href={movie.downloadUrl} target="_blank" class="flex-1 bg-zinc-800 py-3 rounded-lg text-xs font-bold text-center border border-zinc-700">Download 1</a>}
                    {movie.downloadUrl2 && <a href={movie.downloadUrl2} target="_blank" class="flex-1 bg-zinc-800 py-3 rounded-lg text-xs font-bold text-center border border-zinc-700">Download 2</a>}
                </div>
                <button onclick="toggleHelp()" class="text-xs text-yellow-500 font-bold"><i class="fa-solid fa-circle-question mr-1"></i> ဒေါင်းလုဒ်လုပ်နည်းကြည့်ရန်</button>
                <div id="dl-help" class="hidden bg-zinc-900 p-4 rounded-lg text-[11px] text-gray-400 space-y-2 border border-zinc-800">
                    <p>၁။ Play Button ကိုနှိပ်ပြီး Video စဖွင့်ပါ။</p>
                    <p>၂။ Video Player ၏ ညာဘက်အောက်ထောင့်ရှိ အစက် ၃ စက်ကို နှိပ်ပါ။</p>
                    <p>၃။ Download ကိုနှိပ်ပါ။ (သို့မဟုတ်) အပေါ်ရှိ Download Button များကိုသုံးပါ။</p>
                </div>

                {/* Series Seasons */}
                <div class="mt-8 space-y-2">
                    {Object.keys(seasons).map((sName, idx) => (
                        <div class="border border-zinc-800 rounded-lg overflow-hidden">
                            <button onclick={`toggleSeason('${idx}')`} class="w-full p-4 bg-zinc-900 flex justify-between items-center font-bold text-sm">
                                <span>{sName}</span>
                                <i id={`icon-${idx}`} class="fa-solid fa-chevron-down text-xs transition-transform"></i>
                            </button>
                            <div id={`season-${idx}`} class="hidden p-2 grid grid-cols-3 gap-2 bg-black border-t border-zinc-800">
                                {seasons[sName].map(ep => (
                                    <button onclick={`loadPlayer('${ep.url}', '${ep.name}')`} class="bg-zinc-800 py-3 px-1 rounded text-[10px] truncate">{ep.name}</button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        )}
        <p class="text-gray-400 text-sm mt-6 leading-relaxed">{movie.description}</p>
      </div>
    </Layout>
  );
});

// --- PROFILE (With Price Plans) ---
app.get("/profile", async (c) => {
  const user = await getAuthUser(c);
  if (!user) return c.redirect("/login");
  const premium = user.expiryDate && new Date(user.expiryDate) > new Date();
  const plans = [
      { name: "1 Month", price: "700 Ks", days: 30 },
      { name: "3 Months", price: "1,500 Ks", days: 90, popular: true },
      { name: "1 Year", price: "5,000 Ks", days: 365 }
  ];

  return c.html(
    <Layout user={user} title="Profile">
      <div class="p-6 space-y-8">
        <div class="bg-zinc-900 p-6 rounded-3xl border border-zinc-800 flex items-center gap-4">
            <div class="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center text-2xl font-bold">{user.username[0].toUpperCase()}</div>
            <div>
                <h2 class="font-bold text-lg">{user.username}</h2>
                <p class="text-xs text-gray-500">{premium ? "VIP Active" : "Free Member"}</p>
            </div>
        </div>

        <div>
            <h3 class="font-bold mb-4 text-yellow-500">VIP Plans</h3>
            <div class="grid grid-cols-1 gap-3">
                {plans.map(p => (
                    <div class={`p-4 rounded-2xl border ${p.popular ? 'border-yellow-500 bg-yellow-500/5' : 'border-zinc-800 bg-zinc-900'} flex justify-between items-center`}>
                        <div><p class="text-xs text-gray-400">{p.name}</p><p class="font-black text-lg">{p.price}</p></div>
                        {p.popular && <span class="bg-yellow-500 text-black text-[9px] font-bold px-2 py-1 rounded-full">POPULAR</span>}
                    </div>
                ))}
            </div>
        </div>

        <div class="bg-zinc-900 p-6 rounded-3xl border border-zinc-800">
            <h3 class="font-bold mb-4">Activate VIP Key</h3>
            <form action="/profile/redeem" method="post" class="flex gap-2">
                <input name="key" placeholder="Enter Key..." class="input-box text-sm" required />
                <button class="btn-primary">Redeem</button>
            </form>
        </div>
        <a href="/logout" class="block w-full text-center py-4 bg-zinc-900 rounded-2xl text-red-500 font-bold border border-zinc-800">Logout</a>
      </div>
    </Layout>
  );
});

app.post("/login", async (c) => {
  const { username, password } = await c.req.parseBody();
  const user = await getUser(username as string);
  if (user && await verifyPassword(password as string, user.passwordHash)) {
    const sessionId = crypto.randomUUID();
    user.sessionId = sessionId;
    await kv.set(["users", user.username], user);
    setCookie(c, "auth_session", `${user.username}:${sessionId}`, { 
        path: "/", 
        httpOnly: true, 
        secure: true, 
        maxAge: 60 * 60 * 24 * 7 
    });
    return c.redirect("/");
  }
  return c.redirect("/login?error=Invalid");
});

app.get("/logout", (c) => { deleteCookie(c, "auth_session", { path: "/" }); return c.redirect("/"); });
app.route("/admin", admin);
Deno.serve(app.fetch);
