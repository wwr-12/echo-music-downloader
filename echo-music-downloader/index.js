/**
 * EchoMusic 音乐下载器插件
 *
 * 功能：
 *  1. 歌曲右键菜单「下载歌曲」——按设置中的默认音质下载
 *  2. 「下载管理」页面——下载当前播放歌曲、查看任务进度、暂停/恢复/重试/取消
 *  3. 设置面板——下载目录授权、音质、文件命名模板、同名冲突策略、音质自动回退
 *
 * 运行环境：浏览器 ESM（由宿主通过 Blob URL 加载），不得使用 Node 内置模块或 bare import。
 * 适配宿主版本：>= 2.3.2-beta.10（依赖 ctx.net.download / ctx.fs 目录授权 / ctx.kugou API）。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 音质展示名（与宿主 audioQualityOptions 的 value 对齐）。 */
const QUALITY_LABELS = {
  '128': '标准 128K',
  '320': 'HQ 高品质',
  flac: 'SQ 无损',
  high: 'Hi-Res',
  viper_tape: '蝰蛇母带',
  viper_clear: '蝰蛇超清',
  viper_atmos: '蝰蛇全景声',
};

/** 音质自动回退顺序（从高到低），不含蝰蛇系列（特殊音效流，回退意义不大）。 */
const FALLBACK_CHAIN = ['high', 'flac', '320', '128'];

/** 允许使用的扩展名白名单，防止响应里的异常 extName 拼进文件名。 */
const SAFE_EXTS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav', 'ape', 'wma']);

/** 各音质取不到扩展名时的兜底值。 */
const DEFAULT_EXT_BY_QUALITY = {
  '128': 'mp3',
  '320': 'mp3',
  flac: 'flac',
  high: 'flac',
  viper_tape: 'flac',
  viper_clear: 'flac',
  viper_atmos: 'flac',
};

const DEFAULT_SETTINGS = {
  quality: '320',
  template: '{artist} - {title}',
  conflict: 'rename', // rename | replace | skip
  autoFallback: true,
  // 音乐刮削：scrape 总开关；scrapeMode：embed=嵌入音频文件 / sidecar=伴生文件 / both=两者
  // 嵌入由插件自带的 echotag 工具完成（MP3→ID3v2.3，FLAC→Vorbis+Picture）
  scrape: true,
  scrapeMode: 'embed',
  scrapeLyric: true,
  scrapeCover: true,
  scrapeInfo: true,
  directoryId: '',
  displayPath: '',
};

const SETTINGS_KEY = 'settings';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 去除文件/目录名中的非法字符（Windows 优先考虑）。 */
function sanitizeSegment(raw) {
  return String(raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

/** 归一化扩展名：去掉点号、小写、校验白名单。 */
function normalizeExt(value) {
  const ext = String(value ?? '')
    .replace(/^\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return SAFE_EXTS.has(ext) ? ext : '';
}

/** 从 URL 路径里猜扩展名。 */
function extFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]{2,5})$/i);
    return match ? normalizeExt(match[1]) : '';
  } catch {
    return '';
  }
}

/** 递归从酷狗响应中提取播放地址（对齐宿主 resolveUrlsFromResponse 的兼容面）。 */
function extractUrls(payload, depth = 0) {
  if (!payload || depth > 4) return [];
  if (typeof payload === 'string') {
    const url = payload.trim();
    return url ? [url] : [];
  }
  if (Array.isArray(payload)) {
    const urls = [];
    for (const item of payload) {
      for (const url of extractUrls(item, depth + 1)) {
        if (!urls.includes(url)) urls.push(url);
      }
    }
    return urls;
  }
  if (typeof payload === 'object') {
    const record = payload;
    const urls = [];
    const candidates = [record.url, record.play_url, record.playUrl, record.backupUrl, record.backup_url, record.backupUrls];
    for (const value of candidates) {
      for (const url of extractUrls(value, depth + 1)) {
        if (!urls.includes(url)) urls.push(url);
      }
    }
    if (urls.length > 0) return urls;
    if ('data' in record) return extractUrls(record.data, depth + 1);
    if ('info' in record) return extractUrls(record.info, depth + 1);
  }
  return [];
}

/** 递归从响应里找 extName 字段。 */
function extractExt(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 3) return '';
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const ext = extractExt(item, depth + 1);
      if (ext) return ext;
    }
    return '';
  }
  const record = payload;
  if (typeof record.extName === 'string' || typeof record.extname === 'string') {
    const ext = normalizeExt(record.extName ?? record.extname);
    if (ext) return ext;
  }
  for (const key of ['data', 'info']) {
    if (key in record) {
      const ext = extractExt(record[key], depth + 1);
      if (ext) return ext;
    }
  }
  return '';
}

/** 找到音乐 URL 对应的 data 记录（供扩展名判断）。 */
function findDataRecord(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 3) return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findDataRecord(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload.url === 'string' && payload.url) return payload;
  for (const key of ['data', 'info']) {
    if (key in payload) {
      const found = findDataRecord(payload[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** 按音质挑选 hash：优先用 relateGoods 里对应音质的 hash，否则退回歌曲默认 hash。 */
function pickQualityHash(song, quality) {
  const goods = Array.isArray(song?.relateGoods) ? song.relateGoods : [];
  const matched = goods.find((item) => item && item.quality === quality && item.hash);
  return matched?.hash || song?.hash || '';
}

/** 根据模板生成文件名（不含扩展名）。 */
function buildFilename(song, quality, template) {
  const tokens = {
    title: sanitizeSegment(song?.title || song?.name || '未知标题'),
    artist: sanitizeSegment(song?.artist || '未知歌手'),
    album: sanitizeSegment(song?.album || song?.albumName || '未知专辑'),
    quality: QUALITY_LABELS[quality] || quality,
  };
  let name = String(template || DEFAULT_SETTINGS.template);
  for (const [key, value] of Object.entries(tokens)) {
    name = name.split(`{${key}}`).join(value);
  }
  name = sanitizeSegment(name);
  if (!name) name = `${tokens.artist} - ${tokens.title}`;
  if (name.length > 120) name = name.slice(0, 120).trim();
  return name;
}

/** 格式化字节数。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** 递归在响应对象里查找指定字段名的第一个字符串值。 */
function findDeepString(payload, fieldName, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 4) return '';
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findDeepString(item, fieldName, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const value = payload[fieldName];
  if (typeof value === 'string' && value) return value;
  for (const key of ['data', 'info']) {
    if (key in payload) {
      const found = findDeepString(payload[key], fieldName, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

/** KRC 逐字歌词转普通 LRC：行首 [start,dur] 换算 [mm:ss.xx]，去掉逐字时间标签。 */
function krcToLrc(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\[(\d+),\d+\](.*)$/);
      if (!match) return line;
      const start = Number(match[1]);
      const words = match[2].replace(/<[^>]*>/g, '');
      const mm = String(Math.floor(start / 60000)).padStart(2, '0');
      const ss = String(Math.floor((start % 60000) / 1000)).padStart(2, '0');
      const xx = String(Math.floor((start % 1000) / 10)).padStart(2, '0');
      return `[${mm}:${ss}.${xx}]${words}`;
    })
    .join('\n');
}

/** 归一化封面地址：补协议、替换 {size} 占位符。 */
function normalizeCoverUrl(url) {
  let cover = String(url ?? '').trim();
  if (!cover) return '';
  cover = cover.replaceAll('{size}', '480');
  if (cover.startsWith('//')) cover = `https:${cover}`;
  return /^https?:\/\//.test(cover) ? cover : '';
}

/** 判断解码后的歌词文本是 KRC 还是 LRC；KRC 转回 LRC。 */
function ensureLrcText(content) {
  return /^\[\d+,\d+\]/m.test(content) ? krcToLrc(content) : content;
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export async function activate(ctx) {
  const { h, ref, computed } = ctx.vue;

  // --- 设置 -----------------------------------------------------------------
  const saved = (await ctx.storage.get(SETTINGS_KEY)) || {};
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  let grantAvailable = null; // null=未检测, true=可用, false=已失效

  const saveSettings = async () => {
    await ctx.storage.set(SETTINGS_KEY, settings);
  };

  /** 检测目录授权是否仍然可用。 */
  const refreshGrantStatus = async () => {
    try {
      if (!settings.directoryId) {
        grantAvailable = false;
        return;
      }
      const grants = await ctx.fs.listDirectoryGrants();
      const found = (grants || []).find((g) => g && g.id === settings.directoryId);
      grantAvailable = Boolean(found && found.available !== false);
    } catch {
      grantAvailable = null;
    }
  };
  await refreshGrantStatus();

  /**
   * 确保有一个可用的下载目录授权。
   * 返回 { ok: true, directoryId } 或 { ok: false, reason }。
   */
  const ensureDirectory = async (interactive) => {
    if (settings.directoryId && grantAvailable === true) {
      return { ok: true, directoryId: settings.directoryId };
    }
    if (!interactive) {
      return { ok: false, reason: '尚未设置下载目录，请到插件设置中选择' };
    }
    // 已保存但授权失效：优先走重新授权（同一路径保留原 ID）。
    if (settings.directoryId && grantAvailable === false) {
      const re = await ctx.fs.reauthorizeDirectoryGrant(settings.directoryId, {
        access: 'read-write',
        purpose: '重新授权音乐下载目录',
        persist: true,
      });
      if (re.ok && !re.canceled) {
        settings.directoryId = re.directory.id;
        settings.displayPath = re.directory.displayPath || settings.displayPath;
        grantAvailable = true;
        await saveSettings();
        return { ok: true, directoryId: re.directory.id };
      }
      if (re.ok && re.canceled) {
        return { ok: false, reason: '已取消目录授权' };
      }
    }
    // 首次选择或重新授权失败：打开系统目录选择器。
    const selection = await ctx.fs.requestDirectory({
      access: 'read-write',
      purpose: '选择音乐保存目录',
      persist: true,
    });
    if (!selection.ok) {
      return { ok: false, reason: selection.error?.message || '无法访问文件系统' };
    }
    if (selection.canceled) {
      return { ok: false, reason: '已取消选择目录' };
    }
    settings.directoryId = selection.directory.id;
    settings.displayPath = selection.directory.displayPath || selection.directory.name || '';
    grantAvailable = true;
    await saveSettings();
    return { ok: true, directoryId: selection.directory.id };
  };

  // --- 播放地址解析 -----------------------------------------------------------

  /**
   * 获取指定音质的播放地址。
   * 返回 { ok: true, url, quality, ext } 或 { ok: false, reason }。
   */
  const resolveSongUrl = async (song, quality) => {
    const hash = pickQualityHash(song, quality);
    if (!hash) return { ok: false, reason: '歌曲缺少 hash，无法解析地址' };
    const response = await ctx.kugou.music.getSongUrl(
      hash,
      quality,
      undefined,
      song.albumAudioId ? { albumAudioId: song.albumAudioId } : undefined,
    );
    const urls = extractUrls(response);
    if (!urls.length) return { ok: false, reason: '未获取到播放地址（可能需要 VIP 或该音质无权限）' };
    const record = findDataRecord(response);
    const ext =
      extractExt(response) || extFromUrl(urls[0]) || DEFAULT_EXT_BY_QUALITY[quality] || 'mp3';
    return { ok: true, url: urls[0], urls, quality, ext };
  };

  /**
   * 带自动回退的地址解析：目标音质失败时按 FALLBACK_CHAIN 逐级尝试更低音质。
   */
  const resolveWithFallback = async (song, wanted) => {
    const tried = [];
    const chain = [wanted, ...(settings.autoFallback ? FALLBACK_CHAIN : [])].filter(
      (q, i, list) => QUALITY_LABELS[q] && list.indexOf(q) === i,
    );
    let lastReason = '';
    for (const quality of chain) {
      try {
        const result = await resolveSongUrl(song, quality);
        if (result.ok) return { ...result, fallbackFrom: tried };
        lastReason = result.reason;
      } catch (error) {
        lastReason = error?.message || String(error);
      }
      tried.push(quality);
      if (!settings.autoFallback) break;
    }
    return { ok: false, reason: lastReason || '解析播放地址失败', tried };
  };

  // --- 音乐刮削 ---------------------------------------------------------------
  //
  // 两种写入方式（设置 scrapeMode）：
  //   embed  —— 把歌词/封面/信息直接写进音频文件标签（MP3→ID3v2.3，FLAC→Vorbis+Picture）。
  //             由插件自带的本机工具 native/echotag-x64.exe 完成（ctx.process.launch）。
  //   sidecar —— 生成同名伴生文件（歌曲名.lrc / .jpg / .json）
  //   both   —— 两者都写
  // 嵌入失败（非 Windows / exe 缺失 / 用户拒绝授权）时自动回退伴生文件。

  // 刮削结果缓存（按 hash）：重试/重复下载时免去重复 API 请求。
  // 正向缓存歌词/封面；"确认无歌词/无封面"也缓存（负缓存），
  // 但网络等临时错误不缓存，下次自动重试。
  const scrapeCacheLimit = 200;
  const lyricCache = new Map();
  const coverCache = new Map();
  const cachePut = (map, key, value) => {
    if (map.size >= scrapeCacheLimit) map.delete(map.keys().next().value);
    map.set(key, value);
  };

  /** 拉取指定歌曲的 LRC 文本；拿不到返回空串（结果按 hash 缓存）。 */
  const fetchLrcText = async (song) => {
    if (!song?.hash) return ''; // 无 hash 的条目（如历史记录重建）无法查询，直接跳过
    if (lyricCache.has(song.hash)) return lyricCache.get(song.hash);
    // 与宿主歌词加载对齐：album_audio_id 缺失时回退 mixSongId（歌单/搜索来源常缺前者）
    const albumAudioId = song.albumAudioId ?? song.mixSongId;
    const baseOpts = {
      duration: song.duration ? Math.round(song.duration * 1000) : undefined,
      albumAudioId,
    };
    const fetchList = async (man) => {
      const search = await ctx.kugou.music.searchLyric(song.hash, { ...baseOpts, man });
      const payload =
        search && typeof search === 'object' && 'data' in search ? search.data : search;
      return Array.isArray(payload?.candidates) && payload.candidates.length
        ? payload.candidates
        : Array.isArray(payload?.info) && payload.info.length
          ? payload.info
          : [];
    };
    const usable = (list) =>
      (Array.isArray(list) ? list : []).find(
        (item) => item && item.id != null && item.accesskey,
      );

    let lrc = '';
    try {
      // 默认搜索（man=no）无可用候选时，改查候选列表（man=yes）兜底
      let candidate = usable(await fetchList('no'));
      if (!candidate) candidate = usable(await fetchList('yes'));
      if (!candidate) {
        cachePut(lyricCache, song.hash, ''); // 确认无歌词
        return '';
      }
      const detail = await ctx.kugou.music.getLyric(
        String(candidate.id),
        String(candidate.accesskey),
      );
      const content = findDeepString(detail, 'decodeContent') || findDeepString(detail, 'lyric') || '';
      if (!content) {
        cachePut(lyricCache, song.hash, '');
        return '';
      }
      lrc = ensureLrcText(content);
      cachePut(lyricCache, song.hash, lrc);
    } catch {
      // 网络/接口临时错误：不缓存，下次自动重试
    }
    return lrc;
  };

  /**
   * 解析歌曲封面地址：song.coverUrl 为空时（元数据不全的歌单/搜索来源），
   * 与宿主一致地按专辑信息补齐（/krm/audio → album_info.cover），再退 /audio 接口。
   */
  const resolveCoverUrl = async (song) => {
    const direct = normalizeCoverUrl(song.coverUrl || song.cover);
    if (direct) {
      cachePut(coverCache, song.hash, direct);
      return direct;
    }
    if (coverCache.has(song.hash)) return coverCache.get(song.hash);
    const albumAudioId = song.albumAudioId ?? song.mixSongId;
    try {
      if (albumAudioId) {
        const res = await ctx.kugou.music.getSongMetadata([albumAudioId]);
        const payload = res && typeof res === 'object' && 'data' in res ? res.data : res;
        const record = Array.isArray(payload?.data) ? payload.data[0] : null;
        const cover = normalizeCoverUrl(
          record?.album_info?.cover || findDeepString(record, 'cover'),
        );
        if (cover) {
          cachePut(coverCache, song.hash, cover);
          return cover;
        }
      }
      if (song.hash) {
        const res = await ctx.kugou.music.getAudioMetadata([song.hash]);
        const cover = normalizeCoverUrl(findDeepString(res, 'img') || findDeepString(res, 'cover'));
        if (cover) {
          cachePut(coverCache, song.hash, cover);
          return cover;
        }
      }
      cachePut(coverCache, song.hash, ''); // 确认无封面来源
    } catch {
      // 元数据补齐失败：按无封面处理（不缓存临时错误）
    }
    return '';
  };

  const fileRef = (directoryId, relativePath) => ({
    kind: 'directory-file',
    directoryId,
    relativePath,
  });

  /** Windows 风格拼接真实路径（echotag 只在 Windows 可用）。 */
  const joinRealPath = (root, relativePath) =>
    `${String(root || '').replace(/[\\/]+$/, '')}\\${String(relativePath).replace(/\//g, '\\')}`;

  /** 删除宿主侧的下载任务记录（用于清理临时文件的记录残留），失败静默。 */
  const removeDownloadRecord = async (taskId) => {
    if (!taskId) return;
    try {
      await ctx.net.downloads.remove(taskId);
    } catch {
      // 忽略清理失败（记录可能已被宿主回收）
    }
  };

  /** 启动 echotag 把元数据嵌入音频。
   * 返回 { launched, tmpRefs, coverTaskId }：launched 表示已成功启动（fire-and-forget）；
   * tmpRefs 为输入临时文件的引用 —— echotag 成功后自删（--cleanup），据此轮询完成状态；
   * coverTaskId 为临时封面下载任务的宿主记录 id，嵌入结束后需清理，避免下载列表残留。 */
  const launchEmbed = async (song, audioRealPath, lyricsText, coverUrl) => {
    const root = String(settings.displayPath || '');
    if (!root) return { launched: false, tmpRefs: [], coverTaskId: '' };
    const rootTrimmed = String(root).replace(/[\\/]+$/, '');
    const base = audioRealPath.replace(/\.[^.]+$/, '');
    const tmpLyrics = lyricsText ? `${base}.__echotag_lyrics.tmp` : '';
    const tmpCover = coverUrl ? `${base}.__echotag_cover.tmp` : '';
    const relative = (absolute) => absolute.slice(rootTrimmed.length + 1);
    let coverTaskId = '';
    try {
      const tmpRefs = [];
      let coverReady = false;
      if (tmpLyrics) {
        const rel = relative(tmpLyrics);
        await ctx.fs.writeFile(fileRef(settings.directoryId, rel), lyricsText, {
          overwrite: true,
        });
        tmpRefs.push(fileRef(settings.directoryId, rel));
      }
      if (tmpCover) {
        const rel = relative(tmpCover);
        const coverHandle = await ctx.net
          .download({
            url: coverUrl,
            target: { directoryId: settings.directoryId, relativePath: rel },
            name: '__echotag_cover.tmp',
            conflict: 'replace',
          })
          .catch(() => null);
        coverTaskId = coverHandle?.id || '';
        if (coverHandle) {
          try {
            // 关键：等封面真正落盘后再启动 echotag，否则工具可能读到不存在的输入文件
            await coverHandle.wait();
            coverReady = true;
          } catch {
            // 封面下载失败：跳过封面继续嵌入歌词，不让封面问题拖垮整个嵌入
          }
        }
        if (coverReady) tmpRefs.push(fileRef(settings.directoryId, rel));
      }
      const args = [
        '--file', audioRealPath,
        '--title', song.title || song.name || '',
        '--artist', song.artist || '',
        '--album', song.album || song.albumName || '',
      ];
      if (tmpLyrics) args.push('--lyrics', tmpLyrics);
      if (coverReady) args.push('--cover', tmpCover);
      args.push('--cleanup'); // echotag 成功后自删输入临时文件，用于确认嵌入完成
      const launch = await ctx.process
        .launch({ executable: 'native/echotag-x64.exe', args })
        .catch(() => null);
      if (launch && launch.ok) return { launched: true, tmpRefs, coverTaskId };
      // 启动失败：清理临时文件与封面任务记录，由调用方回退伴生文件
      const cleanupRef = async (ref) => {
        try {
          await ctx.fs.deleteFile(ref);
        } catch {
          // 忽略清理失败
        }
      };
      await Promise.all(tmpRefs.map(cleanupRef));
      await removeDownloadRecord(coverTaskId);
      return { launched: false, tmpRefs: [], coverTaskId: '' };
    } catch {
      await removeDownloadRecord(coverTaskId);
      return { launched: false, tmpRefs: [], coverTaskId: '' };
    }
  };

  /** 轮询临时文件是否被 echotag 清理（=嵌入成功），超时返回 false 并清掉残留输入文件。 */
  const waitForEmbedDone = async (tmpRefs, timeoutMs = 60000) => {
    if (!tmpRefs.length) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let remaining = 0;
      for (const ref of tmpRefs) {
        try {
          await ctx.fs.stat(ref);
          remaining += 1; // 文件还在 → 嵌入未完成
        } catch (error) {
          if (error?.code !== 'FILE_MISSING') remaining += 1; // 无法确认 → 保守视为未完成
        }
      }
      if (remaining === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // 超时：echotag 未自行清理（大概率失败），插件侧清掉避免下载目录残留 .tmp
    for (const ref of tmpRefs) {
      try {
        await ctx.fs.deleteFile(ref);
      } catch {
        // 清理失败不阻塞回退流程
      }
    }
    return false;
  };

  /**
   * 按设置完成刮削。返回 { note, issues }：
   * note 为成功提示文案（可能为空串）；issues 为失败原因列表（用于 toast 与任务列表展示）。
   * @param audioRelativePath 最终落盘的音频相对路径（可能因重命名与请求名不同）
   */
  const scrapeSidecars = async (song, directoryId, baseName, quality, audioRelativePath) => {
    const mode = settings.scrapeMode || 'embed';
    const issues = [];
    // 歌词与封面并行获取（各自带缓存），互不阻塞
    const [lyricsSettled, coverSettled] = await Promise.allSettled([
      settings.scrapeLyric ? fetchLrcText(song) : Promise.resolve(''),
      settings.scrapeCover ? resolveCoverUrl(song) : Promise.resolve(''),
    ]);
    const lyricsText =
      lyricsSettled.status === 'fulfilled' && typeof lyricsSettled.value === 'string'
        ? lyricsSettled.value
        : '';
    const coverUrl = coverSettled.status === 'fulfilled' ? coverSettled.value : '';
    if (settings.scrapeLyric && !lyricsText.trim()) issues.push('未找到歌词');
    if (settings.scrapeCover && !coverUrl) issues.push('未找到封面来源');

    // 嵌入模式：echotag 仅支持 MP3/FLAC 内容（内部按魔数识别，扩展名不限）；
    // 其他格式不启动嵌入，直接伴生并明确提示。
    const audioExt = (audioRelativePath.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const embedSupported = audioExt === 'mp3' || audioExt === 'flac';
    if (mode === 'embed' || mode === 'both') {
      if (audioExt && !embedSupported) {
        issues.push(`${audioExt.toUpperCase()} 格式暂不支持嵌入，已生成伴生文件`);
      } else {
        const audioRealPath = joinRealPath(settings.displayPath, audioRelativePath);
        if (audioRealPath && (lyricsText || coverUrl)) {
          const { launched, tmpRefs, coverTaskId } = await launchEmbed(
            song,
            audioRealPath,
            lyricsText,
            coverUrl,
          );
          if (launched) {
            // 轮询临时文件消失 = echotag 嵌入成功；超时则回退伴生文件
            const done = await waitForEmbedDone(tmpRefs);
            // 嵌入已结束（成败皆然）：清掉临时封面的宿主任务记录，避免下载列表残留 .tmp 条目
            await removeDownloadRecord(coverTaskId);
            if (done) {
              const embedNote =
                mode === 'both' ? '已写入音频标签（伴生文件另存）' : '元数据已写入音频标签';
              return { note: embedNote, issues };
            }
            issues.push('标签嵌入未完成，已回退伴生文件');
          } else {
            issues.push('标签嵌入未运行，已回退伴生文件');
          }
        }
        if (!lyricsText && !coverUrl) return { note: '', issues };
      }
    }

    // 伴生文件模式（含 embed 失败回退）
    const saved = [];
    if (lyricsText.trim()) {
      try {
        await ctx.fs.writeFile(fileRef(directoryId, `${baseName}.lrc`), lyricsText, {
          overwrite: true,
        });
        saved.push('歌词');
      } catch {
        issues.push('歌词保存失败');
      }
    }
    if (coverUrl) {
      try {
        const ext = coverUrl.match(/\.(jpe?g|png|webp)(?:[?#]|$)/i)?.[1]?.toLowerCase() || 'jpg';
        await ctx.net.download({
          url: coverUrl,
          target: { directoryId, relativePath: `${baseName}.${ext}` },
          name: `${baseName}.${ext}`,
          conflict: 'replace',
        });
        saved.push('封面');
      } catch {
        issues.push('封面下载失败');
      }
    }
    if (settings.scrapeInfo) {
      try {
        const info = {
          title: song.title || song.name || '',
          artist: song.artist || '',
          album: song.album || song.albumName || '',
          albumId: song.albumId ?? undefined,
          hash: song.hash,
          albumAudioId: song.albumAudioId ?? undefined,
          quality,
          qualityLabel: QUALITY_LABELS[quality] || quality,
          duration: song.duration ?? undefined,
          cover: coverUrl || undefined,
          source: 'kugou',
          downloadedAt: new Date().toISOString(),
          downloader: 'echo-music-downloader',
        };
        await ctx.fs.writeFile(fileRef(directoryId, `${baseName}.json`), JSON.stringify(info, null, 2), {
          overwrite: true,
        });
        saved.push('信息');
      } catch {
        issues.push('信息保存失败');
      }
    }
    return { note: saved.length ? `含${saved.join('、')}` : '', issues };
  };

  // --- 任务登记表（供下载管理页渲染） ------------------------------------------

  /**
   * tasksRef: [{ key, taskId, title, artist, quality, filename, state, received, total,
   *              speed, error, handle, canPause, canResume, canRetry }]
   */
  const tasksRef = ref([]);
  const snapshotToPatch = (snap) => ({
    state: snap.state,
    received: snap.receivedBytes ?? 0,
    total: snap.totalBytes,
    speed: snap.bytesPerSecond,
    error: snap.error?.message || '',
    canPause: Boolean(snap.canPause),
    canResume: Boolean(snap.canResume),
    canRetry: Boolean(snap.canRetry),
  });
  const taskListLimit = 120;
  const upsertTask = (key, patch) => {
    const index = tasksRef.value.findIndex((t) => t.key === key);
    if (index >= 0) {
      tasksRef.value[index] = { ...tasksRef.value[index], ...patch };
    } else {
      tasksRef.value.unshift(patch);
    }
    // 上限保护：超限时优先淘汰已结束的任务，活动任务始终保留
    if (tasksRef.value.length > taskListLimit) {
      const isTerminal = (t) => ['completed', 'failed', 'canceled'].includes(t.state);
      const active = tasksRef.value.filter((t) => !isTerminal(t));
      const finished = tasksRef.value.filter(isTerminal);
      tasksRef.value = [
        ...active,
        ...finished.slice(0, Math.max(0, taskListLimit - active.length)),
      ];
    }
  };

  // --- 下载核心 --------------------------------------------------------------

  const activeWaits = new Set();
  const TERMINAL_STATES = ['completed', 'failed', 'canceled', 'interrupted'];

  // 嵌入工具授权状态（会话内缓存）。刮削开启且为嵌入模式时，下载前必须保证已授权：
  // 未授权则主动触发宿主授权弹窗；用户拒绝 → 取消本次下载（除非关闭刮削）。
  const isWindowsPlatform = /win/i.test(String(navigator.platform || navigator.userAgent));
  let embedAuthorized = false;
  let embedProbePending = null;

  /** 确保嵌入工具（echotag）已获运行授权。返回 true=已授权；false=被拒绝或不可用。 */
  const ensureEmbedAuthorized = async () => {
    if (!isWindowsPlatform) return false;
    if (embedAuthorized) return true;
    // 防并发：多路调用共享同一次探测（宿主在未授权时会弹确认框）
    if (!embedProbePending) {
      embedProbePending = ctx.process
        .launch({ executable: 'native/echotag-x64.exe', args: [] })
        .catch(() => null);
    }
    const probe = await embedProbePending;
    embedProbePending = null;
    embedAuthorized = Boolean(probe && probe.ok);
    return embedAuthorized;
  };

  /**
   * 刮削嵌入模式的授权闸门：刮削开启且为嵌入/双写模式时，
   * 未授权会在此处弹授权框；拒绝 → 返回 false（调用方取消下载）。
   */
  const gateEmbedAuthorization = async ({ quiet }) => {
    if (!settings.scrape) return true;
    const mode = settings.scrapeMode || 'embed';
    if (mode === 'sidecar') return true; // 伴生模式不需要嵌入工具
    const authorized = await ensureEmbedAuthorized();
    if (authorized) return true;
    if (!quiet) {
      ctx.toast.warning(
        '嵌入工具未授权，已取消本次下载。可在插件设置中关闭刮削或改为「伴生文件」，或重新下载并在弹窗中点「允许」',
      );
    }
    return false;
  };

  /**
   * 清理同一首歌的终态下载记录：
   * 用户手动删除已下载文件后，引擎的 completed 旧记录会因目标文件缺失而拒绝重建任务
   * （FILE_MISSING「已下载的文件不存在」）。这里把目标文件已不存在的终态记录清掉，
   * 使下一次下载走全新任务。force=true 时跳过存在性检查直接清理。
   */
  const purgeStaleDownloadRecords = async (sourceKey, force = false) => {
    let snapshots = [];
    try {
      snapshots = (await ctx.net.downloads.list({ offset: 0, limit: 100 })) || [];
    } catch {
      return false;
    }
    let removed = false;
    for (const snap of snapshots) {
      if (snap.sourceKey !== sourceKey) continue;
      if (!TERMINAL_STATES.includes(snap.state)) continue;
      if (!force) {
        const ref =
          snap.result?.file ??
          fileRef(snap.target?.directoryId ?? settings.directoryId, snap.target?.relativePath ?? '');
        let exists = true;
        try {
          await ctx.fs.stat(ref);
        } catch (error) {
          exists = error?.code !== 'FILE_MISSING';
        }
        if (exists) continue;
      }
      try {
        if (snap.state === 'interrupted') {
          const stale = await ctx.net.downloads.attach(snap.id).catch(() => null);
          if (stale) await stale.cancel().catch(() => {});
        }
        await ctx.net.downloads.remove(snap.id);
        removed = true;
      } catch {
        // 单条清理失败不阻断主流程
      }
    }
    return removed;
  };

  /**
   * 下载一首歌。interactive=true 时允许弹出目录选择器；quiet=true 时抑制单曲 toast。
   * 返回 { ok } 供调用方提示，任务进度在「下载管理」页可见。
   */
  const downloadSong = async ({
    song,
    interactive = false,
    qualityOverride,
    quiet = false,
  } = {}) => {
    const title = song?.title || song?.name || '未知标题';
    const artist = song?.artist || '未知歌手';
    if (!song?.hash) {
      if (!quiet) ctx.toast.warning(`「${title}」缺少歌曲标识，无法下载`);
      return { ok: false };
    }

    // 授权闸门：刮削开启且为嵌入模式时，必须先授权嵌入工具；拒绝则取消本次下载
    if (!(await gateEmbedAuthorization({ quiet }))) {
      return { ok: false, notAuthorized: true };
    }

    const dirResult = await ensureDirectory(interactive);
    if (!dirResult.ok) {
      if (interactive && !quiet) ctx.toast.warning(dirResult.reason);
      return { ok: false };
    }

    const wanted = qualityOverride || settings.quality;
    const key = `${song.hash}:${wanted}`;
    if (!quiet) ctx.toast.info(`开始下载「${title}」（${QUALITY_LABELS[wanted] || wanted}）`);

    const resolved = await resolveWithFallback(song, wanted);
    if (!resolved.ok) {
      if (!quiet) ctx.toast.danger(`「${title}」下载失败：${resolved.reason}`);
      return { ok: false };
    }
    if (resolved.quality !== wanted && !quiet) {
      ctx.toast.warning(
        `「${title}」无法获取 ${QUALITY_LABELS[wanted] || wanted}，已回退到 ${QUALITY_LABELS[resolved.quality]}`,
      );
    }

    const filename = `${buildFilename(song, resolved.quality, settings.template)}.${resolved.ext}`;
    const isVipLike = ['flac', 'high', 'viper_tape', 'viper_clear', 'viper_atmos'].includes(
      resolved.quality,
    );
    const conflict = settings.conflict === 'skip' ? 'fail' : settings.conflict || 'rename';

    // skip 策略：先探测同名文件是否存在，存在则跳过。
    if (settings.conflict === 'skip') {
      try {
        await ctx.fs.stat({
          kind: 'directory-file',
          directoryId: dirResult.directoryId,
          relativePath: filename,
        });
        if (!quiet) ctx.toast.warning(`「${filename}」已存在，已跳过`);
        return { ok: false, skipped: true };
      } catch (error) {
        if (error?.code !== 'FILE_MISSING') {
          if (!quiet) ctx.toast.danger(`检查文件失败：${error?.message || error}`);
          return { ok: false };
        }
      }
    }

    const sourceKey = `song:${song.hash}:${resolved.quality}`;
    const createTask = () =>
      ctx.net.download({
        url: resolved.url,
        target: { directoryId: dirResult.directoryId, relativePath: filename },
        name: filename,
        conflict,
        resume: true,
        sourceKey,
        idempotencyKey: key,
      });

    let handle;
    try {
      // 预清理：用户手动删除已下载文件后，旧终态记录会让引擎拒绝重建任务
      await purgeStaleDownloadRecords(sourceKey).catch(() => {});
      handle = await createTask();
    } catch (error) {
      const code = error?.code;
      if (code === 'FILE_MISSING' || code === 'SOURCE_CHANGED' || code === 'INVALID_ARGUMENT') {
        // 强制清理同源终态记录后重试一次
        const purged = await purgeStaleDownloadRecords(sourceKey, true).catch(() => false);
        if (purged) {
          try {
            handle = await createTask();
          } catch (retryError) {
            if (!quiet) ctx.toast.danger(`创建下载任务失败：${retryError?.message || retryError}`);
            return { ok: false };
          }
        } else {
          if (!quiet) ctx.toast.danger(`创建下载任务失败：${error?.message || error}`);
          return { ok: false };
        }
      } else {
        if (!quiet) ctx.toast.danger(`创建下载任务失败：${error?.message || error}`);
        return { ok: false };
      }
    }

    upsertTask(key, {
      key,
      taskId: handle.id,
      title,
      artist,
      quality: resolved.quality,
      filename,
      url: resolved.url,
      state: 'queued',
      received: 0,
      total: undefined,
      speed: undefined,
      error: '',
      handle,
      canPause: false,
      canResume: false,
      canRetry: false,
      isVipLike,
    });

    const unsubscribe = handle.subscribe((snap) => {
      upsertTask(key, snapshotToPatch(snap));
    });

    const waitPromise = handle
      .wait()
      .then(async (result) => {
        const savedName = result.file?.relativePath || filename;
        upsertTask(key, { filename: savedName });
        // 音乐刮削：写入音频标签或生成伴生文件（不阻塞任务状态展示）
        let scrapeNote = '';
        if (settings.scrape) {
          try {
            const baseName = savedName.replace(/\.[^.]+$/, '');
            const { note, issues } = await scrapeSidecars(
              song,
              dirResult.directoryId,
              baseName,
              resolved.quality,
              savedName,
            );
            scrapeNote = note;
            if (issues.length) {
              upsertTask(key, { scrapeNote: issues.join('；') });
              if (!quiet) ctx.toast.warning(`「${title}」${issues.join('；')}`);
            } else {
              upsertTask(key, { scrapeNote: '' });
            }
          } catch {
            // 刮削整体失败不影响音频
          }
        }
        if (!quiet) {
          const suffix = scrapeNote ? `（${scrapeNote}）` : '';
          ctx.toast.success(`已下载「${title}」→ ${savedName}${suffix}`);
        }
      })
      .catch((error) => {
        const message = error?.message || String(error);
        if (error?.name === 'AbortError') return;
        if (!quiet) ctx.toast.danger(`「${title}」下载失败：${message}`);
        upsertTask(key, { error: message });
      })
      .finally(() => {
        unsubscribe();
        activeWaits.delete(waitPromise);
      });
    activeWaits.add(waitPromise);
    return { ok: true };
  };

  // --- 歌曲右键菜单 -----------------------------------------------------------

  ctx.ui.addSongContextMenuItem({
    id: 'download-song',
    label: '下载歌曲',
    order: 50,
    async onSelect(song) {
      await downloadSong({ song, interactive: true });
    },
  });

  // --- 设置面板 ---------------------------------------------------------------

  const rowStyle = 'display:flex;justify-content:space-between;align-items:center;gap:12px;';
  const labelStyle = 'font-size:13px;color:var(--color-text-primary,#333);flex-shrink:0;';
  const hintStyle = 'font-size:12px;color:var(--color-text-tertiary,#999);line-height:1.5;';
  const selectStyle =
    'font-size:13px;padding:4px 8px;border-radius:8px;border:1px solid var(--color-border-tertiary,rgba(0,0,0,.15));background:var(--color-background-primary,#fff);color:var(--color-text-primary,#333);max-width:220px;';
  const inputStyle = `${selectStyle};width:220px;`;
  const buttonStyle =
    'font-size:13px;padding:5px 12px;border-radius:8px;border:none;cursor:pointer;background:#0F6E56;color:#fff;';

  const SettingsPanel = {
    setup() {
      const grantText = computed(() => {
        if (!settings.directoryId) return '未设置';
        if (grantAvailable === false) return `已失效（需重新授权）：${settings.displayPath}`;
        return settings.displayPath || settings.directoryId;
      });

      const chooseDirectory = async () => {
        const result = await ensureDirectory(true);
        if (result.ok) {
          ctx.toast.success(`下载目录已设置：${settings.displayPath || 'OK'}`);
        } else if (!result.reason.includes('取消')) {
          ctx.toast.warning(result.reason);
        }
      };

      return () =>
        h('div', { style: 'display:grid;gap:14px;padding:4px 0;' }, [
          // 下载目录
          h('div', {}, [
            h('div', { style: rowStyle }, [
              h('span', { style: labelStyle }, '下载目录'),
              h('button', { style: buttonStyle, onClick: chooseDirectory }, '选择目录…'),
            ]),
            h(
              'div',
              {
                style: `${hintStyle};margin-top:4px;word-break:break-all;`,
                title: grantText.value,
              },
              grantText.value,
            ),
          ]),
          // 下载音质
          h('label', { style: rowStyle }, [
            h('span', { style: labelStyle }, '下载音质'),
            h(
              'select',
              {
                style: selectStyle,
                value: settings.quality,
                onChange: (event) => {
                  settings.quality = event.target.value;
                  void saveSettings();
                },
              },
              Object.entries(QUALITY_LABELS).map(([value, label]) =>
                h('option', { value }, `${label}${value.startsWith('viper') || value === 'high' || value === 'flac' ? '（需对应权限）' : ''}`),
              ),
            ),
          ]),
          // 文件命名模板
          h('label', { style: rowStyle }, [
            h('span', { style: labelStyle }, '文件命名模板'),
            h('input', {
              style: inputStyle,
              value: settings.template,
              placeholder: '{artist} - {title}',
              onChange: (event) => {
                settings.template = sanitizeSegment(event.target.value) || DEFAULT_SETTINGS.template;
                event.target.value = settings.template;
                void saveSettings();
              },
            }),
          ]),
          h(
            'div',
            { style: hintStyle },
            '可用变量：{title} 歌名、{artist} 歌手、{album} 专辑、{quality} 音质。非法字符会自动替换为空格。',
          ),
          // 同名冲突
          h('label', { style: rowStyle }, [
            h('span', { style: labelStyle }, '同名文件'),
            h(
              'select',
              {
                style: selectStyle,
                value: settings.conflict,
                onChange: (event) => {
                  settings.conflict = event.target.value;
                  void saveSettings();
                },
              },
              [
                h('option', { value: 'rename' }, '自动重命名'),
                h('option', { value: 'replace' }, '覆盖'),
                h('option', { value: 'skip' }, '跳过'),
              ],
            ),
          ]),
          // 音质回退
          h('label', { style: rowStyle }, [
            h('span', { style: labelStyle }, '音质自动回退'),
            h('input', {
              type: 'checkbox',
              checked: settings.autoFallback,
              onChange: (event) => {
                settings.autoFallback = Boolean(event.target.checked);
                void saveSettings();
              },
            }),
          ]),
          // 音乐刮削
          h('div', { style: 'display:grid;gap:8px;padding:10px 12px;border-radius:10px;background:var(--color-background-tertiary,rgba(0,0,0,.04));' }, [
            h('label', { style: rowStyle }, [
              h('span', { style: `${labelStyle};font-weight:500;` }, '音乐刮削'),
              h('input', {
                type: 'checkbox',
                checked: settings.scrape,
                onChange: (event) => {
                  settings.scrape = Boolean(event.target.checked);
                  void saveSettings();
                },
              }),
            ]),
            h('label', { style: rowStyle }, [
              h('span', { style: labelStyle }, '写入方式'),
              h(
                'select',
                {
                  style: selectStyle,
                  value: settings.scrapeMode || 'embed',
                  disabled: !settings.scrape,
                  onChange: (event) => {
                    settings.scrapeMode = event.target.value;
                    void saveSettings();
                  },
                },
                [
                  h('option', { value: 'embed' }, '嵌入音频文件（推荐）'),
                  h('option', { value: 'sidecar' }, '伴生文件'),
                  h('option', { value: 'both' }, '两者都写'),
                ],
              ),
            ]),
            h(
              'div',
              { style: hintStyle },
              '嵌入：把标题/歌手/专辑/歌词/封面直接写进 MP3（ID3v2.3）或 FLAC（Vorbis 标签）文件本身；由插件内置工具完成，首次使用会弹授权确认。开启刮削且为嵌入/双写模式时，必须授权嵌入工具才能下载（未授权会每次弹窗，拒绝则取消下载）。伴生文件：生成 歌曲名.lrc / .jpg / .json。嵌入失败会自动回退为伴生文件。',
            ),
            h('label', { style: rowStyle }, [
              h('span', { style: labelStyle }, '写入歌词'),
              h('input', {
                type: 'checkbox',
                checked: settings.scrapeLyric,
                disabled: !settings.scrape,
                onChange: (event) => {
                  settings.scrapeLyric = Boolean(event.target.checked);
                  void saveSettings();
                },
              }),
            ]),
            h('label', { style: rowStyle }, [
              h('span', { style: labelStyle }, '写入封面'),
              h('input', {
                type: 'checkbox',
                checked: settings.scrapeCover,
                disabled: !settings.scrape,
                onChange: (event) => {
                  settings.scrapeCover = Boolean(event.target.checked);
                  void saveSettings();
                },
              }),
            ]),
            h('label', { style: rowStyle }, [
              h('span', { style: labelStyle }, '写入歌曲信息（伴生 .json）'),
              h('input', {
                type: 'checkbox',
                checked: settings.scrapeInfo,
                disabled: !settings.scrape,
                onChange: (event) => {
                  settings.scrapeInfo = Boolean(event.target.checked);
                  void saveSettings();
                },
              }),
            ]),
          ]),
          h(
            'div',
            { style: hintStyle },
            '开启后，目标音质获取失败会自动尝试更低音质（Hi-Res → 无损 → HQ → 标准）。所有设置即时保存。',
          ),
        ]);
    },
  };

  ctx.ui.settings.define({
    title: '音乐下载器',
    component: SettingsPanel,
  });

  // --- 下载管理页 -------------------------------------------------------------

  const stateTextMap = {
    queued: '排队中',
    connecting: '连接中',
    downloading: '下载中',
    paused: '已暂停',
    interrupted: '已中断',
    verifying: '校验中',
    committing: '保存中',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消',
  };

  const buttonSmall = (text, onClick, disabled) =>
    h(
      'button',
      {
        style: `${buttonStyle};padding:3px 10px;font-size:12px;${disabled ? 'opacity:.45;cursor:default;' : ''}`,
        onClick,
        disabled: Boolean(disabled),
      },
      text,
    );

  const DownloaderPage = {
    setup() {
      const busy = ref(false);
      const selfCheckLines = ref([]);
      const selfChecking = ref(false);

      // 打开页面时从宿主下载记录恢复历史已完成条目（应用重启后列表不再为空）；
      // 顺带清理旧版本遗留的临时封面任务记录（__echotag_*.tmp）。
      const loadHistory = async () => {
        let snapshots = [];
        try {
          snapshots = (await ctx.net.downloads.list({ offset: 0, limit: 100 })) || [];
        } catch {
          return; // 宿主记录不可用时静默跳过，历史功能属于锦上添花
        }
        const restored = [];
        for (const snap of snapshots) {
          const rel =
            snap.result?.file?.relativePath || snap.target?.relativePath || snap.name || '';
          // 遗留的嵌入临时文件记录：直接删除宿主记录，不进历史
          if (rel.includes('__echotag_')) {
            removeDownloadRecord(snap.id);
            continue;
          }
          if (snap.state !== 'completed') continue;
          if (!String(snap.sourceKey || '').startsWith('song:')) continue;
          if (tasksRef.value.some((t) => t.taskId === snap.id)) continue;
          const filename = snap.result?.file?.relativePath || rel;
          const base = filename.replace(/\.[^.]+$/, '');
          const quality = String(snap.sourceKey).split(':')[2] || '';
          restored.push({
            key: `history:${snap.id}`,
            taskId: snap.id,
            title: base || filename,
            artist: '',
            quality,
            filename,
            state: 'completed',
            received: snap.result?.bytes ?? snap.receivedBytes ?? 0,
            total: snap.totalBytes,
            speed: undefined,
            error: '',
            handle: undefined,
            canPause: false,
            canResume: false,
            canRetry: false,
            isHistory: true,
          });
        }
        if (restored.length) {
          // 历史条目排在当前会话任务之后
          tasksRef.value = [...tasksRef.value, ...restored];
        }
      };
      loadHistory();

      const downloadCurrent = async () => {
        const track = ctx.player.currentTrack;
        if (!track) {
          ctx.toast.warning('当前没有正在播放的歌曲');
          return;
        }
        busy.value = true;
        try {
          await downloadSong({ song: track, interactive: true });
        } finally {
          busy.value = false;
        }
      };

      // 清空已结束的任务（保留进行中的），不删除磁盘上的任何文件
      const clearFinished = () => {
        const isTerminal = (t) => ['completed', 'failed', 'canceled'].includes(t.state);
        const before = tasksRef.value.length;
        tasksRef.value = tasksRef.value.filter((t) => !isTerminal(t));
        const removed = before - tasksRef.value.length;
        if (removed) ctx.toast.info(`已清理 ${removed} 个已结束的任务`);
        else ctx.toast.info('没有可清理的任务');
      };

      // 刮削自检：逐步验证目录/嵌入工具授权/歌词/封面，把"刮不了"的原因直接显示出来
      const runSelfCheck = async () => {
        selfChecking.value = true;
        const lines = [];
        try {
          lines.push(
            settings.directoryId
              ? `✓ 下载目录：${settings.displayPath || settings.directoryId}`
              : '✗ 未设置下载目录（请先在设置中选择，或右键任意歌曲触发选择）',
          );
          if (settings.directoryId && grantAvailable === false) {
            lines.push('✗ 目录授权已失效，请在插件设置中重新选择目录');
          }
          if (!settings.scrape) {
            lines.push('－ 刮削总开关已关闭（设置 → 音乐刮削）');
          } else {
            // 嵌入工具授权探测：无参数启动 echotag（立即退出，无副作用），
            // 未授权时宿主会弹确认框 —— 在这里点「允许」后下载才不会被闸门拦下。
            const authorized = await ensureEmbedAuthorized();
            lines.push(
              authorized
                ? '✓ 嵌入工具可运行（echotag-x64.exe 授权有效）'
                : '✗ 嵌入工具未授权：请在弹出的确认框中点「允许」；当前设置下未授权将无法下载',
            );
            const track = ctx.player.currentTrack;
            if (track && track.hash) {
              lines.push(`－ 自检歌曲：「${track.title || track.name || '未知'}」`);
              try {
                const lrc = await fetchLrcText(track);
                lines.push(
                  lrc.trim()
                    ? `✓ 歌词可获取（${lrc.split('\n').length} 行）`
                    : '✗ 歌词接口无结果',
                );
              } catch (error) {
                lines.push(`✗ 歌词获取失败：${error?.message || error}`);
              }
              const cover = await resolveCoverUrl(track);
              lines.push(cover ? '✓ 封面可获取' : '✗ 未找到封面来源');
            } else {
              lines.push('－ 当前没有播放歌曲，跳过歌词/封面检查');
            }
          }
          lines.push('提示：若嵌入超时回退伴生文件，会在下载任务卡片上标明原因。');
        } finally {
          selfCheckLines.value = lines;
          selfChecking.value = false;
        }
      };

      const control = async (task, action) => {
        const handle = task.handle;
        if (!handle) return;
        try {
          if (action === 'pause') await handle.pause();
          else if (action === 'resume') await handle.resume({ url: task.url });
          else if (action === 'retry') await handle.retry({ url: task.url });
          else if (action === 'cancel') await handle.cancel();
        } catch (error) {
          ctx.toast.warning(`操作失败：${error?.message || error}`);
        }
      };

      return () =>
        h('div', { style: 'padding:20px 24px;max-width:860px;' }, [
          h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;' }, [
            h('h2', { style: 'font-size:18px;margin:0;' }, '下载管理'),
            h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
              buttonSmall('下载当前歌曲', downloadCurrent, busy.value),
              buttonSmall('刮削自检', runSelfCheck, selfChecking.value),
              buttonSmall('清空已完成', clearFinished, false),
            ]),
          ]),
          settings.directoryId
            ? h(
                'div',
                { style: hintStyle },
                `保存目录：${grantAvailable === false ? '（授权已失效，请在插件设置中重新授权）' : settings.displayPath || settings.directoryId}`,
              )
            : h('div', { style: `${hintStyle};color:#c2620a;` }, '尚未设置下载目录：请到「插件管理 → 音乐下载器 → 设置」中选择目录，或右键任意歌曲触发目录选择。'),
          selfCheckLines.value.length > 0
            ? h(
                'div',
                {
                  style:
                    'margin-top:12px;padding:10px 14px;border-radius:10px;border:1px solid var(--color-border-tertiary,rgba(0,0,0,.1));background:var(--color-background-secondary,#fafafa);display:grid;gap:4px;',
                },
                selfCheckLines.value.map((line, index) =>
                  h(
                    'div',
                    { key: index, style: 'font-size:12px;line-height:1.6;font-family:monospace;' },
                    line,
                  ),
                ),
              )
            : null,
          tasksRef.value.length === 0
            ? h(
                'div',
                {
                  style:
                    'margin-top:32px;text-align:center;font-size:13px;color:var(--color-text-tertiary,#999);',
                },
                '暂无下载任务。在歌曲列表右键选择「下载歌曲」，或点击右上角「下载当前歌曲」。',
              )
            : h(
                'div',
                { style: 'display:grid;gap:10px;margin-top:16px;' },
                tasksRef.value.map((task) => {
                  const percent =
                    task.total > 0 ? Math.min(100, Math.round((task.received / task.total) * 100)) : null;
                  const isActive = ['queued', 'connecting', 'downloading', 'verifying', 'committing'].includes(
                    task.state,
                  );
                  const rowChildren = [
                    h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:baseline;' }, [
                      h(
                        'span',
                        {
                          style: 'font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
                          title: task.filename,
                        },
                        `${task.title}${task.artist ? ` - ${task.artist}` : ''}`,
                      ),
                      h(
                        'span',
                        { style: 'font-size:12px;color:var(--color-text-secondary,#666);flex-shrink:0;' },
                        [
                          QUALITY_LABELS[task.quality] || task.quality,
                          ' · ',
                          stateTextMap[task.state] || task.state,
                          percent !== null ? ` · ${percent}%` : '',
                          task.state === 'downloading' && task.speed ? ` · ${formatBytes(task.speed)}/s` : '',
                        ],
                      ),
                    ]),
                    percent !== null
                      ? h(
                          'div',
                          {
                            style:
                              'height:6px;border-radius:3px;background:var(--color-background-tertiary,#eee);overflow:hidden;',
                          },
                          h('div', {
                            style: `height:100%;width:${percent}%;border-radius:3px;background:${task.state === 'completed' ? '#0F6E56' : '#1D9E75'};transition:width .3s;`,
                          }),
                        )
                      : null,
                    task.error
                      ? h('div', { style: `${hintStyle};color:#a32d2d;` }, task.error)
                      : null,
                    task.scrapeNote
                      ? h('div', { style: `${hintStyle};color:#854f0b;` }, `刮削：${task.scrapeNote}`)
                      : null,
                    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' }, [
                      task.canPause ? buttonSmall('暂停', () => control(task, 'pause')) : null,
                      task.canResume ? buttonSmall('恢复', () => control(task, 'resume')) : null,
                      task.canRetry ? buttonSmall('重试', () => control(task, 'retry')) : null,
                      isActive ? buttonSmall('取消', () => control(task, 'cancel')) : null,
                      task.state === 'completed'
                        ? h(
                            'span',
                            { style: 'font-size:12px;color:var(--color-text-tertiary,#999);' },
                            task.filename,
                          )
                        : null,
                    ]),
                  ];
                  return h(
                    'div',
                    {
                      key: task.key,
                      style:
                        'display:grid;gap:6px;padding:12px 14px;border-radius:12px;border:1px solid var(--color-border-tertiary,rgba(0,0,0,.1));background:var(--color-background-secondary,#fafafa);',
                    },
                    rowChildren.filter(Boolean),
                  );
                }),
              ),
        ]);
    },
  };

  ctx.ui.addPage({
    id: 'downloads',
    title: '下载管理',
    icon: '⬇️',
    order: 90,
    sidebar: { sectionTitle: '音乐下载器' },
    component: DownloaderPage,
  });
}

export function deactivate() {
  // 宿主会自动清理本插件注册的菜单、页面、设置面板与下载任务。
}
