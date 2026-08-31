const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();
app.use(express.json());

// Format token Telegram otomatis
const rawToken = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_TOKEN = rawToken.trim().replace(/^bot/i, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Fungsi konversi waktu ke detik
function parseTimeToSeconds(timeInput) {
  if (typeof timeInput === 'number') return timeInput;
  if (!timeInput) return 0;
  const parts = String(timeInput).trim().split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parseFloat(timeInput) || 0;
}

// Fungsi sanitasi URL YouTube
function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return str.split('&')[0];
}

// Fungsi kirim pesan teks Telegram
async function sendTelegramMsg(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Gagal kirim pesan TG:', e.message);
  }
}

// Fungsi kirim video MP4 ke Telegram
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
    console.log('Video sukses terkirim ke Telegram!');
  } catch (e) {
    console.error('Gagal kirim video TG:', e.message);
    await sendTelegramMsg(chatId, `❌ Gagal kirim video ke Telegram: ${e.message}`);
  }
}

// Fungsi unduh video sumber
async function downloadSourceVideo(videoUrl, outputPath) {
  try {
    console.log('Mencoba unduh via Cobalt Stream API...');
    const res = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      body: JSON.stringify({ url: videoUrl, videoQuality: '720', filenameStyle: 'basic' })
    });
    const data = await res.json();
    if (data && data.url) {
      const fileStream = await fetch(data.url);
      const buffer = await fileStream.arrayBuffer();
      fs.writeFileSync(outputPath, Buffer.from(buffer));
      console.log('Download via Cobalt berhasil!');
      return;
    }
  } catch (e) {
    console.log('Fallback ke yt-dlp internal...');
  }

  const cookiePath = path.join(__dirname, 'cookies.txt');
  const cookieArg = fs.existsSync(cookiePath) ? `--cookies "${cookiePath}"` : '';

  await new Promise((resolve, reject) => {
    const cmd = `yt-dlp ${cookieArg} --no-check-certificates -f "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b/best" --merge-output-format mp4 -o "${outputPath}" "${videoUrl}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error && !fs.existsSync(outputPath)) {
        return reject(new Error(`yt-dlp error: ${stderr || error.message}`));
      }
      resolve();
    });
  });
}

// ============================================================================
// ENDPOINT 1: AI Kurator 5 Klip Edukatif Berdurasi Dinamis (1 - 5 Menit)
// ============================================================================
app.post('/analyze-video', async (req, res) => {
  const { url, chat_id } = req.body || {};
  const videoUrl = cleanYouTubeUrl(url);
  res.status(200).json({ status: 'Analysis started' });

  if (!videoUrl || !chat_id) return;

  try {
    await sendTelegramMsg(chat_id, '🧠 *AI sedang menyimak video dan merancang 5 klip utuh lengkap dengan teaser pembuka...*');

    const prompt = `Anda adalah Produser Konten Video Pendek & Ahli Viralitas Media Sosial Indonesia.
Tugas Anda: Dari video URL "${videoUrl}", tentukan 5 REKOMENDASI KLIP TERBAIK (5 Topik Berbeda) yang edukatif, berbobot, dan inspiratif.

ATURAN STRUKTUR & RETENSI:
1. JUMLAH KLIP: Tepat 5 klip dengan topik berbeda (tidak tumpang tindih).
2. DURASI DINAMIS (1 - 5 MENIT): Antara 60 detik hingga 300 detik. Berhenti secara alami saat pesan tuntas.
3. ALUR UTUH: Mengandung pembukaan -> pembahasan mendalam -> kesimpulan narasumber.
4. TEASER HOOK: Tentukan kalimat pancingan rasa penasaran di awal video.

Format output WAJIB HANYA JSON valid:
{
  "clips": [
    {
      "clip_number": 1,
      "title": "Judul Klip",
      "start_time": "00:01:20",
      "duration": 120,
      "topic": "Mindset / Solusi / Cerita / Nasihat",
      "hook_headline": "Jangan sampai salah langkah di usia muda! ⚠️",
      "summary": "Ringkasan pembahasan utuh.",
      "social_caption": "Simak penjelasan tuntas ini sampai habis! 💡 #edukasi #mindset #viral"
    }
  ]
}`;

    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    const aiData = await aiRes.json();
    const resultJson = JSON.parse(aiData.candidates[0].content.parts[0].text);

    let msg = `💡 *5 Rekomendasi Klip Edukatif & Berbobot Utuh (Dengan Teaser):*\n\n`;
    resultJson.clips.forEach((clip, idx) => {
      const menit = Math.floor(clip.duration / 60);
      const detik = clip.duration % 60;
      const durasiStr = menit > 0 ? `${menit}m ${detik}s` : `${detik}s`;

      msg += `*${idx + 1}. [${clip.topic}] ${clip.title}*\n`;
      msg += `⏱ Mulai: \`${clip.start_time}\` | Durasi: *${durasiStr}*\n`;
      msg += `🎯 *Hook Teaser:* _"${clip.hook_headline}"_\n`;
      msg += `📖 *Pembahasan:* _${clip.summary}_\n\n`;
    });

    await sendTelegramMsg(chat_id, msg);

  } catch (err) {
    console.error('Gagal analisis AI:', err.message);
    await sendTelegramMsg(chat_id, `❌ Gagal menganalisis video: ${err.message}`);
  }
});

// ============================================================================
// ENDPOINT 2: Render FFmpeg (Micro-Teaser Pembuka + 9:16 Blur + Outro Fade-Out)
// ============================================================================
app.post('/render-webhook', async (req, res) => {
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  const rawUrl = payload.video_url || 
                 payload.source_url || 
                 payload.url || 
                 payload.clip_data?.source_url || 
                 payload.clip_data?.video_url;

  const videoUrl = cleanYouTubeUrl(rawUrl);
  const startTimeRaw = payload.timestamps?.start_time || payload.start_time || '00:00:10';
  const durationRaw = payload.timestamps?.duration_seconds || payload.duration || 60;
  
  const startSec = parseTimeToSeconds(startTimeRaw);
  const durSec = Math.max(20, parseTimeToSeconds(durationRaw));
  
  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || payload.clip_title || 'Viral Educational Clip';
  const hookHeadline = payload.hook_headline || payload.hook || '';
  const socialCaption = payload.social_caption || '';

  if (!videoUrl) return;

  const timestampId = Date.now();
  const rawDownload = path.join(__dirname, `raw_${timestampId}.mp4`);
  const outputClip = path.join(__dirname, `clip_${timestampId}.mp4`);

  try {
    const totalMenit = Math.floor(durSec / 60);
    const totalDetik = durSec % 60;
    const durasiText = totalMenit > 0 ? `${totalMenit}m ${totalDetik}s` : `${totalDetik}s`;

    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\n⏱ Durasi: *${durasiText}* (Lengkap dengan Cuplikan Pembuka & Transisi)\n\nMohon tunggu sekitar 1-3 menit...`);

    // 1. Download video sumber
    await downloadSourceVideo(videoUrl, rawDownload);

    // 2. Hitung titik cuplikan intisari pembuka (3.5 detik dari bagian klimaks/kesimpulan)
    const teaserDur = durSec > 35 ? 3.5 : 2.5;
    const teaserStartSec = startSec + Math.max(5, Math.floor(durSec * 0.72));

    // 3. Hitung efek fade-out di penutup klip utama (1.5 detik terakhir)
    const outroFadeDur = 1.5;
    const outroFadeStart = Math.max(0, durSec - outroFadeDur);

    // 4. Bangun Filter Complex FFmpeg: Cuplikan Teaser -> Transisi -> Klip Pembahasan Penuh
    const filterComplex = 
      // Input 0 (Cuplikan Pembuka 3.5 detik)
      `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg0];` +
      `[0:v]scale=720:-1[fg0];` +
      `[bg0][fg0]overlay=(W-w)/2:(H-h)/2,fade=t=out:st=${teaserDur - 0.4}:d=0.4,fps=30,format=yuv420p[v0];` +
      `[0:a]afade=t=out:st=${teaserDur - 0.4}:d=0.4,aformat=sample_rates=44100:channel_layouts=stereo[a0];` +
      
      // Input 1 (Klip Utama Pembahasan Penuh)
      `[1:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg1];` +
      `[1:v]scale=720:-1[fg1];` +
      `[bg1][fg1]overlay=(W-w)/2:(H-h)/2,fade=t=in:st=0:d=0.4,fade=t=out:st=${outroFadeStart}:d=${outroFadeDur},fps=30,format=yuv420p[v1];` +
      `[1:a]afade=t=in:st=0:d=0.4,afade=t=out:st=${outroFadeStart}:d=${outroFadeDur},aformat=sample_rates=44100:channel_layouts=stereo[a1];` +
      
      // Sambungkan Cuplikan + Klip Utama
      `[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`;

    console.log('Mulai rendering FFmpeg dengan Micro-Teaser + Full Clip...');
    const ffmpegCmd = `ffmpeg -y -ss ${teaserStartSec} -t ${teaserDur} -i "${rawDownload}" -ss ${startSec} -t ${durSec} -i "${rawDownload}" -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -c:a aac -b:a 192k -movflags +faststart "${outputClip}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error || !fs.existsSync(outputClip)) {
          return reject(new Error(`FFmpeg error: ${stderr || error.message}`));
        }
        console.log('FFmpeg render berhasil!');
        resolve();
      });
    });

    // 5. Format caption pengiriman ke Telegram
    let captionText = `🎬 *${clipTitle}*\n⏱ Durasi: *${durasiText}*\n\n`;
    if (hookHeadline) captionText += `🎯 *Hook:* ${hookHeadline}\n\n`;
    if (socialCaption) captionText += `📝 *Caption Medsos:* \n${socialCaption}\n\n`;
    captionText += `⚡ _Lengkap dengan Cuplikan Pembuka (Detik 0–3s) & Transisi Halus!_`;

    // 6. Kirim ke Telegram
    await sendTelegramVideo(chatId, outputClip, captionText);

  } catch (err) {
    console.error('Proses gagal:', err.message);
    await sendTelegramMsg(chatId, `❌ Gagal memproses video: ${err.message}`);
  } finally {
    if (fs.existsSync(rawDownload)) try { fs.unlinkSync(rawDownload); } catch (e) {}
    if (fs.existsSync(outputClip)) try { fs.unlinkSync(outputClip); } catch (e) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker aktif pada port ${PORT}`));
