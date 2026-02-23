import { Hono } from "npm:hono@4";
import { secureHeaders } from "npm:hono@4/secure-headers";

const app = new Hono();
app.use("*", secureHeaders());

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

if (!GEMINI_API_KEY) {
  console.error("❌ ERROR: Set 'GEMINI_API_KEY' in Deno env vars.");
}

// ===== Gemini API Helper =====
async function askGemini(promptText: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.9,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 2048,
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          ],
        }),
      }
    );
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    console.error("Gemini API Error:", e);
    return null;
  }
}

// ===== Main API: Generate Movie Synopsis =====
app.post("/api/generate", async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title || "").trim();
  const type = String(body.type || "Movie").trim();
  const year = String(body.year || "").trim();
  const currentDesc = String(body.currentDesc || "").trim();

  if (!title && !currentDesc) {
    return c.json({ error: "ခေါင်းစဉ် (သို့) အညွန်းစာ ထည့်ပေးပါ။" });
  }

  if (!GEMINI_API_KEY) {
    return c.json({ error: "GEMINI_API_KEY မထည့်ရသေးပါ။ Deno env မှာ set လုပ်ပါ။" });
  }

  const inputText = currentDesc || title;
  const yearInfo = year ? `(${year})` : "";
  const typeInfo = type || "Movie";

  // ===== Strategy 1: Deep Burmese Synopsis (Primary) =====
  const prompt1 = `
You are a professional Myanmar movie reviewer and channel admin who writes extremely detailed, vivid, and engaging movie synopses in Burmese (Myanmar Unicode).

**STRICT RULES:**
1. Write ONLY in Burmese Myanmar Unicode. No English words at all (except character names).
2. Use natural spoken Burmese tone: "တယ်", "ပါတယ်", "မယ်", "လိုက်တယ်", "ဖြစ်တယ်" — NOT formal "သည်/မည်/၏".
3. Be EXTREMELY detailed and vivid — minimum 5-8 paragraphs.
4. Describe the plot step-by-step like you're telling a friend the whole story.
5. Include: character emotions, turning points, suspense moments, relationships, conflicts.
6. Use dramatic storytelling: "ဒါပေမယ့် သူမသိတာက...", "အဲ့မှာပဲ အရာအားလုံး ပြောင်းသွားတယ်...", "ကံဆိုးချင်တော့..."
7. End with a hook that makes the reader want to watch: "ဘယ်လိုအဆုံးသတ်သွားလဲ... ကိုယ်တိုင်ကြည့်ပါ"
8. If the input is in English, translate AND expand it into a rich Burmese narrative.
9. If the input is already Burmese, rewrite it to be much more detailed and dramatic.
10. Add atmosphere descriptions: settings, moods, tensions.

**Movie Info:**
- Title: "${title}" ${yearInfo}
- Type: ${typeInfo}
- Input Text: "${inputText}"

**OUTPUT: ONLY the Burmese synopsis. No headers, no labels, no English explanation.**
`;

  let result = await askGemini(prompt1);

  // ===== Strategy 2: Romantic/Soft Rewrite (Fallback for blocked content) =====
  if (!result) {
    console.log("Strategy 1 blocked. Trying romantic rewrite...");
    const prompt2 = `
You are a Myanmar entertainment channel admin who writes movie descriptions in Burmese.
Rewrite the following plot into an engaging, detailed Burmese synopsis.
Use soft romantic metaphors for any explicit content.
Use natural spoken Burmese ("တယ်/ပါတယ်/မယ်").
Write at least 4-5 paragraphs. Be descriptive and emotional.

Title: "${title}" ${yearInfo}
Type: ${typeInfo}
Input: "${inputText}"

OUTPUT: ONLY Burmese text. No English.
`;
    result = await askGemini(prompt2);
  }

  // ===== Strategy 3: Simple Translation (Last Resort) =====
  if (!result) {
    console.log("Strategy 2 blocked. Trying simple translation...");
    const prompt3 = `
Translate the following movie description into natural spoken Burmese (Myanmar Unicode).
Make it detailed and interesting. Use "တယ်/ပါတယ်" style, not formal "သည်/မည်".
Write at least 3 paragraphs.

Input: "${inputText}"

OUTPUT: ONLY Burmese text.
`;
    result = await askGemini(prompt3);
  }

  if (!result) {
    return c.json({ error: "AI က ဘာသာပြန်မပေးနိုင်ပါ။ နောက်တစ်ခါ ပြန်စမ်းပါ။" });
  }

  // Clean up the result
  result = result
    .replace(/^#+\s*/gm, "")           // Remove markdown headers
    .replace(/\*\*/g, "")              // Remove bold markers
    .replace(/\*/g, "")               // Remove italic markers
    .replace(/^[-•]\s*/gm, "")        // Remove bullet points
    .replace(/^\d+\.\s*/gm, "")       // Remove numbered lists
    .replace(/\n{3,}/g, "\n\n")       // Normalize line breaks
    .trim();

  return c.json({ desc: result });
});

// ===== Web UI =====
app.get("/", (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="my">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Movie Synopsis Generator - မြန်မာအညွန်း</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #0a0a0a; color: #e2e8f0; font-family: 'Inter', sans-serif; }
        .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); }
        .input-field { background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1); color: white; padding: 14px 16px; border-radius: 14px; width: 100%; outline: none; transition: 0.3s; font-size: 14px; }
        .input-field:focus { border-color: #a855f7; box-shadow: 0 0 0 3px rgba(168,85,247,0.15); }
        .input-field::placeholder { color: #4a5568; }
        textarea.input-field { resize: vertical; min-height: 80px; line-height: 1.7; }
        .btn-generate { background: linear-gradient(135deg, #7c3aed, #a855f7, #c084fc); color: white; font-weight: 800; padding: 16px 24px; border-radius: 16px; border: none; cursor: pointer; transition: all 0.3s; box-shadow: 0 8px 30px rgba(168,85,247,0.3); font-size: 15px; letter-spacing: 0.5px; }
        .btn-generate:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(168,85,247,0.4); }
        .btn-generate:active { transform: scale(0.97); }
        .btn-generate:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .result-box { background: rgba(0,0,0,0.5); border: 1px solid rgba(168,85,247,0.2); border-radius: 16px; padding: 24px; min-height: 200px; line-height: 2; font-size: 14px; white-space: pre-wrap; color: #d1d5db; position: relative; }
        .copy-btn { position: absolute; top: 12px; right: 12px; background: rgba(168,85,247,0.2); border: 1px solid rgba(168,85,247,0.3); color: #c084fc; padding: 8px 16px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700; transition: 0.3s; }
        .copy-btn:hover { background: #7c3aed; color: white; }
        .loading { display: inline-block; width: 20px; height: 20px; border: 3px solid rgba(255,255,255,0.2); border-radius: 50%; border-top: 3px solid #c084fc; animation: spin 0.8s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .fade-up { animation: fadeUp 0.5s ease forwards; }
        .pulse-dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; display: inline-block; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .toast { position: fixed; top: 20px; right: 20px; background: rgba(34,197,94,0.9); color: white; padding: 14px 24px; border-radius: 12px; font-weight: 700; font-size: 13px; z-index: 1000; transform: translateX(120%); transition: transform 0.4s cubic-bezier(0.34,1.56,0.64,1); backdrop-filter: blur(10px); }
        .toast.show { transform: translateX(0); }
        .char-count { font-size: 10px; color: #6b7280; text-align: right; margin-top: 4px; }
    </style>
</head>
<body class="min-h-screen">
    <div id="toast" class="toast"><i class="fa-solid fa-check mr-2"></i>Copied!</div>

    <div class="max-w-2xl mx-auto px-4 py-8">
        <!-- Header -->
        <div class="text-center mb-10 fade-up">
            <div class="inline-flex items-center gap-3 mb-4">
                <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center shadow-lg shadow-purple-900/30">
                    <i class="fa-solid fa-language text-white text-xl"></i>
                </div>
                <div class="text-left">
                    <h1 class="text-2xl font-black text-white tracking-tight">Movie Synopsis</h1>
                    <p class="text-xs text-purple-400 font-bold">English → Myanmar Translator</p>
                </div>
            </div>
            <p class="text-gray-500 text-sm max-w-md mx-auto leading-relaxed">
                ရုပ်ရှင်အညွန်းကို English လို ထည့်ပေးလိုက်ရင် မြန်မာလို နိူက်နိူက်ချွတ်ချွတ် ဘာသာပြန်ပေးပါမယ်
            </p>
        </div>

        <!-- Input Form -->
        <div class="glass rounded-2xl p-6 mb-6 fade-up" style="animation-delay: 0.1s">
            <form id="genForm" class="space-y-5">
                <!-- Title -->
                <div>
                    <label class="block text-[10px] uppercase font-bold text-gray-500 mb-2 tracking-widest">
                        <i class="fa-solid fa-film mr-1 text-purple-500"></i> Movie Title (ခေါင်းစဉ်)
                    </label>
                    <input id="titleInput" name="title" placeholder="e.g. Avengers: Endgame" class="input-field" />
                </div>

                <!-- Type & Year -->
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] uppercase font-bold text-gray-500 mb-2 tracking-widest">Type</label>
                        <select id="typeInput" name="type" class="input-field">
                            <option value="Movie">Movie</option>
                            <option value="Series">Series</option>
                            <option value="Anime">Anime</option>
                            <option value="Documentary">Documentary</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[10px] uppercase font-bold text-gray-500 mb-2 tracking-widest">Year</label>
                        <input id="yearInput" name="year" placeholder="2024" class="input-field text-center" />
                    </div>
                </div>

                <!-- Description Input -->
                <div>
                    <label class="block text-[10px] uppercase font-bold text-gray-500 mb-2 tracking-widest">
                        <i class="fa-solid fa-pen-fancy mr-1 text-yellow-500"></i> English Synopsis / Description
                    </label>
                    <textarea id="descInput" name="currentDesc" rows="5" placeholder="English လို ဇာတ်ကားအညွန်း ထည့်ပါ...&#10;&#10;e.g. A young woman discovers she has supernatural powers after a mysterious accident. She must learn to control her abilities while being hunted by a secret organization..." class="input-field" style="line-height: 1.8;"></textarea>
                    <div id="charCount" class="char-count">0 characters</div>
                </div>

                <!-- Generate Button -->
                <button type="submit" id="genBtn" class="btn-generate w-full flex items-center justify-center gap-3">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span id="btnText">မြန်မာလို ဘာသာပြန်မည်</span>
                </button>
            </form>
        </div>

        <!-- Result -->
        <div id="resultSection" class="hidden fade-up" style="animation-delay: 0.2s">
            <div class="flex items-center justify-between mb-3">
                <h3 class="text-sm font-bold text-purple-400 flex items-center gap-2">
                    <span class="pulse-dot"></span> ရလဒ် (Result)
                </h3>
                <span id="resultLength" class="text-[10px] text-gray-600"></span>
            </div>
            <div class="result-box" id="resultBox">
                <button onclick="copyResult()" class="copy-btn">
                    <i class="fa-regular fa-copy mr-1"></i> Copy
                </button>
                <div id="resultText"></div>
            </div>
            
            <!-- Action Buttons -->
            <div class="flex gap-3 mt-4">
                <button onclick="regenerate()" class="flex-1 py-3 rounded-xl bg-zinc-800 text-white font-bold text-xs border border-zinc-700 hover:bg-zinc-700 transition flex items-center justify-center gap-2">
                    <i class="fa-solid fa-rotate"></i> ပြန်ရေးမည်
                </button>
                <button onclick="copyResult()" class="flex-1 py-3 rounded-xl bg-purple-600 text-white font-bold text-xs hover:bg-purple-500 transition flex items-center justify-center gap-2 shadow-lg shadow-purple-900/20">
                    <i class="fa-solid fa-copy"></i> Copy ကူးမည်
                </button>
            </div>
        </div>

        <!-- Footer -->
        <div class="text-center mt-12 text-[10px] text-gray-700">
            Powered by Gemini AI &bull; Myanmar Synopsis Generator
        </div>
    </div>

    <script>
        const form = document.getElementById('genForm');
        const btn = document.getElementById('genBtn');
        const btnText = document.getElementById('btnText');
        const resultSection = document.getElementById('resultSection');
        const resultText = document.getElementById('resultText');
        const resultLength = document.getElementById('resultLength');
        const descInput = document.getElementById('descInput');
        const charCount = document.getElementById('charCount');
        const toast = document.getElementById('toast');

        // Character counter
        descInput.addEventListener('input', () => {
            charCount.textContent = descInput.value.length + ' characters';
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await generate();
        });

        async function generate() {
            const title = document.getElementById('titleInput').value.trim();
            const type = document.getElementById('typeInput').value;
            const year = document.getElementById('yearInput').value.trim();
            const desc = descInput.value.trim();

            if (!title && !desc) {
                showToast('ခေါင်းစဉ် (သို့) အညွန်းစာ ထည့်ပေးပါ။', 'error');
                return;
            }

            // Loading state
            btn.disabled = true;
            btnText.innerHTML = '<span class="loading"></span> AI ရေးနေပါတယ်... ခေတ္တစောင့်ပါ';

            try {
                const formData = new URLSearchParams();
                formData.append('title', title);
                formData.append('type', type);
                formData.append('year', year);
                formData.append('currentDesc', desc);

                const res = await fetch('/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: formData.toString()
                });

                const data = await res.json();

                if (data.error) {
                    showToast(data.error, 'error');
                } else {
                    resultText.textContent = data.desc;
                    resultLength.textContent = data.desc.length + ' chars';
                    resultSection.classList.remove('hidden');
                    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            } catch (err) {
                showToast('Connection Error. ပြန်စမ်းပါ။', 'error');
                console.error(err);
            } finally {
                btn.disabled = false;
                btnText.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles mr-1"></i> မြန်မာလို ဘာသာပြန်မည်';
            }
        }

        function regenerate() {
            generate();
        }

        function copyResult() {
            const text = resultText.textContent;
            if (!text) return;

            if (navigator.clipboard) {
                navigator.clipboard.writeText(text);
            } else {
                const el = document.createElement('textarea');
                el.value = text;
                document.body.appendChild(el);
                el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
            }
            showToast('Copied!', 'success');
        }

        function showToast(msg, type) {
            toast.textContent = msg;
            toast.style.background = type === 'error' 
                ? 'rgba(239,68,68,0.9)' 
                : 'rgba(34,197,94,0.9)';
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2500);
        }
    </script>
</body>
</html>
  `);
});

Deno.serve(app.fetch);
