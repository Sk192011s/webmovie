import { Hono } from "npm:hono@4";
import { getCookie, setCookie, deleteCookie } from "npm:hono@4/cookie";
import { secureHeaders } from "npm:hono@4/secure-headers";
import { compress } from "npm:hono@4/compress";

const app = new Hono();
const kv = await Deno.openKv();

const ADMIN_PASS = Deno.env.get("ADMIN_PASSWORD") || "123456";
const ADMIN_ROUTE = Deno.env.get("ADMIN_ROUTE_PATH") || "/admin_panel_secure";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const ADMIN_SESSION_EXPIRE = 24 * 60 * 60;

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is not set");
}

function page(title: string, body: string) {
  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
    <style>
      body {
        background: #050505;
        color: white;
        font-family: Inter, system-ui, sans-serif;
      }
      .glass {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        backdrop-filter: blur(10px);
      }
      .input-box {
        width: 100%;
        background: #0b0b0b;
        border: 1px solid rgba(255,255,255,0.12);
        color: white;
        border-radius: 18px;
        padding: 14px 16px;
        outline: none;
        transition: .2s;
      }
      .input-box:focus {
        border-color: #a855f7;
        box-shadow: 0 0 0 3px rgba(168,85,247,.15);
      }
      .btn-primary {
        background: linear-gradient(135deg, #a855f7, #7c3aed);
        color: white;
        font-weight: 700;
        border-radius: 16px;
        padding: 12px 18px;
        border: none;
      }
      .btn-primary:disabled {
        opacity: .6;
        cursor: not-allowed;
      }
      .btn-dark {
        background: #111111;
        border: 1px solid rgba(255,255,255,0.1);
        color: #ddd;
        font-weight: 700;
        border-radius: 16px;
        padding: 12px 18px;
      }
      textarea {
        min-height: 200px;
        resize: vertical;
      }
    </style>
  </head>
  <body>
    ${body}
  </body>
  </html>
  `;
}

async function adminGuard(c: any, next: any) {
  const sid = getCookie(c, "admin_session_id");
  if (!sid) return c.redirect(ADMIN_ROUTE);

  const stored = await kv.get(["admin_sessions", sid]);
  if (!stored.value) return c.redirect(ADMIN_ROUTE);

  await next();
}

app.use("*", secureHeaders());
app.use("*", compress());

app.get("/", (c) => c.redirect(ADMIN_ROUTE));

app.get(ADMIN_ROUTE, (c) => {
  return c.html(
    page(
      "Admin Login",
      `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-sm glass rounded-3xl p-8 shadow-2xl">
          <div class="text-center mb-8">
            <div class="w-16 h-16 rounded-full mx-auto mb-4 bg-purple-600/20 flex items-center justify-center">
              <i class="fa-solid fa-robot text-2xl text-purple-400"></i>
            </div>
            <h1 class="text-3xl font-black tracking-tight">AI Translation Tool</h1>
            <p class="text-gray-400 text-sm mt-2">Admin login</p>
          </div>

          <form action="${ADMIN_ROUTE}/login" method="post" class="space-y-4">
            <input
              type="password"
              name="password"
              placeholder="Enter admin password"
              class="input-box"
              required
            />
            <button class="btn-primary w-full">Login</button>
          </form>
        </div>
      </div>
      `
    )
  );
});

app.post(`${ADMIN_ROUTE}/login`, async (c) => {
  const body = await c.req.parseBody();
  const password = String(body.password || "");

  if (password !== ADMIN_PASS) {
    return c.html(
      page(
        "Login Failed",
        `
        <div class="min-h-screen flex items-center justify-center p-4">
          <div class="w-full max-w-sm glass rounded-3xl p-8 text-center">
            <div class="text-red-400 text-5xl mb-4"><i class="fa-solid fa-circle-xmark"></i></div>
            <h1 class="text-2xl font-bold mb-2">Wrong password</h1>
            <a href="${ADMIN_ROUTE}" class="btn-dark inline-block mt-4">Back</a>
          </div>
        </div>
        `
      )
    );
  }

  const sessionId = crypto.randomUUID();
  await kv.set(["admin_sessions", sessionId], "active", {
    expireIn: ADMIN_SESSION_EXPIRE,
  });

  setCookie(c, "admin_session_id", sessionId, {
    path: "/",
    httpOnly: true,
    secure: !c.req.url.includes("localhost"),
    sameSite: "Strict",
    maxAge: ADMIN_SESSION_EXPIRE,
  });

  return c.redirect(`${ADMIN_ROUTE}/dashboard`);
});

app.get(`${ADMIN_ROUTE}/logout`, async (c) => {
  const sid = getCookie(c, "admin_session_id");
  if (sid) {
    await kv.delete(["admin_sessions", sid]);
  }
  deleteCookie(c, "admin_session_id", { path: "/" });
  return c.redirect(ADMIN_ROUTE);
});

app.get(`${ADMIN_ROUTE}/dashboard`, adminGuard, (c) => {
  return c.html(
    page(
      "AI Dashboard",
      `
      <div class="min-h-screen p-4 md:p-8">
        <div class="max-w-4xl mx-auto">
          <div class="flex items-center justify-between mb-6 gap-3">
            <div>
              <h1 class="text-3xl md:text-4xl font-black tracking-tight">AI Burmese Rewriter</h1>
              <p class="text-gray-400 text-sm mt-2">English / Japanese / other text → Burmese synopsis</p>
            </div>
            <a href="${ADMIN_ROUTE}/logout" class="btn-dark whitespace-nowrap">
              <i class="fa-solid fa-right-from-bracket mr-2"></i>Logout
            </a>
          </div>

          <div class="glass rounded-3xl p-5 md:p-6 shadow-2xl">
            <div class="grid gap-4">
              <div>
                <label class="block text-xs uppercase text-gray-400 font-bold mb-2">Title (optional)</label>
                <input id="title" class="input-box" placeholder="Movie title or code..." />
              </div>

              <div>
                <label class="block text-xs uppercase text-gray-400 font-bold mb-2">Mode</label>
                <select id="mode" class="input-box">
                  <option value="story">ပုံပြင်ပြောသလို အညွန်းရေးမယ်</option>
                  <option value="translate">တိုက်ရိုက်ဘာသာပြန်မယ်</option>
                </select>
              </div>

              <div>
                <div class="flex items-center justify-between mb-2 gap-3">
                  <label class="block text-xs uppercase text-gray-400 font-bold">Source Text</label>
                  <button id="generateBtn" type="button" onclick="generateText()" class="btn-primary">
                    <i class="fa-solid fa-robot mr-2"></i>Auto Gen (AI)
                  </button>
                </div>
                <textarea id="sourceText" class="input-box" placeholder="English / Japanese text here..."></textarea>
              </div>

              <div>
                <div class="flex items-center justify-between mb-2 gap-3">
                  <label class="block text-xs uppercase text-gray-400 font-bold">Result</label>
                  <button type="button" onclick="copyResult()" class="btn-dark">
                    <i class="fa-regular fa-copy mr-2"></i>Copy
                  </button>
                </div>
                <textarea id="resultText" class="input-box" placeholder="AI result will appear here..."></textarea>
              </div>

              <div id="statusBox" class="hidden rounded-2xl px-4 py-3 text-sm"></div>
            </div>
          </div>
        </div>
      </div>

      <script>
        function showStatus(message, type = "info") {
          const box = document.getElementById("statusBox");
          box.classList.remove("hidden");
          box.innerText = message;
          box.className = "rounded-2xl px-4 py-3 text-sm";

          if (type === "error") {
            box.classList.add("bg-red-500/10", "text-red-400", "border", "border-red-500/20");
          } else if (type === "success") {
            box.classList.add("bg-green-500/10", "text-green-400", "border", "border-green-500/20");
          } else {
            box.classList.add("bg-purple-500/10", "text-purple-300", "border", "border-purple-500/20");
          }
        }

        async function copyResult() {
          const result = document.getElementById("resultText").value || "";
          if (!result.trim()) {
            showStatus("Nothing to copy", "error");
            return;
          }
          try {
            await navigator.clipboard.writeText(result);
            showStatus("Copied successfully", "success");
          } catch {
            showStatus("Copy failed", "error");
          }
        }

        async function generateText() {
          const btn = document.getElementById("generateBtn");
          const title = document.getElementById("title").value.trim();
          const mode = document.getElementById("mode").value;
          const sourceText = document.getElementById("sourceText").value.trim();
          const resultBox = document.getElementById("resultText");

          if (!title && !sourceText) {
            showStatus("Please enter title or source text first", "error");
            return;
          }

          btn.disabled = true;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Generating...';
          showStatus("AI is working...", "info");

          try {
            const res = await fetch("${ADMIN_ROUTE}/api/generate", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded"
              },
              body:
                "title=" + encodeURIComponent(title) +
                "&mode=" + encodeURIComponent(mode) +
                "&sourceText=" + encodeURIComponent(sourceText)
            });

            const data = await res.json();

            if (data.error) {
              showStatus(data.error, "error");
              return;
            }

            resultBox.value = data.result || "";
            showStatus("Generated successfully", "success");
          } catch (e) {
            showStatus("Request failed", "error");
          } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-robot mr-2"></i>Auto Gen (AI)';
          }
        }
      </script>
      `
    )
  );
});

async function askGemini(promptText: string) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 400,
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error: data?.error?.message || `HTTP ${response.status}`,
        raw: data,
      };
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text && text.trim()) {
      return {
        ok: true,
        text: text.trim(),
      };
    }

    return {
      ok: false,
      error:
        data?.promptFeedback?.blockReason ||
        data?.candidates?.[0]?.finishReason ||
        "No text returned",
      raw: data,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

app.post(`${ADMIN_ROUTE}/api/generate`, adminGuard, async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title || "").trim();
  const sourceText = String(body.sourceText || "").trim();
  const mode = String(body.mode || "story").trim();

  if (!GEMINI_API_KEY) {
    return c.json({ error: "GEMINI_API_KEY not set." });
  }

  if (!title && !sourceText) {
    return c.json({ error: "Title or source text required." });
  }

  const inputText = sourceText || title;

  const prompts: Record<string, string[]> = {
    story: [
      `
You are a Burmese movie-page writer.

Task:
Write the given content into Burmese as if telling a short movie synopsis in a natural, engaging, human style.

Input title: ${title}
Input text: ${inputText}

Rules:
- Output only Burmese Unicode
- Sound natural and readable
- Write like a movie page summary
- 2 to 5 sentences
- Keep the meaning from the source text as much as possible
- Do not add headings
- Do not explain anything
`,
      `
Translate this into Burmese naturally.

Title: ${title}
Text: ${inputText}

Output only Burmese.
`,
    ],

    translate: [
      `
Translate the following text into Burmese.

Title: ${title}
Text: ${inputText}

Rules:
- Burmese Unicode only
- Keep the original meaning as much as possible
- No explanation
- No heading
`,
    ],
  };

  const selectedPrompts = prompts[mode] || prompts.story;
  let lastError = "Unknown error";

  for (const prompt of selectedPrompts) {
    const result = await askGemini(prompt);
    console.log("Gemini result:", result);

    if (result.ok && result.text) {
      return c.json({ result: result.text });
    }

    lastError = result.error || "Unknown AI error";
  }

  return c.json({ error: `AI generate failed: ${lastError}` });
});

app.notFound((c) => c.redirect(ADMIN_ROUTE));

app.onError((err, c) => {
  console.error(err);
  return c.html(
    page(
      "Error",
      `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-md glass rounded-3xl p-8 text-center">
          <div class="text-red-400 text-5xl mb-4"><i class="fa-solid fa-triangle-exclamation"></i></div>
          <h1 class="text-2xl font-bold mb-2">Something went wrong</h1>
          <p class="text-gray-400 text-sm">${String(err.message || err)}</p>
          <a href="${ADMIN_ROUTE}" class="btn-dark inline-block mt-5">Back</a>
        </div>
      </div>
      `
    )
  );
});

Deno.serve(app.fetch);
