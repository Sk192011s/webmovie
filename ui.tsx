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
        .glass { background: rgba(26, 26, 26, 0.95); backdrop-filter: blur(10px); }
        .input-box { background: #1f1f1f; border: 1px solid #333; color: white; padding: 12px; border-radius: 8px; width: 100%; outline: none; }
        .input-box:focus { border-color: #E50914; }
        .btn-primary { background: #E50914; color: white; font-weight: bold; padding: 12px; border-radius: 8px; transition: 0.3s; text-align: center; }
        .btn-primary:active { transform: scale(0.98); }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 12px; padding-bottom: 10px; scroll-snap-type: x mandatory; }
        .h-scroll-section::-webkit-scrollbar { display: none; }
        .movie-card { min-width: 110px; width: 110px; scroll-snap-align: start; }
        .movie-card.wide { min-width: 240px; width: 240px; }
        #page-loader { position: fixed; inset: 0; background: #000; z-index: 9999; display: flex; justify-content: center; align-items: center; transition: 0.3s; pointer-events: none; opacity: 0; }
        #page-loader.active { opacity: 1; pointer-events: all; }
        .spinner { width: 40px; height: 40px; border: 4px solid #333; border-top-color: #E50914; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        function showToast(m, t) { alert(m); } // ရိုးရှင်းအောင် alert သုံးထားသည်
        document.addEventListener('DOMContentLoaded', () => {
          const loader = document.getElementById('page-loader');
          window.addEventListener('beforeunload', () => loader.classList.add('active'));
          window.addEventListener('pageshow', () => loader.classList.remove('active'));
        });
        function loadPlayer(url, type) {
          const container = document.getElementById('video-container');
          container.innerHTML = type === 'embed' ? \`<iframe src="\${url}" class="w-full h-full" frameborder="0" allowfullscreen></iframe>\` : \`<video src="\${url}" controls autoplay class="w-full h-full"></video>\`;
          window.scrollTo({top: 0, behavior: 'smooth'});
        }
      `}} />
    </head>
    <body>
      <div id="page-loader"><div class="spinner"></div></div>
      {!props.hideNav && (
        <nav class="sticky top-0 z-50 glass border-b border-white/10 px-4 py-3">
          <div class="max-w-7xl mx-auto flex justify-between items-center">
            <a href="/" class="text-xl font-black text-red-600 italic">GOLD FLIX</a>
            <div class="flex gap-4 text-xs font-bold text-gray-400 items-center">
              <a href="/"><i class="fa-solid fa-house"></i></a>
              <a href="/favorites"><i class="fa-solid fa-heart"></i></a>
              <a href="/request"><i class="fa-solid fa-paper-plane"></i></a>
              {props.user ? <a href="/profile" class="text-white bg-red-600 px-3 py-1 rounded-full">{props.user.username[0].toUpperCase()}</a> : <a href="/login">Login</a>}
            </div>
          </div>
        </nav>
      )}
      {props.announcement && (
        <div class="bg-yellow-500 text-black text-[10px] font-bold py-1 px-4"><marquee>{props.announcement}</marquee></div>
      )}
      <main class="max-w-7xl mx-auto min-h-screen">{props.children}</main>
      <footer class="p-10 text-center text-gray-600 text-xs border-t border-zinc-900">
        &copy; 2025 Gold Flix. All rights reserved.
      </footer>
    </body>
  </html>
);
