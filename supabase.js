// Supabase client – fill in your project URL and anon key from https://supabase.com
console.log('supabase.js loaded');
const SUPABASE_URL = "https://nbcyffvrzqytpyginpxe.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8RTORBNeowwULojRBTM18g_t3fHCH0O";

const sbConfigured = SUPABASE_URL && SUPABASE_URL !== 'https://YOUR_PROJECT.supabase.co' && SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== 'your-anon-key-here';

var _supabase = null;
try {
    if (sbConfigured && typeof supabase !== 'undefined' && supabase.createClient) {
        _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true }
        });
    }
} catch (e) {
    console.warn('Supabase init failed, falling back to localStorage', e);
}

async function sbTestConnection() {
    if (!_supabase) return { ok: false, reason: '_supabase is null' };
    try {
        const { error } = await _supabase.from('shared_playlists').select('id').limit(1);
        if (error) return { ok: false, reason: 'DB query: ' + error.message };
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function updateSupabaseStatus() {
    const el = document.getElementById('supabase-status');
    if (!el) return;
    if (_supabase) {
        const test = await sbTestConnection();
        if (test.ok) {
            el.textContent = 'Supabase 연결됨 (멀티 기기 동기화)';
            el.style.color = '#4ade80';
        } else {
            el.textContent = 'Supabase 연결 실패: ' + test.reason;
            el.style.color = '#f87171';
        }
    } else if (sbConfigured) {
        const why = typeof supabase === 'undefined' ? 'SDK 로딩 실패 (CDN 차단?)' : typeof supabase?.createClient !== 'function' ? 'SDK 버전 호환성 문제' : '초기화 오류';
        el.textContent = 'Supabase 미연결 (' + why + ') — 로컬 전용 모드';
        el.style.color = '#f87171';
    } else {
        el.textContent = 'Supabase 미설정 (환경 변수 필요)';
        el.style.color = '#fbbf24';
    }
}

// ─── Auth ───

async function sbRegister(username, password) {
    if (!_supabase) throw new Error('Supabase가 설정되지 않았습니다');
    const { data, error } = await _supabase.auth.signUp({
        email: username + '@pl.local',
        password,
        options: { data: { username } }
    });
    if (error) throw new Error(error.message);
    return data;
}

async function sbLogin(username, password) {
    if (!_supabase) throw new Error('Supabase가 설정되지 않았습니다');
    const { data, error } = await _supabase.auth.signInWithPassword({
        email: username + '@pl.local',
        password
    });
    if (error) throw new Error(error.message);
    return data;
}

async function sbLogout() {
    if (_supabase) await _supabase.auth.signOut();
}

function sbGetSession() {
    if (!_supabase) return Promise.resolve({ data: { session: null } });
    return _supabase.auth.getSession();
}

function sbOnAuth(callback) {
    if (!_supabase) return { data: { subscription: { unsubscribe: () => {} } } };
    return _supabase.auth.onAuthStateChange(callback);
}

function sbUserId() {
    if (!_supabase) return Promise.resolve(null);
    return _supabase.auth.getSession().then(({ data }) => data.session?.user?.id || null);
}

// ─── Songs ───

async function sbLoadSongs(userId) {
    if (!_supabase) return [];
    const { data, error } = await _supabase.from('songs').select('*').eq('user_id', userId);
    if (error) { console.warn('sbLoadSongs error:', error); return []; }
    return data || [];
}

function songToDb(s, userId) {
    return {
        id: s.id, user_id: userId,
        title: s.title, artist: s.artist, url: s.url || '',
        logo: s.logo || '', lyrics: s.lyrics || '',
        is_local: s.isLocal || false,
        file_path: s.filePath || ''
    };
}

async function sbSaveSongs(userId, songs) {
    if (!_supabase) return;
    const existing = await sbLoadSongs(userId);
    const existingIds = new Set(existing.map(s => s.id));
    const toUpsert = songs.filter(s => s.id && existingIds.has(s.id));
    const toInsert = songs.filter(s => s.id && !existingIds.has(s.id));
    const toDelete = existing.filter(e => !songs.some(s => s.id === e.id));

    const ops = [];
    if (toInsert.length > 0) {
        ops.push(_supabase.from('songs').insert(toInsert.map(s => songToDb(s, userId))));
    }
    for (const s of toUpsert) {
        ops.push(_supabase.from('songs').update(songToDb(s, userId)).eq('id', s.id).eq('user_id', userId));
    }
    for (const s of toDelete) {
        ops.push(_supabase.from('songs').delete().eq('id', s.id).eq('user_id', userId));
    }
    const results = await Promise.all(ops);
    const errors = results.filter(r => r && r.error);
    if (errors.length > 0) console.warn('sbSaveSongs errors:', errors);
}

// ─── Playlists ───

function playlistToDb(p, userId) {
    return {
        id: p.id, user_id: userId,
        name: p.name, song_ids: p.song_ids || [],
        created_at: p.createdAt ? new Date(p.createdAt).toISOString() : new Date().toISOString()
    };
}

async function sbLoadPlaylists(userId) {
    if (!_supabase) return [];
    const { data, error } = await _supabase.from('playlists').select('*').eq('user_id', userId);
    if (error) { console.warn('sbLoadPlaylists error:', error); return []; }
    return data || [];
}

async function sbSavePlaylists(userId, playlists) {
    if (!_supabase) return;
    const existing = await sbLoadPlaylists(userId);
    const existingIds = new Set(existing.map(p => p.id));
    const toUpsert = playlists.filter(p => p.id && existingIds.has(p.id));
    const toInsert = playlists.filter(p => p.id && !existingIds.has(p.id));
    const toDelete = existing.filter(e => !playlists.some(p => p.id === e.id));

    const ops = [];
    if (toInsert.length > 0) {
        ops.push(_supabase.from('playlists').insert(toInsert.map(p => playlistToDb(p, userId))));
    }
    for (const p of toUpsert) {
        ops.push(_supabase.from('playlists').update(playlistToDb(p, userId)).eq('id', p.id).eq('user_id', userId));
    }
    for (const p of toDelete) {
        ops.push(_supabase.from('playlists').delete().eq('id', p.id).eq('user_id', userId));
    }
    const results = await Promise.all(ops);
    const errors = results.filter(r => r && r.error);
    if (errors.length > 0) console.warn('sbSavePlaylists errors:', errors);
}

// ─── Shared Playlists ───

function sharedToDb(item) {
    return {
        id: item.id,
        user_id: item.user_id || null,
        title: item.title, author: item.author,
        shared_by: item.sharedBy || '',
        genre: item.genre || '', genre_custom: item.genreCustom || '',
        duration: item.duration || '', duration_custom: item.durationCustom || '',
        logo: item.logo || '',
        songs: item.songs || [],
        likes: item.likes || 0, dislikes: item.dislikes || 0,
        liked_by: item.likedBy || [], disliked_by: item.dislikedBy || [],
        comments: item.comments || [],
        created_at: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString()
    };
}

function sharedFromDb(item) {
    return {
        id: item.id,
        title: item.title, author: item.author,
        sharedBy: item.shared_by || '',
        genre: item.genre || '', genreCustom: item.genre_custom || '',
        duration: item.duration || '', durationCustom: item.duration_custom || '',
        logo: item.logo || '',
        songs: typeof item.songs === 'string' ? JSON.parse(item.songs) : (item.songs || []),
        likes: item.likes || 0, dislikes: item.dislikes || 0,
        likedBy: item.liked_by || [], dislikedBy: item.disliked_by || [],
        comments: typeof item.comments === 'string' ? JSON.parse(item.comments) : (item.comments || []),
        createdAt: item.created_at || Date.now()
    };
}

async function sbLoadShared() {
    if (!_supabase) return [];
    const { data, error } = await _supabase.from('shared_playlists').select('*').order('created_at', { ascending: false });
    if (error) { console.warn('sbLoadShared error:', error); return []; }
    if (!data || data.length === 0) { console.log('sbLoadShared: no shared playlists found'); return []; }
    return data.map(sharedFromDb);
}

async function sbAddShared(item) {
    if (!_supabase) throw new Error('Supabase가 설정되지 않았습니다');
    const userId = (await sbUserId()) || null;
    const { error } = await _supabase.from('shared_playlists').insert(sharedToDb({ ...item, user_id: userId }));
    if (error) throw new Error(error.message);
    console.log('sbAddShared: insert succeeded for', item.id, 'user_id:', userId);
}

// updates uses camelCase keys from JS; convert to snake_case for DB
function updatesToDb(updates) {
    const map = {
        likes: 'likes', dislikes: 'dislikes',
        likedBy: 'liked_by', dislikedBy: 'disliked_by',
        comments: 'comments'
    };
    const result = {};
    for (const [key, val] of Object.entries(updates)) {
        result[map[key] || key] = val;
    }
    return result;
}

async function sbUpdateShared(id, updates) {
    if (!_supabase) return;
    const { error } = await _supabase.from('shared_playlists').update(updatesToDb(updates)).eq('id', id);
    if (error) throw new Error(error.message);
}

async function sbDeleteShared(id) {
    if (!_supabase) return;
    await _supabase.from('shared_playlists').delete().eq('id', id);
}

// ─── Files (Supabase Storage) ───

async function sbUploadFile(userId, file) {
    if (!_supabase) throw new Error('Supabase가 설정되지 않았습니다');
    const path = userId + '/' + Date.now() + '_' + file.name;
    const { error } = await _supabase.storage.from('audio').upload(path, file, {
        contentType: file.type,
        upsert: false
    });
    if (error) throw new Error(error.message);
    return path;
}

async function sbGetFileUrl(path) {
    if (!_supabase) return '';
    const { data } = _supabase.storage.from('audio').getPublicUrl(path);
    return data.publicUrl;
}

async function sbDeleteFile(path) {
    if (!_supabase) return;
    await _supabase.storage.from('audio').remove([path]);
}

// ─── Profiles ───

async function sbLoadProfile(username) {
    if (!_supabase) return null;
    const { data } = await _supabase.from('profiles').select('*').eq('username', username).single();
    return data;
}

async function sbUpsertProfile(profile) {
    if (!_supabase) return;
    const { error } = await _supabase.from('profiles').upsert(profile, { onConflict: 'id' });
    if (error) throw new Error(error.message);
}

// ─── Storage helpers (for profile banner/avatar, etc.) ───

async function sbUploadProfileFile(userId, folder, file) {
    if (!_supabase) throw new Error('Supabase가 설정되지 않았습니다');
    const path = 'profile/' + userId + '/' + folder + '_' + Date.now();
    const { error } = await _supabase.storage.from('audio').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw new Error(error.message);
    const { data } = _supabase.storage.from('audio').getPublicUrl(path);
    return data.publicUrl;
}

async function sbHeartProfile(username, currentUsername) {
    if (!_supabase) return null;
    const profile = await sbLoadProfile(username);
    if (!profile) return null;
    let hearts = profile.hearts || 0;
    let heartedBy = profile.hearted_by || [];
    if (heartedBy.includes(currentUsername)) {
        hearts = Math.max(0, hearts - 1);
        heartedBy = heartedBy.filter(u => u !== currentUsername);
    } else {
        hearts = hearts + 1;
        heartedBy.push(currentUsername);
    }
    await _supabase.from('profiles').update({ hearts, hearted_by: heartedBy }).eq('username', username);
    return { hearts, hearted: heartedBy.includes(currentUsername) };
}
