// ============================================================
//  SERDIYA ADDRESS BOT v9.8 — MASTER (AUTO-SAVE)
//  Flow: Address → Regex clean → (AI sirf mushkil pe) → Validate
//        → India Post pincode check → SEEDHA Google Sheet
//  Telegram jawab SIRF: PPD ya phone/pincode/COD missing
//  Stack: Node.js + Telegraf + ChatGPT + Google Sheets + MongoDB + Render
// ============================================================

const { Telegraf } = require("telegraf");
const { google } = require("googleapis");
const express = require("express");
const { MongoClient } = require("mongodb");

// ---------------- ENV VARIABLES (Render me set karo) ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // ChatGPT — ekmatra AI
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // sasta + fast (full power chahiye to Render me "gpt-4o" set karo)
const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "Sheet1";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const MONGO_URI = process.env.MONGO_URI || ""; // SerdiyaMarginDB (learning ke liye)

// 🔒 ADMIN — SIRF in logo ke message padhe jayenge, baaki sabko ANDEKHA kar diya jayega.
//    Render me ADMIN_IDS set karo, comma se alag: "123456789,987654321"
//    Apna ID jaanne ke liye bot ko /id bhejo.
//    KHALI chhoda to purana wala behaviour — sabke message chalenge.
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(ctx) {
  if (ADMIN_IDS.length === 0) return true; // ADMIN_IDS set hi nahi — sabko chalne do
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300000 }); // 5 min (AI chain ke liye)

// (v7.0: koi pending/buttons nahi — address seedha Sheet me jata hai)

// ============================================================
//  🧠 SELF-LEARNING — aapke edits se seekhta hai (MongoDB me yaad)
//  Har "galat piece → sahi piece" ki rule ban jati hai.
//  Agli baar wahi galti aane pe bot KHUD sudhar deta hai.
// ============================================================
let learnCol = null;
const learnCache = new Map(); // wrong(lowercase) → { right, count }

async function initLearning() {
  if (!MONGO_URI) {
    console.log("🧠 Learning OFF (MONGO_URI set nahi hai)");
    return;
  }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    learnCol = client.db("SerdiyaMarginDB").collection("addressLearning");
    const all = await learnCol.find({}).toArray();
    for (const r of all) learnCache.set(r.wrong, { right: r.right, count: r.count || 1 });
    await cleanBadLearning(); // purani galat seekh (number/line wali) turant mitao
    console.log(`🧠 Learning ON — ${learnCache.size} safe rules yaad hai`);
  } catch (e) {
    console.log("🧠 Learning connect fail:", e.message);
  }
}

// Ye cheezein KABHI seekho mat — har address me alag hoti hai (galat seekh se bachne ke liye)
function isUnsafeToLearn(text) {
  const t = text.trim();
  if (/\d/.test(t)) return true;                      // koi bhi number (phone/pin/COD/weight/house no)
  if (/^COD/i.test(t)) return true;
  if (/\bg$/i.test(t)) return true;                    // weight
  if (/(chain|bali|anguthi|rakhdi|ring|payal|jhumka|kada|locket|set|combo|galachen)/i.test(t)) return true; // product
  if (/^(from|form|forum|frm|fram|👤|📦)/i.test(t)) return true;
  return false;
}

// Do word spelling-fix jaisa hai? (bahut alag na ho) — lev2-cap se azaad, apna hisaab
function isSpellingFix(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 2) return false; // length bahut alag = alag shabd
  // Character overlap: kam se kam 60% common letters ho
  const setA = new Set(a), common = [...b].filter((c) => setA.has(c)).length;
  const ratio = common / Math.max(a.length, b.length);
  if (ratio < 0.6) return false; // "barmer" vs "delhi" = bahut kam overlap = alag shabd
  // Pehla akshar same ho (spelling-fix me shuruaat aksar same rehti hai)
  if (a[0] !== b[0]) return false;
  return true;
}

// Ek naya WORD-sudhaar seekho (sirf spelling: "jumki" → "Jhumki") — line nahi, sirf shabd
async function learnCorrection(wrongWord, rightWord) {
  const w = wrongWord.trim().toLowerCase();
  const r = rightWord.trim();
  if (!w || !r) return;
  if (/\s/.test(w) || /\s/.test(r)) return;            // sirf SINGLE word
  if (!/^[a-z]{4,20}$/i.test(w) || !/^[a-z]{4,20}$/i.test(r)) return; // sirf alphabet
  if (w === r.toLowerCase()) return;
  if (!isSpellingFix(w, r)) return;                    // bahut alag shabd = seekho mat
  const prev = learnCache.get(w);
  const count = (prev?.count || 0) + 1;
  learnCache.set(w, { right: r, count });
  if (learnCol) {
    try {
      await learnCol.updateOne({ wrong: w }, { $set: { wrong: w, right: r, count }, $currentDate: { updatedAt: true } }, { upsert: true });
    } catch (e) {
      console.log("Learning save fail:", e.message);
    }
  }
}

// Seekhe hue WORD-sudhaar cleaned address pe LAGAO — har line ke ANDAR word-by-word
function applyLearning(cleanedText) {
  if (!learnCache.size) return { text: cleanedText, applied: [] };
  const applied = [];
  const out = cleanedText.split("\n").map((line) => {
    if (isUnsafeToLearn(line)) return line; // number/COD/product/weight wali line ko haath mat lagao
    // Har word alag se dekho, sirf poora word match ho to badlo
    return line.replace(/[A-Za-z]{4,20}/g, (word) => {
      const hit = learnCache.get(word.toLowerCase());
      if (hit && hit.right.toLowerCase() !== word.toLowerCase()) {
        applied.push(`"${word}" → "${hit.right}"`);
        return hit.right;
      }
      return word;
    });
  });
  return { text: out.join("\n"), applied };
}

// Aap edit karo → SIRF single-word spelling-sudhaar seekho (poori line kabhi nahi)
async function learnFromEdit(botVersion, userVersion) {
  const learned = [];
  const botLines = botVersion.split("\n").map((l) => l.trim()).filter(Boolean);
  const userLines = userVersion.split("\n").map((l) => l.trim()).filter(Boolean);
  // Sirf un lines ko dekho jo dono me hai aur SIRF ek word ka farak ho (safe)
  // Line-position pe bharosa nahi — har bot-line ke liye sabse milti-julti user-line dhundo
  for (const bl of botLines) {
    if (isUnsafeToLearn(bl)) continue;
    const bWords = bl.split(/\s+/);
    let best = null, bestDiff = 999;
    for (const ul of userLines) {
      if (isUnsafeToLearn(ul)) continue;
      const uWords = ul.split(/\s+/);
      if (uWords.length !== bWords.length) continue;   // same structure hi (word count same)
      let diffs = 0, diffPair = null;
      for (let i = 0; i < bWords.length; i++) {
        if (bWords[i].toLowerCase() !== uWords[i].toLowerCase()) { diffs++; diffPair = [bWords[i], uWords[i]]; }
      }
      if (diffs === 1 && diffs < bestDiff) { bestDiff = diffs; best = diffPair; }
    }
    if (best) {
      await learnCorrection(best[0], best[1]);
      // learnCorrection khud safety check karta hai; sirf tab dikhao jab wo waqai save hua
      const w = best[0].trim().toLowerCase();
      if (learnCache.get(w)?.right === best[1].trim()) learned.push(`"${best[0]}" → "${best[1]}"`);
    }
  }
  return learned;
}

// PURANI GALAT SEEKH MITAO (jaise "1chain"→"341001") — number/junk wali entries hatao
async function cleanBadLearning() {
  let removed = 0;
  for (const [w, v] of [...learnCache.entries()]) {
    const bad = /\d/.test(w) || /\d/.test(v.right) || /\s/.test(w) || /\s/.test(v.right) ||
      !/^[a-z]{4,20}$/i.test(w) || !/^[a-z]{4,20}$/i.test(v.right) || !isSpellingFix(w, v.right);
    if (bad) {
      learnCache.delete(w);
      removed++;
      if (learnCol) { try { await learnCol.deleteOne({ wrong: w }); } catch {} }
    }
  }
  if (removed) console.log(`🧹 ${removed} galat seekh mitayi`);
  return removed;
}

// ---------------- RATE-LIMIT HELPERS (429 fix) ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Telegram 429 aaye to retry_after wait karke dobara try karo (crash nahi)
async function tgRetry(fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const is429 = e?.response?.error_code === 429;
      const wait = e?.response?.parameters?.retry_after || 5;
      if (is429 && i < tries - 1) {
        console.log(`Telegram 429 — ${wait}s wait karke retry...`);
        await sleep(wait * 1000 + 500);
      } else throw e;
    }
  }
}

// ============================================================
//  1) GEMINI PARSING — strict 9-line fixed format
// ============================================================
const GEMINI_PROMPT = `Tum ek EXPERT Indian shipping-address specialist ho — bilkul ChatGPT jaise samajhdar. Address ko SAMJHO aur professional courier-label format me RESTRUCTURE karo. Output me SIRF cleaned address lines, kuch aur nahi.

TUMHARI POWER:
- Labels STANDARD karo: Village:/Post Office:/Tehsil:/District:/State — "(v)" = Village, "(nel)" ya "PO" = Post Office, "(D)" ya "Dit"/"Dist" = District.
- Address ko sahi ORDER me jamao: ghar/gali → area → village → post office → tehsil → district → state → pincode → COD → weight.
- 🚨 District / State / Post Office / Tehsil / Village KABHI KHUD SE MAT JODO. Sirf wahi likho jo RAW me pehle se likha hai. Raw me district nahi likha to District ki line MAT BANAO — chhod do. Pincode dekh kar district ka ANDAZA lagana BILKUL MANA hai.
- Raw ki HAR address line output me honi chahiye. Dukan/office/landmark ka naam ("Pushpak Courier Office", "Bharat Petrol Pump") KABHI mat hatao.
- "B.O" / "S.O" / "H.O" (Branch/Sub/Head Office) India Post ka asli hissa hai — "Arniyali B.O", "Dhorimanna S.O" me se ye KABHI mat hatao, jaisa likha hai waisa rakho.
- Jagah ke naam ki spelling sudhar sakte ho (Yazaari Bhongiri → Yadadri Bhuvanagiri) — LEKIN aadmi ka NAAM aur saare NUMBERS kabhi mat badlo.
- KOI BHI bhasha (Hindi/Marathi/Telugu/kuch bhi) → PURA Roman Hinglish. Ek bhi regional akshar nahi.

HATA DO: product lines (Chain/Bali/Anguthi/AGUTHI/BHALI/Rakhdi/Ring/Kada/Galachen + typos), "From ..." lines, baat-cheet ("Hum dalna bhai"), footer (👤 ID / 📦 शिपिंग / ORD #), akela "pin"/"code" label words, akela chhota number (20, 22 = size).
🚨 SENDER/AGENT ka naam ("From X" line ya footer 👤 wala — Devanagari ya Roman kisi bhi script me ho) KABHI bhi landmark nahi banega. "Near <sender ka naam>" jaisa fake landmark MAT BANAO — sender ka naam poori tarah HATA do, address me kahi bhi mat likho, kisi bhi roop me nahi.
Weight/COD/pincode jaisa koi bhi NUMBER agar raw me kahi bhi na mile to KHUD SE mat banao — us line ko chhod do.
RESELLER KA NOTE/COMMENT bhi HATA DO: "रिसेलर ने एड्रेस सुधारा", "address change", "sahi address", "dubara bheja", "update address", "correction" jaisi lines address ka hissa NAHI hai — inhe poori tarah chhod do.
SENDER KA NAAM: "Udaram Siyag", "Ramaram Serdiy", "Laxman Siyag", "Bhomaram", "Dharmi", "Ghanshyam" jaise BHEJNE WALE ka naam address me akela likha ho (bina From ke bhi) to PURA HATA do — ye customer ka address NAHI hai. Use "Near X" landmark KABHI mat banao. "Near" sirf tab likho jab raw me khud "near/ke pass/paas/samne" likha ho — khud se KABHI mat jodo.

FORMAT: Name → Phone(s) alag lines → Address (structured) → State → Pincode → COD (math waise hi, Payment/Pement/Pay/Cash = COD) → Weight ("80g") aakhri.
Numbers (phone/pincode/COD/weight) EXACT copy — weight raw me na ho to KHUD KABHI mat banao (50g apne aap mat likho). Bhejne wale ka naam ("From ..." ya 👤 wala) address me KISI BHI roop me mat aane do — "Near <sender>" jaisa landmark bhi NAHI. Product ka naam (Jhumki/Jumki/Chain) kabhi Village/City mat banao. Missing field ki line PURI TARAH chhod do — "Not Available", "N/A", "District: -" jaisi placeholder line KABHI mat likho. PPD likha ho to sirf "PPD" aakhri line me rakho.

=== EXAMPLE 1 ===
INPUT:
Ashok
9307203119
Gomti Nagar
Lucknow 2lll 391 Viram Khand pin code number  Tahsil Sadar
Lucknow राम भवन चौराहा
226010
Cod 2800
Chain anguthi
80g
From.Ramaram Serdiy

OUTPUT:
Ashok
9307203119
391, Viram Khand
Ram Bhavan Chauraha
Gomti Nagar
Tehsil: Sadar
District: Lucknow
Uttar Pradesh
226010
COD 2800
80g

=== EXAMPLE 2 ===
INPUT:
KANUGU MALLESHAM.
9490557222
(v) Lakkaram
(nel) Choutuppal
(D) Yazaari Bhongiri-
Beside MRR GARDENS
508252
Cod 1800-100=1700
Chain
75g
From.Ramaram Serdiy

OUTPUT:
Kanugu Mallesham
9490557222
Village: Lakkaram
Beside MRR Gardens
Post Office: Choutuppal
District: Yadadri Bhuvanagiri
Telangana
508252
COD 1800-100=1700
75g

=== EXAMPLE 3 ===
INPUT:
विष्णु कुमार शर्मा
9828261505
घंटाघर के पास मेन मार्केट लक्ष्मणगढ़ जिला सीकर pin
332311
Cod 1800-100=1700
Chain
75g
From.Ramaram Serdiy

OUTPUT:
Vishnu Kumar Sharma
9828261505
Ghantaghar Ke Pass, Main Market
Laxmangarh
District: Sikar
Rajasthan
332311
COD 1800-100=1700
75g

=== EXAMPLE 4 (baat wali line → landmark) ===
INPUT:
Sonu Singh Rajput
9928163264
Post office Dedpura
Village Baniya ki ramghra
Dedpura school me mukesh ji narodiya pradhana adeyapak hai
Jila Biyawar
Pin cold 395013
Biti
Cod -1500-100=1400
75g

OUTPUT:
Sonu Singh Rajput
9928163264
Village: Baniya Ki Ramghara
Near Dedpura School (Mukesh Ji Narodiya, Pradhan Adhyapak)
Post Office: Dedpura
District: Beawar
Rajasthan
395013
COD 1500-100=1400
75g

EXTRA RULES:
- Lambi baat-jaisi line jo asal me LANDMARK batati hai ("...school me mukesh ji pradhan adhyapak hai") use HATAO mat — chhota sundar landmark banao: "Near Dedpura School (Mukesh Ji Narodiya, Pradhan Adhyapak)".
- Jila/जिला = District:. Sab kuch saaf Title Case me likho.
- Jagah ki spelling sudharna theek hai (Biyawar → Beawar), lekin aadmi ka naam aur numbers EXACT rakho.

DOHRAV (repeat) ka niyam:
- Agar shahar/gaon ka naam LABEL ke saath likha hai (PO:, Post Office:, Dist:, District:, Village:, Tehsil:) to har label ki line ALAG RAKHO — chahe naam ek jaisa ho. "PO: Sonipat" aur "Dist: Sonipat" DONO rehne do, aur street line ka "Sector 23 Sonipat" bhi waisa hi rakho.
- Sirf tab hatao jab BINA LABEL ke wahi shabd baar-baar aaye ("Sonipat, Sonipat, Sonipat" ya teen alag lines me sirf "Indore") — tab sirf EK rakho.

Ab neeche diye RAW ADDRESS ko EXACT isi tarah clean karo:

RAW ADDRESS:
`;

// MAIN AI: sirf ChatGPT (gpt-4o-mini) — fast, accurate, koi chain nahi
async function geminiParse(rawText) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY set nahi hai");
  const prompt = GEMINI_PROMPT + rawText;
  let out = await callOpenAI(prompt);
  // HINGLISH DOUBLE-CHECK: Devanagari/regional akshar bache ho to ek baar aur sudharwao
  if (/[\u0900-\u0D7F]/.test(out)) {
    try {
      out = await callOpenAI(
        prompt +
          "\n\nDHYAN DO: Pichhle output me Devanagari/regional akshar reh gaye the. PURA output SIRF Roman (English) letters me Hinglish transliterate karke dobara do. Ek bhi Hindi akshar nahi:"
      );
    } catch (e) {
      console.log("Hinglish retry fail:", e.message);
    }
  }
  return out;
}

// ChatGPT gpt-4o-mini
async function callOpenAI(prompt) {
  for (let i = 0; i < 2; i++) {
    const ctrl = new AbortController();
    const tmr = setTimeout(() => ctrl.abort(), 25000);
    let res;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0,
          max_completion_tokens: 600,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tmr);
    }
    if ((res.status === 429 || res.status >= 500) && i < 1) {
      console.log(`OpenAI ${res.status} — 4s wait karke retry...`);
      await sleep(4000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI API error: ${res.status} ${body.substring(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";
    if (!text.trim()) throw new Error("OpenAI se khali jawab aaya");
    return text.replace(/```/g, "").trim();
  }
  throw new Error("OpenAI 429: rate limit");
}

// 📷 Photo se address transcribe (ChatGPT vision)
async function visionTranscribe(imageUrl) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY set nahi hai");
  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), 40000);
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        max_completion_tokens: 600,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Is photo me jo shipping address / order details likhe hai (naam, phone, address, pincode, COD, weight, PPD) unhe EXACT waise hi plain text me utaro, line by line. Kuch explain mat karo, sirf transcription do.",
              },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tmr);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Vision error: ${res.status} ${body.substring(0, 150)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("Photo se kuch nahi padha gaya");
  return text.replace(/```/g, "").trim();
}

// ============================================================
//  1B) REGEX FALLBACK PARSER — Gemini down ho to ye chalega
// ============================================================
// COD ke alag-alag naam jo resellers likhte hai (typos samet)
// 📤 SERDIYA KE JAANE-PEHCHANE SENDERS/RESELLERS — address me akele likhe ho to bhi hatenge
// (Render me SENDER_NAMES env se aur naam jod sakte ho, comma se alag karke)
const KNOWN_SENDERS = [
  "udaram siyag", "ramaram serdiy", "ramaram serdiya", "laxman siyag",
  "bhomaram saran", "dharmi bhandwala", "venaram serdiya", "vena ram",
  "omprakash karwasara", "thakara ram", "jetharam", "prabhu ram",
  "parbhuram choudhary", "mularam verad", "moolaram moolaram",
  "ganesh bhambhu", "lakharam faroda", "chutraram", "ghanshyam",
  ...(process.env.SENDER_NAMES ? process.env.SENDER_NAMES.split(",").map((s) => s.trim().toLowerCase()) : []),
];
function isKnownSender(line) {
  if (/\d/.test(line)) return false;
  const norm = line.replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!norm || norm.split(" ").length > 4) return false;
  return KNOWN_SENDERS.some((s) => norm === s || lev2(norm, s) <= 2);
}

// 💍 PURI JEWELRY PRODUCT LIST (typos samet) — Serdiya ke saare products
const PRODUCT_WORDS_SRC =
  // Chain + saare typos
  "chains?|chen|chan|chin|china|chaina|shain|sikri|sikdi|" +
  // Bali / earrings / jhumka
  "bali|bhali|vali|earring\\w*|earing\\w*|tops|jhum\\w*|jumki|jumka|jhumar|murka|murki|" +
  // Anguthi / ring
  "anguthi|aguthi|aaguthi|anguti|angoothi|anghuthi|anuthi|rings?|challa|chhalla|finger|" +
  // Rakhdi
  "rakhdi|rakhri|rakhi|" +
  // Payal
  "payal|pajeb|payjeb|panjeb|" +
  // Mangalsutra
  "mangalsutra|mangalsutr\\w*|sutra|sutar|sutr|manglsutar\\w*|mglsutar\\w*|mangal|mangl|" +
  "plate|plet|tabij|taweez|tabiz|kavach|kawach|" +
  // Set / combo
  "set|combo|kombo|jodi|" +
  // Galachen
  "galachen|galchen|" +
  // Bracelet / kada / gokhru
  "bracelet|braclet|braslet|breslet|kada|kade|kadda|gokhru|gokharu|gokaru|gokuru|gogru|gogro|chokhar|" +
  // Locket / pendant
  "locket|lockit|laket|loket|locate|choket|pendant|pendal|pendel|pendle|pedals|panel|" +
  // Chudiya / bangles
  "chudi\\w*|churi\\w*|bangdi|bangles?|kangan|kangna|" +
  // Haar / mala / kanthi
  "haar|har|mala|kanthi\\w*|kanti|sohankanthi|" +
  // Nathni
  "nathni|nathiya|nathani|" +
  // Bichiya
  "bichiya|bichhiya|bicchiya|bichudi|" +
  // Waist / arm
  "tagdi|kardhani|kamarband\\w*|bajuband\\w*|baju|" +
  // Mangtika
  "mangtik\\w*|maangtik\\w*|" +
  // Misc jo batches me mile
  "adda|aad|studs|baras|phool|phul|fool|ful|full|long|lung|lunag|loung|zumba|sen|biti|iug|rani|" +
  // Aur products jo baad me mile
  "necklace|neckless|neklace|nekless|necklase|choker|chokar|chokker|" +
  "nosepin|nathiya|anklet|payjeb|armlet|brooch|broch|hathphool|hathphul|" +
  "jewellery|jewelry|jwellery|ornament|item|items|maal|mal";

// Devanagari me likhe product (कड़ा, चेन, अंगूठी...) — inhe bhi hatao
const PRODUCT_DEV_RE = /^(?:\d+\s*)?(?:कड़ा|कडा|कड़े|चेन|चैन|चेइन|अंगूठी|अंगुठी|अँगूठी|बाली|बालि|लॉकेट|लोकेट|माला|हार|पायल|पाजेब|झुमका|झुमकी|झुमर|कंगन|चूड़ी|चुड़ी|ब्रेसलेट|ब्रासलेट|मंगलसूत्र|मंगलसुत्र|रखडी|राखड़ी|राखी|गलचेन|गलाचेन|गोखरू|गोखरु|नथनी|नथ|टागडी|तगड़ी|कमरबंद|बाजूबंद|मांगटीका|कोंबो|कोम्बो|सेट|फुल|फूल|जोड़ी|जोडी|मुरका|कंठी|पेंडल|पेंडेंट)(?:\s|$|[+,\d])/;

// Asli address ke sanket — inme se koi shabd ho to line KABHI product nahi mani jayegi
const ADDRESS_HINT_RE = /\b(road|rd|marg|nagar|nagri|colony|street|gali|chowk|chauraha|circle|bazar|bazaar|market|mandi|mohalla|pura|puram|wadi|vihar|park|complex|society|apartment|tower|plaza|building|niwas|nivas|bhawan|bhavan|sadan|villa|house|makan|plot|flat|room|shop|ward|sector|block|phase|line|near|opp|opposite|behind|samne|pass|paas|village|vill|gaon|gram|post|po|dist|district|jila|tehsil|tahsil|teh|taluka|taluk|city|state|station|stand|bus|depot|school|college|vidyalay\w*|shala|hospital|clinic|medical|temple|mandir|masjid|church|gurudwara|bank|atm|petrol|pump|hotel|dhaba|restaurant|garden|chakki|store|stor|agency|office|factory|godown|godam|farm|dairy|tanki|talab|nadi|pul|bridge|highway|nh|sh|bypass|main|new|old|purana|naya|auto|mobile|motor|cycle|tyre|hardware|electric|electronics|furniture|marble|granite|cement|steel|iron|glass|paint|tiles|sanitary|kirana|karyana|general|provision|super|mart|super\s*market|sweet|mishthan|bhandar|namkeen|bakery|cafe|tea|chai|juice|dairy|milk|gas|cylinder|salon|parlour|parlor|beauty|cloth|garment|readymade|fashion|footwear|shoe|jewell?er|opticals?|computer|mobil|photo|studio|press|xerox|stationery|book|toy|gift|sports|hard\s*ware|traders?|trading|enterprises?|industries|udyog|company|pvt|ltd|centre|center|point|palace|residency|heights|enclave|estate|corner|junction|crossing|naka|phatak|tiraha|mata|devi|maharaj|baba|swami|guru|shri|shree|sri|sant|dev)\b/i;

const PRODUCT_LINE_RE = new RegExp(
  `^(?:${PRODUCT_WORDS_SRC})\\b(?!\\s+(?:road|marg|nagar|chowk|chauraha|gali|colony|street|bazar|bazaar|market|mohalla|pura|puram|wadi|park|vihar|complex|mandi|gaon|gram|niwas|bhawan|sadan|villa|house|society|apartment))`,
  "i"
);
// Sirf ASLI product words (qty/unit words alag hai)
const PRODUCT_ONLY_RE = new RegExp(`^(?:${PRODUCT_WORDS_SRC})\\.?$`, "i");

// KAMZOR product-shabd: ye PATE me bhi aate hai, isliye in par line nahi hatai jaati
//   "Netarhat Awasiya Vidyalay 5th SET"   → asli pata (set = kamzor)
//   "Hanuman Sagar Bhart MALA Rajvada"    → asli pata (mala = kamzor)
//   "Lamkhede MALA", "Sundar SEN Colony"  → asli naam
// PAKKE shabd (chain, jhumar, mangalsutra, anguthi...) pate me kabhi nahi aate,
// isliye wo line me kahi bhi dikhe to line product hai.
// Inme wo naam bhi hai jo ASLI JAGAH ke hai:
//   Bali (tehsil, Pali), Payal (shahar, Punjab), Kada (Kaushambi), Kanthi (W.B.),
//   Sikri (Fatehpur Sikri), Challa, Baras — in par line kabhi nahi hategi.
const WEAK_PRODUCT_RE =
  /^(?:set|combo|kombo|jodi|full|long|lung|lunag|loung|rani|sen|biti|iug|adda|aad|plate|plet|mala|har|baju|phool|phul|fool|ful|panel|finger|item|items|maal|mal|chokhar|china|chaina|bali|bhali|vali|kada|kade|sikri|challa|chhalla|baras|kanti|kanthi|mangal|mangl|rakhi|rakhri|rakhdi|murki|murka|chan|chin|chen|payal|nathani)\.?$/i;
const isStrongProduct = (t) => PRODUCT_ONLY_RE.test(t) && !WEAK_PRODUCT_RE.test(t);

// Bharatiya gaon/shahar ke naam ke PICHHLE hisse. "Kanti KHERI", "Payal VIHAR",
// "Mangal PURA" — ye JAGAH hai, gehna nahi. Isi se "Rani Hot" / "Mangal Sutra"
// (asli product) alag pehchane jate hai.
const PLACE_SUFFIX_RE =
  /(?:pur|pura|puri|kheri|khera|garh|gadh|wadi|vadi|wada|vada|vas|was|sar|gaon|ganv|abad|nagar|nagri|palli|halli|patti|tola|tanda|bagh|khurd|kalan|dhani|bera|vihar|ser|nada|wala|wali)$/i;
const looksLikePlace = (s) =>
  s.split(/[\s,]+/).some((w) => w.length >= 4 && PLACE_SUFFIX_RE.test(w));
// Qty/unit words — ye AKELE product nahi hai ("SURVEY NO. 70" me "NO." product nahi)
const QTY_TOKEN_RE = /^(?:pc|pcs|pec|pics?|piece|pis|ps|pair|size|saze|no|nag|ng|gm|inch)\.?$/i;
const PRODUCT_TOKEN_RE = new RegExp(
  `^(?:${PRODUCT_WORDS_SRC}|pc|pcs|pec|pics?|piece|pis|ps|pair|size|saze|no|nag|ng|gm|inch)\\.?$`,
  "i"
);

// ============================================================
//  RAW NORMALIZER — 1200+ addresses se seekhe saare bigde format
//  (COD ke 12 roop, space/comma wale phone, weight variants)
// ============================================================
// ============================================================
//  DEVANAGARI → HINGLISH (code-level fallback)
//  AI fail/skip ho jaye to bhi Hindi kabhi Sheet me na jaye
// ============================================================
const DEV_MAP = {
  // Swar (independent vowels)
  "अ":"a","आ":"aa","इ":"i","ई":"ee","उ":"u","ऊ":"oo","ऋ":"ri","ए":"e","ऐ":"ai","ओ":"o","औ":"au",
  "ॲ":"a","ऑ":"o","ऍ":"e","ऎ":"e","ऒ":"o","ॠ":"ri","ऌ":"li","ॡ":"li","ॐ":"om",
  // Vyanjan
  "क":"k","ख":"kh","ग":"g","घ":"gh","ङ":"n",
  "च":"ch","छ":"chh","ज":"j","झ":"jh","ञ":"n",
  "ट":"t","ठ":"th","ड":"d","ढ":"dh","ण":"n",
  "त":"t","थ":"th","द":"d","ध":"dh","न":"n",
  "प":"p","फ":"ph","ब":"b","भ":"bh","म":"m",
  "य":"y","र":"r","ल":"l","व":"v","ळ":"l",
  "श":"sh","ष":"sh","स":"s","ह":"h",
  "क़":"q","ख़":"kh","ग़":"g","ज़":"z","ड़":"r","ढ़":"rh","फ़":"f","य़":"y",
  // Matra (dependent vowels)
  "ा":"a","ि":"i","ी":"ee","ु":"u","ू":"oo","ृ":"ri","े":"e","ै":"ai","ो":"o","ौ":"au","ॉ":"o","ॅ":"a",
  // Chihn
  "ं":"n","ँ":"n","ः":"h","्":"","़":"","ऽ":"",
  // Ank
  "०":"0","१":"1","२":"2","३":"3","४":"4","५":"5","६":"6","७":"7","८":"8","९":"9",
};

function devToHinglish(text) {
  if (!/[\u0900-\u097F]/.test(text)) return text;
  const CONS = "कखगघङचछजझञटठडढणतथदधनपफबभमयरलवळशषसहक़ख़ग़ज़ड़ढ़फ़य़";
  const MATRA = "ािीुूृेैोौॉॅ";
  const VOWEL = "अआइईउऊऋएऐओऔऑॲऍऎऒॠऌॡ";

  // Har Devanagari shabd ko alag-alag transliterate karo
  return text.replace(/[\u0900-\u097F]+/g, (word) => {
    const ch = [...word];
    const syl = []; // { c: vyanjan-dhwani, v: swar-dhwani, nasal: bool, inherent: bool }
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (CONS.includes(c)) {
        const s = { c: DEV_MAP[c] || "", v: "a", nasal: false, inherent: true };
        let j = i + 1;
        if (ch[j] === "़") j++; // nukta
        if (ch[j] === "्") { s.v = ""; s.inherent = false; i = j; }
        else if (MATRA.includes(ch[j])) { s.v = DEV_MAP[ch[j]] || ""; s.inherent = false; i = j; }
        // anusvara / chandrabindu vowel ke BAAD aata hai
        let k = i + 1;
        while (ch[k] === "ं" || ch[k] === "ँ") { s.nasal = true; i = k; k++; }
        if (ch[k] === "ः") { s.v += "h"; i = k; }
        syl.push(s);
      } else if (VOWEL.includes(c)) {
        const s = { c: "", v: DEV_MAP[c] || "", nasal: false, inherent: false };
        let k = i + 1;
        while (ch[k] === "ं" || ch[k] === "ँ") { s.nasal = true; i = k; k++; }
        syl.push(s);
      } else if (MATRA.includes(c) || c === "ं" || c === "ँ" || c === "ः" || c === "्" || c === "़" || c === "ऽ") {
        continue; // akela matra — chhod do
      } else {
        syl.push({ c: DEV_MAP[c] !== undefined ? DEV_MAP[c] : c, v: "", nasal: false, inherent: false });
      }
    }

    // --- SCHWA DELETION (Hindi ka asli niyam) ---
    // 1) Shabd ke aakhir ka inherent "a" hamesha hatao (Ram, na ki Rama)
    for (let i = syl.length - 1; i >= 0; i--) {
      if (syl[i].c) { if (syl[i].inherent && !syl[i].nasal) syl[i].v = ""; break; }
    }
    // 2) Beech ka inherent "a" hatao jab dono taraf swar ho (Jodhpur, na ki Jodhapur)
    for (let i = 1; i < syl.length - 1; i++) {
      if (!syl[i].inherent || syl[i].nasal || !syl[i].c) continue;
      const prevHasVowel = syl[i - 1].v && syl[i - 1].v !== "";
      const nextHasVowel = syl[i + 1].v && syl[i + 1].v !== "";
      if (prevHasVowel && nextHasVowel) syl[i].v = "";
    }

    let out = "";
    for (const s of syl) out += s.c + s.v + (s.nasal ? "n" : "");
    // Indian address style: "ee"→"i", "oo"→"u" (Churu, Dhule, Tahsil — na ki Chooroo)
    out = out.replace(/ee/g, "i").replace(/oo/g, "u");
    // "ड़" wala "d" aksar "r" bolte hai (Barmer, na ki Badamer)
    return out.replace(/([a-z])\1{2,}/gi, "$1$1");
  });
}

// Har line ko Title Case me (Hinglish output saaf dikhe)
function titleCaseHinglish(text) {
  return text
    .split("\n")
    .map((l) =>
      l.replace(/\b([a-z])([a-z']*)/g, (m, a, b) => a.toUpperCase() + b)
    )
    .join("\n");
}

function normalizeRaw(raw) {
  let t = raw;

  // --- PHONE: space se toota number jodo ---
  t = t.replace(/(?<!\d)((?:\+?91[\s-]?)?[6-9]\d{4})\s+(\d{5})(?!\d)/g, (m, a, b) => a.replace(/\s/g, "") + b);
  t = t.replace(/(?<!\d)([6-9]\d{3})\s+(\d{6})(?!\d)/g, "$1$2");
  t = t.replace(/(?<!\d)([6-9]\d{5})\s+(\d{4})(?!\d)/g, "$1$2");
  // --- PHONE: comma se jude do number alag lines pe ---
  t = t.replace(/(?<!\d)([6-9]\d{9})\s*,\s*([6-9]\d{9})(?!\d)/g, "$1\n$2");

  // --- COD: har bigda roop ek jaisa ---
  // "COD" label ke baad amount agli line pe ho to jod do
  t = t.replace(/^\s*(cod|c\.?o\.?d\.?|payment|pement|iug)\s*:?\s*$\n\s*([\d,]+(?:\s*[-=]\s*[\d,]+)*)/gim, "COD $2");
  // ₹ symbol, colon, extra "=" hatao
  // (?![A-Za-z]) zaruri hai — warna "Pin code" ka "cod" bhi COD ban jata tha.
  // Lekin digit chalega, taaki "COD1500" bhi pakda jaye.
  t = t.replace(/(?<![A-Za-z])(cod|c\.o\.d\.?|payment|pement|pyment)(?![A-Za-z])\s*[.:=-]*\s*₹?\s*/gi, "COD ");
  // Bina label ke sirf paisa: "₹1000=100=900" / "Rs. 1500" / "INR 1500" → COD maan lo
  // (₹/Rs ke turant baad digit ho tabhi — "Rsingh" jaisa naam safe)
  t = t.replace(/^[ \t]*(?:₹|rs\.?|inr)[ \t]*(?=[\d,])/gim, "COD ");
  // "1500=100=1400" → "1500-100=1400"   |   "1500-100-1400" → "1500-100=1400"
  t = t.replace(/(COD\s+[\d,]+)\s*=\s*([\d,]+)\s*=\s*([\d,]+)/gi, "$1-$2=$3");
  t = t.replace(/(COD\s+[\d,]+)\s*-\s*([\d,]+)\s*-\s*([\d,]+)/gi, "$1-$2=$3");
  t = t.replace(/(COD\s+[\d,]+)\s*-\s*([\d,]+)\s*[.]\s*([\d,]+)/gi, "$1-$2=$3");
  t = t.replace(/(COD\s+[\d,]+\s*-\s*[\d,]+\s*=)\s*-\s*([\d,]+)/gi, "$1$2");
  // COD line ke numbers se comma hatao (1,400 → 1400)
  t = t.replace(/^(COD[^\n]*)$/gim, (m) => m.replace(/(\d),(\d)/g, "$1$2"));
  // COD ke aas-paas ke extra space saaf
  t = t.replace(/^COD\s+([\d]+)\s*-\s*([\d]+)\s*=\s*([\d]+)\s*$/gim, "COD $1-$2=$3");

  // --- WEIGHT: 54gm / 75 gm / 75G / 100gms → 54g ---
  t = t.replace(/(?<=\d)\s*(gms?|grams?|G)\b/g, "g");

  return t;
}

const COD_WORDS = "cod|c\\.?o\\.?d\\.?|payment|pement|pyment|paymet|paymnt|pymt|pymet|peyment|pay|cash|amount|total|rate";

// ============================================================
//  FORMAT ENFORCER — output ka order HAMESHA fix rahe:
//  Name → Phone(s) → Address lines → (State) → Pincode → COD → Weight
// ============================================================
function enforceFormat(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const phones = [], addr = [];
  let pin = "", cod = "", wt = "";
  for (const l of lines) {
    if (/^[6-9]\d{9}$/.test(l)) { phones.push(l); continue; }
    if (/^\d{6}$/.test(l)) { if (!pin) pin = l; else addr.push(l); continue; }
    if (/^COD\s+[\d,]/i.test(l)) { if (!cod) cod = l; else addr.push(l); continue; }
    const wm = l.match(/^(\d+)\s*g(m|ms|ram|rams)?\.?$/i);
    if (wm) { if (!wt) wt = wm[1] + "g"; else addr.push(wm[1] + "g"); continue; }
    addr.push(l);
  }
  const name = addr.shift() || "";
  // S/O, W/O, D/O (son/wife/daughter of) naam ki pehchaan ka hissa hai — phone se PEHLE,
  // naam ke saath rakho. (Slash zaruri: "KHICHAN S.O" = Sub Office, wo address me hi rahega.
  //  C/O = care of, wo bhi address me hi rahega.)
  const relation = [];
  while (addr.length && /^(?:[SWD]\s*\/\s*[O0]\b|son\s+of\b|wife\s+of\b|daughter\s+of\b)/i.test(addr[0])) {
    relation.push(addr.shift());
  }
  return [name, ...relation, ...phones, ...addr, pin, cod, wt].filter(Boolean).join("\n");
}

// NOTE (v7.2): India Post pincode-verification poora HATA diya gaya hai.
// Reseller jo pincode likhe wahi final — bot koi suggestion/warning nahi deta.

// AI output me state missing ho to pincode se add karo (waisa hi jaisa regex karta hai)
function ensureStateLine(text) {
  return text; // State/District bot khud se add nahi karta (sirf reseller ka likha rahega)
  /* eslint-disable */
  const out = text.split("\n");
  const pinLine = out.find((l) => /^\d{6}$/.test(l.trim()));
  if (!pinLine) return text;
  const opts = PIN_STATE[parseInt(pinLine.trim().substring(0, 2))] || [];
  const mila = opts.some((s) =>
    s.toLowerCase().split(/\s+/).some((w) => w.length >= 3 && text.toLowerCase().includes(w))
  );
  if (!mila && opts.length === 1) {
    const idx = out.findIndex((l) => l.trim() === pinLine.trim());
    out.splice(idx, 0, opts[0]);
  }
  return out.join("\n");
  /* eslint-enable */
}

// AI ne regex-cleaned address ka koi word to nahi kha liya? (data-loss check)
// Sirf ASCII words check hote hai (Hindi→Hinglish transliteration me Hindi tokens skip)
// Chhota edit-distance (spelling sudhaar pakadne ke liye): 2 tak ka farak = wahi word
function lev2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
    if (Math.min(...prev) > 2) return 3; // jaldi nikal jao
  }
  return prev[n];
}

function aiMissingWords(regexCleaned, aiCleaned) {
  const aiLow = aiCleaned.toLowerCase();
  const aiWords = aiLow.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const skip = new Set(["near","pass","post","dist","city","vill","state","tahsil","tehsil","house","distrik","district","village","jila","jilla","teshi","tahshil","tehshil","distt","distic","gaon","gram","mohalla","ward","street","circle","chowk"]);
  const isProductWord = (t) => PRODUCT_TOKEN_RE.test(t);
  const missing = [];
  const isStateLine = (s) =>
    Object.values(PIN_STATE).some((arr) => arr.some((st) => st.toLowerCase() === s.trim().toLowerCase()));
  for (const line of regexCleaned.split("\n")) {
    if (/^COD\s/i.test(line) || /^[6-9]\d{9}$/.test(line) || /^\d{6}$/.test(line) || /^\d+g$/i.test(line)) continue;
    if (isStateLine(line)) continue; // state regex ne khud add kiya tha — AI pe iska ilzaam nahi
    for (const tok of line.split(/[^A-Za-z]+/)) {
      if (tok.length < 4) continue;
      if (skip.has(tok.toLowerCase())) continue;
      if (isProductWord(tok)) continue; // product word AI ne hataya = SAHI kiya
      const tokL = tok.toLowerCase();
      const mila = aiLow.includes(tokL) || aiWords.some((w) => lev2(w, tokL) <= 2); // spelling-sudhaar = wahi word
      if (!mila) missing.push(tok);
    }
  }
  return [...new Set(missing)];
}

// Bhejne wale (From/👤) ka naam AI ne address me ghusa diya ho ("Near Udaram Siyag") to line hatao
function scrubSenderFromCleaned(cleanedText, rawText) {
  const senders = []; // Roman/English sender-name pieces (footer Devanagari ho to yahan nahi aayega)
  for (const l of rawText.split("\n")) {
    // 👤 footer — poora naam (Devanagari ho ya Roman, dono capture)
    const m = l.match(/^👤\s*(.+?)\s*\(ID:/u);
    if (m) {
      const n = m[1].replace(/[^\p{L}\p{N}@_\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
      if (n.length > 5) senders.push(n);
      // Footer me @username ho (Roman/ASCII hamesha) to wo bhi pakdo — cross-script gap bharta hai
      const um = l.match(/@([A-Za-z0-9_]{4,})/);
      if (um) senders.push(um[1].toLowerCase().replace(/_/g, " "));
    }
    // "From X" — lenient: line ke aakhir tak strict match nahi, jo bhi Roman naam mile le lo
    const fm = l.match(/^(?:from|form|forum|frm|fram|frome|froam|farom)\b\s*[.:\-]?\s*([A-Za-z][A-Za-z\s]{2,40})/i);
    if (fm) {
      const n = fm[1].replace(/\s+/g, " ").trim().toLowerCase();
      if (n.length > 3) senders.push(n);
    }
    // "From" akela likha ho aur NAAM agli line par ho ("From\nUdaram siyag") — dono lines jodo
  }
  // "From" akela line + agli line naam wali — do-line pattern bhi pakdo
  const rawLines = rawText.split("\n").map((l) => l.trim());
  for (let i = 0; i < rawLines.length - 1; i++) {
    if (/^(from|form|forum|frm|fram)\.?$/i.test(rawLines[i])) {
      const nxt = rawLines[i + 1];
      if (/^[A-Za-z][A-Za-z\s]{2,40}$/.test(nxt)) senders.push(nxt.toLowerCase().trim());
    }
  }

  if (!senders.length) return { text: cleanedText };
  let removed = null;
  const outLines = cleanedText.split("\n").filter((l, i) => {
    if (i === 0) return true; // customer ka naam kabhi mat chhedo
    const low = l.replace(/^near\s+/i, "").toLowerCase().trim(); // "Near Udaram Siyag" → "udaram siyag"
    const words = low.split(/\s+/).filter((w) => w.length >= 4);
    const hit =
      words.length > 0 &&
      senders.some((s) => {
        const sWords = s.split(/\s+/).filter((w) => w.length >= 4);
        if (!sWords.length) return low.includes(s);
        // Kam se kam 70% words match ho (fuzzy, order/spelling farak chalega)
        const matchCount = words.filter((w) => sWords.some((sw) => sw === w || lev2(sw, w) <= 2)).length;
        return matchCount / words.length >= 0.7 || matchCount / sWords.length >= 0.7;
      }) &&
      l.split(/\s+/).length <= 6;
    if (hit) removed = l.trim();
    return !hit;
  });
  return { text: outLines.join("\n"), removed };
}

// AI ne District galat likha ho to India Post ke hisab se theek karo
function fixDistrictLine(cleanedText, correctDistrict) {
  // Bot ab District KHUD nahi badlega — sirf batayega ki reseller ka District pincode se mel nahi khata
  const m = cleanedText.match(/^district\s*:\s*(.+)$/im);
  if (!m) return { text: cleanedText };
  const cur = m[1].trim();
  if (cur.toLowerCase() === correctDistrict.toLowerCase() || lev2(cur.toLowerCase(), correctDistrict.toLowerCase()) <= 2) {
    return { text: cleanedText };
  }
  return { text: cleanedText, mismatch: cur }; // text NAHI badla — sirf mismatch flag
}

// 🚨 GADHA HUA WEIGHT hatao — output ka "Ng" raw me hona HI chahiye.
//    (Kabhi AI/koi aur 150g jaisa number bana deta hai jo raw me hai hi nahi)
function stripFakeWeight(text, rawText) {
  const rawDigits = rawText.replace(/[\s\-,.]/g, "");
  let removed = null;
  const out = text.split("\n").filter((line) => {
    const m = line.trim().match(/^(\d{1,4})\s*g$/i);
    if (!m) return true;
    const num = m[1];
    // Raw me ye number "Ng"/"Ngm" ke roop me ya akela khada hona chahiye
    const okAsWeight = new RegExp(`(?<!\\d)${num}\\s*(?:g|gm|gms|gram)`, "i").test(rawText);
    // Raw ki kisi line pe akela number khada ho ("20") — wo bhi asli weight hai
    const okAlone = rawText.split("\n").some((r) => r.trim() === num);
    if (okAsWeight || okAlone) return true;
    removed = line.trim();
    return false; // raw me hai hi nahi → GADHA hua → HATAO
  });
  return { text: out.join("\n"), removed };
}

// 🚨 AI ne KHUD SE District/State/Post Office/Tehsil gadha to hatao.
//    Rule: label ka naam raw me (ya uske Hinglish roop me) hona HI chahiye.
function stripFabricatedLabels(aiText, rawText) {
  // Raw ko Roman me laao taaki Hindi likha naam bhi match ho jaye
  const rawHing = (devToHinglish(rawText) + " " + rawText).toLowerCase();
  const rawWords = rawHing.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const removed = [];

  const out = aiText.split("\n").filter((line) => {
    const m = line.match(
      /^\s*(district|dist|jila|jilla|state|post\s*office|p\.?o|tehsil|tahsil|teh|taluka|taluk|village|vill|gaon|city)\s*[:\-]\s*(.+)$/i
    );
    if (!m) return true;
    const value = m[2].trim();
    // Har asli shabd (3+ akshar) raw me hona chahiye — warna ye AI ka banaya hua hai
    const words = value.split(/[^A-Za-z]+/).filter((w) => w.length >= 3);
    if (!words.length) return true;
    const mila = words.every((w) => {
      const wl = w.toLowerCase();
      return rawHing.includes(wl) || rawWords.some((rw) => lev2(rw, wl) <= 2);
    });
    if (!mila) {
      removed.push(line.trim());
      return false; // raw me hai hi nahi → AI ne gadha → HATAO
    }
    return true;
  });

  return { text: out.join("\n"), removed };
}

// AI ne kaunsi PURI LINES hata di? (wapas jodne ke liye) + kaunse akele words badle (warning ke liye)
// Line RESTORE hogi jab uske 60%+ asli words gayab ho aur kam se kam 2 words ho
function aiMissingLines(regexCleaned, aiCleaned) {
  const aiLow = aiCleaned.toLowerCase();
  const aiWords = aiLow.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const skip = new Set(["near","pass","post","dist","city","vill","state","tahsil","tehsil","house","distrik","district","village","jila","jilla","teshi","tahshil","tehshil","distt","distic","gaon","gram","mohalla","ward","street","circle","chowk",
    // Label typos + junk jo AI theek/hata karta hai — inhe "loss" mat samjho
    "tashil","tahshil","dict","stade","stad","still","single","vpo","opp","behind","samne","near","road","marg"]);
  const isProductWord = (t) => PRODUCT_TOKEN_RE.test(t);
  const isStateLine = (s) =>
    Object.values(PIN_STATE).some((arr) => arr.some((st) => st.toLowerCase() === s.trim().toLowerCase()));
  // Gibberish/junk word? Asli Indian jagah ke naam me thik-thak vowel hote hai
  const looksGibberish = (t) => {
    const tl = t.toLowerCase();
    const vowels = (tl.match(/[aeiou]/g) || []).length;
    if (vowels === 0) return true; // RHAJGR, STADE — koi vowel nahi
    if (tl.length >= 5 && vowels / tl.length < 0.25) return true; // bahut kam vowel = gibberish
    if (/^[bcdfghjklmnpqrstvwxyz]{4,}$/i.test(t)) return true;
    return false;
  };
  const words = [];
  const lines = [];
  for (const line of regexCleaned.split("\n")) {
    if (/^COD\s/i.test(line) || /^[6-9]\d{9}$/.test(line.trim()) || /^\d{6}$/.test(line.trim()) || /^\d+g$/i.test(line.trim())) continue;
    if (isStateLine(line)) continue;
    // Line me product ka "+" pattern ho (Sohankanthi+Tevti+Galachen) to product hai — skip
    if (/\+/.test(line) && line.split("+").length >= 2) continue;
    const sig = [];
    const miss = [];
    for (const tok of line.split(/[^A-Za-z]+/)) {
      if (tok.length < 4) continue;
      const tl = tok.toLowerCase();
      if (skip.has(tl) || isProductWord(tok) || looksGibberish(tok)) continue;
      sig.push(tok);
      const mila = aiLow.includes(tl) || aiWords.some((w) => lev2(w, tl) <= 2);
      if (!mila) miss.push(tok);
    }
    if (!miss.length) continue;
    // WARNING (wapas nahi jodte): aadhi+ line gayab AUR ek BADA (6+ akshar) asli-jaisa word gaya ho
    if (sig.length >= 2 && miss.length / sig.length >= 0.5 && miss.some((t) => t.length >= 6)) {
      lines.push(line.trim());
    } else {
      for (const t of miss) {
        if (t.length >= 6) lines.push(t);
        else words.push(t);
      }
    }
  }
  return { words: [...new Set(words)], lines: [...new Set(lines)] };
}

// Hatai gayi lines ko AI output me wapas jodo — naam+phone ke THEEK BAAD (address block ke shuru me)
function restoreLines(aiCleaned, missingLines) {
  const out = aiCleaned.split("\n");
  let idx = 1;
  while (idx < out.length && /^[6-9]\d{9}$/.test(out[idx].trim())) idx++;
  out.splice(idx, 0, ...missingLines);
  return out.join("\n");
}

// Pehli line me naam ke saath address chipka hua lag raha hai?
// (4 se zyada words ya 35+ characters = mila hua, AI se alag hoga)
function naamMashed(cleanedText) {
  const first = (cleanedText.split("\n")[0] || "").trim();
  return first.split(/\s+/).length > 4 || first.length > 35;
}

function regexParse(rawText) {
  rawText = normalizeRaw(rawText); // saare bigde COD/phone/weight format pehle theek

  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];

  // Footer 👤 lines se sender ke naam nikaalo (bina "From" wali naam lines hatane ke liye)
  const senderNames = [];
  for (const l of lines) {
    const m = l.match(/^👤\s*(.+?)\s*\(ID:/u);
    if (m) {
      const n = m[1].replace(/[^\p{L}\p{N}@_\s]/gu, "").trim().toLowerCase();
      if (n) senderNames.push(n);
    }
  }

  for (let l of lines) {
    // --- JUNK LINES HATAO ---
    if (/🔔|order book|@serdiya/i.test(l)) continue;                        // boilerplate
    if (/^(from|form|forum|frm|fram|frome|froam|farom)\b\s*[.:\-]?\s*\S/i.test(l)) continue; // From X / Form.Dharmi / Forum khetaram / FROM - X
    if (/^[👤📦🚚💰]|शिपिंग|\bORD\s*#|\(ID:\s*\d+\)/iu.test(l)) continue;     // Margin bot footer
    // Product lines — lekin PEHLI line (customer ka naam: "Bali Ram", "Rakhi Devi") kabhi nahi hategi
    // Line PAKKE product shabd se shuru ho tabhi hatao. KAMZOR shabd se shuru hone wali
    // line ("Kanti Kheri", "Mangal Kheri", "Payal Vihar") ASLI JAGAH ka naam hai —
    // use neeche wala toks-wala niyam dekhta hai.
    {
      const w1 = (l.split(/[\s,.:]+/)[0] || "").replace(/[^\p{L}\p{N}]/gu, "");
      // PAKKE product se shuru → hatao. KAMZOR se shuru → tabhi hatao jab line
      // JAGAH jaisi na lage ("Rani Hot" hatega, "Kanti Kheri" bachega).
      if (out.length > 0 && PRODUCT_LINE_RE.test(l) && !ADDRESS_HINT_RE.test(l) &&
          (isStrongProduct(w1) || !looksLikePlace(l))) continue;
    }
    if (out.length > 0 && PRODUCT_DEV_RE.test(l)) continue; // कड़ा / चेन / अंगूठी jaisi Devanagari product line
    // "Sohankanthi+Tevti+Galachen" jaisi + wali combo line — koi bhi hissa product ho to poori line product hai
    if (out.length > 0 && /\+/.test(l) && l.split("+").length >= 2 &&
        l.split("+").some((part) => PRODUCT_TOKEN_RE.test(part.trim()) || PRODUCT_LINE_RE.test(part.trim()))) continue;
    // "Village: Jumki" jaisi galti — label ke saath product ka naam = poori line hatao
    {
      const lv = l.match(/^(?:village|vill\.?|post\s*office|po|tehsil|tahsil|city)\s*[:\-]\s*(.+)$/i);
      if (lv && PRODUCT_TOKEN_RE.test(lv[1].trim())) continue;
    }
    // "1 Chain 3 anguthi 1 kada" jaisi quantity+product lines — saare words digit/product ho aur kam se kam 1 product word ho
    // 🛡️ LABEL wali line (PO / Vill / Teh / Dist / Ward / Plot...) ASLI PATA hai —
    //    use product samajh kar kabhi mat hatao. "Tashil: Bali", "Dist Kanthi",
    //    "Vill Kada", "Teh Payal" — ye sab jagah ke naam hai, gehna nahi.
    //    (Reseller galti se "Village: Jumki" likhe — wo upar wala alag niyam pakadta hai)
    const ADDR_LABEL_RE =
      /^(?:po|vpo|v\.?\s*p\.?\s*o|post|post\s*office|vill|village|gram|gav|gaon|ganv|mu|mukam|teh|tehsil|tahsil|tashil|taluka|taluk|dist|distt|district|jila|jilla|zila|city|via|vaya|ward|plot|house|h\.?\s*no|flat|shop|room|sector|near|opp|opposite|behind)\b[\s:.\-–—]/i;
    if (out.length > 0 && !ADDR_LABEL_RE.test(l)) {
      // "1pis Mangalsutra" / "2pcs Chain" / "1pc Bali" — number aur unit JUDE hue ho to alag karo.
      // (ye sirf PEHCHAN ke liye hai — line ka asli text kabhi nahi badalta)
      // "gm/g" JAAN-BOOJH KAR bahar hai — warna weight line (75g) product samajh li jati.
      const splitGluedQty = (t) => {
        const g = t.match(/^(\d{1,3})\s*((?:pcs|pc|pec|pics|pic|piece|pis|ps|pair|nag|ng|no|inch|jodi|set)\.?)$/i);
        return g ? [g[1], g[2]] : [t];
      };
      const toks = l.split(/[\s,+()\-]+/).filter(Boolean).flatMap(splitGluedQty);
      const isProd = (t) => PRODUCT_TOKEN_RE.test(t);
      // (a) Poori line sirf product + number ho: "1 Chain 3 anguthi"
      if (toks.length && toks.some(isProd) && toks.every((t) => /^\d+$/.test(t) || isProd(t))) continue;

      // (b) Brand/devta + product: "Balaji locate 2 Pc", "Hanuman Ji pendal", "Chain Balaji locket"
      //     Rule: line CHHOTI ho, usme product word ho, aur koi ADDRESS-shabd na ho.
      // Sirf tab hatao jab line ka BADA hissa product ho (>=50% words), warna
      // "Lamkhede mala" / "Sundar sen colony" jaise ASLI naam kat jate hai
      const prodCount = toks.filter((t) => PRODUCT_ONLY_RE.test(t) || QTY_TOKEN_RE.test(t)).length;
      const looksLikeAddress = ADDRESS_HINT_RE.test(l) || /\d{5,}/.test(l);
      // Product line ka pattern: (a) 50%+ words product ho, YA
      // (b) line PRODUCT ya brand+product se SHURU ho ("Hanuman Ji pendal", "Balaji locate")
      // "Lamkhede mala" jaise naam bache rahe — kyunki product word AAKHIR me hai
      // "NO." / "PC" jaise qty-words se line product nahi banti ("SURVEY NO. 70" safe)
      const isRealProd = (t) => PRODUCT_ONLY_RE.test(t);
      // Devta/brand ka naam + product ("Balaji Plate", "Hanuman Locket") — ye product line hai.
      // ("Balaji Mandir", "Shyam Nagar" me address-shabd hai isliye wo pehle hi safe hai)
      const DEITY = /^(balaji|hanuman|ramdev|ramdevji|shyam|khatu|krishna|ganesh|shiv|shiva|radha|sai|tirupati|bhomiya|nakoda|salasar|mata|maa|devi|baba|shree|shri|sri|ad|a\.d|gold|golden|silver|german|oxidised|oxidized|brass|copper|cz|kundan|meena|antique|forming|victorian|matt|matte|plated|fancy|premium|heavy|light|rose|rosegold)$/i;
      // "Balaji Locate 2 Pc" / "Hanuman Ji Pendal" jaisi line = devta/brand + product + qty.
      // Aisi line me HAR shabd ya to devta/brand ho, ya product, ya ginti —
      // tabhi wo product line hai.
      //
      // ⚠️ PEHLE sirf itna tha ki "koi bhi product shabd baad me aa jaye" to line udd jati thi.
      //    Usse "Netarhat Awasiya Vidyalay 5th Set" jaisa ASLI PATA kat gaya tha
      //    (sirf "Set" ki wajah se). Ab baaki shabd bhi dekhe jate hai.
      const harmless = (t) =>
        isRealProd(t) || QTY_TOKEN_RE.test(t) || DEITY.test(t) ||
        /^(?:ji|wala|wali|ka|ki|ke|aur|and|\+|&)$/i.test(t) ||
        /^\d+(?:st|nd|rd|th)?$/i.test(t) || /^\d+g$/i.test(t); // "Adda 110g" ka weight
      // Do PAAS-PAAS ke shabd JOD kar product ban jaye → wo product line hai.
      //   "Sohan Kanthi" → sohankanthi | "Mangal Sutra" → mangalsutra
      //   "Gala Chen" → galachen       | "Nose Pin" → nosepin
      // ("Kanti Kheri" → kantikheri — vocabulary me nahi, isliye JAGAH hi rahegi)
      const joinedProduct = toks.some(
        (t, i) => i + 1 < toks.length && isStrongProduct(t + toks[i + 1])
      );
      const startsProduct =
        joinedProduct ||
        // PAKKE product se shuru ("Chain Balaji locket")
        isStrongProduct(toks[0]) ||
        // AKELA product shabd ("Chain", "Adda", "Set")
        (toks.length === 1 && isRealProd(toks[0])) ||
        // PAKKA product shabd kahi bhi (chain, jhumar, anguthi...) → line product hai
        (toks.length >= 2 && toks.slice(1).some(isStrongProduct)) ||
        // KAMZOR shabd (set, mala, har...) → tabhi product jab BAAKI sab shabd bhi
        // devta/brand/ginti ho. Warna "Netarhat Awasiya Vidyalay 5th Set" bach jaye.
        (toks.length >= 2 && toks.some(isRealProd) && toks.every(harmless));
      const mostlyProduct = toks.length > 0 && (prodCount / toks.length > 0.5 || startsProduct);
      if (mostlyProduct && !looksLikeAddress && toks.length <= 5) continue;
    }
    // Size / quantity lines: "Size 24", "24 size", "22 no", "Ring size 26", "Size 24 26", "Size......"
    if (out.length > 0 && /^(?:size|saze)\s*[:.\-]*\s*[\d,.\s]*$/i.test(l)) continue;
    // "Size (dono hath ka pic bheja hai)" / "Ring size - baad me bataunga" —
    // size ke saath reseller ka NOTE. Line "size" se shuru ho, usme koi
    // address-shabd / pincode / phone na ho → poori line HATAO.
    if (out.length > 0 && /^(?:ring\s*|chain\s*|anguthi\s*|bali\s*)?(?:size|saze)\b/i.test(l) &&
        !ADDRESS_HINT_RE.test(l) && !/\d{6}/.test(l) && !/[6-9]\d{9}/.test(l)) continue;
    if (out.length > 0 && /^\d{1,3}(?:\.\d{1,2})?\s*(?:size|saze|no\.?|number|[il]nch|nag|ng|pcs|pc|pec|pics|pic|piece|pis|ps|pair|jodi)\.?$/i.test(l)) continue;
    if (out.length > 0 && /^(?:\d+\s*)?(?:ring|chain|anguthi|bali)\s*(?:size|saze)\s*[\d,\s]*$/i.test(l)) continue;
    if (out.length > 0 && /^gm\.?$/i.test(l)) continue; // akela "Gm" bina number ke

    // AI ke banaye "Not Available"/"N/A" placeholder — aisi line poori HATAO
    if (/\b(not\s*available)\b/i.test(l) && l.split(/\s+/).length <= 4) continue;
    if (/^\s*(n\/?a|nil|none)\.?\s*$/i.test(l)) continue;
    if (/^[a-z\s]+:\s*(n\/?a|nil|none|-+)\.?\s*$/i.test(l)) continue;

    // --- RESELLER KA NOTE / COMMENT hatao (address ka hissa nahi) ---
    //     "रिसेलर ने एड्रेस सुधारा", "Riselar Ne Edres Sudhara", "address change",
    //     "sahi address", "dubara bheja", "update address", "correction" waghera
    {
      const noteWords = /(risel[ae]r|reseller|address|adress|edres|adres|एड्रेस|पता)/i;
      const noteAction = /\b(sudhara|sudhar|sudhaar|thik|theek|sahi|change|chenj|correction|correct|update|apdet|updet|dubara|dobara|dubaara|badla|badal|naya|new|galat|wrong|purana|old|resend|repeat|note|dhyan)\b|(सुधार|सही|बदल|गलत|दुबारा|दोबारा|नया|पुराना|चेंज|अपडेट|ध्यान|नोट)/i;
      // 🛡️ Line me ASLI address-shabd ho (Near/Enclave/University/Road...) to ye note NAHI hai.
      //    "new/naya/old/purana/main" pehle hata kar jaancho — warna "Near New Amity University"
      //    jaisi asli line "naya address" samjhi ja rahi thi.
      const probe = l.replace(/\b(new|naya|nayi|old|purana|purani|main|address|adress|edres|adres)\b/gi, " ");
      const hasRealAddress = ADDRESS_HINT_RE.test(probe);
      if (out.length > 0 && !hasRealAddress && !/\d{6}/.test(l) && !/[6-9]\d{9}/.test(l) &&
          l.split(/\s+/).length <= 8 && noteWords.test(l) && noteAction.test(l)) continue;
    }

    // Baat-cheet / chat lines ("Hum dalna bhai", "ye bhej do") — bina digit, chhoti line, order-words ke saath
    // (address-shabd wali line KABHI chat nahi mani jayegi — "Dalna Wali Gali" safe)
    if (!/\d/.test(l) && l.split(/\s+/).length <= 5 && !ADDRESS_HINT_RE.test(l) &&
        /\b(dalna|daal\s*d|dal\s*d|bhejna|bhej\s*d(o|ena|iya)?|bheja|jod\s*d|kar\s*d(o|ena)|likh\s*d|thanks?|thank\s*you|shukriya|dhanyawad|jaldi|dubara|dobara|dubaara|phir\s*se|fir\s*se)\b/i.test(l)) continue;
    if (/^(ring\s*)?size\s*[:\-]?\s*\d+/i.test(l)) continue;                 // "Size 24" / "Ring size 22"

    // --- Jaane-pehchane SENDER (Udaram Siyag, Ramaram...) bina "From" ke bhi hatao ---
    if (out.length > 0 && isKnownSender(l)) continue;
    // --- Akela chhota number (20, 22 = size/qty) — pincode/phone nahi, to hatao ---
    if (out.length > 0 && /^\d{1,3}$/.test(l)) continue;

    // --- Sender ka naam bina "From" ke likha ho to hatao (pehli line = customer, use kabhi mat hatao) ---
    if (out.length > 0 && !/\d/.test(l)) {
      const norm = l.replace(/[^\p{L}\p{N}@_\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
      if (norm && senderNames.some((n) => n === norm || (norm.length > 5 && n.includes(norm)))) continue;
    }

    // --- "ADDRESS:" jaisa prefix hatao (baaki labels PO:/Post:/Dist:/CITY: rakho) ---
    l = l.replace(/^(?:address|adress|addres|add)\s*[;:\-–—]\s*/i, "");

    // --- "Naam / Name / नाम / नेम" label naam ki line se hatao ("Naam khuman Singh" → "khuman Singh") ---
    l = l.replace(/^(naam|name|नाम|नेम)\s*[.:\-–—]?\s+(?=\S)/i, "");

    // --- Pincode line: "Pin code" / "PIN COAD" / "Pin cold" / "Pin -" / "PIN:" / "पिन कोड" → sirf "581329" ---
    // Sirf ASLI pincode-label: pin / pincode / pin code / pin coad / pin cold / pin kod / पिन कोड
    // (pehle "p[i1]n[a-z\s.]*" tha jo "PATHANKOT" jaise shahar bhi kha jata tha)
    const pinM = l.match(/^(?:p[i1]n\.?\s*(?:code|coad|cold|kod|cod|no\.?|number)?|पिन\s*कोड|पिन)\s*[:\-–—]?\s*(\d{6})\s*$/i);
    if (pinM) { out.push(pinM[1]); continue; }
    if (/^(?:p[i1]n\.?\s*(?:code|coad|cold|kod|cod|no\.?|number)?|पिन\s*कोड|पिन)\s*[:\-–—]?\s*$/i.test(l)) continue; // khali "Pin code" label

    // --- COD normalize: COD/Payment/Pement/Amount... sab "COD ..." banenge ---
    const codM = l.match(new RegExp(`^(?:${COD_WORDS})(?![A-Za-z])\\s*[.:\\-–—]?\\s*(.+)$`, "i"));
    if (codM && /\d/.test(codM[1])) {
      const wtLike = codM[1].trim().match(/^(\d+)\s*g(rams?|ms?|ram)?\.?$/i);
      if (wtLike) { out.push(wtLike[1] + "g"); continue; } // "Total 75g" = weight, COD nahi
      let c = codM[1].trim().replace(/^=\s*/, "");
      // "1800-100-1700" jaisi typo: agar A-B=C sahi baithta hai to aakhri dash ko "=" banao
      const t = c.match(/^([\d,]+)\s*-\s*([\d,]+)\s*-\s*([\d,]+)\s*$/);
      if (t) {
        const a = parseInt(t[1].replace(/,/g, "")), b = parseInt(t[2].replace(/,/g, "")), cc = parseInt(t[3].replace(/,/g, ""));
        if (a - b === cc) c = `${t[1]}-${t[2]}=${t[3]}`;
      }
      out.push("COD " + c);
      continue;
    }

    // --- Phone lines: 10-digit, ya 91/0 prefix wale 11-12 digit (919828261505 → 9828261505) ---
    const PHONE_RE = /(?<!\d)(?:\+?91[\s\-]?|0)?[6-9]\d{9}(?!\d)/g;
    const rawNums = l.match(PHONE_RE);
    const nums = rawNums ? [...new Set(rawNums.map((n) => n.replace(/\D/g, "").slice(-10)))] : null;
    if (nums && l.replace(PHONE_RE, "").replace(/[\s\/,\-+()]/g, "") === "") {
      out.push(...nums);
      continue;
    }
    if (nums) {
      // Mixed line (jaise "9950535752 Omprakash ...") — phone alag line pe, baaki text apni jagah
      const rest = l.replace(PHONE_RE, "").replace(/\s{2,}/g, " ").replace(/^[\s,\-–—]+|[\s,\-–—]+$/g, "");
      out.push(...nums);
      if (rest) out.push(rest);
      continue;
    }

    // --- Weight normalize: "75GM" / "100gm" / "75 grams" / "75 G" → "75g" ---
    const wt = l.match(/^(\d+)\s*g(rams?|ms?|ram)?\.?$/i);
    if (wt) { out.push(wt[1] + "g"); continue; }

    // --- LABEL-WORD SAFAI (aapki Apps Script wali) — push se pehle ---
    // Emoji hatao (footer filter upar ho chuka, isliye 👤📦 detection safe hai)
    l = l.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
    // Line ki shuruat ke labels: Address/Add/Contact/Alternative/Mo./Ph./Mobile/Phone...
    l = l.replace(/^(add|contact|alternative|mo\.?|ph\.?|mobile|phone|मोबाइल|मो|नंबर)\s*[.:\-–—,]\s*/i, "");
    // Akela khada label word kahi bhi ho to hatao: pin/code/phone/mobile (Pinki jaise naam safe)
    l = l.replace(/\b(pin\s*code|pincode|pin|code|phone)\b|\bmobile\s*(?=[:.\-]|\s*\d)/gi, " ");
    l = l.replace(/(?<![\p{L}])(पिन|पीन|मोबाइल|मोब|नंबर)(?![\p{L}])/gu, " ");
    // number/num → No., aur khali "No." (bina digit) hatao
    l = l.replace(/\b(number|num)\b/gi, "No.");
    // "No." tabhi hatao jab uske aage koi number NA ho.
    // "House No.:32" / "Plot No. - 5" / "Shop No:12" — sab me No. bacha rehna chahiye
    l = l.replace(/\bNo\b\.?/gi, (m, off, whole) =>
      /^\s*[:\-–—.,]?\s*\d/.test(whole.slice(off + m.length)) ? m : " "
    );
    // Extra spaces / shuru-aakhir ke symbols saaf karo
    l = l.replace(/\s{2,}/g, " ").replace(/^[\s,.:\-–—]+/g, "");
    // Aakhir ki safai — lekin "S.O." / "B.O." / "H.O." ka dot mat chheeno
    if (!/\b[SBHG]\.\s*O\.$/i.test(l)) l = l.replace(/[\s,.:\-–—]+$/g, "");
    else l = l.replace(/[\s,:\-–—]+$/g, "");
    l = l.trim();
    if (!l) continue;

    // --- Baaki lines JAISI HAI WAISI rakho (original order, labels ke saath) ---
    out.push(l);
  }

  // --- JUNK SAFAI (conservative — sirf pakke junk, asli address kabhi nahi) ---
  {
    const seen = new Set();
    const cleaned2 = [];
    for (let i = 0; i < out.length; i++) {
      let l = out[i];
      const isName = i === 0;

      // 1) B.O / S.O / H.O — ye India Post ka ASLI hissa hai, isliye JAISA HAI WAISA RAHEGA.
      //    "Arniyali B.O", "Dhorimanna S.O", "Moga H.O" — kuch nahi kata jayega.

      // 2) Bilkul chhoti gibberish line (<=4 akshar, koi asli shabd nahi): "Aad", "Kanti" jaisi
      //    SIRF tab hataao jab wo akeli ho aur address structure me fit na baithe
      //    (Note: ye risky hai, isliye sirf 2-3 akshar wali pure-alpha line jo COD/pin/phone ke aas-paas ho)

      // 2b) EK HI LINE ke andar wahi shabd baar-baar: "Indore, Indore, Indore" -> "Indore"
      //     (label ke baad wala hissa hi dekha jata hai, taaki "PO: Sonipat" safe rahe)
      if (!isName && /[,\/]/.test(l)) {
        const labelM = l.match(/^([^:]{1,18}:\s*)/); // "Village: " jaisa label alag rakho
        const prefix = labelM ? labelM[1] : "";
        const body = l.slice(prefix.length);
        const parts = body.split(/\s*[,\/]\s*/).filter((x) => x.trim());
        // Devanagari hissa pehle Hinglish banao — warna "इंदौर, इंदौर, इंदौर" ki key
        // KHALI ban jati thi aur ek bhi duplicate nahi hatta tha.
        const normP = (x) => devToHinglish(x.trim()).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const hasDev = /[ऀ-ॿ]/.test(body);
        // LABEL-shabd: "मु, पो, गुलगांव" me "पो" ke baad wala naam POST OFFICE ka hai —
        // aapka niyam: post/jila LIKHA ho to wo naam kabhi nahi hatega, chahe upar aa chuka ho.
        const LABEL_ONLY = /^(?:mu|mukam|muqam|po|post|vpo|vill|village|gram|ganv|gaon|teh|tehsil|tahsil|taluka|dist|distt|district|jila|jilla|city|ps|via|vaya|near|opp|state)$/;
        const isLabelPart = (x) => {
          const n = normP(x);
          return !!n && n.split(" ").every((w) => LABEL_ONLY.test(w));
        };
        const seenP = new Set();
        const seenTok = new Set(); // ab tak aaye saare shabd
        const uniq = parts.filter((x, pi) => {
          const k = normP(x);
          if (!k) return true;
          // Pichla hissa sirf label ho ("...मु, पो, गुलगांव") → ye naam LABELLED hai, mat hatao
          if (pi > 0 && isLabelPart(parts[pi - 1])) {
            k.split(" ").filter(Boolean).forEach((w) => seenTok.add(w));
            return true;
          }
          const flat = k.replace(/\s+/g, "");
          if (seenP.has(flat)) return false; // bilkul wahi part dobara
          const tk = k.split(" ").filter(Boolean);
          // Mixed-script app-tail: "...जिला जालौर राजस्थान, Jalor, Rajasthan"
          // AKELE shabd wala part jo pehle aa chuke shabd ka hi dusra spelling ho → hatao.
          // (sirf Devanagari-wali line pe, kyunki ek hi script me upar wala exact match kaafi hai)
          // Hindi→English spelling ka fark lagbhag poora SWAR (vowel) ka hota hai —
          // "जालौर" = Jalaur/Jalor, "सांचौर" = Sanchaur/Sanchore — isliye vyanjan (consonant)
          // ka dhaancha milao. Isse "Barmer vs Balotra" jaise ALAG naam kabhi nahi milenge.
          // (edit-distance JAAN-BOOJH KAR nahi — "Jaipur vs Jaitpur" ek-akshar door hai
          //  par ALAG jagah hai; vyanjan ka dhaancha ise sahi-sahi alag rakhta hai)
          const skel = (t) => t.replace(/[aeiou]/g, "").replace(/w/g, "v");
          const sameWord = (t) =>
            t === tk[0] ||
            (t.length >= 5 && tk[0].length >= 5 &&
              skel(t).length >= 3 && skel(t) === skel(tk[0]));
          if (hasDev && tk.length === 1 && tk[0].length >= 5 && [...seenTok].some(sameWord)) return false;
          seenP.add(flat);
          tk.forEach((t) => seenTok.add(t));
          return true;
        });
        if (uniq.length !== parts.length) l = (prefix + uniq.join(", ")).trim();
      }

      // 3) Duplicate line (bilkul same, case-insensitive)
      const key = l.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!isName && key && seen.has(key)) continue;
      seen.add(key);

      cleaned2.push(l);
    }
    out.length = 0;
    out.push(...cleaned2);
  }

  // --- Standalone pincode line nahi hai to line ke ANDAR chhipa pincode nikaalo ---
  // (jaise "...Punjab 144514", "CITY: JAISALMER-345021", "Patna - 800020,")
  if (!out.some((l) => /^\d{6}$/.test(l))) {
    for (let i = 0; i < out.length; i++) {
      const l = out[i];
      if (/^COD\s/.test(l) || /^\d+g$/.test(l)) continue;
      const m = l.replace(/[6-9]\d{9}/g, "").match(/(?<!\d)(\d{6})(?!\d)/);
      if (m) {
        let cleaned = l
          .replace(new RegExp("(?<!\\d)" + m[1] + "(?!\\d)"), "")
          .replace(/\s*[-–—]\s*([,.]|$)/g, "$1")
          .replace(/[,:\s\-–—]+$/g, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        if (cleaned) out.splice(i, 1, cleaned, m[1]);
        else out.splice(i, 1, m[1]);
        break;
      }
    }
  }

  // --- COD line hi nahi bani, par koi standalone BADA number pada hai ("1800")? ---
  //     Reseller ne "COD" label bhulaya hoga — use COD maan lo
  if (!out.some((l) => /^COD\b/i.test(l))) {
    const idx = out.findIndex((l, i) => {
      if (i === 0) return false;
      const t = l.trim();
      // (a) "1500-100=1400" jaisa COD-math   (b) akela bada number "1800"
      return /^\d{3,6}\s*-\s*\d{1,5}\s*=\s*\d{3,6}$/.test(t) ||
             (/^\d{3,5}$/.test(t) && parseInt(t, 10) >= 100);
    });
    if (idx !== -1) {
      const amt = out[idx].trim().replace(/\s+/g, "");
      out.splice(idx, 1);
      out.push("COD " + amt);
    }
  }

  // --- Pincode line ko COD line ke THEEK PEHLE lagao ---
  const pinIdx = out.findIndex((l) => /^\d{6}$/.test(l));
  const codIdx = out.findIndex((l) => /^COD\s/.test(l));
  if (pinIdx !== -1 && codIdx !== -1 && pinIdx !== codIdx - 1) {
    const [pinLine] = out.splice(pinIdx, 1);
    const newCodIdx = out.findIndex((l) => /^COD\s/.test(l));
    out.splice(newCodIdx, 0, pinLine);
  }

  // NOTE: State/District bot KHUD SE add nahi karega — reseller likhe to hi rahega
  return enforceFormat(out.join("\n"));
}

// ============================================================
//  2) VALIDATION LAYER — deterministic, kabhi galat nahi
// ============================================================

// Pincode ke pehle 2 digits → State (lenient — border zones me multiple allowed)
const PIN_STATE = {
  11: ["Delhi"], 12: ["Haryana"], 13: ["Haryana", "Punjab"],
  14: ["Punjab"], 15: ["Punjab"], 16: ["Punjab", "Chandigarh"],
  17: ["Himachal Pradesh"], 18: ["Jammu & Kashmir", "Jammu and Kashmir"], 19: ["Jammu & Kashmir", "Jammu and Kashmir"],
  20: ["Uttar Pradesh"], 21: ["Uttar Pradesh"], 22: ["Uttar Pradesh"], 23: ["Uttar Pradesh"],
  24: ["Uttar Pradesh", "Uttarakhand"], 25: ["Uttar Pradesh", "Uttarakhand"],
  26: ["Uttar Pradesh", "Uttarakhand"], 27: ["Uttar Pradesh"], 28: ["Uttar Pradesh"],
  30: ["Rajasthan"], 31: ["Rajasthan"], 32: ["Rajasthan"], 33: ["Rajasthan"], 34: ["Rajasthan"],
  36: ["Gujarat"], 37: ["Gujarat"], 38: ["Gujarat"], 39: ["Gujarat"],
  40: ["Maharashtra", "Goa"], 41: ["Maharashtra"], 42: ["Maharashtra"], 43: ["Maharashtra"], 44: ["Maharashtra"],
  45: ["Madhya Pradesh"], 46: ["Madhya Pradesh"], 47: ["Madhya Pradesh"], 48: ["Madhya Pradesh"],
  49: ["Chhattisgarh"],
  50: ["Telangana"], 51: ["Andhra Pradesh"], 52: ["Andhra Pradesh"], 53: ["Andhra Pradesh"],
  56: ["Karnataka"], 57: ["Karnataka"], 58: ["Karnataka"], 59: ["Karnataka"],
  60: ["Tamil Nadu"], 61: ["Tamil Nadu"], 62: ["Tamil Nadu"], 63: ["Tamil Nadu"], 64: ["Tamil Nadu"],
  67: ["Kerala"], 68: ["Kerala"], 69: ["Kerala"],
  70: ["West Bengal"], 71: ["West Bengal"], 72: ["West Bengal"], 73: ["West Bengal"], 74: ["West Bengal"],
  75: ["Odisha"], 76: ["Odisha"], 77: ["Odisha"],
  78: ["Assam"], 79: ["Arunachal Pradesh", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Tripura"],
  80: ["Bihar"], 81: ["Bihar", "Jharkhand"], 82: ["Jharkhand", "Bihar"],
  83: ["Jharkhand"], 84: ["Bihar"], 85: ["Bihar", "Jharkhand"],
};

// ============================================================
//  ADDRESS FITTER (v9.8) — booking ke time lamba address KAT jata hai,
//  isliye ASLI address (naam / phone / pincode / COD / weight ko CHHOD kar)
//  ko 100 character ke andar laate hai.
//
//  SIDHI BAAT: 100 ke ANDAR hai to kuch bhi nahi chhuta. Jab bada ho tabhi,
//  neeche wali SEEDHI me, aur jaise hi fit ho jaye WAHI RUK jaata hai —
//  zarurat se zyada kabhi nahi katta.
//    1. Label chhote karo      (Post Office: → PO)      — kuch nahi khota
//    2. Ek hi naam baar-baar   (PO/Teh/Dist Sitapur)    — kuch nahi khota
//    3. Aam shabd chhote       (Road → Rd)              — kuch nahi khota
//    4. State hatao            (pincode se pata chalta hai)
//    5. Landmark hatao         (Near ... wala hissa)    — sabse aakhir me
//
//  Gaon ka naam, PO, makan/ward number, Tehsil, Dist KABHI nahi hatte.
// ============================================================
const ADDR_LIMIT = 100;

const ALL_STATES = [...new Set(Object.values(PIN_STATE).flat())];

// Address block alag karo — enforceFormat jaisa hi batwara
function splitParts(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = [], tail = [], addr = [];
  let seenAddr = false;
  for (const l of lines) {
    if (/^[6-9]\d{9}$/.test(l) || /^(?:[SWD]\s*\/\s*[O0]\b|son\s+of\b|wife\s+of\b|daughter\s+of\b)/i.test(l)) {
      (seenAddr ? addr : head).push(l); continue;
    }
    if (/^\d{6}$/.test(l) || /^COD\s+[\d,]/i.test(l) || /^\d+g$/i.test(l)) { tail.push(l); continue; }
    if (!seenAddr && head.length === 0) { head.push(l); continue; } // naam = pehli line
    seenAddr = true; addr.push(l);
  }
  return { head, addr, tail };
}

const addrLen = (addr) => addr.join("\n").length;

function fitAddress(text, limit = ADDR_LIMIT) {
  const { head, addr, tail } = splitParts(text);
  if (addr.length === 0 || addrLen(addr) <= limit) return text; // 82% yahi se wapas
  let A = addr.slice();
  const fitState = {}; // seedhi ke baad wale kaam yahan rakhe jate hai
  const done = () => addrLen(A) <= limit;
  const tidy = (arr) =>
    arr.map((s) => s.replace(/\s{2,}/g, " ")
                    .replace(/\s*,\s*/g, ", ")   // comma ke baad hamesha ek space
                    .replace(/^[\s,:\-–—]+|[\s,:\-–—]+$/g, "").trim())
       .filter(Boolean);

  // ---- 1. LABEL chhote (kuch nahi khota) ----
  const LBL = [
    [/\bv\.?\s*p\.?\s*o\.?\s*[:\-–—]?\s*/gi, "VPO "],
    [/\b(?:post\s*off?ice|post|p\.?\s*o\.?)\s*[:\-–—]\s*/gi, "PO "],
    [/\b(?:village|vill|gram|gaon)\s*\/?\s*[:\-–—]\s*/gi, "Vill "],
    [/\b(?:tehsil|tahsil|taluka|taluk|teh)\s*(?:\/\s*mandal)?\s*[:\-–—]\s*/gi, "Teh "],
    [/\b(?:district|distt?)\s*[:\-–—]\s*/gi, "Dist "],
    [/\b(?:state|city|town|landmark|land\s*mark|area|locality|colony\s*\/\s*area)\s*(?:\/\s*\w+)?\s*[:\-–—.]\s*/gi, ""],
    [/\b(house|plot|flat|shop|ward|room|gali|street|survey)\s*(?:\/\s*\w+)?\s*no\.?\s*[:\-–—]?\s*/gi, (m, w) => w + " "],
    // Bina colon ke label: "Post Office Jogeshwari", "District Wardha", "Village Khapri"
    // (aage road/marg/nagar ho to mat chhedo — "Village Road" naam bach jaye)
    [/(^|,\s*)post\s*off?ice\s+(?!(?:rd|road|marg|ngr|nagar)\b)/gi, "$1PO "],
    [/(^|,\s*)(?:village|gram)\s+(?!(?:rd|road|marg|ngr|nagar)\b)/gi, "$1Vill "],
    [/(^|,\s*)(?:district|distt)\s+(?!(?:rd|road|marg|ngr|nagar)\b)/gi, "$1Dist "],
    // "PO Chandrapur (Main Post Office)" → "PO Chandrapur"
    // SIRF angrezi ka ye FAALTU label bracket me. "(Mungapur)" jaisa DUSRA GAON ka
    // naam, aur "Arniyali B.O" / "Khichan S.O" ko ye KABHI nahi chhuta.
    [/\s*\(\s*(?:main|head|general)?\s*(?:post|head)\s*off?ice\s*\)/gi, ""],
    // Hinglish labels — "Jila Etawah", "Gav Jogeshwari", "Mu Khapri"
    [/(^|,\s*)(?:jila|jilla|zila)\s*[:\-–—]?\s*(?!(?:rd|road|marg|ngr|nagar)\b)/gi, "$1Dist "],
    [/(^|,\s*)(?:gav|gaon|ganv)\s*[:\-–—]?\s+(?!(?:rd|road|marg|ngr|nagar)\b)/gi, "$1Vill "],
    [/(^|,\s*)(?:tehsil|tahsil|taluka)\s+(?!(?:rd|road|marg|ngr|nagar)\b)/gi, "$1Teh "],
  ];
  A = tidy(A.map((s) => { for (const [re, to] of LBL) s = s.replace(re, to); return s; }))
        .filter((s) => !/^(?:PO|VPO|Vill|Teh|Dist)$/i.test(s)); // khali label line
  if (done()) return rebuild(head, A, tail);

  // ---- 2. Ek hi naam PO/Vill/Teh/Dist me baar-baar → ek line (kuch nahi khota) ----
  {
    const grp = {};
    A.forEach((s, i) => {
      const m = s.match(/^(PO|VPO|Vill|Teh|Dist)\s+(.+)$/i);
      if (m) (grp[m[2].trim().toLowerCase()] ||= []).push({ i, lab: m[1], name: m[2].trim() });
    });
    const drop = new Set();
    for (const k in grp) {
      const g = grp[k];
      if (g.length < 2) continue;
      const labs = [...new Set(g.map((x) => x.lab))].join("/");
      A[g[0].i] = labs + " " + g[0].name;
      g.slice(1).forEach((x) => drop.add(x.i));
    }
    if (drop.size) A = A.filter((_, i) => !drop.has(i));
  }
  if (done()) return rebuild(head, A, tail);

  // ---- 2b. Wahi jagah ka naam poore address me baar-baar (kuch nahi khota) ----
  //      "PO Jogeshwari West S.O., Jogeshwari West, ..., Gav Jogeshwari West"
  //      LABEL wala hissa HAMESHA rahega (aapka niyam), sirf BINA-LABEL wali
  //      nakal hategi jo kisi dusre hisse ke andar pehle se maujood hai.
  {
    const LAB = /^(?:PO|VPO|Vill|Teh|Dist|Gav|Gaon|Ganv|Gram|Jila|Mu|Via|H\.?No|Ward|Plot|Flat|Shop|House)\b/i;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const parts = []; // {li, pi, txt}
    A.forEach((l, li) => l.split(/\s*,\s*/).forEach((p, pi) => parts.push({ li, pi, txt: p.trim() })));
    // "PO, Jodhpur" — pichla hissa sirf LABEL ho to aage wala naam USI label ka hai,
    // wo kabhi nahi hatega (chahe wo naam kahi aur bhi likha ho).
    const LAB_ONLY = /^(?:PO|VPO|Vill|Teh|Dist|Gav|Gaon|Ganv|Gram|Jila|Mu|Via|Post|Village|District|Tehsil)\.?$/i;
    const kill = new Set();
    for (const p of parts) {
      const n = norm(p.txt);
      if (!n || n.length < 4 || LAB.test(p.txt)) continue; // label wala kabhi nahi
      const prev = parts.find((q) => q.li === p.li && q.pi === p.pi - 1);
      if (prev && LAB_ONLY.test(prev.txt.trim())) continue; // label ke turant baad ka naam
      const inside = parts.some(
        (q) => q !== p && !kill.has(q) && norm(q.txt) !== n &&
               new RegExp("(^| )" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "( |$)").test(norm(q.txt))
      );
      if (inside) kill.add(p);
    }
    if (kill.size) {
      A = tidy(A.map((l, li) =>
        l.split(/\s*,\s*/).filter((_, pi) => ![...kill].some((k) => k.li === li && k.pi === pi)).join(", ")
      ));
    }
  }
  if (done()) return rebuild(head, A, tail);

  // ---- 2c. Bracket me wahi naam jo pehle se likha hai (kuch nahi khota) ----
  //      "...Navjoti Manovikas School ( Jodhpur)" + upar "PO, Jodhpur" → bracket hatao.
  //      "PO/Vill Khapri (Mungapur)" me Mungapur kahi aur nahi hai → wo RAHEGA.
  {
    const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const next = A.map((l) =>
      l.replace(/\s*\(\s*([^()]{3,30}?)\s*\)/g, (m, inner) => {
        const n = flat(inner);
        if (!n) return m;
        const baaki = flat(A.join(" ").replace(m, " "));
        return new RegExp("(^| )" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "( |$)").test(baaki)
          ? "" : m;
      })
    );
    const t2 = tidy(next);
    if (t2.length) A = t2;
  }
  if (done()) return rebuild(head, A, tail);

  // ---- 4. BHARATIYA DAK ki zarurat ke hisaab se hatao ----
  //
  //  Speed Post ka asli safar:
  //    PIN CODE  → parcel sahi delivery post office tak pahunchta hai (machine sorting)
  //    PO / Gaon → us office ka DAAKIYA apne beat me dhundhta hai
  //    Makan no / Landmark → aakhri darwaza
  //
  //  "India" ko koi nahi padhta (saara parcel desh ke andar hi hai).
  //  State / District / Tehsil bhi daakiya nahi padhta — wo PIN se pehle hi tay ho chuke.
  //  Isliye SABSE PEHLE wahi hatte hai, aur LANDMARK SABSE AAKHIR me —
  //  kyunki gaon-dehat me daakiya asal me usi se ghar dhundhta hai.
  //
  //  Hatane ka kram (sabse kam kaam ka → sabse zyada kaam ka):
  //     India  →  State  →  District  →  Tehsil  →  Landmark
  //  Gaon, PO, makan/ward number KABHI nahi hatte.
  {
    const bare = (s) => s.trim().toLowerCase().replace(/[^a-z& ]/g, "").trim();
    const isIndia = (s) => /^(?:india|bharat|bharath|hindustan|ind)$/.test(bare(s));
    const isState = (s) => ALL_STATES.some((st) => st.toLowerCase() === bare(s));
    const isDist  = (s) => /^dist\b/i.test(s.trim());
    const isTeh   = (s) => /^teh\b/i.test(s.trim());
    const LM      = /^(?:Nr|Opp|Beh|samne|paas|pass)\b/i;
    // 🛡️ Jis hisse me koi NUMBER ho use KABHI mat hatao — "Opp Lifeline Hospital Plot No 1"
    //    me "Plot No 1" ASLI makan ka number ho sakta hai. Thoda lamba rehna chalega,
    //    par makan ka number kabhi nahi khona chahiye.
    // 🛡️ LAMBA hissa sirf landmark nahi hota — usme aage aur bhi ASLI pata hota hai.
    //    "Nr Vasundhara Hosp K Sath Navjoti Manovikas School (Jodhpur)" me
    //    school aur sheher dono hai. Aise hisse ko poora mat hatao —
    //    address thoda lamba reh jaye wo chalega, par jagah ka naam nahi khona chahiye.
    const isLM = (s) => LM.test(s.trim()) && !/\d/.test(s) && s.trim().length <= 35;

    // ZARURI: pehle sirf "Dist"/"Teh" ka LABEL hatao, SHEHER ka naam RAKHO.
    // "Dist Ahmedabad" → "Ahmedabad" (5 akshar bache, naam bach gaya).
    // Naam tabhi jayega jab iske baad bhi jagah kam pade.
    // Isi se address 95-100 ke beech aata hai, 87 par girta nahi.
    const wasDist = new Set(), wasTeh = new Set();
    if (!done()) {
      A = A.map((s) => {
        if (isDist(s)) { const n = s.replace(/^dist\.?\s*[:\-]?\s*/i, "").trim(); if (n) { wasDist.add(n); return n; } }
        if (isTeh(s))  { const n = s.replace(/^teh\.?\s*[:\-]?\s*/i, "").trim();  if (n) { wasTeh.add(n);  return n; } }
        return s;
      });
    }
    const wasDistLine = (s) => wasDist.has(s.trim());
    const wasTehLine = (s) => wasTeh.has(s.trim());

    // Ek cheez hatane ka tarika — pehle comma wala HISSA, phir poori line
    // lineOnly = sirf POORI LINE dekho, line ke andar ke hisse nahi.
    // District/Tehsil ke liye ZARURI hai: "Dist Jodhpur" ka label hat kar wo
    // akela "Jodhpur" ban chuka hai — agar hisse bhi dekhe to "PO, Jodhpur"
    // wala Jodhpur bhi kat jata, jo us PO ka naam hai.
    // ⚠️ SABSE ZARURI NIYAM: EK BAAR ME SIRF EK CHEEZ HATTI HAI.
    //    Har hatane ke baad dobara naapa jata hai, aur jaise hi 100 ke andar
    //    aaya WAHI RUK JATA HAI. Pehle saare landmark ek saath ud jate the —
    //    isi se 134 ka address 57 par gir gaya tha.
    //    CHHOTA hissa pehle jata hai, taaki SABSE KAM akshar kate aur
    //    address 100 ke jitna paas ho sake utna paas rahe.
    const applyDrop = (drop, lineOnly) => {
      // (a) PEHLE line ke andar ka comma wala HISSA — ek-ek karke
      //     ("Nr Meera Chowk, Beh Govt Soc, Hotel Vinayak Palace" me se
      //      sirf "Nr Meera Chowk" jaye, baaki dono bache rahe)
      if (!lineOnly) {
        for (;;) {
          if (done()) return;
          let best = null;
          A.forEach((s, li) => {
            const ps = s.split(/\s*,\s*/);
            if (ps.length < 2) return; // akela hissa = poori line, use (b) dekhega
            ps.forEach((p, pi) => {
              if (!drop(p)) return;
              if (!best || p.trim().length < best.len) best = { li, pi, len: p.trim().length };
            });
          });
          if (!best) break;
          const next = tidy(A.map((s, li) =>
            li !== best.li ? s : s.split(/\s*,\s*/).filter((_, pi) => pi !== best.pi).join(", ")
          ));
          if (!next.length) break;
          A = next;
        }
      }
      // (b) PHIR poori line — bhi ek-ek karke, chhoti line pehle
      //     (line khud wahi cheez ho, ya uske SAARE hisse wahi cheez ho)
      const dropLine = (s) => {
        if (drop(s)) return true;
        const ps = s.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
        return ps.length > 1 && ps.every(drop);
      };
      for (;;) {
        if (done()) return;
        if (A.length <= 1) return; // poora address kabhi khali mat karo
        let bi = -1, bl = Infinity;
        A.forEach((s, i) => { if (dropLine(s) && s.length < bl) { bl = s.length; bi = i; } });
        if (bi === -1) return;
        A = A.filter((_, i) => i !== bi);
      }
    };

    // "India" aur State ka koi MOL nahi (PIN se pata chal jate hai) —
    // isliye ye shabd chhote karne se bhi PEHLE jate hai.
    applyDrop(isIndia);
    applyDrop(isState);
    fitState.applyDrop = applyDrop;
    fitState.rest = [[wasDistLine, true], [wasTehLine, true], [isLM, false]];


  // ---- ab shabd chhote karo (upar wale zero-cost kaam ke BAAD) ----
  //      Jab tak 100 ke andar na aa jaye tabhi agla shabd chhota hota hai.
  //      Isliye "Market" tabhi "Mkt" banega jab sach me jagah kam padegi.
  //      Kram: sabse aam/pehchana-jaane wala pehle.
  const WORD = [
    [/\bnear\s*:?\s*/gi, "Nr "],       // "Near:" ka colon bhi jata hai
    [/\bopposite\s*:?\s*/gi, "Opp "],
    [/\bbehind\s*:?\s*/gi, "Beh "],
    [/\broad\b/gi, "Rd"],
    [/\bnagar\b/gi, "Ngr"],
    [/\bnumber\b/gi, "No"],
    [/\bcolony\b/gi, "Col"],
    [/\bsociety\b/gi, "Soc"],
    [/\bfloor\b/gi, "Flr"],
    [/\bbuilding\b/gi, "Bldg"],
    [/\bapartment\b/gi, "Apt"],
    [/\bstation\b/gi, "Stn"],
    [/\bhospital\b/gi, "Hosp"],
    [/\bmarket\b/gi, "Mkt"],
    [/\bcross(?:ing)?\b/gi, "Crsg"],
  ];
  for (const [re, to] of WORD) {
    if (done()) break;
    const next = tidy(A.map((s) => s.replace(re, to)));
    if (next.length) A = next;
  }
  if (done()) return rebuild(head, A, tail);

    // Ab baaki — District ka naam, Tehsil ka naam, phir LANDMARK sabse aakhir me.
    // Jaise hi 100 ke andar aaya WAHI RUK JAO.
    for (const [drop, lineOnly] of fitState.rest) fitState.applyDrop(drop, lineOnly);
  }
  return rebuild(head, A, tail);
}

function rebuild(head, addr, tail) {
  return [...head, ...addr, ...tail].filter(Boolean).join("\n");
}

function validate(rawText, cleanedText) {
  rawText = normalizeRaw(rawText); // same normalizer — warna false "missing" errors aate hai

  const errors = [];
  const warnings = [];
  let lines = cleanedText.split("\n").map((l) => l.trim());

  const rawDigits = rawText.replace(/[\s,]/g, ""); // spaces/commas hata kar digit matching

  // --- Phone lines nikaalo (line 2 se jitni consecutive 10-digit lines hai) ---
  const phoneLines = [];
  let i = 1;
  while (i < lines.length && /^[6-9]\d{9}$/.test(lines[i].replace(/\D/g, "")) && lines[i].replace(/\D/g, "").length === 10) {
    phoneLines.push(lines[i].replace(/\D/g, ""));
    i++;
  }

  // FORMAT RULE: agar kisi line me 2 number "/" ke saath hai to alag lines me todo
  lines = lines.flatMap((l) => {
    const nums = l.match(/[6-9]\d{9}/g);
    if (nums && nums.length >= 2 && l.replace(/[6-9]\d{9}|[\s\/,]/g, "") === "") {
      return nums; // "98xxx / 92xxx" → do alag lines
    }
    return [l];
  });

  // --- CHECK 1: Har phone raw message me exist karta hai? ---
  const cleanPhones = (cleanedText.match(/[6-9]\d{9}/g) || []);
  for (const p of cleanPhones) {
    if (!rawDigits.includes(p)) errors.push(`📱 Phone ${p} raw address me NAHI mila`);
  }
  // --- CHECK 2: Raw ke saare phones output me hai? ---
  // Line-by-line extract karo — warna 2 alag lines ke numbers jud kar 20 digit ban jate hai
  // Footer/junk lines (👤/📦/ID/शिपिंग/ORD#/From) SKIP karo — unme Telegram ID hoti hai, phone nahi
  const rawPhoneSet = new Set();
  for (const line of rawText.split("\n")) {
    if (/^[👤📦🚚💰]|शिपिंग|\bORD\s*#|\(ID:\s*\d+\)|^(from|form|forum|frm|fram)\s*[:\-]?\s/iu.test(line.trim())) continue;
    const compact = line.replace(/[\s-]/g, "");
    for (const m of compact.matchAll(/(?<!\d)(?:91|0)?([6-9]\d{9})(?!\d)/g)) rawPhoneSet.add(m[1]);
  }
  const rawPhones = [...rawPhoneSet];
  for (const p of rawPhones) {
    if (!cleanPhones.includes(p)) errors.push(`📱 Raw ka phone ${p} output me MISSING hai`);
  }
  if (rawPhones.length === 0) warnings.push("📱 Raw me koi phone number nahi mila");

  // --- CHECK 3: Pincode ---
  const pinMatch = cleanedText.match(/(?<!\d)(\d{6})(?!\d)/g) || [];
  const pin = pinMatch.find((p) => !cleanPhones.some((ph) => ph.includes(p)));
  if (!pin) {
    errors.push("📮 Output me 6-digit pincode nahi mila");
  } else if (!rawDigits.includes(pin)) {
    errors.push(`📮 Pincode ${pin} raw address me NAHI mila`);
  }

  // --- CHECK 4: COD math ---
  const codLine = lines.find((l) => /COD/i.test(l) && /\d/.test(l));
  let codOut = null;
  if (codLine) {
    // "COD 1900-200=1700" ho to final (1700) lo, warna pehla number
    const outMath = codLine.match(/([\d,]+)\s*-\s*([\d,]+)\s*=\s*([\d,]+)/);
    codOut = outMath
      ? parseInt(outMath[3].replace(/,/g, ""))
      : parseInt(codLine.match(/\d[\d,]*/)[0].replace(/,/g, ""));
  }
  const rawCod = rawText.match(new RegExp(`(?<![A-Za-z])(?:${COD_WORDS})(?![A-Za-z])[^\\d]*([\\d,]+)\\s*-\\s*([\\d,]+)\\s*[=\\-]\\s*([\\d,]+)`, "i"));
  const rawCodSimple = rawText.match(new RegExp(`(?<![A-Za-z])(?:${COD_WORDS})(?![A-Za-z])[^\\d]*([\\d,]+)(?!\\s*g(?:m|ms|ram|rams)?\\b)`, "i"));
  // 🚨 COD amount raw me hi nahi mila → TURANT ERROR
  if (!rawCod && !rawCodSimple) {
    errors.push("💰 Raw address me COD amount NAHI mila — turant check karo!");
  }
  if (!codOut) {
    errors.push("💰 Output me COD line nahi mili");
  } else if (rawCod) {
    const a = parseInt(rawCod[1].replace(/,/g, ""));
    const b = parseInt(rawCod[2].replace(/,/g, ""));
    const c = parseInt(rawCod[3].replace(/,/g, ""));
    if (a - b !== c) warnings.push(`💰 Raw COD math galat hai: ${a}-${b}=${c}? (${a - b} hona chahiye)`);
    if (codOut !== c) errors.push(`💰 COD ${codOut} likha hai, raw me final ${c} hai`);
  } else if (rawCodSimple) {
    const c = parseInt(rawCodSimple[1].replace(/,/g, ""));
    if (codOut !== c) errors.push(`💰 COD ${codOut} likha hai, raw me ${c} hai`);
  }

  // --- CHECK 5: Weight ---
  const wtOut = cleanedText.match(/(\d+)\s*g\s*$/im);
  const wtRaw = rawText.match(/(\d+)\s*g(m|ms|ram)?\b/i);
  if (wtOut && wtRaw && wtOut[1] !== wtRaw[1]) {
    errors.push(`⚖️ Weight ${wtOut[1]}g likha hai, raw me ${wtRaw[1]}g hai`);
  }
  // AI ne weight KHUD to nahi banaya? Output ka number raw me akela khada hona chahiye
  if (wtOut && !wtRaw && !new RegExp(`(?<!\\d)${wtOut[1]}(?!\\d)`).test(rawText)) {
    errors.push(`⚖️ Weight ${wtOut[1]}g output me hai lekin raw me KAHIN nahi — AI ne khud banaya lag raha hai!`);
  }

  // --- CHECK 6: Pincode → State verify ---
  if (pin) {
    const validStates = PIN_STATE[parseInt(pin.substring(0, 2))];
    if (validStates) {
      const stateOk = validStates.some((s) => cleanedText.toLowerCase().includes(s.toLowerCase()));
      if (!stateOk) warnings.push(`🗺️ Pincode ${pin} ke hisab se state "${validStates.join(" / ")}" hona chahiye`);
    }
  }

  return { lines, errors, warnings, cleaned: lines.join("\n") };
}

// ============================================================
//  3) GOOGLE SHEETS ENTRY
// ============================================================
// Google Sheets ki limit: 60 write/minute. Quota-error aaye to RUK kar dobara try karo
// (5 baar tak — 5s, 15s, 30s, 60s, 90s). Address kabhi kho na jaye.
async function appendOneRow(raw, cleaned, status, note) {
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const waits = [5000, 15000, 30000, 60000, 90000];

  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!A:E`,
        valueInputOption: "RAW",
        requestBody: { values: [[raw, cleaned, now, status, note || ""]] },
      });
      return; // ho gaya
    } catch (e) {
      const msg = String(e && e.message);
      const isQuota =
        /quota|rate limit|rateLimitExceeded|userRateLimitExceeded|429|500|503|backend/i.test(msg);
      if (!isQuota || attempt === waits.length) throw e;
      console.log(`⏳ Sheets quota — ${waits[attempt] / 1000}s ruk kar dobara try (${attempt + 1}/${waits.length})`);
      await sleep(waits[attempt]);
    }
  }
}

async function appendRowsToSheet(entries) {
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:D`,
    valueInputOption: "RAW",
    requestBody: { values: entries.map((e) => [e.raw, e.cleaned, now, e.status]) },
  });
}

// ============================================================
//  4) BOT HANDLERS — SILENT AUTO-SAVE
//  Address aaya → clean → verify → SEEDHA Sheet me.
//  Jawab SIRF do case me:
//    (1) PPD  → 🚫 batao, Sheet me save NAHI
//    (2) Phone/Pincode/COD MISSING → ⚠️ batao, Sheet me "CHECK" ke saath save
//  Baaki sab → bilkul chup, Sheet me "OK"
// ============================================================
bot.start((ctx) =>
  ctx.reply(
    "🙏 Serdiya Address Bot v9.8 (Auto-Save)\n\n" +
      "Bas address bhej do (TEXT ya PHOTO 📷) — main khud clean karke SEEDHA Sheet me daal dunga.\n\n" +
      "Jawab sirf tab aayega jab:\n" +
      "🚫 PPD parcel ho (save nahi hoga)\n" +
      "⚠️ Phone / Pincode / COD missing ho (Sheet me CHECK likha jayega)\n\n" +
      "🔁 Apna bheja message EDIT karo — sudhra version dobara Sheet me chala jayega."
  )
);

// ---------------- Address processing queue ----------------
const queue = [];
let working = false;

async function processQueue() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await handleAddress(job.ctx, job.raw, job.photo, job.isEdit);
    } catch (e) {
      console.error("Queue error:", e.message);
    }
    // 1.2s gap — Google Sheets ki 60 write/minute limit ke andar rehne ke liye
    if (queue.length) await sleep(1200);
  }
  working = false;
}

// Apna Telegram ID jaanne ke liye — ye SABKE liye chalta hai, taaki aap kisi ko
// /id bhejne ko bol kar uska ID lekar ADMIN_IDS me jod sako.
bot.command("id", (ctx) =>
  ctx.reply(
    `🆔 Aapka Telegram ID: ${ctx.from.id}\n` +
      (isAdmin(ctx) ? "✅ Aap ADMIN ho — aapke address Sheet me jayenge." :
        "🚫 Aap admin nahi ho — aapke message Sheet me NAHI jate.")
  )
);

bot.on("text", (ctx) => {
  if (!isAdmin(ctx)) return skipNonAdmin(ctx);
  const raw = ctx.message.text || "";
  if (raw.startsWith("/")) return; // commands ko chhodo
  if (!/\d/.test(raw) || raw.trim().split("\n").length < 2) return; // bakwas message skip
  queue.push({ ctx, raw });
  processQueue();
});

bot.on("photo", (ctx) => {
  if (!isAdmin(ctx)) return skipNonAdmin(ctx);
  const photos = ctx.message.photo;
  queue.push({ ctx, raw: null, photo: photos[photos.length - 1].file_id });
  processQueue();
});

// Apna bheja message EDIT kiya → naya version dobara Sheet me
bot.on("edited_message", (ctx) => {
  if (!isAdmin(ctx)) return skipNonAdmin(ctx);
  const raw = ctx.editedMessage?.text;
  if (!raw || raw.startsWith("/")) return;
  queue.push({ ctx, raw, isEdit: true });
  processQueue();
});

// Admin ke alawa koi bhi — message BILKUL nahi padha jata, Sheet me kuch nahi jata.
// Sirf Render ke log me dikh jata hai ki kisne bheja tha.
function skipNonAdmin(ctx) {
  const u = ctx.from || {};
  const naam = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "?";
  console.log(`🚫 Admin nahi — andekha kiya: ${naam} (ID: ${u.id})`);
}

// ============================================================
//  MAIN — ek address ko poora process karke Sheet me daalo
// ============================================================
async function handleAddress(ctx, raw, photoFileId, isEdit) {
  // ---------- PHOTO: pehle vision se text nikaalo ----------
  if (photoFileId) {
    try {
      const link = await ctx.telegram.getFileLink(photoFileId);
      raw = await visionTranscribe(link.href);
    } catch (e) {
      return tgRetry(() =>
        ctx.reply("❌ Photo padhne me dikkat: " + e.message.substring(0, 120), {
          reply_parameters: { message_id: ctx.message.message_id },
        })
      );
    }
    if (!raw || !/\d{6}/.test(raw.replace(/\s/g, ""))) {
      return tgRetry(() =>
        ctx.reply("⚠️ Photo me address/pincode nahi mila. Saaf photo bhejo ya text me likho.", {
          reply_parameters: { message_id: ctx.message.message_id },
        })
      );
    }
  }

  const msgId = ctx.message?.message_id || ctx.editedMessage?.message_id;
  const replyTo = msgId ? { reply_parameters: { message_id: msgId } } : {};

  // ---------- 🚫 PPD — Sheet me KABHI nahi ----------
  if (/\bp\.?\s?p\.?\s?d\.?\b/i.test(raw) || /pre\s*-?\s*paid/i.test(raw)) {
    return tgRetry(() =>
      ctx.reply("🚫 *PPD (PREPAID) PARCEL*\n\nSheet me save NAHI kiya — ise alag handle karo 🙏", {
        parse_mode: "Markdown",
        ...replyTo,
      })
    );
  }

  // ---------- STEP 1: Regex clean ----------
  let cleaned = regexParse(raw);
  // Devanagari TURANT Hinglish karo — taaki aage ka "AI ne kya hataya" check
  // Roman-vs-Roman ho aur Hindi lines chup-chaap gayab na ho jaaye
  if (/[\u0900-\u097F]/.test(cleaned)) cleaned = titleCaseHinglish(devToHinglish(cleaned));
  let { errors, warnings } = validate(raw, cleaned);

  // ---------- STEP 2: AI sirf MUSHKIL addresses pe ----------
  const hasIndicScript = /[\u0900-\u0D7F]/.test(cleaned);
  if (OPENAI_API_KEY && (errors.length > 0 || naamMashed(cleaned) || hasIndicScript)) {
    try {
      const aiRawOut = await geminiParse(raw);
      let gParsed = regexParse(aiRawOut);
      if (/[\u0900-\u097F]/.test(gParsed)) gParsed = titleCaseHinglish(devToHinglish(gParsed));
      const sc = scrubSenderFromCleaned(gParsed, raw); // AI ka banaya fake "Near <sender>" hatao
      if (sc.removed) gParsed = sc.text;
      // 🚨 AI ne jhootha District/State/PO gadha ho to hatao
      const fab = stripFabricatedLabels(gParsed, raw);
      gParsed = fab.text;

      const gRes = validate(raw, gParsed);
      const chk = aiMissingLines(cleaned, gParsed);
      // AI ne ASLI address ka hissa kha liya (Pushpak Courier Office jaisa)? To AI ka
      // version mat lo — regex wala safe rakho.
      const bigLoss = chk.lines.length > 0;
      if (gRes.errors.length <= errors.length && !bigLoss) {
        ({ errors, warnings, cleaned } = gRes);
        if (fab.removed.length) warnings.push(`AI ne khud gadha tha, hataya: ${fab.removed.join(" | ")}`);
      } else if (bigLoss) {
        warnings.push(`AI ne ye hata diya tha (${chk.lines.join(" | ")}) — isliye REGEX wala version rakha`);
      }
    } catch (e) {
      console.log("AI skip:", e.message);
    }
  }

  // ---------- STEP 2B: Devanagari BACHA ho to code se Hinglish (AI fail-safe) ----------
  if (/[\u0900-\u097F]/.test(cleaned)) {
    const before = cleaned;
    cleaned = devToHinglish(cleaned);
    cleaned = titleCaseHinglish(cleaned);
    if (before !== cleaned) console.log("🔤 Hindi → Hinglish (code se)");
  }

  // ---------- 🚨 GADHA HUA WEIGHT hatao (kisi bhi source se aaya ho) ----------
  {
    const fw = stripFakeWeight(cleaned, raw);
    if (fw.removed) {
      cleaned = fw.text;
      console.log("⚖️ Nakli weight hataya:", fw.removed);
    }
  }

  // ---------- STEP 3: Seekhe hue spelling-sudhaar lagao ----------
  {
    const la = applyLearning(cleaned);
    if (la.applied.length) cleaned = la.text;
  }

  // ---------- STEP 3b: Address ko 100 character me fit karo (v9.8) ----------
  // Booking ke time lamba address KAT jata hai. Naam / phone / pincode / COD / weight
  // ko haath nahi lagta — sirf beech ka ASLI address chhota hota hai, aur wo bhi
  // TABHI jab 100 se bada ho. (validate() upar hi ho chuka hai — poore address par.)
  {
    const fit = fitAddress(cleaned);
    if (fit !== cleaned) {
      const was = splitParts(cleaned).addr.join("\n").length;
      const now = splitParts(fit).addr.join("\n").length;
      console.log(`📏 Address chhota kiya: ${was} → ${now} chars`);
      cleaned = fit;
    }
  }

  // ---------- STEP 4: Sheet me SEEDHA save ----------
  // NOTE (v7.2): India Post pincode-milaan poori tarah BAND.
  // Reseller ka likha pincode hi final hai — bot na suggestion deta hai, na warning.
  const hardErrors = errors.filter((e) =>
    /phone|pincode|COD amount|MISSING|NAHI mila|nahi mila/i.test(e)
  );
  const status = hardErrors.length ? "CHECK" : "OK";
  const note = hardErrors.join(" | ").substring(0, 400);

  try {
    await appendOneRow(raw, cleaned, status, note);
  } catch (e) {
    console.error("Sheet save fail:", e.message);
    const quota = /quota|rate limit|429/i.test(String(e && e.message));
    const msg = quota
      ? "⚠️ *Ye address Sheet me NAHI gaya* — Google ki limit lag gayi (ek minute me bahut saare address).\n\n🔁 Thodi der baad ise DOBARA bhej do."
      : "❌ *Sheet me save nahi ho paya:* " + String(e.message).substring(0, 150) + "\n\n🔁 Ise dobara bhej do.";
    return tgRetry(() => ctx.reply(msg, { parse_mode: "Markdown", ...replyTo }));
  }

  // ---------- STEP 6: Jawab SIRF error pe ----------
  if (hardErrors.length) {
    let msg = "⚠️ *SHEET ME GAYA — LEKIN CHECK KARO:*\n\n";
    msg += hardErrors.map((e) => "• " + e).join("\n");
    msg += "\n\n```\n" + cleaned + "\n```";
    msg += "\n🔁 Sudharna ho to apna message EDIT kar do — naya version Sheet me chala jayega.";
    return tgRetry(() => ctx.reply(msg, { parse_mode: "Markdown", ...replyTo }));
  }

  // Sab theek → BILKUL CHUP (koi reply nahi)
  console.log(`✅ Saved [${status}]: ${cleaned.split("\n")[0]}`);
}

const app = express();
app.get("/", (req, res) => res.send("Serdiya Address Bot v9.8 chal raha hai ✅"));
app.listen(process.env.PORT || 3000, () => console.log("Health server up"));

// Crash protection — koi bhi unhandled error process ko band NAHI karega
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e?.message || e));
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e?.message || e));

initLearning(); // Launch se PEHLE — 409 deploy-overlap aaye to bhi learning zaroor chale
bot.launch()
  .then(() => console.log("🤖 Serdiya Address Bot v9.8 MASTER LIVE — Auto-Save + Hinglish + anti-hallucination"))
  .catch((e) => console.log("⚠️ Launch me dikkat (deploy overlap — apne aap theek ho jata hai):", e.message));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
