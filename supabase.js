// Supabase client – fill in your project URL and anon key from https://supabase.com
const SUPABASE_URL = "https://nbcyffvrzqytpyginpxe.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8RTORBNeowwULojRBTM18g_t3fHCH0O";

var _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
});

// ─── Auth ───

async function sbRegister(username, password) {
    const { data, error } = await _supabase.auth.signUp({
        email: username + '@pl.local',
        password,
        options: { data: { username } }
    });
    if (error) throw new Error(error.message);
    return data;
}

async function sbLogin(username, password) {
    const { data, error } = await _supabase.auth.signInWithPassword({
        email: username + '@pl.local',
        password
    });
    if (error) throw new Error(error.message);
    return data;
}

async function sbLogout() {
    await _supabase.auth.signOut();
}

function sbGetSession() {
    return _supabase.auth.getSession();
}

function sbOnAuth(callback) {
    return _supabase.auth.onAuthStateChange(callback);
}

function sbUserId() {
    return _supabase.auth.getSession().then(({ data }) => data.session?.user?.id || null);
}

// ─── Songs ───

async function sbLoadSongs(userId) {
    const { data } = await _supabase.from('songs').select('*').eq('user_id', userId);
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
    await Promise.all(ops);
}

// ─── Playlists ───

async function sbLoadPlaylists(userId) {
    const { data } = await _supabase.from('playlists').select('*').eq('user_id', userId);
    return data || [];
}

function playlistToDb(p, userId) {
    return {
        id: p.id, user_id: userId,
        name: p.name,
        logo: p.logo || '',
        song_ids: p.songs || p.song_ids || []
    };
}

async function sbSavePlaylists(userId, playlists) {
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
    await Promise.all(ops);
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
        created_at: item.createdAt || Date.now()
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
    const { data } = await _supabase.from('shared_playlists').select('*').order('created_at', { ascending: false });
    return (data || []).map(sharedFromDb);
}

async function sbAddShared(item) {
    const userId = (await sbUserId()) || null;
    const { error } = await _supabase.from('shared_playlists').insert(sharedToDb({ ...item, user_id: userId }));
    if (error) throw new Error(error.message);
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
    const { error } = await _supabase.from('shared_playlists').update(updatesToDb(updates)).eq('id', id);
    if (error) throw new Error(error.message);
}

async function sbDeleteShared(id) {
    await _supabase.from('shared_playlists').delete().eq('id', id);
}

// ─── Files (Supabase Storage) ───

async function sbUploadFile(userId, file) {
    const path = userId + '/' + Date.now() + '_' + file.name;
    const { error } = await _supabase.storage.from('audio').upload(path, file, {
        contentType: file.type,
        upsert: false
    });
    if (error) throw new Error(error.message);
    return path;
}

async function sbGetFileUrl(path) {
    const { data } = _supabase.storage.from('audio').getPublicUrl(path);
    return data.publicUrl;
}

async function sbDeleteFile(path) {
    await _supabase.storage.from('audio').remove([path]);
}

// ─── Profiles ───

async function sbLoadProfile(username) {
    const { data } = await _supabase.from('profiles').select('*').eq('username', username).single();
    return data;
}

async function sbUpsertProfile(profile) {
    const { error } = await _supabase.from('profiles').upsert(profile, { onConflict: 'id' });
    if (error) throw new Error(error.message);
}

// ─── Storage helpers (for profile banner/avatar, etc.) ───

async function sbUploadProfileFile(userId, folder, file) {
    const path = 'profile/' + userId + '/' + folder + '_' + Date.now();
    const { error } = await _supabase.storage.from('audio').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw new Error(error.message);
    const { data } = _supabase.storage.from('audio').getPublicUrl(path);
    return data.publicUrl;
}

async function sbHeartProfile(username, currentUsername) {
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
