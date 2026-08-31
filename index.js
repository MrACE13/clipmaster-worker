const express = require('express');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const play = require('play-dl');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

app.post('/render-webhook', async (req, res) => {
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  const videoUrl = payload.video_url || 
                   payload.source_url || 
                   payload.url || 
                   payload.clip_data?.source_url || 
                   payload.clip_data?.video_url;

  const startTime = payload.timestamps?.start_time || payload.start_time || '00:00:10';
  const duration = payload.timestamps?.duration_seconds || payload.duration || 30;
  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || payload.clip_title || 'Viral Clip';

  if (!videoUrl) {
    if (chatId) await bot.sendMessage(chatId, '❌ Gagal: URL video tidak ditemukan.');
    return;
  }

  const outputClip = path.join(__dirname, `clip_${Date.now()}.mp4`);

  try {
    if (chatId) {
      await bot.sendMessage(chatId, `⏳ Sedang memproses klip: "${clipTitle}"\nMohon tunggu 1-2 menit...`);
    }

    console.log(`Mengambil stream YouTube: ${videoUrl}`);
    const sourceStream = await play.stream(videoUrl, { quality: 1 });

    console.log('Mulai rendering dan pemotongan FFmpeg...');
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
        .on('end', resolve)
        .on('error', (err) => reject(new Error(err.message)))
        .run();
    });

    if (chatId) {
      console.log(`Mengirim video ke Telegram (${chatId})...`);
      await bot.sendVideo(chatId, outputClip, {
        caption: `🎬 **${clipTitle}**\n⏱ Durasi: ${duration}s\n\nSiap diunggah ke Reels / Shorts / TikTok!`,
        supports_streaming: true
      });
      console.log('Selesai! Video berhasil terkirim.');
    }
  } catch (err) {
    console.error('Error saat render:', err.message);
    if (chatId) {
      await bot.sendMessage(chatId, `❌ Proses gagal: ${err.message}`);
    }
  } finally {
    if (fs.existsSync(outputClip)) {
      try { fs.unlinkSync(outputClip); } catch (e) {}
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker aktif pada port ${PORT}`));
