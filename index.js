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

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

let latestQR = null;
let isConnected = false;

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

async function updateSessionFlow(phone, flowId) {
  try {
    await fetch(`${TRIGGER_API}?t=${Date.now()}`, {
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
  const { state, saveCreds } = await useMultiFileAuthState("session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["ChatBotNexis", "Chrome", "1.0.0"],
  });

  sockInstance = sock;

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

      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      console.log("KONEKSI PUTUS");

      if (shouldReconnect) {
        startBot();
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];

      if (!msg.message) return;
      if (msg.key.fromMe) return;

      const text =
        msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (!text) return;

      const phone = msg.key.remoteJid;

      console.log("PESAN MASUK:", text);
      console.log("DARI NOMOR:", phone);

      const res = await fetch(
        `${TRIGGER_API}?phone=${encodeURIComponent(phone)}&t=${Date.now()}`
      );

      const data = await res.json();

      const triggers = data.triggers || [];
      const session = data.session || null;

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
          return incomingText.includes(keyword);
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

      if (found.image && found.image.trim() !== "") {
        await sock.sendMessage(msg.key.remoteJid, {
          image: {
            url: found.image.trim(),
          },
          caption: found.response || "",
        });

        console.log("GAMBAR DIKIRIM");
      } else {
        await sock.sendMessage(msg.key.remoteJid, {
          text: found.response,
        });

        console.log("BALASAN DIKIRIM");
      }
    } catch (err) {
      console.log("ERROR MESSAGE:", err?.message);
      console.log("ERROR STACK:", err?.stack);
      console.log("ERROR FULL:", err);
    }
  });
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
    res.json({
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
    res.json({
      success: false,
      message: err?.message || "Gagal logout",
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("SERVER RUNNING");
});

startBot();
