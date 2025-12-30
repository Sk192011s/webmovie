import { Movie, User, VipKey, UserRequest, AppConfig } from "./types.ts";
import * as bcrypt from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";

const kv = await Deno.openKv();

export const hashPassword = (password: string) => bcrypt.hash(password);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export async function getMovies() {
  const iter = kv.list<Movie>({ prefix: ["movies"] });
  const movies = [];
  for await (const res of iter) movies.push(res.value);
  return movies.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getMovie(id: string) { return (await kv.get<Movie>(["movies", id])).value; }
export async function getUser(username: string) { return (await kv.get<User>(["users", username])).value; }
export async function getKeys() { 
    const iter = kv.list<VipKey>({ prefix: ["keys"] });
    const keys = []; for await (const res of iter) keys.push(res.value);
    return keys;
}
export async function getRequests() {
    const iter = kv.list<UserRequest>({ prefix: ["requests"] });
    const reqs = []; for await (const res of iter) reqs.push(res.value);
    return reqs;
}
export async function getConfig() { 
    const res = await kv.get<AppConfig>(["config"]);
    return res.value || { announcement: "Welcome to Gold Flix!", showAnnouncement: true };
}

export { kv };
