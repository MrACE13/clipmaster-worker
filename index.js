const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();

// 1. IZINKAN CORS & LOGGER PERMINTAAN DARI WEB BOLT
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Log setiap request yang masuk ke Railway
app.use((req, res, next) => {
  console.log('[REQUEST MASUK] ' + req.method + ' ' + req.url);
  next();
});

// Konfigurasi Token & API Key
const rawToken = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_TOKEN = rawToken.trim().replace(/^bot/i, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Penyimpanan cache data klip
const clipsMemoryCache = new Map();

// Route dasar untuk cek status server
app.get('/', (req, res) => {
  res.send('ClipMaster AI Worker & Studio Engine Online!');
});

// Helper konversi waktu ke detik
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

function formatSeconds(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// Pembersih URL YouTube
function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return 'https://www.youtube.com/watch?v=' + match[1];
  }
  return str.split('&')[0];
}

// Kirim pesan teks ke Telegram
async function sendTelegramMsg(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage';
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Gagal kirim pesan TG:', e.message);
  }
}

// Respon klik callback tombol Telegram
async function answerCallback(callbackQueryId, text = '') {
  if (!BOT_TOKEN || !callbackQueryId) return;
  try {
    const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/answerCallbackQuery';
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text })
    });
  } catch (e) {}
}

// Kirim video MP4 ke Telegram
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

    const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendVideo';
    const res = await fetch(url, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Gagal upload video');
    console.log('Video sukses terkirim ke Telegram!');
  } catch (e) {
    console.error('Gagal kirim video TG:', e.message);
    await sendTelegramMsg(chatId, '❌ Gagal kirim video ke Telegram: ' + e.message);
  }
}

// Download video sumber (Cobalt API + yt-dlp fallback)
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
  const cookieArg = fs.existsSync(cookiePath) ? '--cookies "' + cookiePath + '"' : '';

  await new Promise((resolve, reject) => {
    const cmd = 'yt-dlp ' + cookieArg + ' --no-check-certificates -f "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b/best" --merge-output-format mp4 -o "' + outputPath + '" "' + videoUrl + '"';
    exec(cmd, (error, stdout, stderr) => {
      if (error && !fs.existsSync(outputPath)) {
        return reject(new Error('yt-dlp error: ' + (stderr || error.message)));
      }
      resolve();
    });
  });
}

// ============================================================================
// FITUR AI: GENERATE SUBTITLE KARAOKE BERGERAK (ASS FORMAT)
// ============================================================================
async function generateKaraokeSubtitles(rawVideoPath, startSec, durSec, outputAssPath) {
  if (!GEMINI_API_KEY) return false;
  const tempAudioPath = path.join(__dirname, 'temp_audio_' + Date.now() + '.mp3');

  try {
    console.log('Mengekstrak audio klip untuk AI Subtitle...');
    await new Promise((resolve, reject) => {
      const cmd = 'ffmpeg -y -ss ' + startSec + ' -t ' + durSec + ' -i "' + rawVideoPath + '" -vn -acodec libmp3lame -b:a 128k -ar 44100 "' + tempAudioPath + '"';
      exec(cmd, (err) => {
        if (err || !fs.existsSync(tempAudioPath)) return reject(err);
        resolve();
      });
    });

    console.log('Mengirim audio ke Gemini untuk pembuatan Subtitle Karaoke...');
    const audioData = fs.readFileSync(tempAudioPath).toString('base64');

    const prompt = 'Dengarkan audio podcast bahasa Indonesia ini. Buat transkripsi subtitle format ASS (Advanced Substation Alpha) bergaya video pendek viral (TikTok/Reels).\n\n' +
      'ATURAN SUBTITLE:\n' +
      '1. Bagi per baris menjadi frasa pendek (2 - 4 kata per baris) agar mudah dibaca cepat.\n' +
      '2. Berikan highlight kata aktif menggunakan tag warna kuning: {\\c&H0000FFFF&}KATA AKTIF{\\c&H00FFFFFF&}.\n' +
      '3. Tepatkan waktu start dan end persis sesuai audio (waktu relatif dari 0:00:00.00 hingga akhir klip).\n' +
      '4. Pastikan teks menggunakan bahasa Indonesia yang rapi.\n\n' +
      'Format output WAJIB HANYA berupa struktur file ASS utuh.';

    const aiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY;
    const aiRes = await fetch(aiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'audio/mp3', data: audioData } },
            { text: prompt }
          ]
        }]
      })
    });

    const aiData = await aiRes.json();
    let assText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    assText = assText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();

    if (assText && assText.includes('[Events]')) {
      fs.writeFileSync(outputAssPath, assText, 'utf8');
      console.log('Subtitle Karaoke AI berhasil dibuat!');
      return true;
    }
  } catch (e) {
    console.log('Lewati subtitle, fallback ke video standar:', e.message);
  } finally {
    if (fs.existsSync(tempAudioPath)) try { fs.unlinkSync(tempAudioPath); } catch (e) {}
  }
  return false;
}

// ============================================================================
// CORE PIPELINE: RENDER STUDIO + TEASER 3.5s + AUDIO MASTERING
// ============================================================================
async function executeRenderJob(params) {
  const { videoUrl, startTimeRaw, durationRaw, chatId, clipTitle, hookHeadline, socialCaption } = params;
  if (!videoUrl) return;

  const startSec = parseTimeToSeconds(startTimeRaw);
  const durSec = Math.max(20, parseTimeToSeconds(durationRaw));

  const timestampId = Date.now();
  const rawDownload = path.join(__dirname, 'raw_' + timestampId + '.mp4');
  const outputClip = path.join(__dirname, 'clip_' + timestampId + '.mp4');
  const assSubtitlePath = path.join(__dirname, 'sub_' + timestampId + '.ass');

  try {
    const totalMenit = Math.floor(durSec / 60);
    const totalDetik = durSec % 60;
    const durasiText = totalMenit > 0 ? totalMenit + 'm ' + totalDetik + 's' : totalDetik + 's';

    console.log('Mulai memproses video: ' + clipTitle + ' (' + durasiText + ')');
    if (chatId) {
      await sendTelegramMsg(chatId, '⏳ *Sedang merender klip tingkat studio:*\n"' + clipTitle + '"\n⏱ Durasi: *' + durasiText + '*\n🎨 *Fitur Aktif:* Visual Sharpening + Audio Mastering EBU R128 + AI Subtitle Karaoke\n\nMohon tunggu sekitar 1-3 menit...');
    }

    // 1. Download video sumber
    await downloadSourceVideo(videoUrl, rawDownload);

    // 2. Generate Subtitle Karaoke AI
    const hasSubtitles = await generateKaraokeSubtitles(rawDownload, startSec, durSec, assSubtitlePath);

    // 3. Konfigurasi Teaser Cuplikan Pembuka & Transisi Penutup
    const teaserDur = durSec > 35 ? 3.5 : 2.5;
    const teaserStartSec = startSec + Math.max(5, Math.floor(durSec * 0.72));
    const outroFadeDur = 1.5;
    const outroFadeStart = Math.max(0, durSec - outroFadeDur);

    // Filter Visual & Subtitle
    const visualEnhance = 'unsharp=5:5:0.8:5:5:0.0,eq=contrast=1.08:brightness=0.02:saturation=1.18';
    let subFilterPart = '';
    if (hasSubtitles) {
      const sanitizedAss = assSubtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      subFilterPart = ',subtitles=\'' + sanitizedAss + '\'';
    }

    const filterComplex = 
      '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg0];' +
      '[0:v]scale=720:-1[fg0];' +
      '[bg0][fg0]overlay=(W-w)/2:(H-h)/2,' + visualEnhance + ',fade=t=out:st=' + (teaserDur - 0.4) + ':d=0.4,fps=30,format=yuv420p[v0];' +
      '[0:a]afade=t=out:st=' + (teaserDur - 0.4) + ':d=0.4,aformat=sample_rates=44100:channel_layouts=stereo[a0];' +
      '[1:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg1];' +
      '[1:v]scale=720:-1[fg1];' +
      '[bg1][fg1]overlay=(W-w)/2:(H-h)/2,' + visualEnhance + subFilterPart + ',fade=t=in:st=0:d=0.4,fade=t=out:st=' + outroFadeStart + ':d=' + outroFadeDur + ',fps=30,format=yuv420p[v1];' +
      '[1:a]highpass=f=60,lowpass=f=14000,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.4,afade=t=out:st=' + outroFadeStart + ':d=' + outroFadeDur + ',aformat=sample_rates=44100:channel_layouts=stereo[a1];' +
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]';

    console.log('Mulai rendering FFmpeg Studio Grade...');
    const ffmpegCmd = 'ffmpeg -y -ss ' + teaserStartSec + ' -t ' + teaserDur + ' -i "' + rawDownload + '" -ss ' + startSec + ' -t ' + durSec + ' -i "' + rawDownload + '" -filter_complex "' + filterComplex + '" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -c:a aac -b:a 192k -movflags +faststart "' + outputClip + '"';

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error || !fs.existsSync(outputClip)) {
          return reject(new Error('FFmpeg error: ' + (stderr || error.message)));
        }
        console.log('FFmpeg render berhasil!');
        resolve();
      });
    });

    if (chatId) {
      let captionText = '🎬 *' + clipTitle + '*\n⏱ Durasi: *' + durasiText + '*\n\n';
      if (hookHeadline) captionText += '🎯 *Hook:* ' + hookHeadline + '\n\n';
      if (socialCaption) captionText += '📝 *Caption Medsos:* \n' + socialCaption + '\n\n';
      captionText += '✨ *Kualitas Studio:* Visual Sharp & Vibrant | Audio EBU R128 | Subtitle Karaoke AI!';

      await sendTelegramVideo(chatId, outputClip, captionText);
    }

  } catch (err) {
    console.error('Proses gagal:', err.message);
    if (chatId) {
      await sendTelegramMsg(chatId, '❌ Gagal memproses video: ' + err.message);
    }
  } finally {
    const cleanupFiles = [rawDownload, outputClip, assSubtitlePath];
    cleanupFiles.forEach(f => {
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {}
    });
  }
}

// ============================================================================
// AI KURATOR: 5 KLIP EDUKATIF BERBOBOT (1–5 MENIT)
// ============================================================================
async function handleAnalyzeAndSend5Clips(chatId, videoUrl) {
  try {
    if (chatId) {
      await sendTelegramMsg(chatId, '🧠 *AI sedang menyimak video dan mengkurasi 5 klip edukatif berbobot (1–5 menit tanpa terpotong)...*\nMohon tunggu sekitar 15–30 detik.');
    }

    const prompt = 'Anda adalah Produser Konten Video Pendek & Ahli Viralitas Media Sosial Indonesia.\n' +
      'Tugas Anda: Dari video URL "' + videoUrl + '", temukan dan kurasi MINIMAL 5 REKOMENDASI KLIP TERBAIK (5 Topik Berbeda) yang kaya wawasan, edukatif, inovatif, atau bernilai inspirasi tinggi.\n\n' +
      'ATURAN WAJIB:\n' +
      '1. JUMLAH KLIP: Tepat 5 klip pilihan (Clip #1 sampai Clip #5) dengan topik bahasan berbeda (tidak saling tumpang tindih).\n' +
      '2. DURASI DINAMIS (1 - 5 MENIT): Tentukan durasi antara 60 detik (1 menit) hingga 300 detik (5 menit). Berhenti persis saat gagasan/pembahasan narasumber tuntas secara alami.\n' +
      '3. ALUR LENGKAP: Mengandung pembukaan konteks -> pembahasan mendalam -> kesimpulan tuntas dari narasumber. Jangan memotong kalimat di tengah jalan.\n' +
      '4. METADATA MEDSOS: Buat hook headline, tags, draft caption medsos, dan perkiraan reach.\n\n' +
      'Format output WAJIB HANYA JSON valid:\n' +
      '{\n' +
      '  "clips": [\n' +
      '    {\n' +
      '      "clip_number": 1,\n' +
      '      "title": "Judul Klip Menarik",\n' +
      '      "start_time": "00:01:20",\n' +
      '      "duration": 120,\n' +
      '      "virality_score": 88,\n' +
      '      "topic": "Mindset / Solusi / Kisah Nyata / Tips Bisnis",\n' +
      '      "hook_reason": "Menjelaskan prinsip penting yang sering diabaikan.",\n' +
      '      "tags": "#mindset #bisnis #edukasi",\n' +
      '      "social_tiktok": "Pola pikir penting yang jarang dibahas... #fyp #viral #bisnis",\n' +
      '      "social_shorts": "Wawasan penting hari ini #shorts #edukasi",\n' +
      '      "reach": "1K-10K"\n' +
      '    }\n' +
      '  ]\n' +
      '}';

    const aiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY;
    const aiRes = await fetch(aiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const aiData = await aiRes.json();
    const resultJson = JSON.parse(aiData.candidates[0].content.parts[0].text);

    if (!resultJson.clips || !Array.isArray(resultJson.clips)) {
      throw new Error('Format respon AI tidak sesuai');
    }

    if (chatId) {
      clipsMemoryCache.set(String(chatId), {
        videoUrl: videoUrl,
        clips: resultJson.clips
      });

      for (const clip of resultJson.clips) {
        const startSec = parseTimeToSeconds(clip.start_time);
        const endSec = startSec + clip.duration;
        const startFormatted = formatSeconds(startSec);
        const endFormatted = formatSeconds(endSec);

        const m = Math.floor(clip.duration / 60);
        const s = clip.duration % 60;
        const durText = m > 0 ? m + 'm ' + s + 's' : s + 's';

        const cardMessage = 
          '🎬 *Clip #' + clip.clip_number + '*\n' +
          '*' + clip.title + '*\n\n' +
          '⏱ `' + startFormatted + ' → ' + endFormatted + '` (*' + durText + '*)\n' +
          '⚡ Virality: *' + (clip.virality_score || 85) + '/100*\n' +
          '📱 Format: *9:16 (Studio Quality)*\n\n' +
          '💡 _' + clip.hook_reason + '_\n\n' +
          '🏷 ' + (clip.tags || '#edukasi #viral') + '\n\n' +
          '📱 *TikTok / Reels:*\n' + (clip.social_tiktok || 'Simak pembahasannya! #fyp') + '\n\n' +
          '▶️ *YouTube Shorts:*\n' + (clip.social_shorts || 'Poin penting dari video ini #shorts') + '\n\n' +
          '🎨 Visual: Teaser 0-3s + Color Pop + Subtitle Karaoke AI\n' +
          '📊 Reach: *' + (clip.reach || '1K-10K') + '*';

        const keyboard = {
          inline_keyboard: [
            [
              { text: '🎥 Render Clip', callback_data: 'render_' + clip.clip_number },
              { text: '📱 Open in App', url: videoUrl }
            ]
          ]
        };

        await sendTelegramMsg(chatId, cardMessage, keyboard);
      }
    }

    return resultJson;

  } catch (err) {
    console.error('Gagal analisis AI:', err.message);
    if (chatId) {
      await sendTelegramMsg(chatId, '❌ Gagal menganalisis video: ' + err.message);
    }
    return null;
  }
}

// ============================================================================
// TELEGRAM BOT POLLING LISTENER
// ============================================================================
let lastUpdateId = 0;
async function startTelegramPolling() {
  if (!BOT_TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN belum disetel, polling dilewati.');
    return;
  }
  console.log('Telegram Bot Polling aktif dan siap menerima pesan/link...');

  while (true) {
    try {
      const pollUrl = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=25';
      const res = await fetch(pollUrl);
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;

          if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith('/start')) {
              await sendTelegramMsg(
                chatId,
                '👋 *Selamat datang di ClipMaster AI Studio!*\n\nKirimkan link video YouTube/Podcast ke sini. AI akan mengkurasi *5 klip terbaik berdurasi dinamis (1–5 menit)* lengkap dengan subtitle karaoke dan peningkatan kualitas studio.'
              );
              continue;
            }

            const youtubeUrl = cleanYouTubeUrl(text);
            if (youtubeUrl) {
              handleAnalyzeAndSend5Clips(chatId, youtubeUrl);
            } else if (!text.startsWith('/')) {
              await sendTelegramMsg(chatId, '⚠️ Silakan kirimkan link YouTube yang valid.');
            }
          }

          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const dataStr = cb.data || '';

            if (dataStr.startsWith('render_')) {
              const clipNum = parseInt(dataStr.replace('render_', ''), 10);
              const cached = clipsMemoryCache.get(String(chatId));

              await answerCallback(cb.id, '✅ Memulai render Klip #' + clipNum + '...');

              if (!cached || !cached.clips) {
                await sendTelegramMsg(chatId, '⚠️ Data klip sudah kedaluwarsa. Silakan kirim ulang link videonya.');
                continue;
              }

              const clip = cached.clips.find(c => c.clip_number === clipNum);
              if (!clip) {
                await sendTelegramMsg(chatId, '⚠️ Data klip tidak ditemukan.');
                continue;
              }

              await sendTelegramMsg(chatId, '✅ *Render job queued!*\n\nClip #' + clipNum + ' sedang diproses dengan peningkatan visual & audio studio.');

              executeRenderJob({
                videoUrl: cached.videoUrl,
                startTimeRaw: clip.start_time,
                durationRaw: clip.duration,
                chatId: chatId,
                clipTitle: clip.title,
                hookHeadline: clip.hook_reason,
                socialCaption: clip.social_tiktok
              });
            }
          }
        }
      }
    } catch (err) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ============================================================================
// EXPRESS WEBHOOK ENDPOINTS (DIHUBUNGKAN DARI WEB BOLT)
// ============================================================================
app.post('/analyze-video', async (req, res) => {
  const { url, chat_id } = req.body || {};
  const videoUrl = cleanYouTubeUrl(url);
  res.status(200).json({ status: 'Analysis started' });
  if (videoUrl) handleAnalyzeAndSend5Clips(chat_id, videoUrl);
});

app.post('/render-webhook', (req, res) => {
  console.log('[RENDER WEBHOOK DITERIMA]', JSON.stringify(req.body));
  const payload = req.body || {};
  
  res.status(200).json({ 
    status: 'Processing started',
    message: 'Render job accepted by Railway worker' 
  });

  const rawUrl = payload.video_url || payload.source_url || payload.url || payload.clip_data?.source_url || payload.clip_data?.video_url;
  const videoUrl = cleanYouTubeUrl(rawUrl);
  if (!videoUrl) {
    console.error('URL video tidak valid atau kosong dalam webhook payload.');
    return;
  }

  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;

  executeRenderJob({
    videoUrl: videoUrl,
    startTimeRaw: payload.timestamps?.start_time || payload.start_time || '00:00:10',
    durationRaw: payload.timestamps?.duration_seconds || payload.duration || 60,
    chatId: chatId,
    clipTitle: payload.title || payload.clip_title || 'Viral Educational Clip',
    hookHeadline: payload.hook_headline || payload.hook || '',
    socialCaption: payload.social_caption || ''
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Worker aktif pada port ' + PORT);
  startTelegramPolling();
});
