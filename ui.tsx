/** @jsxImportSource hono/jsx */
import { User } from "./types.ts";

export const Layout = (props: { children: any; title?: string; user?: User | null; hideNav?: boolean; announcement?: string }) => (
  <html lang="my">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>{props.title || "Gold Flix"}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
      <style>{`
        body { background-color: #000; color: #fff; font-family: sans-serif; -webkit-tap-highlight-color: transparent; }
        .glass { background: rgba(20, 20, 20, 0.8); backdrop-filter: blur(15px); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .input-box { background: #1a1a1a; border: 1px solid #333; color: white; padding: 12px; border-radius: 12px; width: 100%; outline: none; transition: 0.3s; }
        .input-box:focus { border-color: #E50914; box-shadow: 0 0 10px rgba(229, 9, 20, 0.2); }
        .btn-primary { background: #E50914; color: white; font-weight: bold; padding: 12px 24px; border-radius: 12px; transition: 0.3s; cursor: pointer; display: inline-block; text-align: center; }
        .btn-primary:active { transform: scale(0.95); }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 15px; padding-bottom: 10px; scroll-snap-type: x mandatory; }
        .h-scroll-section::-webkit-scrollbar { height: 4px; }
        .h-scroll-section::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }
        .movie-card { min-width: 120px; width: 120px; flex-shrink: 0; scroll-snap-align: start; }
        .movie-card.wide { min-width: 260px; width: 260px; }
        #page-loader { position: fixed; inset: 0; background: #000; z-index: 9999; display: flex; justify-content: center; align-items: center; opacity: 0; pointer-events: none; transition: 0.3s; }
        #page-loader.active { opacity: 1; pointer-events: all; }
        .spinner { width: 40px; height: 40px; border: 4px solid #333; border-top-color: #E50914; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        function toggleSeason(id) {
            const el = document.getElementById('season-' + id);
            const icon = document.getElementById('icon-' + id);
            el.classList.toggle('hidden');
            icon.classList.toggle('rotate-180');
        }
        function loadPlayer(url) {
            const box = document.getElementById('video-box');
            const cover = document.getElementById('video-cover');
            if(cover) cover.style.display = 'none';
            box.innerHTML = '<video id="main-player" controls class="w-full h-full" autoplay><source src="'+url+'" type="video/mp4"></video>';
            window.scrollTo({top: 0, behavior: 'smooth'});
        }
        function filterLibrary(val) {
            document.querySelectorAll('.lib-item').forEach(i => {
                i.style.display = i.getAttribute('data-title').toLowerCase().includes(val.toLowerCase()) ? 'flex' : 'none';
            });
        }
        function toggleHelp() { document.getElementById('help-box').classList.toggle('hidden'); }
      `}} />
    </head>
    <body>
      <div id="page-loader"><div class="spinner"></div></div>
      {!props.hideNav && (
        <nav class="sticky top-0 z-50 glass px-6 py-4 flex justify-between items-center">
            <a href="/" class="text-2xl font-black text-red-600 italic tracking-tighter">GOLD FLIX</a>
            <div class="flex gap-6 text-gray-400 items-center text-sm font-bold">
              <a href="/" class="hover:text-white transition">Home</a>
              <a href="/favorites" class="hover:text-white transition">Saved</a>
              <a href="/request" class="hover:text-white transition">Request</a>
              {props.user ? (
                <a href="/profile" class="bg-red-600 w-8 h-8 flex items-center justify-center rounded-full text-white">{props.user.username[0].toUpperCase()}</a>
              ) : (
                <a href="/login" class="text-white bg-zinc-800 px-4 py-1.5 rounded-full">Login</a>
              )}
            </div>
        </nav>
      )}
      {props.announcement && (
        <div class="bg-yellow-500 text-black text-[11px] font-bold py-2 px-6 sticky top-[65px] z-40 shadow-lg">
          <marquee scrollamount="6">{props.announcement}</marquee>
        </div>
      )}
      <main class="min-h-screen pb-20">{props.children}</main>
    </body>
  </html>
);
