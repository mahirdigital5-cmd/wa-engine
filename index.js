import fs from "fs";
import express from "express";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

import P from "pino";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

let sockInstance = null;
let latestQR = null;
let isConnected = false;
let isStarting = false;
let reconnectTimer = null;
const followupTimers = new Map();
const followupStates = new Map();

// Buffer chat customer supaya beberapa chat cepat
// bisa digabung jadi satu proses trigger.
const pendingMessageBuffers = new Map();

// Antrean proses per nomor.
// Ini mencegah trigger tabrakan saat customer kirim chat baru
// sebelum jawaban trigger sebelumnya selesai terkirim semua.
const messageProcessQueues = new Map();

// Riwayat chat pendek per nomor.
// Dipakai hanya sebagai konteks bantu, bukan untuk memaksa trigger keluar.
const recentChatHistories = new Map();
const MAX_RECENT_CHAT_HISTORY = 10;

const AFFIRMATIVE_WORDS = [
  "iya",
  "ya",
  "y",
  "ok",
  "oke",
  "sip",
  "siap",
  "lanjut",
  "boleh",
  "gas",
  "silahkan",
  "setuju",
];

const NEGATIVE_WORDS = [
  "tidak",
  "nggak",
  "gak",
  "ga",
  "batal",
  "gajadi",
  "engga",
  "enggak",
];

const TRIGGER_API = "https://chat-bot-nexis.vercel.app/api/triggers";
const ANSWER_SEPARATOR = "\n---JAWABAN_BARU---\n";

// Folder session WA.
// Kalau di Railway/VPS, sebaiknya set env SESSION_DIR ke folder persistent,
// contoh: /data/session
// Dengan begitu saat deploy/update, WhatsApp tidak perlu scan ulang selama folder session aman.
const SESSION_DIR = process.env.SESSION_DIR || "session";
const AUTO_START_BOT = process.env.AUTO_START_BOT !== "false";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[?.,!]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bbrp\b/g, "berapa")
    .replace(/\bbrpa\b/g, "berapa")
    .replace(/\bbrapa\b/g, "berapa")
    .replace(/\bbrpnya\b/g, "berapanya")
    .replace(/\bharga nya\b/g, "harganya")
    .replace(/\s+/g, " ")
    .trim();
}

function isPriceQuestion(text = "") {
  const normalized = normalizeText(text);

  const priceWords = [
    "berapa",
    "harga",
    "harganya",
    "biaya",
    "tarif",
    "price",
    "duit",
    "bayar",
    "ongkir",
  ];

  return priceWords.some((word) => normalized.includes(word));
}

function isPriceTrigger(keyword = "") {
  const normalized = normalizeText(keyword);

  const priceTriggerWords = [
    "berapa harganya",
    "harganya",
    "harga",
    "berapa harga",
    "biaya",
    "tarif",
    "price",
  ];

  return priceTriggerWords.some((word) => normalized.includes(word));
}

function isShippingQuestion(text = "") {
  const normalized = normalizeText(text);

  const shippingWords = [
    "ongkir",
    "ongkos kirim",
    "ongkos",
    "kirim",
    "pengiriman",
    "cod",
    "alamat",
    "area",
    "wilayah",
    "daerah",
    "kecamatan",
    "kec",
    "kota",
    "kabupaten",
    "kab",
    "provinsi",
    "balikpapan",
    "samarinda",
  ];

  const hasShippingWord = shippingWords.some((word) =>
    normalized.includes(normalizeText(word))
  );

  // Contoh: "ke balikpapan tengah berapa ka"
  const startsWithDestination =
    /\bke\s+[a-zA-Z\s]+\b/.test(normalized) && normalized.includes("berapa");

  return hasShippingWord || startsWithDestination;
}

function isShippingTrigger(keyword = "") {
  const normalized = normalizeText(keyword);

  const shippingTriggerWords = [
    "ongkir",
    "ongkos kirim",
    "ongkos",
    "kirim",
    "pengiriman",
    "cod",
    "alamat",
    "area",
    "wilayah",
    "daerah",
  ];

  return shippingTriggerWords.some((word) =>
    normalized.includes(normalizeText(word))
  );
}

function isProductPriceQuestion(text = "") {
  const normalized = normalizeText(text);

  // Kalau chat sedang membahas ongkir/area, jangan langsung dianggap harga produk.
  if (isShippingQuestion(normalized)) return false;

  const productPricePatterns = [
    "harga",
    "harganya",
    "berapa harga",
    "berapa harganya",
    "price",
    "tarif produk",
    "biaya produk",
  ];

  return productPricePatterns.some((pattern) =>
    normalized.includes(normalizeText(pattern))
  );
}

function isProductPriceTrigger(keyword = "") {
  const normalized = normalizeText(keyword);

  if (isShippingTrigger(normalized)) return false;

  return isPriceTrigger(normalized);
}

function rememberRecentChat(phone, text) {
  const current = recentChatHistories.get(phone) || [];
  const next = [
    ...current,
    {
      text: String(text || ""),
      normalized: normalizeText(text),
      at: Date.now(),
    },
  ].slice(-MAX_RECENT_CHAT_HISTORY);

  recentChatHistories.set(phone, next);
}

function getRecentChatContext(phone, currentText = "") {
  const history = recentChatHistories.get(phone) || [];
  const currentNormalized = normalizeText(currentText);

  return history
    .map((item) => item.normalized)
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .filter((item) => item !== currentNormalized)
    .slice(-MAX_RECENT_CHAT_HISTORY)
    .join(" ");
}

function hasAreaPlaceholder(value = "") {
  return normalizeText(value).includes("area");
}

function keywordHasAreaPlaceholder(keyword = "") {
  return String(keyword || "").toLowerCase().includes("[area]");
}

function keywordHasQtyPlaceholder(keyword = "") {
  const raw = String(keyword || "").toLowerCase();

  return (
    raw.includes("[qty]") ||
    raw.includes("[jumlah]") ||
    raw.includes("[pcs]")
  );
}

function isQtyQuestion(text = "") {
  const normalized = normalizeText(text);

  const qtyWords = [
    "pcs",
    "pc",
    "biji",
    "buah",
    "unit",
    "qty",
    "jumlah",
    "pesan",
    "pesen",
    "order",
    "ambil",
    "beli",
    "mau",
    "paket",
  ];

  const hasQtyWord = qtyWords.some((word) => normalized.includes(word));
  const hasNumber = /\b\d{1,2}\b/.test(normalized);
  const hasWordNumber = [
    "satu",
    "dua",
    "tiga",
    "empat",
    "lima",
    "enam",
    "tujuh",
    "delapan",
    "sembilan",
    "sepuluh",
  ].some((word) => normalized.split(" ").includes(word));

  return hasQtyWord && (hasNumber || hasWordNumber);
}

function matchQtyPlaceholderKeyword(text = "", keyword = "") {
  if (!keywordHasQtyPlaceholder(keyword)) return false;

  return extractQty(text) !== null || isQtyQuestion(text);
}

function getAllCheckoutAreas(flows = []) {
  const areas = [];

  for (const flow of flows || []) {
    const checkout = parseJsonMaybe(flow?.checkout, {});
    const shippingByArea = checkout?.shippingByArea || {};

    for (const area of Object.keys(shippingByArea)) {
      const normalizedArea = normalizeText(area);
      if (normalizedArea) areas.push(normalizedArea);
    }
  }

  return [...new Set(areas)];
}

function textContainsCheckoutArea(text = "", flows = []) {
  const normalized = normalizeText(text);
  const areas = getAllCheckoutAreas(flows);

  return areas.some((area) => normalized.includes(area));
}

function getAreaPlaceholderRegex(keyword = "") {
  const escaped = normalizeText(keyword)
    .replace(/\barea\b/g, "__AREA__")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/__AREA__/g, "(.+?)")
    .replace(/\s+/g, "\\s+");

  return new RegExp(`^${escaped}$`, "i");
}

function matchAreaPlaceholderKeyword(text = "", keyword = "", flows = []) {
  if (!keywordHasAreaPlaceholder(keyword)) return false;

  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword).replace(/\barea\b/g, "").trim();

  const hasKnownArea = textContainsCheckoutArea(normalizedText, flows);

  // Cocokkan pola seperti:
  // "ke [area]" -> "ke balikpapan tengah"
  // "[area] berapa" -> "balikpapan tengah berapa"
  const regex = getAreaPlaceholderRegex(keyword);
  const regexMatch = regex.test(normalizedText);

  if (regexMatch) return true;

  // Kalau ada kata tetap dari keyword + area yang dikenal, anggap cocok.
  const fixedWords = normalizedKeyword
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word !== "area");

  const fixedWordsMatch =
    fixedWords.length === 0 ||
    fixedWords.every((word) => normalizedText.includes(word));

  if (hasKnownArea && fixedWordsMatch) return true;

  // Contoh: customer hanya chat "Balikpapan Tengah berapa ka"
  // keyword: "ke [area]" tetap boleh cocok karena area dikenal + ada kata "berapa".
  if (hasKnownArea && normalizedText.includes("berapa")) return true;

  return false;
}

function getResponseParts(response = "") {
  const raw = String(response || "");

  // Format baru dari dashboard:
  // enter biasa tetap bagian dari 1 jawaban, bukan pemecah jawaban.
  if (raw.includes(ANSWER_SEPARATOR.trim())) {
    return raw
      .split(ANSWER_SEPARATOR.trim())
      .map((item) => item.trim())
      .filter(Boolean);
  }

  // Legacy untuk trigger lama yang belum disimpan ulang.
  return raw
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueTriggers(list) {
  const seen = new Set();

  return list.filter((item) => {
    if (!item?.id) return false;
    if (seen.has(item.id)) return false;

    seen.add(item.id);
    return true;
  });
}

function getMediaList(found) {
  if (Array.isArray(found.media)) {
    return found.media.filter((item) => item?.url);
  }

  if (typeof found.media === "string") {
    try {
      const parsed = JSON.parse(found.media);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => item?.url);
      }
    } catch (err) {
      console.log("MEDIA JSON INVALID:", err?.message);
      return [];
    }
  }

  return [];
}

function getMediaResponseIndex(media) {
  const value = Number(media?.responseIndex);

  if (Number.isInteger(value) && value >= 0) {
    return value;
  }

  return null;
}

async function sendMedia(sock, jid, media) {
  const mediaUrl = String(media.url || "").trim();
  const mediaType = String(media.type || "image").toLowerCase();

  if (!mediaUrl) return;

  if (mediaType === "video") {
    await sock.sendMessage(jid, {
      video: {
        url: mediaUrl,
      },
    });

    console.log("VIDEO DIKIRIM:", mediaUrl);
  } else {
    await sock.sendMessage(jid, {
      image: {
        url: mediaUrl,
      },
    });

    console.log("GAMBAR DIKIRIM:", mediaUrl);
  }
}

async function sendResponseWithMedia(sock, jid, responseParts, mediaList) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const legacyMedia = mediaList.filter(
    (media) => getMediaResponseIndex(media) === null
  );

  const indexedMedia = mediaList.filter(
    (media) => getMediaResponseIndex(media) !== null
  );

  for (const media of legacyMedia) {
    await sendMedia(sock, jid, media);
    await wait(450);
  }

  for (let i = 0; i < responseParts.length; i++) {
    const mediaForAnswer = indexedMedia.filter(
      (media) => getMediaResponseIndex(media) === i
    );

    for (const media of mediaForAnswer) {
      await sendMedia(sock, jid, media);
      await wait(650);
    }

    const part = responseParts[i];

    if (part) {
      await sock.sendMessage(jid, {
        text: part,
      });

      console.log("BALASAN TEXT DIKIRIM:", part);
      await wait(650);
    }
  }

  const extraMedia = indexedMedia.filter((media) => {
    const index = getMediaResponseIndex(media);
    return index >= responseParts.length;
  });

  for (const media of extraMedia) {
    await sendMedia(sock, jid, media);
    await wait(450);
  }

  if (responseParts.length === 0 && indexedMedia.length > 0) {
    for (const media of indexedMedia) {
      await sendMedia(sock, jid, media);
      await wait(650);
    }
  }
}

function getFollowupList(found) {
  if (Array.isArray(found?.followups)) {
    return found.followups.filter((item) => item?.active !== false && item?.message);
  }

  if (typeof found?.followups === "string") {
    try {
      const parsed = JSON.parse(found.followups);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => item?.active !== false && item?.message);
      }
    } catch (err) {
      console.log("FOLLOWUP JSON INVALID:", err?.message);
      return [];
    }
  }

  return [];
}

function cancelFollowups(jid) {
  const timers = followupTimers.get(jid) || [];

  for (const timer of timers) {
    clearTimeout(timer);
  }

  followupTimers.delete(jid);
  followupStates.delete(jid);

  if (timers.length > 0) {
    console.log("FOLLOW UP DIBATALKAN KARENA CUSTOMER MEMBALAS:", jid);
  }
}

function scheduleFollowups(sock, jid, found) {
  const followups = getFollowupList(found);

  if (followups.length === 0) return;

  cancelFollowups(jid);

  const token = `${Date.now()}-${Math.random()}`;
  const timers = [];

  followupStates.set(jid, {
    token,
    triggerId: found.id,
  });

  let accumulatedDelayMs = 0;

  followups.forEach((followup, index) => {
    const delayMinutes = Number(followup.delayMinutes) > 0
      ? Number(followup.delayMinutes)
      : 1;

    accumulatedDelayMs += delayMinutes * 60 * 1000;

    const timer = setTimeout(async () => {
      try {
        const state = followupStates.get(jid);

        if (!state || state.token !== token) {
          console.log("FOLLOW UP SKIP KARENA STATE BERUBAH:", jid);
          return;
        }

        await sock.sendMessage(jid, {
          text: String(followup.message || "").trim(),
        });

        console.log(
          `FOLLOW UP ${index + 1} DIKIRIM SETELAH ${delayMinutes} MENIT:`,
          jid
        );

        if (index === followups.length - 1) {
          followupTimers.delete(jid);
          followupStates.delete(jid);
        }
      } catch (err) {
        console.log("FOLLOW UP ERROR:", err?.message);
      }
    }, accumulatedDelayMs);

    timers.push(timer);
  });

  followupTimers.set(jid, timers);

  console.log("FOLLOW UP DIJADWALKAN:", {
    jid,
    total: followups.length,
  });
}

function parseJsonMaybe(value, fallback = {}) {
  if (!value) return fallback;

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  return value || fallback;
}

function formatRupiah(value) {
  const number = Number(value) || 0;
  if (number >= 1000 && number % 1000 === 0) {
    return `${number / 1000}rb`;
  }

  return `Rp ${number.toLocaleString("id-ID")}`;
}

function getFlowCheckout(flows, flowId) {
  const flow = (flows || []).find((item) => String(item.id) === String(flowId));
  const checkout = parseJsonMaybe(flow?.checkout, {});

  if (checkout?.enabled !== true) return null;

  return {
    enabled: true,
    productName: checkout.productName || flow?.name || "Produk",
    price1: Number(checkout.price1) || 0,
    price2: Number(checkout.price2) || 0,
    priceExtra: Number(checkout.priceExtra) || 0,
    defaultShipping: Number(checkout.defaultShipping) || 0,
    shippingByArea: checkout.shippingByArea || {},
  };
}

function isAffirmative(text) {
  const words = normalizeText(text).split(" ");
  return AFFIRMATIVE_WORDS.some((word) => words.includes(word));
}

function isNegative(text) {
  const normalized = normalizeText(text);
  return NEGATIVE_WORDS.some((word) => normalized.includes(word));
}

function looksLikeAddress(text) {
  const normalized = normalizeText(text);

  const addressWords = [
    "jl",
    "jalan",
    "rt",
    "rw",
    "blok",
    "no",
    "nomor",
    "desa",
    "dusun",
    "kelurahan",
    "kecamatan",
    "kabupaten",
    "kota",
    "provinsi",
    "patokan",
    "rumah",
    "gang",
    "gg",
  ];

  return addressWords.some((word) => normalized.includes(word));
}

function extractQty(text) {
  const raw = String(text || "");
  const normalized = normalizeText(raw);

  const quantityWords = [
    "pcs",
    "pc",
    "biji",
    "buah",
    "unit",
    "qty",
    "jumlah",
    "pesan",
    "pesen",
    "order",
    "ambil",
    "beli",
    "mau",
    "paket",
  ];

  const addressWords = [
    "jl",
    "jalan",
    "no",
    "nomor",
    "rt",
    "rw",
    "blok",
    "gang",
    "gg",
    "kelurahan",
    "kecamatan",
    "kabupaten",
    "kota",
    "provinsi",
    "patokan",
    "rumah",
  ];

  const hasQuantityIntent = quantityWords.some((word) =>
    normalized.includes(word)
  );

  const hasAddressIntent = addressWords.some((word) =>
    normalized.split(" ").includes(word)
  );

  // Kalau chat terlihat seperti alamat dan tidak ada kata yang jelas menunjukkan jumlah,
  // jangan ambil angka dari alamat seperti No. 54 / RT 29 / RW 05 sebagai qty.
  if (hasAddressIntent && !hasQuantityIntent) {
    return null;
  }

  // Ambil angka hanya kalau dekat dengan kata qty.
  // Contoh: "2 pcs", "pcs 2", "ambil 3", "mau 2".
  const quantityPatterns = [
    /\b(\d{1,2})\s*(pcs|pc|biji|buah|unit|paket)\b/i,
    /\b(qty|jumlah|pesan|pesen|order|ambil|beli|mau)\s*(\d{1,2})\b/i,
    /\b(\d{1,2})\s*(qty|jumlah)\b/i,
    /\b(\d{1,2})\s*(brp|berapa)\b/i,
  ];

  for (const pattern of quantityPatterns) {
    const match = raw.match(pattern);
    if (match) {
      const value = Number(match[1] || match[2]);
      if (value > 0 && value <= 99) return value;
    }
  }

  const wordMap = {
    satu: 1,
    dua: 2,
    tiga: 3,
    empat: 4,
    lima: 5,
    enam: 6,
    tujuh: 7,
    delapan: 8,
    sembilan: 9,
    sepuluh: 10,
  };

  // Angka berbentuk kata hanya dipakai jika ada niat jumlah.
  if (hasQuantityIntent) {
    for (const [word, number] of Object.entries(wordMap)) {
      if (normalized.split(" ").includes(word)) return number;
    }
  }

  return null;
}

function calculateProductPrice(checkout, qty) {
  const quantity = Number(qty) || 1;

  if (quantity <= 1) return checkout.price1;
  if (quantity === 2) return checkout.price2 || checkout.price1 * 2;

  const baseTwo = checkout.price2 || checkout.price1 * 2;
  const extra = checkout.priceExtra || checkout.price1;

  return baseTwo + (quantity - 2) * extra;
}

function extractArea(text, checkout) {
  const normalized = normalizeText(text);
  const shippingByArea = checkout?.shippingByArea || {};

  // Prioritas 1: cocok dengan daftar ongkir per area di checkout.
  for (const area of Object.keys(shippingByArea)) {
    if (normalized.includes(normalizeText(area))) return area;
  }

  // Prioritas 2: pola umum customer.
  // Contoh:
  // "ke balikpapan tengah berapa ka"
  // "ongkir ke samarinda berapa"
  // "di kecamatan balikpapan tengah"
  const destinationPatterns = [
    /(?:ke|di|untuk|tujuan)\s+([a-zA-Z\s]+?)(?:\s+berapa|\s+ongkir|\s+ka|\s+kak|\s+min|$)/i,
    /(?:ongkir|kirim|cod)\s+(?:ke\s+)?([a-zA-Z\s]+?)(?:\s+berapa|\s+ka|\s+kak|\s+min|$)/i,
    /([a-zA-Z\s]+?)\s+(?:berapa|ongkir)/i,
    /kecamatan\s+([a-zA-Z\s]+)/i,
    /kec\s+([a-zA-Z\s]+)/i,
    /kota\s+([a-zA-Z\s]+)/i,
    /kabupaten\s+([a-zA-Z\s]+)/i,
    /kab\s+([a-zA-Z\s]+)/i,
  ];

  for (const pattern of destinationPatterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) {
      const cleaned = normalizeText(match[1])
        .replace(/\b(kak|ka|min|admin|berapa|ongkir|cod)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (cleaned) {
        // Kalau hasil ekstrak mengandung area yang ada di setting, pakai nama settingnya.
        for (const area of Object.keys(shippingByArea)) {
          if (cleaned.includes(normalizeText(area))) return area;
        }

        return cleaned.split(" ").slice(0, 3).join(" ");
      }
    }
  }

  return "";
}

function getShippingPrice(checkout, area) {
  const shippingByArea = checkout?.shippingByArea || {};
  const normalizedArea = normalizeText(area);

  for (const [key, value] of Object.entries(shippingByArea)) {
    if (
      normalizeText(key) === normalizedArea ||
      normalizedArea.includes(normalizeText(key))
    ) {
      return Number(value) || checkout.defaultShipping || 0;
    }
  }

  return checkout.defaultShipping || 0;
}

function getCheckoutTotal(checkout, qty, area) {
  const productTotal = calculateProductPrice(checkout, qty);
  const shipping = getShippingPrice(checkout, area);

  return {
    productTotal,
    shipping,
    total: productTotal + shipping,
  };
}

function getCheckoutVariables(checkout, state = {}) {
  const qty = Number(state.qty) || 1;
  const area = state.area || "";
  const totals = getCheckoutTotal(checkout, qty, area);
  const pesanan = `${checkout.productName} ${qty} pcs`;

  return {
    area: area || "sesuai alamat",
    qty,
    produk: checkout.productName,
    subtotal: formatRupiah(totals.productTotal),
    ongkir: formatRupiah(totals.shipping),
    total: formatRupiah(totals.total),
    harga: formatRupiah(totals.total),
    nama: state.name || "-",
    alamat: state.address || "-",
    pesanan,
  };
}

function renderCheckoutPlaceholder(text, checkout, state = {}) {
  if (!checkout) return text;

  const variables = getCheckoutVariables(checkout, state);

  return String(text || "").replace(/\[([a-zA-Z_]+)\]/g, (match, key) => {
    return variables[key] !== undefined ? String(variables[key]) : match;
  });
}

function cleanAddressText(text) {
  return String(text || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(", ");
}

function extractName(text) {
  const raw = String(text || "");
  const namePatterns = [
    /nama\s*[:\-]?\s*([a-zA-Z\s]+)/i,
    /atas nama\s*[:\-]?\s*([a-zA-Z\s]+)/i,
  ];

  for (const pattern of namePatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      return match[1].trim().split(/\s+/).slice(0, 4).join(" ");
    }
  }

  return "";
}

async function updateSessionCheckout(phone, checkout) {
  try {
    await safeJsonFetch(`${TRIGGER_API}?t=${Date.now()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone,
        checkout,
      }),
    });
  } catch (err) {
    console.log("GAGAL UPDATE CHECKOUT:", err?.message);
  }
}

function getSessionCheckoutState(session) {
  return parseJsonMaybe(session?.checkout, {});
}

function mergeCheckoutState(session, nextState = {}) {
  const current = getSessionCheckoutState(session);

  const merged = {
    ...current,
    ...nextState,
    updated_at: new Date().toISOString(),
  };

  if (!merged.qty || Number(merged.qty) <= 0) {
    merged.qty = 1;
  }

  return merged;
}

async function saveCheckoutState(phone, session, nextState = {}) {
  const merged = mergeCheckoutState(session, nextState);

  await updateSessionCheckout(phone, merged);

  return merged;
}

async function handleCheckoutMessage(sock, jid, text, session, flows) {
  // Semua balasan harus berasal dari trigger yang dibuat di dashboard.
  // Function ini sengaja tidak mengirim pesan otomatis supaya tidak membuat template sendiri.
  return false;
}

async function safeJsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    console.log("RESPONSE BUKAN JSON");
    console.log("URL:", url);
    console.log("STATUS:", res.status);
    console.log("BODY:", text.slice(0, 500));

    throw new Error(
      `API tidak membalas JSON. Status ${res.status}. Body: ${text.slice(
        0,
        120
      )}`
    );
  }

  if (!res.ok) {
    throw new Error(
      data?.error || data?.message || `Request gagal dengan status ${res.status}`
    );
  }

  return data;
}

async function updateSessionFlow(phone, flowId) {
  try {
    await safeJsonFetch(`${TRIGGER_API}?t=${Date.now()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone,
        flow_id: flowId,
      }),
    });

    console.log("SESSION FLOW DIUPDATE:", flowId);
  } catch (err) {
    console.log("GAGAL UPDATE SESSION:", err?.message);
  }
}

function enqueueMessageProcess(phone, task) {
  const previous = messageProcessQueues.get(phone) || Promise.resolve();

  const current = previous
    .catch((err) => {
      console.log("QUEUE SEBELUMNYA ERROR:", err?.message);
    })
    .then(task)
    .catch((err) => {
      console.log("QUEUE PROCESS ERROR:", err?.message);
    })
    .finally(() => {
      if (messageProcessQueues.get(phone) === current) {
        messageProcessQueues.delete(phone);
      }
    });

  messageProcessQueues.set(phone, current);

  return current;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function stopSocket() {
  try {
    if (sockInstance) {
      try {
        sockInstance.ev.removeAllListeners();
      } catch {}

      try {
        sockInstance.end();
      } catch {}
    }
  } catch {}

  sockInstance = null;
  isConnected = false;

  // Jangan hapus folder session di sini.
  // Stop socket hanya memutus proses sementara, bukan logout WA.
}

async function startBot() {
  if (isStarting) return;

  isStarting = true;

  try {
    clearReconnectTimer();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: "silent" }),
      browser: ["ChatBotNexis", "Chrome", "1.0.0"],
      printQRInTerminal: false,
    });

    sockInstance = sock;
    isStarting = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log("CONNECTION UPDATE:", {
        connection,
        hasQR: !!qr,
      });

      if (qr) {
        latestQR = await QRCode.toDataURL(qr);
        isConnected = false;
        console.log("QR BERHASIL DIGENERATE");
      }

      if (connection === "open") {
        console.log("WHATSAPP TERHUBUNG");
        latestQR = null;
        isConnected = true;
      }

      if (connection === "close") {
        isConnected = false;

        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log("KONEKSI PUTUS");
        console.log("STATUS CODE:", statusCode);

        if (shouldReconnect) {
          clearReconnectTimer();

          reconnectTimer = setTimeout(() => {
            startBot();
          }, 3000);
        } else {
          latestQR = null;
        }
      }
    });

    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages?.[0];

        if (!msg?.message) return;
        if (msg.key.fromMe) return;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption;

        if (!text) return;

        const phone = msg.key.remoteJid;

        rememberRecentChat(phone, text);

        cancelFollowups(phone);

        console.log("PESAN MASUK:", text);
        console.log("DARI NOMOR:", phone);

        // =========================
        // BUFFER CHAT CUSTOMER
        // =========================
        const existingBuffer = pendingMessageBuffers.get(phone);

        if (existingBuffer?.timer) {
          clearTimeout(existingBuffer.timer);
        }

        const combinedTexts = [
          ...(existingBuffer?.texts || []),
          text,
        ];

        const timer = setTimeout(() => {
          pendingMessageBuffers.delete(phone);

          const mergedText = combinedTexts.join("\n");

          console.log("MERGED TEXT MASUK QUEUE:", mergedText);

          enqueueMessageProcess(phone, async () => {
            console.log("QUEUE MULAI PROSES:", phone, mergedText);

            await processIncomingMessage(
              sock,
              msg,
              mergedText,
              phone
            );

            console.log("QUEUE SELESAI PROSES:", phone);
          });
        }, 1800);

        pendingMessageBuffers.set(phone, {
          texts: combinedTexts,
          timer,
        });

        return;
      } catch (err) {
        console.log("BUFFER ERROR:", err?.message);
      }
    });

    async function processIncomingMessage(sock, msg, text, phone) {
      try {

        const data = await safeJsonFetch(
          `${TRIGGER_API}?phone=${encodeURIComponent(phone)}&t=${Date.now()}`
        );

        const triggers = Array.isArray(data.triggers) ? data.triggers : [];
        const flows = Array.isArray(data.flows) ? data.flows : [];
        const session = data.session || null;

        console.log("JUMLAH TRIGGER:", triggers.length);
        console.log("SESSION AKTIF:", session);

        const incomingText = normalizeText(text);
        const recentContextText = getRecentChatContext(phone, text);
        const incomingTextWithContext = normalizeText(
          [recentContextText, incomingText].filter(Boolean).join(" ")
        );

        function splitIncomingSegments(value) {
          return String(value || "")
            .split(/[?!.\n,]+|\bdan\b|\bterus\b|\bsama\b/gi)
            .map((item) => normalizeText(item))
            .filter(Boolean);
        }

        const incomingSegments = splitIncomingSegments(text);

        function segmentMatchesKeyword(segment, keyword) {
          const normalizedKeyword = normalizeText(keyword);
          if (!segment || !normalizedKeyword) return false;

          if (keywordHasAreaPlaceholder(keyword)) {
            return matchAreaPlaceholderKeyword(segment, keyword, flows);
          }

          if (keywordHasQtyPlaceholder(keyword)) {
            return matchQtyPlaceholderKeyword(segment, keyword);
          }

          return segment.includes(normalizedKeyword);
        }

        function matchTriggers(list) {
          const activeList = list.filter((t) => t.active);

          const ignoredWords = [
            "kak",
            "ka",
            "kaka",
            "min",
            "admin",
            "gan",
            "sis",
            "bro",
            "bos",
            "bang",
            "mas",
            "mba",
            "mbak",
            "ya",
            "yah",
            "oke",
            "ok",
            "sip",
            "halo",
            "hai",
            "hello",
            "permisi",
            "dong",
            "mau",
            "cek",
            "boleh",
            "bisa",
            "ga",
            "gak",
            "nggak",
            "ngga",
            "dong",
          ];

          function getImportantWords(value) {
            return normalizeText(value)
              .split(" ")
              .map((word) => word.trim())
              .filter(Boolean)
              .filter((word) => word.length >= 3)
              .filter((word) => !ignoredWords.includes(word));
          }

          function getKnownShippingAreas(triggerList) {
            const areas = [];

            for (const trigger of triggerList) {
              const checkout = getFlowCheckout(flows, trigger.flow_id);
              const shippingByArea = checkout?.shippingByArea || {};

              for (const area of Object.keys(shippingByArea)) {
                const normalizedArea = normalizeText(area);
                if (normalizedArea) areas.push(normalizedArea);
              }
            }

            return [...new Set(areas)];
          }

          function textContainsKnownShippingArea(value, triggerList) {
            const normalized = normalizeText(value);
            const areas = getKnownShippingAreas(triggerList);

            return areas.some((area) => normalized.includes(area));
          }

          function getTriggerScore(trigger, segment = incomingText) {
            const keyword = normalizeText(trigger.keyword);
            const normalizedSegment = normalizeText(segment);

            if (!keyword || !normalizedSegment) return 0;

            if (keywordHasAreaPlaceholder(trigger.keyword)) {
              return matchAreaPlaceholderKeyword(normalizedSegment, trigger.keyword, flows)
                ? 95
                : 0;
            }

            if (keywordHasQtyPlaceholder(trigger.keyword)) {
              return matchQtyPlaceholderKeyword(normalizedSegment, trigger.keyword)
                ? 95
                : 0;
            }

            if (trigger.type === "Sama Persis") {
              return normalizedSegment === keyword ? 100 : 0;
            }

            const keywordWords = getImportantWords(keyword);
            const segmentWords = getImportantWords(normalizedSegment);

            if (keywordWords.length === 0 || segmentWords.length === 0) {
              return 0;
            }

            const directKeywordMatch = normalizedSegment.includes(keyword);
            const matchedWords = keywordWords.filter((word) =>
              segmentWords.includes(word)
            );

            let score = 0;

            if (directKeywordMatch) score += 70;

            score += matchedWords.length * 18;

            const coverage = matchedWords.length / keywordWords.length;
            if (coverage >= 1) score += 35;
            else if (coverage >= 0.67) score += 22;
            else if (coverage >= 0.5) score += 10;

            // Jangan biarkan kata umum "berapa" sendirian memilih trigger harga produk.
            if (
              isProductPriceTrigger(keyword) &&
              !isProductPriceQuestion(normalizedSegment)
            ) {
              score -= 60;
            }

            // Kalau pertanyaan mengarah ke area/ongkir, trigger harga produk diturunkan.
            if (
              (isShippingQuestion(normalizedSegment) ||
                textContainsKnownShippingArea(normalizedSegment, activeList)) &&
              isProductPriceTrigger(keyword)
            ) {
              score -= 80;
            }

            // Kalau pertanyaan ongkir/area, trigger ongkir dibantu naik.
            if (
              (isShippingQuestion(normalizedSegment) ||
                textContainsKnownShippingArea(normalizedSegment, activeList)) &&
              isShippingTrigger(keyword)
            ) {
              score += 35;
            }

            // Jika trigger punya banyak kata, minimal harus ada 2 kata penting yang match
            // kecuali keyword lengkapnya benar-benar muncul.
            if (keywordWords.length >= 2 && matchedWords.length < 2 && !directKeywordMatch) {
              score = Math.min(score, 25);
            }

            return Math.max(score, 0);
          }

          function getBestSegmentScore(trigger) {
            const segmentScores = incomingSegments.map((segment, index) => ({
              index,
              score: getTriggerScore(trigger, segment),
            }));

            const fullScore = getTriggerScore(trigger, incomingText);

            let best = {
              index: Number.MAX_SAFE_INTEGER,
              score: fullScore,
            };

            for (const item of segmentScores) {
              if (item.score > best.score) {
                best = item;
              }
            }

            // Riwayat 10 chat terakhir hanya untuk bantu konteks ringan.
            // Tidak boleh membuat trigger keluar kalau chat saat ini skornya lemah.
            const contextScore = recentContextText
              ? getTriggerScore(trigger, incomingTextWithContext)
              : 0;

            if (best.score >= 55 && contextScore > best.score) {
              best.score = Math.min(contextScore, best.score + 15);
            }

            return best;
          }

          const scored = activeList
            .map((trigger) => {
              const best = getBestSegmentScore(trigger);

              return {
                trigger,
                score: best.score,
                orderIndex: best.index,
              };
            })
            .filter((item) => {
              const keyword = normalizeText(item.trigger.keyword);

              // Ambang aman: kalau tidak cukup yakin, jangan kirim apa-apa.
              if (keywordHasAreaPlaceholder(item.trigger.keyword)) return item.score >= 80;
              if (keywordHasQtyPlaceholder(item.trigger.keyword)) return item.score >= 80;

              if (item.trigger.type === "Sama Persis") return item.score >= 100;

              if (isShippingTrigger(keyword)) return item.score >= 55;
              if (isProductPriceTrigger(keyword)) return item.score >= 65;

              return item.score >= 60;
            })
            .sort((a, b) => {
              if (a.orderIndex !== b.orderIndex) {
                return a.orderIndex - b.orderIndex;
              }

              if (a.score !== b.score) {
                return b.score - a.score;
              }

              return (
                normalizeText(b.trigger.keyword).length -
                normalizeText(a.trigger.keyword).length
              );
            });

          console.log(
            "SKOR TRIGGER:",
            scored.map((item) => ({
              id: item.trigger.id,
              keyword: item.trigger.keyword,
              score: item.score,
            }))
          );

          return uniqueTriggers(scored.map((item) => item.trigger));
        }

        function matchFlowEntryTriggers(list) {
          const activeList = list.filter((t) => t.active);

          const exactMatches = activeList.filter((t) => {
            return incomingText === normalizeText(t.keyword);
          });

          const priceMatches = isProductPriceQuestion(incomingText)
            ? activeList.filter((t) => isProductPriceTrigger(normalizeText(t.keyword)))
            : [];

          const containsMatches = activeList.filter((t) => {
            const keyword = normalizeText(t.keyword);
            if (!keyword) return false;

            if (keywordHasAreaPlaceholder(t.keyword)) {
              return matchAreaPlaceholderKeyword(incomingText, t.keyword, flows);
            }

            if (keywordHasQtyPlaceholder(t.keyword)) {
              return matchQtyPlaceholderKeyword(incomingText, t.keyword);
            }

            return incomingText.includes(keyword);
          });

          const merged = uniqueTriggers([
            ...exactMatches,
            ...priceMatches,
            ...containsMatches,
          ]);

          if (merged.length === 0) {
            return [];
          }

          function getFlowEntryOrderIndex(trigger) {
            const keyword = normalizeText(trigger.keyword);

            const directIndex = incomingText.indexOf(keyword);
            if (directIndex !== -1) return directIndex;

            for (let i = 0; i < incomingSegments.length; i++) {
              const segment = incomingSegments[i];

              if (isProductPriceTrigger(keyword) && isProductPriceQuestion(segment)) {
                return i;
              }

              if (segmentMatchesKeyword(segment, keyword)) {
                return i;
              }
            }

            return Number.MAX_SAFE_INTEGER;
          }

          const sorted = merged.sort((a, b) => {
            const aIndex = getFlowEntryOrderIndex(a);
            const bIndex = getFlowEntryOrderIndex(b);

            if (aIndex !== bIndex) {
              return aIndex - bIndex;
            }

            return normalizeText(b.keyword).length - normalizeText(a.keyword).length;
          });

          return uniqueTriggers(sorted).slice(0, 1);
        }

        function getFlowIdValue(value) {
          if (value === null || value === undefined || value === "") return null;
          return String(value);
        }

        let foundList = [];

        const flowEntryTriggers = triggers.filter(
          (t) => t.is_flow_entry === true
        );

        const flowEntryFoundList = matchFlowEntryTriggers(flowEntryTriggers);

        if (flowEntryFoundList.length > 0) {
          foundList = flowEntryFoundList;

          console.log("FLOW ENTRY DITEMUKAN:", foundList);

          const firstFlowEntry = flowEntryFoundList[0];

          if (firstFlowEntry?.flow_id) {
            await updateSessionFlow(phone, firstFlowEntry.flow_id);

            const triggersInEntryFlow = triggers.filter((t) => {
              return getFlowIdValue(t.flow_id) === getFlowIdValue(firstFlowEntry.flow_id);
            });

            const additionalFound = matchTriggers(triggersInEntryFlow);

            foundList = uniqueTriggers([
              ...foundList,
              ...additionalFound,
            ]);
          }
        }

        if (foundList.length === 0 && session?.flow_id) {
          // Kalau user sudah berada di sebuah alur,
          // trigger hanya boleh dicari di alur aktif tersebut.
          // Ini mencegah trigger dari alur lain ikut terkirim.
          const activeFlowId = getFlowIdValue(session.flow_id);

          const triggersInActiveFlow = triggers.filter((t) => {
            return getFlowIdValue(t.flow_id) === activeFlowId;
          });

          foundList = matchTriggers(triggersInActiveFlow);

          if (foundList.length > 0) {
            console.log("TRIGGER DI FLOW AKTIF:", foundList);
          }
        }

        if (foundList.length === 0 && !session?.flow_id) {
          const globalTriggers = triggers.filter((t) => {
            if (t.is_flow_entry === true) return false;
            return getFlowIdValue(t.flow_id) === null;
          });

          foundList = matchTriggers(globalTriggers);

          if (foundList.length > 0) {
            console.log("TRIGGER GLOBAL TANPA FLOW:", foundList);
          }
        }

        if (foundList.length === 0 && session?.flow_id) {
          console.log(
            "TIDAK ADA TRIGGER COCOK DI FLOW AKTIF. TIDAK MENCARI KE FLOW LAIN."
          );
        }

        if (foundList.length > 0 && session?.flow_id) {
          const activeFlowId = getFlowIdValue(session.flow_id);

          foundList = foundList.filter((t) => {
            if (t.is_flow_entry === true) return true;
            return getFlowIdValue(t.flow_id) === activeFlowId;
          });
        }

        if (foundList.length === 0) {
          console.log("TRIGGER TIDAK DITEMUKAN:", text);
          return;
        }

        foundList = uniqueTriggers(foundList);

        function getFinalTriggerOrderIndex(trigger) {
          const keyword = normalizeText(trigger.keyword);

          if (keywordHasAreaPlaceholder(trigger.keyword)) {
            for (let i = 0; i < incomingSegments.length; i++) {
              if (matchAreaPlaceholderKeyword(incomingSegments[i], trigger.keyword, flows)) {
                return i;
              }
            }
          }

          if (keywordHasQtyPlaceholder(trigger.keyword)) {
            for (let i = 0; i < incomingSegments.length; i++) {
              if (matchQtyPlaceholderKeyword(incomingSegments[i], trigger.keyword)) {
                return i;
              }
            }
          }

          const directIndex = incomingText.indexOf(keyword);
          if (directIndex !== -1) return directIndex;

          for (let i = 0; i < incomingSegments.length; i++) {
            const segment = incomingSegments[i];

            if (isProductPriceTrigger(keyword) && isProductPriceQuestion(segment)) {
              return i;
            }

            if (segmentMatchesKeyword(segment, keyword)) {
              return i;
            }
          }

          return Number.MAX_SAFE_INTEGER;
        }

        foundList = foundList.sort((a, b) => {
          const aIndex = getFinalTriggerOrderIndex(a);
          const bIndex = getFinalTriggerOrderIndex(b);

          if (aIndex !== bIndex) {
            return aIndex - bIndex;
          }

          return normalizeText(b.keyword).length - normalizeText(a.keyword).length;
        });

        if (session?.flow_id) {
          const activeFlowId = getFlowIdValue(session.flow_id);

          foundList = foundList.filter((found) => {
            if (found.is_flow_entry === true) return true;
            return getFlowIdValue(found.flow_id) === activeFlowId;
          });
        }

        if (foundList.length === 0) {
          console.log("TRIGGER FINAL KOSONG SETELAH FILTER FLOW:", text);
          return;
        }

        console.log("TRIGGER FINAL:", foundList);

        for (const found of foundList) {
          const mediaList = getMediaList(found);
          const triggerCheckout = getFlowCheckout(flows, found.flow_id);
          const previousCheckoutState = getSessionCheckoutState(session);

          const incomingQty = extractQty(text);
          const incomingArea = triggerCheckout ? extractArea(text, triggerCheckout) : "";
          const incomingName = extractName(text);
          const incomingAddress = cleanAddressText(text);

          const checkoutStateForTrigger = {
            ...previousCheckoutState,
            qty: incomingQty || Number(previousCheckoutState.qty) || 1,
            area: incomingArea || previousCheckoutState.area || "",
            address: incomingAddress || previousCheckoutState.address || "",
            name: incomingName || previousCheckoutState.name || "",
          };

          if (triggerCheckout) {
            await saveCheckoutState(phone, session, checkoutStateForTrigger);
          }

          const responseParts = getResponseParts(found.response).map((part) =>
            renderCheckoutPlaceholder(part, triggerCheckout, checkoutStateForTrigger)
          );

          if (mediaList.length > 0) {
            await sendResponseWithMedia(
              sock,
              msg.key.remoteJid,
              responseParts,
              mediaList
            );
          } else if (found.image && String(found.image).trim() !== "") {
            await sendResponseWithMedia(sock, msg.key.remoteJid, responseParts, [
              {
                type: "image",
                url: String(found.image).trim(),
                responseIndex: 0,
              },
            ]);
          } else {
            await sendResponseWithMedia(
              sock,
              msg.key.remoteJid,
              responseParts,
              []
            );
          }

          // Tidak ada pesan/checkout otomatis di engine.
          // Follow up tetap hanya dari setting trigger dashboard.
          scheduleFollowups(sock, msg.key.remoteJid, found);

          // Tunggu sebentar setelah satu trigger selesai total,
          // baru lanjut trigger berikutnya.
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      } catch (err) {
        console.log("ERROR MESSAGE:", err?.message);
        console.log("ERROR STACK:", err?.stack);
        console.log("ERROR FULL:", err);
      }
    }
  } catch (err) {
    isStarting = false;
    console.log("GAGAL START BOT:", err?.message);
    console.log("GAGAL START BOT STACK:", err?.stack);
  }
}

app.get("/", (req, res) => {
  res.send("ChatBotNexis WA Engine Aktif");
});

app.get("/status", (req, res) => {
  res.json({
    success: true,
    connected: isConnected,
    hasQR: !!latestQR,
    starting: isStarting,
    sessionDir: SESSION_DIR,
  });
});

app.get("/qr-json", (req, res) => {
  res.json({
    success: true,
    qr: latestQR,
    connected: isConnected,
    hasQR: !!latestQR,
    starting: isStarting,
    sessionDir: SESSION_DIR,
  });
});

app.get("/qr", (req, res) => {
  res.setHeader("Content-Type", "text/html");

  if (isConnected) {
    return res.send(`
      <html>
        <body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#07140f;color:white;font-family:sans-serif;text-align:center">
          <div>
            <h2>WhatsApp sudah terhubung</h2>
            <p>Tidak perlu scan QR lagi.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (!latestQR) {
    return res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="3">
        </head>
        <body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#07140f;color:white;font-family:sans-serif;text-align:center">
          <div>
            <h2>QR sedang dibuat...</h2>
            <p>Tunggu beberapa detik. Halaman ini refresh otomatis.</p>
          </div>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#07140f;color:white;font-family:sans-serif;text-align:center">
        <div>
          <h2>Scan QR WhatsApp</h2>
          <img src="${latestQR}" style="width:280px;max-width:90%;border-radius:16px;background:white;padding:12px" />
          <p>Scan dari aplikasi WhatsApp.</p>
        </div>
      </body>
    </html>
  `);
});

app.get("/connect", async (req, res) => {
  try {
    // SAFE CONNECT:
    // Tidak menghapus session, jadi aman dipakai setelah update/redeploy.
    latestQR = null;
    isConnected = false;
    isStarting = false;

    clearReconnectTimer();

    await stopSocket();

    startBot();

    res.json({
      success: true,
      message: "WA Engine direstart aman tanpa menghapus session",
      sessionDir: SESSION_DIR,
    });
  } catch (err) {
    console.log("CONNECT ERROR:", err?.message);

    res.status(500).json({
      success: false,
      message: err?.message || "Gagal restart WA Engine",
    });
  }
});

app.get("/reset-session", async (req, res) => {
  try {
    // RESET SESSION:
    // Pakai ini hanya kalau memang mau logout total dan scan QR ulang.
    latestQR = null;
    isConnected = false;
    isStarting = false;

    clearReconnectTimer();

    await stopSocket();

    await fs.promises.rm(SESSION_DIR, {
      recursive: true,
      force: true,
    });

    startBot();

    res.json({
      success: true,
      message: "Session lama dihapus, QR baru akan dibuat",
      sessionDir: SESSION_DIR,
    });
  } catch (err) {
    console.log("RESET SESSION ERROR:", err?.message);

    res.status(500).json({
      success: false,
      message: err?.message || "Gagal reset session",
    });
  }
});

app.get("/reload", async (req, res) => {
  // Trigger/flow/checkout dibaca langsung dari API setiap ada pesan masuk,
  // jadi update template di dashboard tidak perlu restart engine.
  res.json({
    success: true,
    message: "Template dibaca live dari API. Tidak perlu restart untuk update trigger/flow/checkout.",
    connected: isConnected,
    sessionDir: SESSION_DIR,
  });
});

app.get("/logout", async (req, res) => {
  try {
    if (sockInstance) {
      try {
        await sockInstance.logout();
      } catch {}
    }

    await stopSocket();

    latestQR = null;
    isConnected = false;
    isStarting = false;

    await fs.promises.rm(SESSION_DIR, {
      recursive: true,
      force: true,
    });

    res.json({
      success: true,
      message: "WhatsApp berhasil logout",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err?.message || "Gagal logout",
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("SERVER RUNNING DI PORT:", PORT);
  console.log("SESSION DIR:", SESSION_DIR);
});

async function gracefulShutdown(signal) {
  try {
    console.log("GRACEFUL SHUTDOWN:", signal);

    clearReconnectTimer();

    // Jangan logout dan jangan hapus session.
    // Ini supaya deploy/update tidak bikin WhatsApp keluar.
    await stopSocket();

    process.exit(0);
  } catch (err) {
    console.log("GRACEFUL SHUTDOWN ERROR:", err?.message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.log("UNCAUGHT EXCEPTION:", err?.message);
  console.log(err?.stack);
});

process.on("unhandledRejection", (err) => {
  console.log("UNHANDLED REJECTION:", err?.message || err);
});

if (AUTO_START_BOT) {
  startBot();
}
