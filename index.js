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
  console.log('Perintah render masuk:', JSON.stringify(payload));
  res.status(200).json({ status: 'Processing started' });

  const videoUrl = payload.video_url || payload.source_url || payload.url;
  const startTime = payload.timestamps?.start_time || payload.start_time || '00:00:10';
  const duration = payload.timestamps?.duration_seconds || payload.duration || 30;
  const chatId = payload.chat_id || payload.chatId;
  const clipTitle = payload.title || payload.clip_title || 'Viral Clip';

  if (!videoUrl) {
    console.error('Video URL tidak ditemukan dalam data');
    return;
  }

  const tempDownload = path.join(__dirname, `raw_${Date.now()}.mp4`);
  const outputClip = path.join(__dirname, `clip_${Date.now()}.mp4`);

  try {
    if (chatId) {
      await bot.sendMessage(chatId, `⏳ Mulai memproses render klip: "${clipTitle}"\nMohon tunggu sekitar 1-2 menit...`);
    }

    console.log(`Mengunduh video dari: ${videoUrl}`);

    // Download video stream dari YouTube
    await new Promise((resolve, reject) => {
      const stream = ytdl(videoUrl, {
        quality: 'highestvideo',
        filter: 'videoandaudio',
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      });

      const writeStream = fs.createWriteStream(tempDownload);
      stream.pipe(writeStream);

      writeStream.on('finish', () => {
        console.log('Unduhan selesai, mulai memotong dengan FFmpeg...');
        resolve();
      });

      stream.on('error', (err) => reject(new Error(`Gagal download: ${err.message}`)));
      writeStream.on('error', (err) => reject(new Error(`Gagal tulis file: ${err.message}`)));
    });

    // Render potong & ubah ke format 9:16
    await new Promise((resolve, reject) => {
      ffmpeg(tempDownload)
        .setStartTime(startTime)
        .setDuration(duration)
        .videoFilters([
          'crop=ih*(9/16):ih',
          'scale=720:1280'
        ])
        .outputOptions(['-c:v libx264', '-preset ultrafast', '-c:a aac'])
        .output(outputClip)
        .on('end', () => {
          console.log('Rendering FFmpeg selesai!');
          resolve();
        })
        .on('error', (err) => reject(new Error(`Gagal FFmpeg: ${err.message}`)))
        .run();
    });

    // Kirim file mp4 ke Telegram
    if (chatId) {
      console.log(`Mengirim video ke chat ID: ${chatId}`);
      await bot.sendVideo(chatId, outputClip, {
        caption: `🎬 **${clipTitle}**\n⏱ Durasi: ${duration}s\n\nVideo siap diunggah ke Reels / Shorts / TikTok!`,
        supports_streaming: true
      });
      console.log('Video berhasil terkirim ke Telegram!');
    }

  } catch (error) {
    console.error('Error proses render:', error.message);
    if (chatId) {
      await bot.sendMessage(chatId, `❌ Gagal memproses video: ${error.message}`);
    }
  } finally {
    if (fs.existsSync(tempDownload)) fs.unlinkSync(tempDownload);
    if (fs.existsSync(outputClip)) fs.unlinkSync(outputClip);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker berjalan aktif pada port ${PORT}`));
