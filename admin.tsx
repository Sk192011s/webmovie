/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { Layout } from "./ui.tsx";
import { getMovies, getKeys, getConfig, kv, getRequests } from "./db.ts";
import { Movie, Episode, VipKey } from "./types.ts";

const admin = new Hono();

admin.get("/dashboard", async (c) => {
  const movies = await getMovies();
  const keys = await getKeys();
  const config = await getConfig();
  const reqs = await getRequests();
  
  const editId = c.req.query("edit");
  const editMovie = editId ? movies.find(m => m.id === editId) : null;
  const epString = editMovie?.episodes?.map(e => `${e.season || "S1"} | ${e.name} | ${e.url}`).join('\n') || "";

  return c.html(
    <Layout title="Admin Panel">
      <div class="p-6 space-y-8 max-w-7xl mx-auto">
        <div class="flex justify-between items-center">
            <h1 class="text-3xl font-bold text-red-600">Admin Panel</h1>
            <div class="flex gap-3">
                <a href="/admin/backup" class="bg-blue-600 px-4 py-2 rounded-lg text-xs font-bold">Download Backup</a>
                <form action="/admin/restore" method="post" enctype="multipart/form-data">
                    <label class="bg-green-600 px-4 py-2 rounded-lg text-xs font-bold cursor-pointer">Restore Data <input type="file" name="file" class="hidden" onchange="this.form.submit()"/></label>
                </form>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* 1. MOVIE FORM */}
            <div class="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-xl">
                <h2 class="text-lg font-bold mb-6 text-yellow-500">{editMovie ? "Edit Movie" : "Add New Movie"}</h2>
                <form action="/admin/movie/save" method="post" class="space-y-4">
                    <input type="hidden" name="id" value={editMovie?.id || ""} />
                    <input name="title" placeholder="Title" defaultValue={editMovie?.title} required class="input-box" />
                    <div class="flex gap-4">
                        <select name="category" class="input-box">
                            {["Movies","Series","Adult","All Uncensored"].map(cat => <option selected={editMovie?.category===cat}>{cat}</option>)}
                        </select>
                        <input name="year" placeholder="Year" defaultValue={editMovie?.year || "2025"} class="input-box" />
                    </div>
                    <input name="posterUrl" placeholder="Poster URL" defaultValue={editMovie?.posterUrl} class="input-box" />
                    <input name="coverUrl" placeholder="Cover URL (Wide)" defaultValue={editMovie?.coverUrl} class="input-box" />
                    <input name="streamUrl" placeholder="Stream URL" defaultValue={editMovie?.streamUrl} class="input-box" />
                    <textarea name="episodeList" placeholder="S1 | Ep 1 | URL" class="input-box h-32 font-mono text-xs">{epString}</textarea>
                    <textarea name="description" placeholder="Description" class="input-box h-24">{editMovie?.description}</textarea>
                    <button class="btn-primary w-full">{editMovie ? "Update Movie" : "Save Movie"}</button>
                    {editMovie && <a href="/admin/dashboard" class="block text-center text-xs text-gray-500 mt-2">Cancel Edit</a>}
                </form>
            </div>

            {/* 2. KEYS & CONFIG */}
            <div class="space-y-8">
                <div class="bg-zinc-900 p-6 rounded-2xl border border-zinc-800">
                    <h2 class="text-sm font-bold text-gray-400 uppercase mb-4">Generate VIP Keys</h2>
                    <form action="/admin/key/create" method="post" class="flex gap-3">
                        <input type="number" name="days" placeholder="Days (e.g. 30)" required class="input-box" />
                        <button class="btn-primary">Generate</button>
                    </form>
                    <div class="mt-4 grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                        {keys.map(k => (
                            <div class="bg-black p-2 rounded border border-zinc-800 flex justify-between items-center text-xs">
                                <span class="text-yellow-500 font-mono">{k.code}</span>
                                <span>{k.days}D</span>
                                <form action={`/admin/key/delete/${k.code}`} method="post"><button class="text-red-500 ml-2">×</button></form>
                            </div>
                        ))}
                    </div>
                </div>

                <div class="bg-zinc-900 p-6 rounded-2xl border border-zinc-800">
                    <h2 class="text-sm font-bold text-gray-400 uppercase mb-4">Announcement</h2>
                    <form action="/admin/config" method="post" class="space-y-4">
                        <input name="text" defaultValue={config.announcement} class="input-box" />
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="show" checked={config.showAnnouncement} /> Show Announcement</label>
                        <button class="bg-zinc-800 w-full py-3 rounded-xl font-bold border border-zinc-700">Save Config</button>
                    </form>
                </div>
            </div>
        </div>

        {/* 3. LIBRARY LIST */}
        <div class="bg-zinc-900 p-6 rounded-2xl border border-zinc-800">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-xl font-bold">Library ({movies.length})</h2>
                <input oninput="filterLibrary(this.value)" placeholder="Search movies..." class="input-box w-64 text-sm" />
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {movies.map(m => (
                    <div class="lib-item flex gap-4 bg-black p-3 rounded-xl border border-zinc-800" data-title={m.title}>
                        <img src={m.posterUrl} class="w-16 h-24 object-cover rounded-lg" />
                        <div class="flex-grow min-w-0">
                            <h3 class="font-bold text-sm truncate">{m.title}</h3>
                            <p class="text-xs text-gray-500">{m.category} • {m.year}</p>
                            <div class="flex gap-2 mt-3">
                                <a href={`/admin/dashboard?edit=${m.id}`} class="text-[10px] bg-blue-900/30 text-blue-400 px-3 py-1.5 rounded-lg border border-blue-500/20">Edit</a>
                                <form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Delete?')">
                                    <button class="text-[10px] bg-red-900/30 text-red-400 px-3 py-1.5 rounded-lg border border-red-500/20">Delete</button>
                                </form>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
      </div>
    </Layout>
  );
});

// Admin API Actions
admin.post("/config", async (c) => {
    const body = await c.req.parseBody();
    await kv.set(["config"], { announcement: String(body.text), showAnnouncement: body.show === 'on' });
    return c.redirect("/admin/dashboard");
});

admin.post("/movie/save", async (c) => {
  const body = await c.req.parseBody();
  const id = (body.id as string) || crypto.randomUUID();
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

admin.post("/movie/delete/:id", async (c) => {
    await kv.delete(["movies", c.req.param("id")]);
    return c.redirect("/admin/dashboard");
});

admin.post("/key/create", async (c) => {
    const { days } = await c.req.parseBody();
    const code = "VIP-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    await kv.set(["keys", code], { code, days: parseInt(String(days)) });
    return c.redirect("/admin/dashboard");
});

admin.post("/key/delete/:code", async (c) => {
    await kv.delete(["keys", c.req.param("code")]);
    return c.redirect("/admin/dashboard");
});

admin.get("/backup", async (c) => {
    const data = [];
    for await (const entry of kv.list({ prefix: [] })) data.push(entry);
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="backup_${Date.now()}.json"` } });
});

admin.post("/restore", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file as File;
    if (file) {
        const text = await file.text();
        const data = JSON.parse(text);
        for (const entry of data) await kv.set(entry.key, entry.value);
    }
    return c.redirect("/admin/dashboard");
});

export { admin };
