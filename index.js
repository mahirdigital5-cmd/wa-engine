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
    .replace(/[?.,!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

      console.log("PESAN MASUK:", text);

      const res = await fetch(`${TRIGGER_API}?t=${Date.now()}`);
      const triggers = await res.json();

      console.log("TRIGGERS DARI API:", triggers);

      const incomingText = normalizeText(text);

      let found = triggers.find((t) => {
        if (!t.active) return false;
        if (t.type !== "Sama Persis") return false;

        return incomingText === normalizeText(t.keyword);
      });

      if (!found) {
        found = triggers.find((t) => {
          if (!t.active) return false;
          if (t.type === "Sama Persis") return false;

          const keyword = normalizeText(t.keyword);
          return incomingText.includes(keyword);
        });
      }

      if (!found) {
        found = triggers.find((t) => {
          if (!t.active) return false;
          if (t.type === "Sama Persis") return false;

          const keyword = normalizeText(t.keyword);
          const words = keyword.split(" ").filter(Boolean);

          return words.some((word) => incomingText.includes(word));
        });
      }

      if (!found) {
        console.log("TRIGGER TIDAK DITEMUKAN UNTUK PESAN:", text);
        return;
      }

      console.log("TRIGGER KETEMU:", found);

      if (found.image && found.image.trim() !== "") {
        await sock.sendMessage(msg.key.remoteJid, {
          image: {
            url: found.image.trim(),
          },
          caption: found.response || "",
        });

        console.log("GAMBAR DARI DASHBOARD DIKIRIM:", found.image);
      } else {
        await sock.sendMessage(msg.key.remoteJid, {
          text: found.response,
        });

        console.log("BALASAN DIKIRIM:", found.response);
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
