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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session");

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: "silent" }),
    browser: ["Railway Bot", "Chrome", "1.0.0"],
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
}

app.get("/", (req, res) => {
  res.send("WA ENGINE AKTIF");
});

app.get("/qr", (req, res) => {
  if (!latestQR) {
    return res.send("QR belum siap. Tunggu 10 detik lalu refresh.");
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
