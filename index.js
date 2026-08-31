const express = require('express');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const play = require('play-dl');
require('dotenv').config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Normalisasi URL YouTube ke format standar bersih
function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const match = rawUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([\w-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return rawUrl.split('?')[0]; // Hapus query params jika format umum
}

async function sendTelegramMsg(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error('Gagal kirim pesan TG:', e.message);
  }
}

async function sendTelegramVideo(chatId, videoPath, caption) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const fileBuffer = fs.readFileSync(videoPath);
    const blob = new Blob([fileBuffer], { type: 'video/mp4' });
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('video', blob, 'clip.mp4');
    formData.append('caption', caption);
    formData.append('supports_streaming', 'true');

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Gagal upload video');
    console.log('Video berhasil dikirim ke Telegram!');
  } catch (e) {
    console.error('Gagal kirim video TG:', e.message);
    await sendTelegramMsg(chatId, `❌ Gagal upload file video: ${e.message}`);
  }
}

app.post('/render-webhook', async (req, res) => {
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  const rawUrl = payload.video_url || 
                 payload.source_url || 
                 payload.url || 
                 payload.clip_data?.source_url || 
                 payload.clip_data?.video_url;

  const videoUrl = cleanYouTubeUrl(rawUrl);
  const startTime = payload.timestamps?.start_time || payload.start_time || '00:00:10';
  const duration = payload.timestamps?.duration_seconds || payload.duration || 30;
  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || payload.clip_title || 'Viral Clip';

  if (!videoUrl) {
    await sendTelegramMsg(chatId, '❌ Gagal: URL video tidak valid atau tidak ditemukan.');
    return;
  }

  const outputClip = path.join(__dirname, `clip_${Date.now()}.mp4`);

  try {
    console.log(`Mulai render klip: "${clipTitle}" | URL Bersih: ${videoUrl}`);
    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\n\nMohon tunggu sekitar 1-2 menit...`);

    const sourceStream = await play.stream(videoUrl, { quality: 1 });

    await new Promise((resolve, reject) => {
      ffmpeg(sourceStream.stream)
        .setStartTime(startTime)
        .setDuration(duration)
        .videoFilters([
          'crop=ih*(9/16):ih',
          'scale=720:1280'
        ])
        .outputOptions(['-c:v libx264', '-preset ultrafast', '-c:a aac'])
        .output(outputClip)
        .on('end', () => {
          console.log('FFmpeg render selesai.');
          resolve();
        })
        .on('error', (err) => reject(new Error(err.message || 'Error FFmpeg encode')))
        .run();
    });

    await sendTelegramVideo(
      chatId, 
      outputClip, 
      `🎬 *${clipTitle}*\n⏱ Durasi: ${duration}s\n\nSiap diunggah ke TikTok / Reels / Shorts!`
    );

  } catch (err) {
    console.error('Proses gagal:', err.message);
    await sendTelegramMsg(chatId, `❌ Gagal memproses video: ${err.message}`);
  } finally {
    if (fs.existsSync(outputClip)) {
      try { fs.unlinkSync(outputClip); } catch (e) {}
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker aktif pada port ${PORT}`));
