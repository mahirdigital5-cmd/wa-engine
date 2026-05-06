import express from "express";
import pino from "pino";
import qrcode from "qrcode";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const app = express();
const PORT = process.env.PORT || 3000;

let latestQR = null;
let isConnected = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["ChatBotNexis", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = await qrcode.toDataURL(qr);
      console.log("QR siap. Buka /qr untuk scan.");
    }

    if (connection === "open") {
      isConnected = true;
      latestQR = null;
      console.log("BOT WHATSAPP TERHUBUNG");
    }

    if (connection === "close") {
      isConnected = false;

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

    if (!msg.message || msg.key.fromMe) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text) return;

    console.log("Pesan masuk:", text);

    if (text.toLowerCase().includes("halo")) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: "Halo juga kak 👋",
      });
    }
  });
}

app.get("/", (req, res) => {
  res.send(`
    <h2>WA Engine Aktif ✅</h2>
    <p>Status: ${isConnected ? "Terhubung" : "Belum terhubung"}</p>
    <a href="/qr">Buka QR</a>
  `);
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family: Arial; text-align: center; margin-top: 40px;">
        <h2>WhatsApp sudah terhubung ✅</h2>
      </div>
    `);
  }

  if (!latestQR) {
    return res.send(`
      <div style="font-family: Arial; text-align: center; margin-top: 40px;">
        <h2>QR belum siap</h2>
        <p>Refresh halaman ini 5 detik lagi.</p>
      </div>
    `);
  }

  res.send(`
    <div style="font-family: Arial; text-align: center; margin-top: 40px;">
      <h2>Scan QR WhatsApp</h2>
      <img src="${latestQR}" style="width: 320px;" />
      <p>Buka WhatsApp → Perangkat tertaut → Tautkan perangkat</p>
    </div>
  `);
});

app.listen(PORT, () => {
  console.log(`Server jalan di port ${PORT}`);
  startBot();
});
