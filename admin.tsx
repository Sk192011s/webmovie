/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { Layout } from "./ui.tsx";
import { getMovies, getKeys, getRequests, getConfig, kv } from "./db.ts";
import { Movie, Episode } from "./types.ts";

const admin = new Hono();

admin.get("/dashboard", async (c) => {
  const movies = await getMovies();
  const keys = await getKeys();
  const reqs = await getRequests();
  const config = await getConfig();
  
  return c.html(
    <Layout title="Admin Panel">
      <div class="p-4 space-y-6">
        <h1 class="text-2xl font-bold text-red-600">Admin Dashboard</h1>
        
        {/* Add Movie Form */}
        <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800">
          <h2 class="font-bold mb-4">Add/Edit Movie</h2>
          <form action="/admin/movie/save" method="post" class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input name="title" placeholder="Title" required class="input-box" />
            <select name="category" class="input-box">
              <option>Movies</option><option>Series</option><option>Adult</option><option>All Uncensored</option>
            </select>
            <input name="posterUrl" placeholder="Poster URL" required class="input-box" />
            <input name="coverUrl" placeholder="Cover URL (Wide)" class="input-box" />
            <input name="streamUrl" placeholder="Main Stream URL" required class="input-box" />
            <input name="year" placeholder="Year" defaultValue="2025" class="input-box" />
            <textarea name="description" placeholder="Description" class="input-box md:col-span-2"></textarea>
            <textarea name="episodeList" placeholder="Series ဖြစ်လျှင်: Season 1 | Episode 1 | URL" class="input-box md:col-span-2"></textarea>
            <button class="btn-primary md:col-span-2">Save Movie</button>
          </form>
        </div>

        {/* VIP Keys Section */}
        <div class="grid md:grid-cols-2 gap-6">
          <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800">
            <h2 class="font-bold mb-4">Generate VIP Key</h2>
            <form action="/admin/key/create" method="post" class="flex gap-2">
              <input type="number" name="days" placeholder="Days" required class="input-box" />
              <button class="btn-primary">Generate</button>
            </form>
            <div class="mt-4 space-y-2 max-h-40 overflow-y-auto">
              {keys.map(k => (
                <div class="flex justify-between bg-black p-2 rounded text-xs">
                  <span class="text-yellow-500 font-mono">{k.code}</span>
                  <span>{k.days} Days</span>
                </div>
              ))}
            </div>
          </div>
          
          <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800">
            <h2 class="font-bold mb-4">Recent Requests</h2>
            <div class="space-y-2">
              {reqs.map(r => (
                <div class="bg-black p-2 rounded text-xs flex justify-between">
                  <span>{r.movieName} <span class="text-gray-500">({r.username})</span></span>
                  <form action={`/admin/request/delete/${r.id}`} method="post"><button class="text-red-500">Delete</button></form>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
});

// Admin Actions
admin.post("/movie/save", async (c) => {
  const body = await c.req.parseBody();
  const id = crypto.randomUUID();
  const episodes: Episode[] = [];
  const epText = body.episodeList as string;
  if (epText) {
    epText.split('\n').forEach(line => {
      const parts = line.split('|');
      if (parts.length === 3) episodes.push({ season: parts[0].trim(), name: parts[1].trim(), url: parts[2].trim() });
    });
  }
  const movie: Movie = {
    id, title: body.title as string, posterUrl: body.posterUrl as string, coverUrl: body.coverUrl as string,
    category: body.category as any, description: body.description as string, tags: "", year: body.year as string,
    streamUrl: body.streamUrl as string, linkType: "direct", episodes, createdAt: Date.now()
  };
  await kv.set(["movies", id], movie);
  return c.redirect("/admin/dashboard");
});

export { admin };
