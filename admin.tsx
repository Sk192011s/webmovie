/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { Layout } from "./ui.tsx";
import { getMovies, getKeys, getRequests, getConfig, kv } from "./db.ts";
import { Movie, Episode } from "./types.ts";

const admin = new Hono();

admin.get("/dashboard", async (c) => {
  const movies = await getMovies();
  const keys = await getKeys();
  const config = await getConfig();
  
  const editId = c.req.query("edit");
  const editMovie = editId ? movies.find(m => m.id === editId) : null;
  const epString = editMovie?.episodes?.map(e => `${e.season || "S1"} | ${e.name} | ${e.url}`).join('\n') || "";

  return (
    c.html(
      <Layout title="Admin Panel">
        <div class="p-4 space-y-6 bg-black min-h-screen">
            <div class="flex justify-between items-center">
                <h1 class="text-xl font-bold text-red-600">Admin Panel</h1>
                <div class="flex gap-2">
                    <a href="/admin/backup" class="text-[10px] bg-blue-600 px-3 py-1 rounded font-bold">Backup</a>
                    <a href="/" class="text-[10px] bg-zinc-800 px-3 py-1 rounded font-bold">Site</a>
                </div>
            </div>

            {/* Announcement Config */}
            <div class="bg-zinc-900 p-4 rounded-xl border border-yellow-600/30">
                <h2 class="text-xs font-bold text-yellow-500 mb-3 uppercase">Announcement Bar</h2>
                <form action="/admin/config" method="post" class="flex gap-2">
                    <input name="text" defaultValue={config.announcement} class="input-box text-xs" />
                    <label class="flex items-center text-[10px] gap-1"><input type="checkbox" name="show" checked={config.showAnnouncement} /> Show</label>
                    <button class="bg-yellow-600 text-black font-bold px-4 py-2 rounded text-xs">Update</button>
                </form>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Form Section */}
                <div class="bg-zinc-900 p-5 rounded-2xl border border-zinc-800">
                    <h2 class="font-bold mb-4 text-sm">{editMovie ? "Edit Movie" : "Add New Movie"}</h2>
                    <form action="/admin/movie/save" method="post" class="space-y-3">
                        <input type="hidden" name="id" value={editMovie?.id || ""} />
                        <input name="title" placeholder="Title" defaultValue={editMovie?.title} required class="input-box text-xs" />
                        <div class="flex gap-2">
                            <select name="category" class="input-box text-xs">
                                {["Movies","Series","Adult","All Uncensored"].map(cat => <option selected={editMovie?.category===cat}>{cat}</option>)}
                            </select>
                            <input name="year" placeholder="Year" defaultValue={editMovie?.year || "2025"} class="input-box text-xs w-24" />
                        </div>
                        <input name="posterUrl" placeholder="Poster URL" defaultValue={editMovie?.posterUrl} class="input-box text-xs" />
                        <input name="coverUrl" placeholder="Cover URL (Wide)" defaultValue={editMovie?.coverUrl} class="input-box text-xs" />
                        <input name="streamUrl" placeholder="Stream URL" defaultValue={editMovie?.streamUrl} class="input-box text-xs" />
                        <textarea name="episodeList" placeholder="Series: Season | Name | URL" class="input-box text-xs h-32 font-mono">{epString}</textarea>
                        <textarea name="description" placeholder="Description" class="input-box text-xs h-20">{editMovie?.description}</textarea>
                        <button class="btn-primary w-full text-xs">{editMovie ? "Update Movie" : "Save Movie"}</button>
                        {editMovie && <a href="/admin/dashboard" class="block text-center text-[10px] text-gray-500">Cancel Edit</a>}
                    </form>
                </div>

                {/* Library List with Search */}
                <div class="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 flex flex-col h-[600px]">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="font-bold text-sm">Library ({movies.length})</h2>
                        <input oninput="filterLibrary(this.value)" placeholder="Search..." class="bg-black border border-zinc-700 rounded-lg px-3 py-1 text-xs w-40" />
                    </div>
                    <div class="overflow-y-auto space-y-2 pr-2 custom-scroll">
                        {movies.map(m => (
                            <div class="library-item flex items-center gap-3 bg-black p-2 rounded-lg border border-zinc-800" data-title={m.title}>
                                <img src={m.posterUrl} class="w-10 h-14 object-cover rounded" />
                                <div class="flex-grow">
                                    <p class="text-[11px] font-bold truncate w-40">{m.title}</p>
                                    <p class="text-[9px] text-gray-500">{m.category}</p>
                                </div>
                                <div class="flex gap-1">
                                    <a href={`/admin/dashboard?edit=${m.id}`} class="text-[10px] bg-blue-900/30 text-blue-500 px-2 py-1 rounded">Edit</a>
                                    <form action={`/admin/movie/delete/${m.id}`} method="post" onsubmit="return confirm('Delete?')"><button class="text-[10px] bg-red-900/30 text-red-500 px-2 py-1 rounded">Del</button></form>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
      </Layout>
    )
  );
});

// Admin API Actions
admin.post("/config", async (c) => {
    const body = await c.req.parseBody();
    await kv.set(["config"], { announcement: body.text, showAnnouncement: body.show === 'on' });
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

admin.get("/backup", async (c) => {
    const data = [];
    for await (const entry of kv.list({ prefix: [] })) data.push(entry);
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="backup_${Date.now()}.json"` } });
});

export { admin };
