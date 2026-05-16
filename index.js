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

function getResponseParts(response = "") {
  return String(response || "")
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
  const normalized = normalizeText(text);
  const digitMatch = normalized.match(/\b(\d{1,2})\b/);

  if (digitMatch) return Number(digitMatch[1]);

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

  for (const [word, number] of Object.entries(wordMap)) {
    if (normalized.includes(word)) return number;
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

  for (const area of Object.keys(shippingByArea)) {
    if (normalized.includes(normalizeText(area))) return area;
  }

  const areaPatterns = [
    /kecamatan\s+([a-zA-Z\s]+)/i,
    /kec\s+([a-zA-Z\s]+)/i,
    /kota\s+([a-zA-Z\s]+)/i,
    /kabupaten\s+([a-zA-Z\s]+)/i,
    /kab\s+([a-zA-Z\s]+)/i,
  ];

  for (const pattern of areaPatterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) {
      return normalizeText(match[1]).split(" ").slice(0, 2).join(" ");
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
}

async function startBot() {
  if (isStarting) return;

  isStarting = true;

  try {
    clearReconnectTimer();

    const { state, saveCreds } = await useMultiFileAuthState("session");
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
          ];

          function getImportantWords(text) {
            return normalizeText(text)
              .split(" ")
              .map((word) => word.trim())
              .filter(Boolean)
              .filter((word) => word.length >= 3)
              .filter((word) => !ignoredWords.includes(word));
          }

          const incomingWords = getImportantWords(incomingText);

          const priceMatches = isPriceQuestion(incomingText)
            ? activeList
                .filter((t) => isPriceTrigger(normalizeText(t.keyword)))
                .slice(0, 1)
            : [];

          const exactMatches = activeList.filter((t) => {
            if (t.type !== "Sama Persis") return false;
            return incomingText === normalizeText(t.keyword);
          });

          const containsMatches = activeList.filter((t) => {
            if (t.type === "Sama Persis") return false;

            const keyword = normalizeText(t.keyword);

            if (!keyword) return false;

            const keywordWords = getImportantWords(keyword);

            if (keywordWords.length === 0) {
              return false;
            }

            return keywordWords.every((word) =>
              incomingWords.includes(word)
            );
          });

          const wordMatches = activeList.filter((t) => {
            if (t.type === "Sama Persis") return false;

            const keywordWords = getImportantWords(t.keyword);

            if (keywordWords.length === 0) {
              return false;
            }

            const matchedWords = keywordWords.filter((word) =>
              incomingWords.includes(word)
            );

            return matchedWords.length >= 2;
          });

          const merged = uniqueTriggers([
            ...priceMatches,
            ...exactMatches,
            ...containsMatches,
            ...wordMatches,
          ]);

          // Urutan mengikuti posisi trigger di chat customer.
          // Jadi: "berapa? bisa cod?"
          // maka trigger "berapa/harga" dijawab dulu sampai semua jawabannya selesai,
          // baru lanjut trigger "cod".
          function getTriggerOrderIndex(trigger) {
            const keyword = normalizeText(trigger.keyword);

            if (!keyword) return Number.MAX_SAFE_INTEGER;

            const directIndex = incomingText.indexOf(keyword);
            if (directIndex !== -1) return directIndex;

            const keywordWords = getImportantWords(keyword);

            for (let i = 0; i < incomingSegments.length; i++) {
              const segment = incomingSegments[i];
              const segmentWords = getImportantWords(segment);

              if (
                isPriceTrigger(keyword) &&
                isPriceQuestion(segment)
              ) {
                return i;
              }

              if (segmentMatchesKeyword(segment, keyword)) {
                return i;
              }

              if (
                keywordWords.length > 0 &&
                keywordWords.every((word) => segmentWords.includes(word))
              ) {
                return i;
              }

              const matchedWords = keywordWords.filter((word) =>
                segmentWords.includes(word)
              );

              if (matchedWords.length >= 2) {
                return i;
              }
            }

            return Number.MAX_SAFE_INTEGER;
          }

          return merged.sort((a, b) => {
            const aIndex = getTriggerOrderIndex(a);
            const bIndex = getTriggerOrderIndex(b);

            if (aIndex !== bIndex) {
              return aIndex - bIndex;
            }

            return normalizeText(b.keyword).length - normalizeText(a.keyword).length;
          });
        }

        function matchFlowEntryTriggers(list) {
          const activeList = list.filter((t) => t.active);

          const exactMatches = activeList.filter((t) => {
            return incomingText === normalizeText(t.keyword);
          });

          const priceMatches = isPriceQuestion(incomingText)
            ? activeList.filter((t) => isPriceTrigger(normalizeText(t.keyword)))
            : [];

          const containsMatches = activeList.filter((t) => {
            const keyword = normalizeText(t.keyword);
            if (!keyword) return false;

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

              if (isPriceTrigger(keyword) && isPriceQuestion(segment)) {
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

          const directIndex = incomingText.indexOf(keyword);
          if (directIndex !== -1) return directIndex;

          for (let i = 0; i < incomingSegments.length; i++) {
            const segment = incomingSegments[i];

            if (isPriceTrigger(keyword) && isPriceQuestion(segment)) {
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
          const checkoutStateForTrigger = {
            qty: extractQty(text) || 1,
            area: triggerCheckout ? extractArea(text, triggerCheckout) : "",
            address: cleanAddressText(text),
            name: extractName(text),
          };

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
  });
});

app.get("/qr-json", (req, res) => {
  res.json({
    success: true,
    qr: latestQR,
    connected: isConnected,
    hasQR: !!latestQR,
    starting: isStarting,
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
    latestQR = null;
    isConnected = false;
    isStarting = false;

    clearReconnectTimer();

    await stopSocket();

    await fs.promises.rm("session", {
      recursive: true,
      force: true,
    });

    startBot();

    res.json({
      success: true,
      message: "Session lama dihapus, membuat QR baru",
    });
  } catch (err) {
    console.log("CONNECT ERROR:", err?.message);

    res.status(500).json({
      success: false,
      message: err?.message || "Gagal membuat QR",
    });
  }
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

    await fs.promises.rm("session", {
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
});

startBot();
