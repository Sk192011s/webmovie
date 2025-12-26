export const kv = await Deno.openKv();

export interface Movie {
  id: string;
  title: string;
  posterUrl: string;
  category: "Movies" | "Series" | "Adult";
  description: string;
  tags: string[];
  year: string;
  streamUrl: string;
  downloadUrl?: string; // ရှိမှထည့်မယ်
}

// ရုပ်ရှင်အားလုံးယူရန်
export async function getMovies() {
  const iter = kv.list<Movie>({ prefix: ["movies"] });
  const movies = [];
  for await (const res of iter) movies.push(res.value);
  return movies;
}

// ရုပ်ရှင်တစ်ခုတည်းယူရန်
export async function getMovie(id: string) {
  const res = await kv.get<Movie>(["movies", id]);
  return res.value;
}

// Initial Data ထည့်ရန် (Setup အတွက်)
export async function seedData() {
  const sampleMovies: Movie[] = [
    {
      id: "1",
      title: "The Horror Night",
      posterUrl: "https://image.tmdb.org/t/p/w500/u3YQJctMzFN2wV4rgUeKUEHcPC2.jpg",
      category: "Movies",
      description: "2025 ခုနှစ်ထွက် သရဲကားကောင်းတစ်ကား။",
      tags: ["Horror", "2025"],
      year: "2025",
      streamUrl: "https://www.w3schools.com/html/mov_bbb.mp4"
    },
    {
      id: "2",
      title: "Love Story",
      posterUrl: "https://image.tmdb.org/t/p/w500/t6HIqrRAclMCA60NsSmeqe9RmNV.jpg",
      category: "Series",
      description: "အချစ် ဇာတ်လမ်းတွဲ။",
      tags: ["Romance", "Drama"],
      year: "2024",
      streamUrl: "https://www.w3schools.com/html/mov_bbb.mp4"
    },
    {
      id: "3",
      title: "Secret Room",
      posterUrl: "https://image.tmdb.org/t/p/w500/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg",
      category: "Adult",
      description: "18+ Only content.",
      tags: ["Adult", "18+"],
      year: "2023",
      streamUrl: "https://www.w3schools.com/html/mov_bbb.mp4"
    }
  ];

  for (const movie of sampleMovies) {
    await kv.set(["movies", movie.id], movie);
  }
}
