/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { getCookie, setCookie } from "hono/cookie";
import { kv, getMovies, getMovie, seedData } from "./db.ts";

const app = new Hono();

// Layout Component (ခေါင်းစဉ် နဲ့ ဒီဇိုင်းပုံစံခွက်)
const Layout = (props: { children: any; title?: string }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{props.title || "Premium Movie Club"}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>{`
        body { background-color: #09090b; color: #fff; font-family: sans-serif; }
        .gold-text { color: #EAB308; }
        .glass { background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
      `}</style>
    </head>
    <body class="min-h-screen flex flex-col">
      <nav class="p-4 border-b border-white/10 glass sticky top-0 z-50">
        <div class="max-w-6xl mx-auto flex justify-between items-center">
          <a href="/" class="text-2xl font-bold gold-text tracking-widest">GOLD FLIX</a>
          <div class="flex gap-4">
             <a href="/?cat=Movies" class="hover:text-yellow-400">Movies</a>
             <a href="/?cat=Series" class="hover:text-yellow-400">Series</a>
             <a href="/?cat=Adult" class="text-red-500 font-bold hover:text-red-400">18+</a>
          </div>
        </div>
      </nav>
      <main class="flex-grow max-w-6xl mx-auto w-full p-4">
        {props.children}
      </main>
      <footer class="p-6 text-center text-gray-500 text-sm border-t border-white/10">
        &copy; 2025 Gold Flix. Premium Members Only.
      </footer>
    </body>
  </html>
);

// Home Page
app.get("/", async (c) => {
  const cat = c.req.query("cat") || "Movies";
  const allMovies = await getMovies();
  const movies = allMovies.filter((m) => m.category === cat);

  return c.html(
    <Layout>
      <div class="flex gap-2 mb-6 overflow-x-auto pb-2">
        {["Movies", "Series", "Adult"].map((c) => (
          <a href={`/?cat=${c}`} class={`px-6 py-2 rounded-full font-bold ${cat === c ? "bg-yellow-500 text-black" : "glass text-white"}`}>
            {c}
          </a>
        ))}
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        {movies.map((movie) => (
          <a href={`/movie/${movie.id}`} class="group relative block rounded-xl overflow-hidden glass hover:border-yellow-500 transition-all">
            <img src={movie.posterUrl} class="w-full aspect-[2/3] object-cover group-hover:scale-105 transition-transform duration-500" />
            <div class="absolute bottom-0 w-full bg-gradient-to-t from-black to-transparent p-4 pt-10">
              <h3 class="font-bold text-lg truncate">{movie.title}</h3>
              <div class="flex gap-2 mt-1">
                {movie.tags.map(tag => <span class="text-xs bg-yellow-500/20 text-yellow-500 px-2 py-0.5 rounded">{tag}</span>)}
              </div>
            </div>
          </a>
        ))}
      </div>
      {movies.length === 0 && <div class="text-center py-20 text-gray-500">No movies found. <a href="/setup-data" class="underline">Click here to add sample data</a></div>}
    </Layout>
  );
});

// Movie Detail Page
app.get("/movie/:id", async (c) => {
  const id = c.req.param("id");
  const movie = await getMovie(id);
  
  if (!movie) return c.text("Movie not found", 404);

  // Check Premium via Env Variable
  // User က 'PREMIUM_CODE' ဆိုတဲ့ Cookie ရှိမှ ကြည့်လို့ရမယ်
  const userCode = getCookie(c, "access_code");
  const validCode = Deno.env.get("PREMIUM_CODE"); 
  const isPremium = userCode === validCode;

  return c.html(
    <Layout title={movie.title}>
      <div class="grid md:grid-cols-[2fr_1fr] gap-8 mt-4">
        <div>
          {/* Video Player / Premium Lock */}
          <div class="aspect-video bg-black rounded-xl overflow-hidden border border-white/10 relative shadow-2xl">
            {isPremium ? (
              <video controls class="w-full h-full" poster={movie.posterUrl}>
                <source src={movie.streamUrl} type="video/mp4" />
              </video>
            ) : (
              <div class="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/90 backdrop-blur">
                <span class="text-4xl mb-2">🔒</span>
                <h2 class="text-xl font-bold text-yellow-500">Premium Only</h2>
                <form action="/login" method="post" class="mt-4 flex gap-2">
                  <input type="text" name="code" placeholder="Enter Access Code" class="bg-black border border-gray-600 px-3 py-2 rounded text-white" />
                  <button class="bg-yellow-500 text-black font-bold px-4 py-2 rounded">Unlock</button>
                </form>
              </div>
            )}
          </div>

          <h1 class="text-4xl font-bold mt-6 text-white">{movie.title}</h1>
          <div class="flex gap-3 mt-4 mb-6">
            <span class="px-3 py-1 glass rounded text-yellow-400 font-bold">{movie.year}</span>
            <span class="px-3 py-1 glass rounded text-gray-300">{movie.category}</span>
          </div>
          <p class="text-gray-300 leading-relaxed text-lg">{movie.description}</p>

          {/* Actions */}
          <div class="flex gap-4 mt-8 border-t border-white/10 pt-6">
            <button class="px-6 py-2 rounded-full glass hover:bg-white/10 border-yellow-500/50 text-yellow-400">
               ♥ Add to Favorites
            </button>
            {/* Admin Download - Only Show if isPremium AND downloadUrl exists */}
            {isPremium && movie.downloadUrl && (
              <a href={movie.downloadUrl} class="px-6 py-2 rounded-full bg-green-600 hover:bg-green-500 text-white font-bold">
                Download
              </a>
            )}
          </div>
        </div>

        {/* Sidebar Info */}
        <div class="glass p-6 rounded-xl h-fit">
           <img src={movie.posterUrl} class="w-full rounded-lg mb-4 shadow-lg" />
           <div class="space-y-4 text-sm text-gray-400">
             <p>Tags:</p>
             <div class="flex flex-wrap gap-2">
               {movie.tags.map(tag => <span class="bg-white/5 px-2 py-1 rounded">#{tag}</span>)}
             </div>
           </div>
        </div>
      </div>
    </Layout>
  );
});

// Login Logic (Premium Code ထည့်ဖို့)
app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const code = body["code"];
  const validCode = Deno.env.get("PREMIUM_CODE");

  if (code === validCode) {
    setCookie(c, "access_code", String(code), { path: "/", maxAge: 86400 * 30 }); // 30 days
    return c.redirect(c.req.header("Referer") || "/");
  } else {
    return c.text("Incorrect Code!", 403);
  }
});

// Setup Data (ပထမဆုံးအကြိမ် Data ထည့်ဖို့)
app.get("/setup-data", async (c) => {
  await seedData();
  return c.redirect("/");
});

Deno.serve(app.fetch);
