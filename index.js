const express = require('express');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const ytdl = require('@distube/ytdl-core');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

app.post('/render-webhook', async (req, res) => {
  const payload = req.body;
  res.status(200).json({ status: 'Processing started' });

  const videoUrl = payload.video_url || payload.source_url;
  const startTime = payload.timestamps?.start_time || '00:00:15';
  const duration = payload.timestamps?.duration_seconds || 30;
  const chatId = payload.chat_id || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || 'Viral Clip';

  const tempDownload = path.join(__dirname, `raw_${Date.now()}.mp4`);
  const outputClip = path.join(__dirname, `clip_${Date.now()}.mp4`);

  try {
    if (chatId) {
      await bot.sendMessage(chatId, `⏳ Sedang memotong video: "${clipTitle}"\nMohon tunggu 1-2 menit...`);
    }

    await new Promise((resolve, reject) => {
      ytdl(videoUrl, { quality: 'highestvideo' })
        .pipe(fs.createWriteStream(tempDownload))
        .on('finish', resolve)
        .on('error', reject);
    });

    await new Promise((resolve, reject) => {
      ffmpeg(tempDownload)
        .setStartTime(startTime)
        .setDuration(duration)
        .videoFilters([
          'crop=ih*(9/16):ih',
          'scale=720:1280'
        ])
        .output(outputClip)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    if (chatId) {
      await bot.sendVideo(chatId, outputClip, {
        caption: `🎬 ${clipTitle}\n⏱ Durasi: ${duration}s\n\nSiap diunggah ke TikTok / Reels / Shorts!`,
        supports_streaming: true
      });
    }

  } catch (error) {
    console.error('Error saat render:', error);
    if (chatId) {
      await bot.sendMessage(chatId, `❌ Gagal memotong video: ${error.message}`);
    }
  } finally {
    if (fs.existsSync(tempDownload)) fs.unlinkSync(tempDownload);
    if (fs.existsSync(outputClip)) fs.unlinkSync(outputClip);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker berjalan pada port ${PORT}`));
