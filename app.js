console.log('app.js loaded');
const audio = document.getElementById('video-player');
let isVideo = false;
let audioCtx, analyser, vizAnimId;
const DB_NAME = 'PlaylistFiles';
const DB_VER = 1;
const DB_STORE = 'files';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE, { keyPath: 'id' });
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

async function dbPut(id, data, name, type) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put({ id, data, name, type });
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
    });
}

async function dbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(id);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
    });
}

let songs = JSON.parse(localStorage.getItem('pl_songs2')) || [];
let playlists = JSON.parse(localStorage.getItem('pl_playlists2')) || [];
let queue = [];
let queueIndex = 0;
let currentPlaylistId = null;
let isPlaying = false;
let expandedPlaylistId = null;
let selectedArtist = 'all';
let currentBlobUrl = null;
let editingSongId = null;
let pendingEditFile = null;
let currentUser = null;
let sbUser = null; // Supabase auth user object
let sharedPlaylists = [];
let sharedGenreFilter = 'all';
let sharedDurationFilter = 'all';

function userKey(base) {
    if (!currentUser || currentUser === '__legacy__') return base;
    return base + '_' + currentUser;
}

async function loadUserData() {
    if (!sbUser) return;
    const username = sbUser.user_metadata?.username || sbUser.email?.replace('@pl.local', '') || currentUser;
    try {
        const dbSongs = await sbLoadSongs(sbUser.id);
        const hasLocalSongs = !dbSongs || dbSongs.length === 0;
        if (dbSongs && dbSongs.length > 0) {
            songs = dbSongs.map(s => ({
                id: s.id, title: s.title, artist: s.artist, url: s.url,
                logo: s.logo || '', lyrics: s.lyrics || '',
                filePath: s.file_path || '', isLocal: s.is_local || !!s.file_path
            }));
        }
        // Migrate localStorage data to Supabase if Supabase is empty
        if (hasLocalSongs && username) {
            const localSongs = JSON.parse(localStorage.getItem('pl_songs2_' + username)) || JSON.parse(localStorage.getItem('pl_songs2') || '[]');
            if (localSongs.length > 0) {
                songs = localSongs;
                await sbSaveSongs(sbUser.id, songs);
            }
        }
        const dbPlaylists = await sbLoadPlaylists(sbUser.id);
        const hasLocalPlaylists = !dbPlaylists || dbPlaylists.length === 0;
        if (dbPlaylists && dbPlaylists.length > 0) {
            playlists = dbPlaylists.map(p => ({ ...p, song_ids: typeof p.song_ids === 'string' ? JSON.parse(p.song_ids) : (p.song_ids || []) }));
        }
        if (hasLocalPlaylists && username) {
            const localPlaylists = JSON.parse(localStorage.getItem('pl_playlists2_' + username)) || JSON.parse(localStorage.getItem('pl_playlists2') || '[]');
            if (localPlaylists.length > 0) {
                playlists = localPlaylists;
                await sbSavePlaylists(sbUser.id, playlists);
            }
        }
    } catch (e) {
        console.warn('Failed to load from Supabase, using local fallback', e);
        songs = JSON.parse(localStorage.getItem(userKey('pl_songs2'))) || JSON.parse(localStorage.getItem('pl_songs2') || '[]');
        playlists = JSON.parse(localStorage.getItem(userKey('pl_playlists2'))) || JSON.parse(localStorage.getItem('pl_playlists2') || '[]');
    }
    try {
        const serverData = await sbLoadShared();
        const map = new Map(sharedPlaylists.map(p => [p.id, p]));
        serverData.forEach(p => map.set(p.id, p));
        sharedPlaylists = Array.from(map.values());
        saveShared();
        renderSharedPlaylists();
    } catch (e) {
        console.warn('Failed to load shared playlists', e);
        sharedPlaylists = migrateSharedPlaylists();
        renderSharedPlaylists();
    }

    const savedUI = JSON.parse(localStorage.getItem(userKey('pl_ui')));
    if (savedUI) {
        uiSettings = savedUI;
    } else {
        uiSettings = { bgImages: [], bgMode: 'single', bgInterval: 10, bgIndex: 0, accent: '#6c63ff', blur: 10, dim: 50, playBtnImage: '' };
    }
}

async function saveUserData() {
    if (sbUser && sbConfigured) {
        try {
            await sbSaveSongs(sbUser.id, songs);
            await sbSavePlaylists(sbUser.id, playlists);
        } catch (e) {
            console.warn('Supabase save failed, saving to localStorage', e);
        }
    }
    // Always save to localStorage as backup
    localStorage.setItem(userKey('pl_songs2'), JSON.stringify(songs));
    localStorage.setItem(userKey('pl_playlists2'), JSON.stringify(playlists));
}

// YouTube playback
let ytPlayer = null;
let ytReady = false;
let ytTimer = null;
let ytPendingId = null;

function getYouTubeId(url) {
    if (!url) return null;
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) { onYouTubeIframeAPIReady(); return; }
    if (document.querySelector('script[src*="youtube.com/iframe_api"]')) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onload = () => { if (window.YT && window.YT.Player) onYouTubeIframeAPIReady(); };
    document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = function() {
    if (ytPlayer) return;
    ytPlayer = new YT.Player('yt-container', {
        height: 1, width: 1,
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0, iv_load_policy: 3 },
        events: {
            onReady: () => {
                ytReady = true;
                if (ytPendingId) { ytPlayer.loadVideoById(ytPendingId); ytPendingId = null; }
            },
            onStateChange: e => {
                if (e.data === YT.PlayerState.ENDED) {
                    stopYtTimer();
                    if (queueIndex < queue.length - 1) { queueIndex++; loadSong(queueIndex); }
                    else { isPlaying = false; updatePlayerUI(); }
                } else if (e.data === YT.PlayerState.PLAYING) {
                    isPlaying = true;
                    updatePlayerUI();
                    startYtTimer();
                } else if (e.data === YT.PlayerState.PAUSED) {
                    isPlaying = false; stopYtTimer(); updatePlayerUI();
                }
            },
            onError: () => {}
        }
    });
};

function startYtTimer() {
    stopYtTimer();
    ytTimer = setInterval(() => {
        if (!ytPlayer || !ytPlayer.getCurrentTime) return;
        const cur = ytPlayer.getCurrentTime();
        const dur = ytPlayer.getDuration();
        document.getElementById('current-time').textContent = formatTime(cur);
        document.getElementById('total-time').textContent = formatTime(dur);
        document.getElementById('progress-bar').value = dur > 0 ? (cur / dur) * 100 : 0;
    }, 250);
}

function stopYtTimer() {
    if (ytTimer) { clearInterval(ytTimer); ytTimer = null; }
}

function isYouTubeUrl(url) {
    return !!getYouTubeId(url);
}

const GENRE_LABELS = {
    pop:'팝', rnb:'R&B', rock:'록', ballad:'발라드', jpop:'JPop', kpop:'KPop',
    hiphop:'힙합', edm:'EDM', indie:'인디', classic:'클래식', jazz:'재즈',
    country:'컨트리', folk:'포크', metal:'메탈', reggae:'레게', soul:'소울',
    funk:'펑크', blues:'블루스', other:'기타'
};

const DURATION_LABELS = {
    '30min':'30분', '1h':'1시간', '2h':'2시간', '3h':'3시간', other:'기타'
};

let slideshowTimer = null;

// UI settings
let uiSettings = { bgImages: [], bgMode: 'single', bgInterval: 10, bgIndex: 0, accent: '#6c63ff', blur: 10, dim: 50, playBtnImage: '' };

function applyUI() {
    const root = document.documentElement;
    root.style.setProperty('--accent', uiSettings.accent);
    root.style.setProperty('--accent-hover', adjustColor(uiSettings.accent, -20));

    const layer = document.getElementById('bg-layer');
    const images = uiSettings.bgImages;
    if (uiSettings.bgIndex >= images.length && images.length > 0) uiSettings.bgIndex = 0;
    const idx = uiSettings.bgIndex;
    if (images.length > 0 && images[idx]) {
        layer.style.backgroundImage = 'url(' + images[idx] + ')';
    } else {
        layer.style.backgroundImage = '';
    }

    const style = document.getElementById('bg-style') || (function() {
        const s = document.createElement('style');
        s.id = 'bg-style';
        document.head.appendChild(s);
        return s;
    })();
    style.textContent = '.bg-layer::after { backdrop-filter: blur(' + uiSettings.blur + 'px) !important; -webkit-backdrop-filter: blur(' + uiSettings.blur + 'px) !important; background: rgba(0,0,0,' + (uiSettings.dim / 100) + ') !important; }';

    // Apply play button image
    const playBtn = document.getElementById('play-btn');
    if (uiSettings.playBtnImage) {
        playBtn.style.backgroundImage = 'url(' + uiSettings.playBtnImage + ')';
        playBtn.style.backgroundSize = 'cover';
        playBtn.style.backgroundPosition = 'center';
        playBtn.style.fontSize = '0';
    } else {
        playBtn.style.backgroundImage = '';
        playBtn.style.backgroundSize = '';
        playBtn.style.backgroundPosition = '';
        playBtn.style.fontSize = '';
    }

    // Play button preview
    const preview = document.getElementById('play-btn-preview');
    if (preview) {
        preview.innerHTML = uiSettings.playBtnImage
            ? '<div class="preview-circle" style="background-image:url(' + uiSettings.playBtnImage + ')"></div><span style="color:var(--text-secondary);font-size:0.82rem">커스텀 이미지 사용중</span>'
            : '<span style="color:var(--text-secondary);font-size:0.82rem">기본 버튼 (그라데이션)</span>';
    }

    // Render gallery
    renderBgGallery();

    // Slideshow management
    if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
    if (uiSettings.bgMode === 'slideshow' && images.length > 1) {
        slideshowTimer = setInterval(() => {
            uiSettings.bgIndex = (uiSettings.bgIndex + 1) % images.length;
            saveUI();
            applyUI();
        }, uiSettings.bgInterval * 1000);
    }

    // Update form
    document.getElementById('play-btn-img-url').value = '';
    document.getElementById('accent-color').value = uiSettings.accent;
    document.getElementById('bg-blur').value = uiSettings.blur;
    document.getElementById('blur-value').textContent = uiSettings.blur;
    document.getElementById('bg-dim').value = uiSettings.dim;
    document.getElementById('dim-value').textContent = uiSettings.dim;

    // Radio + slideshow options
    const modeRadios = document.querySelectorAll('input[name="bg-mode"]');
    modeRadios.forEach(r => r.checked = r.value === uiSettings.bgMode);
    document.getElementById('slideshow-options').style.display = uiSettings.bgMode === 'slideshow' ? 'flex' : 'none';
    document.getElementById('bg-interval').value = String(uiSettings.bgInterval);
}

function renderBgGallery() {
    const gallery = document.getElementById('bg-gallery');
    if (!gallery) return;
    const images = uiSettings.bgImages;
    if (images.length === 0) {
        gallery.innerHTML = '<p style="color:var(--text-secondary);font-size:0.82rem">등록된 배경 이미지가 없습니다</p>';
        return;
    }
    gallery.innerHTML = images.map((img, i) =>
        '<div class="bg-thumb' + (i === uiSettings.bgIndex ? ' active' : '') + '" onclick="setBgIndex(' + i + ')">' +
            '<img src="' + img + '" loading="lazy">' +
            '<button class="del-btn" onclick="event.stopPropagation();removeBgImage(' + i + ')">✕</button>' +
        '</div>'
    ).join('');
}

function addBgImage() {
    const url = document.getElementById('bg-url').value.trim();
    if (!url) { alert('이미지 URL을 입력하거나 파일 선택/드래그하세요.'); return; }
    uiSettings.bgImages.push(url);
    if (uiSettings.bgImages.length === 1) uiSettings.bgIndex = 0;
    document.getElementById('bg-url').value = '';
    saveUI();
    applyUI();
}

function removeBgImage(index) {
    uiSettings.bgImages.splice(index, 1);
    if (uiSettings.bgImages.length === 0) {
        uiSettings.bgIndex = 0;
    } else if (uiSettings.bgIndex >= uiSettings.bgImages.length) {
        uiSettings.bgIndex = uiSettings.bgImages.length - 1;
    }
    saveUI();
    applyUI();
}

function setBgIndex(index) {
    uiSettings.bgIndex = index;
    saveUI();
    applyUI();
}

function setBgMode(mode) {
    uiSettings.bgMode = mode;
    saveUI();
    applyUI();
}

function setBgInterval(sec) {
    uiSettings.bgInterval = parseInt(sec);
    saveUI();
    applyUI();
}

function setPlayBtnImage() {
    const url = document.getElementById('play-btn-img-url').value.trim();
    if (!url) { alert('이미지 URL을 입력하거나 파일을 드래그하세요.'); return; }
    uiSettings.playBtnImage = url;
    document.getElementById('play-btn-img-url').value = '';
    saveUI();
    applyUI();
}

function clearPlayBtnImage() {
    uiSettings.playBtnImage = '';
    saveUI();
    applyUI();
}

function saveUI() {
    localStorage.setItem(userKey('pl_ui'), JSON.stringify(uiSettings));
}

function adjustColor(hex, amount) {
    let c = parseInt(hex.slice(1), 16);
    let r = Math.max(0, Math.min(255, (c >> 16) + amount));
    let g = Math.max(0, Math.min(255, ((c >> 8) & 0xff) + amount));
    let b = Math.max(0, Math.min(255, (c & 0xff) + amount));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function applyAccent() {
    uiSettings.accent = document.getElementById('accent-color').value;
    saveUI();
    applyUI();
}

document.getElementById('bg-blur').addEventListener('input', function() {
    uiSettings.blur = parseInt(this.value);
    document.getElementById('blur-value').textContent = uiSettings.blur;
    saveUI();
    applyUI();
});

document.getElementById('bg-dim').addEventListener('input', function() {
    uiSettings.dim = parseInt(this.value);
    document.getElementById('dim-value').textContent = uiSettings.dim;
    saveUI();
    applyUI();
});

function resetUI() {
    if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
    uiSettings = { bgImages: [], bgMode: 'single', bgInterval: 10, bgIndex: 0, accent: '#6c63ff', blur: 10, dim: 50, playBtnImage: '' };
    saveUI();
    applyUI();
}

function readImageFile(file, callback) {
    if (!file || !file.type.startsWith('image/')) { alert('유효한 이미지 파일이 아닙니다.'); return; }
    const reader = new FileReader();
    reader.onload = function() { callback(reader.result); };
    reader.readAsDataURL(file);
}

// Background image: file input
document.getElementById('bg-file-input').addEventListener('change', function() {
    readImageFile(this.files[0], function(dataUrl) {
        uiSettings.bgImages.push(dataUrl);
        if (uiSettings.bgImages.length === 1) uiSettings.bgIndex = 0;
        saveUI();
        applyUI();
    });
    this.value = '';
});

// Background image: drag & drop
const bgDropZone = document.getElementById('bg-drop-zone');
bgDropZone.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); bgDropZone.classList.add('drag-over'); });
bgDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; bgDropZone.classList.add('drag-over'); });
bgDropZone.addEventListener('dragleave', e => {
    e.preventDefault();
    e.stopPropagation();
    if (bgDropZone.contains(e.relatedTarget)) return;
    bgDropZone.classList.remove('drag-over');
});
bgDropZone.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    bgDropZone.classList.remove('drag-over');
    readImageFile(e.dataTransfer.files[0], function(dataUrl) {
        uiSettings.bgImages.push(dataUrl);
        if (uiSettings.bgImages.length === 1) uiSettings.bgIndex = 0;
        saveUI();
        applyUI();
    });
});

// Play button image: file input
document.getElementById('play-btn-file-input').addEventListener('change', function() {
    readImageFile(this.files[0], function(dataUrl) {
        uiSettings.playBtnImage = dataUrl;
        saveUI();
        applyUI();
    });
    this.value = '';
});

// Play button image: drag & drop
const playBtnDropZone = document.getElementById('play-btn-drop-zone');
if (playBtnDropZone) {
    playBtnDropZone.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); playBtnDropZone.classList.add('drag-over'); });
    playBtnDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; playBtnDropZone.classList.add('drag-over'); });
    playBtnDropZone.addEventListener('dragleave', e => {
        e.preventDefault();
        e.stopPropagation();
        if (playBtnDropZone.contains(e.relatedTarget)) return;
        playBtnDropZone.classList.remove('drag-over');
    });
    playBtnDropZone.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        playBtnDropZone.classList.remove('drag-over');
        readImageFile(e.dataTransfer.files[0], function(dataUrl) {
            uiSettings.playBtnImage = dataUrl;
            saveUI();
            applyUI();
        });
    });
}

function formatTime(s) {
    if (isNaN(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
}

async function save() {
    await saveUserData();
}

function migrateSharedPlaylists() {
    let existing = [];
    try {
        const raw = localStorage.getItem('pl_shared');
        if (raw) existing = JSON.parse(raw);
        if (!Array.isArray(existing)) existing = [];
    } catch (_) { existing = []; }
    const seen = new Set(existing.map(p => p && p.id).filter(Boolean));
    let migrated = false;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('pl_shared_') && key !== 'pl_shared') {
            try {
                const raw = localStorage.getItem(key);
                if (raw) {
                    const data = JSON.parse(raw);
                    if (Array.isArray(data)) {
                        data.forEach(p => { if (p && p.id && !seen.has(p.id)) { existing.push(p); seen.add(p.id); migrated = true; } });
                    }
                }
            } catch (_) {}
            localStorage.removeItem(key);
        }
    }
    if (migrated) {
        try { localStorage.setItem('pl_shared', JSON.stringify(existing)); } catch (_) {}
    }
    return existing;
}

async function saveShared() {
    try {
        if (!Array.isArray(sharedPlaylists)) sharedPlaylists = [];
        localStorage.setItem('pl_shared', JSON.stringify(sharedPlaylists));
    } catch (_) {
        console.warn('saveShared: localStorage write failed (quota?)');
    }
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function readAudioMetadata(buf) {
    const d = new Uint8Array(buf);
    let title = '', artist = '';
    if (d.length < 10) return { title, artist };

    // ID3v2
    if (d[0] === 0x49 && d[1] === 0x44 && d[2] === 0x53) {
        const size = ((d[6] & 0x7f) << 21) | ((d[7] & 0x7f) << 14) | ((d[8] & 0x7f) << 7) | (d[9] & 0x7f);
        let pos = 10, end = Math.min(10 + size, d.length);
        while (pos + 10 <= end) {
            let fid = '';
            for (let i = 0; i < 4; i++) { const c = d[pos + i]; if (c < 0x41 || c > 0x5A) break; fid += String.fromCharCode(c); }
            if (fid.length < 3) break;
            const frSize = (d[pos+4] << 24) | (d[pos+5] << 16) | (d[pos+6] << 8) | d[pos+7];
            if (frSize <= 0) break;
            if (fid === 'TIT2' || fid === 'TPE1') {
                const enc = d[pos + 10];
                let s = '', i = pos + 11, e = pos + 10 + frSize;
                if (enc === 0) { while (i < e && d[i]) s += String.fromCharCode(d[i++]); }
                else if (enc === 3) { while (i < e && d[i]) s += String.fromCharCode(d[i++]); }
                else {
                    if (e - i >= 2 && d[i] === 0xFF && d[i+1] === 0xFE) i += 2;
                    else if (e - i >= 2 && d[i] === 0xFE && d[i+1] === 0xFF) i += 2;
                    while (i + 1 < e && (d[i] || d[i+1])) { const code = d[i] | (d[i+1] << 8); if (code >= 0x20) s += String.fromCharCode(code); i += 2; }
                }
                if (fid === 'TIT2' && s.trim()) title = s.trim();
                else if (fid === 'TPE1' && s.trim()) artist = s.trim();
            }
            pos += 10 + frSize;
        }
    }
    // ID3v1 fallback
    if (!title && d.length >= 128) {
        const off = d.length - 128;
        if (d[off] === 0x54 && d[off+1] === 0x41 && d[off+2] === 0x47) {
            for (let i = 0; i < 30; i++) { if (!d[off+3+i]) break; title += String.fromCharCode(d[off+3+i]); }
            for (let i = 0; i < 30; i++) { if (!d[off+33+i]) break; artist += String.fromCharCode(d[off+33+i]); }
            title = title.trim(); artist = artist.trim();
        }
    }
    return { title, artist };
}

function getSong(id) {
    return songs.find(s => s.id === id);
}

function getPlaylist(id) {
    return playlists.find(p => p.id === id);
}

function getPlaylistSongs(pid) {
    const pl = getPlaylist(pid);
    if (!pl) return [];
    return pl.songs.map(id => getSong(id)).filter(Boolean);
}

function getArtists() {
    return [...new Set(songs.map(s => s.artist).filter(Boolean))].sort();
}

document.getElementById('filter-bar').addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (btn) {
        selectedArtist = btn.dataset.filter;
        renderLibrary();
    }
});

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const tab = document.getElementById(btn.dataset.tab);
        tab.classList.add('active');
        if (btn.dataset.tab === 'player') {
            renderPlayer();
            const song = queue[queueIndex];
            if (song && getYouTubeId(song.url)) {
                startYtTimer();
            } else if (isVideo) {
                showVideoDisplay();
            } else if (isPlaying) {
                startVisualizer();
            }
        } else if (btn.dataset.tab === 'community') {
            stopVisualizer();
            stopYtTimer();
            hideVideoDisplay();
            hideMiniPlayer();
            renderCommunity();
        } else {
            stopVisualizer();
            stopYtTimer();
            if (isVideo && queue.length > 0) showMiniPlayer();
        }
    });
});

// Auto-extract title from URL
document.getElementById('song-url').addEventListener('input', function () {
    const url = this.value.trim();
    if (url && !document.getElementById('song-title').value) {
        const name = url.split('/').pop().split('?')[0].replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
        if (name) document.getElementById('song-title').value = name;
    }
});

// Add song
document.getElementById('add-song-form').addEventListener('submit', e => {
    e.preventDefault();
    const title = document.getElementById('song-title').value.trim();
    const artist = document.getElementById('song-artist').value.trim();
    const url = document.getElementById('song-url').value.trim();
    if (!title || !artist) return;
    if (url) {
        songs.push({ id: uid(), title, artist, url, fileId: null, isLocal: false });
        save();
        renderLibrary();
        e.target.reset();
    }
});

// Add playlist
let pendingCreatePlLogo = null;

function setCreatePlLogo() {
    const url = document.getElementById('create-pl-logo-url').value.trim();
    if (!url) return;
    pendingCreatePlLogo = url;
    document.getElementById('create-pl-logo-preview').innerHTML = '<img style="width:40px;height:40px;border-radius:8px;object-fit:cover" src="' + esc(url) + '">';
}

function clearCreatePlLogo() {
    pendingCreatePlLogo = null;
    document.getElementById('create-pl-logo-url').value = '';
    document.getElementById('create-pl-logo-preview').innerHTML = '';
}

document.getElementById('create-pl-logo-file').addEventListener('change', function() {
    const file = this.files[0];
    if (!file || !file.type.startsWith('image/')) { alert('유효한 이미지 파일이 아닙니다.'); return; }
    const reader = new FileReader();
    reader.onload = function() {
        pendingCreatePlLogo = reader.result;
        document.getElementById('create-pl-logo-preview').innerHTML = '<img style="width:40px;height:40px;border-radius:8px;object-fit:cover" src="' + reader.result + '">';
    };
    reader.readAsDataURL(file);
    this.value = '';
});

document.getElementById('add-playlist-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('playlist-name').value.trim();
    if (!name) return;
    const pl = { id: uid(), name, songs: [] };
    if (pendingCreatePlLogo) pl.logo = pendingCreatePlLogo;
    playlists.push(pl);
    pendingCreatePlLogo = null;
    save();
    renderPlaylists();
    e.target.reset();
    document.getElementById('create-pl-logo-preview').innerHTML = '';
});

// Player controls
document.getElementById('play-btn').addEventListener('click', togglePlay);
document.getElementById('next-btn').addEventListener('click', nextSong);
document.getElementById('prev-btn').addEventListener('click', prevSong);

document.getElementById('volume-bar').addEventListener('input', function () {
    audio.volume = this.value;
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(this.value * 100);
});

// Audio events
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('play', () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
});
audio.addEventListener('loadedmetadata', () => {
    isVideo = audio.videoWidth > 0 && audio.videoHeight > 0;
    document.getElementById('total-time').textContent = formatTime(audio.duration);
    if (isVideo) {
        stopVisualizer();
        const activeTab = document.querySelector('.tab-btn.active');
        if (activeTab && activeTab.dataset.tab === 'player') {
            showVideoDisplay();
        } else {
            showMiniPlayer();
        }
    } else {
        hideVideoDisplay();
        hideMiniPlayer();
        if (!audio.paused) startVisualizer();
    }
});
audio.addEventListener('ended', () => {
    stopVisualizer();
    if (queueIndex < queue.length - 1) {
        queueIndex++;
        loadSong(queueIndex);
    } else {
        isPlaying = false;
        updatePlayerUI();
    }
});
audio.addEventListener('error', () => {
    isPlaying = false;
    stopVisualizer();
    document.getElementById('play-btn').textContent = '오류';
});

document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
    }
});

// Drag & drop
const libSection = document.getElementById('library');
const dropOverlay = document.getElementById('drop-overlay');

libSection.addEventListener('dragenter', e => {
    e.preventDefault();
    e.stopPropagation();
    dropOverlay.classList.add('visible');
});

libSection.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
});

libSection.addEventListener('dragleave', e => {
    e.preventDefault();
    e.stopPropagation();
    const rect = libSection.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX >= rect.right ||
        e.clientY < rect.top || e.clientY >= rect.bottom) {
        dropOverlay.classList.remove('visible');
    }
});

libSection.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    dropOverlay.classList.remove('visible');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/') || f.type.startsWith('video/'));
    if (files.length === 0) {
        alert('오디오 또는 비디오 파일만 추가할 수 있습니다.');
        return;
    }
    if (files.length === 1) {
        await addFileSong(files[0]);
        renderLibrary();
        renderPlaylists();
    } else {
        await showBatchModal(files);
    }
});

async function addFileSong(file) {
    const data = await file.arrayBuffer();
    const meta = readAudioMetadata(data);
    const title = meta.title || file.name.replace(/\.[^.]+$/, '');
    const artist = meta.artist || '알 수 없음';
    let filePath = '';
    if (sbUser) {
        try {
            filePath = await sbUploadFile(sbUser.id, file);
        } catch (e) {
            console.warn('Supabase upload failed, using local fallback', e);
        }
    }
    if (!filePath) {
        const fid = (currentUser || 'anon') + '_' + uid();
        await dbPut(fid, data, file.name, file.type);
        filePath = 'idxdb:' + fid;
    }
    songs.push({
        id: uid(), title, artist,
        url: '', filePath: filePath, isLocal: true
    });
    save();
}

// Batch file metadata editing
let pendingBatch = [];

async function showBatchModal(files) {
    const list = document.getElementById('batch-list');
    const count = document.getElementById('batch-count');
    count.textContent = '(' + files.length + '개)';
    pendingBatch = [];
    list.innerHTML = '';

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fid = (currentUser || 'anon') + '_' + uid();
        const data = await file.arrayBuffer();
        const meta = readAudioMetadata(data);
        const title = meta.title || file.name.replace(/\.[^.]+$/, '');
const artist = meta.artist || '알 수 없음';

        pendingBatch.push({ file, fid, data, name: file.name, title, artist, meta, type: file.type });

        const item = document.createElement('div');
        item.className = 'batch-item';
        item.innerHTML =
            '<span class="batch-item-index">' + (i + 1) + '</span>' +
            '<div class="batch-item-fields">' +
            '<input class="batch-title" value="' + esc(title).replace(/"/g, '&quot;') + '" placeholder="제목">' +
            '<input class="batch-artist" value="' + esc(artist).replace(/"/g, '&quot;') + '" placeholder="아티스트">' +
            '</div>';
        item.querySelector('.batch-title').dataset.idx = i;
        item.querySelector('.batch-artist').dataset.idx = i;
        list.appendChild(item);
    }

    document.getElementById('batch-modal').classList.add('visible');
}

function closeBatchModal() {
    document.getElementById('batch-modal').classList.remove('visible');
    pendingBatch = [];
}

async function confirmBatchAdd() {
    const inputs = document.querySelectorAll('.batch-item');
    for (let i = 0; i < inputs.length; i++) {
        const item = inputs[i];
        const entry = pendingBatch[i];
        if (!entry) continue;
        const title = item.querySelector('.batch-title').value.trim() || entry.title;
        const artist = item.querySelector('.batch-artist').value.trim() || entry.artist;
        let filePath = '';
        if (sbUser) {
            try {
                const blob = new Blob([entry.data], { type: entry.type || 'audio/mpeg' });
                const fakeFile = new File([blob], entry.name, { type: entry.type || 'audio/mpeg' });
                filePath = await sbUploadFile(sbUser.id, fakeFile);
            } catch (e) {
                console.warn('Supabase upload failed', e);
            }
        }
        if (!filePath) {
            await dbPut(entry.fid, entry.data, entry.name, entry.type || 'audio/mpeg');
            filePath = 'idxdb:' + entry.fid;
        }
        songs.push({
            id: uid(), title, artist,
            url: '', filePath: filePath, isLocal: true
        });
    }
    save();
    closeBatchModal();
    renderLibrary();
    renderPlaylists();
}

// Library
async function deleteSong(id) {
    const song = getSong(id);
    if (!song) return;
    if (song.filePath) {
        if (song.filePath.startsWith('idxdb:')) {
            try { await dbDelete(song.filePath.slice(6)); } catch (_) {}
        } else if (sbUser) {
            try { await sbDeleteFile(song.filePath); } catch (_) {}
        }
    } else if (song.fileId) {
        try { await dbDelete(song.fileId); } catch (_) {}
    }
    if (queue[queueIndex] && queue[queueIndex].id === id) {
        if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
        audio.pause();
        audio.src = '';
        if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
        stopYtTimer();
    }
    songs = songs.filter(s => s.id !== id);
    playlists.forEach(p => {
        p.songs = p.songs.filter(sid => sid !== id);
    });
    save();
    renderLibrary();
    renderPlaylists();
}

function renderLibrary() {
    const artists = getArtists();
    const filter = document.getElementById('filter-bar');
    filter.innerHTML = '<button class="chip' + (selectedArtist === 'all' ? ' active' : '') + '" data-filter="all">전체</button>' +
        artists.map(a => '<button class="chip' + (selectedArtist === a ? ' active' : '') + '" data-filter="' + esc(a).replace(/'/g, '&#39;') + '">' + esc(a) + '</button>').join('');

    const filtered = selectedArtist === 'all' ? songs : songs.filter(s => s.artist === selectedArtist);

    const list = document.getElementById('song-list');
    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">' + (songs.length === 0 ? '저장된 노래가 없습니다. 새로 노래를 추가하거나 파일을 드래그하세요.' : '선택한 아티스트의 노래가 없습니다.') + '</div>';
        return;
    }
    list.innerHTML = filtered.map(s =>
        '<div class="card">' +
            '<div class="info">' +
                (s.logo
                    ? '<img class="song-logo" src="' + esc(s.logo) + '">'
                    : '<div class="song-logo-placeholder">></div>') +
                '<div class="text-group">' +
                    '<h4>' + esc(s.title) + '</h4>' +
                    '<p>' + esc(s.artist) + '</p>' +
                '</div>' +
            '</div>' +
            '<div class="actions">' +
                '<button class="btn-small play-btn" onclick="playLibrarySong(\'' + s.id + '\')">재생</button>' +
                '<button class="btn-small" onclick="editSong(\'' + s.id + '\')">수정</button>' +
                '<button class="btn-danger" onclick="deleteSong(\'' + s.id + '\')">삭제</button>' +
            '</div>' +
        '</div>'
    ).join('');
}

// Edit song
function editSong(id) {
    const song = getSong(id);
    if (!song) return;
    editingSongId = id;
    document.getElementById('edit-title').value = song.title;
    document.getElementById('edit-artist').value = song.artist;
    document.getElementById('edit-url').value = song.url || '';
    document.getElementById('edit-logo-url').value = '';
    document.getElementById('edit-lyrics').value = song.lyrics || '';
    document.getElementById('edit-drop-zone').querySelector('p').textContent = '오디오/비디오 파일을 끌어다 놓으세요 (선택)';
    pendingEditFile = null;
    renderEditLogoPreview(song.logo || '');
    document.getElementById('edit-modal').classList.add('show');
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.remove('show');
    editingSongId = null;
    pendingEditFile = null;
    pendingEditLogo = null;
    const dz = document.getElementById('edit-logo-drop-zone');
    if (dz) dz.classList.remove('drag-over');
}

let pendingEditLogo = null;

function renderEditLogoPreview(url) {
    const el = document.getElementById('edit-logo-preview');
    if (url) {
        el.innerHTML = '<img src="' + esc(url) + '"><span style="color:var(--text-secondary);font-size:0.82rem">로고 사용중</span>';
    } else {
        el.innerHTML = '<span style="color:var(--text-secondary);font-size:0.82rem">로고 없음</span>';
    }
}

function setEditLogo() {
    const url = document.getElementById('edit-logo-url').value.trim();
    if (!url) return;
    pendingEditLogo = url;
    renderEditLogoPreview(url);
}

function clearEditLogo() {
    pendingEditLogo = null;
    document.getElementById('edit-logo-url').value = '';
    renderEditLogoPreview('');
}

document.getElementById('edit-logo-file').addEventListener('change', function() {
    const file = this.files[0];
    if (!file || !file.type.startsWith('image/')) { alert('유효한 이미지 파일이 아닙니다.'); return; }
    const reader = new FileReader();
    reader.onload = function() {
        pendingEditLogo = reader.result;
        renderEditLogoPreview(pendingEditLogo);
    };
    reader.readAsDataURL(file);
    this.value = '';
});

// Edit logo drag & drop
const editLogoDropZone = document.getElementById('edit-logo-drop-zone');
if (editLogoDropZone) {
    editLogoDropZone.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); editLogoDropZone.classList.add('drag-over'); });
    editLogoDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; editLogoDropZone.classList.add('drag-over'); });
    editLogoDropZone.addEventListener('dragleave', e => {
        e.preventDefault();
        e.stopPropagation();
        if (editLogoDropZone.contains(e.relatedTarget)) return;
        editLogoDropZone.classList.remove('drag-over');
    });
    editLogoDropZone.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        editLogoDropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file || !file.type.startsWith('image/')) { alert('유효한 이미지 파일이 아닙니다.'); return; }
        const reader = new FileReader();
        reader.onload = function() {
            pendingEditLogo = reader.result;
            renderEditLogoPreview(pendingEditLogo);
        };
        reader.readAsDataURL(file);
    });
}

document.getElementById('edit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const song = getSong(editingSongId);
    if (!song) return;

    song.title = document.getElementById('edit-title').value.trim();
    song.artist = document.getElementById('edit-artist').value.trim();
    song.url = document.getElementById('edit-url').value.trim();
    if (pendingEditLogo !== null) song.logo = pendingEditLogo;
    const lyricsVal = document.getElementById('edit-lyrics').value.trim();
    if (lyricsVal) song.lyrics = lyricsVal; else delete song.lyrics;

    if (pendingEditFile) {
        if (song.filePath) {
            if (song.filePath.startsWith('idxdb:')) {
                dbDelete(song.filePath.slice(6)).catch(() => {});
            } else if (sbUser) {
                sbDeleteFile(song.filePath).catch(() => {});
            }
        } else if (song.fileId) {
            dbDelete(song.fileId).catch(() => {});
        }
        if (sbUser) {
            const blob = new Blob([pendingEditFile.data], { type: pendingEditFile.type || 'audio/mpeg' });
            const fakeFile = new File([blob], pendingEditFile.name, { type: pendingEditFile.type || 'audio/mpeg' });
            song.filePath = await sbUploadFile(sbUser.id, fakeFile);
        } else {
            const fid = (currentUser || 'anon') + '_' + uid();
            await dbPut(fid, pendingEditFile.data, pendingEditFile.name, pendingEditFile.type);
            song.filePath = 'idxdb:' + fid;
        }
        song.fileId = null;
        song.isLocal = true;
        song.url = '';
        pendingEditFile = null;
    }

    save();
    renderLibrary();
    renderPlaylists();
    closeEditModal();
});

const editDropZone = document.getElementById('edit-drop-zone');
editDropZone.addEventListener('dragover', e => {
    e.preventDefault();
    editDropZone.classList.add('drag-over');
});
editDropZone.addEventListener('dragleave', () => {
    editDropZone.classList.remove('drag-over');
});
editDropZone.addEventListener('drop', async e => {
    e.preventDefault();
    editDropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) {
        pendingEditFile = { data: await file.arrayBuffer(), name: file.name, type: file.type };
        editDropZone.querySelector('p').textContent = file.name;
    }
});

// Playlist edit modal
let editingPlaylistId = null;
let pendingEditPlLogo = null;

function openEditPlaylistModal(id) {
    const pl = getPlaylist(id);
    if (!pl) return;
    editingPlaylistId = id;
    document.getElementById('edit-playlist-name').value = pl.name;
    document.getElementById('edit-pl-logo-url').value = '';
    pendingEditPlLogo = null;
    renderEditPlLogoPreview(pl.logo || '');
    document.getElementById('edit-playlist-modal').classList.add('show');
}

function closeEditPlaylistModal() {
    document.getElementById('edit-playlist-modal').classList.remove('show');
    editingPlaylistId = null;
    pendingEditPlLogo = null;
    const dz = document.getElementById('edit-pl-logo-drop-zone');
    if (dz) dz.classList.remove('drag-over');
}

function renderEditPlLogoPreview(url) {
    const el = document.getElementById('edit-pl-logo-preview');
    if (url) {
        el.innerHTML = '<img src="' + esc(url) + '"><span style="color:var(--text-secondary);font-size:0.82rem">로고 사용중</span>';
    } else {
        el.innerHTML = '<span style="color:var(--text-secondary);font-size:0.82rem">로고 없음</span>';
    }
}

function setEditPlLogo() {
    const url = document.getElementById('edit-pl-logo-url').value.trim();
    if (!url) return;
    pendingEditPlLogo = url;
    renderEditPlLogoPreview(url);
}

function clearEditPlLogo() {
    pendingEditPlLogo = null;
    document.getElementById('edit-pl-logo-url').value = '';
    renderEditPlLogoPreview('');
}

document.getElementById('edit-pl-logo-file').addEventListener('change', function() {
    const file = this.files[0];
    if (!file || !file.type.startsWith('image/')) { alert('유효한 이미지 파일이 아닙니다.'); return; }
    const reader = new FileReader();
    reader.onload = function() {
        pendingEditPlLogo = reader.result;
        renderEditPlLogoPreview(pendingEditPlLogo);
    };
    reader.readAsDataURL(file);
    this.value = '';
});

const editPlLogoDropZone = document.getElementById('edit-pl-logo-drop-zone');
if (editPlLogoDropZone) {
    editPlLogoDropZone.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); editPlLogoDropZone.classList.add('drag-over'); });
    editPlLogoDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; editPlLogoDropZone.classList.add('drag-over'); });
    editPlLogoDropZone.addEventListener('dragleave', e => {
        e.preventDefault();
        e.stopPropagation();
        if (editPlLogoDropZone.contains(e.relatedTarget)) return;
        editPlLogoDropZone.classList.remove('drag-over');
    });
    editPlLogoDropZone.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        editPlLogoDropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file || !file.type.startsWith('image/')) { alert('유효한 이미지 파일이 아닙니다.'); return; }
        const reader = new FileReader();
        reader.onload = function() {
            pendingEditPlLogo = reader.result;
            renderEditPlLogoPreview(pendingEditPlLogo);
        };
        reader.readAsDataURL(file);
    });
}

document.getElementById('edit-playlist-form').addEventListener('submit', e => {
    e.preventDefault();
    const pl = getPlaylist(editingPlaylistId);
    if (!pl) return;
    pl.name = document.getElementById('edit-playlist-name').value.trim();
    if (!pl.name) return;
    if (pendingEditPlLogo !== null) pl.logo = pendingEditPlLogo;
    save();
    renderPlaylists();
    closeEditPlaylistModal();
});

// Playlist reorder
function moveSongInPlaylist(pid, index, dir) {
    const pl = getPlaylist(pid);
    if (!pl) return;
    const target = index + dir;
    if (target < 0 || target >= pl.songs.length) return;
    [pl.songs[index], pl.songs[target]] = [pl.songs[target], pl.songs[index]];
    if (currentPlaylistId === pid) {
        queue = getPlaylistSongs(pid);
    }
    save();
    renderPlaylists();
}

// Playlists
function deletePlaylist(id) {
    playlists = playlists.filter(p => p.id !== id);
    if (currentPlaylistId === id) {
        currentPlaylistId = null;
        queue = [];
        queueIndex = 0;
        audio.pause();
        audio.src = '';
        isPlaying = false;
        renderPlayer();
        updatePlayerUI();
    }
    save();
    renderPlaylists();
}

function toggleExpandPlaylist(id) {
    expandedPlaylistId = expandedPlaylistId === id ? null : id;
    renderPlaylists();
}

function addSongToPlaylist(pid, sid) {
    if (!sid) return;
    const pl = getPlaylist(pid);
    if (pl && !pl.songs.includes(sid)) {
        pl.songs.push(sid);
        save();
        renderPlaylists();
    }
}

function removeSongFromPlaylist(pid, index) {
    const pl = getPlaylist(pid);
    if (pl) {
        pl.songs.splice(index, 1);
        save();
        renderPlaylists();
    }
}

function renderPlaylists() {
    const list = document.getElementById('playlist-list');
    if (!list) return;
    if (playlists.length === 0) {
        list.innerHTML = '<div class="empty-state">생성된 플레이리스트가 없습니다.</div>';
        return;
    }
    list.innerHTML = playlists.map(pl => {
        const expanded = expandedPlaylistId === pl.id;
        const plSongs = getPlaylistSongs(pl.id);
        const availSongs = songs.filter(s => !pl.songs.includes(s.id));
        const addId = 'add-sel-' + pl.id;
        const quickAddId = 'quick-add-' + pl.id;
        return '<div class="card playlist-card"><div style="width:100%">' +
            '<div class="playlist-header">' +
                '<div class="info" onclick="toggleExpandPlaylist(\'' + pl.id + '\')">' +
                    (pl.logo ? '<img class="playlist-logo" src="' + esc(pl.logo) + '">' : '<div class="playlist-logo-placeholder">></div>') +
                    '<div class="text-group">' +
                        '<h4>' + esc(pl.name) + '</h4>' +
                        '<p>' + pl.songs.length + '곡</p>' +
                    '</div>' +
                '</div>' +
                '<div class="actions">' +
                    (plSongs.length > 0 ? '<button class="btn-small play-btn" onclick="playPlaylist(\'' + pl.id + '\', 0)">전체 재생</button>' : '') +
                    (availSongs.length > 0 ? '<button class="btn-small" onclick="event.stopPropagation();toggleQuickAdd(\'' + pl.id + '\')">+</button>' : '') +
                    '<button class="btn-small" onclick="event.stopPropagation();openEditPlaylistModal(\'' + pl.id + '\')">수정</button>' +
                    '<button class="btn-danger" onclick="deletePlaylist(\'' + pl.id + '\')">삭제</button>' +
                '</div>' +
            '</div>' +
            '<div id="' + quickAddId + '" class="quick-add" style="display:none">' +
                '<select onchange="quickAddSong(\'' + pl.id + '\', this.value, this)">' +
                    '<option value="">-- 노래 선택 --</option>' +
                    availSongs.map(s => '<option value="' + s.id + '">' + esc(s.title) + ' - ' + esc(s.artist) + '</option>').join('') +
                '</select>' +
            '</div>' +
            (expanded ? '<div class="playlist-body">' +
                '<ul class="playlist-songs">' +
                    (plSongs.length === 0 ? '<li style="color:var(--text-secondary);justify-content:center;border:none;padding:12px 0">곡이 없습니다</li>' :
                    plSongs.map((s, i) =>
                        '<li>' +
                            (s.logo ? '<img class="song-logo" src="' + esc(s.logo) + '">' : '<div class="song-logo-placeholder">></div>') +
                            '<div class="song-info"><span>' + esc(s.title) + '</span><span style="color:var(--text-secondary);font-size:0.82rem"> - ' + esc(s.artist) + '</span></div>' +
                            '<div class="actions">' +
                                '<button class="reorder-btn" onclick="moveSongInPlaylist(\'' + pl.id + '\', ' + i + ', -1)"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
                                '<button class="reorder-btn" onclick="moveSongInPlaylist(\'' + pl.id + '\', ' + i + ', 1)"' + (i === plSongs.length - 1 ? ' disabled' : '') + '>▼</button>' +
                                '<button class="btn-small" onclick="playPlaylist(\'' + pl.id + '\', ' + i + ')">재생</button>' +
                                '<button class="btn-small btn-danger" onclick="removeSongFromPlaylist(\'' + pl.id + '\', ' + i + ')" title="제거">✕</button>' +
                            '</div>' +
                        '</li>'
                    ).join('')) +
                '</ul>' +
                (availSongs.length > 0 ?
                    '<div class="playlist-add">' +
                        '<select id="' + addId + '">' +
                            '<option value="">-- 노래 선택 --</option>' +
                            availSongs.map(s => '<option value="' + s.id + '">' + esc(s.title) + ' - ' + esc(s.artist) + '</option>').join('') +
                        '</select>' +
                        '<button class="btn-primary" onclick="addSongFromSelect(\'' + pl.id + '\')">추가</button>' +
                    '</div>' :
                    '<p style="color:var(--text-secondary);margin-top:10px;font-size:0.85rem">추가할 곡이 없습니다</p>') +
            '</div>' : '') +
        '</div></div>';
    }).join('');
}

function toggleQuickAdd(id) {
    const el = document.getElementById('quick-add-' + id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function quickAddSong(pid, sid, sel) {
    if (!sid) return;
    addSongToPlaylist(pid, sid);
    sel.value = '';
    document.getElementById('quick-add-' + pid).style.display = 'none';
}

function addSongFromSelect(pid) {
    const sel = document.getElementById('add-sel-' + pid);
    if (sel && sel.value) {
        addSongToPlaylist(pid, sel.value);
        sel.value = '';
    }
}

// Community
async function renderCommunity() {
    const sel = document.getElementById('share-playlist-sel');
    if (sel) {
        sel.innerHTML = '<option value="">-- 플레이리스트 선택 --</option>' +
            playlists.map(p => '<option value="' + p.id + '">' + esc(p.name) + ' (' + p.songs.length + '곡)</option>').join('');
    }
    // Always try to load from Supabase (cross-device)
    let serverData = [];
    if (_supabase) {
        try {
            serverData = await sbLoadShared();
        } catch (e) {
            console.warn('Failed to load shared playlists from server', e);
        }
    }
    // Merge: server data overwrites local, local-only entries preserved
    const map = new Map();
    (sharedPlaylists || []).forEach(p => { if (p) map.set(p.id, p); });
    serverData.forEach(p => { if (p) map.set(p.id, p); });
    sharedPlaylists = Array.from(map.values());
    saveShared();
    renderSharedPlaylists();
}

function getGenreLabel(v) { return GENRE_LABELS[v] || v; }
function getDurationLabel(v) { return DURATION_LABELS[v] || v; }

function renderSharedPlaylists() {
    const list = document.getElementById('shared-list');
    if (!list) return;

    const filtered = sharedPlaylists.filter(sp => {
        if (sharedGenreFilter !== 'all' && sp.genre !== 'other' && sp.genre !== sharedGenreFilter) return false;
        if (sharedDurationFilter !== 'all' && sp.duration !== 'other' && sp.duration !== sharedDurationFilter) return false;
        return true;
    });

    const filterBar = document.getElementById('shared-filter-bar');
    if (filterBar) {
        const genres = [...new Set(sharedPlaylists.filter(s => s.genre !== 'other').map(s => s.genre))];
        const durations = [...new Set(sharedPlaylists.filter(s => s.duration !== 'other').map(s => s.duration))];
        filterBar.innerHTML =
            '<div class="filter-section"><span class="filter-label">장르</span>' +
            '<button class="chip' + (sharedGenreFilter === 'all' ? ' active' : '') + '" onclick="setSharedGenreFilter(\'all\')">전체</button>' +
            genres.map(g => '<button class="chip' + (sharedGenreFilter === g ? ' active' : '') + '" onclick="setSharedGenreFilter(\'' + g + '\')">' + esc(getGenreLabel(g)) + '</button>').join('') +
            '</div>' +
            '<div class="filter-section"><span class="filter-label">길이</span>' +
            '<button class="chip' + (sharedDurationFilter === 'all' ? ' active' : '') + '" onclick="setSharedDurationFilter(\'all\')">전체</button>' +
            durations.map(d => '<button class="chip' + (sharedDurationFilter === d ? ' active' : '') + '" onclick="setSharedDurationFilter(\'' + d + '\')">' + esc(getDurationLabel(d)) + '</button>').join('') +
            '</div>';
    }

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">' + (sharedPlaylists.length === 0 ? '아직 공유된 플레이리스트가 없습니다.<br>먼저 직접 공유하거나 JSON 파일을 가져오세요.' : '조건에 맞는 플레이리스트가 없습니다.') + '</div>';
        return;
    }

    list.innerHTML = filtered.map(sp => {
        const genreLabel = sp.genre === 'other' ? (sp.genreCustom || '기타') : getGenreLabel(sp.genre);
        const durLabel = sp.duration === 'other' ? (sp.durationCustom || '기타') : getDurationLabel(sp.duration);
        const liked = currentUser && sp.likedBy && sp.likedBy.includes(currentUser);
        const disliked = currentUser && sp.dislikedBy && sp.dislikedBy.includes(currentUser);
        const commId = 'comm-' + sp.id;
        return '<div class="shared-card">' +
            '<div class="shared-card-header">' +
                (sp.logo ? '<img class="playlist-logo" src="' + esc(sp.logo) + '">' : '<div class="playlist-logo-placeholder">></div>') +
                '<div class="info">' +
                    '<h4>' + esc(sp.title) + '</h4>' +
                    '<span class="author" onclick="showProfile(\'' + esc(encodeURIComponent(sp.sharedBy || sp.author)) + '\')">' + esc(sp.author) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="shared-card-badges">' +
                '<span class="badge">' + esc(genreLabel) + '</span>' +
                '<span class="badge badge-duration">' + esc(durLabel) + '</span>' +
            '</div>' +
            '<div class="shared-card-meta">' +
                '<span class="song-count">' + sp.songs.length + '곡</span>' +
                '<div class="shared-card-rating">' +
                    '<button class="rate-btn' + (liked ? ' active' : '') + '" onclick="likeSharedPlaylist(\'' + sp.id + '\')" title="좋아요">👍 <span id="like-cnt-' + sp.id + '">' + (sp.likes || 0) + '</span></button>' +
                    '<button class="rate-btn' + (disliked ? ' active' : '') + '" onclick="dislikeSharedPlaylist(\'' + sp.id + '\')" title="싫어요">👎 <span id="dislike-cnt-' + sp.id + '">' + (sp.dislikes || 0) + '</span></button>' +
                '</div>' +
                '<div class="shared-card-actions">' +
                    '<button class="btn-small" onclick="applySharedPlaylist(\'' + sp.id + '\')">내 라이브러리에 추가</button>' +
                    '<button class="btn-small" onclick="document.getElementById(\'' + commId + '\').classList.toggle(\'visible\')">댓글 ' + ((sp.comments && sp.comments.length) || 0) + '</button>' +
                    '<button class="btn-small" onclick="downloadSharedPlaylist(\'' + sp.id + '\')">다운로드</button>' +
                    '<button class="btn-small btn-danger" onclick="deleteSharedPlaylist(\'' + sp.id + '\')">삭제</button>' +
                '</div>' +
            '</div>' +
            '<div id="' + commId + '" class="shared-comments">' +
                '<div class="comments-list">' +
                    (sp.comments && sp.comments.length
                        ? sp.comments.map(c => '<div class="comment"><b>' + esc(c.author) + '</b> <span>' + esc(c.text) + '</span></div>').join('')
                        : '<p class="no-comments">아직 댓글이 없습니다.</p>') +
                '</div>' +
                '<div class="comment-input-row">' +
                    '<input type="text" class="comment-input" id="' + commId + '-input" placeholder="댓글 작성...">' +
                    '<button class="btn-small" onclick="addComment(\'' + sp.id + '\')">작성</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

function setSharedGenreFilter(g) {
    sharedGenreFilter = g;
    renderSharedPlaylists();
}

function setSharedDurationFilter(d) {
    sharedDurationFilter = d;
    renderSharedPlaylists();
}

// Share form handler
(function() {
    const form = document.getElementById('share-form');
    if (!form) return;
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const plId = document.getElementById('share-playlist-sel').value;
        const pl = playlists.find(p => p.id === plId);
        if (!pl) { alert('플레이리스트를 선택하세요'); return; }
        const songsList = getPlaylistSongs(plId);
        if (songsList.length === 0) { alert('플레이리스트에 곡이 없습니다.'); return; }

        const genre = document.getElementById('share-genre').value;
        const genreCustom = genre === 'other' ? document.getElementById('share-genre-custom').value.trim() : '';
        if (genre === 'other' && !genreCustom) { alert('장르를 직접 입력하세요'); return; }

        const duration = document.getElementById('share-duration').value;
        const durationCustom = duration === 'other' ? document.getElementById('share-duration-custom').value.trim() : '';
        if (duration === 'other' && !durationCustom) { alert('길이를 직접 입력하세요'); return; }

        // Build song data — store file data in IndexedDB, keep only ref in shared playlist
        const songData = [];
        for (const s of songsList) {
            const entry = { title: s.title, artist: s.artist, url: s.url };
            if (s.logo) entry.logo = s.logo;
            if (s.lyrics) entry.lyrics = s.lyrics;
            if (s.isLocal) {
                if (s.filePath && !s.filePath.startsWith('idxdb:')) {
                    entry.filePath = s.filePath;
                } else if (s.fileId || (s.filePath && s.filePath.startsWith('idxdb:'))) {
                    try {
                        const fid = s.fileId || s.filePath.slice(6);
                        const stored = await dbGet(fid);
                        if (stored && stored.data) {
                            const refId = 'shared_' + uid();
                            await dbPut(refId, stored.data, stored.name, stored.type);
                            entry.fileRef = refId;
                        }
                    } catch (_) {}
                }
            }
            songData.push(entry);
        }

        const shared = {
            id: uid(),
            title: pl.name,
            author: document.getElementById('share-author').value.trim(),
            sharedBy: currentUser,
            genre, genreCustom,
            duration, durationCustom,
            songs: songData,
            createdAt: Date.now(),
            likes: 0, dislikes: 0,
            likedBy: [], dislikedBy: [],
            comments: []
        };
        if (pl.logo) shared.logo = pl.logo;
        sharedPlaylists.unshift(shared);
        let sbOk = false;
        try { await sbAddShared(shared); sbOk = true; } catch (e) { console.warn('Failed to share to server', e); }
        await saveShared();
        renderSharedPlaylists();
        form.reset();
        document.getElementById('share-genre-custom').style.display = 'none';
        document.getElementById('share-duration-custom').style.display = 'none';
        const fileCount = songData.filter(s => s.fileData || s.fileRef).length;
        const sbMsg = sbOk ? '' : ' (서버 저장 실패 — 같은 브라우저에서만 보입니다)';
        alert('플레이리스트가 공유되었습니다 (' + fileCount + '개 파일 포함)' + sbMsg);
    });

    // Toggle custom inputs
    document.getElementById('share-genre').addEventListener('change', function() {
        document.getElementById('share-genre-custom').style.display = this.value === 'other' ? 'block' : 'none';
    });
    document.getElementById('share-duration').addEventListener('change', function() {
        document.getElementById('share-duration-custom').style.display = this.value === 'other' ? 'block' : 'none';
    });
})();

async function downloadSharedPlaylist(id) {
    const sp = sharedPlaylists.find(p => p.id === id);
    if (!sp) return;
    // Reconstruct file data from IndexedDB if stored as fileRef
    const copy = JSON.parse(JSON.stringify(sp));
    for (const song of copy.songs) {
        if (song.fileRef) {
            try {
                const stored = await dbGet(song.fileRef.id);
                if (stored && stored.data) {
                    song.fileData = {
                        base64: arrayBufferToBase64(stored.data),
                        name: song.fileRef.name,
                        type: song.fileRef.type
                    };
                    delete song.fileRef;
                }
            } catch (_) {}
        }
    }
    const data = JSON.stringify(copy, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sp.title.replace(/[^a-zA-Z0-9가-힣]/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(url);
}

async function importSharedPlaylist() {
    const input = document.getElementById('import-file');
    const file = input.files[0];
    if (!file) { alert('JSON 파일을 선택하세요'); return; }
    try {
        const text = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = e => resolve(e.target.result);
            r.onerror = e => reject(e.target.error);
            r.readAsText(file);
        });
        const data = JSON.parse(text);
        if (!data.title || !data.author || !Array.isArray(data.songs)) {
            throw new Error('올바른 플레이리스트 형식이 아닙니다.');
        }
        data.id = uid();
        data.createdAt = Date.now();
        if (!data.genre) data.genre = 'other';
        if (!data.duration) data.duration = 'other';
        if (!data.likes) { data.likes = 0; data.dislikes = 0; data.likedBy = []; data.dislikedBy = []; }
        if (!data.comments) data.comments = [];
        if (!data.sharedBy) data.sharedBy = currentUser || '';
        sharedPlaylists.unshift(data);
        try { await sbAddShared(data); } catch (e) { console.warn('Failed to sync import to server', e); }
        await saveShared();
        renderSharedPlaylists();
        input.value = '';
        const fileCount = data.songs.filter(s => s.fileData).length;
        alert('플레이리스트가 가져와졌습니다' + (fileCount ? ' (' + fileCount + '개 파일 포함)' : ''));
    } catch (err) {
        alert('파일을 읽을 수 없습니다: ' + err.message);
    }
}

async function deleteSharedPlaylist(id) {
    const sp = sharedPlaylists.find(p => p.id === id);
    if (!sp) return;
    if (sp.sharedBy && sp.sharedBy !== currentUser) {
        alert('다른 사람의 공유 플레이리스트는 삭제할 수 없습니다.');
        return;
    }
    if (!confirm('이 공유 플레이리스트를 삭제하시겠습니까?')) return;
    sharedPlaylists = sharedPlaylists.filter(p => p.id !== id);
    try { await sbDeleteShared(id); } catch (e) { console.warn('Failed to delete from server', e); }
    await saveShared();
    renderSharedPlaylists();
}

function likeSharedPlaylist(id) {
    const sp = sharedPlaylists.find(p => p.id === id);
    if (!sp) return;
    if (!currentUser) { alert('로그인된 사용자가 없습니다.'); return; }
    if (sp.dislikedBy && sp.dislikedBy.includes(currentUser)) {
        sp.dislikes = Math.max(0, (sp.dislikes || 0) - 1);
        sp.dislikedBy = sp.dislikedBy.filter(u => u !== currentUser);
    }
    if (sp.likedBy && sp.likedBy.includes(currentUser)) {
        sp.likes = Math.max(0, (sp.likes || 0) - 1);
        sp.likedBy = sp.likedBy.filter(u => u !== currentUser);
    } else {
        sp.likes = (sp.likes || 0) + 1;
        if (!sp.likedBy) sp.likedBy = [];
        sp.likedBy.push(currentUser);
    }
    saveShared();
    sbUpdateShared(id, { likes: sp.likes, dislikes: sp.dislikes, liked_by: sp.likedBy, disliked_by: sp.dislikedBy }).catch(e => console.warn(e));
    renderSharedPlaylists();
}

function dislikeSharedPlaylist(id) {
    const sp = sharedPlaylists.find(p => p.id === id);
    if (!sp) return;
    if (!currentUser) { alert('로그인된 사용자가 없습니다.'); return; }
    if (sp.likedBy && sp.likedBy.includes(currentUser)) {
        sp.likes = Math.max(0, (sp.likes || 0) - 1);
        sp.likedBy = sp.likedBy.filter(u => u !== currentUser);
    }
    if (sp.dislikedBy && sp.dislikedBy.includes(currentUser)) {
        sp.dislikes = Math.max(0, (sp.dislikes || 0) - 1);
        sp.dislikedBy = sp.dislikedBy.filter(u => u !== currentUser);
    } else {
        sp.dislikes = (sp.dislikes || 0) + 1;
        if (!sp.dislikedBy) sp.dislikedBy = [];
        sp.dislikedBy.push(currentUser);
    }
    saveShared();
    sbUpdateShared(id, { likes: sp.likes, dislikes: sp.dislikes, liked_by: sp.likedBy, disliked_by: sp.dislikedBy }).catch(e => console.warn(e));
    renderSharedPlaylists();
}

function addComment(id) {
    const sp = sharedPlaylists.find(p => p.id === id);
    if (!sp) return;
    if (!currentUser) { alert('로그인된 사용자가 없습니다.'); return; }
    const input = document.getElementById('comm-' + id + '-input');
    const text = input.value.trim();
    if (!text) return;
    if (!sp.comments) sp.comments = [];
    sp.comments.push({ author: currentUser, text: text, createdAt: Date.now() });
    input.value = '';
    saveShared();
    sbUpdateShared(id, { comments: sp.comments }).catch(e => console.warn(e));
    renderSharedPlaylists();
}

// Profile
let profileViewUser = null;

const defaultProfile = { display_name: '', bio: '', avatar_url: '', banner_url: '', hearts: 0, hearted_by: [] };

function getLocalProfiles() {
    try { return JSON.parse(localStorage.getItem('pl_profiles')) || {}; } catch (_) { return {}; }
}
function saveLocalProfile(username, data) {
    const all = getLocalProfiles();
    all[username] = { ...all[username], ...data };
    localStorage.setItem('pl_profiles', JSON.stringify(all));
}

async function loadProfile(username) {
    let data = null;
    try { data = await sbLoadProfile(username); } catch (_) {}
    // Always merge with local profile (local takes priority)
    const local = getLocalProfiles();
    if (local[username]) {
        data = { ...defaultProfile, ...(data || {}), ...local[username], username };
    }
    return data || { ...defaultProfile, username };
}

async function getMappedProfile(username) {
    const p = await loadProfile(username);
    return {
        displayName: p.display_name || username,
        bio: p.bio || '',
        banner: p.banner_url || '',
        avatar: p.avatar_url || '',
        hearts: p.hearts || 0,
        heartedBy: p.hearted_by || []
    };
}

async function showProfile(username) {
    let decoded;
    try { decoded = decodeURIComponent(username); } catch (_) { decoded = username; }
    profileViewUser = decoded;
    const profile = await getMappedProfile(decoded);
    const isOwn = decoded === currentUser;

    document.getElementById('profile-banner-img').style.backgroundImage = profile.banner ? 'url(' + profile.banner + ')' : '';
    document.getElementById('profile-avatar').src = profile.avatar || '';
    document.getElementById('profile-avatar').style.display = profile.avatar ? 'block' : 'none';
    document.getElementById('profile-display-name').textContent = profile.displayName || decoded;
    document.getElementById('profile-username').textContent = '@' + decoded;
    document.getElementById('profile-bio').textContent = profile.bio || '';
    document.getElementById('profile-bio').style.display = profile.bio ? 'block' : 'none';
    document.getElementById('profile-heart-count').textContent = profile.hearts || 0;

    const heartBtn = document.getElementById('profile-heart-btn');
    if (isOwn) {
        heartBtn.style.display = 'none';
    } else {
        heartBtn.style.display = 'inline-flex';
        const hearted = profile.heartedBy && profile.heartedBy.includes(currentUser);
        heartBtn.classList.toggle('active', hearted);
    }

    document.getElementById('profile-edit-btn').style.display = isOwn ? 'inline-block' : 'none';
    document.getElementById('profile-edit-fields').style.display = 'none';
    document.getElementById('profile-banner-edit').style.display = isOwn ? 'flex' : 'none';
    document.getElementById('profile-avatar-edit').style.display = isOwn ? 'flex' : 'none';
    document.getElementById('profile-save-btn').style.display = 'none';
    document.getElementById('profile-cancel-btn').style.display = 'none';

    document.getElementById('profile-modal').classList.add('visible');
}

function closeProfileModal() {
    document.getElementById('profile-modal').classList.remove('visible');
    profileViewUser = null;
}

function toggleProfileEdit() {
    document.getElementById('profile-edit-fields').style.display = 'block';
    document.getElementById('profile-edit-name').value = '';
    document.getElementById('profile-edit-bio').value = '';
    getMappedProfile(profileViewUser).then(p => {
        document.getElementById('profile-edit-name').value = p.displayName || '';
        document.getElementById('profile-edit-bio').value = p.bio || '';
    });

    document.getElementById('profile-edit-btn').style.display = 'none';
    document.getElementById('profile-save-btn').style.display = 'inline-block';
    document.getElementById('profile-cancel-btn').style.display = 'inline-block';
    document.querySelector('#profile-modal .profile-actions > .btn-small:last-child').style.display = 'none';
}

async function saveProfile() {
    const dn = document.getElementById('profile-edit-name').value.trim() || profileViewUser;
    const bio = document.getElementById('profile-edit-bio').value.trim();
    // Save to Supabase if available
    if (sbUser) {
        try {
            await sbUpsertProfile({ id: sbUser.id, username: profileViewUser, display_name: dn, bio: bio });
        } catch (e) {
            console.warn('Failed to save profile to server', e);
        }
    }
    // Always save locally
    saveLocalProfile(profileViewUser, { display_name: dn, bio: bio });
    if (profileViewUser === currentUser) {
        document.getElementById('user-display').textContent = dn + '님';
    }
    closeProfileModal();
}

// Banner/avatar file handling
document.getElementById('profile-banner-file').addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    // Try Supabase upload
    if (sbUser) {
        try {
            const url = await sbUploadProfileFile(sbUser.id, 'banner', file);
            await sbUpsertProfile({ id: sbUser.id, username: profileViewUser, banner_url: url });
            document.getElementById('profile-banner-img').style.backgroundImage = 'url(' + url + ')';
            saveLocalProfile(profileViewUser, { banner_url: url });
            return;
        } catch (e) {
            console.warn('Banner upload failed, falling back to local', e);
        }
    }
    // Local fallback: read as data URL
    const reader = new FileReader();
    reader.onload = function() {
        const dataUrl = reader.result;
        document.getElementById('profile-banner-img').style.backgroundImage = 'url(' + dataUrl + ')';
        saveLocalProfile(profileViewUser, { banner_url: dataUrl });
    };
    reader.readAsDataURL(file);
});

document.getElementById('profile-avatar-file').addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    // Try Supabase upload
    if (sbUser) {
        try {
            const url = await sbUploadProfileFile(sbUser.id, 'avatar', file);
            await sbUpsertProfile({ id: sbUser.id, username: profileViewUser, avatar_url: url });
            document.getElementById('profile-avatar').src = url;
            document.getElementById('profile-avatar').style.display = 'block';
            saveLocalProfile(profileViewUser, { avatar_url: url });
            return;
        } catch (e) {
            console.warn('Avatar upload failed, falling back to local', e);
        }
    }
    // Local fallback: read as data URL
    const reader = new FileReader();
    reader.onload = function() {
        const dataUrl = reader.result;
        document.getElementById('profile-avatar').src = dataUrl;
        document.getElementById('profile-avatar').style.display = 'block';
        saveLocalProfile(profileViewUser, { avatar_url: dataUrl });
    };
    reader.readAsDataURL(file);
});

async function heartProfile() {
    if (!currentUser) { alert('로그인된 사용자가 없습니다.'); return; }
    // Try Supabase first
    let result = null;
    try { result = await sbHeartProfile(profileViewUser, currentUser); } catch (_) {}
    if (result) {
        document.getElementById('profile-heart-count').textContent = result.hearts;
        document.getElementById('profile-heart-btn').classList.toggle('active');
        saveLocalProfile(profileViewUser, { hearts: result.hearts, hearted_by: result.hearted_by || [] });
        return;
    }
    // Local fallback
    const local = getLocalProfiles();
    const p = local[profileViewUser] || {};
    let hearts = p.hearts || 0;
    let heartedBy = p.hearted_by || [];
    if (heartedBy.includes(currentUser)) {
        hearts = Math.max(0, hearts - 1);
        heartedBy = heartedBy.filter(u => u !== currentUser);
    } else {
        hearts++;
        heartedBy.push(currentUser);
    }
    saveLocalProfile(profileViewUser, { hearts, hearted_by: heartedBy });
    document.getElementById('profile-heart-count').textContent = hearts;
    document.getElementById('profile-heart-btn').classList.toggle('active');
}

async function applySharedPlaylist(id) {
    const sp = sharedPlaylists.find(p => p.id === id);
    if (!sp) return;

    const added = [];
    for (const ss of sp.songs) {
        const existing = songs.find(s => s.title === ss.title && s.artist === ss.artist);
        if (!existing) {
            const newSong = { id: uid(), title: ss.title, artist: ss.artist, url: ss.url, fileId: null, filePath: '', isLocal: false };
            if (ss.logo) newSong.logo = ss.logo;
            if (ss.lyrics) newSong.lyrics = ss.lyrics;
            if (ss.filePath && !ss.filePath.startsWith('idxdb:')) {
                newSong.filePath = ss.filePath;
                newSong.isLocal = true;
                newSong.url = '';
            }
            const fileSrc = ss.fileData || ss.fileRef;
            if (fileSrc) {
                try {
                    let buf, fname, ftype;
                    if (fileSrc.base64) {
                        buf = base64ToArrayBuffer(fileSrc.base64);
                        fname = fileSrc.name;
                        ftype = fileSrc.type;
                    } else if (fileSrc.id) {
                        const stored = await dbGet(fileSrc.id);
                        if (stored && stored.data) { buf = stored.data; fname = stored.name; ftype = stored.type; }
                    } else if (typeof fileSrc === 'string') {
                        const stored = await dbGet(fileSrc);
                        if (stored && stored.data) { buf = stored.data; fname = stored.name; ftype = stored.type; }
                    }
                    if (buf) {
                        if (sbUser) {
                            const blob = new Blob([buf], { type: ftype || 'audio/mpeg' });
                            const fakeFile = new File([blob], fname || 'audio', { type: ftype || 'audio/mpeg' });
                            newSong.filePath = await sbUploadFile(sbUser.id, fakeFile);
                            newSong.isLocal = true;
                            newSong.url = '';
                        } else {
                            const fid = (currentUser || 'anon') + '_' + uid();
                            await dbPut(fid, buf, fname, ftype);
                            newSong.filePath = 'idxdb:' + fid;
                            newSong.isLocal = true;
                            newSong.url = '';
                        }
                    }
                } catch (_) {}
            }
            songs.push(newSong);
            added.push(newSong);
        } else {
            added.push(existing);
        }
    }

    if (added.length === 0) { alert('모든 곡이 이미 라이브러리에 있습니다.'); return; }

    const pl = { id: uid(), name: sp.title + ' (공유)', songs: added.map(s => s.id) };
    playlists.push(pl);
    save();
    renderLibrary();
    renderPlaylists();
    alert('플레이리스트 "' + pl.name + '"가 라이브러리에 추가되었습니다 (' + added.length + '곡)');
}

// Player
function playPlaylist(pid, index) {
    const songsList = getPlaylistSongs(pid);
    if (songsList.length === 0) return;
    queue = songsList;
    queueIndex = index;
    currentPlaylistId = pid;
    switchToPlayer();
    loadSong(index);
}

function playLibrarySong(sid) {
    const song = getSong(sid);
    if (!song) return;
    queue = [song];
    queueIndex = 0;
    currentPlaylistId = null;
    switchToPlayer();
    loadSong(0);
}

function moveVideoTo(target) {
    if (!target.contains(audio)) {
        target.appendChild(audio);
    }
}

function showVideoDisplay() {
    const vc = document.getElementById('video-container');
    const bar = document.getElementById('mini-video-bar');
    bar.classList.remove('show');
    vc.classList.add('show');
    moveVideoTo(vc);
    audio.controls = true;
}

function hideVideoDisplay() {
    document.getElementById('video-container').classList.remove('show');
}

function showMiniPlayer() {
    const vc = document.getElementById('video-container');
    vc.classList.remove('show');
    const bar = document.getElementById('mini-video-bar');
    bar.classList.add('show');
    moveVideoTo(document.getElementById('mini-thumb'));
    audio.controls = false;
    const song = queue[queueIndex];
    if (song) {
        document.getElementById('mini-title').textContent = song.title;
        document.getElementById('mini-artist').textContent = song.artist;
    }
}

function hideMiniPlayer() {
    document.getElementById('mini-video-bar').classList.remove('show');
}

function closeMiniPlayer() {
    audio.pause();
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    stopYtTimer();
    isPlaying = false;
    isVideo = false;
    stopVisualizer();
    hideMiniPlayer();
    hideVideoDisplay();
    moveVideoTo(document.getElementById('video-storage'));
    updatePlayerUI();
}

function switchToPlayer() {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="player"]').classList.add('active');
    document.getElementById('player').classList.add('active');
    if (isVideo) showVideoDisplay();
    const song = queue[queueIndex];
    if (song && getYouTubeId(song.url)) startYtTimer();
}

async function loadSong(index) {
    if (index < 0 || index >= queue.length) return;
    queueIndex = index;
    const song = queue[index];
    if (!song) return;

    stopYtTimer();
    hideVideoDisplay();
    hideMiniPlayer();
    stopVisualizer();
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }
    audio.pause();
    audio.src = '';
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();

    ytPendingId = null;
    try {
        const ytId = getYouTubeId(song.url);
        if (ytId) {
            loadYouTubeAPI();
            ytPendingId = ytId;
            isVideo = false;
            if (ytReady && ytPlayer && ytPlayer.loadVideoById) {
                ytPendingId = null;
                ytPlayer.loadVideoById(ytId);
                isPlaying = true;
            } else {
                let tries = 0;
                const iv = setInterval(() => {
                    tries++;
                    if (ytReady && ytPlayer && ytPlayer.loadVideoById && ytPendingId) {
                        clearInterval(iv);
                        ytPlayer.loadVideoById(ytPendingId);
                        ytPendingId = null;
                        isPlaying = true;
                        updatePlayerUI();
                    } else if (tries > 50) {
                        clearInterval(iv);
                    }
                }, 200);
            }
            updatePlayerUI();
            renderPlayer();
            return;
        }

        // Init AudioContext within user gesture before playing
        initVisualizer();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

        if (song.isLocal && song.filePath) {
            if (song.filePath.startsWith('idxdb:')) {
                const fileData = await dbGet(song.filePath.slice(6));
                if (fileData) {
                    const blob = new Blob([fileData.data], { type: fileData.type || 'audio/mpeg' });
                    currentBlobUrl = URL.createObjectURL(blob);
                    audio.src = currentBlobUrl;
                } else {
                    throw new Error('파일을 찾을 수 없습니다');
                }
            } else {
                try {
                    const url = await sbGetFileUrl(song.filePath);
                    audio.src = url;
                } catch (e) {
                    console.warn('Failed to load Supabase file', e);
                    throw new Error('파일을 불러올 수 없습니다');
                }
            }
        } else if (song.fileId) {
            // Legacy: fileId-based
            const fileData = await dbGet(song.fileId);
            if (fileData) {
                const blob = new Blob([fileData.data], { type: fileData.type || 'audio/mpeg' });
                currentBlobUrl = URL.createObjectURL(blob);
                audio.src = currentBlobUrl;
            } else {
                throw new Error('파일을 찾을 수 없습니다');
            }
        } else {
            audio.src = song.url;
        }
        audio.load();
        await audio.play();
        isPlaying = true;
        if (!isVideo) startVisualizer();
    } catch (e) {
        isPlaying = false;
        console.error('Playback error:', e);
    }
    updatePlayerUI();
    renderPlayer();
}

function togglePlay() {
    if (queue.length === 0) {
        if (songs.length > 0) playLibrarySong(songs[0].id);
        return;
    }
    const song = queue[queueIndex];
    if (song && getYouTubeId(song.url)) {
        if (!ytPlayer || !ytPlayer.getPlayerState) return;
        if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
            ytPlayer.pauseVideo();
        } else {
            ytPlayer.playVideo();
        }
        return;
    }
    if (audio.paused) {
        initVisualizer();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        audio.play().then(() => {
            isPlaying = true;
            updatePlayerUI();
            if (!isVideo) startVisualizer();
        }).catch(e => {
            console.error('Toggle play error:', e);
        });
    } else {
        audio.pause();
        isPlaying = false;
        stopVisualizer();
        updatePlayerUI();
    }
}

function nextSong() {
    if (queue.length === 0) return;
    const next = queueIndex + 1;
    if (next < queue.length) loadSong(next);
}

function prevSong() {
    if (queue.length === 0) return;
    const song = queue[queueIndex];
    if (song && getYouTubeId(song.url)) {
        if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getCurrentTime() > 3) {
            ytPlayer.seekTo(0);
            return;
        }
    } else if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    const prev = queueIndex - 1;
    if (prev >= 0) loadSong(prev);
}

function updateProgress() {
    if (audio.duration) {
        const pct = (audio.currentTime / audio.duration) * 100;
        document.getElementById('progress-bar').value = pct;
        document.getElementById('current-time').textContent = formatTime(audio.currentTime);
        document.getElementById('total-time').textContent = formatTime(audio.duration);
    }
}

function updatePlayerUI() {
    const song = queue.length > 0 ? queue[queueIndex] : null;
    const pl = currentPlaylistId ? getPlaylist(currentPlaylistId) : null;

    // Song logo
    const logoEl = document.getElementById('now-playing-logo');
    if (song && song.logo) {
        logoEl.src = song.logo;
        logoEl.style.display = 'block';
    } else {
        logoEl.style.display = 'none';
    }

    // Playlist logo
    const plLogoEl = document.getElementById('now-playing-pl-logo');
    if (pl && pl.logo) {
        plLogoEl.src = pl.logo;
        plLogoEl.style.display = 'block';
    } else {
        plLogoEl.style.display = 'none';
    }

    document.getElementById('current-title').textContent = song ? song.title : '선택된 노래 없음';
    document.getElementById('current-artist').textContent = song ? song.artist : '';
    document.getElementById('current-playlist-name').textContent = pl ? pl.name : '';

    const nextEl = document.getElementById('next-up');
    if (queue.length > 1 && queueIndex < queue.length - 1) {
        const next = queue[queueIndex + 1];
        nextEl.innerHTML = '다음 곡 <b>' + esc(next.title) + '</b> - ' + esc(next.artist);
    } else {
        nextEl.textContent = '';
    }

    // Lyrics
    const lyricsContainer = document.getElementById('lyrics-container');
    const lyricsText = document.getElementById('lyrics-text');
    if (song && song.lyrics) {
        lyricsText.textContent = song.lyrics;
        lyricsContainer.style.display = '';
    } else {
        lyricsContainer.style.display = 'none';
    }

    document.getElementById('play-btn').textContent = isPlaying ? '일시 정지' : '재생';

    if (song && audio.duration) {
        document.getElementById('total-time').textContent = formatTime(audio.duration);
    }
}

function renderPlayer() {
    const hasContent = queue.length > 0;
    document.getElementById('player-view').classList.toggle('active', hasContent);
    document.getElementById('no-playlist-selected').classList.toggle('hidden', hasContent);

    const list = document.getElementById('queue-list');
    if (queue.length === 0) {
        list.innerHTML = '';
        document.getElementById('queue-count').textContent = '';
        return;
    }

    document.getElementById('queue-count').textContent = '(' + queue.length + '곡)';
    list.innerHTML = queue.map((s, i) =>
        '<li class="' + (i === queueIndex ? 'active' : '') + '" onclick="jumpTo(' + i + ')">' +
            (s.logo ? '<img class="queue-logo" src="' + esc(s.logo) + '">' : '<div class="queue-logo-placeholder">></div>') +
            '<div class="song-info">' +
                '<div class="title">' + esc(s.title) + '</div>' +
                '<div class="artist">' + esc(s.artist) + '</div>' +
            '</div>' +
            '<span class="duration">' + (i === queueIndex && audio.duration ? formatTime(audio.duration) : '') + '</span>' +
            '<button class="btn-small btn-danger" onclick="event.stopPropagation();removeFromQueue(' + i + ')" style="margin-left:4px">✕</button>' +
        '</li>'
    ).join('');

    // Populate queue add selector
    const sel = document.getElementById('queue-add-select');
    if (sel) {
        const ids = new Set(queue.map(s => s.id));
        sel.innerHTML = '<option value="">-- 노래 선택 --</option>' +
            songs.filter(s => !ids.has(s.id)).map(s => '<option value="' + s.id + '">' + esc(s.title) + ' - ' + esc(s.artist) + '</option>').join('');
    }

    updatePlayerUI();
}

function showQueueAddPicker() {
    const el = document.getElementById('queue-add-picker');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function addSelectedToQueue(sel) {
    if (!sel.value) return;
    const song = getSong(sel.value);
    if (song) {
        queue.push(song);
        if (queue.length === 1) {
            queueIndex = 0;
            loadSong(0);
        }
        save();
        renderPlayer();
    }
    sel.value = '';
    document.getElementById('queue-add-picker').style.display = 'none';
}

function removeFromQueue(index) {
    if (index < 0 || index >= queue.length) return;
    const removedId = queue[index].id;
    queue.splice(index, 1);
    // Also remove from the associated playlist if it exists
    if (currentPlaylistId) {
        const pl = getPlaylist(currentPlaylistId);
        if (pl) {
            const pi = pl.songs.indexOf(removedId);
            if (pi !== -1) pl.songs.splice(pi, 1);
            save();
            renderPlaylists();
        }
    }
    if (queue.length === 0) {
        audio.pause();
        audio.src = '';
        isPlaying = false;
        queueIndex = 0;
        currentPlaylistId = null;
    } else if (index <= queueIndex) {
        queueIndex = Math.max(0, queueIndex - 1);
        if (index === queueIndex && isPlaying) loadSong(queueIndex);
    }
    renderPlayer();
    updatePlayerUI();
}

function removeCurrentFromQueue() {
    if (queue.length === 0) return;
    removeFromQueue(queueIndex);
}

function jumpTo(index) {
    if (index >= 0 && index < queue.length) loadSong(index);
}

document.getElementById('progress-bar').addEventListener('input', function () {
    const song = queue[queueIndex];
    if (song && getYouTubeId(song.url)) {
        if (ytPlayer && ytPlayer.seekTo && ytPlayer.getDuration()) {
            ytPlayer.seekTo((this.value / 100) * ytPlayer.getDuration());
        }
        return;
    }
    if (audio.duration) {
        audio.currentTime = (this.value / 100) * audio.duration;
    }
});

// File data helpers
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const buf = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buf;
}

// Visualizer
function initVisualizer() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const src = audioCtx.createMediaElementSource(audio);
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
        if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {
        console.warn('Visualizer not available');
    }
}

function startVisualizer() {
    const canvas = document.getElementById('visualizer');
    if (!canvas) return;
    if (vizAnimId) cancelAnimationFrame(vizAnimId);
    initVisualizer();
    if (!analyser) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const barCount = 64;
    const smooth = new Float32Array(barCount);
    canvas.classList.add('show');

    // Cache logarithmic frequency bin ranges (computed once)
    const binRanges = [];
    const logMin = Math.log(1);
    const logMax = Math.log(bufferLength);
    for (let i = 0; i < barCount; i++) {
        const start = i / barCount;
        const end = (i + 1) / barCount;
        const startBin = Math.floor(Math.exp(logMin + start * (logMax - logMin)));
        const endBin = Math.min(bufferLength, Math.ceil(Math.exp(logMin + end * (logMax - logMin))));
        binRanges.push({ start: startBin, end: endBin, count: Math.max(1, endBin - startBin) });
    }

    // Parse accent color once
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c63ff';
    const ar = parseInt(accent.slice(1,3), 16) || 108;
    const ag = parseInt(accent.slice(3,5), 16) || 99;
    const ab = parseInt(accent.slice(5,7), 16) || 255;
    const brightR = Math.min(255, ar + 60);
    const brightG = Math.min(255, ag + 60);
    const brightB = Math.min(255, ab + 60);

    const barW = w / barCount;
    const gap = barW * 0.15;
    const halfGap = gap / 2;
    const centerY = h / 2;

    function draw() {
        vizAnimId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);
        ctx.clearRect(0, 0, w, h);

        // Set shadow once for all bars
        ctx.shadowColor = `rgba(${ar},${ag},${ab},0.3)`;
        ctx.shadowBlur = 6;

        for (let i = 0; i < barCount; i++) {
            const range = binRanges[i];
            let sum = 0;
            for (let j = range.start; j < range.end && j < bufferLength; j++) {
                sum += dataArray[j] || 0;
            }
            const raw = sum / range.count / 255;
            smooth[i] += (raw - smooth[i]) * 0.3;
            const v = smooth[i];
            const barH = Math.max(v * h * 0.9, 2);
            const halfH = barH * 0.5;

            const x = i * barW + halfGap;
            const bw = barW - gap;
            const top = centerY - halfH;

            const alpha = 0.35 + v * 0.65;

            // Single color fill (avoids per-bar gradient creation)
            const r = Math.round(brightR * alpha + ar * (1 - alpha));
            const g = Math.round(brightG * alpha + ag * (1 - alpha));
            const b = Math.round(brightB * alpha + ab * (1 - alpha));
            ctx.fillStyle = `rgb(${r},${g},${b})`;

            ctx.fillRect(x, top, bw, barH);
        }
        ctx.shadowBlur = 0;
    }
    draw();
}

function stopVisualizer() {
    if (vizAnimId) cancelAnimationFrame(vizAnimId);
    vizAnimId = null;
    document.getElementById('visualizer')?.classList.remove('show');
}

window.addEventListener('resize', () => {
    const canvas = document.getElementById('visualizer');
    if (canvas && canvas.classList.contains('show')) startVisualizer();
});

async function showApp() {
    document.getElementById('login-overlay').style.display = 'none';
    document.querySelector('.app').style.display = 'block';
    document.getElementById('user-info').style.display = 'flex';
    let displayName = currentUser;
    try {
        const profile = currentUser ? await getMappedProfile(currentUser) : null;
        if (profile) displayName = profile.displayName || currentUser;
    } catch (_) {}
    document.getElementById('user-display').textContent = displayName + '님';
    loadYouTubeAPI();
    applyUI();
    renderLibrary();
    renderPlaylists();
    renderPlayer();
    await renderCommunity();
    updatePlayerUI();
}

function showLogin() {
    document.getElementById('login-overlay').style.display = 'flex';
    document.querySelector('.app').style.display = 'none';
    document.getElementById('user-info').style.display = 'none';
    currentUser = null;
    localStorage.removeItem('pl_session');
}

// Auth functions
async function registerUser(username, password) {
    document.getElementById('login-error').textContent = '';
    if (username.length < 2) { document.getElementById('login-error').textContent = '사용자 이름은 2자 이상이어야 합니다'; return false; }
    if (password.length < 4) { document.getElementById('login-error').textContent = '비밀번호는 4자 이상이어야 합니다'; return false; }

    // Try Supabase first (cross-device)
    if (sbConfigured && _supabase) {
        try {
            const data = await sbRegister(username, password);
            if (data && data.user) {
                document.getElementById('login-error').textContent = '회원가입 성공! 로그인해 주세요';
                document.getElementById('login-error').style.color = 'var(--accent)';
                return true;
            }
        } catch (e) {
            console.warn('Supabase register failed, fallback to local', e);
        }
    }

    // Fallback: save to localStorage (device-only)
    const users = JSON.parse(localStorage.getItem('pl_users')) || [];
    if (users.some(u => u.username === username)) {
        document.getElementById('login-error').textContent = '이미 존재하는 사용자입니다.';
        return false;
    }
    users.push({ username, password });
    localStorage.setItem('pl_users', JSON.stringify(users));
    document.getElementById('login-error').textContent = '회원가입 성공! (로컬 전용, 다른 기기와 미동기) 로그인해 주세요';
    document.getElementById('login-error').style.color = 'var(--accent)';
    return true;
}

async function loginUser(username, password) {
    console.log('loginUser called', username, sbConfigured, !!_supabase);
    document.getElementById('login-error').textContent = '';

    // Try Supabase first (cross-device)
    if (sbConfigured && _supabase) {
        try {
            const data = await sbLogin(username, password);
            if (data && data.user) {
                sbUser = data.user;
                currentUser = data.user.user_metadata?.username || username;
                localStorage.setItem(userKey('pl_session'), username);
                localStorage.setItem('pl_last_user', username);
                await loadUserData();
                document.getElementById('login-error').textContent = '';
                return true;
            }
        } catch (e) {
            console.warn('Supabase login failed, trying local fallback', e);
        }
    }

    // Fallback: localStorage
    const users = JSON.parse(localStorage.getItem('pl_users')) || [];
    const match = users.find(u => u.username === username);
    if (match && match.password !== password) {
        document.getElementById('login-error').textContent = '비밀번호가 틀렸습니다.';
        return false;
    }
    const hasUserSpecificData = localStorage.getItem('pl_songs2_' + username) !== null;
    if (!match && !hasUserSpecificData) {
        document.getElementById('login-error').textContent = '존재하지 않는 사용자입니다. 회원가입해 주세요';
        return false;
    }

    // Local login
    sbUser = null;
    currentUser = username;
    localStorage.setItem(userKey('pl_session'), username);
    localStorage.setItem('pl_last_user', username);
    songs = JSON.parse(localStorage.getItem(userKey('pl_songs2'))) || [];
    playlists = JSON.parse(localStorage.getItem(userKey('pl_playlists2'))) || [];
    sharedPlaylists = migrateSharedPlaylists();
    const savedUI = JSON.parse(localStorage.getItem(userKey('pl_ui')));
    uiSettings = savedUI || { bgImages: [], bgMode: 'single', bgInterval: 10, bgIndex: 0, accent: '#6c63ff', blur: 10, dim: 50, playBtnImage: '' };
    document.getElementById('login-error').textContent = '';
    return true;
}

async function logoutUser() {
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
    audio.pause();
    audio.src = '';
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    stopYtTimer();
    isPlaying = false;
    isVideo = false;
    stopVisualizer();
    songs = [];
    playlists = [];
    queue = [];
    queueIndex = 0;
    currentPlaylistId = null;
    try { await sbLogout(); } catch (_) {}
    sbUser = null;
    localStorage.removeItem('pl_last_user');
    showLogin();
}

// Expose login/register handlers globally (used by addEventListener)
let loginInProgress = false;

async function handleLoginClick() {
    if (loginInProgress) return;
    loginInProgress = true;
    try {
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        if (!username) { document.getElementById('login-error').textContent = '사용자 이름을 입력하세요'; loginInProgress = false; return; }
        if (!password) { document.getElementById('login-error').textContent = '비밀번호를 입력하세요'; loginInProgress = false; return; }
        const ok = await loginUser(username, password);
        if (ok) await showApp();
    } catch (e) {
        console.error('handleLoginClick error:', e);
        document.getElementById('login-error').textContent = '오류: ' + e.message;
    }
    loginInProgress = false;
}

document.getElementById('login-btn').addEventListener('click', handleLoginClick);

document.getElementById('login-username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
});
document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
});

async function handleRegisterClick() {
    if (loginInProgress) return;
    loginInProgress = true;
    try {
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        if (!username) { document.getElementById('login-error').textContent = '사용자 이름을 입력하세요'; loginInProgress = false; return; }
        if (!password) { document.getElementById('login-error').textContent = '비밀번호를 입력하세요'; loginInProgress = false; return; }
        await registerUser(username, password);
    } catch (e) {
        console.error('handleRegisterClick error:', e);
        document.getElementById('login-error').textContent = '오류: ' + e.message;
    }
    loginInProgress = false;
}

document.getElementById('register-btn').addEventListener('click', handleRegisterClick);

document.getElementById('logout-btn').addEventListener('click', logoutUser);

document.getElementById('user-display').addEventListener('click', () => {
    if (currentUser) showProfile(currentUser);
});

// On page load, check session
(async function init() {
    console.log('init() running, sbConfigured:', sbConfigured, '_supabase:', !!_supabase);

    // 1. Try Supabase session first (cross-device)
    if (sbConfigured && _supabase) {
        try {
            const { data } = await sbGetSession();
            if (data && data.session) {
                sbUser = data.session.user;
                currentUser = sbUser.user_metadata?.username || sbUser.email?.replace('@pl.local', '') || 'user';
                await loadUserData();
                await showApp();
                return;
            }
        } catch (e) {
            console.warn('init(): Supabase session failed', e);
        }
    }

    // 2. Fallback: localStorage (device-only)
    try {
        const users = JSON.parse(localStorage.getItem('pl_users')) || [];
        const lastUser = localStorage.getItem('pl_last_user');
        const target = lastUser && users.some(u => u.username === lastUser) ? lastUser : users[0]?.username;
        const legacyUser = !target && localStorage.getItem('pl_songs2') !== null ? '__legacy__' : null;
        const effectiveUser = target || legacyUser;
        if (effectiveUser) {
            console.log('init(): found local user', effectiveUser);
            currentUser = effectiveUser;
            sbUser = null;
            songs = JSON.parse(localStorage.getItem(userKey('pl_songs2'))) || [];
            playlists = JSON.parse(localStorage.getItem(userKey('pl_playlists2'))) || [];
            sharedPlaylists = migrateSharedPlaylists();
            const savedUI = JSON.parse(localStorage.getItem(userKey('pl_ui')));
            if (savedUI) uiSettings = savedUI;
            await showApp();
            return;
        }
    } catch (e) {
        console.warn('init(): localStorage fallback failed', e);
    }
    console.log('init(): showing login screen');
    showLogin();
})();
