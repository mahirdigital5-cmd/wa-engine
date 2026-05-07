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

let latestQR = null;

const TRIGGER_API = "https://chat-bot-nexis.vercel.app/api/triggers";

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session");

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: "silent" }),
    browser: ["ChatBotNexis", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    console.log("UPDATE:", update);

    if (qr) {
      latestQR = await QRCode.toDataURL(qr);
      console.log("QR BERHASIL DIGENERATE");
    }

    if (connection === "open") {
      console.log("WHATSAPP TERHUBUNG");
      latestQR = null;
    }

    if (connection === "close") {
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
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

      if (!text) return;

      console.log("PESAN MASUK:", text);

      const res = await fetch(TRIGGER_API);
      const triggers = await res.json();

      const found = triggers.find((t) => {
        if (!t.is_active) return false;

        return text
          .toLowerCase()
          .includes(t.keyword.toLowerCase());
      });

      if (!found) {
        console.log("TRIGGER TIDAK DITEMUKAN");
        return;
      }

      await sock.sendMessage(msg.key.remoteJid, {
        text: found.response,
      });

      console.log("BALASAN DIKIRIM:", found.response);
    } catch (err) {
      console.log("ERROR:", err);
    }
  });
}

app.get("/", (req, res) => {
  res.send("ChatBotNexis WA Engine Aktif");
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("SERVER RUNNING");
});

startBot();
