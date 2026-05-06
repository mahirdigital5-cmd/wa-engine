import express from "express";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import P from "pino";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";

const app = express();

let latestQR = "BELUM ADA QR";

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = await QRCode.toDataURL(qr);
      console.log("QR BARU BERHASIL DIGENERATE");
    }

    if (connection === "open") {
      console.log("WHATSAPP TERHUBUNG");
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      console.log("Koneksi putus");

      if (shouldReconnect) {
        startBot();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    if (!msg.message) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return;

    console.log("Pesan:", text);

    if (text.toLowerCase().includes("halo")) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: "Halo juga kak 👋",
      });
    }
  });
}

app.get("/", (req, res) => {
  res.send("WA ENGINE AKTIF");
});

app.get("/qr", (req, res) => {
  if (latestQR === "BELUM ADA QR") {
    return res.send("QR belum siap, refresh lagi 5 detik.");
  }

  res.send(`
    <h1>Scan QR WhatsApp</h1>
    <img src="${latestQR}" />
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("SERVER RUNNING");
});

startBot();
