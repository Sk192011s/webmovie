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
        .glass { background: rgba(26, 26, 26, 0.95); backdrop-filter: blur(10px); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .input-box { background: #1f1f1f; border: 1px solid #333; color: white; padding: 12px; border-radius: 8px; width: 100%; outline: none; }
        .input-box:focus { border-color: #E50914; }
        .btn-primary { background: #E50914; color: white; font-weight: bold; padding: 10px 20px; border-radius: 8px; transition: 0.3s; cursor: pointer; display: inline-block; text-align: center; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 12px; padding-bottom: 10px; }
        .h-scroll-section::-webkit-scrollbar { height: 4px; }
        .h-scroll-section::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }
        .movie-card { min-width: 110px; width: 110px; flex-shrink: 0; }
        .movie-card.wide { min-width: 240px; width: 240px; }
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
        function loadPlayer(url, title) {
            const container = document.getElementById('video-player-box');
            const cover = document.getElementById('player-cover');
            if(cover) cover.style.display = 'none';
            container.innerHTML = '<video controls controlsList="download" class="w-full h-full" autoplay><source src="'+url+'" type="video/mp4"></video>';
            window.scrollTo({top: 0, behavior: 'smooth'});
        }
        function filterLibrary(val) {
            document.querySelectorAll('.library-item').forEach(item => {
                const title = item.getAttribute('data-title').toLowerCase();
                item.style.display = title.includes(val.toLowerCase()) ? 'flex' : 'none';
            });
        }
        function toggleHelp() { document.getElementById('dl-help').classList.toggle('hidden'); }
      `}} />
    </head>
    <body>
      <div id="page-loader"><div class="spinner"></div></div>
      {!props.hideNav && (
        <nav class="sticky top-0 z-50 glass px-4 py-3 flex justify-between items-center">
            <a href="/" class="text-xl font-black text-red-600 italic">GOLD FLIX</a>
            <div class="flex gap-5 text-gray-400 items-center text-sm font-bold">
              <a href="/">Home</a>
              <a href="/favorites">Saved</a>
              <a href="/request">Request</a>
              {props.user ? <a href="/profile" class="text-white bg-red-600 w-7 h-7 flex items-center justify-center rounded-full text-xs">{props.user.username[0].toUpperCase()}</a> : <a href="/login">Login</a>}
            </div>
        </nav>
      )}
      {props.announcement && (
        <div class="bg-yellow-500 text-black text-[11px] font-bold py-1.5 px-4 sticky top-[53px] z-40">
          <marquee scrollamount="5">{props.announcement}</marquee>
        </div>
      )}
      <main class="min-h-screen">{props.children}</main>
    </body>
  </html>
);
