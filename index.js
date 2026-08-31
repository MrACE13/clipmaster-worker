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
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  // Cari fallback URL jika bersarang di dalam clip_data atau root
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
    console.error('ERROR: video_url tidak ditemukan pada payload');
    if (chatId) {
      await bot.sendMessage(chatId, '❌ Gagal: Tautan video (URL) tidak terlampir dalam perintah render.');
    }
    return;
  }

  const tempDownload = path.join(__dirname, `raw_${Date.now()}.mp4`);
  const outputClip = path.join(__dirname, `clip_${Date.now()}.mp4`);

  try {
    if (chatId) {
      await bot.sendMessage(chatId, `⏳ Sedang mengunduh dan memotong: "${clipTitle}"\nMohon tunggu 1-2 menit...`);
    }

    console.log(`Mengunduh stream: ${videoUrl}`);

    await new Promise((resolve, reject) => {
      const stream = ytdl(videoUrl, {
        quality: 'highest',
        filter: 'audioandvideo',
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        }
      });

      const writeStream = fs.createWriteStream(tempDownload);
      stream.pipe(writeStream);
      writeStream.on('finish', resolve);
      stream.on('error', (err) => reject(new Error(err.message || 'Error stream download')));
      writeStream.on('error', (err) => reject(new Error(err.message || 'Error file write')));
    });

    console.log('Mulai rendering FFmpeg (9:16 vertical)...');

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
        .on('end', resolve)
        .on('error', (err) => reject(new Error(err.message || 'Error FFmpeg encode')))
        .run();
    });

    if (chatId) {
      console.log(`Mengirim video ke Telegram ID: ${chatId}`);
      await bot.sendVideo(chatId, outputClip, {
        caption: `🎬 **${clipTitle}**\n⏱ Durasi: ${duration}s\n\nSiap diunggah ke Reels / Shorts / TikTok!`,
        supports_streaming: true
      });
      console.log('Proses selesai dan video terkirim!');
    }

  } catch (err) {
    const errorMsg = err.message || 'Terjadi kesalahan internal server';
    console.error('Render gagal:', errorMsg);
    if (chatId) {
      await bot.sendMessage(chatId, `❌ Proses gagal: ${errorMsg}`);
    }
  } finally {
    if (fs.existsSync(tempDownload)) try { fs.unlinkSync(tempDownload); } catch(e){}
    if (fs.existsSync(outputClip)) try { fs.unlinkSync(outputClip); } catch(e){}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker aktif pada port ${PORT}`));
