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
        .glass { background: rgba(20, 20, 20, 0.9); backdrop-filter: blur(15px); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .input-box { background: #1a1a1a; border: 1px solid #333; color: white; padding: 12px; border-radius: 12px; width: 100%; outline: none; }
        .btn-primary { background: #E50914; color: white; font-weight: bold; padding: 12px 24px; border-radius: 12px; cursor: pointer; text-align: center; }
        .h-scroll-section { display: flex; overflow-x: auto; gap: 15px; padding-bottom: 10px; }
        .movie-card { min-width: 120px; width: 120px; flex-shrink: 0; }
        .movie-card.wide { min-width: 260px; width: 260px; }
        .slider-container { position: relative; height: 250px; overflow: hidden; }
        .slide { position: absolute; inset: 0; opacity: 0; transition: 1s ease-in-out; }
        .slide.active { opacity: 1; }
      `}</style>
      <script dangerouslySetInnerHTML={{__html: `
        document.addEventListener('DOMContentLoaded', () => {
            const slides = document.querySelectorAll('.slide');
            if(slides.length > 0) {
                let current = 0;
                setInterval(() => {
                    slides[current].classList.remove('active');
                    current = (current + 1) % slides.length;
                    slides[current].classList.add('active');
                }, 4000);
            }
        });
        function toggleSeason(id) { document.getElementById('season-'+id).classList.toggle('hidden'); }
        function loadPlayer(url) {
            document.getElementById('video-cover').style.display = 'none';
            document.getElementById('video-box').innerHTML = '<video controls class="w-full h-full" autoplay><source src="'+url+'" type="video/mp4"></video>';
        }
        function toggleHelp() { document.getElementById('help-box').classList.toggle('hidden'); }
        function filterLibrary(val) {
            document.querySelectorAll('.lib-item').forEach(i => i.style.display = i.getAttribute('data-title').toLowerCase().includes(val.toLowerCase()) ? 'flex' : 'none');
        }
      `}} />
    </head>
    <body>
      {!props.hideNav && (
        <nav class="sticky top-0 z-50 glass px-6 py-4 flex justify-between items-center">
            <a href="/" class="text-2xl font-black text-red-600 italic tracking-tighter">GOLD FLIX</a>
            <div class="flex gap-5 text-gray-400 items-center text-sm font-bold">
              <a href="/">Home</a>
              <a href="/favorites">Saved</a>
              <a href="/request">Request</a>
              {props.user ? <a href="/profile" class="bg-red-600 w-8 h-8 flex items-center justify-center rounded-full text-white">{props.user.username[0].toUpperCase()}</a> : <a href="/login">Login</a>}
            </div>
        </nav>
      )}
      {props.announcement && (
        <div class="bg-yellow-500 text-black text-[11px] font-bold py-2 px-6 sticky top-[65px] z-40">
          <marquee scrollamount="5">{props.announcement}</marquee>
        </div>
      )}
      <main class="min-h-screen pb-20">{props.children}</main>
    </body>
  </html>
);
