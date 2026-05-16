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

        function matchTriggers(list) {
          const activeList = list.filter((t) => t.active);

          const priceMatches = activeList.filter((t) => {
            const keyword = normalizeText(t.keyword);
            return isPriceTrigger(keyword) && isPriceQuestion(incomingText);
          });

          const exactMatches = activeList.filter((t) => {
            if (t.type !== "Sama Persis") return false;
            return incomingText === normalizeText(t.keyword);
          });

          const containsMatches = activeList.filter((t) => {
            if (t.type === "Sama Persis") return false;

            const keyword = normalizeText(t.keyword);
            return keyword && incomingText.includes(keyword);
          });

          const wordMatches = activeList.filter((t) => {
            if (t.type === "Sama Persis") return false;

            const keyword = normalizeText(t.keyword);
            const words = keyword.split(" ").filter(Boolean);

            return words.some((word) => incomingText.includes(word));
          });

          return uniqueTriggers([
            ...priceMatches,
            ...exactMatches,
            ...containsMatches,
            ...wordMatches,
          ]);
        }

        function matchFlowEntryTriggers(list) {
          const activeList = list.filter((t) => t.active);

          const exactMatches = activeList.filter((t) => {
            return incomingText === normalizeText(t.keyword);
          });

          if (exactMatches.length > 0) {
            return uniqueTriggers(exactMatches).slice(0, 1);
          }

          const containsMatches = activeList.filter((t) => {
            const keyword = normalizeText(t.keyword);
            if (!keyword) return false;

            return incomingText.includes(keyword);
          });

          if (containsMatches.length > 0) {
            const sorted = containsMatches.sort((a, b) => {
              return normalizeText(b.keyword).length - normalizeText(a.keyword).length;
            });

            return uniqueTriggers(sorted).slice(0, 1);
          }

          return [];
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
          }
        }

        if (foundList.length === 0 && session?.flow_id) {
          // Kalau user sudah berada di sebuah alur,
          // trigger hanya boleh dicari di alur aktif tersebut.
          // Ini mencegah trigger dari alur lain ikut terkirim.
          const activeFlowId = getFlowIdValue(session.flow_id);

          const triggersInActiveFlow = triggers.filter((t) => {
            return (
              getFlowIdValue(t.flow_id) === activeFlowId &&
              t.is_flow_entry !== true
            );
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
          const responseParts = getResponseParts(found.response);

          if (mediaList.length > 0) {
            for (let i = 0; i < mediaList.length; i++) {
              const media = mediaList[i];
              const mediaUrl = String(media.url || "").trim();
              const mediaType = String(media.type || "image").toLowerCase();

              if (!mediaUrl) continue;

              if (mediaType === "video") {
                await sock.sendMessage(msg.key.remoteJid, {
                  video: {
                    url: mediaUrl,
                  },
                });

                console.log("VIDEO DIKIRIM:", mediaUrl);
              } else {
                await sock.sendMessage(msg.key.remoteJid, {
                  image: {
                    url: mediaUrl,
                  },
                });

                console.log("GAMBAR DIKIRIM:", mediaUrl);
              }
            }

            for (const part of responseParts) {
              await sock.sendMessage(msg.key.remoteJid, {
                text: part,
              });

              console.log("BALASAN TEXT DIKIRIM:", part);
            }
          } else if (found.image && String(found.image).trim() !== "") {
            await sock.sendMessage(msg.key.remoteJid, {
              image: {
                url: String(found.image).trim(),
              },
            });

            console.log("GAMBAR LAMA DIKIRIM");

            for (const part of responseParts) {
              await sock.sendMessage(msg.key.remoteJid, {
                text: part,
              });

              console.log("BALASAN TEXT DIKIRIM:", part);
            }
          } else {
            for (const part of responseParts) {
              await sock.sendMessage(msg.key.remoteJid, {
                text: part,
              });

              console.log("BALASAN TEXT DIKIRIM:", part);
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 700));
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
