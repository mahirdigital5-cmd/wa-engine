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

let sockInstance = null;

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

let latestQR = null;
let isConnected = false;
let isStarting = false;

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

async function startBot() {
  if (isStarting) return;

  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: "silent" }),
      browser: ["ChatBotNexis", "Chrome", "1.0.0"],
    });

    sockInstance = sock;
    isStarting = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log("UPDATE:", update);

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
          setTimeout(() => {
            startBot();
          }, 3000);
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

        console.log("PESAN MASUK:", text);
        console.log("DARI NOMOR:", phone);

        const data = await safeJsonFetch(
          `${TRIGGER_API}?phone=${encodeURIComponent(phone)}&t=${Date.now()}`
        );

        const triggers = Array.isArray(data.triggers) ? data.triggers : [];
        const session = data.session || null;

        console.log("JUMLAH TRIGGER:", triggers.length);
        console.log("SESSION AKTIF:", session);

        const incomingText = normalizeText(text);

        function matchTrigger(list) {
          let found = list.find((t) => {
            if (!t.active) return false;

            const keyword = normalizeText(t.keyword);

            if (isPriceTrigger(keyword) && isPriceQuestion(incomingText)) {
              return true;
            }

            return false;
          });

          if (found) return found;

          found = list.find((t) => {
            if (!t.active) return false;
            if (t.type !== "Sama Persis") return false;

            return incomingText === normalizeText(t.keyword);
          });

          if (found) return found;

          found = list.find((t) => {
            if (!t.active) return false;
            if (t.type === "Sama Persis") return false;

            const keyword = normalizeText(t.keyword);
            return keyword && incomingText.includes(keyword);
          });

          if (found) return found;

          found = list.find((t) => {
            if (!t.active) return false;
            if (t.type === "Sama Persis") return false;

            const keyword = normalizeText(t.keyword);
            const words = keyword.split(" ").filter(Boolean);

            return words.some((word) => incomingText.includes(word));
          });

          return found;
        }

        let found = null;

        const flowEntryTriggers = triggers.filter(
          (t) => t.is_flow_entry === true
        );

        const flowEntryFound = matchTrigger(flowEntryTriggers);

        if (flowEntryFound) {
          found = flowEntryFound;

          console.log("FLOW ENTRY DITEMUKAN:", found);

          if (found.flow_id) {
            await updateSessionFlow(phone, found.flow_id);
          }
        }

        if (!found && session?.flow_id) {
          const triggersInActiveFlow = triggers.filter(
            (t) => t.flow_id === session.flow_id && t.is_flow_entry !== true
          );

          found = matchTrigger(triggersInActiveFlow);

          if (found) {
            console.log("TRIGGER DI FLOW AKTIF:", found);
          }
        }

        if (!found) {
          const globalTriggers = triggers.filter(
            (t) => t.is_flow_entry !== true
          );

          found = matchTrigger(globalTriggers);

          if (found) {
            console.log("TRIGGER GLOBAL:", found);
          }
        }

        if (!found) {
          console.log("TRIGGER TIDAK DITEMUKAN:", text);
          return;
        }

        console.log("TRIGGER FINAL:", found);

        const mediaList = getMediaList(found);

        if (mediaList.length > 0) {
          for (let i = 0; i < mediaList.length; i++) {
            const media = mediaList[i];
            const mediaUrl = String(media.url || "").trim();
            const mediaType = String(media.type || "image").toLowerCase();

            if (!mediaUrl) continue;

            const caption = i === 0 ? found.response || "" : "";

            if (mediaType === "video") {
              await sock.sendMessage(msg.key.remoteJid, {
                video: {
                  url: mediaUrl,
                },
                caption,
              });

              console.log("VIDEO DIKIRIM:", mediaUrl);
            } else {
              await sock.sendMessage(msg.key.remoteJid, {
                image: {
                  url: mediaUrl,
                },
                caption,
              });

              console.log("GAMBAR DIKIRIM:", mediaUrl);
            }
          }
        } else if (found.image && String(found.image).trim() !== "") {
          await sock.sendMessage(msg.key.remoteJid, {
            image: {
              url: String(found.image).trim(),
            },
            caption: found.response || "",
          });

          console.log("GAMBAR LAMA DIKIRIM");
        } else {
          await sock.sendMessage(msg.key.remoteJid, {
            text: found.response || "",
          });

          console.log("BALASAN DIKIRIM");
        }
      } catch (err) {
        console.log("ERROR MESSAGE:", err?.message);
        console.log("ERROR STACK:", err?.stack);
        console.log("ERROR FULL:", err);
      }
    });
  } catch (err) {
    isStarting = false;
    console.log("GAGAL START BOT:", err?.message);
  }
}

app.get("/", (req, res) => {
  res.send("ChatBotNexis WA Engine Aktif");
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!latestQR,
  });
});

app.get("/qr-json", (req, res) => {
  res.json({
    qr: latestQR,
    connected: isConnected,
  });
});

app.get("/qr", (req, res) => {
  if (!latestQR) {
    return res.send("QR belum siap atau WhatsApp sudah terhubung.");
  }

  res.send(`
    <html>
      <body style="text-align:center;font-family:sans-serif">
        <h1>SCAN QR WHATSAPP</h1>
        <img src="${latestQR}" />
      </body>
    </html>
  `);
});

app.get("/connect", async (req, res) => {
  try {
    latestQR = null;
    isConnected = false;

    if (sockInstance) {
      try {
        sockInstance.end();
      } catch (e) {}
    }

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
    res.status(500).json({
      success: false,
      message: err?.message || "Gagal membuat QR",
    });
  }
});

app.get("/logout", async (req, res) => {
  try {
    if (sockInstance) {
      await sockInstance.logout();
    }

    latestQR = null;
    isConnected = false;

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
